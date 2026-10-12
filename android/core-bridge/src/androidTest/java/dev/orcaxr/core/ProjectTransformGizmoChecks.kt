package dev.orcaxr.core

import java.security.MessageDigest

/** The transform gizmo through the Kotlin wrapper (`transform-gizmo-vectors.json`):
 * [TransformGizmo.geometry] reads the baked handles the browser bakes;
 * [TransformGizmo.attach], [TransformGizmo.step] and [TransformGizmo.present]
 * replay every pointer sequence with the browser's change flags and views
 * (their SHA-256), the state's axis and drag agreeing with the view's;
 * [TransformGizmo.changes] submits what the browser submits; and malformed
 * requests are refused by the exports. */
object ProjectTransformGizmoChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as? Double ?: Double.NaN } }
    private fun pose(value: Any) = (value as ProjectJsonObject).let {
        GizmoPose(doubles(it.get("position")), doubles(it.get("quaternion")), doubles(it.get("scale")))
    }
    private fun transform(value: Any): ProjectIntents.Transform = (value as ProjectJsonObject).let {
        ProjectIntents.Transform(doubles(it.get("translationMm")), doubles(it.get("rotation")), doubles(it.get("scale")))
    }
    private fun sha256(text: String) =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun scene(request: ProjectJsonObject): GizmoScene {
        val camera = request.get("camera") as ProjectJsonObject
        return GizmoScene(
            GizmoCamera(
                camera.get("fov") as Double,
                camera.get("aspect") as Double,
                camera.get("near") as Double,
                camera.get("far") as Double,
                doubles(camera.get("position")),
                doubles(camera.get("target")),
                doubles(camera.get("up")),
            ),
            pose(request.get("root")),
            GizmoMode.entries.first { it.wire == request.get("mode") },
            GizmoSpace.entries.first { it.wire == request.get("space") },
        )
    }

    /** [script] lines (tab-separated): `G <geometry>`, `S <request> <steps>` sequences,
     * `C <request> <reply>` drag changes, and `X <exchange> <request>` refusals. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        for (line in script.split("\n")) {
            val entry = line.split("\t")
            when (entry[0]) {
                "G" -> {
                    check(NativeProject.transformGizmoGeometry() == entry[1], "geometry_text")
                    val expected = obj(entry[1])
                    val geometry = TransformGizmo.geometry()
                    for ((group, shapes) in listOf("gizmo" to geometry.gizmo, "picker" to geometry.picker, "helper" to geometry.helper)) {
                        val modes = expected.get(group) as ProjectJsonObject
                        for (mode in GizmoMode.entries) {
                            val list = modes.get(mode.wire) as ProjectJsonArray
                            val read = shapes.getValue(mode)
                            check(read.size == list.length(), "geometry_${group}_${mode.wire}_count")
                            for ((index, shape) in read.withIndex()) {
                                val want = list.get(index) as ProjectJsonObject
                                val positions = doubles(want.get("positions")).map { it.toFloat() }
                                val indices = (want.get("index") as? ProjectJsonArray)?.let { l -> List(l.length()) { (l.get(it) as Double).toInt() } }
                                check(
                                    shape.name == want.get("name") && shape.helper == (want.get("tag") is String) &&
                                        shape.line == (want.get("kind") == "line") && shape.positions.toList() == positions &&
                                        shape.index?.toList() == indices,
                                    "geometry_${group}_${mode.wire}_$index",
                                )
                            }
                        }
                    }
                    check(geometry.plane.index?.size == 24 && geometry.plane.positions.size == 27, "geometry_plane")
                }
                "S" -> {
                    val request = obj(entry[1])
                    val steps = CanonicalJson.read(entry[2]) as ProjectJsonArray
                    val scene = scene(request)
                    val events = request.get("events") as ProjectJsonArray
                    var state = TransformGizmo.attach(pose(request.get("proxy")))
                    check(!state.changed && !state.dragging && state.axis == null, "attached")
                    for (index in 0 until events.length()) {
                        val event = events.get(index) as ProjectJsonObject
                        val step = steps.get(index) as ProjectJsonObject
                        val kind = GizmoEventKind.entries.first { it.wire == event.get("kind") }
                        state = TransformGizmo.step(scene, state, kind, event.get("x") as Double, event.get("y") as Double)
                        check(state.changed == step.get("changed"), "changed_$checks ${entry[1].take(80)} $index")
                        val view = TransformGizmo.present(scene, state)
                        check(
                            sha256(view.json) == step.get("view") && view.axis == state.axis && view.dragging == state.dragging,
                            "view_$checks $index",
                        )
                    }
                }
                "C" -> {
                    val request = obj(entry[1])
                    val reply = obj(entry[2])
                    val origins = (request.get("origins") as ProjectJsonArray).let { list ->
                        List(list.length()) {
                            val origin = list.get(it) as ProjectJsonObject
                            ProjectIntents.InstanceTransform((origin.get("instanceId") as String).map { c -> c.code }, transform(origin.get("transform")))
                        }
                    }
                    val changes = TransformGizmo.changes(
                        pose(request.get("initialProxy")),
                        pose(request.get("proxy")),
                        TransformTool.entries.first { it.wire == request.get("mode") },
                        origins,
                    )
                    val expected = if (reply.keys().asSequence().any { it == "error" }) {
                        TransformFieldEdit.Refused(reply.get("message") as String)
                    } else {
                        val list = reply.get("changes") as ProjectJsonArray
                        TransformFieldEdit.Changes(
                            List(list.length()) {
                                val change = list.get(it) as ProjectJsonObject
                                ProjectIntents.InstanceTransform((change.get("instanceId") as String).map { c -> c.code }, transform(change.get("transform")))
                            },
                        )
                    }
                    check(changes == expected, "changes_$checks $changes")
                }
                "X" -> {
                    val refused = failure {
                        when (entry[1]) {
                            "attach" -> NativeProject.transformGizmoAttach(entry[2])
                            "step" -> NativeProject.transformGizmoStep(entry[2])
                            "present" -> NativeProject.transformGizmoPresent(entry[2])
                            else -> NativeProject.transformGizmoChanges(entry[2])
                        }
                    }
                    check(refused == "invalid_request", "refused_$checks ${entry[2]}")
                }
                else -> error("unknown line ${entry[0]}")
            }
        }
        // A value JSON cannot carry is refused before it is sent.
        val still = GizmoPose(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))
        check(failure { TransformGizmo.attach(still.copy(scale = listOf(Double.NaN, 1.0, 1.0))) } == "invalid_request", "non_finite_refused")
        check(TransformGizmo.attach(still).proxy == still, "attach_reads_back")
        return checks
    }
}
