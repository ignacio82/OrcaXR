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

    /** Set the user's bed-translate offset (mm) — the same value the
     *  TransformSheet's Translate X/Y sliders carry. (0, 0) centers
     *  the model on the bed; positive X shifts right, positive Y
     *  shifts back. Stays correct under any rotation/scale because
     *  the renderer recomputes the rotated bbox per frame. */
    fun setBedTranslation(xMm: Float, yMm: Float) {
        renderer.bedTranslationMm = floatArrayOf(xMm, yMm)
        requestRender()
    }

    fun setModelScale(sx: Float, sy: Float, sz: Float) {
        renderer.modelScale = floatArrayOf(sx, sy, sz)
        requestRender()
    }

    /** Set the model's rotation in degrees around the mesh center
     *  (X then Y then Z, intrinsic). The renderer drops the rotated
     *  bbox flush to Z=0 so the model still rests on the bed even
     *  when tipped onto a different face. */
    fun setModelRotation(rotXDeg: Float, rotYDeg: Float, rotZDeg: Float) {
        renderer.modelRotationDeg = floatArrayOf(rotXDeg, rotYDeg, rotZDeg)
        requestRender()
    }

    fun resetView() {
        renderer.pendingCameraReset = true
        requestRender()
    }

    /**
     * Apply per-triangle paint to the rendered mesh. [palette] is a
     * list of RGBA float arrays (one per filament slot;
     * `palette[slotIndex - 1]` colors triangles tagged with slot N).
     * [paintFilamentIndex] is a per-triangle byte array; entry i = 0
     * means "unpainted" (mint default), 1..palette.size means "paint
     * with that slot's color". Pass null/empty palette + null index to
     * clear paint.
     */
    fun setPaint(palette: List<FloatArray>, paintFilamentIndex: ByteArray?) {
        if (palette.isEmpty() || paintFilamentIndex == null) {
            renderer.pendingPaintClear = true
        } else {
            renderer.pendingPaint = palette to paintFilamentIndex
        }
        requestRender()
    }

    /** Clear paint and revert to the uniform mint fill. */
    fun clearPaint() {
        renderer.pendingPaintClear = true
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
     *  rotated/scaled XY bbox, given the current rotation, scale, and
     *  translate. Mirrors ModelRenderer's drawModel placement so the
     *  drag hit target matches what the user sees. */
    private fun objectContains(bx: Float, by: Float): Boolean {
        val mesh = renderer.meshData ?: return false
        val s = renderer.modelScale
        val r = renderer.modelRotationDeg
        // Rotated/scaled bbox in mesh-centered coords (matches renderer).
        val halfW = (mesh.maxX - mesh.minX) / 2f * s[0]
        val halfH = (mesh.maxY - mesh.minY) / 2f * s[1]
        val halfD = (mesh.maxZ - mesh.minZ) / 2f * s[2]
        val rxRad = Math.toRadians(r[0].toDouble())
        val ryRad = Math.toRadians(r[1].toDouble())
        val rzRad = Math.toRadians(r[2].toDouble())
        val cx = kotlin.math.cos(rxRad).toFloat()
        val sxr = kotlin.math.sin(rxRad).toFloat()
        val cy = kotlin.math.cos(ryRad).toFloat()
        val syr = kotlin.math.sin(ryRad).toFloat()
        val cz = kotlin.math.cos(rzRad).toFloat()
        val szr = kotlin.math.sin(rzRad).toFloat()
        val r00 = cz * cy
        val r01 = cz * syr * sxr - szr * cx
        val r02 = cz * syr * cx + szr * sxr
        val r10 = szr * cy
        val r11 = szr * syr * sxr + cz * cx
        val r12 = szr * syr * cx - cz * sxr
        var minX = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        for (i in 0 until 8) {
            val px = if ((i and 1) == 0) -halfW else halfW
            val py = if ((i and 2) == 0) -halfH else halfH
            val pz = if ((i and 4) == 0) -halfD else halfD
            val nx = r00 * px + r01 * py + r02 * pz
            val ny = r10 * px + r11 * py + r12 * pz
            if (nx < minX) minX = nx
            if (nx > maxX) maxX = nx
            if (ny < minY) minY = ny
            if (ny > maxY) maxY = ny
        }
        val rWidth = maxX - minX
        val rDepth = maxY - minY
        val centeredX = renderer.bedWidthMm / 2f - minX - rWidth / 2f
        val centeredY = renderer.bedDepthMm / 2f - minY - rDepth / 2f
        val translate = renderer.bedTranslationMm
        val ox = centeredX + translate.getOrElse(0) { 0f } + minX
        val oy = centeredY + translate.getOrElse(1) { 0f } + minY
        return bx in ox..(ox + rWidth) && by in oy..(oy + rDepth)
    }
}
