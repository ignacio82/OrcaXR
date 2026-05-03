package dev.orcaxr.app

import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * D19c — decal / texture projection. Reverse-projects a 2D RGBA image
 * through a camera onto the model's surface, then quantizes each
 * touched triangle's sampled pixel to the closest filament-slot color.
 * Output is a per-triangle ByteArray in the same shape as
 * `PlacedModel.paintFilamentIndex` (1-based slot ids; 0 = unpainted).
 *
 * Why a dedicated engine: paint_projected_mask paints all touched
 * triangles with a SINGLE tag. A decal needs to assign DIFFERENT tags
 * to different triangles based on the source image's per-pixel color
 * — eyes black (slot 4), pupils white (slot 3), etc. Doing this with N
 * separate paint_projected_mask calls requires the LLM to author N
 * masks per slot; the decal engine collapses that into one image +
 * one quantization step.
 *
 * Coordinate frame: camera lives in centered_preview_mm (gotcha #11d).
 * Triangle indices align with the BVH's triangle order (same frame
 * `nativeWriteColoredGlb` uses), so the resulting ByteArray drops in
 * directly as `PlacedModel.paintFilamentIndex`.
 */
internal object AiDecalEngine {

    /** A decal target: place the image inside this pixel rectangle on
     *  the camera frame. `null` = full camera frame. Coordinates are
     *  inclusive top-left, exclusive bottom-right (PNG layout). */
    data class TargetRect(val x0: Int, val y0: Int, val x1: Int, val y1: Int) {
        init { require(x1 > x0 && y1 > y0) { "TargetRect must be non-empty" } }
        val width: Int get() = x1 - x0
        val height: Int get() = y1 - y0
    }

    /** A palette slot — RGB values 0..255 plus the 1-based slot id we
     *  assign when this slot is the closest match. Slot 0 is reserved
     *  for "unpainted" / background and never returned. */
    data class PaletteSlot(val slotId: Int, val r: Int, val g: Int, val b: Int)

