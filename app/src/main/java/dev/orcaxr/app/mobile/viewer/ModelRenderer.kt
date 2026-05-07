/*
 * Adapted from u1-slicer-for-android (AGPL-3.0 — see NOTICE.md).
 * Slimmed for OrcaXR's mobile shell:
 *  - Configurable bed size (sourced from active profile's printable_area;
 *    u1-slicer hardcoded 270×270 for the Snapmaker U1).
 *  - Procedurally-generated rectangular bed mesh (u1-slicer loaded a
 *    bundled u1_bed.stl asset; OrcaXR supports any printer so we
 *    generate a quad at runtime from the configured bed dimensions).
 *  - No vendor logo texture, no wipe tower, no multi-instance, no
 *    extruder-color recoloring — those features live in the XR shell.
 *  - Single mesh placed at a single (objectX, objectY) bed position
 *    that the host updates as the user drags.
 */
package dev.orcaxr.app.mobile.viewer

import android.content.Context
import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.os.Handler
import android.os.Looper
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.cos
import kotlin.math.sin

class ModelRenderer(private val context: Context) : GLSurfaceView.Renderer {

    val camera = Camera()
    private val mainHandler = Handler(Looper.getMainLooper())

    var meshData: MeshData? = null
        private set

    private var modelShader: ShaderProgram? = null
    private var gridShader: ShaderProgram? = null

    private var modelVAO = 0
    private var modelVBO = 0
    private var useVertexColorLoc = -1

    private var bedFillVAO = 0
    private var bedFillVertexCount = 0
    private var gridVAO = 0
    private var gridVertexCount = 0
    private var majorGridVAO = 0
    private var majorGridVertexCount = 0
    private var bedBorderVAO = 0

    /** Bed dimensions in mm, set from the active profile. */
    @Volatile var bedWidthMm: Float = 256f
    @Volatile var bedDepthMm: Float = 256f
    private var lastBedWidth = -1f
    private var lastBedDepth = -1f

    /** Default model color when no per-vertex coloring is present. Mint
     *  to match OrcaXR's brand. */
    private val modelColorDefault = floatArrayOf(0.475f, 0.816f, 0.780f, 1f)
    private val highlightColor = floatArrayOf(1f, 0.6f, 0.2f, 1f)

    /** XY offset (mm) from "model centered on the bed" — the user's
     *  TransformSheet translate sliders feed this directly. (0, 0)
     *  means the rotated/scaled model bbox is centered on the bed;
     *  positive X shifts right, positive Y shifts back. The renderer
     *  recomputes the rotated/scaled bbox per frame so this offset
     *  stays correct under any rotation/scale. */
    @Volatile var bedTranslationMm = floatArrayOf(0f, 0f)

    /** Uniform scale (X,Y,Z); applied around the mesh center. */
    @Volatile var modelScale = floatArrayOf(1f, 1f, 1f)

    /** Per-axis rotation in degrees (X, Y, Z), applied around the mesh
     *  center as Z * Y * X (intrinsic Tait-Bryan, matching the
     *  TransformSheet's slider semantics). */
    @Volatile var modelRotationDeg = floatArrayOf(0f, 0f, 0f)

    /** True while the user is mid-drag. Tints the model. */
    @Volatile var highlighted: Boolean = false

    private var viewportWidth = 1
    private var viewportHeight = 1

    @Volatile var pendingMesh: MeshData? = null
    @Volatile var pendingClearMesh = false
    @Volatile var preserveCameraOnNextMeshUpload = false
    @Volatile var pendingCameraReset = false
    @Volatile var pendingCameraState: CameraViewState? = null
    @Volatile var onContentReady: (() -> Unit)? = null
    @Volatile private var pendingContentReadyDispatch = false

    /** Pending paint apply: (palette, perTriangleSlotIndex). Set on the
     *  UI thread; consumed at the top of onDrawFrame on the GL thread.
     *  When non-null the renderer rewrites every vertex's color via
     *  [MeshData.recolorByPaint] and re-uploads the VBO. Pass `null`
     *  for both members of the pair to clear paint and revert to the
     *  uniform mint fill. */
    @Volatile var pendingPaint: Pair<List<FloatArray>, ByteArray?>? = null

