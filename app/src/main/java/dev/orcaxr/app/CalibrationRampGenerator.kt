package dev.orcaxr.app

/**
 * Roadmap B12 — generate a list of [SlicerEngine.CustomGcodeTick]s
 * that ramp a single tunable parameter across a calibration print's
 * Z bands.
 *
 * **What this is for:** the user prints one of the bundled
 * calibration meshes (PA tower, temperature tower, retraction tower,
 * VFA, …) once with a per-Z ramp — say "PA from 0.02 to 0.06 in
 * steps of 0.005, holding each value for 10 layers" — visually picks
 * the band that printed best, and applies that value to the active
 * filament's profile via `set_user_preference` / `save_as_profile`.
 *
 * **What this is NOT for:** the calibration meshes themselves ship
 * via [HandyModelCatalog]. This file only produces the per-Z
 * G-code ticks that ride on top of the loaded mesh; the user calls
 * `add_handy_model("calib_pa_tower")` then `generate_calibration_
 * ramp("pressure_advance", …)` to assemble both halves.
 *
 * Pure Kotlin, no JNI, no I/O — every output is a list of
 * [SlicerEngine.CustomGcodeTick] that the existing A11 plumbing
 * (Add / Remove / List custom-gcode-tick MCP tools, the
 * `nativeSlice.customGcode*` parallel arrays) routes into the gcode
 * unchanged. One band = one Template tick at the Z where the band
 * begins, with the matching M-command in the `extra` field.
 */
object CalibrationRampGenerator {

    /** Calibration kinds we know how to ramp. Each maps to a single
     *  M-command emitted at the start of every band. */
    enum class Kind(val displayName: String) {
        PressureAdvance("Pressure Advance"),
        Temperature("Nozzle temperature"),
        Retraction("Retraction length"),
        VolumetricFlow("Max volumetric flow"),
        Speed("Print speed"),
    }

    /** Inputs to [generate]. Defaults are tuned for the U1's typical
     *  calibration sweep so a one-line `generate(kind=Temperature)`
     *  produces a usable tower. */
    data class Params(
        val kind: Kind,
        /** First band's value. Range and unit depend on [kind]
         *  (PA = mm/s², Temperature = °C, Retraction = mm, etc.). */
        val start: Float,
        val end: Float,
        val step: Float,
        /** Layers per band — controls the printed band height
         *  (`layersPerBand * layerHeightMm`). 10 at 0.2 mm = 2 mm
         *  bands which is the OrcaSlicer default. */
        val layersPerBand: Int,
        /** Active profile's layer height in mm. Same number that
         *  flows into `nativeSlice` via `mergedConfig`. */
        val layerHeightMm: Float,
        /** Z height (mm) at which the first band begins. The ramp
         *  skips the bottom of the tower so the first band's command
         *  doesn't fire mid-skirt. Default 0.4 mm (≈ first 2 layers
         *  of a 0.2 mm slice). */
        val firstBandZmm: Float = 0.4f,
    ) {
        init {
            require(step != 0f) { "step must be non-zero." }
            require(layersPerBand >= 1) { "layersPerBand must be >= 1." }
            require(layerHeightMm > 0f) { "layerHeightMm must be > 0." }
        }
    }

    /**
     * Generate the per-band ticks for the given [params]. Returns
     * an empty list when the start/end/step combination produces
     * zero bands.
     *
     * Each emitted tick is `kind = Template`, `extra = M-command`,
     * and `printZmm = bandStartZ`. libslic3r's
     * `before_layer_change_gcode` hook fires the Template body at
     * the matching layer; values are inclusive of `start` and step
     * monotonically toward `end`.
     */
    fun generate(params: Params): List<SlicerEngine.CustomGcodeTick> {
        val bandHeightMm = params.layersPerBand * params.layerHeightMm
        val direction = if (params.end >= params.start) 1f else -1f
        val absStep = kotlin.math.abs(params.step)
        val span = kotlin.math.abs(params.end - params.start)
        // ceil(span/step) + 1 — we always emit a band at `start` AND
        // a band at `end`, even when `step` doesn't divide `span`
        // cleanly. The non-aligned final band has its value clamped
        // to `end` so the printer ends the ramp at the user-asked-
        // for ceiling, not one step short.
        val bandCount = kotlin.math.ceil(span / absStep).toInt() + 1
        if (bandCount <= 0) return emptyList()

        val ticks = ArrayList<SlicerEngine.CustomGcodeTick>(bandCount)
        var lastEmittedClamped = Float.NaN
        for (i in 0 until bandCount) {
            val value = params.start + direction * i * absStep
            // Clamp to prevent floating-drift overshoot when the
            // start/end/step ratio doesn't divide cleanly.
            val clamped = if (direction > 0f) kotlin.math.min(value, params.end)
            else kotlin.math.max(value, params.end)
            // De-dup the final clamped band — when step divides span
            // cleanly, the loop's natural end already lands on `end`
            // and we don't want a duplicate tick.
            if (!lastEmittedClamped.isNaN() &&
                kotlin.math.abs(lastEmittedClamped - clamped) < 1e-4f
            ) break
            val z = params.firstBandZmm + i * bandHeightMm
            ticks += SlicerEngine.CustomGcodeTick(
                printZmm = z,
                kind = SlicerEngine.CustomGcodeKind.Template,
                extruder = 0,
                color = "",
                extra = bandGcode(params.kind, clamped),
            )
            lastEmittedClamped = clamped
            if (kotlin.math.abs(clamped - params.end) < 1e-4f) break
        }
        return ticks
    }

    /** Render the M-command that sets [kind] to [value]. Comments are
     *  appended so a user reading the gcode in a hex editor can see
     *  which band they're looking at. */
    fun bandGcode(kind: Kind, value: Float): String = when (kind) {
        Kind.PressureAdvance ->
            // Klipper firmware on the U1 + Centauri Carbon honors
            // SET_PRESSURE_ADVANCE; Marlin firmware uses M572. Emit
            // both so the gcode is firmware-agnostic — the unused
            // command is a no-op on its respective firmware.
            "SET_PRESSURE_ADVANCE ADVANCE=%.4f\nM572 S%.4f ; PA band".format(value, value)
        Kind.Temperature ->
            "M104 S${value.toInt()} ; temp band"
        Kind.Retraction ->
            "; retraction band: %.2f mm — Klipper users adjust via SET_RETRACTION".format(value) +
                "\nSET_RETRACTION RETRACT_LENGTH=%.2f".format(value)
        Kind.VolumetricFlow ->
            "M221 S%.0f ; volumetric flow band — caps at extruder max".format((value * 100).coerceAtLeast(1f))
        Kind.Speed ->
            "M220 S%.0f ; speed band".format(value.coerceAtLeast(1f))
    }
}
