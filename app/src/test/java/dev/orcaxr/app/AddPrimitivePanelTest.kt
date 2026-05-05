package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D12 — pure-Kotlin contract tests for the AddPrimitivePanel's data
 * layer. Pins the slider-range heuristics + AddRequest equality so a
 * later refactor can't silently flip "facet_angle is degrees, not mm"
 * without the tests catching it.
 */
class AddPrimitivePanelTest {

    // -----------------------------------------------------------------
    // PrimitivePanelData.rangeFor — slider envelope per param
    // -----------------------------------------------------------------

    @Test fun facetAngleIsClampedToReasonableArc() {
        // libslic3r treats the facet angle as the chord angle per
        // segment (degrees). 1°..18° covers the practical tessellation
        // ladder; outside that range either bloats triangle count or
        // makes the primitive visibly facetted.
        val r = PrimitivePanelData.rangeFor("facet_angle_deg")
        assertEquals(1f, r.start)
        assertEquals(18f, r.endInclusive)
    }

    @Test fun heightStaysInsideTypicalBed() {
        val r = PrimitivePanelData.rangeFor("height_mm")
        assertTrue(r.start >= 0.5f)
        // Typical printable Z is 200..400 mm; 200 is the minimum useful
        // ceiling. Anything taller would happily overflow the U1's
        // build envelope and silently fail the bed-collision check.
        assertEquals(200f, r.endInclusive)
    }

    @Test fun radiusRangeAllowsSubMillimeter() {
        // A Ø1 mm cylinder is a legitimate magnet-locator pin head;
        // don't lock the slider at 5 mm minimum.
        val r = PrimitivePanelData.rangeFor("radius_mm")
        assertTrue(r.start <= 0.5f)
    }

    @Test fun unknownNamesGetGenericMmRange() {
        val r = PrimitivePanelData.rangeFor("not_a_real_param")
        // Sanity: still positive and finite.
        assertTrue(r.start > 0f)
        assertTrue(r.endInclusive > r.start)
    }

    @Test fun stepsForFacetAngleIsDiscretised() {
        // Hand-tracking-precision sliders need discrete steps; default
        // for facet angle is 16 (1° increments across the 1..18 range).
        assertEquals(16, PrimitivePanelData.stepsFor("facet_angle_deg"))
    }

    @Test fun stepsForLengthIsContinuous() {
        // Lengths in mm should be continuous so the user can dial in
        // a fractional value.
        assertEquals(0, PrimitivePanelData.stepsFor("radius_mm"))
        assertEquals(0, PrimitivePanelData.stepsFor("height_mm"))
    }

    @Test fun everyKnownParamHasRangeCoveringDefaults() {
        // Every primitive's default value MUST land inside the slider
        // envelope, otherwise the slider clamps the value on first
        // render and the user sees a different number than the panel
        // started with.
        for (k in PrimitiveKind.values()) {
            for ((i, name) in k.paramNames.withIndex()) {
                val def = k.defaults[i]
                val r = PrimitivePanelData.rangeFor(name)
                assertTrue(
                    "$k.$name default=$def must be >= range.start=${r.start}",
                    def >= r.start,
                )
                assertTrue(
                    "$k.$name default=$def must be <= range.end=${r.endInclusive}",
                    def <= r.endInclusive,
                )
            }
        }
    }

    // -----------------------------------------------------------------
    // ModeKind ↔ ModelVolumeType
    // -----------------------------------------------------------------

    @Test fun objectModeHasNoVolumeType() {
        assertNull(PrimitivePanelData.ModeKind.AsObject.volumeType)
    }

    @Test fun everyVolumeKindIsCovered() {
        val typesInPanel = PrimitivePanelData.ModeKind.values()
            .mapNotNull { it.volumeType }
            .toSet()
        // The panel must surface every author-able volume kind D14 ships.
        // If a future ModelVolumeType is added, the test forces the
        // author to also surface it in the panel (or explicitly add a
        // rationale to skip it).
        assertEquals(ModelVolumeType.values().toSet(), typesInPanel)
    }

    // -----------------------------------------------------------------
    // AddRequest equality (used by Compose remember keys + tests)
    // -----------------------------------------------------------------

    @Test fun addRequestEqualityChecksParamsContent() {
        val a = PrimitivePanelData.AddRequest(
            kind = PrimitiveKind.CYLINDER,
            params = floatArrayOf(7f, 20f, 2f),
            mode = PrimitivePanelData.Mode.AsObject,
        )
        val b = PrimitivePanelData.AddRequest(
            kind = PrimitiveKind.CYLINDER,
            params = floatArrayOf(7f, 20f, 2f),
            mode = PrimitivePanelData.Mode.AsObject,
        )
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        val c = a.copy(params = floatArrayOf(7f, 25f, 2f))
        assertNotEquals(a, c)
    }

    @Test fun addRequestVolumeModeCarriesTarget() {
        val r = PrimitivePanelData.AddRequest(
            kind = PrimitiveKind.CUBE,
            params = floatArrayOf(6f, 6f, 3f),
            mode = PrimitivePanelData.Mode.AsVolume(
                ModelVolumeType.NEGATIVE_VOLUME,
                "model_42",
            ),
        )
        val asVol = r.mode as PrimitivePanelData.Mode.AsVolume
        assertEquals(ModelVolumeType.NEGATIVE_VOLUME, asVol.type)
        assertEquals("model_42", asVol.targetModelId)
    }

    // -----------------------------------------------------------------
    // Param value formatting
    // -----------------------------------------------------------------

    @Test fun paramValueLabelUnits() {
        assertTrue(paramValueLabel("radius_mm", 7.5f).endsWith("mm"))
        assertTrue(paramValueLabel("facet_angle_deg", 6f).endsWith("°"))
        assertEquals("Radius", paramLabel("radius_mm"))
        assertEquals("Facet angle", paramLabel("facet_angle_deg"))
    }
}
