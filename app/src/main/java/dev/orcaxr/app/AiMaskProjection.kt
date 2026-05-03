package dev.orcaxr.app

import kotlin.math.max
import kotlin.math.min

/**
 * AI-driven paint pillar (C9 milestone 4) — `paint_projected_mask`.
 * Reverse-projects a 2D mask through a camera into the model's
 * triangle index space.
 *
 * Mask formats accepted by the MCP tool:
 *  - polygon list (preferred for simple regions; rasterized via
 *    scanline fill)
 *  - explicit on/off boolean buffer (for tool-internal use; unit
 *    tests pre-build buffers and exercise the projection directly)
 *
 * Uses the BVH to find ray-vs-mesh intersections. In the front-most
 * mode we take the closest hit (front face only); in all-hits mode
 * we walk the full ray.
 */
internal object AiMaskProjection {

    enum class DepthMode { FrontFacingOnly, AllHits }

    /**
     * For each "on" pixel in [mask] (size [width] × [height], row-
     * major top-to-bottom, true = on), unproject through [camera]
     * and intersect against [bvh]. Returns the union of triangle
     * indices.
     *
     * [backFaceFilter]: when true, drop hits whose outward normal
     * points away from the camera (typical for paint).
     */
    fun project(
        bvh: MeshBvh,
        camera: AiRenderEngine.CameraSpec,
        mask: BooleanArray,
        depthMode: DepthMode = DepthMode.FrontFacingOnly,
        backFaceFilter: Boolean = true,
    ): IntArray {
        val w = camera.widthPx
        val h = camera.heightPx
        require(mask.size == w * h) { "mask must be width*height booleans" }
        val invMVP = invert4x4(matMulRowMajor(camera.projMatrixRowMajor, camera.viewMatrixRowMajor))
            ?: return IntArray(0)
        // Camera origin in world space = inverse(view) * (0, 0, 0, 1).
        val invView = invert4x4(camera.viewMatrixRowMajor) ?: return IntArray(0)
        val camOrigin = Vec3f(invView[3], invView[7], invView[11])
        val hits = HashSet<Int>(64)
        var idx = 0
        for (py in 0 until h) {
            for (px in 0 until w) {
                if (mask[idx]) {
                    castRay(bvh, invMVP, camOrigin, px, py, w, h, depthMode, backFaceFilter, hits)
                }
                idx++
            }
        }
        val out = hits.toIntArray()
        java.util.Arrays.sort(out)
        return out
    }

    private fun castRay(
        bvh: MeshBvh,
        invMVP: FloatArray,
        camOrigin: Vec3f,
        px: Int, py: Int,
        width: Int, height: Int,
        depthMode: DepthMode,
        backFaceFilter: Boolean,
        out: MutableSet<Int>,
    ) {
        // NDC: (2*(px+0.5)/w - 1, 1 - 2*(py+0.5)/h, ?). Pick a far-
        // plane point at z=1 and unproject; the ray direction is
        // (worldFar - camOrigin).
        val ndcX = 2f * (px + 0.5f) / width - 1f
        val ndcY = 1f - 2f * (py + 0.5f) / height
        val far = unprojectNdc(invMVP, ndcX, ndcY, 1f) ?: return
        val dx = far.x - camOrigin.x
        val dy = far.y - camOrigin.y
        val dz = far.z - camOrigin.z
        when (depthMode) {
            DepthMode.FrontFacingOnly -> {
                val tri = bvh.intersect(camOrigin, Vec3f(dx, dy, dz)) ?: return
                if (backFaceFilter) {
                    val n = bvh.triangleNormal(tri)
                    val dot = n.x * dx + n.y * dy + n.z * dz
                    if (dot >= 0f) return  // normal faces away from camera
                }
                out.add(tri)
            }
            DepthMode.AllHits -> {
                val tris = bvh.intersectAll(camOrigin, Vec3f(dx, dy, dz))
                for (t in tris) {
                    if (backFaceFilter) {
                        val n = bvh.triangleNormal(t)
                        if (n.x * dx + n.y * dy + n.z * dz >= 0f) continue
                    }
                    out.add(t)
                }
            }
        }
    }

