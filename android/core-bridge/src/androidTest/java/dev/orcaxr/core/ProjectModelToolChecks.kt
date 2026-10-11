package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** The browser's model tools on real sessions (`model-tool-vectors.json`). */
object ProjectModelToolChecks {
    private const val WAIT_S = 60L
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /**
     * What a split would split through the Kotlin wrapper: the recorded
     * project, opened as a real session with its assets, answers every
     * request through [ProjectSnapshot.splitSource] as the browser's reply
     * reads, and [SplitSources.request] refuses a limit the exchange would.
     * [script] lines: `C <request> <reply>` (tab-separated).
     */
    @JvmStatic fun splitSources(stateJson: String, assets: List<ByteArray>, script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectPreparation().use { scope ->
            val bytes = stateJson.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument()
            check(upload.assetCount() == assets.size.toLong(), "asset_count")
            for ((position, mesh) in assets.withIndex()) {
                kotlin.check(upload.beginAsset(position.toLong()) == mesh.size.toLong()) { "asset_$position" }
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open())
            session.snapshot().use { snapshot ->
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    kotlin.check(entry[0] == "C") { "unknown line ${entry[0]}" }
                    val request = CanonicalJson.read(entry[1]) as ProjectJsonObject
                    val instanceId = request.get("instanceId") as String
                    val target = SplitTarget.entries.first { it.wire == request.get("target") }
                    val limit = (request.get("triangleLimit") as Double).toLong()
                    val expected = SplitSources.read(entry[2])
                    check(snapshot.splitSource(instanceId, target, limit) == expected, "split_source_$checks $instanceId ${target.wire} $limit")
                    if (expected is SplitSourceResult.Found) {
                        check(expected.source.instanceIds.contains(instanceId) && expected.source.volumeIds.isNotEmpty(), "split_source_shape_$checks")
                    }
                }
            }
        }
        check(failure { SplitSources.request("import:instance:a", SplitTarget.PARTS, 0) } == "invalid_request", "request_zero_limit")
        check(failure { SplitSources.request("import:instance:a", SplitTarget.PARTS, 9_007_199_254_740_992L) } == "invalid_request", "request_unsafe_limit")
        check(
            SplitSources.request("Würfel ☃", SplitTarget.OBJECTS, 50_000) ==
                "{\"instanceId\":\"W\\u00fcrfel \\u2603\",\"target\":\"objects\",\"triangleLimit\":50000}",
            "request_text",
        )
        return checks
    }

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun <T> attempt(future: CompletableFuture<T>): Result<T> = try {
        Result.success(future.get(WAIT_S, TimeUnit.SECONDS))
    } catch (thrown: ExecutionException) {
        Result.failure(thrown.cause ?: thrown)
    }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

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

    private fun numbers(feature: ProjectIntents.SurfaceFeature): List<Double> = when (feature) {
        is ProjectIntents.SurfaceFeature.Point -> feature.value.point
        is ProjectIntents.SurfaceFeature.Edge -> feature.value.from + feature.value.to +
            ((feature.value.extraPoint as? ProjectIntents.OptionalVector.Value)?.value ?: emptyList())
        is ProjectIntents.SurfaceFeature.Circle -> feature.value.center + feature.value.normal + feature.value.radius
        is ProjectIntents.SurfaceFeature.Plane -> feature.value.normal + feature.value.origin + feature.value.index.toDouble()
    }

    private fun numbers(result: ProjectIntents.MeasureResult): List<Double> {
        fun distance(value: ProjectIntents.OptionalMeasureDistance) =
            (value as? ProjectIntents.OptionalMeasureDistance.Value)?.value?.let { listOf(it.distance) + it.from + it.to } ?: emptyList()
        val angle = (result.angle as? ProjectIntents.OptionalMeasureAngle.Value)?.value?.let { listOf(it.angle, it.radius) + it.center } ?: emptyList()
        return angle + distance(result.distanceInfinite) + distance(result.distanceStrict) +
            ((result.distanceXyz as? ProjectIntents.OptionalVector.Value)?.value ?: emptyList())
    }

    /** The same numbers to rounding: the workspace reaches printer millimetres through its scene root's inverse, Kotlin composes the transforms directly. */
    private fun close(a: List<Double>, b: List<Double>) =
        a.size == b.size && a.indices.all { abs(a[it] - b[it]) <= 1e-9 * maxOf(1.0, abs(a[it]), abs(b[it])) }

    /**
     * The journey on a [ProjectWorkspace] opened on the browser's 3MF
     * ([archive]) with the browser's seeded IDs: after every split, refusal,
     * simplification, preview and measurement of the browser's journey the
     * project has the browser's semantic hash and undo label, splits report
     * the browser's flow statuses and confirmations, simplifications its
     * parts and counts, and picks and measurements its features and readout
     * (to rounding); undoing every entry passes back through each earlier
     * state to the one opened.
     */
    @JvmStatic fun journey(corpus: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        val ids = ProjectIds(seeded((reference.get("seed") as Double).toInt()))
        ProjectWorkspace(resolver = LocalTimestampResolver { it }, ids = ids).use { workspace ->
            done(workspace.ready())
            // Nothing selected: nothing to split or simplify.
            check(attempt(workspace.splitSelectedToParts()).exceptionOrNull()?.message == "Split to Parts requires an instance selection", "empty_parts")
            check(attempt(workspace.splitToObjectsConfirmation()).exceptionOrNull()?.message == "Split to Objects requires a primary selected model instance", "empty_objects")
            check(done(workspace.simplifySelected()) == null, "empty_simplify")
            check(done(workspace.previewSimplify(SimplifyConfiguration.DEFAULT)) == SimplifyPreviewResult.NothingSelected, "empty_preview")
            check(done(workspace.applySimplifyPreview()) == null && !workspace.cancelSimplifyPreview(), "empty_apply")

            check(done(workspace.open(Memory(archive), "tools.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(workspace.view.revision?.semanticHash == opened, "opened_hash ${workspace.view.revision}")
            ids.next((reference.get("skippedIds") as Double).toInt())

            val picks = ArrayList<MeasurePick>()
            val browserPicks = ArrayList<MeasurePick>()
            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val operation = step.get("operation") as ProjectJsonObject
                val expected = step.get("result") as? ProjectJsonObject
                val refusal = step.get("refusal") as? String
                val kind = operation.get("kind") as String
                fun label(name: String) = "step_${index}_$name"
                when (kind) {
                    "select" -> {
                        val id = operation.get("id") as String
                        when (operation.get("entity")) {
                            "instance" -> done(workspace.selectInstance(id))
                            else -> done(workspace.selectRow("${operation.get("entity")}:$id"))
                        }
                    }
                    "splitToParts" -> {
                        val outcome = attempt(workspace.splitSelectedToParts())
                        if (refusal != null) {
                            check(outcome.exceptionOrNull()?.message == refusal, label("refused ${outcome.exceptionOrNull()}"))
                        } else {
                            check(
                                outcome.getOrNull() == SplitToPartsResult((expected!!.get("partCount") as Double).toInt(), expected.get("objectName") as String),
                                label("parts ${outcome.exceptionOrNull()}"),
                            )
                        }
                    }
                    "splitToObjects" -> {
                        // The browser's flow: the confirmation shown and accepted, then the split and its status.
                        val shown = expected!!.get("confirmation") as? ProjectJsonObject
                        val confirmation = attempt(workspace.splitToObjectsConfirmation())
                        val status = confirmation.fold(
                            { accepted ->
                                check(shown != null, label("confirmed"))
                                val instances = shown!!.get("affectedInstanceIds") as ProjectJsonArray
                                check(
                                    accepted.objectName == shown.get("objectName") && accepted.strategy.wire == shown.get("strategy") &&
                                        accepted.volumeCount == (shown.get("volumeCount") as Double).toInt() &&
                                        accepted.triangleCount == (shown.get("triangleCount") as Double).toLong() &&
                                        accepted.affectedInstanceIds == List(instances.length()) { instances.get(it) as String },
                                    label("confirmation"),
                                )
                                attempt(workspace.splitSelectedToObjects(accepted)).fold(
                                    { split ->
                                        check(split.instanceIds.size == split.objectIds.size * accepted.affectedInstanceIds.size, label("instances"))
                                        ModelToolStatus.splitDone(accepted.objectName, split.objectIds.size, accepted.affectedInstanceIds.size)
                                    },
                                    { ModelToolStatus.splitFailed(it.message) },
                                )
                            },
                            { refused ->
                                check(shown == null, label("not_confirmed"))
                                ModelToolStatus.splitUnavailable(refused.message)
                            },
                        )
                        check(status == expected.get("status"), label("status $status"))
                    }
                    "simplifyPreview" -> {
                        val configuration = operation.get("configuration") as ProjectJsonObject
                        val outcome = done(
                            workspace.previewSimplify(
                                SimplifyConfiguration(
                                    configuration.get("useCount") as Boolean, configuration.get("decimateRatio") as Double, configuration.get("maxError") as Double,
                                ),
                            ),
                        )
                        val volumes = expected!!.get("volumeIds") as ProjectJsonArray
                        if (volumes.length() == 0) {
                            check(outcome == SimplifyPreviewResult.NothingToSimplify(configuration.get("useCount") as Boolean), label("nothing $outcome"))
                            check(workspace.simplifyPreview == null, label("nothing_shown"))
                        } else {
                            val preview = (outcome as SimplifyPreviewResult.Previewing).preview
                            check(preview.parts.map { it.volumeId } == List(volumes.length()) { volumes.get(it) as String }, label("parts"))
                            check(
                                preview.beforeTriangles == (expected.get("beforeTriangles") as Double).toLong() &&
                                    preview.afterTriangles == (expected.get("afterTriangles") as Double).toLong() &&
                                    preview.stoppedOnError == expected.get("stoppedOnError"),
                                label("counts"),
                            )
                            // The preview's mesh is the payload Apply installs: its triangles, then its indices.
                            val part = preview.parts.first()
                            check(part.mesh()?.size?.toLong() == part.vertexCount * 12 + part.afterTriangles * 12, label("mesh"))
                            check(workspace.simplifyPreview === preview, label("shown"))
                            check(workspace.view.actions["simplify_apply"]?.enabled == true || waitEnabled(workspace, "simplify_apply"), label("apply_enabled"))
                            if (operation.get("apply") == true) {
                                check(done(workspace.applySimplifyPreview()) == SimplifyApplied(preview.parts.size, preview.beforeTriangles, preview.afterTriangles), label("applied"))
                                check(part.mesh() == null && workspace.simplifyPreview == null, label("released"))
                            } else {
                                check(workspace.cancelSimplifyPreview() && workspace.simplifyPreview == null, label("cancelled"))
                            }
                        }
                    }
                    "simplify" -> {
                        val applied = done(workspace.simplifySelected(operation.get("decimateRatio") as Double))
                        check(
                            applied == SimplifyApplied(
                                (expected!!.get("changed") as Double).toInt(), (expected.get("beforeTriangles") as Double).toLong(),
                                (expected.get("afterTriangles") as Double).toLong(),
                            ),
                            label("simplified $applied"),
                        )
                    }
                    "measurePick" -> {
                        val point = (expected!!.get("point") as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as Double } }
                        val outcome = done(
                            workspace.measurePick(
                                operation.get("instanceId") as String, operation.get("volumeId") as String,
                                (operation.get("triangle") as Double).toLong(), point,
                            ),
                        )
                        val browser = ProjectIntents.decodeMeasureFeatureReply(expected.get("reply") as String) as ProjectIntents.MeasureFeatureReply.Feature
                        val pick = (outcome as MeasurePickResult.Picked).pick
                        check(pick.summary == text(browser.value.summary), label("summary ${pick.summary}"))
                        check(pick.feature::class == browser.value.feature::class && close(numbers(pick.feature), numbers(browser.value.feature)), label("feature"))
                        picks += pick
                        browserPicks += MeasurePick(browser.value.feature, text(browser.value.summary), pick.instanceId)
                    }
                    "measure" -> {
                        val first = (operation.get("first") as Double).toInt()
                        val second = (operation.get("second") as Double).toInt()
                        val ours = checkNotNull(workspace.measure(picks[first], picks[second]))
                        val browser = (ProjectIntents.decodeMeasureReply(step.get("result") as String) as ProjectIntents.MeasureReply.Measured).value
                        check(close(numbers(ours), numbers(browser)) && ours.unsupported == browser.unsupported, label("measured"))
                        val readout = ProjectMeasures.readout(true, listOf(picks[first], picks[second]), ours)
                        val browserReadout = ProjectMeasures.readout(true, listOf(browserPicks[first], browserPicks[second]), browser)
                        check(readout.rows == browserReadout.rows && readout.rows.isNotEmpty() && readout.hint == MeasureHint.NEXT, label("readout ${readout.rows}"))
                    }
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
        // The readout's words and numbers, as the browser's panel writes them.
        check(ProjectMeasures.format(29.999999999999996) == "30" && ProjectMeasures.format(-0.0004) == "0", "format_round")
        check(ProjectMeasures.format(1.0005) == "1" && ProjectMeasures.format(0.0625) == "0.063" && ProjectMeasures.format(-12.3456) == "-12.346", "format_half_up")
        check(ProjectMeasures.format(1234567.25) == "1234567.25" && ProjectMeasures.format(1e21) == "1e+21", "format_large")
        check(ModelToolStatus.previewing(1, 720, 360, false) == "Previewing 1 part(s): 720 → 360 triangles (50% removed).", "previewing")
        check(ModelToolStatus.previewing(2, 3, 2, true) == "Previewing 2 part(s): 3 → 2 triangles (33% removed). Stopped at the error limit before reaching the target.", "previewing_stopped")
        check(ModelToolStatus.splitFailed("a\n\tb ") == "Split to Objects failed: a b. The project was not changed.", "split_failed_words")
        check(ModelToolStatus.splitDone("Pair", 2, 1) == "Split Pair into 2 objects across all 1 instance in one undoable edit.", "split_done_one")
        return checks
    }

    /** Whether the core comes to enable [id] (its capabilities are read after each change). */
    private fun waitEnabled(workspace: ProjectWorkspace, id: String): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (workspace.view.actions[id]?.enabled != true) {
            if (System.nanoTime() > deadline) return false
            Thread.sleep(10)
        }
        return true
    }
}
