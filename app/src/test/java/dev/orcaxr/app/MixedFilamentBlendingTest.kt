package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the FullSpectrum virtual-filament color resolver
 * used by the mobile preview. Desktop OrcaSlicer FullSpectrum draws
 * each virtual mix row in its actual blended color; OrcaXR's preview
 * was previously showing every virtual slot as the unpainted brand
 * mint because the renderer's palette only carried the base
 * filament_colour entries. [extendPaletteWithVirtualRows] +
 * [resolveMixedRowDisplayColor] are the pieces that close that gap.
 */
class MixedFilamentBlendingTest {

    private val basePalette =
        listOf("#FF0000", "#00FF00", "#0000FF", "#FFFF00")  // R, G, B, Y

    @Test
    fun twoWayBlend50PctSitsBetweenComponents() {
        val row = MixedFilamentEntry(
            id = "ab", componentA = 1, componentB = 2,
            ratioA = 1, ratioB = 1, mixBPercent = 50,
        )
        val hex = resolveMixedRowDisplayColor(row, basePalette)
        // 50/50 mix of #FF0000 and #00FF00 in gamma-correct linear
        // space lands around #BCBC00 — both channels are bright, but
        // crucially the result is NOT the unpainted "#FFFFFF" placeholder
        // and is distinct from either component.
        assertNotEquals("#FFFFFF", hex)
        assertNotEquals(basePalette[0], hex)
        assertNotEquals(basePalette[1], hex)
        // Sanity: red and green channels should both be > 0x40 because
        // we're mixing two saturated primaries; blue should stay at 0.
        val r = hex.substring(1, 3).toInt(16)
        val g = hex.substring(3, 5).toInt(16)
        val b = hex.substring(5, 7).toInt(16)
        assertTrue("red channel too low: $hex", r > 0x40)
        assertTrue("green channel too low: $hex", g > 0x40)
        assertEquals("blue channel should stay 0: $hex", 0, b)
    }

    @Test
    fun differentMixPercentagesProduceDifferentColors() {
        val row25 = MixedFilamentEntry(
            id = "ab25", componentA = 1, componentB = 2,
            ratioA = 1, ratioB = 1, mixBPercent = 25,
        )
        val row75 = MixedFilamentEntry(
            id = "ab75", componentA = 1, componentB = 2,
            ratioA = 1, ratioB = 1, mixBPercent = 75,
        )
        val a = resolveMixedRowDisplayColor(row25, basePalette)
        val b = resolveMixedRowDisplayColor(row75, basePalette)
        assertNotEquals(
            "25% and 75% B should not collapse to the same swatch: $a vs $b",
            a, b,
        )
    }

    @Test
    fun threeWayGradientPicksUpEachComponent() {
        val row = MixedFilamentEntry(
            id = "rgb", componentA = 1, componentB = 2,
            gradientComponentIds = "123",
            gradientComponentWeights = "1/1/1",
        )
        val hex = resolveMixedRowDisplayColor(row, basePalette)
        // Equal-weight mix of pure red, green, blue lands near a
        // desaturated mid-gray. All channels should be present.
        val r = hex.substring(1, 3).toInt(16)
        val g = hex.substring(3, 5).toInt(16)
        val b = hex.substring(5, 7).toInt(16)
        assertTrue("expected R > 0 in $hex", r > 0)
        assertTrue("expected G > 0 in $hex", g > 0)
        assertTrue("expected B > 0 in $hex", b > 0)
    }

    @Test
    fun manualPatternFoldsRepeatedDigitsIntoWeight() {
        // "1112" = three layers of filament 1 then one of filament 2.
        // Weights should be {1: 3, 2: 1} → result heavily biased
        // toward red.
        val row = MixedFilamentEntry(
            id = "pat", componentA = 1, componentB = 2,
            manualPattern = "1112",
        )
        val hex = resolveMixedRowDisplayColor(row, basePalette)
        val r = hex.substring(1, 3).toInt(16)
        val g = hex.substring(3, 5).toInt(16)
        assertTrue(
            "expected red to dominate green in #1112 mix, got $hex (r=$r g=$g)",
            r > g + 0x10,
        )
    }

    @Test
    fun extendPaletteAppendsOneEntryPerRow() {
        val rows = listOf(
            MixedFilamentEntry(id = "r1", componentA = 1, componentB = 2, mixBPercent = 50),
            MixedFilamentEntry(id = "r2", componentA = 1, componentB = 3, mixBPercent = 50),
            MixedFilamentEntry(id = "r3", componentA = 2, componentB = 3, mixBPercent = 50),
        )
        val extended = extendPaletteWithVirtualRows(basePalette, rows)
        assertEquals(basePalette.size + rows.size, extended.size)
        // The first basePalette.size entries must match the base
        // verbatim — otherwise physical filament rendering breaks.
        for (i in basePalette.indices) {
            assertEquals(basePalette[i], extended[i])
        }
        // The three virtual rows should resolve to three DIFFERENT
        // blended colors (R+G, R+B, G+B) — none should equal a base
        // entry or the unpainted "#FFFFFF" placeholder.
        val virtuals = extended.drop(basePalette.size).toSet()
        assertEquals(rows.size, virtuals.size)
        for (v in virtuals) {
            assertTrue(
                "virtual entry $v collided with a base palette entry",
                v !in basePalette,
            )
            assertNotEquals(
                "virtual entry should not be the unpainted fallback",
                "#FFFFFF", v,
            )
        }
    }

    @Test
    fun deletedRowsKeepTheirIndexSlot() {
        // libslic3r indexes virtual filaments as `filament_id -
        // num_physical - 1`, so dropping deleted rows from the
        // extended palette would shift every later virtual id down by
        // one. We keep them — the resolver produces whatever color
        // their components blend to (even though the row is logically
        // tombstoned), and the slot stays addressable.
        val rows = listOf(
            MixedFilamentEntry(id = "live", componentA = 1, componentB = 2, mixBPercent = 50),
            MixedFilamentEntry(
                id = "dead", componentA = 1, componentB = 3, mixBPercent = 50,
                deleted = true,
            ),
            MixedFilamentEntry(id = "live2", componentA = 2, componentB = 3, mixBPercent = 50),
        )
        val extended = extendPaletteWithVirtualRows(basePalette, rows)
        assertEquals(
            "deleted rows must still occupy a palette slot to preserve indexing",
            basePalette.size + rows.size,
            extended.size,
        )
    }
}
