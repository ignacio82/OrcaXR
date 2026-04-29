package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [TopCoverRule]. Phase H.2 ships this as the user-visible
 * surface for `requires_top_cover` (libslic3r patch 0026 only
 * registers the key). The rule has to:
 *  - Stay quiet when bundled profiles don't set the key (the common
 *    case today — no Phase B PA-CF / ABS-CF leaves yet).
 *  - Fire on any slot with "1" so a future profile that flips the
 *    key on T2 immediately surfaces a banner.
 */
class TopCoverRuleTest {

    @Test fun keyAbsentIsOk() {
        assertEquals(TopCoverRule.Result.Ok, TopCoverRule.evaluate(emptyMap()))
    }

    @Test fun emptyValueIsOk() {
        assertEquals(
            TopCoverRule.Result.Ok,
            TopCoverRule.evaluate(mapOf("requires_top_cover" to "")),
        )
    }

    @Test fun allZerosIsOk() {
        // The shape mergedConfig produces today for a 4-slot profile
        // that didn't set the key (after Phase H.1 SAFE_KEYS landed
        // and resize() padded it).
        assertEquals(
            TopCoverRule.Result.Ok,
            TopCoverRule.evaluate(mapOf("requires_top_cover" to "0,0,0,0")),
        )
    }

    @Test fun firstSlotFlagged() {
        val r = TopCoverRule.evaluate(mapOf("requires_top_cover" to "1,0,0,0"))
        assertTrue(r is TopCoverRule.Result.Warning)
        val w = r as TopCoverRule.Result.Warning
        assertEquals(listOf(0), w.slots)
        assertTrue("expected message to mention T1, got '${w.message}'", "T1" in w.message)
    }

    @Test fun multipleSlotsFlagged() {
        val r = TopCoverRule.evaluate(mapOf("requires_top_cover" to "0,1,0,1"))
        assertTrue(r is TopCoverRule.Result.Warning)
        val w = r as TopCoverRule.Result.Warning
        assertEquals(listOf(1, 3), w.slots)
        assertTrue("T2" in w.message)
        assertTrue("T4" in w.message)
    }

    @Test fun semicolonSeparatorAlsoTolerated() {
        // Defensive: if a future flatten path produces semicolons
        // (coStrings convention), the rule should still fire. coBools
        // today is comma-joined, so this only matters for resilience.
        val r = TopCoverRule.evaluate(mapOf("requires_top_cover" to "0;1;0"))
        assertTrue(r is TopCoverRule.Result.Warning)
        assertEquals(listOf(1), (r as TopCoverRule.Result.Warning).slots)
    }

    @Test fun trueLiteralAlsoTolerated() {
        // libslic3r serializes "true"/"false" in some legacy paths.
        val r = TopCoverRule.evaluate(mapOf("requires_top_cover" to "true,false"))
        assertTrue(r is TopCoverRule.Result.Warning)
        assertEquals(listOf(0), (r as TopCoverRule.Result.Warning).slots)
    }
}
