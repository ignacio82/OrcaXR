package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Add Magnets" regression — pins [MagnetOp] placement math. If the
 * grid, primitive params, embedded-Z budget, or pause-Z snap drift,
 * magnet pockets silently overlap, breach a wall, get roofed before
 * the pause (magnet can't be inserted), or pause off a layer boundary.
 */
class MagnetOpTest {

    private fun discSpec(count: Int = 4) = MagnetSpec(
        count = count,
        shape = MagnetShape.DISC,
        diameterMm = 6f,
        discHeightMm = 2f,
        clearanceMm = 0.2f,
        roofThicknessMm = 0.8f,
        edgeMarginMm = 3f,
    )

    @Test
    fun gridDimsAreNearSquare() {
        assertEquals(1 to 1, MagnetOp.gridDims(1))
        assertEquals(2 to 1, MagnetOp.gridDims(2))
        assertEquals(2 to 2, MagnetOp.gridDims(4))
        assertEquals(3 to 2, MagnetOp.gridDims(6))
        assertEquals(3 to 3, MagnetOp.gridDims(7)) // 2 empty slots
        assertEquals(3 to 3, MagnetOp.gridDims(9))
        assertEquals(1 to 1, MagnetOp.gridDims(0)) // degenerate → 1×1
    }

    @Test
    fun cavitiesAreSymmetricAboutOrigin() {
        for (n in 1..12) {
            val p = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(n), 0.2f)
            assertEquals("n=$n count", n, p.cavities.size)
            val sx = p.cavities.sumOf { it.centerXmm.toDouble() }
            val sy = p.cavities.sumOf { it.centerYmm.toDouble() }
            // Symmetry only holds when the grid is fully populated; for
            // partial last rows just assert it stays bounded inside the
            // footprint (no runaway pitch).
            if (n == p.gridCols * p.gridRows) {
                assertEquals("n=$n Σx", 0.0, sx, 1e-3)
                assertEquals("n=$n Σy", 0.0, sy, 1e-3)
            }
            p.cavities.forEach {
                assertTrue("n=$n x in footprint", kotlin.math.abs(it.centerXmm) <= 30f)
                assertTrue("n=$n y in footprint", kotlin.math.abs(it.centerYmm) <= 30f)
            }
        }
    }

    @Test
    fun discMapsToCylinderParams() {
        val p = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(1), 0.2f)
        assertEquals(PrimitiveKind.CYLINDER, p.primitiveKind)
        // radius = (6 + 2*0.2)/2 = 3.2 ; height = 2 + 0.2 = 2.2 ; facet 2
        assertEquals(3.2f, p.primitiveParams[0], 1e-4f)
        assertEquals(2.2f, p.primitiveParams[1], 1e-4f)
        assertEquals(2f, p.primitiveParams[2], 1e-4f)
    }

    @Test
    fun blockMapsToCubeParams() {
        val spec = MagnetSpec(
            count = 2, shape = MagnetShape.BLOCK,
            blockXmm = 10f, blockYmm = 4f, blockZmm = 3f,
            clearanceMm = 0.25f, roofThicknessMm = 0.8f, edgeMarginMm = 3f,
        )
        val p = MagnetOp.placeCavities(80f, 80f, 20f, spec, 0.2f)
        assertEquals(PrimitiveKind.CUBE, p.primitiveKind)
        assertEquals(10.5f, p.primitiveParams[0], 1e-4f) // 10 + 2*0.25
        assertEquals(4.5f, p.primitiveParams[1], 1e-4f)  // 4  + 2*0.25
        assertEquals(3.25f, p.primitiveParams[2], 1e-4f) // 3  + 0.25
    }

    @Test
    fun embeddedZBudgetLeavesFloorAndRoof() {
        val p = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(1), 0.2f)
        // floor = roof = 0.8 ; ch = 2.2 ; top = 0.8 + 2.2 = 3.0
        assertEquals(0.8f, p.floorZmm, 1e-4f)
        assertEquals(3.0f, p.cavityTopZmm, 1e-4f)
        // roof material exists above the pocket
        assertTrue(p.cavityTopZmm + 0.8f <= 20f)
    }

    @Test
    fun modelTooShortClampsPocketAndWarns() {
        // hostHeight 3 mm; floor+roof = 1.6; raw ch = 2.2 → clamp to 1.4
        val p = MagnetOp.placeCavities(60f, 60f, 3f, discSpec(1), 0.2f)
        assertTrue("expected a clamp warning", p.warnings.any { it.contains("Model too short") })
        assertEquals(0.8f + (3f - 1.6f), p.cavityTopZmm, 1e-3f)
        // primitive height param recomputed to the clamped pocket
        assertEquals(3f - 1.6f, p.primitiveParams[1], 1e-3f)
    }

    @Test
    fun magnetWiderThanFootprintWarnsAndCentersWithoutNegativePitch() {
        val p = MagnetOp.placeCavities(8f, 8f, 20f, discSpec(4), 0.2f)
        assertTrue(p.warnings.any { it.contains("wider than inset footprint") })
        // usable clamped to 0 → all cavities collapse to origin, no
        // negative spread.
        p.cavities.forEach {
            assertEquals(0f, it.centerXmm, 1e-4f)
            assertEquals(0f, it.centerYmm, 1e-4f)
        }
    }

    @Test
    fun pauseZSnapsStrictlyAboveCavityTopOnLayerBoundary() {
        // top exactly on a boundary → push to next layer
        assertEquals(2.2f, MagnetOp.pauseZForCavityTop(2.0f, 0.2f, 100f), 1e-4f)
        // top mid-layer → ceil to next boundary
        assertEquals(2.2f, MagnetOp.pauseZForCavityTop(2.05f, 0.2f, 100f), 1e-4f)
        // never exceeds host height
        assertEquals(10f, MagnetOp.pauseZForCavityTop(9.95f, 0.2f, 10f), 1e-4f)
        // strictly above the pocket
        assertTrue(MagnetOp.pauseZForCavityTop(3.0f, 0.2f, 100f) > 3.0f)
    }

    @Test
    fun singleMagnetIsCentered() {
        val p = MagnetOp.placeCavities(60f, 40f, 20f, discSpec(1), 0.2f)
        assertEquals(1, p.cavities.size)
        assertEquals(0f, p.cavities[0].centerXmm, 1e-4f)
        assertEquals(0f, p.cavities[0].centerYmm, 1e-4f)
    }

    @Test
    fun placementEqualityIsValueBased() {
        val a = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(4), 0.2f)
        val b = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(4), 0.2f)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        val c = MagnetOp.placeCavities(60f, 60f, 20f, discSpec(6), 0.2f)
        assertNotEquals(a, c)
    }
}
