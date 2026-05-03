package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [AiPaintEngine] — the C9 milestone 1 spatial paint
 * primitives. Uses small fixture meshes (cube, two-tile square,
 * disconnected pair) so triangle counts and indices are deterministic.
 */
class AiPaintEngineTest {

    // ---- Fixture meshes (mirrored from MeshBvhTest) ----

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

    /** 10mm cube centered on origin (vertices at ±5). 12 triangles,
     *  CCW-from-outside. */
    private val cube: StlMesh by lazy {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            // -Z bottom (faces 0, 1)
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            // +Z top (faces 2, 3)
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            // -Y front (faces 4, 5)
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            // +Y back (faces 6, 7)
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            // -X left (faces 8, 9)
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            // +X right (faces 10, 11)
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

    private val twoLayers: StlMesh by lazy {
        // Two parallel triangles at z=0 and z=10. Used to test slab
        // and projected-mask front-most behavior in M4.
        mesh(floatArrayOf(
            0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f,    // z=0 layer
            0f, 0f, 10f, 10f, 0f, 10f, 0f, 10f, 10f, // z=10 layer
        ))
    }

    private val disconnected: StlMesh by lazy {
        // Two coplanar tris with NO shared vertices, far apart.
        mesh(floatArrayOf(
            0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f,
            100f, 100f, 0f, 110f, 100f, 0f, 100f, 110f, 0f,
        ))
    }

    // ---------------- paint_sphere ----------------

    @Test fun spherePaintsTrianglesNearCenter() {
        val bvh = MeshBvh.build(cube)
        // Sphere at the +Z face center with a 3 mm radius — should hit
        // both top tris (centroids at (5/3, -5/3, 5) and (-5/3, 5/3, 5)
        // — distance from (0, 0, 5) is sqrt(2/9 * 25) ≈ 2.36 mm).
        val hit = AiPaintEngine.sphere(bvh, 0f, 0f, 5f, 3f).toSet()
        assertEquals("expected both +Z face tris", setOf(2, 3), hit)
    }

    @Test fun sphereTooSmallReturnsEmpty() {
        val bvh = MeshBvh.build(cube)
        // Sphere far from any centroid.
        val hit = AiPaintEngine.sphere(bvh, 100f, 100f, 100f, 1f)
        assertEquals(0, hit.size)
    }

    @Test fun sphereWithBackFaceFilterOnlyKeepsOutwardTris() {
        val bvh = MeshBvh.build(cube)
        // A large sphere at the cube center catches everything via
        // centroid distance, but back_face_filter should reject every
        // triangle (their normals point away from the center).
        val hitNoFilter = AiPaintEngine.sphere(bvh, 0f, 0f, 0f, 100f).toSet()
        assertEquals(12, hitNoFilter.size)
        val hitFiltered = AiPaintEngine.sphere(bvh, 0f, 0f, 0f, 100f, backFaceFilter = true).toSet()
        // From the inside, every triangle's outward normal points away
        // from the center, so back_face_filter rejects them all.
        assertEquals(0, hitFiltered.size)
    }

    @Test fun sphereOutsideHullKeepsOnlyFrontFacingFaces() {
        val bvh = MeshBvh.build(cube)
        // Big sphere centered far down -Z. With back_face_filter we
        // should keep only the -Z bottom tris (their outward normal
        // is -Z, which aligns with the centroid-from-center direction
        // when we're below the cube).
        val center = floatArrayOf(0f, 0f, -100f)
        val hit = AiPaintEngine.sphere(
            bvh, center[0], center[1], center[2], 200f, backFaceFilter = true,
        ).toSet()
        // Faces 0 and 1 are -Z bottom tris.
        assertTrue("must include -Z bottom tris", hit.containsAll(setOf(0, 1)))
        // -Z bottom tris are accepted; +Z top and side tris are rejected.
        assertFalse("must NOT include +Z top tris", hit.contains(2))
        assertFalse(hit.contains(3))
    }

    @Test fun sphereWithZeroRadiusReturnsEmpty() {
        val bvh = MeshBvh.build(cube)
        assertEquals(0, AiPaintEngine.sphere(bvh, 0f, 0f, 0f, 0f).size)
    }

    // ---------------- paint_slab ----------------

    @Test fun slabZAxisCentroidPicksUpperTriangles() {
        val bvh = MeshBvh.build(twoLayers)
        val out = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.Z, 5f, 15f).toSet()
        assertEquals("expected z=10 layer (tri 1)", setOf(1), out)
    }

