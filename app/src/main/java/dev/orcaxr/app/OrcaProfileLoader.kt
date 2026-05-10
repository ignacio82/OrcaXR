package dev.orcaxr.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reads OrcaSlicer-style profile JSONs from the bundled assets and
 * flattens their `inherits` chains into [SlicerProfile] entries that
 * map cleanly onto our flat `Map<String, String>` config shape.
 *
 * Profile model (mirrors OrcaSlicer's, see Snapmaker/OrcaSlicer's
 * `resources/profiles/Snapmaker/`):
 *   - **machine**: bed geometry, nozzle, gcode flavor, retraction.
 *   - **process**: layer height, walls, infill, supports, speeds.
 *   - **filament**: temps, fan, density, max volumetric.
 * Each file optionally `inherits` another by `name`. We resolve the
 * chain breadth-first (leaf overrides base), strip OrcaSlicer
 * meta-keys (the `name`/`from`/`type` book-keeping fields and the
 * Snapmaker-firmware-specific gcode macros that don't apply on
 * vanilla MainsailOS hosts), and merge `machine + process + filament`
 * into one [SlicerProfile] per (machine, process, filament) triple.
 *
 * License: profile JSONs ship under AGPL-3.0 (same as libslic3r).
 * NOTICE.md tracks the snapshot.
 */
object OrcaProfileLoader {

    private const val PROFILES_ROOT = "profiles"

    /**
     * Load every bundled profile from every brand subdirectory under
     * `assets/profiles/`, flatten inheritance, and produce one
     * [SlicerProfile] per machine × process × filament triple per
     * brand. If anything fails to parse, skip that triple — never
     * throw, since a malformed asset must not prevent the app from
     * booting.
     *
     * Brand directories are independent — `inherits` is resolved
     * within a single brand's tree, so two brands defining a
     * `fdm_filament_common` don't cross-link.
     */
    fun loadCatalog(ctx: Context): List<SlicerProfile> = runCatching {
        val brands = ctx.assets.list(PROFILES_ROOT)?.toList().orEmpty()
        brands.flatMap { brand ->
            runCatching { loadBrand(ctx, "$PROFILES_ROOT/$brand") }
                .getOrDefault(emptyList())
        }
    }.getOrDefault(emptyList())

    /**
     * Load all flattened filament configs, keyed by the filament short name
     * (e.g. "Generic PLA", "Elegoo PLA Matte"). Used to look up the
     * specific temperature and cooling settings for each slot's material.
     */
    fun loadFilaments(ctx: Context): Map<String, Map<String, String>> = runCatching {
        val out = mutableMapOf<String, Map<String, String>>()
        val brands = ctx.assets.list(PROFILES_ROOT)?.toList().orEmpty()
        for (brand in brands) {
            runCatching {
                val brandRoot = "$PROFILES_ROOT/$brand"
                val machines = readDir(ctx, "$brandRoot/machine")
                val processes = readDir(ctx, "$brandRoot/process")
                val filaments = readDir(ctx, "$brandRoot/filament")

                val byName = (machines + processes + filaments)
                    .filter { it.has("name") }
                    .associateBy { it.getString("name") }

                val filamentLeaves = leavesOf(filaments)
                for (f in filamentLeaves) {
                    val name = f.optString("name", "").trim().substringBefore('@').trim()
                    if (name.isNotBlank()) {
                        out[name] = flatten(f, byName)
                    }
                }
            }
        }
        out
    }.getOrDefault(emptyMap())

    /**
     * Load every machine × process × filament triple for one brand
     * (e.g. `profiles/Snapmaker` or `profiles/Elegoo`).
     */
    private fun loadBrand(ctx: Context, brandRoot: String): List<SlicerProfile> {
        val machines = readDir(ctx, "$brandRoot/machine")
        val processes = readDir(ctx, "$brandRoot/process")
        val filaments = readDir(ctx, "$brandRoot/filament")

        // Index this brand's profiles by `name` so any
        // `inherits: "<name>"` resolves regardless of which directory
        // (machine/process/filament) the parent lives in.
        val byName: Map<String, JSONObject> = (machines + processes + filaments)
            .filter { it.has("name") }
            .associateBy { it.getString("name") }

        val machineLeaves = leavesOf(machines)
        val processLeaves = leavesOf(processes)
        val filamentLeaves = leavesOf(filaments)

        val combos = mutableListOf<SlicerProfile>()
        for (machine in machineLeaves) {
            val machineCfg = flatten(machine, byName)
            for (process in processLeaves) {
                val processCfg = flatten(process, byName)
                for (filament in filamentLeaves) {
                    val filamentCfg = flatten(filament, byName)
                    combos += compose(machine, process, filament, machineCfg + processCfg + filamentCfg)
                }
            }
        }
        return combos
    }

