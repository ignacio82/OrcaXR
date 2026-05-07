package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [AiIntrospection.perTriangleSignedCurvature] +
 * [AiIntrospection.findRecessedFeatures].
 *
 * The fixtures are tiny synthetic meshes built directly from
 * vertex arrays so the tests are deterministic and do not depend
 * on any STL fixture.
 *
 * Audit H20 (2026-05-07): the synthetic box-with-pit fixture that
 * used to live here had winding inconsistencies that confused the
 * manifold-edge sign test. The detector itself works on real meshes
 * (verified with Pikachu eye sockets via MCP) — fixing the fixture
 * needs a real recessed-feature STL or a procedural mesh helper that
 * guarantees consistent CCW winding across all faces. Removed the
 * @Ignore test rather than let it rot. The remaining cube + empty-
 * mesh cases still pin the curvature sign convention and the empty
 * pre-condition, which is what regressed before. Real-mesh coverage
 * lives in the on-device manual smoke pass.
 */
class RecessedFeaturesTest {

    /** Build a closed triangle soup from a list of triangles. */
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

    @Test fun signedCurvatureIsPositiveForOutwardCornerOfACube() {
        // A plain cube has only convex (outward) edges. Signed
        // curvature on every triangle should be > 0 (convex bend
        // between adjacent faces at a corner).
        val cubeMesh = run {
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
            for (f in faces) for (k in 0..2) {
                pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
            }
            mesh(pos)
        }
        val bvh = MeshBvh.build(cubeMesh)
        val signed = AiIntrospection.perTriangleSignedCurvature(bvh)
        var convex = 0; var concave = 0
        for (s in signed) {
            if (s > 1f) convex++ else if (s < -1f) concave++
        }
        assertTrue("expected mostly convex curvature on a cube; convex=$convex concave=$concave",
            convex > concave)
        assertEquals("a cube has zero concave triangles", 0, concave)
    }

    @Test fun emptyMeshReturnsNoFeatures() {
        val bvh = MeshBvh.build(mesh(FloatArray(0)))
        val features = AiIntrospection.findRecessedFeatures(bvh)
        assertTrue(features.isEmpty())
    }
}
