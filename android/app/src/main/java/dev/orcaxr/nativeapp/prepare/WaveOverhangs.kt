package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectSettingsOverrideSnapshot
import dev.orcaxr.nativeapp.R

enum class WaveOptionKind { BOOL, INT, FLOAT, ENUM }

enum class WaveOptionGroup(val labelRes: Int) {
    GENERAL(R.string.wave_group_general),
    DETECTION(R.string.wave_group_detection),
    PATTERN(R.string.wave_group_pattern),
    CORNER(R.string.wave_group_corner),
    MOTION(R.string.wave_group_motion),
    COOLING(R.string.wave_group_cooling),
    FLOOR(R.string.wave_group_floor),
    DEBUG(R.string.wave_group_debug);

    companion object {
        val ALL = entries
        val OPEN_BY_DEFAULT = setOf(GENERAL, PATTERN, MOTION, COOLING, FLOOR)
    }
}

enum class WaveValueSource(val labelRes: Int) {
    OVERRIDE(R.string.wave_source_override),
    INHERITED(R.string.wave_source_inherited),
    DEFAULT(R.string.wave_source_default),
}

data class WaveOverhangOption(
    val key: String,
    val group: WaveOptionGroup,
    val kind: WaveOptionKind,
    val engineDefault: Any,
    val labelRes: Int,
    val step: Double = 1.0,
    val min: Double? = null,
    val max: Double? = null,
    val unit: String? = null,
    val choices: List<String>? = null,
    val requires: List<String>? = null,
    val inert: Boolean = false,
    val develop: Boolean = false,
    val passthrough: Double? = null,
)

data class WaveOptionState(
    val option: WaveOverhangOption,
    val value: Any,
    val source: WaveValueSource,
    val applies: Boolean,
)

data class WaveNotice(
    val id: String,
    val messageRes: Int,
    val fixId: String? = null,
    val fixRes: Int? = null,
)

data class WaveSettingsState(
    val enabled: Boolean,
    val options: List<WaveOptionState>,
    val hasOverrides: Boolean,
    val unknownKeys: List<String>,
    val notices: List<WaveNotice>,
)

object WaveOverhangs {
    const val MASTER_KEY = "wave_overhangs"

