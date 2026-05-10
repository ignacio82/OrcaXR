package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A12 — pin the [HeightRange] data model + its participation in
 * [PlacedModel] equality, copy semantics, and the canonical authoring
 * shapes (single 100% infill band on the bottom 5 mm of a 20 mm cube).
 *
 * The JNI thread to `mo->layer_config_ranges` is exercised on-device;
 * here we only pin the Kotlin side so a future refactor can't drop a
 * field silently from PlacedModel.equals or PlacedModel.hashCode.
 */
class HeightRangeTest {

    private fun model(ranges: List<HeightRange> = emptyList()): PlacedModel =
        PlacedModel(
            id = "m",
            source = File("/dev/null"),
            label = "test",
            heightRanges = ranges,
        )

    @Test fun heightRangeEqualityIsStructural() {
        val a = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        val b = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test fun heightRangeBoundsDifferenceBreaksEquality() {
        val a = HeightRange(0f, 5f)
        val b = HeightRange(0f, 5.0001f)
        assertNotEquals(a, b)
    }

    @Test fun heightRangeOverridesDifferenceBreaksEquality() {
        val a = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        val b = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "50"))
        assertNotEquals(a, b)
    }

    @Test fun emptyOverridesIsValid() {
        val r = HeightRange(0f, 5f)
        assertTrue(r.overrides.isEmpty())
        assertEquals(0f, r.zMinMm, 1e-6f)
        assertEquals(5f, r.zMaxMm, 1e-6f)
    }

    // ---- PlacedModel participation ----

    @Test fun placedModelEqualsTracksHeightRanges() {
        val r = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        val a = model(listOf(r))
        val b = model(listOf(r))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())

        val c = model(listOf(r.copy(zMaxMm = 10f)))
        assertNotEquals(a, c)
    }

    @Test fun placedModelDefaultRangesIsEmpty() {
        val m = PlacedModel(id = "m", source = File("/dev/null"), label = "t")
        assertTrue(m.heightRanges.isEmpty())
    }

    @Test fun copyPreservesUnrelatedFields() {
        val r = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        val a = model(listOf(r)).copy(rotZDeg = 90)
        assertEquals(1, a.heightRanges.size)
        assertEquals(90, a.rotZDeg)
    }

    // ---- Authoring shapes the exit criterion exercises ----

    @Test fun bottom5mmDenseInfillIsOneBand() {
        // The A12 exit criterion: a 0–5 mm band with sparse_infill_density=100
        // on a 20 mm cube should yield 100% density in layers 1–25 (assuming
        // 0.20 mm layer height) and the project default above. Pin the
        // authoring shape so a refactor doesn't change the public surface.
        val r = HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100"))
        val m = model(listOf(r))
        assertEquals(1, m.heightRanges.size)
        assertEquals(0f, m.heightRanges[0].zMinMm, 1e-6f)
        assertEquals(5f, m.heightRanges[0].zMaxMm, 1e-6f)
        assertEquals("100", m.heightRanges[0].overrides["sparse_infill_density"])
    }

    @Test fun overlappingBandsAreAllowedAtAuthoringTime() {
        // libslic3r resolves overlaps at process time (LayerRanges::assign,
        // PrintApply.cpp:342) by splitting at boundaries; the Kotlin side
        // doesn't reject overlaps so the user can layer "100% infill 0-10 mm"
        // + "200% wall in 5-7 mm magnet pocket region" on top of each other.
        val outer = HeightRange(0f, 10f, mapOf("sparse_infill_density" to "100"))
        val inner = HeightRange(5f, 7f, mapOf("wall_loops" to "5"))
        val m = model(listOf(outer, inner))
        assertEquals(2, m.heightRanges.size)
    }

    @Test fun degenerateBandSurvivesAuthoring() {
        // The authoring data class doesn't enforce zMin < zMax — that's
        // the JNI's job (degenerate bands are skipped server-side with a
        // log line). This pins the loose authoring contract so a future
        // tightening doesn't surprise callers.
        val r = HeightRange(5f, 5f)
        assertEquals(5f, r.zMinMm, 1e-6f)
        assertEquals(5f, r.zMaxMm, 1e-6f)
    }
}