    /**
     * Rasterize a list of polygons into a width × height boolean
     * mask. Pixels strictly inside any polygon (even-odd rule) are
     * marked true. Polygons are closed implicitly (first pt == last
     * pt not required).
     *
     * Polygons are flat float arrays: [x1, y1, x2, y2, ...]. Coords
     * are pixel coords (0..width, 0..height; top-left origin).
     */
    fun rasterizePolygons(
        polygons: List<FloatArray>,
        width: Int, height: Int,
    ): BooleanArray {
        require(width > 0 && height > 0) { "non-positive dims" }
        val mask = BooleanArray(width * height)
        if (polygons.isEmpty()) return mask
        for (py in 0 until height) {
            val y = py + 0.5f
            // Collect x-intercepts for each horizontal scan line.
            val xs = ArrayList<Float>(8)
            for (poly in polygons) {
                val n = poly.size / 2
                if (n < 2) continue
                var i = n - 1
                for (j in 0 until n) {
                    val xi = poly[i * 2]; val yi = poly[i * 2 + 1]
                    val xj = poly[j * 2]; val yj = poly[j * 2 + 1]
                    val crosses = (yi <= y && yj > y) || (yj <= y && yi > y)
                    if (crosses) {
                        val t = (y - yi) / (yj - yi)
                        xs.add(xi + t * (xj - xi))
                    }
                    i = j
                }
            }
            xs.sort()
            // Pair them off — each pair is an interval.
            var k = 0
            while (k + 1 < xs.size) {
                val xLo = max(0f, xs[k])
                val xHi = min(width.toFloat(), xs[k + 1])
                val ixLo = xLo.toInt()
                val ixHi = xHi.toInt()
                for (px in ixLo..min(width - 1, ixHi)) {
                    mask[py * width + px] = true
                }
                k += 2
            }
        }
        return mask
    }

    // ---- 4x4 matrix helpers (row-major) ----

    private fun matMulRowMajor(a: FloatArray, b: FloatArray): FloatArray {
        val out = FloatArray(16)
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0f
                for (k in 0 until 4) s += a[i * 4 + k] * b[k * 4 + j]
                out[i * 4 + j] = s
            }
        }
        return out
    }

    /** Invert a 4×4 row-major matrix. Returns null if singular. */
    private fun invert4x4(m: FloatArray): FloatArray? {
        // Cofactor expansion. ~30 ops; not the prettiest but matches
        // OpenGL Mathematics' approach.
        val a = m
        val inv = FloatArray(16)
        inv[0] =  a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10]
        inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10]
        inv[8] =  a[4]*a[9]*a[15]  - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9]
        inv[12] = -a[4]*a[9]*a[14]  + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9]
        inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10]
        inv[5] =  a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10]
        inv[9] = -a[0]*a[9]*a[15]  + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9]
        inv[13] =  a[0]*a[9]*a[14]  - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9]
        inv[2] =  a[1]*a[6]*a[15]  - a[1]*a[7]*a[14]  - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7]  - a[13]*a[3]*a[6]
        inv[6] = -a[0]*a[6]*a[15]  + a[0]*a[7]*a[14]  + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7]  + a[12]*a[3]*a[6]
        inv[10] =  a[0]*a[5]*a[15]  - a[0]*a[7]*a[13]  - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7]  - a[12]*a[3]*a[5]
        inv[14] = -a[0]*a[5]*a[14]  + a[0]*a[6]*a[13]  + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6]  + a[12]*a[2]*a[5]
        inv[3] = -a[1]*a[6]*a[11]  + a[1]*a[7]*a[10]  + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7]   + a[9]*a[3]*a[6]
        inv[7] =  a[0]*a[6]*a[11]  - a[0]*a[7]*a[10]  - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7]   - a[8]*a[3]*a[6]
        inv[11] = -a[0]*a[5]*a[11]  + a[0]*a[7]*a[9]   + a[4]*a[1]*a[11] - a[4]*a[3]*a[9]  - a[8]*a[1]*a[7]   + a[8]*a[3]*a[5]
        inv[15] =  a[0]*a[5]*a[10]  - a[0]*a[6]*a[9]   - a[4]*a[1]*a[10] + a[4]*a[2]*a[9]  + a[8]*a[1]*a[6]   - a[8]*a[2]*a[5]
        val det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12]
        if (kotlin.math.abs(det) < 1e-10) return null
        val invDet = 1f / det
        for (i in 0 until 16) inv[i] *= invDet
        return inv
    }

    /** Unproject (ndcX, ndcY, ndcZ) through inverse MVP to a world
     *  point (after w-divide). */
    private fun unprojectNdc(invMVP: FloatArray, ndcX: Float, ndcY: Float, ndcZ: Float): Vec3f? {
        val x = invMVP[0] * ndcX + invMVP[1] * ndcY + invMVP[2] * ndcZ + invMVP[3]
        val y = invMVP[4] * ndcX + invMVP[5] * ndcY + invMVP[6] * ndcZ + invMVP[7]
        val z = invMVP[8] * ndcX + invMVP[9] * ndcY + invMVP[10] * ndcZ + invMVP[11]
        val w = invMVP[12] * ndcX + invMVP[13] * ndcY + invMVP[14] * ndcZ + invMVP[15]
        if (kotlin.math.abs(w) < 1e-7f) return null
        return Vec3f(x / w, y / w, z / w)
    }
}
