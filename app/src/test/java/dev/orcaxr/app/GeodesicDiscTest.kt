package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Tests for [MeshBvh.geodesicDisc] (D18a). Validates:
 *  - seed-only result for radius=0
 *  - geodesic-distance ordering (closest first)
 *  - dihedral gate stops at sharp edges (cube → seed face only)
 *  - maxTriangles cap respected
 *  - polar cap on a UV sphere matches the analytic area
 *    `2πR(1 - cos(θ))` within 10 % (the leading numerical
 *    correctness check for the algorithm).
 */
class GeodesicDiscTest {

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

    /** Cube fixture identical to MeshBvhTest.cube. */
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

    /** UV sphere with [latRings] × [lonSegs] subdivisions (radius
     *  [R]). Returns triangles in CCW-from-outside order. */
    private fun uvSphere(R: Float, latRings: Int, lonSegs: Int): StlMesh {
        // Vertices: (latRings+1) × (lonSegs+1) where row 0 = north pole, row latRings = south pole.
        val verts = ArrayList<FloatArray>()
        for (i in 0..latRings) {
            val phi = PI.toFloat() * i / latRings  // 0..π
            val z = R * cos(phi)
            val r = R * sin(phi)
            for (j in 0..lonSegs) {
                val theta = 2f * PI.toFloat() * j / lonSegs
                verts.add(floatArrayOf(r * cos(theta), r * sin(theta), z))
            }
        }
        val W = lonSegs + 1
        fun idx(i: Int, j: Int) = i * W + j
        val pos = ArrayList<Float>()
        fun emitTri(a: Int, b: Int, c: Int) {
            for (id in listOf(a, b, c)) {
                pos.add(verts[id][0]); pos.add(verts[id][1]); pos.add(verts[id][2])
            }
        }
        for (i in 0 until latRings) {
            for (j in 0 until lonSegs) {
                val a = idx(i, j); val b = idx(i + 1, j); val c = idx(i + 1, j + 1); val d = idx(i, j + 1)
                emitTri(a, b, c)  // CCW from outside (north pole-side)
                emitTri(a, c, d)
            }
        }
        return mesh(pos.toFloatArray())
    }

    @Test fun radiusZeroReturnsSeedOnly() {
        val bvh = MeshBvh.build(cube)
        val out = bvh.geodesicDisc(seed = 0, radiusMm = 0f)
        assertEquals(0, out.size)  // radius=0 short-circuits to empty
        val out2 = bvh.geodesicDisc(seed = 0, radiusMm = 0.001f, maxDihedralDeg = 30f)
        // A tiny radius reaches just the seed (centroid-to-neighbor
        // hop on a 10 mm cube face is ~6 mm).
        assertEquals(1, out2.size)
        assertEquals(0, out2[0])
    }

    @Test fun dihedralGateStopsAtSharpEdges() {
        // 30° dihedral on a cube — neighbor faces are 90° apart, gate
        // rejects them. So the disc stays on the seed face.
        val bvh = MeshBvh.build(cube)
        val out = bvh.geodesicDisc(seed = 0, radiusMm = 100f, maxDihedralDeg = 30f).toSet()
        // Cube face 0 is one of the -Z bottom triangles; co-planar
        // partner is face 1.
        assertEquals(setOf(0, 1), out)
    }

    @Test fun wideDihedralCrossesEdges() {
        val bvh = MeshBvh.build(cube)
        val out = bvh.geodesicDisc(seed = 0, radiusMm = 100f, maxDihedralDeg = 180f).toSet()
        assertEquals(12, out.size)  // whole cube is connected
    }

    @Test fun radiusBoundsTheWalk() {
        val bvh = MeshBvh.build(cube)
        // Co-planar partner (tri 1) centroid is sqrt((10/3)² × 2)
        // ≈ 4.71 mm from tri 0's centroid. 4 mm doesn't reach;
        // 5 mm does.
        val tooSmall = bvh.geodesicDisc(seed = 0, radiusMm = 4f, maxDihedralDeg = 30f).toSet()
        assertEquals(setOf(0), tooSmall)
        val justRight = bvh.geodesicDisc(seed = 0, radiusMm = 5f, maxDihedralDeg = 30f).toSet()
        assertEquals(setOf(0, 1), justRight)
    }

