package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [MeshBvh] — ray-vs-triangle hit testing and shared-vertex
 * adjacency BFS for radius-paint. Phase J §4.3.
 *
 * Test mesh patterns reusable here:
 *   - single triangle in the XY plane at z=0
 *   - two triangles forming a unit square at z=0 (shared edge)
 *   - cube of 12 triangles at the origin (full BVH stress)
 *   - disconnected pair (two triangles with no shared vertices) for
 *     the adjacency cutoff test
 */
class MeshBvhTest {

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

    /** Single triangle: vertices at (0,0,0), (10,0,0), (0,10,0). */
    private val singleTri = mesh(floatArrayOf(
        0f, 0f, 0f,
        10f, 0f, 0f,
        0f, 10f, 0f,
    ))

    /** Two triangles forming a 10×10 unit square at z=0. */
    private val unitSquare = mesh(floatArrayOf(
        // tri 0
        0f, 0f, 0f,
        10f, 0f, 0f,
        0f, 10f, 0f,
        // tri 1 (shares edge (10,0,0)-(0,10,0))
        10f, 0f, 0f,
        10f, 10f, 0f,
        0f, 10f, 0f,
    ))

    /** Two triangles in disjoint XY locations — no shared vertices. */
    private val disconnected = mesh(floatArrayOf(
        // tri 0 near origin
        0f, 0f, 0f,
        10f, 0f, 0f,
        0f, 10f, 0f,
        // tri 1 far away
        100f, 100f, 0f,
        110f, 100f, 0f,
        100f, 110f, 0f,
    ))

