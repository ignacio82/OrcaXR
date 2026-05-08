package dev.orcaxr.app

import kotlin.math.floor
import kotlin.math.sqrt

/**
 * AI-driven paint pillar (M6) — procedural triangle-set generators.
 *
 * Two pure functions over the centered_preview frame:
 *  - [gradient] — bucket every triangle by where its centroid lies along
 *    a direction, and assign it to a stop. Stops are non-overlapping
 *    half-open intervals over the normalized parameter `t`.
 *  - [valueNoise] — bucket every triangle by a deterministic 3D value
 *    noise sampled at its centroid. Same stops API.
 *
 * Both return one [IntArray] of triangle indices per stop in the input
 * order, so the caller can issue one [WorkspaceAction.PaintTriangleSet]
 * per stop with the stop's tag. Triangles whose `t` falls outside every
 * stop's range are silently skipped (so an LLM can paint just two ends
 * of a gradient and leave the middle band untouched).
 *
 * Determinism: noise is fully determined by `(seed, frequencyPerMm,
 * triangle centroid)`. No floating-point reductions or HashSet ordering;
 * any two runs over the same fixture produce identical output.
 */
internal object AiProceduralPaint {

    /** A half-open band `[tLo, tHi)` mapped to a filament tag. The
     *  caller may pass overlapping bands; ties are resolved by the
     *  first-match-wins order. */
    data class Stop(val tLo: Float, val tHi: Float, val tag: Int)

    /**
     * For each triangle, project its centroid onto [direction] and
     * normalize against the model's bbox along that direction.
     * `t = (centroid·dir̂ - tMin) / (tMax - tMin)` clamped to [0, 1].
     * Pick the first stop whose `[tLo, tHi)` contains `t`.
     *
     * @return one [IntArray] per stop, sorted ascending. Indices are
     * unique within each output array; a triangle never appears in
     * more than one output.
     */
    fun gradient(
        bvh: MeshBvh,
        dirX: Float, dirY: Float, dirZ: Float,
        stops: List<Stop>,
    ): List<IntArray> {
        if (bvh.triCount == 0 || stops.isEmpty()) return List(stops.size) { IntArray(0) }
        val len = sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ)
        if (len < 1e-7f) return List(stops.size) { IntArray(0) }
        val nx = dirX / len; val ny = dirY / len; val nz = dirZ / len

