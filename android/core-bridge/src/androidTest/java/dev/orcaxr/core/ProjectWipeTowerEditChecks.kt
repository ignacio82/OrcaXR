package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * "Auto-place Wipe Tower" on a real session, over JNI, as the Android app
 * runs it, against the browser's journey (`wipe-tower-vectors.mjs`: the
 * production controller placing as the workspace places). The same canonical
 * 3MF is opened and every step taken through [ProjectWorkspace]: plates
 * activated, a model moved, and [ProjectWorkspace.autoPlaceWipeTower] with
 * and without the profile's printable rectangle — its pick the browser's,
 * one "Auto-place wipe tower" step, nothing when the tower is already there.
 * After each step the semantic hash, the undo label and the active plate's
 * ghost ([ProjectWorkspace.wipeTowerGhost]: none, or the browser's box) are
 * the browser's; then every entry is undone back to the opened project.
 */
object ProjectWipeTowerEditChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun numbers(list: ProjectJsonArray) = List(list.length()) { list.get(it) as Double }

    @JvmStatic fun journey(corpus: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            check(done(workspace.open(Memory(archive), "towers.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val kind = operation.get("kind") as String
                fun label(name: String) = "step_${index}_$name"
                when (kind) {
                    "activate" -> done(workspace.activatePlate(operation.get("plateId") as String))
                    "move" -> {
                        val transform = operation.get("transform") as ProjectJsonObject
                        done(
                            workspace.execute(
                                ProjectIntents.Command.SetInstanceTransform(
                                    ProjectIntents.SetInstanceTransform(
                                        units(operation.get("instanceId") as String),
                                        ProjectIntents.Transform(
                                            numbers(transform.get("translationMm") as ProjectJsonArray),
                                            numbers(transform.get("rotation") as ProjectJsonArray),
                                            numbers(transform.get("scale") as ProjectJsonArray),
                                        ),
                                        units("setup:move"),
                                    ),
                                ),
                            ),
                        )
                    }
                    "autoPlace" -> {
                        val expected = step.get("result") as ProjectJsonObject
                        val pick = checkNotNull(done(workspace.autoPlaceWipeTower(operation.get("fromProfile") as Boolean)))
                        val footprint = expected.get("footprint") as ProjectJsonObject
                        check(pick.xMm == expected.get("xMm") && pick.yMm == expected.get("yMm"), label("corner ${pick.xMm} ${pick.yMm}"))
                        check((pick.clearanceMm as? ProjectIntents.OptionalFinite.Value)?.value == expected.get("clearanceMm") as? Double, label("clearance"))
                        check(text(pick.label) == expected.get("label"), label("label ${text(pick.label)}"))
                        check(
                            pick.footprint == ProjectIntents.WipeTowerRect(
                                footprint.get("xMin") as Double, footprint.get("yMin") as Double,
                                footprint.get("xMax") as Double, footprint.get("yMax") as Double,
                            ),
                            label("footprint"),
                        )
                    }
                    else -> error("unknown operation $kind")
                }
                val view = workspace.view
                check(view.revision?.semanticHash == step.get("semanticHash"), label("hash $kind"))
                check(view.undo == step.get("undoLabel") as? String, label("undo ${view.undo}"))
                val ghost = ProjectIntents.decodeWipeTowerGhostReply(step.get("ghost") as String)
                check(done(workspace.wipeTowerGhost()) == (ghost as? ProjectIntents.WipeTowerGhostReply.Ghost)?.value, label("ghost"))
            }
            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == entry.get("undoLabel") as? String, "undo_${index}_label ${workspace.view.undo}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
        }
        return checks
    }
}
