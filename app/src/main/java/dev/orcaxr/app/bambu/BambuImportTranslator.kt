package dev.orcaxr.app.bambu

import dev.orcaxr.app.SlicerEngine

/**
 * Bambu Studio → OrcaXR (Snapmaker U1) 3MF import translator.
 *
 * **Why this exists.** A Bambu Studio 3MF carries the same libslic3r
 * config-key namespace as an OrcaSlicer 3MF, but it embeds
 * Bambu-Lab-X1/P1S/A1 hardware values: a 256×256mm bed, Bambu Klipper
 * toolchange macros (`M620 S[next_extruder]`), Bambu-specific filament
 * tunings (PLA max volumetric speed 18-22 mm³/s vs U1's 12), etc. If
 * OrcaXR just forwarded the 3MF's `project_settings.config` keys into
 * `mergedConfig`, the user's U1 profile pick would be partially clobbered
 * by Bambu-specific values that don't match the U1 firmware / hotend /
 * filament path.
 *
 * **What this does.** Pure function. Given the raw project-overrides map
 * (already filtered to [SlicerEngine.PROJECT_OVERRIDE_KEYS] by the
 * extractor), a [SlicerEngine.Bambu3mfFingerprint], and the slot count
 * for the active printer:
 *
 *   1. Detects whether the 3MF is Bambu-authored. The
 *      [SlicerEngine.PROJECT_OVERRIDE_KEYS] allowlist already drops the
 *      worst Bambu hardware keys (machine_max_*, bed_shape,
 *      machine_start_gcode etc. aren't on the allowlist), so detection
 *      drives a *filament-side* stripping pass — see #2.
 *   2. Strips Bambu-specific filament tunings that ARE in the allowlist
 *      (filament_max_volumetric_speed, filament_flow_ratio,
 *      nozzle_temperature, pressure_advance, cooling-fan tunings)
 *      because those values came from Bambu's filament profile and
 *      shouldn't override the user's U1 filament profile. The user's
 *      profile pick provides the right values for the U1 hotend.
 *   3. Optionally emits a per-slot filament_settings_id remap so the
 *      4 project-filament slots land on the right U1 bundled profile
 *      (e.g. filament_type=PLA → "Snapmaker PLA SnapSpeed @U1"). The
 *      FilamentEntries store already exposes a settable filament-type
 *      per slot; the caller can apply the remap as a user-overridable
 *      suggestion rather than a force-apply.
 *
 * **What this DOESN'T do.** No machine-envelope rewrite, no g-code
 * macro translation, no per-volume Bambu-painting reinterpretation —
 * those are already handled correctly by OrcaXR's existing pipeline
 * because the dangerous keys live outside [SlicerEngine.PROJECT_OVERRIDE_KEYS]
 * and never reach the slice config in the first place. The translator
 * is therefore narrow on purpose: just a filament-tuning strip + a
 * suggestion banner.
 *
 * **License note.** The detection + remap rules below were derived
 * clean-room from the public DOC-U1-Link tool's (GPLv3) documented
 * key list. No source was copied; the lists themselves are
 * unprotectable factual catalogs of libslic3r config-key names. The
 * implementation strategy (strip + suggest rather than rewrite +
 * reinject templates) differs deliberately so the translator stays
 * within OrcaXR's existing data flow (no template 3MFs shipped, no
 * separate "import wizard" UI).
 */
object BambuImportTranslator {

    /**
     * Filament-tuning keys that DO appear in
     * [SlicerEngine.PROJECT_OVERRIDE_KEYS] (so they'd otherwise reach
     * the slicer) but should be dropped for a Bambu-authored 3MF
     * because their values reflect Bambu's filament profile, not the
     * U1's. Keep the *object* tunings (sparse_infill_density,
     * wall_loops, speeds, accelerations, jerks, etc.) — those are
     * about the model the user wants to print, not the printer they
     * want to print it on.
     */
    val BAMBU_FILAMENT_TUNING_STRIP: Set<String> = setOf(
        "filament_max_volumetric_speed",
        "filament_flow_ratio",
        "nozzle_temperature",
        "nozzle_temperature_initial_layer",
        "pressure_advance",
        "enable_pressure_advance",
        "slow_down_layer_time",
        "slow_down_min_speed",
        "fan_cooling_layer_time",
        "fan_min_speed",
        "fan_max_speed",
        "overhang_fan_speed",
        "overhang_fan_threshold",
    )

