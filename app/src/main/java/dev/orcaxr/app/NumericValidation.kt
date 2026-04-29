package dev.orcaxr.app

/**
 * Roadmap B8 — numeric input validation primitives.
 *
 * Pure functions so the validation rules are unit-testable without a
 * Compose runtime. The TextField composable layer (`AxisFieldRow` and
 * the print-settings tabs) consumes the [Result] to drive its
 * `isError` flag and a one-shot Toast.
 *
 * Today the slicer's TextField inputs silently clamp at the libslic3r
 * boundary — a user typing `scale = 0` got no feedback even though the
 * effective value snapped back to a positive minimum, and a `translate
 * = 1e9 mm` turned the project into NaN-land without any UI hint. The
 * validation helper surfaces both shapes:
 *  - Parse failure (non-numeric / blank) → [Result.NotANumber]
 *  - Out-of-range (parsed but extreme) → [Result.OutOfRange]
 */
object NumericValidation {
    sealed interface Result {
        data class Ok(val value: Float) : Result
        data object NotANumber : Result
        data class OutOfRange(val value: Float, val min: Float, val max: Float) : Result
    }

    /**
     * Parse [text] as a Float and verify it falls in `[min, max]`. The
     * range is inclusive on both ends so `min == max` yields a single
     * legal value (rare but useful for keyed sentinels).
     */
    fun validate(text: String, min: Float, max: Float): Result {
        val parsed = text.trim().toFloatOrNull() ?: return Result.NotANumber
        if (parsed.isNaN() || parsed.isInfinite()) return Result.NotANumber
        if (parsed < min || parsed > max) return Result.OutOfRange(parsed, min, max)
        return Result.Ok(parsed)
    }

    /**
     * Built-in ranges for the TransformPanel axes. Picked to be wide
     * enough that no realistic edit hits them, narrow enough that
     * accidental keystrokes (e.g. typing the printer model number into
     * the rotate field) reliably fail. Translate and rotate accept
     * negatives; scale must stay positive (a 0% scale collapses the
     * mesh to a point and bricks the slicer).
     */
    object Ranges {
        /** mm. Bed centroid + a generous slop so a user repositioning
         *  a 250 mm-wide slab on a 270 mm bed can still translate
         *  ±400 mm without tripping the validator. */
        val translateMm: ClosedFloatingPointRange<Float> = -500f..500f

        /** Degrees. Rotation wraps modulo 360 internally, but a UI
         *  range that allows multi-turn typing (e.g. 720°) is fine —
         *  only catastrophic typos trip the validator. */
        val rotateDeg: ClosedFloatingPointRange<Float> = -1080f..1080f

        /** Percent. 1% to 2000% — 0% is geometrically nonsensical
         *  (mesh collapses) and the libslic3r boundary clamps to a
         *  positive minimum silently otherwise. */
        val scalePct: ClosedFloatingPointRange<Float> = 1f..2000f
    }
}