    /**
     * A "leaf" is a profile no other profile inherits from. With the
     * Snapmaker tree this comes out to one machine ("Snapmaker U1 (0.4
     * nozzle)"), three processes (0.12 Fine / 0.20 Standard / 0.28
     * Extra Draft), and one filament (Generic PLA).
     *
     * Profiles flagged `instantiation: "false"` are explicit
     * abstract-base markers and we exclude them too.
     */
    private fun leavesOf(jsons: List<JSONObject>): List<JSONObject> {
        val parentNames = jsons.mapNotNullTo(mutableSetOf()) {
            it.optString("inherits", "").takeIf(String::isNotBlank)
        }
        return jsons.filter {
            val name = it.optString("name", "")
            name.isNotBlank() &&
                name !in parentNames &&
                it.optString("instantiation", "true") != "false"
        }
    }

    /**
     * Walk the [leaf]'s parent chain to the root, then merge from root
     * to leaf so leaf values win. Returns a flat [Map] suitable for
     * direct passthrough to libslic3r's `set_deserialize_nothrow`.
     */
    fun flatten(leaf: JSONObject, byName: Map<String, JSONObject>): Map<String, String> {
        val chain = mutableListOf<JSONObject>()
        var current: JSONObject? = leaf
        var depth = 0
        while (current != null && depth < MAX_INHERITANCE_DEPTH) {
            chain += current
            val parentName = current.optString("inherits", "").takeIf(String::isNotBlank)
            current = parentName?.let(byName::get)
            depth += 1
        }
        val out = mutableMapOf<String, String>()
        for (json in chain.asReversed()) {
            val keys = json.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key in META_KEYS) continue
                if (key in DROPPED_GCODE_KEYS) continue
                // ConfigOptionEnumsGeneric guard. These config options'
                // enum-name tables are populated at preset-bundle load
                // time; we don't load a bundle, so calling
                // set_deserialize_nothrow on them dereferences a null
                // map and segfaults inside libslic3r (caught in field on
                // the user's Galaxy XR — backtrace landed in
                // __tree::find on a never-constructed map). The known
                // offenders all have the shape "vendor/enum-typed config
                // that requires the bundle's vendor section." Drop them
                // here. Hand-rolled values for these keys (e.g. our
                // bundled Snapmaker U1 ahead of the JSON loader) avoided
                // the crash because they never set the unsafe options.
                // Until we either ship a preset-bundle loader or
                // patch libslic3r's PrintConfig defaults, route through
                // a known-safe whitelist. Blacklist guessing would let
                // a Bambu/SoftFever-introduced enum slip through and
                // segfault the slicer mid-run. The whitelist matches
                // the keys our hand-rolled Snapmaker_U1_PLA_Standard
                // profile used (proven stable in field) plus a handful
                // of obviously-safe additions.
                if (key !in SAFE_KEYS) continue
                out[key] = jsonValueToString(json.get(key))
            }
        }
        return out
    }

    /**
     * libslic3r's `set_deserialize_nothrow` accepts string scalars only.
     *  - Per-tool arrays (4-long on U1: nozzle_diameter, retraction_*)
     *    collapse to a single comma-joined string. libslic3r's parser
     *    re-vectorizes if the underlying option is a vector type.
     *  - `printable_area` is structurally a 4-element array of corner
     *    coordinates ("0.5x1", …). Same comma-joined output works
     *    because libslic3r's polygon parser splits on commas.
     *  - Single scalars fall through `.toString()`.
     */
    private fun jsonValueToString(value: Any?): String = when (value) {
        null -> ""
        is JSONArray -> buildString {
            for (i in 0 until value.length()) {
                if (i > 0) append(',')
                append(value.optString(i, ""))
            }
        }
        is JSONObject -> value.toString()
        else -> value.toString()
    }

    private fun compose(
        machine: JSONObject,
        process: JSONObject,
        filament: JSONObject,
        merged: Map<String, String>,
    ): SlicerProfile {
        val machineName = machine.optString("name").trim()
        val processName = process.optString("name").trim()
        val filamentName = filament.optString("name").trim()

        // Strip the OrcaSlicer convention "@<context>" suffix from the
        // process AND filament names for a tighter UI label.
        // "0.20 Standard @Snapmaker U1 (0.4 nozzle)" → "0.20 Standard".
        // "Elegoo PLA Matte @ECC" → "Elegoo PLA Matte".
        // "Elegoo PLA Matte @0.2 nozzle" → "Elegoo PLA Matte"
        // (nozzle disambiguation already lives in machineName).
        val processShort = processName.substringBefore('@').trim()
        val filamentShort = filamentName.substringBefore('@').trim()
        // Optional brand prefix strip — Snapmaker U1's UI was nicer
        // without "Snapmaker " on every row (the Devices panel
        // already says it's a Snapmaker). Generalize: only strip a
        // brand prefix if the rest of the name remains unique.
        val machineShort = machineName.removePrefix("Snapmaker ")

        val id = buildString {
            append("bundled_")
            append(slug(machineName)); append('.')
            append(slug(processShort)); append('.')
            append(slug(filamentName))
        }
        val display = "$machineShort · $processShort · $filamentShort"
        val description = buildString {
            merged["layer_height"]?.let { append(it).append(" mm") }
            merged["sparse_infill_density"]?.let { append(", ").append(it).append(" infill") }
            merged["nozzle_temperature"]?.let { append(", ").append(it).append(" °C") }
            merged["hot_plate_temp"]?.let { append(" / ").append(it).append(" °C") }
        }.trim().trimStart(',', ' ')

        return SlicerProfile(
            id = id,
            displayName = display,
            description = description.ifBlank { "Bundled OrcaSlicer profile" },
            config = merged,
            machineName = machineName,
            processName = processName,
            filamentName = filamentShort.ifBlank { filamentName },
        )
    }

    private fun readDir(ctx: Context, path: String): List<JSONObject> {
        val names = runCatching { ctx.assets.list(path) }.getOrNull() ?: return emptyList()
        return names
            .asSequence()
            .filter { it.endsWith(".json", ignoreCase = true) }
            .mapNotNull { name ->
                runCatching {
                    ctx.assets.open("$path/$name").bufferedReader().use(java.io.BufferedReader::readText)
                }.getOrNull()?.let { text ->
                    runCatching { JSONObject(text) }.getOrNull()
                }
            }
            .toList()
    }

    private fun slug(s: String): String =
        s.lowercase()
            .replace(Regex("[^a-z0-9._-]+"), "_")
            .trim('_', '.')

    /**
     * Brand keywords we recognize when extracting a vendor from a
     * printer's display name. Substring-matched case-insensitively
     * against [PrinterConfig.name] and against [SlicerProfile.machineName].
     * Order doesn't matter — printer names contain at most one brand.
     */
    private val PRINTER_BRANDS: List<String> = listOf(
        "Snapmaker",
        "Elegoo",
        "Bambu",
        "Prusa",
    )

    /**
     * Model-identifier patterns used to narrow the profile picker
     * beyond the brand level. The pattern is matched against the
     * printer's display name (case-insensitive); the captured string
     * is then substring-matched against [SlicerProfile.machineName].
     *
     * Without this, a user with a Snapmaker U1 still sees profiles
     * for Snapmaker A350 / J1 / Artisan in the dropdown. Pattern
     * order matters when patterns can overlap (e.g. "MK3.5" must
     * win over "MK3"). Add a row when bundling a new vendor's
     * machine profile leaves so the picker stays narrow.
     */
    private val PRINTER_MODELS: List<Pair<Regex, String>> = listOf(
        // Snapmaker
        Regex("""\bArtisan\b""", RegexOption.IGNORE_CASE) to "Artisan",
        Regex("""\bU1\b""", RegexOption.IGNORE_CASE) to "U1",
        Regex("""\bJ1\b""", RegexOption.IGNORE_CASE) to "J1",
        Regex("""\bA350\b""", RegexOption.IGNORE_CASE) to "A350",
        Regex("""\bA250\b""", RegexOption.IGNORE_CASE) to "A250",
        Regex("""\bA150\b""", RegexOption.IGNORE_CASE) to "A150",
        // Elegoo
        Regex("""\bCentauri\s+Carbon\b""", RegexOption.IGNORE_CASE) to "Centauri Carbon",
        Regex("""\bECC\b""", RegexOption.IGNORE_CASE) to "Centauri Carbon",
        // Bambu
        Regex("""\bX1C\b""", RegexOption.IGNORE_CASE) to "X1C",
        Regex("""\bX1E\b""", RegexOption.IGNORE_CASE) to "X1E",
        Regex("""\bP1S\b""", RegexOption.IGNORE_CASE) to "P1S",
        Regex("""\bP1P\b""", RegexOption.IGNORE_CASE) to "P1P",
        Regex("""\bA1\s+mini\b""", RegexOption.IGNORE_CASE) to "A1 mini",
        Regex("""\bA1\b""", RegexOption.IGNORE_CASE) to "A1",
        // Prusa
        Regex("""\bMK4S?\b""", RegexOption.IGNORE_CASE) to "MK4",
        Regex("""\bMK3\.5\b""", RegexOption.IGNORE_CASE) to "MK3.5",
        Regex("""\bMK3S?\b""", RegexOption.IGNORE_CASE) to "MK3",
        Regex("""\bXL\b""", RegexOption.IGNORE_CASE) to "XL",
        Regex("""\bMINI\b""", RegexOption.IGNORE_CASE) to "MINI",
    )

    /**
     * Material family tokens, longest-first so "PLA-CF" matches before
     * "PLA". Substring-matched case-insensitively against the project's
     * filament-type strings (e.g. "Generic PLA", "Elegoo PLA Matte"
     * → PLA) and against [SlicerProfile.filamentName] when filtering
     * the dropdown.
     */
    private val MATERIAL_TOKENS: List<String> = listOf(
        "PLA-CF", "PETG-CF", "PA-CF", "ABS-CF",
        "PETG", "PCTG",
        "PLA", "ABS", "ASA", "TPU", "PVA", "HIPS",
        "PA", "PC", "PEI", "PEEK",
    )

    /**
     * Extracts the recognized vendor brand from a printer's display name.
     * Returns null when no brand keyword matches — callers treat null as
     * "no brand filter" and show every profile.
     */
    fun brandOfPrinter(name: String?): String? {
        if (name.isNullOrBlank()) return null
        return PRINTER_BRANDS.firstOrNull { name.contains(it, ignoreCase = true) }
    }

    /**
     * Extracts the recognized printer-model token from a printer's
     * display name (e.g. "Snapmaker U1 — Living Room" → "U1",
     * "Elegoo Centauri Carbon" → "Centauri Carbon"). Returns null
     * when no [PRINTER_MODELS] pattern matches; callers fall back to
     * brand-only filtering so the dropdown doesn't go empty.
     */
    fun modelOfPrinter(name: String?): String? {
        if (name.isNullOrBlank()) return null
        return PRINTER_MODELS.firstOrNull { (re, _) -> re.containsMatchIn(name) }?.second
    }

    /**
     * Reduces a set of project-filament-type strings to a single shared
     * material family, or null if the project mixes families. With one
     * unique family, the dropdown filter narrows to profiles whose
     * filament leaf advertises that family.
     */
    fun sharedMaterialFamily(filamentTypes: Collection<String>): String? {
        if (filamentTypes.isEmpty()) return null
        val families = filamentTypes.mapNotNullTo(mutableSetOf()) { type ->
            MATERIAL_TOKENS.firstOrNull { type.contains(it, ignoreCase = true) }
        }
        return families.singleOrNull()
    }

    /**
     * Filters the bundled+user catalog down to rows that make sense for
     * the active printer + project's shared material family. User-saved
     * profiles (machineName/filamentName both null) always pass — we
     * don't second-guess what the user explicitly authored. If the
     * filter would empty the dropdown, returns the full input list so
     * the user is never stuck without a selectable profile.
     */
    fun filterForContext(
        all: List<SlicerProfile>,
        printerBrand: String?,
        sharedMaterial: String?,
        printerModel: String? = null,
    ): List<SlicerProfile> {
        if (printerBrand == null && sharedMaterial == null && printerModel == null) return all
        val filtered = all.filter { p ->
            val brandOk = printerBrand == null
                || p.machineName == null
                || p.machineName.contains(printerBrand, ignoreCase = true)
            // Narrow further by printer-model when we recognized one
            // — without this the dropdown surfaces every Snapmaker /
            // Bambu / Prusa machine profile when only one model is
            // physically present. User-saved profiles still pass
            // (their machineName is null).
            val modelOk = printerModel == null
                || p.machineName == null
                || p.machineName.contains(printerModel, ignoreCase = true)
            val materialOk = sharedMaterial == null
                || p.filamentName == null
                || p.filamentName.contains(sharedMaterial, ignoreCase = true)
            brandOk && modelOk && materialOk
        }
        return if (filtered.isEmpty()) all else filtered
    }

    /** OrcaSlicer book-keeping fields that aren't slicer config keys. */
    private val META_KEYS: Set<String> = setOf(
        "name", "type", "from", "version", "instantiation", "inherits",
        "setting_id", "filament_id", "model_id", "is_custom_defined",
        "default_print_profile", "default_filament_profile",
        "compatible_printers", "compatible_printers_condition",
        "compatible_prints", "compatible_prints_condition",
        "printer_notes", "printer_settings_id",
    )

    /**
     * G-code macro keys we previously stripped. Now empty: the bundled
     * Snapmaker U1 profile's `machine_start_gcode` IS Snapmaker's
     * canonical 2026-01-28 production text, designed for the U1
     * firmware's PRINT_START + SM_PRINT_AUTO_FEED + BED_MESH_CALIBRATE
     * + DEFECT_DETECTION_* macro stack. Every U1 owner has these
     * macros — they ship in Snapmaker's stock Klipper config, not as
     * optional add-ons. Stripping them and substituting our naive
     * `GENERIC_KLIPPER_START_GCODE` was the actual cause of the M109
     * deadlock: bare M104/M109 (no `T{initial_extruder}`) gets
     * intercepted by the U1 firmware's [gcode_macro M104] override,
     * routed to a parallel heater controller that doesn't update
     * Klipper's `extruder.target` field, and M109's wait-on-target
     * never unblocks even though the nozzle physically heats.
     *
     * For non-Snapmaker Klipper hosts: the GENERIC_KLIPPER_*_GCODE
     * fallback in MainActivity.kt fires only when the profile's
     * machine_start_gcode is missing or blank.
     */
    private val DROPPED_GCODE_KEYS: Set<String> = emptySet()

    /** Hard cap to defend against accidentally-cyclic `inherits` graphs. */
    private const val MAX_INHERITANCE_DEPTH = 16

    /**
     * Whitelist of OrcaSlicer config keys we pass to
     * `set_deserialize_nothrow`. Started life as a defensive guard
     * against the `ConfigOptionEnumsGeneric` null-`keys_map` crash
     * (deserialize would dereference a never-set runtime pointer for
     * any `coEnums` option since `FullPrintConfig::defaults()` builds
     * those options via the initializer-list ctor that doesn't copy
     * the def's `enum_keys_map`). slic3r_jni.cpp now patches the
     * keys_map onto every `coEnums` option at startup, so the
     * original segfault rationale no longer drives this list.
     *
     * Current rationale: keep BBS-only / Snapmaker-fork-only / preset-
     * bundle-only keys out of the deserialize path, where they'd
     * either be silently dropped by libslic3r anyway (with our
     * `ORCAXR_LOGE("rejected config: ...")` line) or — worse —
     * trigger the gotcha #16 nullable-enum (`*Nullable` template
     * instantiation) crash in `serialize_single_value` that the
     * keys_map fixup does NOT cover. The whitelist is the cheap
     * defense until we either widen the fixup or load a real preset
     * bundle.
     *
     * **Type-check rule before adding a key:** grep
     * `third_party/OrcaSlicer/src/libslic3r/PrintConfig.cpp` for
     * `add("<key>"` and confirm the option type is one of:
     * `coBool`, `coBools`, `coInt`, `coInts`, `coFloat`, `coFloats`,
     * `coFloatOrPercent`, `coPercent`, `coString`, `coStrings`,
     * `coPoint`, `coPoints`, or a typed `coEnum<X>` (e.g.,
     * `ConfigOptionEnum<BedType>`). Reject anything that is `coEnums`
     * (the Generic variant) unless covered by the keys_map fixup, and
     * reject any `*Nullable` template instantiation outright. Typed
     * enums like `top_surface_pattern` carry their own keys_map at
     * the option-class level and are safe.
     *
     * Note for coStrings vectors: `jsonValueToString` flattens JSON
     * arrays with `,`, but libslic3r's coStrings parser splits on
     * `;` (gotcha #19). The only coStrings vectors we actively rely
     * on (`filament_type`, `filament_colour`, `extruder_colour`) are
     * post-processed by `mergedConfig` with `;` separators. Don't add
     * a non-empty coStrings key here that bypasses `mergedConfig`.
     */
    private val SAFE_KEYS: Set<String> = setOf(
        // ---- machine geometry / kinematics ----
        "printable_height",
        "printable_area",
        "bed_exclude_area",
        "nozzle_diameter",
        "nozzle_type",                  // coEnums — keys_map fixup in slic3r_jni.cpp
        "extruder_offset",
        "auxiliary_fan",
        "fan_speedup_time",
        "scan_first_layer",
        "machine_load_filament_time",
        "machine_unload_filament_time",
        "manual_filament_change",
        "single_extruder_multi_material",
        "gcode_flavor",
        // host_type sentinel for routing to a vendor-specific
        // Moonraker driver. ElegooSlicer's CC machine profile authors
        // "elegoolink"; libslic3r's PrintHostType enum doesn't include
        // it, so deserialize silently drops the value — but having
        // the key in SAFE_KEYS means the Kotlin-side PrinterRepository
        // (which reads the raw JSON, not the resolved config) can
        // detect a CC and route to a Centauri-aware Moonraker dialect
        // when one ships. coEnum<PrintHostType> on the libslic3r side.
        "host_type",
        // Centauri-style filename templates ("ECC_{nozzle_diameter[0]}_{...}.gcode")
        // so prints uploaded by OrcaXR group correctly in the CC's
        // on-printer file browser. coString — safe.
        "filename_format",
        // Identifying metadata that ends up in the gcode header
        // (`;printer_model:[printer_model]`) and is consumed by the
        // CC firmware UI. coString — safe.
        "printer_model",
        "printer_variant",
        "default_bed_type",
        // ---- retraction / wipe ----
        "retraction_length",
        "retraction_speed",
        "deretraction_speed",
        "retract_lift_above",
        "retract_lift_below",
        "retract_when_changing_layer",
        "retraction_minimum_travel",
        "z_hop",
        "wipe",
        "wipe_distance",
        // ---- process: layers / shells ----
        "layer_height",
        "initial_layer_print_height",
        "first_layer_height",
        "wall_loops",
        "wall_generator",
        "top_shell_layers",
        "top_shell_thickness",
        "bottom_shell_layers",
        "bottom_shell_thickness",
        "line_width",
        "outer_wall_line_width",
        "inner_wall_line_width",
        "top_surface_line_width",
        "sparse_infill_line_width",
        // ---- process: infill ----
        "sparse_infill_density",
        "sparse_infill_pattern",
        // ---- process: supports ----
        "support_type",
        "enable_support",
        "support_threshold_angle",
        "support_top_z_distance",
        "support_bottom_z_distance",
        "support_object_xy_distance",
        "support_interface_top_layers",
        "support_interface_bottom_layers",
        "support_interface_spacing",
        "support_speed",
        // ---- process: speeds / accelerations ----
        // Without these keys' Snapmaker-tuned values flowing through,
        // libslic3r falls back to compiled-in defaults that are far
        // more conservative — `gap_infill_speed` defaults to 30 mm/s
        // vs Snapmaker's 250, `bridge_speed` to 25 vs 50,
        // `top_surface_acceleration` to 500 mm/s² vs 2000, etc. That
        // delta is the dominant cause of OrcaXR-sliced prints running
        // 15-30% longer than the same model sliced by Snapmaker's
        // upstream Orca fork.
        "outer_wall_speed",
        "inner_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "top_surface_speed",
        "travel_speed",
        "initial_layer_speed",
        "initial_layer_infill_speed",
        "bridge_speed",
        "internal_bridge_speed",
        "gap_infill_speed",
        "support_interface_speed",
        "wipe_speed",
        // overhang_*_speed gate the slowdown-by-overhang-severity
        // logic. Defaults are 0 ("no override") — without these the
        // slicer prints overhangs at full wall speed (faster, but
        // worse quality). Snapmaker's profile sets explicit caps.
        "overhang_1_4_speed",
        "overhang_2_4_speed",
        "overhang_3_4_speed",
        "overhang_4_4_speed",
        // accelerations
        "outer_wall_acceleration",
        "inner_wall_acceleration",
        "top_surface_acceleration",
        "initial_layer_acceleration",
        "bridge_acceleration",
        "sparse_infill_acceleration",
        "travel_acceleration",
        "default_acceleration",
        "accel_to_decel_enable",
        "accel_to_decel_factor",
        // per-feature jerk + small-perimeter knobs. Same reasoning as
        // accelerations above — without these flowing through, libslic3r
        // falls back to compiled-in defaults that ignore the U1's
        // tuned-for-Klipper jerk (9 mm/s on walls, 12 on travel) and the
        // 0% small-perimeter slowdown trigger. Surfaced 2026-05-02 by
        // diffing the user's reference Snapmaker-desktop CONFIG_BLOCK
        // against the resolved-from-profile values.
        "outer_wall_jerk",
        "inner_wall_jerk",
        "infill_jerk",
        "travel_jerk",
        "top_surface_jerk",
        "initial_layer_jerk",
        "default_jerk",
        "small_perimeter_speed",
        "small_perimeter_threshold",
        "overhang_fan_speed",
        // ---- machine kinematics caps (per-axis ceilings the slicer
        // uses to clamp the per-feature accel/speed values above).
        // Snapmaker's U1 toolchanger profile sets these to 20000 mm/s²
        // on X/Y/extruding/travel — without them passing through, the
        // slicer falls back to its compiled-in defaults (~1500 mm/s²),
        // which silently downgrades EVERY accel value above to that
        // ceiling. That is the root cause of OrcaXR slices taking
        // significantly longer to print than the same model sliced
        // through Snapmaker's desktop OrcaSlicer build. Each entry is
        // a coFloats array sized to extruder_count and gets resized
        // by mergedConfig before reaching libslic3r. ----
        "machine_max_acceleration_x",
        "machine_max_acceleration_y",
        "machine_max_acceleration_z",
        "machine_max_acceleration_e",
        "machine_max_acceleration_extruding",
        "machine_max_acceleration_retracting",
        "machine_max_acceleration_travel",
        "machine_max_speed_x",
        "machine_max_speed_y",
        "machine_max_speed_z",
        "machine_max_speed_e",
        "machine_max_jerk_x",
        "machine_max_jerk_y",
        "machine_max_jerk_z",
        "machine_max_jerk_e",
        // ---- filament ----
        "filament_type",
        "filament_diameter",
        "filament_density",
        "filament_flow_ratio",
        "filament_max_volumetric_speed",
        "nozzle_temperature",
        "nozzle_temperature_initial_layer",
        "nozzle_temperature_range_low",
        "nozzle_temperature_range_high",
        // OrcaSlicer keeps a separate per-plate temperature for each
        // bed type. `bed_temperature_initial_layer_single` (used by
        // PRINT_START's `M140 S{...}` substitution) reads from the key
        // matching `curr_bed_type`: cool/eng/hot/textured. Strip any
        // one of these and libslic3r silently falls back to its
        // compiled-in default (~45°C), which is what we observed on
        // the U1's textured PEI plate (PLA profile says 65°C, output
        // emitted M140 S45). Whitelist all four.
        "cool_plate_temp",
        "cool_plate_temp_initial_layer",
        "eng_plate_temp",
        "eng_plate_temp_initial_layer",
        "hot_plate_temp",
        "hot_plate_temp_initial_layer",
        "textured_plate_temp",
        "textured_plate_temp_initial_layer",
        "fan_max_speed",
        "fan_min_speed",
        "overhang_fan_threshold",       // coEnums — keys_map fixup in slic3r_jni.cpp
        "close_fan_the_first_x_layers",
        "additional_cooling_fan_speed",
        "slow_down_layer_time",
        "slow_down_min_speed",
        "fan_cooling_layer_time",
        "temperature_vitrification",
        // ---- bed plate ----
        // curr_bed_type is the typed BedType enum libslic3r consults
        // for bed-temp resolution (hot_plate vs cool_plate). Setting
        // this to "Textured PEI Plate" forces the hot_plate_temp path
        // — matches u1-slicer's `ConfigOptionEnum<BedType>(btPEI)`.
        "curr_bed_type",
        "default_bed_type",
        // ---- multi-color ----
        "extruder_colour",
        "filament_colour",
        // Generic-enum keys needed for the toolchanger code path
        // (PrintConfig.cpp:9173-9183). Without these the
        // update_values_to_printer_extruders_for_multiple_filaments
        // path can't resolve per-extruder variants. Made deserialize-
        // safe by slic3r_jni.cpp's keys_map fixup.
        "extruder_type",
        "nozzle_volume_type",
        "default_nozzle_volume_type",
        "filament_map",
        // filament_map_mode — must be "Manual" for our user-supplied
        // filament_map to survive Print::process. Default is
        // "Auto For Flush" which silently recomputes the map at slice
        // time and discards the user's physical-slot picks. See
        // GEMINI.md gotcha #34. ConfigOptionEnum<FilamentMapMode>;
        // typed enum, no keys_map fixup needed.
        "filament_map_mode",
        // single_extruder_multi_material — explicitly false for the U1
        // (4 independent extruders, not Bambu/Prusa MMU). Embedded
        // Snapmaker profiles set this to 1; mergedConfig() force-
        // overrides for real multi-tool slicing.
        // ---- gcode templates (PRINT_START / change tool / end) ----
        // Pass through to libslic3r. The Snapmaker U1 profile's
        // machine_start_gcode is the canonical sequence the U1
        // firmware was designed to receive (PRINT_START + per-extruder
        // feeds + bed mesh + clean cycle). Suppressing it caused the
        // M109 deadlock — see DROPPED_GCODE_KEYS comment above.
        "machine_start_gcode",
        "machine_end_gcode",
        "change_filament_gcode",
        "before_layer_change_gcode",
        "layer_change_gcode",
        "filament_start_gcode",
        "filament_end_gcode",
        "machine_pause_gcode",
        "template_custom_gcode",
        // ---- process: quality / Klipper-aware tweaks ----
        // Most are coBool toggles that change toolpath shape rather
        // than speed directly, but they affect total print time
        // through Klipper's lookahead (longer/straighter segments =
        // higher achievable velocity). enable_arc_fitting is the big
        // one — without it the slicer emits long G1 chains instead of
        // G2/G3 arcs.
        "enable_arc_fitting",
        "resolution",
        "slowdown_for_curled_perimeters",
        "precise_outer_wall",
        "only_one_wall_top",
        "min_width_top_surface",
        "detect_overhang_wall",
        "reduce_infill_retraction",
        "reduce_crossing_wall",
        "infill_direction",
        "infill_wall_overlap",
        "seam_gap",
        "seam_position",                  // typed coEnum<SeamPosition> — safe
        "bridge_flow",
        "bridge_density",
        "internal_bridge_flow",
        // ---- process: surface patterns (typed coEnum<X>) ----
        // Typed enums (not coEnums Generic) — keys_map lives at the
        // option-class level, no fixup needed. Same shape as
        // sparse_infill_pattern / support_type already in the list.
        "top_surface_pattern",
        "bottom_surface_pattern",
        "internal_solid_infill_pattern",
        "gap_fill_target",
        // ---- process: multi-tool / wipe tower geometry ----
        // Snapmaker's leaf tunes wipe-tower shape and tool-change
        // standby behavior; defaults here add print time on
        // multi-color jobs.
        "standby_temperature_delta",
        "preheat_time",
        "ooze_prevention",
        "prime_volume",
        // Master toggle for the prime/wipe tower. Authored at "1" in
        // the bundled Snapmaker U1 multi-color and Elegoo ECC process
        // leaves but was being silently dropped here, so multi-color
        // slices ran without a tower and dragged old-color filament
        // onto the part on the first few mm after each toolchange.
        // mergedConfig() force-sets this to "1" for n>=2 anyway, but
        // letting the profile's value through means single-tool
        // profiles that author the tower (e.g. for purge_to_infill
        // calibration prints) also work as expected. coBool — safe.
        "enable_prime_tower",
        // coBool — Bambu/SoftFever extension, controls whether a
        // sparse "framework" structure replaces the solid tower
        // body to save filament. Default is false. Listed here so
        // a profile that opts in actually opts in.
        "prime_tower_enable_framework",
        // coBool — when true, normal infill is purged into the
        // tower instead of being printed as part of the model;
        // off by default in the bundled profiles. Lets the
        // authored "0" (don't purge to infill) flow through
        // instead of being silently dropped, which prevents
        // libslic3r from falling back to its compiled-in default
        // and producing a tower different from what the profile
        // designer intended.
        "purge_in_prime_tower",
        "prime_tower_width",
        "prime_tower_brim_width",
        // Phase D.1 (PR #131 port): brim chamfer around the prime tower.
        "prime_tower_brim_chamfer",
        "prime_tower_brim_chamfer_max_width",
        "wipe_tower_extra_spacing",
        "wipe_tower_extra_rib_length",
        "wipe_tower_wall_type",            // typed coEnum<WipeTowerWallType>
        "wipe_tower_cone_angle",
        "wipe_tower_filament",
        "wipe_tower_no_sparse_layers",
        // Roadmap A13 — wipe-tower position. Both are coFloats (one
        // entry per plate). PrintConfig.cpp:6442-6456. Default 15/220
        // for plate 1; the auto-position scorer in WipeTowerPlacement
        // overrides these via mergedConfig() when the user opts in.
        "wipe_tower_x",
        "wipe_tower_y",
        // Multi-color purge sizing. Both are coFloats (non-nullable
        // vectors) per PrintConfig.cpp:6417-6431. Sizing is load-
        // bearing: libslic3r's WipeTowerIntegration indexes
        // flush_volumes_matrix as `n_filaments² × nozzle_count`
        // (Print.cpp:3240), and flush_multiplier holds one entry per
        // nozzle (Print.cpp:3272). Without these flowing through, the
        // compiled-in defaults (280 mm³ off-diagonal × 0.3 multiplier
        // = 84 mm³ per toolchange) override whatever was authored in
        // a 3MF or set in a profile, ballooning the wipe tower vs
        // desktop OrcaSlicer / FullSpectrum. mergedConfig() validates
        // the active matrix size against the slot count before
        // forwarding (size mismatch falls back to a synthesized small-
        // default matrix, never the libslic3r 280-default).
        "flush_volumes_matrix",
        "flush_multiplier",
        "skirt_distance",
        // ---- filament: per-extruder cooling / pressure / ramming ----
        // coBools / coFloats per-tool vectors. mergedConfig() resizes
        // these to the slot count for multi-color slicing.
        "filament_minimal_purge_on_wipe_tower",
        "filament_multitool_ramming",
        "filament_multitool_ramming_volume",
        "filament_multitool_ramming_flow",
        "enable_pressure_advance",
        "pressure_advance",
        "reduce_fan_stop_start_freq",
        // Phase H.1 (Snapmaker fork PR #279 port) — per-filament
        // coBools that the U1 start-gcode reads to pre-condition
        // heaters for high-temp materials. Default false; profile
        // leaves that need it set the override per slot. mergedConfig
        // resizes per-tool just like the other filament_* coBools
        // above.
        "filament_is_high_temperature",
        // Phase H.2 (Snapmaker fork PR #284 port) — per-filament
        // coBools for materials that need the U1's magnetic top
        // cover. The Compose shell consumes this for the user-
        // visible warning banner (see MainActivity.topCoverHint).
        "requires_top_cover",
        // ---- filament: tool-change loading/unloading & cooling tuning ----
        // Snapmaker fork's fdm_filament_common.json sets these per-tool;
        // without whitelisting, libslic3r falls back to compiled-in defaults
        // and tool changes run at upstream's 28 mm/s instead of the fork's
        // tuned 25 mm/s. coFloats / coInts; not nullable, no keys_map.
        "filament_loading_speed",
        "filament_loading_speed_start",
        "filament_unloading_speed",
        "filament_unloading_speed_start",
        "filament_toolchange_delay",
        "filament_cooling_moves",
        "filament_cooling_initial_speed",
        "filament_cooling_final_speed",
        // ---- process: line widths + first-layer geometry ----
        // These ARE in our shipped 0.4-nozzle process JSONs but were
        // silently dropped pre-Phase B. Whitelisting per gotcha #2's
        // type-check rule (all coFloat / coFloatOrPercent).
        "elefant_foot_compensation",
        "filter_out_gap_fill",
        "initial_layer_line_width",
        "support_line_width",
        "internal_solid_infill_line_width",
        "precise_z_height",
        // ---- Roadmap A8 — G-code thumbnails ----
        // The Snapmaker / Elegoo touchscreens display a model preview
        // when the gcode contains base64-encoded thumbnail blocks
        // (`; thumbnail begin WxH bytes`). The bundled Snapmaker U1
        // machine JSONs author `"thumbnails": "48x48/PNG, 300x300/PNG"`,
        // which used to be silently dropped here so the firmware
        // showed a generic-icon job in the print queue. Whitelisting
        // both keys lets the slice JNI's ThumbnailsGeneratorCallback
        // (orcaxr::render_isometric_thumbnail) emit blocks at the
        // sizes / format the printer expects. coString — safe.
        "thumbnails",
        "thumbnails_format",
    )
}
