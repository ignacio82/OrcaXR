package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Tests for [scrubRate]'s velocity curve. The hero use case (400-layer
 * scrub at full stick → ~10s) is sensitive to: deadband width, sign
 * preservation, max-rate clamp, and the exponent ramp shape.
 */
class ControllerInputTest {

    private fun close(expected: Float, actual: Float, eps: Float = 1e-4f) {
        assertTrue("expected $expected, got $actual", abs(expected - actual) <= eps)
    }

    @Test fun zeroStickGivesZeroRate() {
        assertEquals(0f, scrubRate(0f, flat = 0.1f, maxLps = 40))
    }

    @Test fun withinDeadbandGivesZeroRate() {
        // Both signs of jitter under the flat band must be ignored —
        // resting noise on a centered stick will sit here.
        assertEquals(0f, scrubRate(0.05f, flat = 0.1f, maxLps = 40))
        assertEquals(0f, scrubRate(-0.09f, flat = 0.1f, maxLps = 40))
        // Boundary: exactly at flat is still considered dead (≤, not <).
        assertEquals(0f, scrubRate(0.1f, flat = 0.1f, maxLps = 40))
    }

    @Test fun fullDeflectionHitsMaxLps() {
        close(40f, scrubRate(1f, flat = 0.1f, maxLps = 40))
        close(-40f, scrubRate(-1f, flat = 0.1f, maxLps = 40))
    }

    @Test fun signIsPreserved() {
        val pos = scrubRate(0.6f, flat = 0.1f, maxLps = 40)
        val neg = scrubRate(-0.6f, flat = 0.1f, maxLps = 40)
        assertTrue("expected positive, got $pos", pos > 0f)
        assertTrue("expected negative, got $neg", neg < 0f)
        close(pos, -neg)
    }

    @Test fun midDeflectionIsLessThanLinear() {
        // exponent=2.5 means halfway-deflected stick should produce
        // *much* less than half the max rate. Defends against a
        // future "linearize this for feel" regression: at v=0.5 with
        // flat=0.1, normalized = 0.444; 0.444^2.5 ≈ 0.131 → ~5.3 lps.
        // Linear would have produced 20 lps. The test asserts the
        // curved value is well under linear-half (< 15 lps) so we
        // don't accidentally fall back to linear.
        val r = scrubRate(0.5f, flat = 0.1f, maxLps = 40)
        assertTrue("mid-deflection rate $r should be sub-linear", r < 15f)
        assertTrue("mid-deflection rate $r should be > 0", r > 0f)
    }

    @Test fun outOfRangeStickIsClamped() {
        // Drivers occasionally report values past [-1, 1] (calibration
        // drift on cheap pads). The function must not produce
        // > maxLps, otherwise the consumer's `delay(1000/abs(rate))`
        // can underflow to zero and busy-loop.
        val high = scrubRate(2f, flat = 0.1f, maxLps = 40)
        // Allow a tiny epsilon — exponent on (1) returns exactly 1 but
        // floats compose imperfectly.
        assertTrue("rate $high must not exceed maxLps", high <= 40.0001f)
    }

    @Test fun zeroFlatStillProducesContinuousCurve() {
        // If the platform reports flat=0 (some emulator drivers do),
        // the curve must still be well-defined and start at 0.
        assertEquals(0f, scrubRate(0f, flat = 0f, maxLps = 40))
        close(40f, scrubRate(1f, flat = 0f, maxLps = 40))
    }

    @Test fun pathologicalFlatNearOneStillHonorsZero() {
        // flat = 0.95 means almost the whole travel is dead. Anything
        // under that must remain 0; full deflection still hits max.
        assertEquals(0f, scrubRate(0.9f, flat = 0.95f, maxLps = 40))
        close(40f, scrubRate(1f, flat = 0.95f, maxLps = 40))
    }

    @Test fun ratesScaleLinearlyWithMaxLps() {
        // Pure proportionality in maxLps — same stick, doubled cap,
        // doubled result.
        val a = scrubRate(0.7f, flat = 0.1f, maxLps = 20)
        val b = scrubRate(0.7f, flat = 0.1f, maxLps = 40)
        close(2 * a, b, eps = 1e-3f)
    }

    @Test fun controllerInputBusEmitsAndResets() {
        val bus = ControllerInputBus()
        bus.setLeftStick(0.3f, -0.4f)
        assertEquals(0.3f, bus.leftStickX.value)
        assertEquals(-0.4f, bus.leftStickY.value)
        bus.resetAxes()
        assertEquals(0f, bus.leftStickX.value)
        assertEquals(0f, bus.leftStickY.value)
    }

    @Test fun controllerInputBusClampsAxisInput() {
        // Drivers can over-report; bus normalizes to [-1, 1] so
        // consumers can trust the range.
        val bus = ControllerInputBus()
        bus.setLeftStick(2f, -3f)
        assertEquals(1f, bus.leftStickX.value)
        assertEquals(-1f, bus.leftStickY.value)
    }

    @Test fun midDeflectionBelowFullValue() {
        // Sanity: a half-deflection rate must be strictly less than
        // a full deflection rate (monotonicity of the ramp).
        val half = scrubRate(0.5f, flat = 0.1f, maxLps = 40)
        val full = scrubRate(1f, flat = 0.1f, maxLps = 40)
        assertNotEquals(half, full)
        assertTrue(half < full)
    }

    // ---------------- nextScrubLayer (Phase 2 — Y axis) ----------------