    @Test fun slabZAxisCentroidPicksLowerTriangles() {
        val bvh = MeshBvh.build(twoLayers)
        val out = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.Z, -5f, 5f).toSet()
        assertEquals("expected z=0 layer (tri 0)", setOf(0), out)
    }

    @Test fun slabHandlesReversedBounds() {
        val bvh = MeshBvh.build(twoLayers)
        val outNormal = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.Z, 5f, 15f).toSet()
        val outReversed = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.Z, 15f, 5f).toSet()
        assertEquals(outNormal, outReversed)
    }

    @Test fun slabAnyVertexCatchesStraddlingTriangle() {
        // Triangle with vertices at z=-5, 0, +5 — its centroid is at z=0.
        val straddle = mesh(floatArrayOf(
            0f, 0f, -5f, 10f, 0f, 0f, 0f, 10f, 5f,
        ))
        val bvh = MeshBvh.build(straddle)
        // Slab at z in [4, 6] catches by any_vertex (z=5 vertex), but
        // misses by centroid (centroid z = 0).
        val byCentroid = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.Z, 4f, 6f).toSet()
        val byAnyVertex = AiPaintEngine.slab(
            bvh, AiPaintEngine.Axis.Z, 4f, 6f, AiPaintEngine.SlabTest.AnyVertex,
        ).toSet()
        assertEquals(emptySet<Int>(), byCentroid)
        assertEquals(setOf(0), byAnyVertex)
    }

    @Test fun slabAllVerticesRequiresEveryVertexInRange() {
        val straddle = mesh(floatArrayOf(
            0f, 0f, -5f, 10f, 0f, 0f, 0f, 10f, 5f,
        ))
        val bvh = MeshBvh.build(straddle)
        val byAll = AiPaintEngine.slab(
            bvh, AiPaintEngine.Axis.Z, -10f, 10f, AiPaintEngine.SlabTest.AllVertices,
        ).toSet()
        assertEquals("the wide slab encloses every vertex", setOf(0), byAll)
        val byAllTight = AiPaintEngine.slab(
            bvh, AiPaintEngine.Axis.Z, -3f, 3f, AiPaintEngine.SlabTest.AllVertices,
        ).toSet()
        assertEquals("z=-5 vertex falls outside", emptySet<Int>(), byAllTight)
    }

    @Test fun slabXAxisCubeSplitsLeftFromRight() {
        val bvh = MeshBvh.build(cube)
        // Negative-X slab catches the -X face tris (faces 8, 9).
        val negX = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.X, -10f, -1f).toSet()
        assertTrue("must include -X face tris", negX.containsAll(setOf(8, 9)))
        // Positive-X slab catches the +X face tris (faces 10, 11).
        val posX = AiPaintEngine.slab(bvh, AiPaintEngine.Axis.X, 1f, 10f).toSet()
        assertTrue("must include +X face tris", posX.containsAll(setOf(10, 11)))
    }

    // ---------------- paint_normal_cone ----------------

    @Test fun normalConePicksUnderside() {
        val bvh = MeshBvh.build(cube)
        // Direction (0,0,-1), 30° cone — must pick exactly the two -Z
        // face tris.
        val out = AiPaintEngine.normalCone(bvh, 0f, 0f, -1f, 30f).toSet()
        assertEquals(setOf(0, 1), out)
    }

    @Test fun normalConeWideAngleAcceptsMore() {
        val bvh = MeshBvh.build(cube)
        // 90° half-angle from +Z direction — accepts every face whose
        // normal has a non-negative Z component. That's +Z (top, 2 tris)
        // plus the 4 vertical-side faces (8 tris) at the boundary.
        // Whether vertical sides are accepted depends on cosThreshold
        // (cos 90° = 0) — vertical normals dot to exactly 0, so they
        // should be accepted (≥ threshold).
        val out = AiPaintEngine.normalCone(bvh, 0f, 0f, 1f, 90f).toSet()
        assertEquals("expected top + sides (10 tris)", 10, out.size)
        assertTrue("must include +Z top tris", out.containsAll(setOf(2, 3)))
    }

    @Test fun normalConeInwardSignFlipsSelection() {
        val bvh = MeshBvh.build(cube)
        // Inward of +Z direction = matching the -Z face normal.
        val out = AiPaintEngine.normalCone(
            bvh, 0f, 0f, 1f, 30f, sign = AiPaintEngine.CooneSign.Inward,
        ).toSet()
        assertEquals(setOf(0, 1), out)
    }

    @Test fun normalConeBothSignAcceptsBothEndsOfAxis() {
        val bvh = MeshBvh.build(cube)
        val out = AiPaintEngine.normalCone(
            bvh, 0f, 0f, 1f, 30f, sign = AiPaintEngine.CooneSign.Both,
        ).toSet()
        // Both ±Z faces.
        assertEquals(setOf(0, 1, 2, 3), out)
    }

    @Test fun normalConeRejectsZeroDirection() {
        val bvh = MeshBvh.build(cube)
        val out = AiPaintEngine.normalCone(bvh, 0f, 0f, 0f, 90f)
        assertEquals(0, out.size)
    }

    // ---------------- paint_surface_region ----------------

    @Test fun surfaceRegionFillsCoplanarFaces() {
        val bvh = MeshBvh.build(cube)
        // Seed on -Z face. Smart fill at 30° gates at sharp edges so
        // we should pick up the two co-planar -Z tris only.
        val out = AiPaintEngine.surfaceRegion(bvh, seedTri = 0, maxDihedralDeg = 30f).toSet()
        assertEquals(setOf(0, 1), out)
    }

    @Test fun surfaceRegionWideAngleFillsWholeComponent() {
        val bvh = MeshBvh.build(cube)
        val out = AiPaintEngine.surfaceRegion(bvh, seedTri = 0, maxDihedralDeg = 180f).toSet()
        assertEquals(12, out.size)
    }

    // ---------------- paint_connected_component ----------------

    @Test fun connectedComponentFillsWholeCube() {
        val bvh = MeshBvh.build(cube)
        val out = AiPaintEngine.connectedComponent(bvh, seedTri = 0).toSet()
        assertEquals(12, out.size)
    }

    @Test fun connectedComponentDoesNotJumpAcrossDisjointMeshes() {
        val bvh = MeshBvh.build(disconnected)
        val out0 = AiPaintEngine.connectedComponent(bvh, seedTri = 0).toSet()
        val out1 = AiPaintEngine.connectedComponent(bvh, seedTri = 1).toSet()
        assertEquals(setOf(0), out0)
        assertEquals(setOf(1), out1)
    }

    @Test fun connectedComponentRespectsCap() {
        val bvh = MeshBvh.build(cube)
        val out = AiPaintEngine.connectedComponent(bvh, seedTri = 0, maxTriangles = 4)
        assertEquals(4, out.size)
        assertTrue("seed must appear", out.toSet().contains(0))
    }

    // ---------------- paint_triangle_list ----------------

    @Test fun triangleListSortsAndDedupes() {
        val r = AiPaintEngine.triangleList(triCount = 12, ids = intArrayOf(5, 1, 3, 5, 1, 11))
        assertEquals(intArrayOf(1, 3, 5, 11).toList(), r.indices.toList())
        assertEquals(0, r.droppedOutOfRange)
    }

    @Test fun triangleListDropsOutOfRange() {
        val r = AiPaintEngine.triangleList(triCount = 12, ids = intArrayOf(-1, 0, 5, 12, 100))
        assertEquals(intArrayOf(0, 5).toList(), r.indices.toList())
        assertEquals(3, r.droppedOutOfRange)
    }

    @Test fun triangleListEmptyInputReturnsEmpty() {
        val r = AiPaintEngine.triangleList(triCount = 12, ids = intArrayOf())
        assertEquals(0, r.indices.size)
        assertEquals(0, r.droppedOutOfRange)
    }

    // ---------------- MeshBvh additions used by the engine ----------------

    @Test fun aabbOverlapTrianglesPickUpEverythingInsideTheBox() {
        val bvh = MeshBvh.build(cube)
        val all = bvh.aabbOverlapTriangles(-10f, -10f, -10f, 10f, 10f, 10f).toSet()
        assertEquals(12, all.size)
    }

    @Test fun aabbOverlapTrianglesEmptyBoxReturnsNothing() {
        val bvh = MeshBvh.build(cube)
        val none = bvh.aabbOverlapTriangles(50f, 50f, 50f, 60f, 60f, 60f)
        assertEquals(0, none.size)
    }

    @Test fun bvhConnectedComponentRejectsSeedOutOfRange() {
        val bvh = MeshBvh.build(cube)
        runCatching { bvh.connectedComponent(seed = 999) }.also {
            assertTrue(it.isFailure)
        }
    }

    @Test fun triangleVertexExposesEachVertex() {
        val bvh = MeshBvh.build(cube)
        // -Z face triangle 0 was authored as (v0, v2, v1) = (-5,-5,-5),
        // (5,5,-5), (5,-5,-5).
        val v0 = bvh.triangleVertex(0, 0)
        val v1 = bvh.triangleVertex(0, 1)
        val v2 = bvh.triangleVertex(0, 2)
        assertEquals(Vec3f(-5f, -5f, -5f), v0)
        assertEquals(Vec3f(5f, 5f, -5f), v1)
        assertEquals(Vec3f(5f, -5f, -5f), v2)
    }
}
