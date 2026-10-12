package dev.orcaxr.nativeapp.workspace

import android.os.Build
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.OrbitGestures

/**
 * How a pointer moves a 3D view's camera, as the browser's `OrbitControls`
 * maps its input ([OrbitGestures]): a finger, a pen or the left button drags
 * to orbit (with Ctrl, Meta or Shift held, the left button pans); the right
 * button drags to pan (with one of them held, to orbit); the middle button
 * drags to zoom; two fingers — on the screen or a touchpad — pinch to zoom; a
 * mouse wheel, a trackpad's scroll or a touchpad's two-finger swipe zooms, as
 * the browser's wheel does (Chrome's deltas: the platform's scroll factor in
 * dp per notch, Ctrl + wheel taken as a pinch).
 */
internal class ViewNavigation(
    private val view: View,
    private val limits: OrbitGestures.Limits,
    private val camera: () -> OrbitCamera?,
    private val move: (OrbitCamera) -> Unit,
) {
    /** What a drag in progress does. */
    enum class Drag { ROTATE, PAN, DOLLY }

    /** The drag a press starts, by its button and the keyboard's modifiers. */
    fun dragFor(event: MotionEvent): Drag {
        val modified = event.metaState and (KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON or KeyEvent.META_SHIFT_ON) != 0
        val buttons = event.buttonState
        return when {
            !isMouse(event) -> Drag.ROTATE
            buttons and MotionEvent.BUTTON_TERTIARY != 0 -> Drag.DOLLY
            buttons and MotionEvent.BUTTON_SECONDARY != 0 -> if (modified) Drag.ROTATE else Drag.PAN
            modified -> Drag.PAN
            else -> Drag.ROTATE
        }
    }

    /** A drag of [dx], [dy] pixels. */
    fun drag(drag: Drag, dx: Float, dy: Float) {
        val old = camera() ?: return
        move(
            when (drag) {
                Drag.ROTATE -> OrbitGestures.rotate(old, dx.toDouble(), dy.toDouble(), view.height, limits)
                Drag.PAN -> OrbitGestures.pan(old, dx.toDouble(), dy.toDouble(), view.height)
                Drag.DOLLY -> OrbitGestures.dolly(old, dy.toDouble(), limits)
            },
        )
    }

    /** Two fingers spread by [factor]. */
    fun pinch(factor: Float) {
        val old = camera() ?: return
        move(OrbitGestures.pinch(old, factor.toDouble(), limits))
    }

    /** A wheel's or a trackpad's scroll (`ACTION_SCROLL`): zoom, as the browser's wheel. Whether it was one. */
    fun scroll(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_SCROLL || !event.isFromSource(InputDevice.SOURCE_CLASS_POINTER)) return false
        val notches = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
        if (notches == 0f) return false
        // Chrome's deltaY: a notch is the platform's scroll factor, in CSS pixels (dp); scrolling up is negative.
        val factor = ViewConfiguration.get(view.context).scaledVerticalScrollFactor / view.resources.displayMetrics.density
        wheel(OrbitGestures.wheelDelta(-notches.toDouble() * factor, ctrl = event.metaState and KeyEvent.META_CTRL_ON != 0))
        return true
    }

    /**
     * A touchpad's two-finger swipe (Android 14's `CLASSIFICATION_TWO_FINGER_SWIPE`):
     * zoom by its vertical distance, as the browser zooms on a trackpad's
     * scroll; such events never orbit. Whether [event] was one.
     */
    fun swipe(event: MotionEvent): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
        if (event.classification != MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE) return false
        if (event.actionMasked == MotionEvent.ACTION_MOVE) {
            val distance = event.getAxisValue(MotionEvent.AXIS_GESTURE_SCROLL_Y_DISTANCE)
            if (distance != 0f) wheel(-distance.toDouble() / view.resources.displayMetrics.density)
        }
        return true
    }

    private fun wheel(deltaY: Double) {
        val old = camera() ?: return
        move(OrbitGestures.wheel(old, deltaY, limits))
    }

    companion object {
        /** Whether [event] comes from a mouse (or a touchpad acting as one). */
        fun isMouse(event: MotionEvent): Boolean =
            event.isFromSource(InputDevice.SOURCE_MOUSE) && event.getToolType(0) == MotionEvent.TOOL_TYPE_MOUSE

        /**
         * Whether a press asks for a context menu, as a secondary click: the
         * mouse's right button (a touchpad's two-finger click), or a pen's
         * button held as it touches (Android's context click for a stylus).
         */
        fun isContextPress(event: MotionEvent): Boolean {
            val buttons = event.buttonState
            return (isMouse(event) && buttons and MotionEvent.BUTTON_SECONDARY != 0) ||
                (event.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS && buttons and MotionEvent.BUTTON_STYLUS_PRIMARY != 0)
        }
    }
}
