/*
 * Adapted from u1-slicer-for-android (AGPL-3.0 — see NOTICE.md).
 * Slimmed: single mesh + drag-to-move on the bed, no wipe tower, no
 * multi-instance hit testing, no GL frame capture.
 */
package dev.orcaxr.app.mobile.viewer

import android.content.Context
import android.view.MotionEvent

class ModelViewerView(context: Context) : BaseGLViewerView(context) {

    val renderer = ModelRenderer(context)
    override val camera: Camera get() = renderer.camera

    /** When true, single-finger drag on the bed translates the model. */
    @Volatile var placementMode: Boolean = false

    /** Fired during placement-mode drag with bed-mm deltas (dx, dy). */
    var onObjectMoved: ((dxMm: Float, dyMm: Float) -> Unit)? = null

    /** Fired once when placement-mode drag ends. */
    var onObjectMoveEnded: (() -> Unit)? = null

    private var isDraggingObject = false
    private var lastBedX = 0f
    private var lastBedY = 0f

    init {
        setEGLContextClientVersion(3)
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
    }

    fun setMesh(mesh: MeshData) {
        renderer.pendingMesh = mesh
        requestRender()
    }

    fun clearMesh() {
        renderer.pendingClearMesh = true
        requestRender()
    }

    /** Update bed dimensions from the active profile. Renderer rebuilds
     *  the bed mesh on the next GL frame and resets the camera if the
     *  mesh hasn't loaded yet. */
    fun setBedSize(widthMm: Float, depthMm: Float) {
        if (widthMm <= 0f || depthMm <= 0f) return
        renderer.bedWidthMm = widthMm
        renderer.bedDepthMm = depthMm
        requestRender()
    }

    /** Set the model's position on the bed (mm, XY-min corner of the
     *  scaled bbox). Pass null to recenter on the bed. */
    fun setObjectPosition(xMm: Float?, yMm: Float?) {
        renderer.objectPosition =
            if (xMm == null || yMm == null) null else floatArrayOf(xMm, yMm)
        requestRender()
    }

    fun setModelScale(sx: Float, sy: Float, sz: Float) {
        renderer.modelScale = floatArrayOf(sx, sy, sz)
        requestRender()
    }

    fun resetView() {
        renderer.pendingCameraReset = true
        requestRender()
    }

    fun applyCameraState(state: CameraViewState) {
        renderer.preserveCameraOnNextMeshUpload = true
        renderer.pendingCameraReset = false
        renderer.pendingCameraState = state
        requestRender()
    }

    override fun handleActionDown(event: MotionEvent) {
        if (!placementMode) return
        val mesh = renderer.meshData ?: return
        // Hit at half model height for the elevated camera; fall back to bed plane.
        val s = renderer.modelScale
        val halfZ = (mesh.maxZ - mesh.minZ) * s[2] / 2f
        val hit = renderer.screenToBed(event.x, event.y, halfZ)
            ?: renderer.screenToBed(event.x, event.y, 0f)
            ?: return
        if (objectContains(hit[0], hit[1])) {
            isDraggingObject = true
            lastBedX = hit[0]
            lastBedY = hit[1]
            renderer.highlighted = true
            requestRender()
            onActionDownHandled = true
        }
    }

    override fun handlePointerDown() {
        if (isDraggingObject) {
            isDraggingObject = false
            renderer.highlighted = false
            requestRender()
        }
    }

    override fun handleActionMove(event: MotionEvent): Boolean {
        if (!placementMode || !isDraggingObject || event.pointerCount != 1) return false
        val bed = renderer.screenToBed(event.x, event.y) ?: return true
        val dx = bed[0] - lastBedX
        val dy = bed[1] - lastBedY
        lastBedX = bed[0]
        lastBedY = bed[1]
        onObjectMoved?.invoke(dx, dy)
        requestRender()
        return true
    }

    override fun handleActionUp(event: MotionEvent) {
        if (isDraggingObject) {
            isDraggingObject = false
            renderer.highlighted = false
            onObjectMoveEnded?.invoke()
            requestRender()
        }
    }

    override fun handleActionCancel() {
        if (isDraggingObject) {
            isDraggingObject = false
            renderer.highlighted = false
            requestRender()
        }
    }

    /** Test whether bed coord (bx, by) falls inside the model's
     *  scaled XY bbox, given its current objectPosition. */
    private fun objectContains(bx: Float, by: Float): Boolean {
        val mesh = renderer.meshData ?: return false
        val s = renderer.modelScale
        val width = (mesh.maxX - mesh.minX) * s[0]
        val depth = (mesh.maxY - mesh.minY) * s[1]
        val pos = renderer.objectPosition
        val ox: Float
        val oy: Float
        if (pos != null && pos.size >= 2) {
            ox = pos[0]; oy = pos[1]
        } else {
            ox = renderer.bedWidthMm / 2f - width / 2f
            oy = renderer.bedDepthMm / 2f - depth / 2f
        }
        return bx >= ox && bx <= ox + width && by >= oy && by <= oy + depth
    }
}
