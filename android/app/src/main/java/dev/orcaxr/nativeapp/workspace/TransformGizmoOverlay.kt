package dev.orcaxr.nativeapp.workspace

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.IntSize
import dev.orcaxr.core.GizmoCamera
import dev.orcaxr.core.GizmoHandle
import dev.orcaxr.core.GizmoMode
import dev.orcaxr.core.GizmoPose
import dev.orcaxr.core.GizmoScene
import dev.orcaxr.core.GizmoShape
import dev.orcaxr.core.GizmoView
import dev.orcaxr.core.TransformGizmo
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.Point3
import kotlin.math.pow
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * The transform gizmo as three.js's `TransformControls` draws it: each
 * visible handle of [view] — the [mode]'s gizmo group, then its helpers
 * (the axis line, the drag's start and end) — in its colour and opacity,
 * over everything, as the browser draws its handles without a depth test;
 * projected through [camera] into a [size] view.
 */
@Composable
internal fun TransformGizmoOverlay(view: GizmoView, mode: GizmoMode, camera: OrbitCamera?, size: IntSize) {
    if (camera == null || size.width <= 0 || size.height <= 0) return
    val shapes = remember(mode) { TransformGizmo.geometry().let { it.gizmo.getValue(mode) + it.helper.getValue(mode) } }
    Canvas(Modifier.fillMaxSize()) {
        val projector = GizmoProjector(camera, size)
        // The view lists the handles in the geometry's order; a mismatch draws nothing rather than the wrong shape.
        if (view.handles.size != shapes.size) return@Canvas
        view.handles.zip(shapes).forEach { (handle, shape) ->
            if (handle.visible && handle.name == shape.name) projector.draw(this, handle, shape)
        }
    }
}

/**
 * The gizmo's scene in the Workspace: the camera as the Filament scene
 * projects it, and the root that puts the printer's millimetres (Z up) into
 * render-space metres (Y up) as [dev.orcaxr.renderer.RenderSpace] does —
 * −90° about X, then a thousandth.
 */
internal object WorkspaceGizmo {
    const val FIELD_OF_VIEW = 45.0
    const val NEAR = .001
    const val FAR = 10.0
    val ROOT = GizmoPose(listOf(0.0, 0.0, 0.0), listOf(-sqrt(.5), 0.0, 0.0, sqrt(.5)), listOf(.001, .001, .001))

    /** The gizmo seen through [camera] in a [size] view with [mode]'s handles; null before the view has a size. */
    fun scene(camera: OrbitCamera, size: IntSize, mode: GizmoMode): GizmoScene? {
        if (size.width <= 0 || size.height <= 0) return null
        fun list(point: Point3) = listOf(point.x, point.y, point.z)
        val lens = GizmoCamera(FIELD_OF_VIEW, size.width.toDouble() / size.height, NEAR, FAR, list(camera.eye), list(camera.target), listOf(0.0, 1.0, 0.0))
        return GizmoScene(lens, ROOT, mode)
    }

    /** Where ([x], [y]) in a [size] view falls in normalized device coordinates (x right, y up, each from −1 to 1). */
    fun ndc(x: Float, y: Float, size: IntSize): Pair<Double, Double> = 2.0 * x / size.width - 1 to 1 - 2.0 * y / size.height
}

/**
 * Projects render-space points (metres) as [OrbitCamera.project] does — the
 * Workspace's 45° camera — keeping only what lies between its near and far
 * planes: a triangle is drawn whole or not at all, a line is clipped.
 */
private class GizmoProjector(camera: OrbitCamera, private val size: IntSize) {
    private val eye = camera.eye
    private val forward = (camera.target - eye).normalized()
    private val right = forward.cross(Point3(0.0, 1.0, 0.0)).normalized()
    private val up = right.cross(forward)
    private val extent = tan(Math.toRadians(WorkspaceGizmo.FIELD_OF_VIEW) / 2)
    private val aspect = size.width.toDouble() / size.height

    private fun depth(point: Point3) = (point - eye).dot(forward)

    private fun screen(point: Point3): Offset {
        val offset = point - eye
        val depth = offset.dot(forward)
        val x = offset.dot(right) / (depth * extent * aspect)
        val y = offset.dot(up) / (depth * extent)
        return Offset(((x + 1) / 2 * size.width).toFloat(), ((1 - y) / 2 * size.height).toFloat())
    }

    /** [shape]'s Float32 positions placed by [handle]'s world matrix (column-major, affine). */
    private fun world(handle: GizmoHandle, shape: GizmoShape): List<Point3> {
        val m = handle.matrix
        val p = shape.positions
        return List(p.size / 3) { i ->
            val x = p[3 * i].toDouble()
            val y = p[3 * i + 1].toDouble()
            val z = p[3 * i + 2].toDouble()
            Point3(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14])
        }
    }

    fun draw(scope: DrawScope, handle: GizmoHandle, shape: GizmoShape) {
        val color = color(handle)
        val points = world(handle, shape)
        if (shape.line) {
            // A three.js Line: a strip through its points, each segment clipped to what the camera sees.
            for (i in 0 until points.size - 1) clip(points[i], points[i + 1])?.let { (a, b) ->
                scope.drawLine(color, screen(a), screen(b), strokeWidth = LINE_WIDTH)
            }
            return
        }
        // three draws the handles' materials front side only: a triangle is drawn where it faces the camera,
        // counter-clockwise on screen with y up (clockwise here, y down), the other way under a mirroring matrix
        // (three's `frontFaceCW`). Drawing a closed mesh's back faces too would give every point inside it
        // windings that cancel, and the path's non-zero fill would leave it empty.
        val m = handle.matrix
        val mirrored = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) < 0
        val path = Path()
        val index = shape.index
        val corners = index?.size ?: points.size
        for (t in 0 until corners / 3) {
            val a = points[index?.get(3 * t) ?: (3 * t)]
            val b = points[index?.get(3 * t + 1) ?: (3 * t + 1)]
            val c = points[index?.get(3 * t + 2) ?: (3 * t + 2)]
            if (listOf(a, b, c).any { depth(it) !in NEAR..FAR }) continue
            val (pa, pb, pc) = Triple(screen(a), screen(b), screen(c))
            val turn = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)
            if (if (mirrored) turn <= 0 else turn >= 0) continue
            path.moveTo(pa.x, pa.y)
            path.lineTo(pb.x, pb.y)
            path.lineTo(pc.x, pc.y)
            path.close()
        }
        scope.drawPath(path, color)
    }

    /** The part of segment [a]–[b] between the near and far planes, or null when none of it is. */
    private fun clip(a: Point3, b: Point3): Pair<Point3, Point3>? {
        var from = a
        var to = b
        for ((limit, keepAbove) in listOf(NEAR to true, FAR to false)) {
            val da = depth(from) - limit
            val db = depth(to) - limit
            val inA = if (keepAbove) da >= 0 else da <= 0
            val inB = if (keepAbove) db >= 0 else db <= 0
            if (!inA && !inB) return null
            if (inA != inB) {
                val cut = from + (to - from) * (da / (da - db))
                if (inA) to = cut else from = cut
            }
        }
        return from to to
    }

    private companion object {
        const val NEAR = WorkspaceGizmo.NEAR
        const val FAR = WorkspaceGizmo.FAR
        const val LINE_WIDTH = 2f
    }
}

/** A handle's colour as the screen shows it: three's linear colour encoded to sRGB, with its opacity. */
private fun color(handle: GizmoHandle): Color {
    fun encode(linear: Double) = (if (linear <= .0031308) 12.92 * linear else 1.055 * linear.pow(1 / 2.4) - .055).coerceIn(0.0, 1.0).toFloat()
    val (r, g, b) = handle.color
    return Color(encode(r), encode(g), encode(b), handle.opacity.coerceIn(0.0, 1.0).toFloat())
}
