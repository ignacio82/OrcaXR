package dev.orcaxr.app

import android.content.Context
import org.json.JSONObject

/**
 * Snapmaker fork's filament-vs-bed-vs-nozzle compatibility rules,
 * ported to a Kotlin pre-flight check. Mirrors the C++
 * FilamentHotBedNozzleRules engine in `Snapmaker/OrcaSlicer` but
 * runs entirely in the Compose shell — there's no libslic3r-side
 * Print::validate() integration in OrcaXR yet, so the guard is at
 * UI time instead of slice time.
 *
 * The bundled JSON (assets/profiles/Snapmaker/filament/filament_
 * hot_bed_nozzles.json) is byte-identical to the fork's. Today it
 * declares two bed types:
 *  - `btPEI`: supports PLA, warns on TPU.
 *  - `btGESP`: supports PLA + TPU.
 * Anything else on PEI is treated as unsupported (Forbidden tier).
 *
 * Substring-match semantics match the fork's `contains_token_ci`:
 * "PLA-CF", "PLA Silk", "PLA Matte" all match PLA's support list;
 * "TPU 95A HF" matches TPU's warning list. Future Snapmaker JSON
 * updates that add nozzle bands ("0.4mm" keys) are parsed but not
 * surfaced — the rules class skips them, and the C++ port can take
 * over the nozzle-band path when/if we wire libslic3r's
 * Print::validate hook in a follow-up phase.
 */
object FilamentRules {

    sealed interface Result {
        /** No applicable rule found, or filament is in the support list. */
        object Ok : Result
        /** Filament is allowed but flagged for caution (e.g. TPU on PEI). */
        data class Warning(val message: String) : Result
        /** Filament is not supported on this bed and slicing should be blocked. */
        data class Forbidden(val message: String) : Result
    }

    data class Rules(
        val supportByBed: Map<String, Set<String>>,
        val warningByBed: Map<String, Set<String>>,
    ) {
        companion object {
            val EMPTY = Rules(emptyMap(), emptyMap())
        }
    }

    private const val ASSET_PATH =
        "profiles/Snapmaker/filament/filament_hot_bed_nozzles.json"

    /**
     * Open the bundled rules JSON from assets and parse it. Failures
     * (asset missing, invalid JSON) collapse to [Rules.EMPTY] — a
     * malformed asset must never block slicing.
     */
    fun loadFromAssets(ctx: Context): Rules =
        runCatching {
            val text = ctx.assets.open(ASSET_PATH)
                .bufferedReader()
                .use(java.io.BufferedReader::readText)
            parse(text)
        }.getOrElse { Rules.EMPTY }

    /**
     * Parse the rules JSON. Tokens are uppercased so the substring match
     * downstream is case-insensitive without per-call lowercasing.
     */
    fun parse(text: String): Rules {
        val root = JSONObject(text)
        val support = mutableMapOf<String, Set<String>>()
        val warning = mutableMapOf<String, Set<String>>()
        val keys = root.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            // Nozzle bands (keys ending in "mm") describe per-nozzle-
            // diameter rules and require preset-name resolution to fire.
            // The shipped JSON has none today; skip them so a future
            // update doesn't surprise the bed-rule path.
            if (key.endsWith("mm", ignoreCase = true)) continue
            val obj = root.optJSONObject(key) ?: continue
            obj.optJSONArray("support")?.let { arr ->
                val set = mutableSetOf<String>()
                for (i in 0 until arr.length()) {
                    val v = arr.optString(i, "").trim().uppercase()
                    if (v.isNotEmpty()) set += v
                }
                if (set.isNotEmpty()) support[key] = set
            }
            obj.optJSONArray("warning")?.let { arr ->
                val set = mutableSetOf<String>()
                for (i in 0 until arr.length()) {
                    val v = arr.optString(i, "").trim().uppercase()
                    if (v.isNotEmpty()) set += v
                }
                if (set.isNotEmpty()) warning[key] = set
            }
        }
        return Rules(support, warning)
    }

    /**
     * Convert libslic3r's BedType display string (the value of
     * `curr_bed_type`) to the rule key used in the JSON. Returns null
     * for any plate the rules don't enumerate — caller treats null as
     * "no rule for this bed → no opinion".
     *
     * The OrcaXR code path forces `curr_bed_type = "Textured PEI Plate"`
     * (mergedConfig in MainActivity) because the U1 ships with one. The
     * rest of the mapping is forward-compat for future plate variants.
     */
    fun bedKeyFor(currBedType: String?): String? {
        if (currBedType.isNullOrBlank()) return null
        val normalized = currBedType.trim()
        return when {
            normalized.contains("PEI", ignoreCase = true) -> "btPEI"
            normalized.contains("Engineering", ignoreCase = true) ||
                normalized.contains("GESP", ignoreCase = true) -> "btGESP"
            else -> null
        }
    }

    /**
     * Run [filamentTypes] against [rules] for [bedKey]. Forbidden wins
     * over Warning when the same project has both — surface the worse
     * tier so the user has to fix it before slicing.
     *
     * - [Result.Forbidden] when any filament is on a known bed but
     *   absent from BOTH the support and warning lists for that bed.
     * - [Result.Warning] when at least one filament hits the warning
     *   list and none hit the forbidden tier.
     * - [Result.Ok] when all filaments are in the support list, when
     *   [bedKey] is null, or when the rules don't enumerate [bedKey].
     */
    fun evaluate(
        rules: Rules,
        bedKey: String?,
        filamentTypes: List<String>,
    ): Result {
        if (bedKey == null) return Result.Ok
        val support = rules.supportByBed[bedKey] ?: return Result.Ok
        val warningSet = rules.warningByBed[bedKey].orEmpty()

        val unsupported = mutableListOf<String>()
        val warned = mutableListOf<String>()
        for (rawType in filamentTypes) {
            val ty = rawType.trim().uppercase()
            if (ty.isEmpty()) continue
            val isSupport = support.any { token -> ty.contains(token) }
            val isWarning = warningSet.any { token -> ty.contains(token) }
            when {
                isWarning -> warned += rawType
                !isSupport -> unsupported += rawType
            }
        }
        return when {
            unsupported.isNotEmpty() -> Result.Forbidden(
                "Filament ${unsupported.joinToString(", ")} is not supported " +
                    "on the active build plate. Change the plate or pick a " +
                    "different filament before slicing.",
            )
            warned.isNotEmpty() -> Result.Warning(
                "Filament ${warned.joinToString(", ")} may have poor adhesion " +
                    "on this build plate. Slicing is allowed but the print " +
                    "may need extra care (brim, glue, plate temperature).",
            )
            else -> Result.Ok
        }
    }
}
