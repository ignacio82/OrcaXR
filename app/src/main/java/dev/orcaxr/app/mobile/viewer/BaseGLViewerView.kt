/*
 * Ported from u1-slicer-for-android (AGPL-3.0 — see NOTICE.md).
 * Common touch-gesture base for GL-backed 3D viewers.
 */
package dev.orcaxr.app.mobile.viewer

import android.content.Context
import android.graphics.Rect
import android.opengl.GLSurfaceView
import android.os.Build
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ScaleGestureDetector

/**
 * Base GLSurfaceView with touch gestures:
 *  - Pinch to zoom
 *  - Single-finger orbit (rotate)
 *  - Two-finger pan
 *  - Long-press → single-finger pan mode (with haptic)
 *  - systemGestureExclusionRects keeps Android edge-swipe out of the way
 *  - requestDisallowInterceptTouchEvent prevents Compose scroll from stealing events
 */
abstract class BaseGLViewerView(context: Context) : GLSurfaceView(context) {

    init {
        // 24-bit depth — kills Z-fighting on flat / thin objects.
        setEGLConfigChooser(8, 8, 8, 8, 24, 0)
    }

    abstract val camera: Camera
    var onCameraChanged: ((CameraViewState) -> Unit)? = null
    private var pendingCameraDispatch = false

    private val scaleDetector =
        ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    camera.zoom(1.0 / detector.scaleFactor)
                    markCameraChanged()
                    requestRender()
                    return true
                }
            },
        )

    private val gestureDetector =
        GestureDetector(
            context,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onLongPress(e: MotionEvent) {
                    if (pointerCount == 1 && !onActionDownHandled) {
                        isPanMode = true
                        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    }
                }
            },
        )

    protected var isPanMode = false
    private var pointerCount = 0
    private var previousX = 0f
    private var previousY = 0f
    private var previousMidX = 0f
    private var previousMidY = 0f

    /** Subclasses set true in handleActionDown to suppress long-press pan when handling drag. */
    protected var onActionDownHandled = false

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            systemGestureExclusionRects = listOf(Rect(0, 0, w, h))
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestureDetector.onTouchEvent(event)
        scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                previousX = event.x
                previousY = event.y
                pointerCount = 1
                isPanMode = false
                onActionDownHandled = false
                handleActionDown(event)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                handlePointerDown()
                pointerCount = event.pointerCount
                if (pointerCount >= 2) {
                    previousMidX = (event.getX(0) + event.getX(1)) / 2
                    previousMidY = (event.getY(0) + event.getY(1)) / 2
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (!handleActionMove(event)) {
                    if (pointerCount == 1 && event.pointerCount == 1) {
                        val dx = event.x - previousX
                        val dy = event.y - previousY
                        if (isPanMode) {
                            val panScale = camera.distance * 0.003
                            camera.pan(-dx.toDouble() * panScale, dy.toDouble() * panScale)
                        } else {
                            camera.rotate(-dx.toDouble() * 0.3, dy.toDouble() * 0.3)
                        }
                        markCameraChanged()
                        requestRender()
                        previousX = event.x
                        previousY = event.y
                    } else if (event.pointerCount >= 2) {
                        val midX = (event.getX(0) + event.getX(1)) / 2
                        val midY = (event.getY(0) + event.getY(1)) / 2
                        val dx = midX - previousMidX
                        val dy = midY - previousMidY
                        val panScale = camera.distance * 0.002
                        camera.pan(-dx.toDouble() * panScale, dy.toDouble() * panScale)
                        markCameraChanged()
                        requestRender()
                        previousMidX = midX
                        previousMidY = midY
                    }
                }
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_POINTER_UP -> {
                isPanMode = false
                handleActionUp(event)
                pointerCount = event.pointerCount - 1
                if (event.pointerCount == 2) {
                    val remainingIdx = if (event.actionIndex == 0) 1 else 0
                    previousX = event.getX(remainingIdx)
                    previousY = event.getY(remainingIdx)
                } else if (event.pointerCount <= 1) {
                    previousX = event.x
                    previousY = event.y
                }
                dispatchCameraChangedIfNeeded()
            }
            MotionEvent.ACTION_CANCEL -> {
                isPanMode = false
                pointerCount = 0
                handleActionCancel()
                dispatchCameraChangedIfNeeded()
                requestRender()
            }
        }
        return true
    }

    protected open fun handleActionDown(event: MotionEvent) {}

    protected open fun handlePointerDown() {}

    protected open fun handleActionMove(event: MotionEvent): Boolean = false

    protected open fun handleActionUp(event: MotionEvent) {}

    protected open fun handleActionCancel() {}

    protected fun markCameraChanged() {
        pendingCameraDispatch = true
    }

    protected fun dispatchCameraChangedIfNeeded() {
        if (!pendingCameraDispatch) return
        pendingCameraDispatch = false
        onCameraChanged?.invoke(camera.snapshot())
    }
}
