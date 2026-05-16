package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests for [AutoPaintCascade] — the metadata-aware prioritized
 *  cascade (borrowed ideas #1 / #4 / #5). */
class AutoPaintCascadeTest {

    private fun cubeAt(cx: Float, cy: Float, cz: Float): FloatArray {
        val v = arrayOf(
            floatArrayOf(cx - 5, cy - 5, cz - 5), floatArrayOf(cx + 5, cy - 5, cz - 5),
            floatArrayOf(cx + 5, cy + 5, cz - 5), floatArrayOf(cx - 5, cy + 5, cz - 5),
            floatArrayOf(cx - 5, cy - 5, cz + 5), floatArrayOf(cx + 5, cy - 5, cz + 5),
            floatArrayOf(cx + 5, cy + 5, cz + 5), floatArrayOf(cx - 5, cy + 5, cz + 5),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2), intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4), intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3), intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return pos
    }

    private fun bvhOf(pos: FloatArray): MeshBvh {
        val n = pos.size / 9
        var mnx = Float.POSITIVE_INFINITY; var mny = Float.POSITIVE_INFINITY; var mnz = Float.POSITIVE_INFINITY
        var mxx = Float.NEGATIVE_INFINITY; var mxy = Float.NEGATIVE_INFINITY; var mxz = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < pos.size) {
            if (pos[i] < mnx) mnx = pos[i]; if (pos[i] > mxx) mxx = pos[i]
            if (pos[i + 1] < mny) mny = pos[i + 1]; if (pos[i + 1] > mxy) mxy = pos[i + 1]
            if (pos[i + 2] < mnz) mnz = pos[i + 2]; if (pos[i + 2] > mxz) mxz = pos[i + 2]
            i += 3
        }
        return MeshBvh.build(StlMesh(pos, n, Vec3f(mnx, mny, mnz), Vec3f(mxx, mxy, mxz)))
    }

    private operator fun FloatArray.plus(o: FloatArray) =
        FloatArray(size + o.size).also { copyInto(it); o.copyInto(it, size) }

    @Test fun paintStateBranchRespectsExistingPaintAndFillsGaps() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f)) // 12 tris, one shell
        val paint = ByteArray(12)
        for (t in 0..7) paint[t] = 1
        for (t in 8..9) paint[t] = 2
        // tris 10,11 left 0 (unpainted) → must be diffuse-filled.
        val r = AutoPaintCascade.run(bvh, paint, paletteSize = 4)
        assertEquals(AutoPaintCascade.Source.PaintState, r.source)
        assertTrue("full coverage", r.perTriangleSlot.none { it.toInt() == 0 })
        assertEquals(1, r.perTriangleSlot[0].toInt())
        assertEquals(2, r.perTriangleSlot[8].toInt())
        assertTrue(r.slotsUsed >= 2)
        // Single shell → components not viable → alternate is height.
        assertEquals(AutoPaintCascade.Source.HeightBands, r.alternateSource)
        assertTrue(r.branchesAvailable.contains("paint_state"))
        assertTrue(r.branchesAvailable.contains("height_bands"))
        assertFalse(r.branchesAvailable.contains("components"))
    }

    @Test fun paintTagsAbovePaletteAreFoldedIntoRange() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f))
        val paint = ByteArray(12) { 7 } // tag 7 with palette of 4
        val r = AutoPaintCascade.run(bvh, paint, paletteSize = 4)
        assertEquals(AutoPaintCascade.Source.PaintState, r.source)
        for (s in r.perTriangleSlot) assertTrue(s.toInt() in 1..4)
        // 7 → ((7-1)%4)+1 = 3
        assertEquals(3, r.perTriangleSlot[0].toInt())
    }

    @Test fun nullOrMismatchedOrEmptyPaintSkipsPaintBranch() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f))
        assertEquals(AutoPaintCascade.Source.HeightBands, AutoPaintCascade.run(bvh, null, 4).source)
        assertEquals(
            AutoPaintCascade.Source.HeightBands,
            AutoPaintCascade.run(bvh, ByteArray(5), 4).source, // wrong size
        )
        assertEquals(
            AutoPaintCascade.Source.HeightBands,
            AutoPaintCascade.run(bvh, ByteArray(12), 4).source, // all unpainted
        )
    }

    @Test fun twoShellsSelectComponentsWithHeightAlternate() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f) + cubeAt(100f, 0f, 0f))
        val r = AutoPaintCascade.run(bvh, null, paletteSize = 4)
        assertEquals(AutoPaintCascade.Source.Components, r.source)
        assertEquals(AutoPaintCascade.Source.HeightBands, r.alternateSource)
        assertTrue(r.branchesAvailable.contains("components"))
        assertTrue("full coverage", r.perTriangleSlot.none { it.toInt() == 0 })
        assertEquals(2, r.slotsUsed)
        // Largest (tie → first) shell is slot 1.
        assertEquals(1, r.perTriangleSlot[0].toInt())
    }

    @Test fun singleShellNoPaintFallsToHeightBands() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f))
        val r = AutoPaintCascade.run(bvh, null, paletteSize = 4)
        assertEquals(AutoPaintCascade.Source.HeightBands, r.source)
        assertNull(r.alternateSource)
        assertEquals(listOf("height_bands"), r.branchesAvailable)
        assertTrue(r.perTriangleSlot.none { it.toInt() == 0 })
    }

    @Test fun confettiGuardCapsSlotsToPaletteAcrossManyShells() {
        var pos = FloatArray(0)
        for (i in 0 until 6) pos += cubeAt(i * 100f, 0f, 0f)
        val bvh = bvhOf(pos)
        val r = AutoPaintCascade.run(bvh, null, paletteSize = 3)
        assertEquals(AutoPaintCascade.Source.Components, r.source)
        assertTrue("slots capped to palette", r.slotsUsed <= 3)
        assertTrue(r.perTriangleSlot.none { it.toInt() == 0 })
        assertEquals(1, r.perTriangleSlot[0].toInt())
    }

    @Test fun deterministic() {
        val bvh = bvhOf(cubeAt(0f, 0f, 0f) + cubeAt(80f, 0f, 0f))
        val a = AutoPaintCascade.run(bvh, null, 4)
        val b = AutoPaintCascade.run(bvh, null, 4)
        assertTrue(a.perTriangleSlot.contentEquals(b.perTriangleSlot))
        assertEquals(a.source, b.source)
    }

    @Test fun emptyMeshIsSafe() {
        val bvh = bvhOf(FloatArray(0))
        val r = AutoPaintCascade.run(bvh, null, 4)
        assertEquals(0, r.perTriangleSlot.size)
        assertEquals(AutoPaintCascade.Source.HeightBands, r.source)
    }
}
