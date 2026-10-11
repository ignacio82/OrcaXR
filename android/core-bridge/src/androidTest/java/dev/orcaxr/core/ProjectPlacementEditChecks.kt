package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** Placement edits on a real session, as the browser's workspace applies them
 * (one scene of `placement-edit-vectors.json`: the U1's printable area, or one
 * far from the bed corner): the browser's canonical 3MF of the picking scene
 * opens in a [ProjectWorkspace] with the browser's semantic hash and bed;
 * every edit — drop to bed, mirror, the resets, centre, scale to fit, lay
 * flat by a normal and by a facet, arrange — leaves the project with the
 * browser's hash and undo label after it (repeated gestures coalescing, edits
 * that change nothing leaving history alone, refusals in the browser's
 * words) and the instances the core's live preflight finds outside its build
 * volume are the browser's, and undoing every entry passes back through each
 * earlier state to the one opened. A project stating no printable height
 * refuses to scale to fit as the browser does. */
object ProjectPlacementEditChecks {
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
    private fun strings(value: Any): List<String> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as Double } }
    private fun text(value: Any): String? = value as? String

    /** The instances the core's live preflight of plate [plateId] (the project as authored) finds outside its build volume. */
    internal fun outside(workspace: ProjectWorkspace, plateId: String): List<String> =
        workspace.preflight(plateId).get(WAIT_S, TimeUnit.SECONDS).issues
            .filter { it.code == ProjectIntents.PreflightCode.InstanceOutsideBuildVolume }
            .flatMap { issue -> issue.entities.mapNotNull { (it as? ProjectIntents.PreflightEntity.Instance)?.value } }
            .map { units -> String(CharArray(units.size) { units[it].toChar() }) }
            .sorted()

    /** [corpus] is one scene's `{"bed","opened","plateId","steps","undo"}`; [archive] its 3MF. */
    @JvmStatic fun run(corpus: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            val first = done(workspace.ready())
            // The empty project states no printable area: the 200 mm plate, no height to scale into.
            check(first.bed == WorkspaceBed.DEFAULT, "empty_bed ${first.bed}")
            check(attempt(workspace.scaleToFit(listOf("import:instance:any"))).exceptionOrNull()?.message == PlacementGestures.NO_PRINTABLE_HEIGHT, "no_height_refused")
            check(workspace.view.revision == first.revision, "refusal_changes_nothing")

            check(done(workspace.open(Memory(archive), "placement.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            val bed = WorkspaceBeds.read(reference.get("bed") as String)
            check(until(workspace) { it.bed == bed }.bed == bed, "opened_bed")
            val plateId = reference.get("plateId") as String

            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val ids = { strings(operation.get("instanceIds")) }
                val outcome: Result<Any?> = when (val kind = operation.get("kind") as String) {
                    "dropToBed" -> attempt(workspace.dropToBed(ids())).map { drops -> mapOf("moved" to drops.count { it.deltaZMm != 0.0 }) }
                    "mirror" -> attempt(workspace.mirror(ids(), ProjectIntents.PlacementAxis.valueOf((operation.get("axis") as String).uppercase()))).map { null }
                    "reset" -> attempt(workspace.resetTransforms(ids(), TransformReset.valueOf((operation.get("target") as String).uppercase()))).map { null }
                    "center" -> attempt(workspace.centerOnPlate(ids())).map { null }
                    "scaleToFit" -> attempt(workspace.scaleToFit(ids())).map { mapOf("changed" to it) }
                    "layOnFace" -> attempt(workspace.layOnFace(operation.get("instanceId") as String, doubles(operation.get("localNormal")))).map { null }
                    "layOnFacet" -> attempt(workspace.layOnFacet(operation.get("instanceId") as String, operation.get("volumeId") as String, (operation.get("triangle") as Double).toLong())).map { null }
                    "arrange" -> attempt(workspace.arrangePlate(operation.get("plateId") as String)).map {
                        mapOf("placed" to it.placements.size, "unplaced" to it.unplacedInstanceIds.size)
                    }
                    else -> error("unknown operation $kind")
                }
                val refusal = text(step.get("refusal"))
                if (refusal != null) {
                    check(outcome.exceptionOrNull()?.message == refusal, "step_${index}_refused ${outcome.exceptionOrNull()}")
                } else {
                    check(outcome.isSuccess, "step_${index}_applied ${outcome.exceptionOrNull()}")
                    val expected = (step.get("result") as? ProjectJsonObject)?.let { result ->
                        result.keys().asSequence().associateWith { (result.get(it) as Double).toInt() }
                    }
                    check(outcome.getOrNull() == expected, "step_${index}_result ${outcome.getOrNull()} != $expected")
                }
                val view = workspace.view
                check(view.revision?.semanticHash == step.get("semanticHash"), "step_${index}_hash ${operation.get("kind")}")
                check(view.undo == text(step.get("undoLabel")), "step_${index}_label ${view.undo}")
                check(outside(workspace, plateId) == strings(step.get("outside")), "step_${index}_outside ${operation.get("kind")}")
            }
            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == text(entry.get("undoLabel")), "undo_${index}_label ${workspace.view.undo}")
                check(outside(workspace, plateId) == strings(entry.get("outside")), "undo_${index}_outside")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
        }
        return checks
    }
}
