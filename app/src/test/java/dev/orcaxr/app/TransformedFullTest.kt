package dev.orcaxr.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Phase XR_OBJ_2 — verify [StlMesh.transformedFull] composes scale,
 * mirror, rotation and translate in the expected order. The math is
 * load-bearing for the per-axis TransformPanel; a regression here is
 * silent at compile time but produces visibly wrong models on the bed.
 */
class TransformedFullTest {

    /** A unit cube centered at origin (x∈[-1,1], y∈[-1,1], z∈[0,2]).
     *  12 triangles, 36 verts, no shared vertices (matches binary STL
     *  on-disk layout). */
    private fun unitCube(): StlMesh {
        // Six faces, two CCW-outward tris each. The outline matches
        // StlPreviewGlb's recentered convention (XY centered, zMin=0).
        val v = arrayOf(
            floatArrayOf(-1f, -1f, 0f),  // 0
            floatArrayOf( 1f, -1f, 0f),  // 1
            floatArrayOf( 1f,  1f, 0f),  // 2
            floatArrayOf(-1f,  1f, 0f),  // 3
            floatArrayOf(-1f, -1f, 2f),  // 4
            floatArrayOf( 1f, -1f, 2f),  // 5
            floatArrayOf( 1f,  1f, 2f),  // 6
            floatArrayOf(-1f,  1f, 2f),  // 7
        )
        val faces = intArrayOf(
            0, 3, 2, 0, 2, 1,   // -Z
            4, 5, 6, 4, 6, 7,   // +Z
            0, 1, 5, 0, 5, 4,   // -Y
            3, 7, 6, 3, 6, 2,   // +Y
            0, 4, 7, 0, 7, 3,   // -X
            1, 2, 6, 1, 6, 5,   // +X
        )
        val pos = FloatArray(faces.size * 3)
        for (i in faces.indices) {
            val src = v[faces[i]]
            pos[i * 3 + 0] = src[0]
            pos[i * 3 + 1] = src[1]
            pos[i * 3 + 2] = src[2]
        }
        return StlMesh(
            positions = pos,
            triCount = faces.size / 3,
            bboxMin = Vec3f(-1f, -1f, 0f),
            bboxMax = Vec3f(1f, 1f, 2f),
        )
    }

    @Test fun identity_returns_same_instance() {
        val cube = unitCube()
        val out = cube.transformedFull()
        // No-op short-circuit: reference equality.
        assertEquals(cube, out)
    }

    @Test fun uniform_scale_doubles_bbox() {
        val out = unitCube().transformedFull(scaleX = 2f, scaleY = 2f, scaleZ = 2f)
        assertEquals(-2f, out.bboxMin.x, 1e-5f)
        assertEquals(2f, out.bboxMax.x, 1e-5f)
        assertEquals(0f, out.bboxMin.z, 1e-5f)
        assertEquals(4f, out.bboxMax.z, 1e-5f)
    }

    @Test fun mirror_x_negates_x_extent() {
        val out = unitCube().transformedFull(mirrorX = true)
        // mirror is sign-flip of scale: x' = -x. bbox swaps signs.
        assertEquals(-1f, out.bboxMin.x, 1e-5f)
        assertEquals(1f, out.bboxMax.x, 1e-5f)
        // y/z unaffected.
        assertEquals(-1f, out.bboxMin.y, 1e-5f)
        assertEquals(1f, out.bboxMax.y, 1e-5f)
        assertEquals(0f, out.bboxMin.z, 1e-5f)
        assertEquals(2f, out.bboxMax.z, 1e-5f)
    }

    @Test fun rotate_90_z_swaps_xy_extents() {
        val tall = StlMesh(
            positions = floatArrayOf(
                -3f, -1f, 0f, 3f, -1f, 0f, 3f, 1f, 0f,
            ),
            triCount = 1,
            bboxMin = Vec3f(-3f, -1f, 0f),
            bboxMax = Vec3f(3f, 1f, 0f),
        )
        val out = tall.transformedFull(rotZDeg = 90f)
        // After +90° around Z: (x,y) -> (-y, x). bboxX was ±3 → now ±1
        // (from y=±1 mapped to -y=∓1 then min/max). bboxY was ±1 → now ±3.
        assertEquals(-1f, out.bboxMin.x, 1e-5f)
        assertEquals(1f, out.bboxMax.x, 1e-5f)
        assertEquals(-3f, out.bboxMin.y, 1e-5f)
        assertEquals(3f, out.bboxMax.y, 1e-5f)
    }

    @Test fun translate_offsets_bbox() {
        val out = unitCube().transformedFull(tx = 10f, ty = 20f, tz = 5f)
        assertEquals(9f, out.bboxMin.x, 1e-5f)
        assertEquals(11f, out.bboxMax.x, 1e-5f)
        assertEquals(19f, out.bboxMin.y, 1e-5f)
        assertEquals(21f, out.bboxMax.y, 1e-5f)
        assertEquals(5f, out.bboxMin.z, 1e-5f)
        assertEquals(7f, out.bboxMax.z, 1e-5f)
    }

    @Test fun rotate_x_90_swaps_yz() {
        // Rotation around X: (x,y,z) -> (x, -z, y).
        // unit cube y∈[-1,1], z∈[0,2] becomes y∈[-2,0], z∈[-1,1].
        val out = unitCube().transformedFull(rotXDeg = 90f)
        assertEquals(-2f, out.bboxMin.y, 1e-5f)
        assertEquals(0f, out.bboxMax.y, 1e-5f)
        assertEquals(-1f, out.bboxMin.z, 1e-5f)
        assertEquals(1f, out.bboxMax.z, 1e-5f)
    }

    @Test fun composed_scale_then_translate() {
        // Scale 200% → bbox becomes ±2/0..4. Translate +5 along x →
        // x∈[3,7], y∈[-2,2], z∈[0,4].
        val out = unitCube().transformedFull(
            scaleX = 2f, scaleY = 2f, scaleZ = 2f,
            tx = 5f,
        )
        assertEquals(3f, out.bboxMin.x, 1e-5f)
        assertEquals(7f, out.bboxMax.x, 1e-5f)
        assertEquals(-2f, out.bboxMin.y, 1e-5f)
        assertEquals(2f, out.bboxMax.y, 1e-5f)
        assertEquals(0f, out.bboxMin.z, 1e-5f)
        assertEquals(4f, out.bboxMax.z, 1e-5f)
    }

    @Test fun triangle_count_preserved_through_transforms() {
        val cube = unitCube()
        val out = cube.transformedFull(
            rotXDeg = 30f, rotYDeg = 45f, rotZDeg = 60f,
            scaleX = 1.5f, scaleY = 2f, scaleZ = 0.5f,
            mirrorX = true,
            tx = 1f, ty = -2f, tz = 3f,
        )
        assertEquals(cube.triCount, out.triCount)
        assertEquals(cube.positions.size, out.positions.size)
    }
}
