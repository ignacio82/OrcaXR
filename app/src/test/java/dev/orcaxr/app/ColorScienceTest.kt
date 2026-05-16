package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests for [ColorScience] (extracted from GamutMatcher). */
class ColorScienceTest {

    @Test fun parseLabRejectsShortOrNonHex() {
        assertNull(ColorScience.parseLab("#FFF"))
        assertNull(ColorScience.parseLab("nothex"))
        assertNull(ColorScience.parseLab("#ZZZZZZ"))
    }

    @Test fun parseLabAcceptsHashAndBare() {
        val a = ColorScience.parseLab("#FF0000")!!
        val b = ColorScience.parseLab("FF0000")!!
        assertEquals(a, b)
    }

    @Test fun whiteAndBlackLightnessAreExtremes() {
        val black = ColorScience.rgbToLab(0, 0, 0)
        val white = ColorScience.rgbToLab(255, 255, 255)
        assertTrue("black L≈0", black.l < 1.0)
        assertTrue("white L≈100", white.l > 99.0)
    }

    @Test fun redHasPositiveAStar() {
        val red = ColorScience.rgbToLab(255, 0, 0)
        assertTrue("red a* > 0", red.a > 0)
    }

    @Test fun ciede2000OfIdenticalColorsIsZero() {
        val c = ColorScience.parseLab("#3366CC")!!
        assertEquals(0.0, ColorScience.ciede2000(c, c), 1e-9)
    }

    @Test fun ciede2000WhiteVsBlackIsLarge() {
        val w = ColorScience.rgbToLab(255, 255, 255)
        val k = ColorScience.rgbToLab(0, 0, 0)
        assertTrue(ColorScience.ciede2000(w, k) > 50.0)
    }

    @Test fun nearestIndexPicksPerceptualClosestNotEuclidean() {
        val palette = listOf(
            ColorScience.rgbToLab(255, 0, 0),   // 0 red
            ColorScience.rgbToLab(0, 255, 0),   // 1 green
            ColorScience.rgbToLab(0, 0, 255),   // 2 blue
        )
        val target = ColorScience.rgbToLab(220, 20, 30) // a reddish color
        assertEquals(0, ColorScience.nearestIndex(target, palette))
        assertEquals(-1, ColorScience.nearestIndex(target, emptyList()))
    }
}
