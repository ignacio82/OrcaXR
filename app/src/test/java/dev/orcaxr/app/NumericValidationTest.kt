package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NumericValidationTest {

    @Test fun parses_plain_integer() {
        val out = NumericValidation.validate("42", -100f, 100f)
        assertEquals(NumericValidation.Result.Ok(42f), out)
    }

    @Test fun trims_whitespace() {
        val out = NumericValidation.validate("  3.14  ", -10f, 10f)
        assertEquals(NumericValidation.Result.Ok(3.14f), out)
    }

    @Test fun rejects_blank() {
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("", -1f, 1f))
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("  ", -1f, 1f))
    }

    @Test fun rejects_non_numeric() {
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("abc", -1f, 1f))
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("3.14abc", -1f, 1f))
    }

    @Test fun rejects_nan_and_infinity() {
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("NaN", -1f, 1f))
        assertEquals(NumericValidation.Result.NotANumber, NumericValidation.validate("Infinity", -1f, 1f))
    }

    @Test fun out_of_range_low() {
        val out = NumericValidation.validate("-50", -10f, 10f)
        assertTrue(out is NumericValidation.Result.OutOfRange)
        out as NumericValidation.Result.OutOfRange
        assertEquals(-50f, out.value, 1e-6f)
        assertEquals(-10f, out.min, 1e-6f)
        assertEquals(10f, out.max, 1e-6f)
    }

    @Test fun out_of_range_high() {
        val out = NumericValidation.validate("50", -10f, 10f)
        assertTrue(out is NumericValidation.Result.OutOfRange)
    }

    @Test fun inclusive_bounds() {
        assertEquals(NumericValidation.Result.Ok(-10f), NumericValidation.validate("-10", -10f, 10f))
        assertEquals(NumericValidation.Result.Ok(10f), NumericValidation.validate("10", -10f, 10f))
    }

    @Test fun transform_ranges_are_sensible() {
        // A few sanity checks so the curated defaults don't drift to
        // bogus values silently.
        assertEquals(-500f, NumericValidation.Ranges.translateMm.start, 1e-6f)
        assertEquals(500f, NumericValidation.Ranges.translateMm.endInclusive, 1e-6f)
        assertEquals(1f, NumericValidation.Ranges.scalePct.start, 1e-6f)
        assertEquals(2000f, NumericValidation.Ranges.scalePct.endInclusive, 1e-6f)
        // Rotate accepts multi-turn typing.
        assertEquals(-1080f, NumericValidation.Ranges.rotateDeg.start, 1e-6f)
    }

    @Test fun print_setting_ranges_cover_expected_keys() {
        // The Speed-tab keys all need ranges or the per-key gate
        // silently degrades to "anything parseable goes".
        val speedKeys = listOf(
            "initial_layer_speed",
            "outer_wall_speed",
            "inner_wall_speed",
            "sparse_infill_speed",
            "internal_solid_infill_speed",
            "support_speed",
            "travel_speed",
        )
        for (k in speedKeys) {
            assertTrue("missing range for $k", k in NumericValidation.printSettingRanges)
        }
        // Layer-height range catches the most common typo (decimal
        // shifted: 2.0 mm intended → 20 mm typed).
        val lh = NumericValidation.printSettingRanges["layer_height"]!!
        assertTrue(20f > lh.endInclusive)
        assertTrue(0.04f >= lh.start)
        // Sparse infill density caps at 100%.
        val infill = NumericValidation.printSettingRanges["sparse_infill_density"]!!
        assertEquals(0f, infill.start, 1e-6f)
        assertEquals(100f, infill.endInclusive, 1e-6f)
    }

    @Test fun print_setting_ranges_validate_correctly() {
        val r = NumericValidation.printSettingRanges["layer_height"]!!
        assertTrue(NumericValidation.validate("0.2", r.start, r.endInclusive)
            is NumericValidation.Result.Ok)
        assertTrue(NumericValidation.validate("20", r.start, r.endInclusive)
            is NumericValidation.Result.OutOfRange)
        assertTrue(NumericValidation.validate("0.0", r.start, r.endInclusive)
            is NumericValidation.Result.OutOfRange)
    }
}
