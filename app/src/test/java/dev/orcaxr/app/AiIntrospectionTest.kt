package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [AiIntrospection] — geometry summaries, components,
 * face-orientation buckets, region growing.
 */
class AiIntrospectionTest {

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

    /** 10mm cube centered on origin (vertices at ±5). */
    private val cube: StlMesh by lazy {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
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

    private val disconnected: StlMesh by lazy {
        // Cube + a far-away triangle, no shared vertices.
        val cubePositions = cube.positions
        val extras = floatArrayOf(
            100f, 100f, 100f, 110f, 100f, 100f, 100f, 110f, 100f,
        )
        mesh(cubePositions + extras)
    }

    // ---- geometry ----

    @Test fun cubeGeometryBboxAndArea() {
        val bvh = MeshBvh.build(cube)
        val g = AiIntrospection.geometry(bvh, bins = 4)
        assertEquals(12, g.totalTriangleCount)
        // Cube extents are -5..5 on each axis.
        assertEquals(-5f, g.bboxCenteredPreview.minX, 1e-4f)
        assertEquals(5f, g.bboxCenteredPreview.maxX, 1e-4f)
        // Surface area of a 10mm cube is 6*100 = 600 mm².
        assertEquals(600f, g.surfaceAreaMm2, 1f)
        // Volume of a 10mm cube is 1000 mm³.
        assertEquals(1000f, g.volumeMm3, 5f)
        // Z-histogram has 4 bins; total area should sum to 600.
        var binTotal = 0f
        for (b in g.zHistogram) binTotal += b.areaMm2
        assertEquals(600f, binTotal, 1f)
    }

    @Test fun emptyMeshGeometryReturnsZero() {
        val bvh = MeshBvh.build(mesh(floatArrayOf()))
        val g = AiIntrospection.geometry(bvh)
        assertEquals(0, g.totalTriangleCount)
        assertEquals(0f, g.surfaceAreaMm2, 0f)
        assertEquals(0f, g.volumeMm3, 0f)
    }

    // ---- components ----

    @Test fun cubeIsOneComponent() {
        val bvh = MeshBvh.build(cube)
        val cs = AiIntrospection.components(bvh)
        assertEquals(1, cs.size)
        assertEquals(12, cs[0].triangleIndices.size)
    }

    @Test fun disconnectedSplitsIntoTwoComponents() {
        val bvh = MeshBvh.build(disconnected)
        val cs = AiIntrospection.components(bvh)
        assertEquals(2, cs.size)
        // First (largest) is the cube (12 tris).
        assertEquals(12, cs[0].triangleIndices.size)
        assertEquals(1, cs[1].triangleIndices.size)
        // Each gets a unique sequential ID.
        assertEquals(0, cs[0].componentId)
        assertEquals(1, cs[1].componentId)
    }

    // ---- face orientation ----

    @Test fun cubeFaceOrientationSplitsSixWays() {
        val bvh = MeshBvh.build(cube)
        val buckets = AiIntrospection.faceOrientationSummary(bvh)
        // 6 cardinals + 1 diagonal.
        assertEquals(7, buckets.size)
        // Each cardinal direction has 2 tris on a cube.
        for (b in buckets) {
            if (b.name != "diagonal") {
                assertEquals("expected 2 tris on ${b.name}", 2, b.triangleCount)
            } else {
                assertEquals("no diagonal tris on a cube", 0, b.triangleCount)
            }
        }
    }

    @Test fun faceOrientationDiagonalCatchesAngledTriangles() {
        // A single 45°-tilted triangle (normal (0, 1, 1)/√2 — between
        // back and up, neither within 30°).
        val angled = mesh(floatArrayOf(
            0f, 0f, 0f, 10f, 0f, 0f, 5f, 5f, 5f,
        ))
        val bvh = MeshBvh.build(angled)
        val buckets = AiIntrospection.faceOrientationSummary(bvh)
        val diagonal = buckets.first { it.name == "diagonal" }
        assertEquals(1, diagonal.triangleCount)
    }

    // ---- semantic regions ----

    @Test fun cubeProducesSixRegions() {
        // Each face is a flat region of 2 coplanar tris. With a 35°
        // normal tolerance, faces 90° apart shouldn't merge.
        val bvh = MeshBvh.build(cube)
        val regions = AiIntrospection.semanticRegions(bvh, maxRegions = 12)
        assertEquals(6, regions.size)
        // Every region has exactly 2 tris (the two coplanar tris of
        // one face).
        for (r in regions) {
            assertEquals("region ${r.regionId} (${r.label}) tri count", 2, r.triangleIndices.size)
        }
        // Labels should include orientation (horizontal_top /
        // horizontal_bottom / vertical_side).
        val labels = regions.map { it.label }
        assertTrue("regions should have orientation labels", labels.any { it.startsWith("horizontal_") })
        assertTrue(labels.any { it.startsWith("vertical_") })
    }

    @Test fun semanticRegionsRespectMaxRegions() {
        val bvh = MeshBvh.build(cube)
        val regions = AiIntrospection.semanticRegions(bvh, maxRegions = 3)
        assertTrue("expected ≤ 3 regions, got ${regions.size}", regions.size <= 3)
    }

    @Test fun semanticRegionsDropsTinyClusters() {
        val bvh = MeshBvh.build(cube)
        val regions = AiIntrospection.semanticRegions(
            bvh, maxRegions = 12, minRegionAreaPct = 50f,
        )
        // 50% of 600 mm² = 300 mm², bigger than any single face on a
        // 10 mm cube. So no regions survive.
        assertEquals(0, regions.size)
    }

    // ---- direct neighbors ----

    @Test fun directNeighborsOnCube() {
        val bvh = MeshBvh.build(cube)
        // Triangle 0 is one of the -Z bottom tris. It shares vertices
        // with: its co-planar sibling (1), and the triangles on the
        // four adjacent vertical faces. Each cube vertex is shared by
        // 3 face triangles (one per face), so each of triangle 0's
        // three vertices has 2 OTHER triangles meeting it. Plus we
        // expect triangle 1 once. Bottom line: a non-empty set with
        // triangle 1 in it.
        val n = bvh.directNeighbors(0).toSet()
        assertTrue("triangle 0 must have triangle 1 as a neighbor", n.contains(1))
        assertTrue("triangle 0 must have at least 4 neighbors", n.size >= 4)
    }

    @Test fun directNeighborsOutOfRangeThrows() {
        val bvh = MeshBvh.build(cube)
        runCatching { bvh.directNeighbors(99) }.also {
            assertTrue("expected out-of-range to throw", it.isFailure)
        }
    }
}
