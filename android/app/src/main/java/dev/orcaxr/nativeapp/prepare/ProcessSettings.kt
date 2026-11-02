package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectSettingsOverrideSnapshot
import dev.orcaxr.nativeapp.R

/**
 * The essential print and process settings that operators frequently adjust
 * before slicing (Brim / Bed Adhesion, Supports, Infill, Walls), matching
 * desktop OrcaSlicer's Process panel and the browser's Process card.
 */
data class PrintProcessSettings(
    // Brim / Bed Adhesion
    val brimType: String = ProcessSettings.BRIM_TYPE_AUTO,
    val brimWidthMm: Double = ProcessSettings.DEFAULT_BRIM_WIDTH_MM,
    val brimObjectGapMm: Double = ProcessSettings.DEFAULT_BRIM_GAP_MM,
    val brimOverridden: Boolean = false,

    // Supports
    val enableSupport: Boolean = false,
    val supportType: String = ProcessSettings.SUPPORT_TYPE_NORMAL_AUTO,
    val supportStyle: String = ProcessSettings.SUPPORT_STYLE_DEFAULT,
    val supportOnBuildPlateOnly: Boolean = false,
    val supportThresholdAngle: Double = ProcessSettings.DEFAULT_SUPPORT_THRESHOLD_ANGLE,
    val supportTopZDistanceMm: Double = ProcessSettings.DEFAULT_SUPPORT_TOP_Z_MM,
    val supportOverridden: Boolean = false,

    // Quality & Strength
    val sparseInfillDensity: String = ProcessSettings.DEFAULT_INFILL_DENSITY,
    val wallLoops: Int = ProcessSettings.DEFAULT_WALL_LOOPS,

    // Metadata
    val totalOverridesCount: Int = 0,
    val hasOverrides: Boolean = false,
) {
    val isBrimDisabled: Boolean get() = brimType == ProcessSettings.BRIM_TYPE_NO_BRIM
}

object ProcessSettings {
    // Brim Types
    const val BRIM_TYPE_AUTO = "auto_brim"
    const val BRIM_TYPE_NO_BRIM = "no_brim"
    const val BRIM_TYPE_OUTER_ONLY = "outer_only"
    const val BRIM_TYPE_INNER_ONLY = "inner_only"
    const val BRIM_TYPE_OUTER_AND_INNER = "outer_and_inner"
    const val BRIM_TYPE_MOUSE_EARS = "brim_ears"

    val BRIM_TYPES = listOf(
        BRIM_TYPE_AUTO to R.string.settings_brim_type_auto,
        BRIM_TYPE_NO_BRIM to R.string.settings_brim_type_no_brim,
        BRIM_TYPE_OUTER_ONLY to R.string.settings_brim_type_outer_only,
        BRIM_TYPE_INNER_ONLY to R.string.settings_brim_type_inner_only,
        BRIM_TYPE_OUTER_AND_INNER to R.string.settings_brim_type_outer_and_inner,
        BRIM_TYPE_MOUSE_EARS to R.string.settings_brim_type_mouse_ears,
    )

    // Support Types
    const val SUPPORT_TYPE_NORMAL_AUTO = "normal(auto)"
    const val SUPPORT_TYPE_TREE_AUTO = "tree(auto)"
    const val SUPPORT_TYPE_NORMAL_MANUAL = "normal(manual)"
    const val SUPPORT_TYPE_TREE_MANUAL = "tree(manual)"

    val SUPPORT_TYPES = listOf(
        SUPPORT_TYPE_NORMAL_AUTO to R.string.settings_support_type_normal_auto,
        SUPPORT_TYPE_TREE_AUTO to R.string.settings_support_type_tree_auto,
        SUPPORT_TYPE_NORMAL_MANUAL to R.string.settings_support_type_normal_manual,
        SUPPORT_TYPE_TREE_MANUAL to R.string.settings_support_type_tree_manual,
    )

    // Support Styles
    const val SUPPORT_STYLE_DEFAULT = "default"
    const val SUPPORT_STYLE_SNUG = "snug"
    const val SUPPORT_STYLE_TREE_SLIM = "tree_slim"
    const val SUPPORT_STYLE_TREE_STRONG = "tree_strong"
    const val SUPPORT_STYLE_TREE_HYBRID = "tree_hybrid"
    const val SUPPORT_STYLE_ORGANIC = "organic"