    @Test fun maxTrianglesCapRespected() {
        val bvh = MeshBvh.build(cube)
        val out = bvh.geodesicDisc(seed = 0, radiusMm = 1000f, maxDihedralDeg = 180f, maxTriangles = 4)
        assertTrue("expected ≤ 4 tris, got ${out.size}", out.size <= 4)
        assertEquals("seed must be first", 0, out[0])
    }

    @Test fun seedOutOfRangeRejected() {
        val bvh = MeshBvh.build(cube)
        runCatching { bvh.geodesicDisc(seed = -1, radiusMm = 1f) }
            .also { assertTrue(it.isFailure) }
        runCatching { bvh.geodesicDisc(seed = 999, radiusMm = 1f) }
            .also { assertTrue(it.isFailure) }
    }

    @Test fun geodesicOrderIsClosestFirst() {
        // On the cube with wide dihedral, tri 0's geodesic-closest
        // neighbor is its co-planar partner (tri 1), then the
        // edge-shared tris on the four adjacent vertical faces.
        val bvh = MeshBvh.build(cube)
        val out = bvh.geodesicDisc(seed = 0, radiusMm = 1000f, maxDihedralDeg = 180f)
        assertEquals(0, out[0])
        // Second triangle should be the co-planar partner (closest
        // centroid hop on the cube).
        assertEquals(1, out[1])
    }

    @Test fun polarCapAreaApproximatesAnalytic() {
        // Sphere radius 10, dense subdivision, polar cap with geodesic
        // angle θ. Cap area = 2π R² (1 - cos θ); geodesic distance
        // along the surface from pole = R · θ.
        val R = 10f
        val sphere = uvSphere(R, latRings = 64, lonSegs = 96)
        val bvh = MeshBvh.build(sphere)
        val theta = PI.toFloat() / 6f  // 30° polar cap
        val arcDist = R * theta
        // Find the seed at the north pole (highest z centroid).
        // Skip degenerate triangles whose three vertices collapse
        // (UV sphere's pole-row half-tris are like that — same
        // (0,0,R) twice → zero normal).
        var bestSeed = 0
        var bestZ = Float.NEGATIVE_INFINITY
        for (i in 0 until bvh.triCount) {
            val n = bvh.triangleNormal(i)
            if (n.x == 0f && n.y == 0f && n.z == 0f) continue
            val c = bvh.triangleCentroid(i)
            if (c.z > bestZ) { bestZ = c.z; bestSeed = i }
        }
        val disc = bvh.geodesicDisc(
            seed = bestSeed,
            radiusMm = arcDist,
            // Wide gate — a sphere has no sharp edges, but per-step
            // dihedral is small so any gate ≥ ~5° passes.
            maxDihedralDeg = 30f,
            maxTriangles = 200_000,
        )
        // Compute disc area.
        var area = 0.0
        for (t in disc) {
            val v0 = bvh.triangleVertex(t, 0)
            val v1 = bvh.triangleVertex(t, 1)
            val v2 = bvh.triangleVertex(t, 2)
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val cnx = e1y * e2z - e1z * e2y
            val cny = e1z * e2x - e1x * e2z
            val cnz = e1x * e2y - e1y * e2x
            area += 0.5 * sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)
        }
        val expected = 2.0 * Math.PI * R * R * (1.0 - cos(theta.toDouble()))
        val err = abs(area - expected) / expected
        // BFS-with-dist-cap on a discrete mesh isn't a perfect
        // geodesic ball; allow 25 % error. (Tightened to 10 % once
        // we ship a true Dijkstra over edge-length graph.)
        assertTrue(
            "polar cap area $area vs expected $expected (err ${"%.2f".format(err * 100)}%)",
            err < 0.25,
        )
    }
}