    /**
     * filament_type literal → U1 bundled filament profile id. Used
     * to populate the per-slot `filament_settings_id` suggestion so
     * the active printer's filament store can pick the right U1
     * filament when the user opens a Bambu 3MF. Fallback: "Generic PLA"
     * for anything unrecognized (logged so we can extend the table
     * later).
     *
     * Keys are upper-case so the lookup tolerates Bambu's
     * "Bambu PLA Basic" / "Bambu PETG-HF" / "Bambu ABS" labels (we
     * normalize the input before lookup). Values reference the
     * bundled-profile display names OrcaProfileLoader exposes —
     * eventually we may swap these to stable IDs, but display names
     * are what the FilamentEntries store currently keys off.
     */
    val FILAMENT_TYPE_TO_U1_PROFILE: Map<String, String> = mapOf(
        "PLA" to "Snapmaker PLA SnapSpeed @U1",
        "PLA+" to "Snapmaker PLA SnapSpeed @U1",
        "PLA-CF" to "Snapmaker PLA-CF",
        "PETG" to "Snapmaker PETG HF",
        "PETG-HF" to "Snapmaker PETG HF",
        "PETG-CF" to "Snapmaker PETG-CF",
        "ABS" to "Generic ABS",
        "ABS-GF" to "Generic ABS",
        "ASA" to "Snapmaker ASA U1",
        "ASA-CF" to "Snapmaker ASA U1",
        "TPU" to "Generic TPU",
        "TPU-95A" to "Generic TPU",
        "PC" to "Generic ABS",
        "PA" to "Generic ABS",
        "PA-CF" to "Generic ABS",
        "PVA" to "Generic PVA",
        "HIPS" to "Generic HIPS",
    )

    /** Outcome of a translation pass. The caller threads
     *  [translatedOverrides] into the existing `loadedProjectOverrides`
     *  state, surfaces [wasBambu] + [droppedKeys] in the import banner,
     *  and (optionally) applies [filamentProfileSuggestion] to the
     *  FilamentEntries store. */
    data class Result(
        /** Overrides ready to feed into mergedConfig. Identical to
         *  the input map for non-Bambu 3MFs. */
        val translatedOverrides: Map<String, String>,
        /** True when [BambuImportTranslator.detect] tripped on either
         *  printer_model or printer_settings_id. */
        val wasBambu: Boolean,
        /** Keys removed from the input map (Bambu-only). Surfaced in
         *  the banner so the user can see what got dropped. Empty for
         *  non-Bambu 3MFs. */
        val droppedKeys: List<String>,
        /** Per-slot (0-based) filament_settings_id suggestions. Empty
         *  for non-Bambu 3MFs or when no recognized filament_type was
         *  present in the 3MF fingerprint. */
        val filamentProfileSuggestion: List<String>,
        /** Human-readable summary suitable for an info banner. Empty
         *  for non-Bambu 3MFs. */
        val bannerText: String,
    )

    /** Heuristic detector. Returns true iff [fingerprint] looks like a
     *  Bambu Studio-authored 3MF. Conservative: an OrcaSlicer 3MF that
     *  happens to inherit a Bambu-named filament profile (e.g. via a
     *  user-imported preset) will NOT trip this — we require either a
     *  Bambu-shaped printer_model OR a `@BBL`/`@P1S`/`@A1`/`@X1`
     *  printer_settings_id, since only Bambu's own slicer authors
     *  those identity fields. */
    fun detect(fingerprint: SlicerEngine.Bambu3mfFingerprint): Boolean {
        val model = fingerprint.printerModel
        val settings = fingerprint.printerSettingsId
        if (model.isBlank() && settings.isBlank()) return false

        if (model.startsWith("Bambu Lab", ignoreCase = true)) return true
        // Bambu's bundled preset names always carry the model suffix.
        val bambuSettingsMarkers = listOf("@BBL", "@P1S", "@P1P", "@A1", "@A1M", "@A1 Mini", "@X1", "@X1C", "@X1E", "@H2D")
        return bambuSettingsMarkers.any { settings.contains(it, ignoreCase = true) }
    }

