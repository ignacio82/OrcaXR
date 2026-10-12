package dev.orcaxr.renderer

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.tan

/**
 * The browser's 3D-view navigation (three's `OrbitControls` as the flat shell
 * configures it: rotate, zoom and pan speeds 1, screen-space panning) on an
 * [OrbitCamera], so a finger, mouse, trackpad or stylus moves the camera as
 * it moves in the browser:
 *
 *  - [rotate]: a one-finger or left-button drag turns the camera 2π times the
 *    drag over the view's height, sideways about the vertical and up or down;
 *  - [pan]: a right-button (or Ctrl/Meta/Shift + left) drag slides the target
 *    with the pointer, as far as the drag spans at the target's distance;
 *  - [wheel]: a wheel or trackpad scroll zooms by `0.95^(|deltaY|·0.01)` per
 *    event (`_getZoomScale`), in when the content scrolls up (deltaY < 0),
 *    deltaY in CSS pixels — line-mode deltas count 16, page-mode 100, and a
 *    pinch arriving as Ctrl + wheel 10 times more ([wheelDelta]);
 *  - [dolly]: a middle-button drag zooms by the same scale per pixel, out
 *    when dragged down;
 *  - [pinch]: two fingers (a touchscreen's or a touchpad's) zoom by their
 *    spread, the distance divided by its ratio.
 *
 * The pitch stays short of straight up or down and the distance within the
 * view's bounds, which [OrbitCamera] requires; OrbitControls bounds neither
 * by default, so only those limits differ.
 */
object OrbitGestures {
    /** The camera's vertical field of view ([OrbitCamera.ray]'s 45°), which panning spans. */
    private val HALF_FIELD = tan(PI / 8)

    /** How a view bounds the camera: its pitch and distance range. */
    data class Limits(val minPitch: Double = .05, val maxPitch: Double = 1.5, val minDistance: Double = .05, val maxDistance: Double = 4.5) {
        init {
            require(minPitch < maxPitch && minPitch > -PI / 2 && maxPitch < PI / 2)
            require(minDistance >= .03 && minDistance < maxDistance && maxDistance <= 5.0)
        }
    }

    /** `rotateLeft(2π·dx/h)`, `rotateUp(2π·dy/h)` for a drag of [dx], [dy] pixels in a view [height] pixels tall. */
    fun rotate(camera: OrbitCamera, dx: Double, dy: Double, height: Int, limits: Limits = Limits()): OrbitCamera {
        if (height <= 0 || !dx.isFinite() || !dy.isFinite()) return camera
        return camera.copy(
            yaw = camera.yaw - 2 * PI * dx / height,
            pitch = (camera.pitch + 2 * PI * dy / height).coerceIn(limits.minPitch, limits.maxPitch),
        )
    }

    /** Screen-space `pan(dx, dy)`: the target follows a drag of [dx], [dy] pixels in a view [height] pixels tall. */
    fun pan(camera: OrbitCamera, dx: Double, dy: Double, height: Int): OrbitCamera {
        if (height <= 0 || !dx.isFinite() || !dy.isFinite()) return camera
        val forward = (camera.target - camera.eye).normalized()
        val right = forward.cross(Point3(0.0, 1.0, 0.0)).normalized()
        val up = right.cross(forward)
        val span = 2 * camera.distance * HALF_FIELD / height
        val target = camera.target + right * (-dx * span) + up * (dy * span)
        return if (target.finite()) camera.copy(target = target) else camera
    }

    /** `_getZoomScale(delta)`: the distance factor a dolly of [delta] makes. */
    fun zoomScale(delta: Double): Double = 0.95.pow(abs(delta * 0.01))

    /** A wheel event's `deltaY` as OrbitControls reads it (`_customWheelEvent`): line ×16, page ×100, Ctrl (a pinch) ×10. */
    fun wheelDelta(deltaY: Double, mode: WheelMode = WheelMode.PIXEL, ctrl: Boolean = false): Double {
        val scaled = when (mode) {
            WheelMode.PIXEL -> deltaY
            WheelMode.LINE -> deltaY * 16
            WheelMode.PAGE -> deltaY * 100
        }
        return if (ctrl) scaled * 10 else scaled
    }

    /** `_handleMouseWheel`: closer for a negative [deltaY] (CSS pixels, from [wheelDelta]), farther for a positive one. */
    fun wheel(camera: OrbitCamera, deltaY: Double, limits: Limits = Limits()): OrbitCamera = when {
        !deltaY.isFinite() || deltaY == 0.0 -> camera
        deltaY < 0 -> distance(camera, camera.distance * zoomScale(deltaY), limits)
        else -> distance(camera, camera.distance / zoomScale(deltaY), limits)
    }

    /** `_handleMouseMoveDolly`: a middle-button drag of [dy] pixels, farther when dragged down. */
    fun dolly(camera: OrbitCamera, dy: Double, limits: Limits = Limits()): OrbitCamera = when {
        !dy.isFinite() || dy == 0.0 -> camera
        dy > 0 -> distance(camera, camera.distance / zoomScale(dy), limits)
        else -> distance(camera, camera.distance * zoomScale(dy), limits)
    }

    /** `_handleTouchMoveDolly`: two fingers spread by [factor] (new span over old) bring the camera that much closer. */
    fun pinch(camera: OrbitCamera, factor: Double, limits: Limits = Limits()): OrbitCamera =
        if (!factor.isFinite() || factor <= 0) camera else distance(camera, camera.distance / factor, limits)

    private fun distance(camera: OrbitCamera, distance: Double, limits: Limits) =
        camera.copy(distance = distance.coerceIn(limits.minDistance, limits.maxDistance))

    /** A wheel event's `deltaMode`. */
    enum class WheelMode { PIXEL, LINE, PAGE }
}
