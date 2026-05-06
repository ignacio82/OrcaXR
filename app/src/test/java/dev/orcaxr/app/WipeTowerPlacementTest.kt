package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap A13 — pure-Kotlin tests for the wipe-tower auto-placement
 * scorer. Verifies the 8-candidate grid, the bias-driven tie-break,
 * and the L∞ clearance metric.
 */
class WipeTowerPlacementTest {

    private val u1Bed = Pair(270f, 270f) // Snapmaker U1 bed extents.

    @Test fun empty_plate_picks_back_left_by_default() {
        val pick = WipeTowerPlacement.score(
            parts = emptyList(),
            bedW = u1Bed.first,
            bedD = u1Bed.second,
        )
        assertEquals("back-left", pick.label)
        // Inset 1 mm from the back-left corner.
        assertEquals(1f, pick.xMm, 0.5f)
        assertEquals(u1Bed.second - 60f /*tower*/ - 1f /*inset*/, pick.yMm, 0.5f)
        assertTrue("clearance should be huge", pick.clearanceMm > 100f)
    }

    @Test fun part_in_back_left_pushes_tower_to_far_corner() {
        // A 60×60 part centered at back-left (40, 220). Default bias
        // back-left is overruled because its clearance is now 0 / negative.
        val part = WipeTowerPlacement.AabbXY.of(40f, 230f, 60f, 60f)
        val pick = WipeTowerPlacement.score(
            parts = listOf(part),
            bedW = u1Bed.first,
            bedD = u1Bed.second,
        )
        // back-left tower would overlap the part; one of the other
        // candidates wins. front-right is the geometric opposite, but
        // back-mid / right-mid / etc. all also clear. Just assert the
        // picked candidate has positive clearance and is NOT
        // back-left.
        assertTrue("expected non-back-left, got ${pick.label}", pick.label != "back-left")
        assertTrue("clearance must be positive at $pick", pick.clearanceMm > 0f)
    }

    @Test fun bias_breaks_ties_when_clearances_are_close() {
        // No parts at all → every candidate has infinite clearance.
        // back-right bias should land at back-right.
        val pick = WipeTowerPlacement.score(
            parts = emptyList(),
            bedW = u1Bed.first,
            bedD = u1Bed.second,
            bias = WipeTowerPlacement.Bias.BackRight,
        )
        assertEquals("back-right", pick.label)
    }

    @Test fun largest_clearance_finds_well_clearing_candidate() {
        // L∞ clearance ties heavily on a square bed (every corner is
        // equidistant from a tiny part), so we can't pin a *specific*
        // corner. Just verify the picked clearance is large and the
        // pick honors LargestClearance bias (no early back-left pull).
        val part = WipeTowerPlacement.AabbXY.of(30f, 30f, 40f, 40f)
        val pick = WipeTowerPlacement.score(
            parts = listOf(part),
            bedW = u1Bed.first,
            bedD = u1Bed.second,
            bias = WipeTowerPlacement.Bias.LargestClearance,
        )
        assertTrue("expected high clearance, got ${pick.clearanceMm}", pick.clearanceMm > 100f)
        // And confirm the picked label is in the candidate set.
        assertTrue(
            "got unknown label ${pick.label}",
            pick.label in setOf(
                "back-left", "back-right", "front-left", "front-right",
                "back-mid", "front-mid", "left-mid", "right-mid",
            ),
        )
    }

    @Test fun aabb_l_inf_clearance_handles_overlap_and_separation() {
        val a = WipeTowerPlacement.AabbXY(0f, 0f, 10f, 10f)
        val b = WipeTowerPlacement.AabbXY(20f, 20f, 30f, 30f)
        // Diagonal gap is 10 in X and 10 in Y → L∞ = 10.
        assertEquals(10f, WipeTowerPlacement.aabbLInfClearance(a, b), 0.01f)
        // Side-by-side, 5 mm apart in X.
        val c = WipeTowerPlacement.AabbXY(15f, 0f, 25f, 10f)
        assertEquals(5f, WipeTowerPlacement.aabbLInfClearance(a, c), 0.01f)
        // Overlapping → result is negative (interpenetration depth).
        val d = WipeTowerPlacement.AabbXY(5f, 5f, 15f, 15f)
        assertTrue(
            "overlapping rects should report negative clearance",
            WipeTowerPlacement.aabbLInfClearance(a, d) < 0f,
        )
    }

    @Test fun bias_parse_accepts_aliases() {
        // null defaults to BackLeft (safer default for the auto-position
        // happy path — XR users look front-down at the bed).
        assertEquals(WipeTowerPlacement.Bias.BackLeft, WipeTowerPlacement.Bias.parse(null))
        assertEquals(WipeTowerPlacement.Bias.BackLeft, WipeTowerPlacement.Bias.parse("back-left"))
        assertEquals(WipeTowerPlacement.Bias.BackLeft, WipeTowerPlacement.Bias.parse("BACK_LEFT"))
        assertEquals(WipeTowerPlacement.Bias.LargestClearance, WipeTowerPlacement.Bias.parse("largest"))
        assertEquals(WipeTowerPlacement.Bias.LargestClearance, WipeTowerPlacement.Bias.parse("largest_clearance"))
        // Unknown string falls back to BackLeft (safer default).
        assertEquals(WipeTowerPlacement.Bias.BackLeft, WipeTowerPlacement.Bias.parse("garbage"))
    }

    @Test fun small_bed_with_huge_part_returns_best_available() {
        // 100x100 bed with a 90x90 part — the tower can't fit anywhere
        // without overlap. The scorer must still return a Pick (best
        // available, even if clearance is negative). Caller decides
        // whether to honor it or fall back to profile defaults.
        val part = WipeTowerPlacement.AabbXY(5f, 5f, 95f, 95f)
        val pick = WipeTowerPlacement.score(
            parts = listOf(part),
            bedW = 100f,
            bedD = 100f,
            towerW = 60f,
            towerD = 60f,
        )
        // Just sanity-check the API: a Pick is returned with a label.
        assertTrue("got an empty label", pick.label.isNotEmpty())
        // Clearance is some real number (could be negative — overlap).
        assertTrue(pick.clearanceMm.isFinite() || pick.clearanceMm == Float.POSITIVE_INFINITY)
    }
}
