package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [AiProceduralPaint] — the procedural-paint engine that backs
 * `paint_gradient` and `paint_noise`.
 *
 * Fixture: a 10mm cube made of 12 triangles (faces 0..11). Z bands
 * at z=-5 (bottom) and z=+5 (top); side faces span -5..+5.
 */
class AiProceduralPaintTest {

    private fun mesh(positions: FloatArray): StlMesh {
        val n = positions.size / 9
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < positions.size) {
            val x = positions[i]; val y = positions[i + 1]; val z = positions[i + 2]
            if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
            if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
            i += 3
        }
        if (n == 0) {
            minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f
        }
        return StlMesh(positions, n, Vec3f(minX, minY, minZ), Vec3f(maxX, maxY, maxZ))
    }

    private val cube: StlMesh by lazy {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),       // 0,1 bottom (z=-5)
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),       // 2,3 top (z=+5)
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),       // 4,5 -Y side
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),       // 6,7 +Y side
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),       // 8,9 -X side
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),       // 10,11 +X side
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) {
            for (k in 0 until 3) {
                pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
            }
        }
        mesh(pos)
    }

    // ---- Gradient ----

    @Test fun gradientAlongZSplitsBottomTopAndSides() {
        val bvh = MeshBvh.build(cube)
        // Cube z range: [-5, 5]. Bottom face centroids at z=-5 (t=0),
        // top at z=+5 (t=1), side centroids at z=±5/3 (t≈0.333 or
        // 0.667). Three stops that partition the t-axis into low /
        // mid / high — mid is empty for this fixture because side
        // centroids fall in the low and high bands, not the middle.
        val stops = listOf(
            AiProceduralPaint.Stop(tLo = 0f,   tHi = 0.4f, tag = 1),  // low
            AiProceduralPaint.Stop(tLo = 0.4f, tHi = 0.6f, tag = 2),  // mid (empty)
            AiProceduralPaint.Stop(tLo = 0.6f, tHi = 1.0f, tag = 3),  // high
        )
        val buckets = AiProceduralPaint.gradient(bvh, 0f, 0f, 1f, stops)
        assertEquals(3, buckets.size)
        // Bottom face (2 tris, t=0) + 4 side tris with z=-5/3 (t≈0.333).
        assertEquals(6, buckets[0].size)
        assertTrue("expected bottom tris (0,1) in stop 0", buckets[0].toSet().containsAll(setOf(0, 1)))
        // Mid band catches no side centroids.
        assertEquals(0, buckets[1].size)
        // Top face (2 tris, t=1) + 4 side tris with z=+5/3 (t≈0.667).
        assertEquals(6, buckets[2].size)
        assertTrue("expected top tris (2,3) in stop 2", buckets[2].toSet().containsAll(setOf(2, 3)))
        // Total partition covers all 12 tris.
        assertEquals(12, buckets.sumOf { it.size })
    }

    @Test fun gradientGapsLeaveTrianglesUnpainted() {
        val bvh = MeshBvh.build(cube)
        // Only paint the ends; middle band intentionally omitted.
        val stops = listOf(
            AiProceduralPaint.Stop(0f, 0.3f, tag = 1),
            AiProceduralPaint.Stop(0.7f, 1.0f, tag = 2),
        )
        val buckets = AiProceduralPaint.gradient(bvh, 0f, 0f, 1f, stops)
        // 2 bottom + 2 top = 4 triangles painted; 8 side triangles
        // are silently skipped because they fall in the gap.
        val totalPainted = buckets.sumOf { it.size }
        assertEquals(4, totalPainted)
    }

    @Test fun gradientNoStopsReturnsEmpty() {
        val bvh = MeshBvh.build(cube)
        val buckets = AiProceduralPaint.gradient(bvh, 0f, 0f, 1f, emptyList())
        assertEquals(0, buckets.size)
    }

    @Test fun gradientZeroLengthDirectionIsNoOp() {
        val bvh = MeshBvh.build(cube)
        val stops = listOf(AiProceduralPaint.Stop(0f, 1f, tag = 1))
        val buckets = AiProceduralPaint.gradient(bvh, 0f, 0f, 0f, stops)
        // Single stop, but degenerate direction: nothing matches.
        assertEquals(1, buckets.size)
        assertEquals(0, buckets[0].size)
    }

    @Test fun gradientFirstMatchWinsOnOverlap() {
        val bvh = MeshBvh.build(cube)
        val stops = listOf(
            AiProceduralPaint.Stop(0f, 1f, tag = 1),    // matches everything
            AiProceduralPaint.Stop(0f, 1f, tag = 2),    // would also match but loses
        )
        val buckets = AiProceduralPaint.gradient(bvh, 0f, 0f, 1f, stops)
        assertEquals(12, buckets[0].size)               // all tris
        assertEquals(0,  buckets[1].size)               // none
    }

    // ---- Value noise ----

    @Test fun valueNoiseDeterministicForFixedSeed() {
        val bvh = MeshBvh.build(cube)
        val stops = listOf(
            AiProceduralPaint.Stop(0f, 0.5f, tag = 1),
            AiProceduralPaint.Stop(0.5f, 1f, tag = 2),
        )
        val a = AiProceduralPaint.valueNoise(bvh, frequencyPerMm = 0.1f, seed = 42, stops = stops)
        val b = AiProceduralPaint.valueNoise(bvh, frequencyPerMm = 0.1f, seed = 42, stops = stops)
        assertEquals(a.size, b.size)
        for (i in a.indices) {
            assertTrue("bucket $i should match across runs", a[i].contentEquals(b[i]))
        }
    }

    @Test fun valueNoiseDifferentSeedDifferentDistribution() {
        val bvh = MeshBvh.build(cube)
        val stops = listOf(
            AiProceduralPaint.Stop(0f, 0.5f, tag = 1),
            AiProceduralPaint.Stop(0.5f, 1f, tag = 2),
        )
        val a = AiProceduralPaint.valueNoise(bvh, frequencyPerMm = 0.5f, seed = 1, stops = stops)
        val b = AiProceduralPaint.valueNoise(bvh, frequencyPerMm = 0.5f, seed = 999, stops = stops)
        // Some triangles must end up in different stops between seeds.
        assertNotEquals(a[0].toList(), b[0].toList())
    }

    @Test fun valueNoisePartitionsAllTriangles() {
        // With non-overlapping full-range stops, every triangle should
        // land in exactly one bucket (count sums to 12).
        val bvh = MeshBvh.build(cube)
        val stops = listOf(
            AiProceduralPaint.Stop(0f, 0.5f, tag = 1),
            AiProceduralPaint.Stop(0.5f, 1f, tag = 2),
        )
        val buckets = AiProceduralPaint.valueNoise(bvh, 0.2f, seed = 7, stops = stops)
        val total = buckets.sumOf { it.size }
        assertEquals(12, total)
    }

    @Test fun valueNoiseNonPositiveFrequencyDefaults() {
        val bvh = MeshBvh.build(cube)
        val stops = listOf(AiProceduralPaint.Stop(0f, 1f, tag = 1))
        // 0 / negative both fall back to a default frequency without
        // throwing; output is still the full triangle set since the
        // single stop covers [0..1].
        val zero = AiProceduralPaint.valueNoise(bvh, 0f, seed = 0, stops = stops)
        val neg  = AiProceduralPaint.valueNoise(bvh, -5f, seed = 0, stops = stops)
        assertEquals(12, zero[0].size)
        assertEquals(12, neg[0].size)
    }

    @Test fun valueNoiseEmptyMeshReturnsEmptyBuckets() {
        val empty = mesh(floatArrayOf())
        val bvh = MeshBvh.build(empty)
        val stops = listOf(AiProceduralPaint.Stop(0f, 1f, tag = 1))
        val buckets = AiProceduralPaint.valueNoise(bvh, 0.1f, seed = 0, stops = stops)
        assertNotNull(buckets)
        assertEquals(1, buckets.size)
        assertEquals(0, buckets[0].size)
    }
}
