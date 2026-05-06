package dev.orcaxr.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Single-process key/value preferences. Phase 2 only stores the
 * last-used slicer profile id so the user doesn't have to re-pick
 * PLA Standard on every launch. When Phase 3 adds user-defined
 * profiles or printer connections, swap to DataStore — at that point
 * we'll be persisting structured records + flow-observing changes.
 */
class UserPreferences(ctx: Context) {

    private val prefs: SharedPreferences =
        ctx.applicationContext.getSharedPreferences("orcaxr.prefs", Context.MODE_PRIVATE)

    var lastProfileId: String?
        get() = prefs.getString(KEY_PROFILE_ID, null)
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_PROFILE_ID) else putString(KEY_PROFILE_ID, value)
            }.apply()
        }

    /**
     * Per-session overrides the user has typed into the right-panel
     * settings. Empty string means "no override, use the profile
     * default" — same convention as the runtime `MutableState<String>`.
     */
    var layerHeightOverride: String
        get() = prefs.getString(KEY_LAYER_HEIGHT_OVERRIDE, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_LAYER_HEIGHT_OVERRIDE, value).apply()
        }

    /** Whether the toolpath GLB renders travel segments. Off by default. */
    var showTravels: Boolean
        get() = prefs.getBoolean(KEY_SHOW_TRAVELS, false)
        set(value) {
            prefs.edit().putBoolean(KEY_SHOW_TRAVELS, value).apply()
        }

    /**
     * Roadmap A7 — when true, [ToolpathGlb.write] emits each extrusion
     * segment as a 4-sided rectangular prism (8 verts, 12 tris) instead
     * of a single LINE. Visually closer to desktop OrcaSlicer's GL
     * viewer at the cost of ~6× triangle count vs LINES; auto-falls
     * back to LINES above [ToolpathGlb.TUBES_SEGMENT_CAP] segments.
     *
     * Default flipped to ON because LINES on Galaxy XR's Filament
     * render as 1-pixel hairlines — for a typical 100K+ segment slice
     * (e.g. dragon.3mf) the densely overlapping anti-aliased pixels
     * blend to a hazy silver-gray and the role / extruder coloring
     * stops reading. Tubes give visible 3D extrusion shape with the
     * Lambert shading baked into vertex colors. The toggle in the
     * Layer Preview panel still lets users opt back to lines.
     */
    var toolpathTubes: Boolean
        get() = prefs.getBoolean(KEY_TOOLPATH_TUBES, true)
        set(value) {
            prefs.edit().putBoolean(KEY_TOOLPATH_TUBES, value).apply()
        }

    /**
     * Roadmap A13 — auto-position wipe tower toggle. When true,
     * `runSliceMulti` consults [WipeTowerPlacement.score] before
     * slicing and threads the picked X/Y into the slice config via
     * [wipeTowerXOverride] / [wipeTowerYOverride]. Off by default so
     * existing slices stay byte-identical to pre-A13.
     */
    var wipeTowerAutoPosition: Boolean
        get() = prefs.getBoolean(KEY_WIPE_TOWER_AUTO, false)
        set(value) {
            prefs.edit().putBoolean(KEY_WIPE_TOWER_AUTO, value).apply()
        }

    /**
     * Roadmap A13 — explicit override of `wipe_tower_x` (mm). Set by
     * the [WipeTowerPlacement.score]-driven path or by an MCP tool
     * call. NaN means "no override" (use the profile default).
     */
    var wipeTowerXOverride: Float
        get() = prefs.getFloat(KEY_WIPE_TOWER_X, Float.NaN)
        set(value) {
            prefs.edit().putFloat(KEY_WIPE_TOWER_X, value).apply()
        }

    /** Roadmap A13 — see [wipeTowerXOverride]. */
    var wipeTowerYOverride: Float
        get() = prefs.getFloat(KEY_WIPE_TOWER_Y, Float.NaN)
        set(value) {
            prefs.edit().putFloat(KEY_WIPE_TOWER_Y, value).apply()
        }

    /** Roadmap A14 — toolpath color mode. One of `auto` (default —
     * per-extruder if multi-tool, per-role otherwise), `extruder` (always
     * per-tool), or `feature` (always per-extrusion-role: outer wall vs
     * infill vs support, regardless of how many tools the slice used).
     * Persisted as a string so future modes don't break the schema.
     */
    var toolpathColorMode: String
        get() = prefs.getString(KEY_TOOLPATH_COLOR_MODE, "auto") ?: "auto"
        set(value) {
            val sanitized = when (value.lowercase()) {
                "extruder", "feature", "auto" -> value.lowercase()
                else -> "auto"
            }
            prefs.edit().putString(KEY_TOOLPATH_COLOR_MODE, sanitized).apply()
        }

    /**
     * Mobile shell (phone / tablet) theme override. 0 = follow system,
     * 1 = force dark, 2 = force light. Persisted across process death
     * so a user who flipped to dark on a phone with a light system
     * theme keeps dark on next launch. The XR shell ignores this —
     * it's always dark.
     */
    var mobileTheme: Int
        get() = prefs.getInt(KEY_MOBILE_THEME, 0)
        set(value) {
            prefs.edit().putInt(KEY_MOBILE_THEME, value.coerceIn(0, 2)).apply()
        }

    /** Currently-selected printer's id (the destination for "Send to printer" + the Project panel display). */
    var lastPrinterId: String?
        get() = prefs.getString(KEY_LAST_PRINTER_ID, null)
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_LAST_PRINTER_ID) else putString(KEY_LAST_PRINTER_ID, value)
            }.apply()
        }

    /** Resolve [lastProfileId] against [Profiles.all], falling back to the default. */
    fun lastProfileOrDefault(): SlicerProfile {
        val id = lastProfileId ?: return Profiles.default
        return Profiles.all.firstOrNull { it.id == id } ?: Profiles.default
    }

    /**
     * True on first launch (no saved profile id). Lets MainActivity
     * decide the seed profile from the *async-loaded* bundled catalog
     * — see [PREFERRED_DEFAULT_ID] in MainActivity. Without this we'd
     * always seed with [Profiles.default] (Elegoo) and the user would
     * have to manually swap to the Snapmaker U1 every fresh install.
     */
    val hasSelectedProfileBefore: Boolean
        get() = lastProfileId != null

    companion object {
        private const val KEY_PROFILE_ID = "last_profile_id"
        private const val KEY_LAYER_HEIGHT_OVERRIDE = "layer_height_override"
        private const val KEY_SHOW_TRAVELS = "show_travels"
        private const val KEY_LAST_PRINTER_ID = "last_printer_id"
        private const val KEY_TOOLPATH_TUBES = "toolpath_tubes"
        private const val KEY_TOOLPATH_COLOR_MODE = "toolpath_color_mode"
        private const val KEY_WIPE_TOWER_AUTO = "wipe_tower_auto"
        private const val KEY_WIPE_TOWER_X = "wipe_tower_x_override"
        private const val KEY_WIPE_TOWER_Y = "wipe_tower_y_override"
        private const val KEY_MOBILE_THEME = "mobile_theme"
    }
}
