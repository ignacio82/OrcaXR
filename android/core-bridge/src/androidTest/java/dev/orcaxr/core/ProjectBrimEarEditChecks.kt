package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The Workspace's Brim Ears tool on a real session, over JNI, as the
 * Android Workspace drives it, against the browser's journey
 * (`brim-ear-vectors.mjs`: the production controller running the
 * workspace's tool). The same canonical 3MF is opened and every step taken
 * through [ProjectWorkspace]: the selection (an instance, an object's row,
 * nothing), [ProjectWorkspace.brimEars] (the one object ears go on, its ears,
 * the stranded ones and its base), a tap's ear — placed through the part it
 * met ([ProjectWorkspace.placeBrimEarOnPart], whose object-frame point agrees
 * with three.js's to rounding, then undone) and at the browser's exact point
 * ([ProjectWorkspace.placeBrimEar]) —, the detector's corners
 * ([ProjectWorkspace.autoPlaceBrimEars]), removal and clearing, and the cases
 * that place nothing. After each step the semantic hash, the undo label and
 * the target's view are the browser's; then every entry is undone back to
 * the opened project.
 */
object ProjectBrimEarEditChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
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
            // A fresh project: one empty object is never in scope, so nothing to place on.
            check(done(workspace.brimEars()) == BrimEarState(), "empty_project")
            check(done(workspace.autoPlaceBrimEars(5.0)) == BrimEarAuto.NoTarget, "empty_auto")
            check(done(workspace.open(Memory(archive), "ears.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")

            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val result = step.get("result") as? ProjectJsonObject
                val kind = operation.get("kind") as String
                fun label(name: String) = "step_${index}_$name"
                when (kind) {
                    "select" -> when (val entity = operation.get("entity") as? String) {
                        null -> done(workspace.deselectAll())
                        "instance" -> done(workspace.selectInstance(operation.get("id") as String))
                        else -> done(workspace.selectRow("$entity:${operation.get("id")}"))
                    }
                    "tap" -> {
                        val objectId = result!!.get("objectId") as String
                        val browser = numbers(result.get("objectPoint") as ProjectJsonArray)
                        val radius = operation.get("radiusMm") as Double
                        // Through the part the tap met, as the Workspace places it: the object-frame point agrees with
                        // three.js's to rounding and the ear sits at the base. Undone, then placed at the browser's
                        // exact point, so the history and the hashes stay the browser's.
                        val before = done(workspace.brimEars())
                        done(workspace.placeBrimEarOnPart(objectId, operation.get("volumeId") as String, numbers(operation.get("point") as ProjectJsonArray), radius))
                        val tapped = done(workspace.brimEars())
                        val ear = tapped.ears.last()
                        check(tapped.ears.size == before.ears.size + 1 && ear.headFrontRadiusMm == radius, label("tapped"))
                        check(abs(ear.positionMm[0] - browser[0]) < 1e-9 && abs(ear.positionMm[1] - browser[1]) < 1e-9, label("frame ${ear.positionMm} $browser"))
                        check(ear.positionMm[2] == (tapped.baseZMm ?: browser[2]), label("base"))
                        check(workspace.view.undo == "Place brim ear", label("tap_label"))
                        done(workspace.undo())
                        check(done(workspace.brimEars()) == before, label("tap_undone"))
                        done(workspace.placeBrimEar(objectId, browser, radius))
                    }
                    "auto" -> {
                        val outcome = done(workspace.autoPlaceBrimEars(operation.get("radiusMm") as Double))
                        val expected = when (result!!.get("outcome")) {
                            "noTarget" -> BrimEarAuto.NoTarget
                            "noGeometry" -> BrimEarAuto.NoGeometry
                            "noEars" -> BrimEarAuto.NoEars(result.get("reason") as? String)
                            else -> BrimEarAuto.Placed((result.get("count") as Double).toInt())
                        }
                        check(outcome == expected, label("auto $outcome"))
                    }
                    "clear" -> {
                        val outcome = done(workspace.clearBrimEars())
                        val expected = when (result!!.get("outcome")) {
                            "noTarget" -> BrimEarClear.NO_TARGET
                            "noEars" -> BrimEarClear.NO_EARS
                            else -> BrimEarClear.CLEARED
                        }
                        check(outcome == expected, label("clear $outcome"))
                    }
                    "remove" -> {
                        val removed = done(workspace.removeBrimEar((operation.get("index") as Double).toLong()))
                        check(removed == result!!.get("removed"), label("removed $removed"))
                    }
                    else -> error("unknown operation $kind")
                }
                val view = workspace.view
                check(view.revision?.semanticHash == step.get("semanticHash"), label("hash $kind"))
                check(view.undo == step.get("undoLabel") as? String, label("undo ${view.undo}"))
                // What the tool shows: the browser's target and its view.
                val state = done(workspace.brimEars())
                check(state.objectId == step.get("target") as? String, label("target ${state.objectId}"))
                val browser = (step.get("view") as? String)?.let { ProjectIntents.decodeBrimEarViewReply(it) as ProjectIntents.BrimEarViewReply.View }?.value
                if (browser == null) {
                    check(state == BrimEarState(), label("nothing_shown"))
                } else {
                    check(
                        state.ears == browser.ears.map { BrimEarPoint(it.positionMm, it.headFrontRadiusMm) } &&
                            state.stranded == browser.stranded.map { it.toInt() } &&
                            state.baseZMm == (browser.baseZMm as? ProjectIntents.OptionalFinite.Value)?.value,
                        label("view $state"),
                    )
                }
            }
            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == entry.get("undoLabel") as? String, "undo_${index}_label ${workspace.view.undo}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")

            // A radius outside the pinned bounds is refused, and nothing changes.
            done(workspace.selectRow("object:import:object:journey-split"))
            val refused = runCatching { done(workspace.placeBrimEar("import:object:journey-split", listOf(1.0, 1.0, 0.0), 25.0)) }.exceptionOrNull()
            check((refused as? ExecutionException)?.cause is ProjectFailure && workspace.view.revision?.semanticHash == opened, "radius_refused $refused")
        }
        // The panel's and the workspace's words.
        check(ProjectBrimEars.placed(5.0) == "Placed a 5 mm brim ear." && ProjectBrimEars.placed(2.5) == "Placed a 2.5 mm brim ear.", "placed_words")
        check(ProjectBrimEars.autoPlaced(1) == "Placed 1 brim ear on the corners that would lift; one undo removes them all.", "auto_one")
        check(ProjectBrimEars.autoPlaced(4) == "Placed 4 brim ears on the corners that would lift; one undo removes them all.", "auto_many")
        check(ProjectBrimEars.noEars(null) == "No ears placed." && ProjectBrimEars.noEars("Flat.") == "No ears placed. Flat.", "no_ears")
        check(ProjectBrimEars.RADIUS_BOUNDS == "A brim ear radius must be between 0.1 and 20 mm.", "bounds")
        check(ProjectBrimEars.row(BrimEarPoint(listOf(23.00000000000001, -0.004, 1.5), 2.5), true) == "23, 0, 1.5 mm · ⌀5 mm · does not reach the part", "row")
        return checks
    }
}
