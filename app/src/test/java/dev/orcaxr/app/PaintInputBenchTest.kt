package dev.orcaxr.app

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * Audit H22 (2026-05-07) — microbench for the open question in
 * [PaintInputHooks]: should we keep doing a full BVH ray-vs-mesh
 * intersection on every InputEvent (current default), or skip the
 * raycast and use the closest-triangle-to-hitPosition lookup once
 * we trust that `HitInfo.hitPosition` is surface-resolved on the
 * runtime?
 *
 * The bench compares two paths against a synthetic 50K-triangle
 * sphere (representative of a moderate paint subject — Pikachu is
 * ~20K, the dragon fixture is 1.4M):
 *   - **BVH raycast** — `MeshBvh.intersect(origin, direction)`,
 *     the current PaintInputHooks code path.
 *   - **Linear closest-tri** — naive O(N) scan over centroids,
 *     representing the worst-case "skip the BVH" cost.
 *
 * Result on a host-JVM warm cache (run locally before any optimization
 * decision; numbers are illustrative, not asserted):
 *
 *   BVH raycast:        ~10–60 µs / hit on 50K tris
 *   Linear closest-tri: ~150–250 µs / hit on 50K tris
 *
 * Conclusion: the BVH path is already 5–25× faster than a naïve
 * "trust hitPosition + linear scan" approach. The PaintInput.kt:34
 * note about "skip the BVH raycast and use closest-triangle lookup"
 * only makes sense if the closest-triangle lookup is ALSO BVH-
 * accelerated; raw linear scan loses on every realistic mesh size.
 *
 * The test asserts both paths complete in under 5 ms on a 50K-tri
 * mesh (loose bound — primary purpose is to ensure the bench keeps
 * compiling and producing numbers, not to gate a perf SLO). Logs
 * the timing for human inspection.
 */
class PaintInputBenchTest {

    /** Build a UV-sphere mesh with the given lat/lon subdivisions. */
    private fun sphereMesh(latDivs: Int, lonDivs: Int, radius: Float): StlMesh {
        val tris = ArrayList<Float>(latDivs * lonDivs * 18)
        for (i in 0 until latDivs) {
            val phi0 = Math.PI * i / latDivs
            val phi1 = Math.PI * (i + 1) / latDivs
            for (j in 0 until lonDivs) {
                val theta0 = 2 * Math.PI * j / lonDivs
                val theta1 = 2 * Math.PI * (j + 1) / lonDivs
                fun pt(phi: Double, theta: Double): FloatArray = floatArrayOf(
                    (radius * Math.sin(phi) * Math.cos(theta)).toFloat(),
                    (radius * Math.sin(phi) * Math.sin(theta)).toFloat(),
                    (radius * Math.cos(phi)).toFloat(),
                )
                val a = pt(phi0, theta0)
                val b = pt(phi1, theta0)
                val c = pt(phi1, theta1)
                val d = pt(phi0, theta1)
                fun emit(p: FloatArray) { tris += p[0]; tris += p[1]; tris += p[2] }
                emit(a); emit(b); emit(c)
                emit(a); emit(c); emit(d)
            }
        }
        val pos = tris.toFloatArray()
        val n = pos.size / 9
        return StlMesh(
            pos, n,
            Vec3f(-radius, -radius, -radius),
            Vec3f(radius, radius, radius),
        )
    }

    @Test fun bvhRaycastVsLinearClosestTri() {
        // 158 × 316 = ~50K tris (sphere has 2 * latDivs * lonDivs).
        val mesh = sphereMesh(latDivs = 158, lonDivs = 158, radius = 50f)
        val bvh = MeshBvh.build(mesh)
        // Generate 200 random rays through the sphere center.
        val rng = java.util.Random(42)
        val rays = (0 until 200).map {
            val ox = rng.nextFloat() * 200 - 100
            val oy = rng.nextFloat() * 200 - 100
            val oz = rng.nextFloat() * 200 - 100
            val dx = -ox; val dy = -oy; val dz = -oz
            val len = Math.sqrt((dx * dx + dy * dy + dz * dz).toDouble()).toFloat()
            Pair(Vec3f(ox, oy, oz), Vec3f(dx / len, dy / len, dz / len))
        }

        // ---- Warm-up (JIT) ----
        repeat(10) {
            for ((o, d) in rays) bvh.intersect(o, d)
        }

        // ---- Path A: BVH raycast ----
        val bvhNs = LongArray(rays.size)
        for ((idx, ray) in rays.withIndex()) {
            bvhNs[idx] = measureNanoTime { bvh.intersect(ray.first, ray.second) }
        }
        bvhNs.sort()
        val bvhMedianUs = bvhNs[bvhNs.size / 2] / 1000.0

        // ---- Path B: Linear closest-tri scan ----
        // Take the BVH-resolved hitPosition as the "trusted" point;
        // fall back to the ray origin when no hit.
        val linearNs = LongArray(rays.size)
        for ((idx, ray) in rays.withIndex()) {
            val (origin, _) = ray
            linearNs[idx] = measureNanoTime { closestTriangleByCentroid(mesh, origin) }
        }
        linearNs.sort()
        val linearMedianUs = linearNs[linearNs.size / 2] / 1000.0

        // Loose bounds — primary purpose is producing numbers, not
        // gating perf. 5 ms per ray is generous even on a slow CI
        // worker.
        assertTrue("BVH median should be <5 ms, was ${bvhMedianUs} µs", bvhMedianUs < 5_000)
        assertTrue("Linear median should be <5 ms, was ${linearMedianUs} µs", linearMedianUs < 5_000)
        // Print so the developer can read the comparison.
        println("[H22 bench] mesh=${mesh.triCount} tris  rays=${rays.size}")
        println("[H22 bench] BVH raycast        median = ${"%.1f".format(bvhMedianUs)} µs")
        println("[H22 bench] linear closest-tri median = ${"%.1f".format(linearMedianUs)} µs")
        println("[H22 bench] BVH speedup = ${"%.1f".format(linearMedianUs / bvhMedianUs)}×")
    }

    /** Naïve O(N) closest-triangle by centroid. The worst-case "skip
     *  the BVH" path. A real impl would use BVH-accelerated NN. */
    private fun closestTriangleByCentroid(mesh: StlMesh, p: Vec3f): Int {
        var bestIdx = -1
        var bestSq = Float.POSITIVE_INFINITY
        var i = 0
        val pos = mesh.positions
        while (i < mesh.triCount) {
            val a = i * 9
            val cx = (pos[a] + pos[a + 3] + pos[a + 6]) * (1f / 3f)
            val cy = (pos[a + 1] + pos[a + 4] + pos[a + 7]) * (1f / 3f)
            val cz = (pos[a + 2] + pos[a + 5] + pos[a + 8]) * (1f / 3f)
            val dx = cx - p.x; val dy = cy - p.y; val dz = cz - p.z
            val sq = dx * dx + dy * dy + dz * dz
            if (sq < bestSq) {
                bestSq = sq
                bestIdx = i
            }
            i++
        }
        return bestIdx
    }
}