        // First pass: compute the projection range so we can normalize.
        var tMin = Float.POSITIVE_INFINITY
        var tMax = Float.NEGATIVE_INFINITY
        for (i in 0 until bvh.triCount) {
            val c = bvh.triangleCentroid(i)
            val t = c.x * nx + c.y * ny + c.z * nz
            if (t < tMin) tMin = t
            if (t > tMax) tMax = t
        }
        if (!(tMax > tMin)) {
            // Degenerate (mesh collapses to a plane perpendicular to
            // the gradient axis). Treat every centroid as t=0; only
            // stops covering 0 match.
            return matchAtConstantT(bvh.triCount, stops, t = 0f)
        }
        val invSpan = 1f / (tMax - tMin)
        val buckets = Array(stops.size) { ArrayList<Int>() }
        for (i in 0 until bvh.triCount) {
            val c = bvh.triangleCentroid(i)
            val tRaw = c.x * nx + c.y * ny + c.z * nz
            val t = ((tRaw - tMin) * invSpan).coerceIn(0f, 1f)
            val bucket = stops.indexOfFirst { stop -> tInBand(t, stop) }
            if (bucket >= 0) buckets[bucket].add(i)
        }
        return buckets.map { it.toIntArray() }
    }

    /**
     * For each triangle, sample a deterministic 3D value-noise field
     * at its centroid (in mesh-local mm), normalize to [0, 1], and
     * pick the first stop whose band contains the noise value. The
     * frequency controls the spatial scale of the noise: a value of
     * 0.05 means one full noise cycle every ~20 mm.
     */
    fun valueNoise(
        bvh: MeshBvh,
        frequencyPerMm: Float,
        seed: Int,
        stops: List<Stop>,
    ): List<IntArray> {
        if (bvh.triCount == 0 || stops.isEmpty()) return List(stops.size) { IntArray(0) }
        val freq = if (frequencyPerMm <= 0f) 0.05f else frequencyPerMm
        val buckets = Array(stops.size) { ArrayList<Int>() }
        for (i in 0 until bvh.triCount) {
            val c = bvh.triangleCentroid(i)
            val n = sampleNoise(c.x * freq, c.y * freq, c.z * freq, seed)
            val bucket = stops.indexOfFirst { stop -> tInBand(n, stop) }
            if (bucket >= 0) buckets[bucket].add(i)
        }
        return buckets.map { it.toIntArray() }
    }

    // ---- helpers ----

    private fun tInBand(t: Float, stop: Stop): Boolean {
        // Inclusive of tLo, exclusive of tHi — except at t == 1 (and
        // tHi == 1) where the interval is closed on the right. This
        // matches the LLM's natural reading "stop covers 0.7..1.0".
        return if (stop.tHi >= 1f) t >= stop.tLo && t <= stop.tHi
        else t >= stop.tLo && t < stop.tHi
    }

    private fun matchAtConstantT(triCount: Int, stops: List<Stop>, t: Float): List<IntArray> {
        val buckets = Array(stops.size) { ArrayList<Int>() }
        val winner = stops.indexOfFirst { tInBand(t, it) }
        if (winner >= 0) {
            val arr = buckets[winner]
            for (i in 0 until triCount) arr.add(i)
        }
        return buckets.map { it.toIntArray() }
    }

    /**
     * 3D value noise: a lattice hash at integer corners + tri-linear
     * interpolation with a quintic smoothstep. Output in [0, 1]. Pure
     * integer hash so identical inputs give bit-identical outputs
     * across runs (no `Math.random` / no implementation-defined
     * `Random` ordering).
     */
    private fun sampleNoise(x: Float, y: Float, z: Float, seed: Int): Float {
        val xi = floor(x.toDouble()).toInt()
        val yi = floor(y.toDouble()).toInt()
        val zi = floor(z.toDouble()).toInt()
        val fx = x - xi
        val fy = y - yi
        val fz = z - zi
        val sx = smoothstep(fx)
        val sy = smoothstep(fy)
        val sz = smoothstep(fz)
        val c000 = corner(xi,     yi,     zi,     seed)
        val c100 = corner(xi + 1, yi,     zi,     seed)
        val c010 = corner(xi,     yi + 1, zi,     seed)
        val c110 = corner(xi + 1, yi + 1, zi,     seed)
        val c001 = corner(xi,     yi,     zi + 1, seed)
        val c101 = corner(xi + 1, yi,     zi + 1, seed)
        val c011 = corner(xi,     yi + 1, zi + 1, seed)
        val c111 = corner(xi + 1, yi + 1, zi + 1, seed)
        val ix00 = lerp(c000, c100, sx)
        val ix10 = lerp(c010, c110, sx)
        val ix01 = lerp(c001, c101, sx)
        val ix11 = lerp(c011, c111, sx)
        val iy0 = lerp(ix00, ix10, sy)
        val iy1 = lerp(ix01, ix11, sy)
        return lerp(iy0, iy1, sz)
    }

    private fun smoothstep(t: Float): Float = t * t * t * (t * (t * 6f - 15f) + 10f)

    private fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

    private fun corner(x: Int, y: Int, z: Int, seed: Int): Float {
        // 32-bit integer mix (Murmur-3 fmix-style).
        var h = seed
        h = mix(h, x)
        h = mix(h, y)
        h = mix(h, z)
        // Map to [0, 1] using the high bits (more random than low).
        val u = (h ushr 8) and 0xFFFFFF
        return u / 16_777_216f
    }

    private fun mix(state: Int, k: Int): Int {
        var s = state
        s = s xor k
        s = s * 0x5bd1e995.toInt()
        s = s xor (s ushr 13)
        s = s * 0x27d4eb2f.toInt()
        s = s xor (s ushr 15)
        return s
    }
}