    val SUPPORT_STYLES = listOf(
        SUPPORT_STYLE_DEFAULT to R.string.settings_support_style_default,
        SUPPORT_STYLE_SNUG to R.string.settings_support_style_snug,
        SUPPORT_STYLE_TREE_SLIM to R.string.settings_support_style_tree_slim,
        SUPPORT_STYLE_TREE_STRONG to R.string.settings_support_style_tree_strong,
        SUPPORT_STYLE_TREE_HYBRID to R.string.settings_support_style_tree_hybrid,
        SUPPORT_STYLE_ORGANIC to R.string.settings_support_style_organic,
    )

    const val DEFAULT_BRIM_WIDTH_MM = 5.0
    const val DEFAULT_BRIM_GAP_MM = 0.1
    const val DEFAULT_SUPPORT_THRESHOLD_ANGLE = 30.0
    const val DEFAULT_SUPPORT_TOP_Z_MM = 0.2
    const val DEFAULT_INFILL_DENSITY = "15%"
    const val DEFAULT_WALL_LOOPS = 2

    // Slicing Keys
    const val KEY_BRIM_TYPE = "brim_type"
    const val KEY_BRIM_WIDTH = "brim_width"
    const val KEY_BRIM_OBJECT_GAP = "brim_object_gap"
    const val KEY_ENABLE_SUPPORT = "enable_support"
    const val KEY_SUPPORT_TYPE = "support_type"
    const val KEY_SUPPORT_STYLE = "support_style"
    const val KEY_SUPPORT_ON_BUILD_PLATE_ONLY = "support_on_build_plate_only"
    const val KEY_SUPPORT_THRESHOLD_ANGLE = "support_threshold_angle"
    const val KEY_SUPPORT_TOP_Z_DISTANCE = "support_top_z_distance"
    const val KEY_SPARSE_INFILL_DENSITY = "sparse_infill_density"
    const val KEY_WALL_LOOPS = "wall_loops"

    private val PROCESS_SETTING_KEYS = setOf(
        KEY_BRIM_TYPE,
        KEY_BRIM_WIDTH,
        KEY_BRIM_OBJECT_GAP,
        KEY_ENABLE_SUPPORT,
        KEY_SUPPORT_TYPE,
        KEY_SUPPORT_STYLE,
        KEY_SUPPORT_ON_BUILD_PLATE_ONLY,
        KEY_SUPPORT_THRESHOLD_ANGLE,
        KEY_SUPPORT_TOP_Z_DISTANCE,
        KEY_SPARSE_INFILL_DENSITY,
        KEY_WALL_LOOPS,
    )