    data class DecalResult(
        /** Per-triangle slot ids (length == bvh.triCount). 0 means the
         *  triangle was not touched by the decal (preserve any existing
         *  paint underneath). */
        val perTriangleSlot: ByteArray,
        /** Triangles touched by the decal (may include slot=0 if a
         *  pixel quantized to background — this is the "input painted
         *  pixel count" for telemetry, NOT a count of slot-changing
         *  writes). */
        val triangleHitCount: Int,
        /** Histogram per slot: index = slotId, value = count of
         *  triangles assigned to that slot. Index 0 = transparent /
         *  background pixels skipped. */
        val perSlotHistogram: IntArray,
        /** Pixels in the decal image that were not transparent / not
         *  background. Useful as the denominator for "% of decal
         *  reached the surface" telemetry. */
        val activeSourcePixels: Int,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is DecalResult) return false
            return triangleHitCount == other.triangleHitCount
                && activeSourcePixels == other.activeSourcePixels
                && perTriangleSlot.contentEquals(other.perTriangleSlot)
                && perSlotHistogram.contentEquals(other.perSlotHistogram)
        }
        override fun hashCode(): Int =
            (triangleHitCount * 31 + activeSourcePixels) * 31 +
                perTriangleSlot.contentHashCode()
    }

    /**
     * Project the decal onto the mesh.
     *
     * For each pixel inside [target] (or the full camera frame if
     * `null`):
     *   1. Sample [decalRgba] at the corresponding decal pixel
     *      (decalRgba is row-major top-to-bottom, RGBA, length =
     *      decalWidth * decalHeight * 4).
     *   2. If alpha < [alphaThreshold] OR (RGB == [ignoreRgb] when
     *      provided), skip — the pixel is "transparent."
     *   3. Cast a ray from the camera through the camera-frame pixel
     *      and find the closest triangle hit. Optional back-face
     *      filter rejects triangles whose normal faces away from the
     *      camera.
     *   4. Quantize the sampled RGB to the closest [palette] slot in
     *      Euclidean RGB-space; assign that slot to the hit triangle.
     *
     * If multiple decal pixels project to the same triangle, the
     * triangle's slot is the most-frequent slot ("majority vote").
     * Ties resolve to the first slot encountered. The intent: a
     * triangle covering 30 black pixels and 5 white pixels should be
     * black, not whichever the BFS happened to read first.
     */
    fun project(
        bvh: MeshBvh,
        camera: AiRenderEngine.CameraSpec,
        decalRgba: ByteArray,
        decalWidth: Int,
        decalHeight: Int,
        target: TargetRect?,
        palette: List<PaletteSlot>,
        alphaThreshold: Int = 16,
        ignoreRgb: IntArray? = null,
        backFaceFilter: Boolean = true,
    ): DecalResult {
        require(decalRgba.size == decalWidth * decalHeight * 4) {
            "decalRgba size ${decalRgba.size} != width*height*4 (${decalWidth * decalHeight * 4})"
        }
        require(palette.isNotEmpty()) { "palette must have at least one slot" }
        val w = camera.widthPx
        val h = camera.heightPx
        val rect = target ?: TargetRect(0, 0, w, h)
        require(rect.x0 >= 0 && rect.y0 >= 0 && rect.x1 <= w && rect.y1 <= h) {
            "TargetRect $rect outside camera frame ${w}x${h}"
        }
        val invMVP = invert4x4(matMulRowMajor(camera.projMatrixRowMajor, camera.viewMatrixRowMajor))
            ?: return emptyResult(bvh.triCount, palette)
        val invView = invert4x4(camera.viewMatrixRowMajor) ?: return emptyResult(bvh.triCount, palette)
        val camOrigin = Vec3f(invView[3], invView[7], invView[11])

        // Per-triangle slot tally.
        // First dimension = triangle index, second = slot id.
        val triCount = bvh.triCount
        val triSlotVotes = HashMap<Int, IntArray>(256)

        var activePixels = 0

        for (py in rect.y0 until rect.y1) {
            for (px in rect.x0 until rect.x1) {
                // Map camera pixel → decal pixel.
                val u = (px - rect.x0).toFloat() / rect.width.toFloat()
                val v = (py - rect.y0).toFloat() / rect.height.toFloat()
                val dx = (u * decalWidth).toInt().coerceIn(0, decalWidth - 1)
                val dy = (v * decalHeight).toInt().coerceIn(0, decalHeight - 1)
                val o = (dy * decalWidth + dx) * 4
                val r = decalRgba[o].toInt() and 0xff
                val g = decalRgba[o + 1].toInt() and 0xff
                val b = decalRgba[o + 2].toInt() and 0xff
                val a = decalRgba[o + 3].toInt() and 0xff
                if (a < alphaThreshold) continue
                if (ignoreRgb != null && r == ignoreRgb[0] && g == ignoreRgb[1] && b == ignoreRgb[2]) continue
                activePixels++
                // Cast a ray through this camera pixel.
                val tri = castRay(bvh, invMVP, camOrigin, px, py, w, h, backFaceFilter) ?: continue
                val slotId = quantizeToSlot(r, g, b, palette)
                val votes = triSlotVotes.getOrPut(tri) { IntArray(palette.size + 1) }
                val slotIdx = palette.indexOfFirst { it.slotId == slotId }
                if (slotIdx >= 0) votes[slotIdx + 1]++
            }
        }

        val perTriangleSlot = ByteArray(triCount)
        val perSlotHist = IntArray(MAX_PAINT_SLOTS + 1)
        for ((tri, votes) in triSlotVotes) {
            // Find the winning slot (first-max). Index 0 unused.
            var bestIdx = 1
            var bestCount = votes[1]
            for (k in 2 until votes.size) {
                if (votes[k] > bestCount) {
                    bestCount = votes[k]; bestIdx = k
                }
            }
            if (bestCount <= 0) continue
            val slot = palette[bestIdx - 1].slotId
            perTriangleSlot[tri] = slot.toByte()
            if (slot in 0..MAX_PAINT_SLOTS) perSlotHist[slot]++
        }
        return DecalResult(
            perTriangleSlot = perTriangleSlot,
            triangleHitCount = triSlotVotes.size,
            perSlotHistogram = perSlotHist,
            activeSourcePixels = activePixels,
        )
    }

    /**
     * Overlay [decal] onto [base] (per-triangle paint state from the
     * model). Triangles with decal slot != 0 take the decal's slot;
     * triangles with decal slot == 0 keep [base]'s value (so the decal
     * paints additively over existing paint). Result is sized to
     * [decal] (== bvh.triCount).
     */
    fun overlay(base: ByteArray?, decal: ByteArray): ByteArray {
        val out = ByteArray(decal.size)
        if (base != null && base.size == decal.size) {
            System.arraycopy(base, 0, out, 0, decal.size)
        }
        for (i in decal.indices) {
            val s = decal[i].toInt() and 0xff
            if (s != 0) out[i] = decal[i]
        }
        return out
    }

    /** Closest-slot-by-Euclidean-RGB-distance. Returns the slotId of
     *  the winner. Pure: no ties broken stochastically. */
    fun quantizeToSlot(r: Int, g: Int, b: Int, palette: List<PaletteSlot>): Int {
        var bestSlot = palette[0].slotId
        var bestDist = Int.MAX_VALUE
        for (p in palette) {
            val dr = r - p.r; val dg = g - p.g; val db = b - p.b
            val d = dr * dr + dg * dg + db * db
            if (d < bestDist) { bestDist = d; bestSlot = p.slotId }
        }
        return bestSlot
    }

    /** Parse a `#RRGGBB` palette entry into RGB ints. Returns null on
     *  malformed input — the MCP tool surfaces a clear error. */
    fun parseHexColor(hex: String): IntArray? {
        val s = hex.trim().removePrefix("#")
        if (s.length < 6) return null
        val r = s.substring(0, 2).toIntOrNull(16) ?: return null
        val g = s.substring(2, 4).toIntOrNull(16) ?: return null
        val b = s.substring(4, 6).toIntOrNull(16) ?: return null
        return intArrayOf(r, g, b)
    }

    private fun emptyResult(triCount: Int, palette: List<PaletteSlot>): DecalResult {
        return DecalResult(
            perTriangleSlot = ByteArray(triCount),
            triangleHitCount = 0,
            perSlotHistogram = IntArray(MAX_PAINT_SLOTS + 1),
            activeSourcePixels = 0,
        )
    }

    private fun castRay(
        bvh: MeshBvh,
        invMVP: FloatArray,
        camOrigin: Vec3f,
        px: Int, py: Int,
        w: Int, h: Int,
        backFaceFilter: Boolean,
    ): Int? {
        val ndcX = 2f * (px + 0.5f) / w - 1f
        val ndcY = 1f - 2f * (py + 0.5f) / h
        val far = unprojectNdc(invMVP, ndcX, ndcY, 1f) ?: return null
        val dx = far.x - camOrigin.x
        val dy = far.y - camOrigin.y
        val dz = far.z - camOrigin.z
        val tri = bvh.intersect(camOrigin, Vec3f(dx, dy, dz)) ?: return null
        if (backFaceFilter) {
            val n = bvh.triangleNormal(tri)
            if (n.x * dx + n.y * dy + n.z * dz >= 0f) return null
        }
        return tri
    }

    // ---- 4×4 row-major helpers (duplicated from AiMaskProjection so
    //                              the engine is self-contained — both
    //                              copies stay tiny) ----

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

    private fun invert4x4(m: FloatArray): FloatArray? {
        val a = m
        val inv = FloatArray(16)
        inv[0] = a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10]
        inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10]
        inv[8] = a[4]*a[9]*a[15] - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9]
        inv[12] = -a[4]*a[9]*a[14] + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9]
        inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10]
        inv[5] = a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10]
        inv[9] = -a[0]*a[9]*a[15] + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9]
        inv[13] = a[0]*a[9]*a[14] - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9]
        inv[2] = a[1]*a[6]*a[15] - a[1]*a[7]*a[14] - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7] - a[13]*a[3]*a[6]
        inv[6] = -a[0]*a[6]*a[15] + a[0]*a[7]*a[14] + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7] + a[12]*a[3]*a[6]
        inv[10] = a[0]*a[5]*a[15] - a[0]*a[7]*a[13] - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7] - a[12]*a[3]*a[5]
        inv[14] = -a[0]*a[5]*a[14] + a[0]*a[6]*a[13] + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6] + a[12]*a[2]*a[5]
        inv[3] = -a[1]*a[6]*a[11] + a[1]*a[7]*a[10] + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7] + a[9]*a[3]*a[6]
        inv[7] = a[0]*a[6]*a[11] - a[0]*a[7]*a[10] - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7] - a[8]*a[3]*a[6]
        inv[11] = -a[0]*a[5]*a[11] + a[0]*a[7]*a[9] + a[4]*a[1]*a[11] - a[4]*a[3]*a[9] - a[8]*a[1]*a[7] + a[8]*a[3]*a[5]
        inv[15] = a[0]*a[5]*a[10] - a[0]*a[6]*a[9] - a[4]*a[1]*a[10] + a[4]*a[2]*a[9] + a[8]*a[1]*a[6] - a[8]*a[2]*a[5]
        val det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12]
        if (kotlin.math.abs(det) < 1e-10) return null
        val invDet = 1f / det
        for (i in 0 until 16) inv[i] *= invDet
        return inv
    }

    private fun unprojectNdc(invMVP: FloatArray, ndcX: Float, ndcY: Float, ndcZ: Float): Vec3f? {
        val x = invMVP[0] * ndcX + invMVP[1] * ndcY + invMVP[2] * ndcZ + invMVP[3]
        val y = invMVP[4] * ndcX + invMVP[5] * ndcY + invMVP[6] * ndcZ + invMVP[7]
        val z = invMVP[8] * ndcX + invMVP[9] * ndcY + invMVP[10] * ndcZ + invMVP[11]
        val w = invMVP[12] * ndcX + invMVP[13] * ndcY + invMVP[14] * ndcZ + invMVP[15]
        if (kotlin.math.abs(w) < 1e-7f) return null
        return Vec3f(x / w, y / w, z / w)
    }
}
