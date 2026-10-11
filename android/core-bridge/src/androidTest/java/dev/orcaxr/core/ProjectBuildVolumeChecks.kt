package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** Placements inside the slice preflight's build volume on a real session, as
 * the browser's workspace makes them (one journey of `build-volume-vectors.json`:
 * the Snapmaker U1's bundled printable area, offset 0.5 × 1 mm from the bed
 * corner, or one far from the corner with a plate tower). The browser's
 * canonical 3MF opens in a [ProjectWorkspace] whose IDs come from the
 * browser's seeded source, with the browser's bed — its placement area and
 * build volume; then primitives centred on the area, an arrangement, a bed
 * fill, centring and scaling to the build volume (the selection, then the
 * plate's models) and a model import each leave the project with the
 * browser's hash (the import's IDs are this device's own) and undo label, and
 * the core's live preflight finds no model outside its build volume; undoing
 * every entry passes back through each earlier state to the one opened. */
object ProjectBuildVolumeChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun <T> attempt(future: java.util.concurrent.CompletableFuture<T>): Result<T> = try {
        Result.success(future.get(WAIT_S, TimeUnit.SECONDS))
    } catch (thrown: ExecutionException) {
        Result.failure(thrown.cause ?: thrown)
    }
    private fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun text(value: Any): String? = value as? String
    private fun strings(value: Any): List<String> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }

    /** The browser's `seededRandom` (web/src/project/domain/ids.ts): xorshift32 words over 2³². */
    private fun seeded(seed: Int): () -> Double {
        var state = if (seed != 0) seed else 0x9e3779b9.toInt()
        return {
            state = state xor (state shl 13)
            state = state xor (state ushr 17)
            state = state xor (state shl 5)
            (state.toLong() and 0xffffffffL) / 4294967296.0
        }
    }

    /** [corpus] is one journey's `{"bed","importedAt","opened","plateId","seed","skippedIds","steps","undo"}`;
     * [archive] its 3MF; [cube] the STL its import step reads. */
    @JvmStatic fun run(corpus: String, archive: ByteArray, cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        val ids = ProjectIds(seeded((reference.get("seed") as Double).toInt()))
        val importedAt = reference.get("importedAt") as String
        val clock = java.time.Instant.parse(importedAt).toEpochMilli()
        ProjectWorkspace(clock = { clock }, resolver = LocalTimestampResolver { it }, ids = ids).use { workspace ->
            done(workspace.ready())
            check(done(workspace.open(Memory(archive), "volume.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            // The browser's bed: its placement area and the build volume the preflight checks.
            val bed = WorkspaceBeds.read(reference.get("bed") as String)
            check(until(workspace) { it.bed == bed }.bed.volumeMm != null, "opened_bed")
            val plateId = reference.get("plateId") as String
            check(ProjectPlacementEditChecks.outside(workspace, plateId).isEmpty(), "opened_inside")
            // The browser's controller drew these for its own empty project before opening.
            ids.next((reference.get("skippedIds") as Double).toInt())

            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val expected = step.get("result") as? ProjectJsonObject
                fun field(name: String) = expected?.get(name)
                val kind = operation.get("kind") as String
                val outcome: Result<Boolean> = when (kind) {
                    "primitive" -> {
                        val shape = PrimitiveShape.entries.first { it.wire == operation.get("primitive") }
                        attempt(workspace.addPrimitive(shape)).map {
                            it == ProjectPrimitiveAdded(field("objectId") as String, field("instanceId") as String, field("reusedAsset") as Boolean)
                        }
                    }
                    "select" -> attempt(workspace.selectInstance(operation.get("instanceId") as String)).map { true }
                    "deselect" -> attempt(workspace.deselectAll()).map { true }
                    "arrange" -> attempt(workspace.arrangeActivePlate()).map {
                        it != null && it.placements.size == (field("placed") as Double).toInt() &&
                            it.unplacedInstanceIds.size == (field("unplaced") as Double).toInt()
                    }
                    "fill" -> attempt(workspace.fillBed()).map {
                        it == ProjectBedFill((field("created") as Double).toInt(), (field("withheld") as Double).toLong())
                    }
                    "center" -> attempt(workspace.centerSelectedOnPlate()).map { it == (field("count") as Double).toInt() }
                    "scaleToFit" -> attempt(workspace.scaleSelectedToFit()).map { it == (field("changed") as Double).toInt() }
                    // Centred on the printable area and dropped onto the bed, under this device's own IDs.
                    "import" -> attempt(workspace.prepareImport(Memory(cube), "cube.stl")).mapCatching { candidate ->
                        checkNotNull(candidate) { "no import candidate" }
                        done(workspace.commitImport(candidate, emptyList()))
                        true
                    }
                    else -> error("unknown operation $kind")
                }
                check(outcome.getOrNull() == true, "step_${index}_$kind ${outcome.exceptionOrNull()} $expected")
                val view = workspace.view
                if (kind != "import") check(view.revision?.semanticHash == step.get("semanticHash"), "step_${index}_hash $kind")
                check(view.undo == text(step.get("undoLabel")), "step_${index}_label ${view.undo}")
                val outside = ProjectPlacementEditChecks.outside(workspace, plateId)
                check(outside.isEmpty() && strings(step.get("outside")).isEmpty(), "step_${index}_outside $kind $outside")
            }
            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == text(entry.get("undoLabel")), "undo_${index}_label ${workspace.view.undo}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
        }
        return checks
    }
}