    /**
     * Resolves current effective print settings from project snapshot maps.
     */
    fun resolve(snapshot: ProjectSettingsOverrideSnapshot): PrintProcessSettings {
        val inherited = MiniJson.parseMap(snapshot.inheritedConfigJson)
        val overrides = MiniJson.parseMap(snapshot.overridesJson)
        val effective = MiniJson.parseMap(snapshot.effectiveConfigJson)

        fun stringVal(key: String, default: String): String {
            val raw = effective[key] ?: overrides[key] ?: inherited[key]
            return when (raw) {
                null -> default
                is String -> raw.trim()
                is List<*> -> raw.firstOrNull()?.toString()?.trim() ?: default
                else -> raw.toString()
            }
        }

        fun boolVal(key: String, default: Boolean): Boolean {
            val raw = effective[key] ?: overrides[key] ?: inherited[key]
            return when (raw) {
                null -> default
                is Boolean -> raw
                0, "0", "false" -> false
                1, "1", "true" -> true
                is List<*> -> boolVal(raw.firstOrNull()?.toString().orEmpty(), default)
                else -> default
            }
        }

        fun doubleVal(key: String, default: Double): Double {
            val raw = effective[key] ?: overrides[key] ?: inherited[key]
            return when (raw) {
                null -> default
                is Number -> raw.toDouble()
                is String -> raw.trim().toDoubleOrNull() ?: default
                is List<*> -> (raw.firstOrNull() as? Number)?.toDouble() ?: default
                else -> default
            }
        }

        fun intVal(key: String, default: Int): Int {
            val raw = effective[key] ?: overrides[key] ?: inherited[key]
            return when (raw) {
                null -> default
                is Number -> raw.toInt()
                is String -> raw.trim().toIntOrNull() ?: default
                is List<*> -> (raw.firstOrNull() as? Number)?.toInt() ?: default
                else -> default
            }
        }

        val brimType = stringVal(KEY_BRIM_TYPE, BRIM_TYPE_AUTO)
        val brimWidthMm = doubleVal(KEY_BRIM_WIDTH, DEFAULT_BRIM_WIDTH_MM)
        val brimObjectGapMm = doubleVal(KEY_BRIM_OBJECT_GAP, DEFAULT_BRIM_GAP_MM)
        val brimOverridden = overrides.containsKey(KEY_BRIM_TYPE) || overrides.containsKey(KEY_BRIM_WIDTH)

        val enableSupport = boolVal(KEY_ENABLE_SUPPORT, false)
        val supportType = stringVal(KEY_SUPPORT_TYPE, SUPPORT_TYPE_NORMAL_AUTO)
        val supportStyle = stringVal(KEY_SUPPORT_STYLE, SUPPORT_STYLE_DEFAULT)
        val supportOnPlateOnly = boolVal(KEY_SUPPORT_ON_BUILD_PLATE_ONLY, false)
        val supportThresholdAngle = doubleVal(KEY_SUPPORT_THRESHOLD_ANGLE, DEFAULT_SUPPORT_THRESHOLD_ANGLE)
        val supportTopZDistanceMm = doubleVal(KEY_SUPPORT_TOP_Z_DISTANCE, DEFAULT_SUPPORT_TOP_Z_MM)
        val supportOverridden = overrides.containsKey(KEY_ENABLE_SUPPORT) || overrides.containsKey(KEY_SUPPORT_TYPE) || overrides.containsKey(KEY_SUPPORT_STYLE)

        val infillDensity = stringVal(KEY_SPARSE_INFILL_DENSITY, DEFAULT_INFILL_DENSITY)
        val wallLoops = intVal(KEY_WALL_LOOPS, DEFAULT_WALL_LOOPS)

        return PrintProcessSettings(
            brimType = brimType,
            brimWidthMm = brimWidthMm,
            brimObjectGapMm = brimObjectGapMm,
            brimOverridden = brimOverridden,
            enableSupport = enableSupport,
            supportType = supportType,
            supportStyle = supportStyle,
            supportOnBuildPlateOnly = supportOnPlateOnly,
            supportThresholdAngle = supportThresholdAngle,
            supportTopZDistanceMm = supportTopZDistanceMm,
            supportOverridden = supportOverridden,
            sparseInfillDensity = infillDensity,
            wallLoops = wallLoops,
            totalOverridesCount = overrides.size,
            hasOverrides = overrides.isNotEmpty(),
        )
    }

    /**
     * Updates one setting in the overrides JSON text, formatting as engine string.
     */
    fun withValue(overridesJson: String, key: String, value: Any): String {
        val map = MiniJson.parseMap(overridesJson).toMutableMap()
        val serialized = when (value) {
            is Boolean -> if (value) "1" else "0"
            is Number -> if (value is Double || value is Float) String.format(java.util.Locale.US, "%.2f", value.toDouble()).trimEnd('0').trimEnd('.') else value.toString()
            else -> value.toString()
        }
        map[key] = serialized
        return MiniJson.serializeMap(map)
    }

    /**
     * Removes one setting from the overrides JSON text, reverting it to inherited.
     */
    fun withoutValue(overridesJson: String, key: String): String {
        val map = MiniJson.parseMap(overridesJson).toMutableMap()
        map.remove(key)
        return MiniJson.serializeMap(map)
    }

    /**
     * Removes all process settings from the overrides JSON text.
     */
    fun withoutOverrides(overridesJson: String): String {
        val map = MiniJson.parseMap(overridesJson).filterKeys { it !in PROCESS_SETTING_KEYS }
        return MiniJson.serializeMap(map)
    }
}