    val OPTIONS: List<WaveOverhangOption> = listOf(
        // General
        WaveOverhangOption(
            key = MASTER_KEY,
            group = WaveOptionGroup.GENERAL,
            kind = WaveOptionKind.BOOL,
            engineDefault = false,
            labelRes = R.string.wave_master_label,
        ),
        WaveOverhangOption(
            key = "wave_overhangs_instead_of_bridges",
            group = WaveOptionGroup.GENERAL,
            kind = WaveOptionKind.BOOL,
            engineDefault = false,
            labelRes = R.string.wave_opt_instead_of_bridges,
        ),
        WaveOverhangOption(
            key = "support_remaining_areas_after_wave_overhangs",
            group = WaveOptionGroup.GENERAL,
            kind = WaveOptionKind.BOOL,
            engineDefault = true,
            labelRes = R.string.wave_opt_support_remaining,
        ),
        // Detection
        WaveOverhangOption(
            key = "wave_overhang_min_angle",
            group = WaveOptionGroup.DETECTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_min_angle,
            min = 0.0, max = 90.0, step = 1.0, unit = "°", inert = true,
        ),
        WaveOverhangOption(
            key = "wave_overhang_min_length",
            group = WaveOptionGroup.DETECTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_min_length,
            min = 0.0, max = 50.0, step = 0.5, unit = "mm", passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_max_iterations",
            group = WaveOptionGroup.DETECTION,
            kind = WaveOptionKind.INT,
            engineDefault = 0,
            labelRes = R.string.wave_opt_max_iterations,
            min = 0.0, max = 500.0, step = 10.0, passthrough = 0.0,
        ),
        // Pattern
        WaveOverhangOption(
            key = "wave_overhang_pattern",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.ENUM,
            engineDefault = "smart",
            labelRes = R.string.wave_opt_pattern,
            choices = listOf("smart", "monotonic", "zigzag"),
        ),
        WaveOverhangOption(
            key = "wave_overhang_seam_mode",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.ENUM,
            engineDefault = "alternating",
            labelRes = R.string.wave_opt_seam_mode,
            choices = listOf("alternating", "aligned", "random"),
            inert = true,
        ),
        WaveOverhangOption(
            key = "wave_overhang_outer_perimeters",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.INT,
            engineDefault = 1,
            labelRes = R.string.wave_opt_outer_perimeters,
            min = 0.0, step = 1.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_line_spacing",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.35,
            labelRes = R.string.wave_opt_line_spacing,
            min = 0.01, step = 0.01, unit = "mm",
        ),
        WaveOverhangOption(
            key = "wave_overhang_spacing_mode",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.ENUM,
            engineDefault = "uniform",
            labelRes = R.string.wave_opt_spacing_mode,
            choices = listOf("uniform", "progressive"),
            inert = true,
        ),
        WaveOverhangOption(
            key = "wave_overhang_perimeter_overlap",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.1,
            labelRes = R.string.wave_opt_perimeter_overlap,
            min = 0.0, step = 0.05, unit = "mm",
        ),
        WaveOverhangOption(
            key = "wave_overhang_minimum_width",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.7,
            labelRes = R.string.wave_opt_minimum_width,
            min = 0.0, step = 0.05, unit = "mm",
        ),
        WaveOverhangOption(
            key = "wave_overhang_min_new_area",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.01,
            labelRes = R.string.wave_opt_min_new_area,
            min = 0.0, max = 100.0, step = 0.005, unit = "mm²", develop = true,
        ),
        WaveOverhangOption(
            key = "wave_overhang_flow_mm3_per_mm",
            group = WaveOptionGroup.PATTERN,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.15,
            labelRes = R.string.wave_opt_flow,
            min = 0.02, max = 1.5, step = 0.01, unit = "mm³/mm",
        ),
        // Corner reinforcement
        WaveOverhangOption(
            key = "wave_overhang_corner_taper_enable",
            group = WaveOptionGroup.CORNER,
            kind = WaveOptionKind.BOOL,
            engineDefault = false,
            labelRes = R.string.wave_opt_corner_enable,
        ),
        WaveOverhangOption(
            key = "wave_overhang_line_spacing_corner",
            group = WaveOptionGroup.CORNER,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_corner_spacing,
            min = 0.0, max = 2.0, step = 0.01, unit = "mm",
            requires = listOf("wave_overhang_corner_taper_enable"),
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_corner_taper_distance",
            group = WaveOptionGroup.CORNER,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_corner_distance,
            min = 0.0, max = 20.0, step = 0.5, unit = "mm",
            requires = listOf("wave_overhang_corner_taper_enable"),
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_corner_angle_threshold",
            group = WaveOptionGroup.CORNER,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 90.0,
            labelRes = R.string.wave_opt_corner_angle,
            min = 10.0, max = 180.0, step = 5.0, unit = "°",
            requires = listOf("wave_overhang_corner_taper_enable"),
        ),
        // Motion
        WaveOverhangOption(
            key = "wave_overhang_print_speed",
            group = WaveOptionGroup.MOTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 2.0,
            labelRes = R.string.wave_opt_print_speed,
            min = 0.1, step = 0.5, unit = "mm/s",
        ),
        WaveOverhangOption(
            key = "wave_overhang_perimeter_speed",
            group = WaveOptionGroup.MOTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_perimeter_speed,
            min = 0.0, max = 1000.0, step = 1.0, unit = "mm/s",
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_travel_speed",
            group = WaveOptionGroup.MOTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 40.0,
            labelRes = R.string.wave_opt_travel_speed,
            min = 1.0, step = 5.0, unit = "mm/s",
        ),
        WaveOverhangOption(
            key = "wave_overhang_end_retract_length",
            group = WaveOptionGroup.MOTION,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_end_retract,
            min = 0.0, max = 10.0, step = 0.1, unit = "mm",
            passthrough = 0.0,
        ),
        // Cooling
        WaveOverhangOption(
            key = "wave_overhang_fan_speed",
            group = WaveOptionGroup.COOLING,
            kind = WaveOptionKind.INT,
            engineDefault = 100,
            labelRes = R.string.wave_opt_fan_speed,
            min = 0.0, max = 100.0, step = 5.0, unit = "%",
        ),
        WaveOverhangOption(
            key = "wave_overhang_aux_fan_speed",
            group = WaveOptionGroup.COOLING,
            kind = WaveOptionKind.INT,
            engineDefault = -1,
            labelRes = R.string.wave_opt_aux_fan_speed,
            min = -1.0, max = 100.0, step = 5.0, unit = "%",
            passthrough = -1.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_nozzle_temp",
            group = WaveOptionGroup.COOLING,
            kind = WaveOptionKind.INT,
            engineDefault = 0,
            labelRes = R.string.wave_opt_nozzle_temp,
            min = 0.0, max = 350.0, step = 5.0, unit = "°C",
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_min_wave_time",
            group = WaveOptionGroup.COOLING,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_min_wave_time,
            min = 0.0, max = 60.0, step = 0.5, unit = "s",
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_min_layer_time",
            group = WaveOptionGroup.COOLING,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_min_layer_time,
            min = 0.0, max = 300.0, step = 1.0, unit = "s",
            passthrough = 0.0,
        ),
        // Floor layers
        WaveOverhangOption(
            key = "wave_overhang_floor_layers",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = 2,
            labelRes = R.string.wave_opt_floor_layers,
            min = 0.0, max = 20.0, step = 1.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_use_hilbert",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.BOOL,
            engineDefault = false,
            labelRes = R.string.wave_opt_floor_hilbert,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_hilbert_layers",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = 0,
            labelRes = R.string.wave_opt_floor_hilbert_layers,
            min = 0.0, max = 20.0, step = 1.0,
            requires = listOf("wave_overhang_floor_use_hilbert"),
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_hilbert_density",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = 100,
            labelRes = R.string.wave_opt_floor_hilbert_density,
            min = 1.0, max = 100.0, step = 5.0, unit = "%",
            requires = listOf("wave_overhang_floor_use_hilbert"),
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_print_speed",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_floor_print_speed,
            min = 0.0, max = 1000.0, step = 1.0, unit = "mm/s",
            requires = listOf("wave_overhang_floor_use_hilbert"),
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_perimeter_speed",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.FLOAT,
            engineDefault = 0.0,
            labelRes = R.string.wave_opt_floor_perimeter_speed,
            min = 0.0, max = 1000.0, step = 1.0, unit = "mm/s",
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_speed_ramp",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = 0,
            labelRes = R.string.wave_opt_floor_speed_ramp,
            min = 0.0, max = 64.0, step = 1.0,
            passthrough = 0.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_fan_speed",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = -1,
            labelRes = R.string.wave_opt_floor_fan_speed,
            min = -1.0, max = 100.0, step = 5.0, unit = "%",
            requires = listOf("wave_overhang_floor_use_hilbert"),
            passthrough = -1.0,
        ),
        WaveOverhangOption(
            key = "wave_overhang_floor_aux_fan_speed",
            group = WaveOptionGroup.FLOOR,
            kind = WaveOptionKind.INT,
            engineDefault = -1,
            labelRes = R.string.wave_opt_floor_aux_fan_speed,
            min = -1.0, max = 100.0, step = 5.0, unit = "%",
            requires = listOf("wave_overhang_floor_use_hilbert"),
            passthrough = -1.0,
        ),
        // Debug
        WaveOverhangOption(
            key = "wave_overhang_debug_gcode",
            group = WaveOptionGroup.DEBUG,
            kind = WaveOptionKind.BOOL,
            engineDefault = true,
            labelRes = R.string.wave_opt_debug_gcode,
        ),
    )

