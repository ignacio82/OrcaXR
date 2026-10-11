package dev.orcaxr.renderer

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.sqrt

/** The browser's View menu camera views (`view_camera_<id>`, web/src/actions/groups/view.ts), in its order. */
enum class CameraView(val id: String) {
    DEFAULT("default"), TOP("top"), FRONT("front"), LEFT("left"), RIGHT("right"), REAR("rear"), BOTTOM("bottom"),
}

/**
 * The browser's camera views (`OrcaWorkspace.frameCameraView`) on a bed of
 * a given size: the camera looks at the plate's centre lifted a little, from
 * an offset in multiples of the bed's larger side, so any bed is framed the
 * way the browser frames it — Default from above the front, Top and Bottom
 * straight down and up (a hair off the pole, as the browser keeps
 * OrbitControls out of gimbal lock), the four sides from just above the
 * plate. The browser's world is printer metres scaled by its workspace
 * scale; offsets are multiples of the span, so only its two absolute lengths
 * (the lift and the pole's hair) are scaled back here. Both look along the
 * same axes: +x to the printer's right, +y up, +z toward its front.
 */
object CameraViews {
    /** The browser workspace's scale (`WORKSPACE_SCALE`): its world is printer metres times this. */
    private const val WORKSPACE_SCALE = 1.75
    /** `plateFocus`: the plate's centre lifted 0.03 world units, in printer metres. */
    const val FOCUS_LIFT = .03 / WORKSPACE_SCALE
    /** The depth the browser gives the straight-down and straight-up views, in printer metres. */
    const val POLE = .0015 / WORKSPACE_SCALE

    /** The camera for [view] over a bed of [widthMm] by [depthMm], drawn from the origin. */
    fun of(view: CameraView, widthMm: Double, depthMm: Double): OrbitCamera {
        require(widthMm.isFinite() && depthMm.isFinite() && widthMm > 0 && depthMm > 0)
        val offset = offset(view, max(widthMm, depthMm) * .001)
        val distance = sqrt(offset.dot(offset))
        val target = RenderSpace.point(Point3(widthMm / 2, depthMm / 2, 0.0)) + Point3(0.0, FOCUS_LIFT, 0.0)
        // The renderer draws to 10 m: a bed past 2.3 m is seen from the camera's farthest orbit.
        return OrbitCamera(atan2(offset.x, offset.z), asin(offset.y / distance), distance.coerceIn(.03, 5.0), target)
    }

    /** The eye's offset from the target for [view], for a bed whose larger side is [span] metres. */
    fun offset(view: CameraView, span: Double): Point3 {
        val far = span * 2.15
        return when (view) {
            CameraView.DEFAULT -> Point3(0.0, span, span * 1.7)
            CameraView.TOP -> Point3(0.0, far, POLE)
            CameraView.BOTTOM -> Point3(0.0, -far, POLE)
            CameraView.FRONT -> Point3(0.0, span * .17, far)
            CameraView.REAR -> Point3(0.0, span * .17, -far)
            CameraView.LEFT -> Point3(-far, span * .17, 0.0)
            CameraView.RIGHT -> Point3(far, span * .17, 0.0)
        }
    }
}
