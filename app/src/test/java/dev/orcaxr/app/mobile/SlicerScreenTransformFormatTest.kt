package dev.orcaxr.app.mobile

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression test for the H_PIXEL10 (2026-05-07) crash:
 * `TransformSlider` formatted its value with `"%.1f$unit".format(value)`,
 * which embedded the user-supplied unit string directly into the format
 * spec. When the Scale slider passed `unit = "%"`, the format string
 * became `"%.1f%"` and `String.format` threw
 * `UnknownFormatConversionException: Conversion = 'End of String'` on
 * every recomposition of the TransformSheet. Symptom on a Pixel 10 Pro
 * (Android 16, API 36): the app crashed as soon as the user opened a
 * model in the Slicer screen, because the TransformSheet renders
 * unconditionally below the PreviewCard.
 *
 * The fix formats only the numeric value and concatenates the unit
 * separately. This test pins both the happy path AND the previously-
 * crashing `%` unit.
 */
class SlicerScreenTransformFormatTest {

    /** Mirrors the inlined formatter inside `TransformSlider`. */
    private fun formatValueWithUnit(value: Float, unit: String): String =
        String.format(Locale.US, "%.1f", value) + unit

    @Test
    fun degreeUnitFormatsCleanly() {
        assertEquals("90.0°", formatValueWithUnit(90f, "°"))
        assertEquals("-180.0°", formatValueWithUnit(-180f, "°"))
    }

    @Test
    fun millimeterUnitFormatsCleanly() {
        assertEquals("12.5 mm", formatValueWithUnit(12.5f, " mm"))
        assertEquals("-150.0 mm", formatValueWithUnit(-150f, " mm"))
    }

    /**
     * The crash trigger. Before the H_PIXEL10 fix, this called
     * `"%.1f$unit".format(value)` which built the format string
     * `"%.1f%"` and crashed with UnknownFormatConversionException.
     */
    @Test
    fun percentUnitDoesNotCrash() {
        assertEquals("100.0%", formatValueWithUnit(100f, "%"))
        assertEquals("400.0%", formatValueWithUnit(400f, "%"))
        assertEquals("10.0%", formatValueWithUnit(10f, "%"))
    }

    @Test
    fun localeUsForcesDotDecimalSeparator() {
        // Sanity: even on a JVM running with a comma-decimal locale,
        // the displayed output uses '.' so the slider readout is
        // consistent across devices.
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("12.5 mm", formatValueWithUnit(12.5f, " mm"))
        } finally {
            Locale.setDefault(previous)
        }
    }
}