    val OPTIONS_BY_KEY: Map<String, WaveOverhangOption> = OPTIONS.associateBy { it.key }

    fun isWaveOverhangKey(key: String): Boolean =
        key.startsWith("wave_overhang") || key == "support_remaining_areas_after_wave_overhangs"

    fun choiceLabelRes(choice: String): Int = when (choice) {
        "smart" -> R.string.wave_choice_smart
        "monotonic" -> R.string.wave_choice_monotonic
        "zigzag" -> R.string.wave_choice_zigzag
        "alternating" -> R.string.wave_choice_alternating
        "aligned" -> R.string.wave_choice_aligned
        "random" -> R.string.wave_choice_random
        "uniform" -> R.string.wave_choice_uniform
        "progressive" -> R.string.wave_choice_progressive
        else -> R.string.wave_choice_smart
    }

    fun parseValue(option: WaveOverhangOption, raw: Any?): Any? {
        if (raw == null) return null
        return when (option.kind) {
            WaveOptionKind.BOOL -> when (raw) {
                is Boolean -> raw
                1, "1", "true" -> true
                0, "0", "false" -> false
                else -> null
            }
            WaveOptionKind.INT -> when (raw) {
                is Number -> raw.toInt()
                is String -> raw.trim().toIntOrNull()
                else -> null
            }
            WaveOptionKind.FLOAT -> when (raw) {
                is Number -> raw.toDouble()
                is String -> raw.trim().toDoubleOrNull()
                else -> null
            }
            WaveOptionKind.ENUM -> {
                val str = raw.toString()
                if (option.choices?.contains(str) == true) str else null
            }
        }
    }

