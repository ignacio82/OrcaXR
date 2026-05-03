package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiMaskProjectionTest {

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

    // ---- Polygon rasterization ----

    @Test fun rasterizeRectanglePolygon() {
        val poly = floatArrayOf(2f, 2f, 8f, 2f, 8f, 6f, 2f, 6f)
        val mask = AiMaskProjection.rasterizePolygons(listOf(poly), 10, 10)
        // Pixels (3, 3) inside, (0, 0) outside.
        assertTrue("center pixel should be on", mask[3 * 10 + 3])
        assertEquals("corner outside", false, mask[0])
    }

    @Test fun rasterizeEmptyPolygonsProducesEmptyMask() {
        val mask = AiMaskProjection.rasterizePolygons(emptyList(), 8, 8)
        assertEquals(64, mask.size)
        assertEquals(false, mask.any { it })
    }

    // ---- Front-most projection ----

    @Test fun frontFacingProjectionOnlyHitsOneTopFace() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("top", geom.bboxCenteredPreview, 16, 16)
        // Mask at center of image.
        val mask = BooleanArray(16 * 16) { false }
        mask[8 * 16 + 8] = true
        val tris = AiMaskProjection.project(
            bvh, cam, mask,
            depthMode = AiMaskProjection.DepthMode.FrontFacingOnly,
            backFaceFilter = true,
        ).toSet()
        // From above, the front-most triangle is one of the +Z top tris
        // (faces 2 or 3).
        assertTrue("expected front-facing top tri", tris.contains(2) || tris.contains(3))
        assertEquals("front-facing should yield exactly one tri", 1, tris.size)
    }

    @Test fun allHitsProjectionPaintsThroughCube() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("top", geom.bboxCenteredPreview, 16, 16)
        val mask = BooleanArray(16 * 16) { false }
        mask[8 * 16 + 8] = true
        val tris = AiMaskProjection.project(
            bvh, cam, mask,
            depthMode = AiMaskProjection.DepthMode.AllHits,
            backFaceFilter = false,
        ).toSet()
        // The ray crosses the +Z top, then exits through the -Z bottom.
        // Without back-face filter we expect both top + bottom tris.
        assertTrue("expected both top and bottom hits", tris.size >= 2)
        assertTrue(tris.any { it == 2 || it == 3 })  // top
        assertTrue(tris.any { it == 0 || it == 1 })  // bottom
    }

    @Test fun projectionWithEmptyMaskReturnsNoTriangles() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 8, 8)
        val mask = BooleanArray(8 * 8) { false }
        val tris = AiMaskProjection.project(bvh, cam, mask)
        assertEquals(0, tris.size)
    }

    // ---- intersectAll ----

    @Test fun intersectAllReturnsHitsInOrder() {
        val bvh = MeshBvh.build(cube)
        // Ray from above, pointing straight down through cube center.
        val tris = bvh.intersectAll(Vec3f(0f, 0f, 100f), Vec3f(0f, 0f, -1f))
        // Should hit at least 2 tris (top + bottom).
        assertTrue(tris.size >= 2)
        // First hit should be a +Z face tri (top) since it's closest.
        assertTrue("expected first hit on +Z top face", tris[0] == 2 || tris[0] == 3)
    }

    @Test fun intersectAllOnEmptyMeshReturnsEmpty() {
        val empty = mesh(floatArrayOf())
        val bvh = MeshBvh.build(empty)
        val tris = bvh.intersectAll(Vec3f(0f, 0f, 0f), Vec3f(0f, 0f, -1f))
        assertEquals(0, tris.size)
    }
}
