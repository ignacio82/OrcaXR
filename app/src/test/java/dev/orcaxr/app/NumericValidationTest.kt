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
}
