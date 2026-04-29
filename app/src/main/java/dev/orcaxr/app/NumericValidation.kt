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

    /**
     * Allowed ranges for libslic3r config keys exposed in the Print
     * Settings tabs. Bounds were picked to:
     *   1. Reject obvious typos (negative speeds, 9999% infill density,
     *      a layer height of 100 mm) without
     *   2. Trapping the user inside artificially-narrow profile-tuned
     *      windows (no `outer_wall_speed` ceiling at 200 mm/s when
     *      Voron / Rapido nozzles are happy at 600).
     *
     * Keys not present here pass through validation as "any parseable
     * number is acceptable" — same behavior the legacy [SettingNumericEditor]
     * had before B8. New keys can be added incrementally without
     * touching the call sites.
     */
    val printSettingRanges: Map<String, ClosedFloatingPointRange<Float>> = mapOf(
        // ---- layer / shell geometry ----
        "layer_height" to 0.04f..1.5f,
        "initial_layer_print_height" to 0.04f..1.5f,
        "first_layer_height" to 0.04f..1.5f,
        "wall_loops" to 0f..50f,
        "top_shell_layers" to 0f..50f,
        "bottom_shell_layers" to 0f..50f,
        "top_shell_thickness" to 0f..20f,
        "bottom_shell_thickness" to 0f..20f,
        // ---- infill ----
        "sparse_infill_density" to 0f..100f,
        // ---- speeds (mm/s) ----
        "initial_layer_speed" to 0.1f..1000f,
        "outer_wall_speed" to 0.1f..1000f,
        "inner_wall_speed" to 0.1f..1000f,
        "sparse_infill_speed" to 0.1f..1000f,
        "internal_solid_infill_speed" to 0.1f..1000f,
        "top_surface_speed" to 0.1f..1000f,
        "support_speed" to 0.1f..1000f,
        "support_interface_speed" to 0.1f..1000f,
        "travel_speed" to 0.1f..1000f,
        "bridge_speed" to 0.1f..1000f,
        "internal_bridge_speed" to 0.1f..1000f,
        "gap_infill_speed" to 0.1f..1000f,
        "wipe_speed" to 0.1f..1000f,
        // ---- supports ----
        "support_threshold_angle" to 0f..90f,
        "support_top_z_distance" to 0f..2f,
        "support_bottom_z_distance" to 0f..2f,
        "support_object_xy_distance" to 0f..10f,
        "support_interface_top_layers" to 0f..50f,
        "support_interface_bottom_layers" to 0f..50f,
        "support_interface_spacing" to 0f..20f,
        // ---- temperatures (°C) ----
        "nozzle_temperature" to 100f..400f,
        "nozzle_temperature_initial_layer" to 100f..400f,
        "nozzle_temperature_range_low" to 100f..400f,
        "nozzle_temperature_range_high" to 100f..400f,
        // ---- nozzle / filament ----
        "nozzle_diameter" to 0.1f..2.0f,
        "filament_diameter" to 1.0f..3.5f,
        "filament_flow_ratio" to 0.5f..1.5f,
        "filament_max_volumetric_speed" to 0f..50f,
    )
}