    /** Set true to clear paint and revert to the uniform color. */
    @Volatile var pendingPaintClear = false

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        // Background — OrcaXR mobile dark surface (matches MobilePalette.Dark.Bg).
        GLES30.glClearColor(0.039f, 0.086f, 0.149f, 1f)
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
        GLES30.glEnable(GLES30.GL_CULL_FACE)

        modelShader = ShaderProgram(context, "shaders/model.vert", "shaders/model.frag")
        gridShader = ShaderProgram(context, "shaders/grid.vert", "shaders/grid.frag")

        useVertexColorLoc = modelShader!!.getUniformLocation("u_UseVertexColor")

        rebuildBed()
        resetCameraToDefaultView()
    }

    private fun resetCameraToDefaultView() {
        camera.setTarget((bedWidthMm / 2f).toDouble(), (bedDepthMm / 2f).toDouble(), 0.0)
        camera.distance = (maxOf(bedWidthMm, bedDepthMm) * 1.85).toDouble().coerceAtLeast(200.0)
        camera.elevation = 55.0
        camera.azimuth = -75.0
        camera.panX = 0.0
        camera.panY = 0.0
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES30.glViewport(0, 0, width, height)
        viewportWidth = width
        viewportHeight = height
        camera.updateProjectionMatrix(width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        // Bed dimensions changed → regenerate the bed mesh + reset camera.
        if (bedWidthMm != lastBedWidth || bedDepthMm != lastBedDepth) {
            rebuildBed()
            if (meshData == null) resetCameraToDefaultView()
        }

        pendingCameraState?.let { state ->
            camera.restore(state)
            pendingCameraState = null
        }

        if (pendingClearMesh) {
            pendingClearMesh = false
            meshData = null
        }

        pendingMesh?.let { mesh ->
            // Apply any paint that arrived BEFORE the mesh upload, so
            // the initial glBufferData carries the recolored vertex data
            // and the user doesn't see a single flat-mint frame before
            // colors flip in.
            pendingPaint?.let { (palette, idx) ->
                mesh.recolorByPaint(palette, idx)
                pendingPaint = null
            }
            uploadMesh(mesh)
            meshData = mesh
            pendingMesh = null
            pendingCameraReset = !preserveCameraOnNextMeshUpload
            preserveCameraOnNextMeshUpload = false
            pendingContentReadyDispatch = true
        }

        // Apply paint to an already-uploaded mesh.
        if (pendingPaint != null) {
            meshData?.let { mesh ->
                pendingPaint?.let { (palette, idx) ->
                    mesh.recolorByPaint(palette, idx)
                    refreshColorVbo(mesh)
                    pendingPaint = null
                }
            }
        }
        if (pendingPaintClear) {
            pendingPaintClear = false
            meshData?.let { mesh ->
                mesh.resetToUniformColor()
                refreshColorVbo(mesh)
            }
        }

        if (pendingCameraReset && meshData != null) {
            pendingCameraReset = false
            resetCameraToDefaultView()
        }

        camera.updateViewMatrix()
        if (viewportWidth > 0 && viewportHeight > 0) {
            camera.updateProjectionMatrix(viewportWidth, viewportHeight)
        }

        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
        drawBedAndGrid()
        meshData?.let { drawModel(it) }

        if (pendingContentReadyDispatch) {
            pendingContentReadyDispatch = false
            onContentReady?.let { cb -> mainHandler.post { cb() } }
        }
    }

    private fun uploadMesh(mesh: MeshData) {
        if (modelVAO != 0) {
            GLES30.glDeleteVertexArrays(1, intArrayOf(modelVAO), 0)
        }
        if (modelVBO != 0) {
            GLES30.glDeleteBuffers(1, intArrayOf(modelVBO), 0)
        }
        val vaos = IntArray(1)
        GLES30.glGenVertexArrays(1, vaos, 0); modelVAO = vaos[0]
        val vbos = IntArray(1)
        GLES30.glGenBuffers(1, vbos, 0); modelVBO = vbos[0]

        GLES30.glBindVertexArray(modelVAO)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, modelVBO)
        mesh.vertices.position(0)
        GLES30.glBufferData(
            GLES30.GL_ARRAY_BUFFER,
            mesh.vertexCount * MeshData.BYTES_PER_VERTEX,
            mesh.vertices,
            GLES30.GL_STATIC_DRAW,
        )
        // Position 3f @ 0
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, MeshData.BYTES_PER_VERTEX, 0)
        GLES30.glEnableVertexAttribArray(0)
        // Normal 3f @ 12
        GLES30.glVertexAttribPointer(1, 3, GLES30.GL_FLOAT, false, MeshData.BYTES_PER_VERTEX, 12)
        GLES30.glEnableVertexAttribArray(1)
        // Color 4f @ 24
        GLES30.glVertexAttribPointer(2, 4, GLES30.GL_FLOAT, false, MeshData.BYTES_PER_VERTEX, 24)
        GLES30.glEnableVertexAttribArray(2)
        GLES30.glBindVertexArray(0)
    }

    /** Re-upload [mesh.vertices] to the existing VBO without
     *  re-allocating. Cheap (~ms for 1.4M-tri dragon); used after
     *  a paint mutation. */
    private fun refreshColorVbo(mesh: MeshData) {
        if (modelVBO == 0) return
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, modelVBO)
        mesh.vertices.position(0)
        GLES30.glBufferSubData(
            GLES30.GL_ARRAY_BUFFER,
            0,
            mesh.vertexCount * MeshData.BYTES_PER_VERTEX,
            mesh.vertices,
        )
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawModel(mesh: MeshData) {
        val shader = modelShader ?: return
        shader.use()

        val modelMatrix = FloatArray(16)
        Matrix.setIdentityM(modelMatrix, 0)
        val s = modelScale
        val r = modelRotationDeg
        val halfW = (mesh.maxX - mesh.minX) / 2f
        val halfH = (mesh.maxY - mesh.minY) / 2f
        val halfD = (mesh.maxZ - mesh.minZ) / 2f

        // Compose rotation around the mesh center as Z * Y * X (intrinsic
        // Tait-Bryan, matching StlMesh.transformedFull / TransformSheet
        // semantics). Compute the post-rotation bbox (8 corners) so the
        // ground plane drops to the rotated mesh's lowest point — the
        // user's translate sliders address the world XY of the model's
        // (rotated, scaled) min corner, not the original mesh footprint.
        val rotated =
            rotatedAndScaledBbox(mesh, r[0], r[1], r[2], s[0], s[1], s[2])
        val rWidth = rotated[3] - rotated[0]
        val rDepth = rotated[4] - rotated[1]
        val rHeight = rotated[5] - rotated[2]

        // Place the model on the bed: center the rotated/scaled bbox,
        // then add the user's translate offset. Z always rests flush
        // on the bed (post-rotation min-Z lifted to 0).
        val centeredX = bedWidthMm / 2f - rotated[0] - rWidth / 2f
        val centeredY = bedDepthMm / 2f - rotated[1] - rDepth / 2f
        val translate = bedTranslationMm
        val tx = centeredX + translate.getOrElse(0) { 0f }
        val ty = centeredY + translate.getOrElse(1) { 0f }
        val tz = -rotated[2]

        // Apply transforms — order matters; OpenGL Matrix calls
        // post-multiply, so the leftmost call here is the LAST applied
        // to the vertex. Vertex order from inside-out:
        //   1. center mesh at origin
        //   2. scale
        //   3. rotate X then Y then Z
        //   4. translate to bed position with post-rotate ground drop.
        Matrix.translateM(modelMatrix, 0, tx, ty, tz)
        Matrix.rotateM(modelMatrix, 0, r[2], 0f, 0f, 1f)
        Matrix.rotateM(modelMatrix, 0, r[1], 0f, 1f, 0f)
        Matrix.rotateM(modelMatrix, 0, r[0], 1f, 0f, 0f)
        Matrix.scaleM(modelMatrix, 0, s[0], s[1], s[2])
        Matrix.translateM(
            modelMatrix,
            0,
            -mesh.minX - halfW,
            -mesh.minY - halfH,
            -mesh.minZ - halfD,
        )
        // Reference rHeight so a future caller can read the rotated
        // height without recomputing — the variable is kept for clarity.
        @Suppress("UNUSED_VARIABLE")
        val unusedHeight = rHeight

        camera.computeMVP(modelMatrix)
        GLES30.glUniformMatrix4fv(shader.getUniformLocation("u_MVPMatrix"), 1, false, camera.mvpMatrix, 0)
        GLES30.glUniformMatrix4fv(shader.getUniformLocation("u_NormalMatrix"), 1, false, camera.normalMatrix, 0)
        // When painted: vertex shader reads a_Color per vertex (already
        // tinted by recolorByPaint). Highlighted drag-tint always wins
        // over per-vertex color so the user has unambiguous visual
        // feedback that the model is being moved.
        val useVertex = mesh.hasPerVertexColor && !highlighted
        val color = if (highlighted) highlightColor else modelColorDefault
        GLES30.glUniform4fv(shader.getUniformLocation("u_Color"), 1, color, 0)
        GLES30.glUniform1f(useVertexColorLoc, if (useVertex) 1f else 0f)

        GLES30.glBindVertexArray(modelVAO)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, mesh.vertexCount)
        GLES30.glBindVertexArray(0)
    }

    /**
     * Compute the axis-aligned bbox of the mesh after rotation around
     * the mesh center (Z * Y * X intrinsic) and per-axis scale. Returns
     * float[6] = (minX, minY, minZ, maxX, maxY, maxZ) in mesh-CENTERED
     * coordinates, i.e. each component is the offset from the mesh
     * center after rotate + scale. Used to:
     *  (a) drop the rotated model flush to Z=0 so it sits on the bed;
     *  (b) interpret the user's translate sliders as targeting the
     *      rotated/scaled bbox's min corner, not the un-rotated one.
     */
    private fun rotatedAndScaledBbox(
        mesh: MeshData,
        rotXDeg: Float,
        rotYDeg: Float,
        rotZDeg: Float,
        sx: Float,
        sy: Float,
        sz: Float,
    ): FloatArray {
        val halfW = (mesh.maxX - mesh.minX) / 2f * sx
        val halfH = (mesh.maxY - mesh.minY) / 2f * sy
        val halfD = (mesh.maxZ - mesh.minZ) / 2f * sz
        val rxRad = Math.toRadians(rotXDeg.toDouble())
        val ryRad = Math.toRadians(rotYDeg.toDouble())
        val rzRad = Math.toRadians(rotZDeg.toDouble())
        val cx = kotlin.math.cos(rxRad).toFloat()
        val sxr = kotlin.math.sin(rxRad).toFloat()
        val cy = kotlin.math.cos(ryRad).toFloat()
        val syr = kotlin.math.sin(ryRad).toFloat()
        val cz = kotlin.math.cos(rzRad).toFloat()
        val szr = kotlin.math.sin(rzRad).toFloat()
        // R = Rz * Ry * Rx (matches StlMesh.transformedFull's compose).
        val r00 = cz * cy
        val r01 = cz * syr * sxr - szr * cx
        val r02 = cz * syr * cx + szr * sxr
        val r10 = szr * cy
        val r11 = szr * syr * sxr + cz * cx
        val r12 = szr * syr * cx - cz * sxr
        val r20 = -syr
        val r21 = cy * sxr
        val r22 = cy * cx
        var minX = Float.POSITIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        var maxZ = Float.NEGATIVE_INFINITY
        for (i in 0 until 8) {
            val px = if ((i and 1) == 0) -halfW else halfW
            val py = if ((i and 2) == 0) -halfH else halfH
            val pz = if ((i and 4) == 0) -halfD else halfD
            val nx = r00 * px + r01 * py + r02 * pz
            val ny = r10 * px + r11 * py + r12 * pz
            val nz = r20 * px + r21 * py + r22 * pz
            if (nx < minX) minX = nx
            if (ny < minY) minY = ny
            if (nz < minZ) minZ = nz
            if (nx > maxX) maxX = nx
            if (ny > maxY) maxY = ny
            if (nz > maxZ) maxZ = nz
        }
        return floatArrayOf(minX, minY, minZ, maxX, maxY, maxZ)
    }

    private fun drawBedAndGrid() {
        val shader = gridShader ?: return
        shader.use()
        camera.computeMVP()
        GLES30.glUniformMatrix4fv(shader.getUniformLocation("u_MVPMatrix"), 1, false, camera.mvpMatrix, 0)

        // Bed fill (push behind grid lines via polygon offset).
        if (bedFillVAO != 0) {
            GLES30.glEnable(GLES30.GL_POLYGON_OFFSET_FILL)
            GLES30.glPolygonOffset(2f, 2f)
            GLES30.glUniform4f(shader.getUniformLocation("u_Color"), 0.067f, 0.122f, 0.196f, 1f)
            GLES30.glBindVertexArray(bedFillVAO)
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, bedFillVertexCount)
            GLES30.glBindVertexArray(0)
            GLES30.glDisable(GLES30.GL_POLYGON_OFFSET_FILL)
        }
        // Minor grid (10mm).
        GLES30.glUniform4f(shader.getUniformLocation("u_Color"), 0.157f, 0.220f, 0.318f, 1f)
        GLES30.glBindVertexArray(gridVAO)
        GLES30.glDrawArrays(GLES30.GL_LINES, 0, gridVertexCount)
        GLES30.glBindVertexArray(0)
        // Major grid (50mm).
        GLES30.glUniform4f(shader.getUniformLocation("u_Color"), 0.275f, 0.357f, 0.475f, 1f)
        GLES30.glBindVertexArray(majorGridVAO)
        GLES30.glDrawArrays(GLES30.GL_LINES, 0, majorGridVertexCount)
        GLES30.glBindVertexArray(0)
        // Border.
        GLES30.glUniform4f(shader.getUniformLocation("u_Color"), 0.475f, 0.816f, 0.780f, 1f)
        GLES30.glBindVertexArray(bedBorderVAO)
        GLES30.glDrawArrays(GLES30.GL_LINES, 0, 8)
        GLES30.glBindVertexArray(0)
    }

    private fun rebuildBed() {
        val w = bedWidthMm
        val d = bedDepthMm
        lastBedWidth = w
        lastBedDepth = d

        // Bed fill: 2 triangles spanning (0,0,0)..(w,d,0).
        val bedQuad = floatArrayOf(
            0f, 0f, 0f, w, 0f, 0f, w, d, 0f,
            0f, 0f, 0f, w, d, 0f, 0f, d, 0f,
        )
        bedFillVertexCount = bedQuad.size / 3
        bedFillVAO = uploadStaticLineOrTriVao(bedQuad)

        // Minor grid: lines every 10mm.
        val minor = ArrayList<Float>(((w / 10).toInt() + (d / 10).toInt() + 4) * 6)
        var x = 0f
        while (x <= w + 0.001f) {
            minor.add(x); minor.add(0f); minor.add(0f)
            minor.add(x); minor.add(d); minor.add(0f)
            x += 10f
        }
        var y = 0f
        while (y <= d + 0.001f) {
            minor.add(0f); minor.add(y); minor.add(0f)
            minor.add(w); minor.add(y); minor.add(0f)
            y += 10f
        }
        gridVertexCount = minor.size / 3
        gridVAO = uploadStaticLineOrTriVao(minor.toFloatArray())

        // Major grid: lines every 50mm (plus the far edge).
        val major = ArrayList<Float>()
        var mx = 0f
        while (mx <= w + 0.001f) {
            major.add(mx); major.add(0f); major.add(0f)
            major.add(mx); major.add(d); major.add(0f)
            mx += 50f
        }
        if (mx - 50f < w - 0.001f) {
            major.add(w); major.add(0f); major.add(0f)
            major.add(w); major.add(d); major.add(0f)
        }
        var my = 0f
        while (my <= d + 0.001f) {
            major.add(0f); major.add(my); major.add(0f)
            major.add(w); major.add(my); major.add(0f)
            my += 50f
        }
        if (my - 50f < d - 0.001f) {
            major.add(0f); major.add(d); major.add(0f)
            major.add(w); major.add(d); major.add(0f)
        }
        majorGridVertexCount = major.size / 3
        majorGridVAO = uploadStaticLineOrTriVao(major.toFloatArray())

        // Border.
        val border =
            floatArrayOf(
                0f, 0f, 0f, w, 0f, 0f,
                w, 0f, 0f, w, d, 0f,
                w, d, 0f, 0f, d, 0f,
                0f, d, 0f, 0f, 0f, 0f,
            )
        bedBorderVAO = uploadStaticLineOrTriVao(border)
    }

    private fun uploadStaticLineOrTriVao(verts: FloatArray): Int {
        val buf =
            ByteBuffer.allocateDirect(verts.size * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
        buf.put(verts); buf.flip()

        val vaos = IntArray(1); GLES30.glGenVertexArrays(1, vaos, 0)
        val vbos = IntArray(1); GLES30.glGenBuffers(1, vbos, 0)
        GLES30.glBindVertexArray(vaos[0])
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbos[0])
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, verts.size * 4, buf, GLES30.GL_STATIC_DRAW)
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, 12, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glBindVertexArray(0)
        return vaos[0]
    }

    /**
     * Unproject a screen touch onto the bed plane (or any horizontal Z=planeZ
     * plane). Returns bed-mm (x, y) of the intersection, or null when the ray
     * is parallel to the plane. Called from the UI thread; must NOT mutate
     * shared camera FloatArrays.
     */
    fun screenToBed(screenX: Float, screenY: Float, planeZ: Float = 0f): FloatArray? {
        val radAz = Math.toRadians(camera.azimuth)
        val radEl = Math.toRadians(camera.elevation)
        val eyeX = (camera.targetX + camera.panX + camera.distance * cos(radEl) * cos(radAz)).toFloat()
        val eyeY = (camera.targetY + camera.panY + camera.distance * cos(radEl) * sin(radAz)).toFloat()
        val eyeZ = (camera.targetZ + camera.distance * sin(radEl)).toFloat()
        val localView = FloatArray(16)
        Matrix.setLookAtM(
            localView, 0,
            eyeX, eyeY, eyeZ,
            (camera.targetX + camera.panX).toFloat(),
            (camera.targetY + camera.panY).toFloat(),
            camera.targetZ.toFloat(),
            0f, 0f, 1f,
        )
        val localProj = FloatArray(16)
        val aspect = viewportWidth.toFloat() / viewportHeight.toFloat()
        Matrix.perspectiveM(
            localProj, 0,
            45f, aspect,
            (camera.distance * 0.01).coerceAtLeast(0.1).toFloat(),
            (camera.distance * 10.0).toFloat(),
        )
        val invertedVP = FloatArray(16)
        val vpMatrix = FloatArray(16)
        Matrix.multiplyMM(vpMatrix, 0, localProj, 0, localView, 0)
        if (!Matrix.invertM(invertedVP, 0, vpMatrix, 0)) return null

        val ndcX = (2f * screenX / viewportWidth) - 1f
        val ndcY = 1f - (2f * screenY / viewportHeight)

        val nearW = floatArrayOf(ndcX, ndcY, -1f, 1f)
        val nearWorld = FloatArray(4)
        Matrix.multiplyMV(nearWorld, 0, invertedVP, 0, nearW, 0)
        if (nearWorld[3] == 0f) return null
        val nx = nearWorld[0] / nearWorld[3]
        val ny = nearWorld[1] / nearWorld[3]
        val nz = nearWorld[2] / nearWorld[3]

        val farW = floatArrayOf(ndcX, ndcY, 1f, 1f)
        val farWorld = FloatArray(4)
        Matrix.multiplyMV(farWorld, 0, invertedVP, 0, farW, 0)
        if (farWorld[3] == 0f) return null
        val fx = farWorld[0] / farWorld[3]
        val fy = farWorld[1] / farWorld[3]
        val fz = farWorld[2] / farWorld[3]

        val dx = fx - nx; val dy = fy - ny; val dz = fz - nz
        if (kotlin.math.abs(dz) < 1e-6f) return null
        val t = (planeZ - nz) / dz
        return floatArrayOf(nx + dx * t, ny + dy * t)
    }
}
