package dev.orcaxr.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Verifies the mobile preview routes virtual-filament color resolution
 * through libslic3r's pigment-aware blender
 * (MixedFilamentManager::blend_color_multi → filament_mixer's degree-4
 * polynomial regression, ~Mixbox parity) instead of the gamma-correct
 * sRGB fallback. The visible difference matters on opponent-color
 * pairs: a 50% mix of saturated blue and yellow should land on a
 * proper green (close to #2F8D38 per the filament_mixer.h docstring)
 * rather than the gray-green a sRGB midpoint produces — that's the
 * accuracy gap the user reported when comparing OrcaXR's preview to
 * OrcaSlicer FullSpectrum on the SnOrca hexagon.
 */
@RunWith(AndroidJUnit4::class)
class PigmentBlenderTest {

    @Test
    fun blueYellowMidpointResolvesAsGreen() {
        // Triggers the SlicerEngine init block, which wires
        // nativeFilamentBlender. Pure-JVM unit tests don't run that
        // init, so the gamma-correct fallback runs there; this
        // instrumented test confirms the native path is active.
        SlicerEngine.javaClass

        // Filament_mixer header docstring example: blue (#002185)
        // + yellow (#FCD300) at 50%/50% should mix to RGB(47,141,56).
        // The native blender takes integer weights, not percent — the
        // wrapper normalizes internally.
        val hex = SlicerEngine.blendFilamentColors(
            hexes = arrayOf("#002185", "#FCD300"),
            weights = intArrayOf(50, 50),
        )
        assertTrue("expected #RRGGBB result, got '$hex'", hex.startsWith("#") && hex.length == 7)
        val r = hex.substring(1, 3).toInt(16)
        val g = hex.substring(3, 5).toInt(16)
        val b = hex.substring(5, 7).toInt(16)
        // The polynomial mixer is approximate, so check that the
        // result reads as "green" rather than asserting an exact
        // value: green channel dominates by a meaningful margin AND
        // the result is not the muddy gray-green a sRGB midpoint
        // produces (where g would be only marginally higher than r
        // and b).
        assertTrue(
            "expected G > R+0x20 in pigment blue+yellow mix, got #${"%02X%02X%02X".format(r,g,b)}",
            g > r + 0x20,
        )
        assertTrue(
            "expected G > B+0x20 in pigment blue+yellow mix, got #${"%02X%02X%02X".format(r,g,b)}",
            g > b + 0x20,
        )
    }

    @Test
    fun resolverEndToEndUsesPigmentBlender() {
        // Same path the mobile preview takes when a 3MF embeds a
        // virtual mix row that combines blue + yellow.
        SlicerEngine.javaClass
        val basePalette = listOf("#002185", "#FCD300")  // blue, yellow
        val row = MixedFilamentEntry(
            id = "blue_yellow",
            componentA = 1, componentB = 2,
            ratioA = 1, ratioB = 1, mixBPercent = 50,
        )
        val resolved = resolveMixedRowDisplayColor(row, basePalette)
        val r = resolved.substring(1, 3).toInt(16)
        val g = resolved.substring(3, 5).toInt(16)
        val b = resolved.substring(5, 7).toInt(16)
        assertTrue(
            "expected resolved row to read as green via pigment blender, got $resolved",
            g > r + 0x20 && g > b + 0x20,
        )
    }

    @Test
    fun emptyComponentsFallBackToWhite() {
        SlicerEngine.javaClass
        val hex = SlicerEngine.blendFilamentColors(
            hexes = arrayOf(),
            weights = intArrayOf(),
        )
        assertEquals("#FFFFFF", hex)
    }

    @Test
    fun allZeroWeightsFallBackToWhiteOrBlack() {
        // libslic3r's blend_color_multi returns "#000000" when every
        // weight is 0; the wrapper preserves that. Either #000000 or
        // #FFFFFF is a clean fallback — both signal "no usable
        // color" without crashing.
        SlicerEngine.javaClass
        val hex = SlicerEngine.blendFilamentColors(
            hexes = arrayOf("#FF0000", "#00FF00"),
            weights = intArrayOf(0, 0),
        )
        assertTrue(
            "expected #000000 or #FFFFFF fallback, got '$hex'",
            hex == "#000000" || hex == "#FFFFFF",
        )
    }
}
