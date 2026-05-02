package dev.orcaxr.app

/**
 * A named bundle of libslic3r config key→value overrides. Applied on
 * top of `DynamicPrintConfig::full_print_config()` defaults inside the
 * native shim.
 *
 * Phase 2 ships a small built-in catalog (PLA / PETG / ABS at a few
 * quality tiers); Phase 3 adds DataStore-backed user profiles + the
 * FullSpectrum mixed-color model. Keys are libslic3r's canonical
 * names (snake_case) — see `src/libslic3r/PrintConfig.cpp` for the
 * authoritative list. set_deserialize_nothrow handles parsing the
 * string values into the right types.
 */
data class SlicerProfile(
    val id: String,
    val displayName: String,
    val description: String,
    val config: Map<String, String>,
    /**
     * Original OrcaSlicer machine-profile leaf name this row was
     * composed from (e.g. "Snapmaker U1 (0.4 nozzle)", "Elegoo Centauri
     * Carbon (0.4 nozzle)"). null for user-saved profiles, which carry
     * no upstream provenance — the dropdown filter treats `null` as
     * "compatible with any printer" so user picks always show up.
     * Populated by [OrcaProfileLoader.compose].
     */
    val machineName: String? = null,
    /**
     * Original process-leaf name (e.g. "0.20 Standard @Snapmaker U1
     * (0.4 nozzle)"). null for user-saved profiles. Currently
     * informational; the dropdown filter doesn't gate on this field.
     */
    val processName: String? = null,
    /**
     * Original filament-leaf name (e.g. "Generic PLA", "Elegoo PLA
     * Matte"). The dropdown filter substring-matches this against the
     * project's single dominant material family ("PLA", "PETG", …) when
     * deciding whether to show the row. null for user-saved profiles —
     * those always pass the filament gate.
     */
    val filamentName: String? = null,
)

object Profiles {

    /** Layer height + perimeter / infill counts the Quality tier varies. */
    private fun base(quality: Quality): Map<String, String> = when (quality) {
        Quality.Draft -> mapOf(
            "layer_height" to "0.28",
            "initial_layer_print_height" to "0.28",
            "wall_loops" to "2",
            "sparse_infill_density" to "10%",
            "top_shell_layers" to "3",
            "bottom_shell_layers" to "3",
        )
        Quality.Standard -> mapOf(
            "layer_height" to "0.20",
            "initial_layer_print_height" to "0.20",
            "wall_loops" to "3",
            "sparse_infill_density" to "15%",
            "top_shell_layers" to "4",
            "bottom_shell_layers" to "3",
        )
        Quality.Detail -> mapOf(
            "layer_height" to "0.12",
            "initial_layer_print_height" to "0.20",
            "wall_loops" to "3",
            "sparse_infill_density" to "20%",
            "top_shell_layers" to "5",
            "bottom_shell_layers" to "4",
        )
    }

    private enum class Quality { Draft, Standard, Detail }

    /** Filament-specific temps. Generic safe defaults — not vendor-tuned. */
    private fun filament(name: String, nozzle: Int, bed: Int, fan: Int = 100): Map<String, String> = mapOf(
        "nozzle_temperature" to "$nozzle",
        "nozzle_temperature_initial_layer" to "${nozzle + 5}",
        "hot_plate_temp" to "$bed",
        "hot_plate_temp_initial_layer" to "$bed",
        "fan_max_speed" to "$fan",
    ).also {
        // tag with filament name as a comment-only field — useful in
        // logs / G-code header. (Not a real config key but harmless;
        // set_deserialize_nothrow will skip unknown ones.)
        @Suppress("UNUSED_VARIABLE") val _name = name
    }

    /**
     * Elegoo Centauri Carbon — also Klipper, 256×256×256 bed, 0.4 nozzle.
     * No vendor-specific OrcaSlicer profile shipped upstream yet (Elegoo
     * keeps theirs internal), so this is a sensible-defaults entry built
     * from the Centauri Carbon spec sheet + standard PLA values. Refine
     * once the user's actual prints surface tuning data.
     */
    val Centauri_Carbon_PLA_Standard = SlicerProfile(
        id = "centauri_carbon_0.4_pla_standard",
        displayName = "Elegoo Centauri Carbon · 0.4 · PLA",
        description = "0.20 mm layers, 15% infill, 215 °C / 60 °C, 256×256 bed",
        config = filament("PLA", nozzle = 215, bed = 60) + base(Quality.Standard) + mapOf(
            "printable_height" to "256",
            "nozzle_diameter" to "0.4",
            "gcode_flavor" to "klipper",
            "filament_type" to "PLA",
            "filament_diameter" to "1.75",
            "filament_density" to "1.24",
            "outer_wall_speed" to "200",
            "inner_wall_speed" to "300",
            "travel_speed" to "500",
            "default_acceleration" to "8000",
        ),
    )

    /**
     * Hand-rolled catalog. Empty now that both Snapmaker U1 AND
     * Elegoo Centauri Carbon (0.2 + 0.4 nozzles) have full bundled
     * JSON profiles under `app/src/main/assets/profiles/{Snapmaker,
     * Elegoo}/` — picked up at startup by [OrcaProfileLoader].
     *
     * `Centauri_Carbon_PLA_Standard` is kept ONLY as a last-ditch
     * `default` fallback for the case where asset loading fails
     * entirely (corrupted APK, etc.) so the slice button still has
     * something to point at. It is intentionally NOT in this list,
     * so the FlatShell ProfilePicker doesn't surface a duplicate
     * next to the loader-generated rows.
     */
    val all: List<SlicerProfile> = emptyList()

    val default: SlicerProfile = Centauri_Carbon_PLA_Standard
}
