/*
 * Adapted from u1-slicer-for-android (AGPL-3.0 — see NOTICE.md).
 * Slimmed for OrcaXR: no per-extruder coloring, no Z-band recolor —
 * those features live in the XR shell's BakedShading pipeline.
 */
package dev.orcaxr.app.mobile.viewer

import dev.orcaxr.app.StlMesh
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.sqrt

/**
 * Interleaved vertex buffer for the model shader.
 *
 * Per vertex: [x, y, z, nx, ny, nz, r, g, b, a] (10 floats = 40 bytes).
 * Each triangle's three vertices share the same flat face normal —
 * cheap to compute, gives a faceted look that reads correctly under
 * the two-light setup in `model.vert`.
 */
class MeshData(
    val vertices: FloatBuffer,
    val vertexCount: Int,
    val minX: Float,
    val minY: Float,
    val minZ: Float,
    val maxX: Float,
    val maxY: Float,
    val maxZ: Float,
) {
    val centerX get() = (minX + maxX) / 2f
    val centerY get() = (minY + maxY) / 2f
    val centerZ get() = (minZ + maxZ) / 2f
    val sizeX get() = maxX - minX
    val sizeY get() = maxY - minY
    val sizeZ get() = maxZ - minZ
    val maxDimension get() = maxOf(sizeX, sizeY, sizeZ)

    /** True when [recolorByPaint] has written per-triangle RGBA into the
     *  vertex buffer. The renderer reads this to flip
     *  `u_UseVertexColor` between solid-fill and per-triangle colors. */
    @Volatile var hasPerVertexColor: Boolean = false
        private set

    /**
     * Write per-vertex RGBA into [vertices] based on a per-triangle
     * filament slot index ([paintFilamentIndex], 0 = unpainted,
     * 1..palette.size = slot index) and the matching [palette] of RGBA
     * floats. Triangles tagged with an out-of-range or 0 slot get
     * [unpaintedRgba] (defaults to OrcaXR brand mint). Sets
     * [hasPerVertexColor] = true so the next draw will sample these
     * colors. Caller is responsible for re-uploading the VBO (the
     * renderer does this via its `pendingVboRefresh` flag).
     */
    fun recolorByPaint(
        palette: List<FloatArray>,
        paintFilamentIndex: ByteArray?,
        unpaintedRgba: FloatArray = floatArrayOf(0.475f, 0.816f, 0.780f, 1f),
    ) {
        val triCount = vertexCount / 3
        val buf = vertices
        for (tri in 0 until triCount) {
            val raw = paintFilamentIndex?.getOrNull(tri)?.toInt() ?: 0
            val slot = raw and 0xff
            val color =
                if (slot in 1..palette.size) palette[slot - 1] else unpaintedRgba
            for (v in 0 until 3) {
                val base = (tri * 3 + v) * FLOATS_PER_VERTEX + 6
                buf.put(base, color[0])
                buf.put(base + 1, color[1])
                buf.put(base + 2, color[2])
                buf.put(base + 3, color[3])
            }
        }
        hasPerVertexColor = true
    }

    /** Reset every vertex to the default white tint and clear
     *  [hasPerVertexColor]. Use when the user clears paint or
     *  switches to a paintless model. */
    fun resetToUniformColor() {
        val buf = vertices
        for (v in 0 until vertexCount) {
            val base = v * FLOATS_PER_VERTEX + 6
            buf.put(base, 1f)
            buf.put(base + 1, 1f)
            buf.put(base + 2, 1f)
            buf.put(base + 3, 1f)
        }
        hasPerVertexColor = false
    }

    companion object {
        const val FLOATS_PER_VERTEX = 10
        const val BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4

        /**
         * Build a [MeshData] from OrcaXR's [StlMesh] — recompute flat face
         * normals on the fly. Default base color is unused (the shader's
         * `u_Color` uniform overrides per draw call); we set it to white
         * so a future per-vertex-color path can paint over without bias.
         */
        fun fromStlMesh(mesh: StlMesh): MeshData {
            val triCount = mesh.triCount
            val buf = allocateBuffer(triCount)
            val src = mesh.positions
            var w = 0
            for (t in 0 until triCount) {
                val b = t * 9
                val ax = src[b]; val ay = src[b + 1]; val az = src[b + 2]
                val bx = src[b + 3]; val by = src[b + 4]; val bz = src[b + 5]
                val cx = src[b + 6]; val cy = src[b + 7]; val cz = src[b + 8]
                // (B - A) × (C - A)
                val ex = bx - ax; val ey = by - ay; val ez = bz - az
                val fx = cx - ax; val fy = cy - ay; val fz = cz - az
                var nxv = ey * fz - ez * fy
                var nyv = ez * fx - ex * fz
                var nzv = ex * fy - ey * fx
                val len = sqrt(nxv * nxv + nyv * nyv + nzv * nzv)
                if (len > 1e-12f) {
                    nxv /= len; nyv /= len; nzv /= len
                }
                // Three vertices, identical normal + color.
                writeVertex(buf, w, ax, ay, az, nxv, nyv, nzv); w += FLOATS_PER_VERTEX
                writeVertex(buf, w, bx, by, bz, nxv, nyv, nzv); w += FLOATS_PER_VERTEX
                writeVertex(buf, w, cx, cy, cz, nxv, nyv, nzv); w += FLOATS_PER_VERTEX
            }
            buf.position(0)
            return MeshData(
                vertices = buf,
                vertexCount = triCount * 3,
                minX = mesh.bboxMin.x,
                minY = mesh.bboxMin.y,
                minZ = mesh.bboxMin.z,
                maxX = mesh.bboxMax.x,
                maxY = mesh.bboxMax.y,
                maxZ = mesh.bboxMax.z,
            )
        }

        private fun allocateBuffer(triangleCount: Int): FloatBuffer =
            ByteBuffer.allocateDirect(triangleCount * 3 * FLOATS_PER_VERTEX * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()

        @Suppress("LongParameterList")
        private fun writeVertex(
            buf: FloatBuffer,
            offset: Int,
            x: Float,
            y: Float,
            z: Float,
            nx: Float,
            ny: Float,
            nz: Float,
        ) {
            buf.put(offset, x)
            buf.put(offset + 1, y)
            buf.put(offset + 2, z)
            buf.put(offset + 3, nx)
            buf.put(offset + 4, ny)
            buf.put(offset + 5, nz)
            // Color: white (1,1,1,1) — u_Color uniform overrides this in practice.
            buf.put(offset + 6, 1f)
            buf.put(offset + 7, 1f)
            buf.put(offset + 8, 1f)
            buf.put(offset + 9, 1f)
        }
    }
}