    /**
     * Run the translation pass. Pure function — no I/O. For non-Bambu
     * fingerprints, returns the input unchanged with `wasBambu=false`
     * and empty banner / dropped / suggestion lists, so callers can
     * unconditionally route every 3MF load through this.
     *
     * @param rawOverrides the project-overrides map as returned by
     *   [SlicerEngine.read3mfProjectOverrides]. Already filtered to
     *   keys OrcaXR knows about.
     * @param fingerprint identity probe from
     *   [SlicerEngine.read3mfBambuFingerprint].
     * @param slotCount how many project-filament slots the active
     *   printer exposes (4 on Snapmaker U1). Used to size the
     *   filament-profile suggestion list and pad/truncate the 3MF's
     *   filament_type vector.
     */
    fun translate(
        rawOverrides: Map<String, String>,
        fingerprint: SlicerEngine.Bambu3mfFingerprint,
        slotCount: Int,
    ): Result {
        if (!detect(fingerprint)) {
            return Result(
                translatedOverrides = rawOverrides,
                wasBambu = false,
                droppedKeys = emptyList(),
                filamentProfileSuggestion = emptyList(),
                bannerText = "",
            )
        }

        val dropped = mutableListOf<String>()
        val filtered = buildMap {
            for ((k, v) in rawOverrides) {
                if (k in BAMBU_FILAMENT_TUNING_STRIP) {
                    dropped += k
                    continue
                }
                put(k, v)
            }
        }
        dropped.sort()

        val suggestions = if (slotCount > 0 && fingerprint.filamentTypes.isNotEmpty()) {
            val padded = (0 until slotCount).map { i ->
                val rawType = fingerprint.filamentTypes.getOrNull(i).orEmpty()
                val normalized = normalizeFilamentType(rawType)
                FILAMENT_TYPE_TO_U1_PROFILE[normalized] ?: "Generic PLA"
            }
            padded
        } else {
            emptyList()
        }

        val modelHint = fingerprint.printerModel.takeIf { it.isNotBlank() }
            ?: fingerprint.printerSettingsId.takeIf { it.isNotBlank() }
            ?: "Bambu Studio"
        val banner = buildString {
            append("Imported as Bambu Studio 3MF (")
            append(modelHint)
            append(").")
            if (dropped.isNotEmpty()) {
                append(" Dropped ")
                append(dropped.size)
                append(" filament-tuning key")
                if (dropped.size != 1) append('s')
                append(" so the active U1 profile wins.")
            } else {
                append(" Using active U1 profile for machine + filament settings.")
            }
        }

        return Result(
            translatedOverrides = filtered,
            wasBambu = true,
            droppedKeys = dropped,
            filamentProfileSuggestion = suggestions,
            bannerText = banner,
        )
    }

    /** Strip Bambu's "Bambu " brand prefix and any trailing
     *  variant marker ("Basic", "Matte", etc.) so the lookup key
     *  matches a base filament_type. */
    internal fun normalizeFilamentType(raw: String): String {
        if (raw.isBlank()) return ""
        var s = raw.trim().trim('"').uppercase()
        // Strip the "Bambu " brand prefix Bambu Studio stamps into
        // filament_type for its own filaments (e.g. "BAMBU PLA BASIC").
        if (s.startsWith("BAMBU ")) s = s.removePrefix("BAMBU ").trim()
        // Strip trailing finish-marker words so "PLA BASIC" / "PLA MATTE"
        // both fold to "PLA".
        val finishMarkers = listOf(
            " BASIC", " MATTE", " SILK", " METAL", " WOOD", " SPARKLE",
            " GLOW", " TOUGH", " AERO", " ECO", " PRO", " HIGH SPEED",
        )
        for (marker in finishMarkers) {
            if (s.endsWith(marker)) {
                s = s.removeSuffix(marker).trim()
                break
            }
        }
        return s
    }
}
