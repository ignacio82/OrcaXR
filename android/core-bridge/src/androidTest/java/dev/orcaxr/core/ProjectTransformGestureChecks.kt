package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * A drag of the Workspace's transform gizmo on a real session, over JNI, as
 * the Android Workspace drives it: [ProjectWorkspace.transformProxy] stands
 * the gizmo over the selection (nowhere with nothing selected; one
 * instance's own pose; the centre of a selection's bounds, unrotated);
 * [TransformGizmo] takes a press on a handle and the finger's moves through
 * the browser's TransformControls, seen through the Workspace's camera in
 * metres; each move's [TransformGizmo.changes] go to one
 * [ProjectWorkspace.TransformGesture], and the drag lands as exactly the
 * last move's changes — one undo entry, "Transform instance" or "Transform
 * 2 instances", that one undo takes back whole. Two drags are two gestures;
 * a gesture finished with nothing to apply changes nothing, nor does a pose
 * given after it finished.
 */
object ProjectTransformGestureChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view}" }
            Thread.sleep(5)
        }
        return workspace.view
    }
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** The Workspace's root: printer millimetres (Z up) as render-space metres (Y up), as `WorkspaceGizmo.ROOT`. */
    private val ROOT = GizmoPose(listOf(0.0, 0.0, 0.0), listOf(-sqrt(.5), 0.0, 0.0, sqrt(.5)), listOf(.001, .001, .001))
    private const val ASPECT = 720.0 / 1280.0

    /** A point (mm) in render-space metres. */
    private fun metres(mm: List<Double>) = listOf(mm[0] * .001, mm[2] * .001, -mm[1] * .001)

    /** The Workspace's camera: 45° vertical, up +Y, from [eye] at [target] (metres), and where a world point shows on it. */
    private class Lens(val eye: List<Double>, val target: List<Double>) {
        private fun minus(a: List<Double>, b: List<Double>) = List(3) { a[it] - b[it] }
        private fun dot(a: List<Double>, b: List<Double>) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        private fun cross(a: List<Double>, b: List<Double>) = listOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        private fun unit(a: List<Double>) = sqrt(dot(a, a)).let { n -> a.map { it / n } }
        private val forward = unit(minus(target, eye))
        private val right = unit(cross(forward, listOf(0.0, 1.0, 0.0)))
        private val up = cross(right, forward)
        private val extent = tan(Math.toRadians(45.0) / 2)

        fun scene(mode: GizmoMode) = GizmoScene(GizmoCamera(45.0, ASPECT, .001, 10.0, eye, target, listOf(0.0, 1.0, 0.0)), ROOT, mode)

        /** Where world point [p] shows, in normalized device coordinates. */
        fun ndc(p: List<Double>): Pair<Double, Double> {
            val offset = minus(p, eye)
            val depth = dot(offset, forward)
            return dot(offset, right) / (depth * extent * ASPECT) to dot(offset, up) / (depth * extent)
        }
    }

    /** [local] (a handle's own frame) through a handle's column-major world matrix. */
    private fun place(m: List<Double>, local: List<Double>) = List(3) { row ->
        m[row] * local[0] + m[4 + row] * local[1] + m[8 + row] * local[2] + m[12 + row]
    }

    /** The session's transforms of [ids] now. */
    @Suppress("UNCHECKED_CAST")
    private fun transforms(workspace: ProjectWorkspace, ids: Collection<String>): Map<String, ProjectIntents.Transform> = (done(
        workspace.actor.inspect { session ->
            session.snapshot().use { s -> s.query().use { root -> ProjectInspection.placed(root, ids.toSet()).mapValues { it.value.second } } }
        }.completion.toCompletableFuture(),
    ) as ProjectOutcome.Inspected).result.getOrThrow() as Map<String, ProjectIntents.Transform>

    private fun same(a: ProjectIntents.Transform, b: ProjectIntents.Transform) =
        a.translationMm == b.translationMm && a.rotation == b.rotation && a.scale == b.scale

    /** [cube], a binary STL, is imported twice. */
    @JvmStatic fun run(cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            check(done(workspace.transformProxy()) == TransformProxy.None, "nothing_selected_no_gizmo")
            done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            until(workspace, "imported") { it.activePlate?.objects == 1 }
            check(done(workspace.transformProxy()) == TransformProxy.None, "imported_unselected")

            // One instance: the gizmo stands at its own pose and a drag carries it alone.
            val first = transformsOfAll(workspace).keys.single()
            done(workspace.selectInstance(first))
            val one = done(workspace.transformProxy()) as? TransformProxy.Placed
            check(one != null && one.primaryInstanceId == first && one.origins.size == 1, "one_placed $one")
            val home = transforms(workspace, listOf(first)).getValue(first)
            checkNotNull(one)
            check(one.pose.position == home.translationMm && one.pose.quaternion == home.rotation && one.pose.scale == home.scale, "stands_at_its_pose")

            // The Workspace's camera, from the front right and above, on the cube.
            val centre = metres(home.translationMm)
            val lens = Lens(listOf(centre[0] + .12, centre[1] + .1, centre[2] + .16), centre)
            var state = TransformGizmo.attach(one.pose)
            val translate = lens.scene(GizmoMode.TRANSLATE)
            val x = TransformGizmo.present(translate, state).handles.first { it.group == "gizmo" && it.name == "X" }
            // On the X arrow's shaft (its picker runs from the centre to 0.6 handle units), and towards its tip.
            val (sx, sy) = lens.ndc(place(x.matrix, listOf(.3, 0.0, 0.0)))
            val (tx, ty) = lens.ndc(place(x.matrix, listOf(.6, 0.0, 0.0)))
            state = TransformGizmo.step(translate, state, GizmoEventKind.HOVER, sx, sy)
            check(state.axis == "X" && !state.dragging, "hover_x ${state.axis}")
            state = TransformGizmo.step(translate, state, GizmoEventKind.PRESS, sx, sy)
            check(state.axis == "X" && state.dragging, "press_x")
            val earlier = workspace.view.undo
            val gesture = workspace.transformGesture()
            val initial = state.proxy
            var last: List<ProjectIntents.InstanceTransform>? = null
            for (step in 1..4) {
                state = TransformGizmo.step(translate, state, GizmoEventKind.MOVE, sx + (tx - sx) * step / 2, sy + (ty - sy) * step / 2)
                check(state.changed, "move_changes_$step")
                val edit = TransformGizmo.changes(initial, state.proxy, TransformTool.MOVE, one.origins)
                check(edit is TransformFieldEdit.Changes && edit.changes.size == 1, "move_edit_$step")
                last = (edit as TransformFieldEdit.Changes).changes
                gesture.update(last)
            }
            state = TransformGizmo.step(translate, state, GizmoEventKind.RELEASE, tx, ty)
            check(!state.dragging && state.axis == null, "released")
            done(gesture.finish())
            val moved = transforms(workspace, listOf(first)).getValue(first)
            check(same(moved, checkNotNull(last).single().transform), "lands_as_the_last_move")
            // Along the printer's X alone (the gizmo's red axis), by a visible amount.
            check(moved.translationMm[1] == home.translationMm[1] && moved.translationMm[2] == home.translationMm[2], "only_x_moves")
            check(kotlin.math.abs(moved.translationMm[0] - home.translationMm[0]) > 5, "x_moved ${moved.translationMm}")
            check(until(workspace, "moved_label") { it.undo == "Transform instance" }.undo == "Transform instance", "one_entry_label")
            // The four moves are one step: one undo takes the whole drag back.
            done(workspace.undo())
            check(same(transforms(workspace, listOf(first)).getValue(first), home), "one_undo_restores")
            check(until(workspace, "undone") { it.redo == "Transform instance" }.undo == earlier, "whole_drag_undone")
            done(workspace.redo())
            check(same(transforms(workspace, listOf(first)).getValue(first), moved), "redo_moves_again")
            // After the drag the gizmo stands where the instance now is.
            val again = done(workspace.transformProxy()) as? TransformProxy.Placed
            check(again?.pose?.position == moved.translationMm, "stands_where_it_moved")

            // A gesture with nothing to apply changes nothing, nor does a pose given after it finished.
            val revision = workspace.view.revision
            val idle = workspace.transformGesture()
            check(idle.id != gesture.id && idle.id.startsWith("transform-controls:"), "gestures_are_distinct ${idle.id}")
            done(idle.finish())
            idle.update(last)
            Thread.sleep(200)
            check(workspace.view.revision == revision, "finished_gesture_takes_nothing")

            // Two instances: a second cube beside the first, both selected (the second primary).
            done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            until(workspace, "second") { it.activePlate?.objects == 2 }
            val second = transformsOfAll(workspace).keys.single { it != first }
            val beside = ProjectIntents.Transform(listOf(moved.translationMm[0] + 40, moved.translationMm[1], 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))
            done(workspace.execute(ProjectIntents.Command.SetInstanceTransform(ProjectIntents.SetInstanceTransform(units(second), beside, units("setup:beside")))))
            done(workspace.selectInstance(first))
            done(workspace.selectInstance(second, extend = true))
            val two = done(workspace.transformProxy()) as? TransformProxy.Placed
            check(two != null && two.primaryInstanceId == second && two.origins.size == 2, "two_placed $two")
            checkNotNull(two)
            // The centre of their bounds, unrotated and unscaled: between the two cubes.
            check(two.pose.quaternion == listOf(0.0, 0.0, 0.0, 1.0) && two.pose.scale == listOf(1.0, 1.0, 1.0), "pivot_unrotated")
            check(two.pose.position[0] > moved.translationMm[0] && two.pose.position[0] < beside.translationMm[0], "pivot_between ${two.pose.position}")
            val before = transforms(workspace, listOf(first, second))

            // Rotate about the printer's Z (the gizmo's green ring, three's world Y): a press found on the ring.
            val rotate = lens.scene(GizmoMode.ROTATE)
            var turning = TransformGizmo.attach(two.pose)
            val ring = TransformGizmo.present(rotate, turning).handles.first { it.group == "gizmo" && it.name == "Y" }
            val press = (0 until 24).map { it * Math.PI / 12 }.map { angle ->
                lens.ndc(place(ring.matrix, listOf(.5 * cos(angle), 0.0, .5 * sin(angle))))
            }.firstOrNull { (px, py) -> TransformGizmo.step(rotate, turning, GizmoEventKind.HOVER, px, py).axis == "Y" }
            check(press != null, "found_the_ring")
            val (px, py) = checkNotNull(press)
            turning = TransformGizmo.step(rotate, turning, GizmoEventKind.PRESS, px, py)
            check(turning.axis == "Y" && turning.dragging, "press_ring")
            val turn = workspace.transformGesture()
            val pivot = turning.proxy
            var turned: List<ProjectIntents.InstanceTransform>? = null
            for (step in 1..3) {
                turning = TransformGizmo.step(rotate, turning, GizmoEventKind.MOVE, px + .04 * step, py - .03 * step)
                if (!turning.changed) continue
                val edit = TransformGizmo.changes(pivot, turning.proxy, TransformTool.ROTATE, two.origins)
                check(edit is TransformFieldEdit.Changes && edit.changes.size == 2, "turn_edit_$step")
                turned = (edit as TransformFieldEdit.Changes).changes
                turn.update(turned)
            }
            check(turned != null, "the_ring_turned")
            TransformGizmo.step(rotate, turning, GizmoEventKind.RELEASE, px, py)
            done(turn.finish())
            val after = transforms(workspace, listOf(first, second))
            check(checkNotNull(turned).all { change -> same(after.getValue(text(change.instanceId)), change.transform) }, "both_land")
            // Turned about the vertical: still on the bed, rotated about Z alone.
            check(after.values.all { t -> kotlin.math.abs(t.translationMm[2]) < 1e-9 && kotlin.math.abs(t.rotation[0]) < 1e-9 && kotlin.math.abs(t.rotation[1]) < 1e-9 && kotlin.math.abs(t.rotation[2]) > 1e-3 }, "both_turn_about_z $after")
            check(until(workspace, "turned_label") { it.undo == "Transform 2 instances" }.undo == "Transform 2 instances", "two_instance_label")
            done(workspace.undo())
            val restored = transforms(workspace, listOf(first, second))
            check(restored.all { (id, t) -> same(t, before.getValue(id)) }, "one_undo_restores_both")
        }
        return checks
    }

    /** Every instance of the project and its transform. */
    private fun transformsOfAll(workspace: ProjectWorkspace): Map<String, ProjectIntents.Transform> {
        @Suppress("UNCHECKED_CAST")
        val ids = (done(
            workspace.actor.inspect { session -> session.snapshot().use { s -> s.query().use { ProjectFacts.instances(it) } } }.completion.toCompletableFuture(),
        ) as ProjectOutcome.Inspected).result.getOrThrow() as List<InstanceFacts>
        return transforms(workspace, ids.map { it.id })
    }
}