    /** Axis-aligned 10mm cube made of 12 triangles, centered on the
     *  origin (vertices at ±5). Useful for exercising BVH descent on a
     *  shape with multiple-axis extent. */
    private val cube: StlMesh by lazy {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), // 0
            floatArrayOf( 5f, -5f, -5f), // 1
            floatArrayOf( 5f,  5f, -5f), // 2
            floatArrayOf(-5f,  5f, -5f), // 3
            floatArrayOf(-5f, -5f,  5f), // 4
            floatArrayOf( 5f, -5f,  5f), // 5
            floatArrayOf( 5f,  5f,  5f), // 6
            floatArrayOf(-5f,  5f,  5f), // 7
        )
        val faces = listOf(
            // -Z bottom
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            // +Z top
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            // -Y front
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            // +Y back
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            // -X left
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            // +X right
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) {
            for (k in 0 until 3) {
                pos[p++] = v[f[k]][0]
                pos[p++] = v[f[k]][1]
                pos[p++] = v[f[k]][2]
            }
        }
        mesh(pos)
    }

    // ---------------- intersect — happy paths ----------------

    @Test fun emptyMeshReturnsNullOnAnyRay() {
        val bvh = MeshBvh.build(mesh(floatArrayOf()))
        assertNull(bvh.intersect(Vec3f(0f, 0f, 10f), Vec3f(0f, 0f, -1f)))
    }

    @Test fun rayDownThroughSingleTriHitsIt() {
        val bvh = MeshBvh.build(singleTri)
        // Aim at the centroid at (10/3, 10/3, 0) from above, looking
        // straight down.
        val hit = bvh.intersect(Vec3f(3.33f, 3.33f, 5f), Vec3f(0f, 0f, -1f))
        assertEquals(0, hit)
    }

    @Test fun rayMissingTriReturnsNull() {
        val bvh = MeshBvh.build(singleTri)
        assertNull(bvh.intersect(Vec3f(100f, 100f, 5f), Vec3f(0f, 0f, -1f)))
    }

    @Test fun rayUnitSquarePicksTheCorrectTri() {
        val bvh = MeshBvh.build(unitSquare)
        // Lower-left corner is in tri 0.
        assertEquals(0, bvh.intersect(Vec3f(2f, 2f, 5f), Vec3f(0f, 0f, -1f)))
        // Upper-right corner is in tri 1.
        assertEquals(1, bvh.intersect(Vec3f(8f, 8f, 5f), Vec3f(0f, 0f, -1f)))
    }

    @Test fun frontMostHitWinsWhenRayCrossesMultipleTris() {
        // Two parallel triangles at z=0 and z=5; ray from above
        // pointing down should hit the z=5 one (smaller t).
        val twoLayers = mesh(floatArrayOf(
            0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f,    // bottom
            0f, 0f, 5f, 10f, 0f, 5f, 0f, 10f, 5f,    // top
        ))
        val bvh = MeshBvh.build(twoLayers)
        assertEquals(1, bvh.intersect(Vec3f(2f, 2f, 10f), Vec3f(0f, 0f, -1f)))
    }

    @Test fun rayBehindOriginIsNotAHit() {
        // Triangle is at z=0, ray origin at z=-5 pointing further
        // negative — we should NOT hit (Möller-Trumbore returns t > 0
        // hits only).
        val bvh = MeshBvh.build(singleTri)
        assertNull(bvh.intersect(Vec3f(3.33f, 3.33f, -5f), Vec3f(0f, 0f, -1f)))
    }

    @Test fun parallelRayMissesTri() {
        val bvh = MeshBvh.build(singleTri)
        // Ray sliding along the triangle's plane.
        assertNull(bvh.intersect(Vec3f(3f, 3f, 0f), Vec3f(1f, 0f, 0f)))
    }

    @Test fun cubeHitFromAllSixDirections() {
        val bvh = MeshBvh.build(cube)
        // From +X aim toward -X — must hit a +X face triangle.
        val hitPlusX = bvh.intersect(Vec3f(20f, 0f, 0f), Vec3f(-1f, 0f, 0f))
        assertNotNull("ray from +X should hit", hitPlusX)
        // From -X aim toward +X.
        val hitMinusX = bvh.intersect(Vec3f(-20f, 0f, 0f), Vec3f(1f, 0f, 0f))
        assertNotNull(hitMinusX)
        // Same for Y/Z.
        assertNotNull(bvh.intersect(Vec3f(0f, 20f, 0f), Vec3f(0f, -1f, 0f)))
        assertNotNull(bvh.intersect(Vec3f(0f, -20f, 0f), Vec3f(0f, 1f, 0f)))
        assertNotNull(bvh.intersect(Vec3f(0f, 0f, 20f), Vec3f(0f, 0f, -1f)))
        assertNotNull(bvh.intersect(Vec3f(0f, 0f, -20f), Vec3f(0f, 0f, 1f)))
    }

    @Test fun cubeMissFromCorner() {
        val bvh = MeshBvh.build(cube)
        // Aim from far corner outward — ray escapes without touching
        // any face.
        assertNull(bvh.intersect(Vec3f(20f, 20f, 20f), Vec3f(1f, 1f, 1f)))
    }

    @Test fun unnormalizedDirectionStillHitsCorrectTri() {
        // The intersect API explicitly says direction need not be
        // normalized — verify that a 100x-length direction still
        // returns the same triangle.
        val bvh = MeshBvh.build(unitSquare)
        val normal = bvh.intersect(Vec3f(2f, 2f, 5f), Vec3f(0f, 0f, -1f))
        val scaled = bvh.intersect(Vec3f(2f, 2f, 5f), Vec3f(0f, 0f, -100f))
        assertEquals(normal, scaled)
    }

    // ---------------- radiusBfs ----------------

    @Test fun radiusBfsZeroRadiusReturnsSeedOnly() {
        val bvh = MeshBvh.build(unitSquare)
        val out = bvh.radiusBfs(seed = 0, radiusMm = 0f)
        assertEquals(1, out.size)
        assertEquals(0, out[0])
    }

    @Test fun radiusBfsConnectedShareReturnsBothTris() {
        val bvh = MeshBvh.build(unitSquare)
        // Two triangles sharing an edge; centroid distance between
        // them is sqrt((6.67-3.33)² + (3.33-6.67)² + 0²) ≈ 4.71. So
        // a 5mm radius pulls in both, a 4mm radius only the seed.
        val pulledIn = bvh.radiusBfs(seed = 0, radiusMm = 5f).toSet()
        assertEquals(setOf(0, 1), pulledIn)

        val solo = bvh.radiusBfs(seed = 0, radiusMm = 4f).toSet()
        assertEquals(setOf(0), solo)
    }

    @Test fun radiusBfsDoesNotJumpAcrossDisconnectedComponents() {
        // The two triangles are 100mm+ apart; even a 1000mm radius
        // shouldn't pull in the disconnected one.
        val bvh = MeshBvh.build(disconnected)
        val out = bvh.radiusBfs(seed = 0, radiusMm = 1000f).toSet()
        assertEquals("must not jump components", setOf(0), out)
    }

    @Test fun radiusBfsRespectsMaxTrianglesCap() {
        // On the cube, all 12 triangles are connected through the
        // shared corner vertices and centroid distances are <= ~10mm.
        // A large-radius BFS would normally return all 12; capping
        // at 3 must return at most 3 even though more are reachable.
        val bvh = MeshBvh.build(cube)
        val out = bvh.radiusBfs(seed = 0, radiusMm = 1000f, maxTriangles = 3)
        assertTrue("expected ≤ 3, got ${out.size}", out.size <= 3)
        assertTrue("seed must be in result", out.contains(0))
    }

    @Test fun radiusBfsLargeRadiusGetsAllConnectedTrisOnCube() {
        val bvh = MeshBvh.build(cube)
        // 100mm radius from center of any face reaches everything on
        // the cube via shared corner vertices. Dimensions 10mm so
        // even diagonal centroid distance is well under 100mm.
        val out = bvh.radiusBfs(seed = 0, radiusMm = 100f).toSet()
        assertEquals("cube has 12 tris all connected", 12, out.size)
    }

    @Test fun radiusBfsSeedOutOfRangeIsRejected() {
        val bvh = MeshBvh.build(unitSquare)
        runCatching { bvh.radiusBfs(seed = 999, radiusMm = 1f) }.also {
            assertTrue("expected out-of-range to throw", it.isFailure)
        }
        runCatching { bvh.radiusBfs(seed = -1, radiusMm = 1f) }.also {
            assertTrue(it.isFailure)
        }
    }

    // ---------------- triCount ----------------

    @Test fun triCountMatchesSourceMesh() {
        assertEquals(1, MeshBvh.build(singleTri).triCount)
        assertEquals(2, MeshBvh.build(unitSquare).triCount)
        assertEquals(12, MeshBvh.build(cube).triCount)
        assertEquals(0, MeshBvh.build(mesh(floatArrayOf())).triCount)
    }

    // ---------------- smartFillBfs ----------------

    @Test fun smartFillBfsCoplanarTrisFillTogether() {
        // Both unit-square tris lie in the z=0 plane → identical
        // normals → angle gate of 1° still permits the walk.
        val bvh = MeshBvh.build(unitSquare)
        val out = bvh.smartFillBfs(seed = 0, maxAngleDeg = 1f).toSet()
        assertEquals(setOf(0, 1), out)
    }

    @Test fun smartFillBfsTightAngleStopsAtSharpEdge() {
        // Cube tris are pairwise 90° at every edge. A 30° gate must
        // not leave the seed face — only the seed's two co-planar
        // neighbors (sharing an edge on the same face) are allowed.
        val bvh = MeshBvh.build(cube)
        val out = bvh.smartFillBfs(seed = 0, maxAngleDeg = 30f).toSet()
        // Cube face 0 is one of the -Z bottom triangles (faces[0/1]).
        // Smart fill picks the seed + its co-planar partner = 2 tris.
        assertEquals("expected 2 co-planar tris on a -Z face", 2, out.size)
    }

    @Test fun smartFillBfsWideAngleFillsConnectedComponent() {
        // Cube has 12 tris all connected. 180° gate (cos = -1) lets
        // every step pass → fill should be all 12.
        val bvh = MeshBvh.build(cube)
        val out = bvh.smartFillBfs(seed = 0, maxAngleDeg = 180f).toSet()
        assertEquals(12, out.size)
    }

    @Test fun smartFillBfsDoesNotJumpDisconnectedComponents() {
        val bvh = MeshBvh.build(disconnected)
        val out = bvh.smartFillBfs(seed = 0, maxAngleDeg = 180f).toSet()
        assertEquals("seed-only — second tri shares no vertices", setOf(0), out)
    }

    @Test fun smartFillBfsRespectsCap() {
        val bvh = MeshBvh.build(cube)
        val out = bvh.smartFillBfs(seed = 0, maxAngleDeg = 180f, maxTriangles = 4)
        assertEquals(4, out.size)
        assertTrue("seed must be in the result", out.toSet().contains(0))
    }

    @Test fun smartFillBfsSeedOutOfRangeIsRejected() {
        val bvh = MeshBvh.build(unitSquare)
        runCatching { bvh.smartFillBfs(seed = 999, maxAngleDeg = 30f) }.also {
            assertTrue(it.isFailure)
        }
    }
}
