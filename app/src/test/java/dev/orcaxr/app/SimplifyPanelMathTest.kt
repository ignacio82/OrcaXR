package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Roadmap D17 — pin the SimplifyPanel slider's number-formatting +
 * round-to-nice helpers so the user-visible readout stays stable as
 * the slider moves.
 */
class SimplifyPanelMathTest {

    @Test fun `round-to-nice picks the largest 1-2-5-10 multiple at-or-below the input`() {
        // 1, 2, 5, 10 × 10^k landmarks; everything in between rounds
        // DOWN to the nearest landmark.
        assertEquals(1, SimplifyPanelMath.roundToNearestNice(1))
        assertEquals(2, SimplifyPanelMath.roundToNearestNice(3))
        assertEquals(5, SimplifyPanelMath.roundToNearestNice(7))
        assertEquals(10, SimplifyPanelMath.roundToNearestNice(11))
        assertEquals(50, SimplifyPanelMath.roundToNearestNice(74))
        assertEquals(100, SimplifyPanelMath.roundToNearestNice(123))
        assertEquals(50_000, SimplifyPanelMath.roundToNearestNice(54_321))
        assertEquals(500_000, SimplifyPanelMath.roundToNearestNice(789_012))
        assertEquals(1_000_000, SimplifyPanelMath.roundToNearestNice(1_048_576))
    }

    @Test fun `format-thousands inserts commas for positive ints`() {
        assertEquals("0", SimplifyPanelMath.formatThousands(0))
        assertEquals("1", SimplifyPanelMath.formatThousands(1))
        assertEquals("999", SimplifyPanelMath.formatThousands(999))
        assertEquals("1,000", SimplifyPanelMath.formatThousands(1_000))
        assertEquals("50,000", SimplifyPanelMath.formatThousands(50_000))
        assertEquals("1,048,576", SimplifyPanelMath.formatThousands(1_048_576))
    }

    @Test fun `format-thousands handles negatives without misplacing the comma`() {
        // Defensive: the slider can't go negative today, but the helper
        // is general-purpose enough to keep correct under future use.
        assertEquals("-1,000", SimplifyPanelMath.formatThousands(-1_000))
        assertEquals("-1,234,567", SimplifyPanelMath.formatThousands(-1_234_567))
    }
}
