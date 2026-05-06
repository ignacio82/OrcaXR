package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap B12 — pin the per-Z ramp generator's band layout, value
 * sequence, and per-kind G-code body shapes.
 */
class CalibrationRampGeneratorTest {

    @Test fun `pa tower 0_02 to 0_06 step 0_005 produces 9 bands`() {
        val ticks = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.PressureAdvance,
                start = 0.02f,
                end = 0.06f,
                step = 0.005f,
                layersPerBand = 10,
                layerHeightMm = 0.2f,
            ),
        )
        assertEquals(9, ticks.size)
        // First band at firstBandZmm (0.4); bands are 10*0.2 = 2 mm tall.
        assertEquals(0.4f, ticks[0].printZmm, 1e-4f)
        assertEquals(0.4f + 8 * 2f, ticks.last().printZmm, 1e-4f)
        // First band's body sets PA = 0.02, last sets PA = 0.06.
        assertTrue(
            "expected ADVANCE=0.0200 in body ${ticks[0].extra}",
            ticks[0].extra.contains("ADVANCE=0.0200"),
        )
        assertTrue(
            "expected ADVANCE=0.0600 in body ${ticks.last().extra}",
            ticks.last().extra.contains("ADVANCE=0.0600"),
        )
        // Every tick is Template kind so libslic3r emits the body verbatim.
        for (t in ticks) {
            assertEquals(SlicerEngine.CustomGcodeKind.Template, t.kind)
        }
    }

    @Test fun `temperature tower 180 to 240 step 5 produces M104 commands`() {
        val ticks = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 180f,
                end = 240f,
                step = 5f,
                layersPerBand = 10,
                layerHeightMm = 0.2f,
            ),
        )
        assertEquals(13, ticks.size) // 180, 185, ..., 240
        assertTrue(ticks[0].extra.startsWith("M104 S180"))
        assertTrue(ticks.last().extra.startsWith("M104 S240"))
    }

    @Test fun `negative direction (cooling tower) ramps down`() {
        val ticks = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 230f,
                end = 200f,
                step = 5f,
                layersPerBand = 5,
                layerHeightMm = 0.2f,
            ),
        )
        assertEquals(7, ticks.size) // 230, 225, ..., 200
        assertTrue(ticks[0].extra.startsWith("M104 S230"))
        assertTrue(ticks.last().extra.startsWith("M104 S200"))
        // Z spacing: 5 layers × 0.2 mm = 1 mm bands.
        assertEquals(0.4f, ticks[0].printZmm, 1e-4f)
        assertEquals(0.4f + 1f, ticks[1].printZmm, 1e-4f)
    }

    @Test fun `step direction is inferred — sign of step is ignored`() {
        // Even if the user passes a positive step but start > end,
        // the generator still ramps DOWN. The direction flag is
        // derived from sign(end - start), not sign(step). Symmetric
        // helper; saves the user from a "wrong sign" footgun.
        val a = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 230f, end = 200f, step = 10f,
                layersPerBand = 1, layerHeightMm = 0.2f,
            ),
        )
        val b = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 230f, end = 200f, step = -10f,
                layersPerBand = 1, layerHeightMm = 0.2f,
            ),
        )
        assertEquals(a.size, b.size)
        for (i in a.indices) {
            assertEquals(a[i].extra, b[i].extra)
        }
    }

    @Test fun `band z spacing scales with layers-per-band and layer height`() {
        val short = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Speed,
                start = 50f, end = 100f, step = 25f,
                layersPerBand = 5, layerHeightMm = 0.12f,
            ),
        )
        val tall = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Speed,
                start = 50f, end = 100f, step = 25f,
                layersPerBand = 20, layerHeightMm = 0.20f,
            ),
        )
        // 3 bands each (50, 75, 100).
        assertEquals(3, short.size)
        assertEquals(3, tall.size)
        assertEquals(0.6f, short[1].printZmm - short[0].printZmm, 1e-4f) // 5 × 0.12
        assertEquals(4.0f, tall[1].printZmm - tall[0].printZmm, 1e-4f)   // 20 × 0.20
    }

    @Test fun `band gcode helpers cover every Kind`() {
        // Tripwire — if a new Kind enum value lands without a body
        // helper, this test surfaces it. `bandGcode` is exhaustive in
        // an enum-driven `when` so the Kotlin compiler actually
        // catches missing arms; this test is the runtime backstop.
        for (k in CalibrationRampGenerator.Kind.entries) {
            val body = CalibrationRampGenerator.bandGcode(k, 1f)
            assertTrue("body for $k should be non-blank, got '$body'", body.isNotBlank())
        }
    }

    @Test fun `non-divisible step still terminates at end`() {
        // Start=0.0, end=0.07, step=0.02 → bands at 0.00, 0.02, 0.04,
        // 0.06 — overshoot to 0.08 would clamp to 0.07 in the last
        // band. We don't emit the clamped 0.07 because the loop sees
        // 0.06 < 0.07 and continues; (0.06 + 0.02) > 0.07 → produced
        // in the next iteration with the clamp + early break.
        val ticks = CalibrationRampGenerator.generate(
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.PressureAdvance,
                start = 0f, end = 0.07f, step = 0.02f,
                layersPerBand = 1, layerHeightMm = 0.2f,
            ),
        )
        // 0.00 0.02 0.04 0.06 0.07 (clamp) — 5 bands.
        assertEquals(5, ticks.size)
        assertTrue(ticks.last().extra.contains("ADVANCE=0.0700"))
    }

    @Test fun `init-block rejects invalid params`() {
        // step=0 → infinite loop guard.
        try {
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 200f, end = 230f, step = 0f,
                layersPerBand = 5, layerHeightMm = 0.2f,
            )
            error("Expected IllegalArgumentException for step=0")
        } catch (_: IllegalArgumentException) { /* ok */ }
        // layersPerBand < 1 → division-by-zero risk downstream.
        try {
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 200f, end = 230f, step = 5f,
                layersPerBand = 0, layerHeightMm = 0.2f,
            )
            error("Expected IllegalArgumentException for layersPerBand=0")
        } catch (_: IllegalArgumentException) { /* ok */ }
        // layerHeight <= 0 → bad slice.
        try {
            CalibrationRampGenerator.Params(
                kind = CalibrationRampGenerator.Kind.Temperature,
                start = 200f, end = 230f, step = 5f,
                layersPerBand = 5, layerHeightMm = 0f,
            )
            error("Expected IllegalArgumentException for layerHeight=0")
        } catch (_: IllegalArgumentException) { /* ok */ }
    }
}