    fun serializeValue(option: WaveOverhangOption, value: Any): String {
        return when (option.kind) {
            WaveOptionKind.BOOL -> if (value == true) "1" else "0"
            WaveOptionKind.INT -> (value as? Number)?.toInt()?.toString() ?: value.toString()
            WaveOptionKind.FLOAT -> {
                val d = (value as? Number)?.toDouble() ?: 0.0
                if (d == d.toLong().toDouble()) d.toLong().toString()
                else String.format(java.util.Locale.US, "%.6f", d).trimEnd('0').trimEnd('.')
            }
            WaveOptionKind.ENUM -> value.toString()
        }
    }

    fun waveValueProblemRes(option: WaveOverhangOption, value: Any): Int? {
        when (option.kind) {
            WaveOptionKind.BOOL -> if (value !is Boolean) return R.string.wave_problem_bool
            WaveOptionKind.ENUM -> if (value !is String || option.choices?.contains(value) != true) return R.string.wave_problem_choice
            WaveOptionKind.INT -> {
                val num = (value as? Number)?.toDouble() ?: return R.string.wave_problem_integer
                if (option.min != null && num < option.min) return R.string.wave_problem_number
                if (option.max != null && num > option.max) return R.string.wave_problem_number
            }
            WaveOptionKind.FLOAT -> {
                val num = (value as? Number)?.toDouble() ?: return R.string.wave_problem_number
                if (option.min != null && num < option.min) return R.string.wave_problem_number
                if (option.max != null && num > option.max) return R.string.wave_problem_number
            }
        }
        return null
    }

    fun resolve(snapshot: ProjectSettingsOverrideSnapshot): WaveSettingsState {
        val inherited = MiniJson.parseMap(snapshot.inheritedConfigJson)
        val overrides = MiniJson.parseMap(snapshot.overridesJson)
        val effective = MiniJson.parseMap(snapshot.effectiveConfigJson)

        val resolvedValues = mutableMapOf<String, Pair<Any, WaveValueSource>>()
        for (option in OPTIONS) {
            val (v, source) = when {
                overrides.containsKey(option.key) -> {
                    val parsed = parseValue(option, overrides[option.key])
                    if (parsed != null) parsed to WaveValueSource.OVERRIDE else option.engineDefault to WaveValueSource.OVERRIDE
                }
                inherited.containsKey(option.key) -> {
                    val parsed = parseValue(option, inherited[option.key])
                    if (parsed != null) parsed to WaveValueSource.INHERITED else option.engineDefault to WaveValueSource.INHERITED
                }
                else -> option.engineDefault to WaveValueSource.DEFAULT
            }
            resolvedValues[option.key] = v to source
        }

        val masterOn = resolvedValues[MASTER_KEY]?.first == true

        val optionStates = OPTIONS.map { option ->
            val (value, source) = resolvedValues[option.key]!!
            val applies = option.key == MASTER_KEY || (masterOn && (option.requires ?: emptyList()).all {
                resolvedValues[it]?.first == true
            })
            WaveOptionState(option, value, source, applies)
        }

        val allKeys = (inherited.keys + overrides.keys).toSet()
        val hasOverrides = overrides.keys.any { isWaveOverhangKey(it) }
        val unknownKeys = allKeys.filter { isWaveOverhangKey(it) && !OPTIONS_BY_KEY.containsKey(it) }.sorted()

        val notices = mutableListOf<WaveNotice>()
        val detectWall = when (val raw = effective["detect_overhang_wall"]) {
            null -> true
            is Boolean -> raw
            0, "0", "false" -> false
            else -> true
        }
        if (!detectWall) {
            notices.add(
                WaveNotice(
                    id = "detect-overhang-wall-off",
                    messageRes = R.string.wave_notice_detect_overhang,
                    fixId = "enable-overhang-detection",
                    fixRes = R.string.wave_notice_turn_on,
                )
            )
        }
        val walls = when (val raw = effective["wall_loops"]) {
            null -> 2
            is Number -> raw.toInt()
            is String -> raw.trim().toIntOrNull() ?: 2
            else -> 2
        }
        if (walls < 1) {
            notices.add(
                WaveNotice(
                    id = "no-walls",
                    messageRes = R.string.wave_notice_no_walls,
                )
            )
        }
        val spiral = when (val raw = effective["spiral_mode"]) {
            null -> false
            is Boolean -> raw
            1, "1", "true" -> true
            else -> false
        }
        if (spiral) {
            notices.add(
                WaveNotice(
                    id = "spiral-vase",
                    messageRes = R.string.wave_notice_spiral_vase,
                )
            )
        }
        if (unknownKeys.isNotEmpty()) {
            notices.add(
                WaveNotice(
                    id = "unknown-keys",
                    messageRes = R.string.wave_notice_remove_unknown,
                    fixId = "remove-unknown",
                    fixRes = R.string.wave_notice_remove_unknown,
                )
            )
        }

        return WaveSettingsState(
            enabled = masterOn,
            options = optionStates,
            hasOverrides = hasOverrides,
            unknownKeys = unknownKeys,
            notices = notices,
        )
    }