    @Test fun scrubFromShowAllPushingDownStartsAtTopMinusOne() {
        // Plan §5 boundary: from null, negative rate snaps to topLayer-1
        // so the scrub visibly starts.
        assertEquals(399, nextScrubLayer(current = null, rate = -10f, topLayer = 400))
    }

    @Test fun scrubFromShowAllPushingUpStaysShowingAll() {
        // Already showing all; nothing to scrub up to.
        assertEquals(null, nextScrubLayer(current = null, rate = 10f, topLayer = 400))
    }

    @Test fun scrubPositiveRateIncrementsByOne() {
        assertEquals(101, nextScrubLayer(current = 100, rate = 5f, topLayer = 400))
    }

    @Test fun scrubNegativeRateDecrementsByOne() {
        assertEquals(99, nextScrubLayer(current = 100, rate = -5f, topLayer = 400))
    }

    @Test fun scrubPastTopReturnsNull() {
        // Crossing the top boundary re-enters "show all" so the user
        // doesn't have to manage layer caps when scrubbing all the way up.
        assertEquals(null, nextScrubLayer(current = 399, rate = 5f, topLayer = 400))
    }

    @Test fun scrubAtZeroDoesNotGoNegative() {
        assertEquals(0, nextScrubLayer(current = 0, rate = -5f, topLayer = 400))
    }

    @Test fun scrubZeroRateIsNoOp() {
        assertEquals(50, nextScrubLayer(current = 50, rate = 0f, topLayer = 400))
        assertEquals(null, nextScrubLayer(current = null, rate = 0f, topLayer = 400))
    }

    @Test fun scrubWithEmptyOrSingleLayerTopIsNoOp() {
        // Edge cases: a one-layer slice (lastIndex = 0) or a not-yet-
        // sliced run (lastIndex = -1) shouldn't crash or scrub. Plan
        // anchor: §3.5 / §5 (the LE bails until topLayer > 0).
        assertEquals(null, nextScrubLayer(current = null, rate = -5f, topLayer = 0))
        assertEquals(null, nextScrubLayer(current = null, rate = -5f, topLayer = -1))
    }

    // ---------------- nextJumpLayer (Phase 2 — X axis ±10) ----------------

    @Test fun jumpFromShowAllJumpsBackTen() {
        // From null with negative direction, jump anchors to topLayer
        // and steps back by jumpSize (default 10) → topLayer-10.
        assertEquals(390, nextJumpLayer(current = null, signedDirection = -1, topLayer = 400))
    }

    @Test fun jumpForwardPastTopReturnsNull() {
        assertEquals(null, nextJumpLayer(current = 395, signedDirection = +1, topLayer = 400))
    }

    @Test fun jumpBackwardClampsAtZero() {
        assertEquals(0, nextJumpLayer(current = 5, signedDirection = -1, topLayer = 400))
    }

    @Test fun jumpZeroDirectionIsNoOp() {
        assertEquals(100, nextJumpLayer(current = 100, signedDirection = 0, topLayer = 400))
    }

    @Test fun jumpNormalCase() {
        assertEquals(110, nextJumpLayer(current = 100, signedDirection = 1, topLayer = 400))
        assertEquals(90, nextJumpLayer(current = 100, signedDirection = -1, topLayer = 400))
    }

    @Test fun jumpSizeIsConfigurable() {
        // Drove this from a parameter rather than hardcoding 10 so
        // we can tune from the binding site without touching the
        // helper.
        assertEquals(125, nextJumpLayer(current = 100, signedDirection = 1, topLayer = 400, jumpSize = 25))
    }

    @Test fun jumpWithEmptyOrSingleLayerTopIsNoOp() {
        assertEquals(null, nextJumpLayer(current = null, signedDirection = -1, topLayer = 0))
        assertEquals(null, nextJumpLayer(current = null, signedDirection = -1, topLayer = -1))
        assertEquals(10, nextJumpLayer(current = 10, signedDirection = -1, topLayer = 0))
    }

    @Test fun jumpFromShowAllJumpsForwardStaysShowAll() {
        assertEquals(null, nextJumpLayer(current = null, signedDirection = 1, topLayer = 400))
    }

    // ---------------- nextRotationDeg (Phase 4 — X axis 90° rotate) ----------------

    @Test fun rotateForwardCyclesQuartet() {
        assertEquals(90, nextRotationDeg(0, signedDirection = 1))
        assertEquals(180, nextRotationDeg(90, signedDirection = 1))
        assertEquals(270, nextRotationDeg(180, signedDirection = 1))
        assertEquals(0, nextRotationDeg(270, signedDirection = 1))
    }

    @Test fun rotateBackwardCyclesQuartet() {
        assertEquals(270, nextRotationDeg(0, signedDirection = -1))
        assertEquals(0, nextRotationDeg(90, signedDirection = -1))
        assertEquals(90, nextRotationDeg(180, signedDirection = -1))
        assertEquals(180, nextRotationDeg(270, signedDirection = -1))
    }

    @Test fun rotateZeroDirectionNormalizes() {
        // Even a no-op call must normalize an out-of-range input — a
        // saved profile with rotZDeg=450 from a different code path
        // shouldn't survive a tick of model manipulation.
        assertEquals(90, nextRotationDeg(450, signedDirection = 0))
        assertEquals(270, nextRotationDeg(-90, signedDirection = 0))
    }

    @Test fun rotateNormalizesNegativeStartAngle() {
        // -90 + 90 = 0; this also exercises the modulo-of-negative
        // path which Kotlin's % returns negative for.
        assertEquals(0, nextRotationDeg(-90, signedDirection = 1))
        assertEquals(180, nextRotationDeg(-90, signedDirection = -1))
    }
}
