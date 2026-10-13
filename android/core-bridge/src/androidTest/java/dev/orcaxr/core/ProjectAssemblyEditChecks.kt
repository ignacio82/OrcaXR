package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The Workspace's assembly flow on a real session, over JNI, as the Android
 * app runs it, against the browser's journey (`assembly-vectors.mjs`: the
 * production controller and `AssemblyAlignment.ts` over the Measure tool's
 * picks). The same canonical 3MF is opened and every step taken through
 * [ProjectWorkspace]: each pick is the browser's feature to rounding (the
 * browser reaches printer millimetres through its scene root's inverse,
 * Kotlin composes the transforms) and its summary exactly; the alignments
 * then take the browser's features, as the pair the operator picked, so the
 * Align section's view ([ProjectAssemblies.view]: what the pair allows,
 * whether it can move, the hint) and each alignment's outcome, status and
 * committed transform are the browser's exactly — a move one
 * "Transform instance" step, nothing for faces already aligned, a refusal
 * before anything is read, the plan's refusal in the core's words. After each
 * step the semantic hash and the undo label are the browser's; then every
 * entry is undone back to the opened project.
 */
object ProjectAssemblyEditChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun numbers(list: ProjectJsonArray) = List(list.length()) { list.get(it) as Double }

    private fun numbers(feature: ProjectIntents.SurfaceFeature): List<Double> = when (feature) {
        is ProjectIntents.SurfaceFeature.Point -> feature.value.point
        is ProjectIntents.SurfaceFeature.Edge -> feature.value.from + feature.value.to +
            ((feature.value.extraPoint as? ProjectIntents.OptionalVector.Value)?.value ?: emptyList())
        is ProjectIntents.SurfaceFeature.Circle -> feature.value.center + feature.value.normal + feature.value.radius
        is ProjectIntents.SurfaceFeature.Plane -> feature.value.normal + feature.value.origin + feature.value.index.toDouble()
    }

    private fun close(a: List<Double>, b: List<Double>) =
        a.size == b.size && a.indices.all { abs(a[it] - b[it]) <= 1e-9 * maxOf(1.0, abs(a[it]), abs(b[it])) }

    /** The browser's hints (`ASSEMBLY_HINTS`) and refusal statuses, which the app shows from its string resources. */
    private val HINTS = mapOf(
        AssemblyHint.PICK to "Pick two faces — the second one moves.",
        AssemblyHint.CHOOSE to "Choose an alignment; it commits as one undoable move.",
        AssemblyHint.DIFFERENT_MODELS to "Pick two faces on different models to align them.",
    )
    private val REFUSALS = mapOf(
        AssemblyPairing.TWO_PICKS to "Pick two faces before aligning.",
        AssemblyPairing.DIFFERENT_MODELS to "Assembly alignment needs two faces on different models.",
        AssemblyPairing.GONE to "The model to align is no longer on this plate.",
    )
    private const val ALREADY = "Those faces are already aligned; nothing moved."
    private val NOTHING = ProjectIntents.AssemblyAvailability(false, false, false, false, false, false, 0.0, 0.0)

    @JvmStatic fun journey(corpus: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            check(done(workspace.open(Memory(archive), "assembly.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            // The Measure tool's picks, as the app holds them: a third starts a new pair.
            var picks = listOf<MeasurePick>()
            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val result = step.get("result") as ProjectJsonObject
                val kind = operation.get("kind") as String
                fun label(name: String) = "step_${index}_$name"
                when (kind) {
                    "pick" -> {
                        val instanceId = operation.get("instanceId") as String
                        val outcome = done(
                            workspace.measurePick(
                                instanceId, operation.get("volumeId") as String,
                                (operation.get("triangle") as Double).toLong(), numbers(operation.get("point") as ProjectJsonArray),
                            ),
                        )
                        val browser = ProjectIntents.decodeMeasureFeatureReply(result.get("reply") as String) as ProjectIntents.MeasureFeatureReply.Feature
                        val pick = (outcome as MeasurePickResult.Picked).pick
                        check(pick.summary == text(browser.value.summary), label("summary ${pick.summary}"))
                        check(pick.feature::class == browser.value.feature::class && close(numbers(pick.feature), numbers(browser.value.feature)), label("feature"))
                        picks = (if (picks.size >= 2) emptyList() else picks) + MeasurePick(browser.value.feature, pick.summary, instanceId)
                    }
                    "snapshot" -> {
                        val view = ProjectAssemblies.view(picks)
                        val available = result.get("available") as ProjectJsonObject
                        val expected = ProjectIntents.AssemblyAvailability(
                            available.get("canSetToParallel") as Boolean, available.get("canSetToCenterCoincidence") as Boolean,
                            available.get("canReverseFeature1") as Boolean, available.get("canReverseFeature2") as Boolean,
                            available.get("canRotateAroundFaceCenter") as Boolean, available.get("hasParallelDistance") as Boolean,
                            available.get("parallelDistanceMm") as Double, available.get("angleRadians") as Double,
                        )
                        check((view.available ?: NOTHING) == expected, label("available ${view.available}"))
                        check(view.movable == result.get("movable"), label("movable"))
                        check(HINTS[view.hint] == result.get("hint"), label("hint ${view.hint}"))
                    }
                    "align" -> {
                        val alignment = AssemblyKind.of(operation.get("alignment") as String)
                        val parameter = if (operation.keys().asSequence().any { it == "parameter" }) operation.get("parameter") as Double else null
                        val aligned = done(workspace.alignAssembly(picks, alignment, parameter))
                        val status = result.get("status") as String
                        when (result.get("outcome") as String) {
                            "move" -> {
                                val moved = aligned as AssemblyAligned.Moved
                                val transform = result.get("transform") as ProjectJsonObject
                                check(moved.instanceId == result.get("instanceId"), label("moved"))
                                check(
                                    moved.transform == ProjectIntents.Transform(
                                        numbers(transform.get("translationMm") as ProjectJsonArray),
                                        numbers(transform.get("rotation") as ProjectJsonArray),
                                        numbers(transform.get("scale") as ProjectJsonArray),
                                    ),
                                    label("transform ${moved.transform}"),
                                )
                                check(ProjectAssemblies.applied(alignment) == status, label("applied"))
                                // The picks described where the faces were: the workspace drops them.
                                picks = emptyList()
                            }
                            "aligned" -> check(aligned == AssemblyAligned.Aligned && status == ALREADY, label("aligned $aligned"))
                            "failed" -> check(ProjectAssemblies.failed((aligned as AssemblyAligned.Failed).message) == status, label("failed $aligned"))
                            "refused" -> check(REFUSALS[(aligned as AssemblyAligned.Refused).reason] == status, label("refused $aligned"))
                            else -> error("unknown outcome")
                        }
                    }
                    // The exploded view is the renderer's ([dev.orcaxr.renderer.SceneExplosion]), checked over a scene.
                    "explode" -> Unit
                    else -> error("unknown operation $kind")
                }
                val view = workspace.view
                check(view.revision?.semanticHash == step.get("semanticHash"), label("hash $kind"))
                check(view.undo == step.get("undoLabel") as? String, label("undo ${view.undo}"))
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
