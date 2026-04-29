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
     * Off by default — LINES still ship and read fine on Galaxy XR.
     */
    var toolpathTubes: Boolean
        get() = prefs.getBoolean(KEY_TOOLPATH_TUBES, false)
        set(value) {
            prefs.edit().putBoolean(KEY_TOOLPATH_TUBES, value).apply()
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
    }
}
