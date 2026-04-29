package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Phase XR_OBJ_8 regression — pin [clonePatternOffsets] math.
 * The offset list feeds [MainActivity.runClonePattern]; if the
 * pitch math drifts (axis confusion, count off-by-one, footprint
 * picks the wrong axis after rotation) the cloned pattern silently
 * overlaps or stretches.
 */
class ClonePatternTest {

    private fun model(
        bboxX: Float = 50f,
        bboxY: Float = 30f,
        bboxZ: Float = 20f,
        rotZ: Int = 0,
        scale: Int = 100,
    ) = PlacedModel(
        id = "src",
        source = File("/tmp/src.stl"),
        label = "src",
        baseBboxXmm = bboxX,
        baseBboxYmm = bboxY,
        baseBboxZmm = bboxZ,
        rotZDeg = rotZ,
        scalePct = scale,
    )

    @Test fun axisXProducesXOffsetsOnly() {
        // 50mm wide source + 10mm spacing → pitch = 60mm.
        // Clone 1 → +60, Clone 2 → +120, Clone 3 → +180.
        val offsets = clonePatternOffsets(model(), 3, 10f, 'x')
        assertEquals(3, offsets.size)
        assertEquals(60f to 0f, offsets[0])
        assertEquals(120f to 0f, offsets[1])
        assertEquals(180f to 0f, offsets[2])
    }

    @Test fun axisYProducesYOffsetsOnly() {
        // 30mm deep source + 5mm spacing → pitch = 35mm.
        val offsets = clonePatternOffsets(model(), 2, 5f, 'y')
        assertEquals(2, offsets.size)
        assertEquals(0f to 35f, offsets[0])
        assertEquals(0f to 70f, offsets[1])
    }

    @Test fun upperCaseAxisIsAcceptedSameAsLower() {
        val lower = clonePatternOffsets(model(), 2, 0f, 'x')
        val upper = clonePatternOffsets(model(), 2, 0f, 'X')
        assertEquals(lower, upper)
    }

    @Test fun unrecognizedAxisFallsBackToX() {
        // 'z' isn't a valid axis for a planar pattern; runClonePattern's
        // contract is "x or y". The fallback path picks X to keep the
        // bug visible (a 0-offset stack would silently coincide).
        val offsets = clonePatternOffsets(model(), 1, 0f, 'z')
        assertEquals(50f to 0f, offsets[0])
    }

    @Test fun zeroSpacingMakesFootprintsTouch() {
        // Edges flush — clone i lands at i × footprintWidth.
        val offsets = clonePatternOffsets(model(bboxX = 40f), 3, 0f, 'x')
        assertEquals(40f to 0f, offsets[0])
        assertEquals(80f to 0f, offsets[1])
        assertEquals(120f to 0f, offsets[2])
    }

    @Test fun rotationSwapsFootprintAxisAtNinetyDegrees() {
        // 80×40 source rotated 90° has effective footprint 40×80.
        // X-axis pitch = 40 + spacing, Y-axis pitch = 80 + spacing.
        val rotated = model(bboxX = 80f, bboxY = 40f, rotZ = 90)
        val xOffsets = clonePatternOffsets(rotated, 1, 5f, 'x')
        val yOffsets = clonePatternOffsets(rotated, 1, 5f, 'y')
        assertEquals(45f to 0f, xOffsets[0])
        assertEquals(0f to 85f, yOffsets[0])
    }

    @Test fun scaleAffectsPitch() {
        // 50mm at 200% takes 100mm of footprint; pitch scales accordingly.
        val big = model(bboxX = 50f, scale = 200)
        val offsets = clonePatternOffsets(big, 1, 10f, 'x')
        // pitch = 100 + 10 = 110.
        assertEquals(110f to 0f, offsets[0])
    }

    @Test fun countOneReturnsSingleOffset() {
        // The "clone once" case — one extra entry positioned one pitch
        // away from the source.
        val offsets = clonePatternOffsets(model(), 1, 0f, 'x')
        assertEquals(1, offsets.size)
        assertEquals(50f to 0f, offsets[0])
    }

    @Test fun negativeSpacingPullsClonesTowardSourceButHelperPermits() {
        // We let the helper produce negative pitch — the snap+clamp
        // step (in MainActivity) is what guards the bed boundary.
        // Documents the contract: helper is pure math, no clamping.
        val offsets = clonePatternOffsets(model(bboxX = 50f), 2, -60f, 'x')
        // pitch = 50 + (-60) = -10. So clone 1 = -10, clone 2 = -20.
        assertEquals(-10f to 0f, offsets[0])
        assertEquals(-20f to 0f, offsets[1])
    }

    @Test fun zeroCountThrows() {
        // Guard against an off-by-one elsewhere triggering an empty
        // pattern silently — runClonePattern's own count gate (n >= 1)
        // is the public contract; this asserts the helper's internal
        // invariant matches.
        try {
            clonePatternOffsets(model(), 0, 0f, 'x')
            error("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }
}
