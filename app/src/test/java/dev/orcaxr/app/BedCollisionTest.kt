package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap A6 — verify [BedCollision.detect] flags the right triangles
 * when a transformed mesh extends past the printable polygon and stays
 * silent when it fits.
 */
class BedCollisionTest {

    /** Ten-mm cube centered on origin in XY. (z ∈ [0, 10]). */
    private fun cube10mm(): StlMesh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, 0f),
            floatArrayOf( 5f, -5f, 0f),
            floatArrayOf( 5f,  5f, 0f),
            floatArrayOf(-5f,  5f, 0f),
            floatArrayOf(-5f, -5f, 10f),
            floatArrayOf( 5f, -5f, 10f),
            floatArrayOf( 5f,  5f, 10f),
            floatArrayOf(-5f,  5f, 10f),
        )
        val faces = intArrayOf(
            0, 3, 2, 0, 2, 1,
            4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2,
            0, 4, 7, 0, 7, 3,
            1, 2, 6, 1, 6, 5,
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
            bboxMin = Vec3f(-5f, -5f, 0f),
            bboxMax = Vec3f(5f, 5f, 10f),
        )
    }

    @Test fun cube_well_inside_bed_returns_ok() {
        // 10mm cube on a 270mm bed → fits.
        val out = BedCollision.detect(cube10mm(), bedXmm = 270f, bedYmm = 270f)
        assertEquals(BedCollision.Result.Ok, out)
    }

    @Test fun cube_larger_than_bed_flags_every_tri() {
        // 10mm cube on a 6mm × 6mm "bed" → every face has at least one
        // off-bed vertex. Recenter is true (default) but the cube is
        // already centered, so the recenter pass is a no-op and the
        // overflow comes from the cube's own ±5mm extents vs ±3mm bed.
        val out = BedCollision.detect(cube10mm(), bedXmm = 6f, bedYmm = 6f)
        assertTrue("expected Off, got $out", out is BedCollision.Result.Off)
        out as BedCollision.Result.Off
        assertEquals(12, out.totalTriCount)
        assertEquals(12, out.offendingTriCount)
        assertTrue(out.overflowX)
        assertTrue(out.overflowY)
        // Signed worst-overflow: most-negative vert is at x=-5; halfX=3
        // → over = -5 + 3 = -2. Y is symmetric.
        assertEquals(-2f, out.worstOverflowXmm, 1e-5f)
        assertEquals(-2f, out.worstOverflowYmm, 1e-5f)
    }

    @Test fun translate_with_recenter_off_keeps_offset_visible() {
        // 10mm cube translated +60mm on X. With recenterToBed=false the
        // cube's bbox sits at x∈[55, 65]; on a 100mm bed (half=50mm)
        // every X side flags. With recenter=true the bbox center
        // (60, 0) is subtracted and the cube re-fits the bed.
        val cube = cube10mm()
        val translated = cube.transformedFull(tx = 60f)
        val withoutRecenter = BedCollision.detect(translated, 100f, 100f, recenterToBed = false)
        assertTrue("expected Off, got $withoutRecenter", withoutRecenter is BedCollision.Result.Off)
        val withRecenter = BedCollision.detect(translated, 100f, 100f, recenterToBed = true)
        assertEquals(BedCollision.Result.Ok, withRecenter)
    }

    @Test fun rotation_extends_silhouette_off_bed() {
        // Tall thin slab: 100mm × 10mm × 10mm. On a 90mm bed it doesn't
        // fit even centered (X extent 100 > 90). recenterToBed=true does
        // not help — recentering only cancels the bbox-center offset,
        // and the bbox extent itself overflows.
        val slab = StlMesh(
            positions = floatArrayOf(
                -50f, -5f, 0f,  50f, -5f, 0f,  50f, 5f, 0f,
                -50f, -5f, 0f,  50f,  5f, 0f, -50f, 5f, 0f,
            ),
            triCount = 2,
            bboxMin = Vec3f(-50f, -5f, 0f),
            bboxMax = Vec3f(50f, 5f, 0f),
        )
        val out = BedCollision.detect(slab, bedXmm = 90f, bedYmm = 90f)
        assertTrue("expected Off, got $out", out is BedCollision.Result.Off)
        out as BedCollision.Result.Off
        assertTrue(out.overflowX)
        assertFalse(out.overflowY)
        // Both ±50 vertices land 5 mm past the bed edge; whichever
        // is encountered first wins the tie since the algorithm only
        // overwrites on strictly greater magnitude. The user-visible
        // semantic is "the worst-offending vertex is 5 mm off the
        // bed" — sign just identifies which edge.
        assertEquals(5f, kotlin.math.abs(out.worstOverflowXmm), 1e-5f)
        // All four corner-vertices of both tris off-bed → both tris hit.
        assertEquals(2, out.offendingTriCount)
    }

    @Test fun empty_mesh_returns_ok() {
        val empty = StlMesh(
            positions = FloatArray(0),
            triCount = 0,
            bboxMin = Vec3f(0f, 0f, 0f),
            bboxMax = Vec3f(0f, 0f, 0f),
        )
        assertEquals(BedCollision.Result.Ok, BedCollision.detect(empty, 270f, 270f))
    }

    @Test fun off_data_class_equals_compares_indices() {
        val a = BedCollision.Result.Off(
            offendingTriCount = 2, totalTriCount = 12,
            offendingTriIndices = intArrayOf(0, 1),
            overflowX = true, overflowY = false,
            worstOverflowXmm = 5f, worstOverflowYmm = 0f,
        )
        val b = BedCollision.Result.Off(
            offendingTriCount = 2, totalTriCount = 12,
            offendingTriIndices = intArrayOf(0, 1),
            overflowX = true, overflowY = false,
            worstOverflowXmm = 5f, worstOverflowYmm = 0f,
        )
        assertEquals(a, b)
        val c = a.copy(offendingTriIndices = intArrayOf(0, 2))
        assertNotEquals(a, c)
    }
}
