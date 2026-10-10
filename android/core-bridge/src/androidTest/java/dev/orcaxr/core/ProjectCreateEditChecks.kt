package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** Creation on a real session, as the browser's workspace creates
 * (`primitive-vectors.json` journey): the browser's canonical 3MF (a U1 bed and
 * a plate tower) opens in a [ProjectWorkspace] whose IDs come from the
 * browser's seeded source; every primitive, helper volume, added instance, bed
 * fill, copy, cut and paste leaves the project with the browser's semantic hash
 * and undo label after it (a primitive sharing a mesh draws no asset ID, a fill
 * is one "Fill n instances", refusals keep the browser's words), and undoing
 * every entry passes back through each earlier state to the one opened. */
object ProjectCreateEditChecks {
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

    /** [corpus] is the journey's `{"bed","importedAt","opened","seed","skippedIds","steps","undo"}`; [archive] its 3MF. */
    @JvmStatic fun run(corpus: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        val ids = ProjectIds(seeded((reference.get("seed") as Double).toInt()))
        val importedAt = reference.get("importedAt") as String
        val clock = java.time.Instant.parse(importedAt).toEpochMilli()
        check(NewProjects.timestamp(clock) == importedAt, "clock")
        ProjectWorkspace(clock = { clock }, resolver = LocalTimestampResolver { it }, ids = ids).use { workspace ->
            done(workspace.ready())
            // Nothing selected and no copy: no helper target, nothing to fill with or paste.
            check(attempt(workspace.addHelperVolume(HelperVolumeRole.MODIFIER)).exceptionOrNull()?.message == "Adding a volume requires a selected object or instance", "empty_helper")
            check(done(workspace.fillBed()) == null && done(workspace.paste()) == null && done(workspace.copySelected()) == null, "empty_nothing")
            check(!workspace.hasClipboard && workspace.view.actions["edit_paste"]?.enabled != true, "empty_no_paste")
            check(attempt(workspace.addPrimitive(PrimitiveShape.HELPER_CUBE)).exceptionOrNull() is ProjectFailure, "helper_cube_not_primitive")

            check(done(workspace.open(Memory(archive), "create.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            val bed = (reference.get("bed") as ProjectJsonArray).let { listOf(it.get(0) as Double, it.get(1) as Double) }
            check(until(workspace) { listOf(it.bed.widthMm, it.bed.depthMm) == bed }.bed.keepOut != null, "opened_bed")
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
                    "helper" -> {
                        val role = HelperVolumeRole.entries.first { it.wire == operation.get("role") }
                        attempt(workspace.addHelperVolume(role)).map { it == expected?.let { ProjectHelperAdded(field("objectId") as String, field("volumeId") as String) } }
                    }
                    "addInstance" -> attempt(workspace.cloneSelected()).map { it == field("instanceId") }
                    "fill" -> attempt(workspace.fillBed()).map {
                        it == expected?.let { ProjectBedFill((field("created") as Double).toInt(), (field("withheld") as Double).toLong()) }
                    }
                    "copy" -> attempt(workspace.copySelected()).map { it == field("objectId") }
                    "paste" -> attempt(workspace.paste()).map { it == field("objectId") }
                    "cut" -> attempt(workspace.cutSelected()).map { it?.name?.lowercase() == field("scope") }
                    else -> error("unknown operation $kind")
                }
                val refusal = text(step.get("refusal"))
                if (refusal != null) {
                    check(outcome.exceptionOrNull()?.message == refusal, "step_${index}_refused ${outcome.exceptionOrNull()}")
                } else {
                    check(outcome.getOrNull() == true, "step_${index}_$kind ${outcome.exceptionOrNull()} $expected")
                }
                val view = workspace.view
                check(view.revision?.semanticHash == step.get("semanticHash"), "step_${index}_hash $kind")
                check(view.undo == text(step.get("undoLabel")), "step_${index}_label ${view.undo}")
                if (kind == "copy" && expected != null) {
                    // A copy enables Paste once the core has answered for the clipboard.
                    check(until(workspace) { it.actions["edit_paste"]?.enabled == true }.actions["edit_paste"]?.enabled == true, "copy_enables_paste")
                }
            }
            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == text(entry.get("undoLabel")), "undo_${index}_label ${workspace.view.undo}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
            // The copy outlives the edits it was taken among, as the browser's clipboard does.
            check(workspace.hasClipboard, "clipboard_kept")
        }
        return checks
    }
}