    fun withValue(overridesJson: String, key: String, value: Any): String {
        val map = MiniJson.parseMap(overridesJson).toMutableMap()
        val option = OPTIONS_BY_KEY[key] ?: return overridesJson
        map[key] = serializeValue(option, value)
        return MiniJson.serializeMap(map)
    }

    fun withoutValue(overridesJson: String, key: String): String {
        val map = MiniJson.parseMap(overridesJson).toMutableMap()
        map.remove(key)
        return MiniJson.serializeMap(map)
    }

    fun withoutOverrides(overridesJson: String): String {
        val map = MiniJson.parseMap(overridesJson).filterKeys { !isWaveOverhangKey(it) }
        return MiniJson.serializeMap(map)
    }

    fun withNoticeFix(overridesJson: String, fixId: String): String {
        val map = MiniJson.parseMap(overridesJson).toMutableMap()
        when (fixId) {
            "enable-overhang-detection" -> map["detect_overhang_wall"] = "1"
            "remove-unknown" -> {
                val toRemove = map.keys.filter { isWaveOverhangKey(it) && !OPTIONS_BY_KEY.containsKey(it) }
                for (k in toRemove) map.remove(k)
            }
        }
        return MiniJson.serializeMap(map)
    }
}

internal object MiniJson {
    fun parseMap(text: String): Map<String, Any?> {
        val trimmed = text.trim()
        if (trimmed.length < 2 || !trimmed.startsWith("{") || !trimmed.endsWith("}")) return emptyMap()
        val result = mutableMapOf<String, Any?>()
        var i = 1
        val len = trimmed.length - 1

        fun skipWs() {
            while (i < len && trimmed[i].isWhitespace()) i++
        }

        fun parseString(): String? {
            if (i >= len || trimmed[i] != '"') return null
            i++
            val sb = StringBuilder()
            while (i < len) {
                val c = trimmed[i++]
                if (c == '"') return sb.toString()
                if (c == '\\') {
                    if (i >= len) return null
                    when (val esc = trimmed[i++]) {
                        '"', '\\', '/' -> sb.append(esc)
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000c')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (i + 4 > len) return null
                            val hex = trimmed.substring(i, i + 4)
                            i += 4
                            val code = hex.toIntOrNull(16) ?: return null
                            sb.append(code.toChar())
                        }
                        else -> sb.append(esc)
                    }
                } else {
                    sb.append(c)
                }
            }
            return null
        }

        while (i < len) {
            skipWs()
            if (i >= len) break
            if (trimmed[i] == ',') { i++; continue }
            val key = parseString() ?: break
            skipWs()
            if (i >= len || trimmed[i] != ':') break
            i++
            skipWs()
            if (i >= len) break
            val value: Any? = when {
                trimmed[i] == '"' -> parseString()
                trimmed.startsWith("true", i) -> { i += 4; true }
                trimmed.startsWith("false", i) -> { i += 5; false }
                trimmed.startsWith("null", i) -> { i += 4; null }
                else -> {
                    val start = i
                    while (i < len && trimmed[i] != ',' && trimmed[i] != '}' && !trimmed[i].isWhitespace()) i++
                    val token = trimmed.substring(start, i)
                    token.toIntOrNull() ?: token.toDoubleOrNull() ?: token
                }
            }
            result[key] = value
            skipWs()
            if (i < len && trimmed[i] == ',') i++
        }
        return result
    }

    fun serializeMap(map: Map<String, Any?>): String {
        val entries = map.entries.map { (k, v) ->
            val serializedValue = when (v) {
                null -> "null"
                is Boolean -> v.toString()
                is Number -> v.toString()
                is String -> "\"${escape(v)}\""
                else -> "\"${escape(v.toString())}\""
            }
            "\"${escape(k)}\":$serializedValue"
        }
        return "{${entries.joinToString(",")}}"
    }

    private fun escape(s: String): String {
        val sb = StringBuilder()
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                else -> {
                    if (c.code < 32) sb.append(String.format(java.util.Locale.US, "\\u%04x", c.code))
                    else sb.append(c)
                }
            }
        }
        return sb.toString()
    }
}
