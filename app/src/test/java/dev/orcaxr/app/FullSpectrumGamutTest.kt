package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests for [FullSpectrumGamut] — the M3 FS quantization seam. */
class FullSpectrumGamutTest {

    private val redBlue = listOf("#FF0000", "#0000FF")

    @Test fun buildAddsPhysicalThenBlendPlaceholders() {
        val b = FullSpectrumGamut.build(redBlue, mixStepPercent = 10)
        assertEquals(2, b.physicalCount)
        // Physical slots are 1 and 2.
        assertEquals(1, b.paletteSlots[0].slot)
        assertEquals(2, b.paletteSlots[1].slot)
        // Blends start at physicalCount+1 = 3.
        val virtual = b.paletteSlots.drop(2)
        assertTrue("has blend placeholders", virtual.isNotEmpty())
        assertEquals(3, virtual.first().slot)
        for (v in virtual) {
            assertTrue(b.recipeOf[v.slot] is GamutMatcher.GamutRecipe.Blend)
            assertTrue(b.predictedHexOf.containsKey(v.slot))
            assertTrue(b.fallbackPhysicalOf[v.slot] in setOf(1, 2))
        }
    }

    @Test fun maxSlotsCapsPlaceholders() {
        val b = FullSpectrumGamut.build(redBlue, mixStepPercent = 10, maxSlots = 4)
        // 2 physical + at most 2 virtual placeholders (slots 3, 4).
        assertTrue(b.paletteSlots.size <= 4)
        assertTrue(b.paletteSlots.none { it.slot > 4 })
    }

    @Test fun materializeAppendsThenReusesBlendRows() {
        val b = FullSpectrumGamut.build(redBlue, mixStepPercent = 10)
        val placeholder = b.paletteSlots.first { it.slot >= 3 }.slot
        val m1 = FullSpectrumGamut.materialize(setOf(placeholder), b, emptyList())
        assertEquals(1, m1.rows.size)
        // real id = physicalCount(2) + rowIndex(1) = 3
        assertEquals(3, m1.remap[placeholder])
        assertTrue(m1.overflowed.isEmpty())
        // Re-materialize against the row we just created → reuse, no append.
        val m2 = FullSpectrumGamut.materialize(setOf(placeholder), b, m1.rows)
        assertEquals(1, m2.rows.size)
        assertEquals(3, m2.remap[placeholder])
    }

    @Test fun materializeFallsBackToPhysicalOnOverflow() {
        val many = (0 until 31).map { "#%06X".format((it * 8000) and 0xFFFFFF) }
        val b = FullSpectrumGamut.build(many, mixStepPercent = 50, maxSlots = 32)
        val placeholder = b.paletteSlots.first { it.slot >= 32 }.slot
        assertEquals(32, placeholder)
        // A pre-existing non-matching row pushes the appended row to
        // rowIndex 2 → realId = 31 + 2 = 33 > 32 → fallback.
        val pre = listOf(MixedFilamentEntry(id = "x", componentA = 1, componentB = 2, mixBPercent = 25))
        val m = FullSpectrumGamut.materialize(setOf(placeholder), b, pre, maxSlots = 32)
        assertTrue(placeholder in m.overflowed)
        assertEquals(b.fallbackPhysicalOf[placeholder], m.remap[placeholder])
        assertTrue("fallback is a physical slot", m.remap[placeholder]!! in 1..31)
    }

    @Test fun remapPaintRewritesVirtualKeepsPhysical() {
        val b = FullSpectrumGamut.build(redBlue, mixStepPercent = 10)
        val placeholder = b.paletteSlots.first { it.slot >= 3 }.slot
        val m = FullSpectrumGamut.materialize(setOf(placeholder), b, emptyList())
        // tris: physical slot 1, the used placeholder, an UNused
        // placeholder (must fall back, never leak a >physical id with
        // no row behind it).
        val unused = b.paletteSlots.last { it.slot >= 3 && it.slot != placeholder }.slot
        val paint = byteArrayOf(1, placeholder.toByte(), unused.toByte())
        val out = FullSpectrumGamut.remapPaint(paint, b, m)
        assertEquals(1, out[0].toInt())
        assertEquals(m.remap[placeholder], out[1].toInt())
        assertEquals(b.fallbackPhysicalOf[unused], out[2].toInt())
        assertFalse("no unmaterialized virtual id leaks",
            out.any { (it.toInt() and 0xff) > b.physicalCount && (it.toInt() and 0xff) != m.remap[placeholder] })
    }

    @Test fun emptyPaletteIsSafe() {
        val b = FullSpectrumGamut.build(emptyList())
        assertTrue(b.paletteSlots.isEmpty())
        assertEquals(0, b.physicalCount)
    }
}
