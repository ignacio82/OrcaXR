package dev.orcaxr.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

/**
 * Per-printer filament-slot color assignment. Mirrors how Snapmaker's
 * OrcaSlicer fork tracks the U1's 4 toolchanger spools — each slot has
 * a color the slicer feeds into `extruder_colour`, and Klipper's tool
 * macros consume the same value at print time so the right tool head
 * loads at the right point in the G-code.
 *
 * Storage shape: a single Preferences string under `slots_json`
 * holding a JSON object keyed by printer id, each value a JSON array
 * of color hex strings (with `#` prefix; `null` means "use the
 * profile default for that slot"):
 *
 * ```
 * {
 *   "printer_xyz": ["#FF6B00", "#7BC8FF", "#7BFFB1", "#FFD27B"],
 *   "printer_abc": ["#FFFFFF"]
 * }
 * ```
 *
 * On read, callers ask for `slotsFor(printerId, count)` and the store
 * returns the saved colors, padding with default-palette entries when
 * the printer's extruder count outgrew its saved config.
 */
class FilamentSlotsStore(ctx: Context) {

    private val store = ctx.applicationContext.filamentSlotsDataStore

    /**
     * Default palette, applied per-slot when the user hasn't set a
     * color yet. Matches the orcaXR2.png mockup roughly: a warm
     * orange first-tool, two cool tools, then a neutral fourth.
     */
    val defaultPalette: List<String> = listOf(
        "#FF6B00",  // orange
        "#7BC8FF",  // cyan
        "#7BFFB1",  // green
        "#FFD27B",  // amber
        "#C77DFF",  // violet
        "#FFFFFF",  // white
        "#1B1F23",  // dark
        "#FF7B7B",  // pink
    )

    val all: Flow<Map<String, List<String>>> = store.data.map { prefs ->
        decode(prefs[KEY] ?: "{}")
    }

    /** Replace the slot config for [printerId] with [colors]. */
    suspend fun set(printerId: String, colors: List<String>) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "{}").toMutableMap()
            current[printerId] = colors
            prefs[KEY] = encode(current)
        }
    }

    /**
     * Return [count] colors for the printer — the saved entries
     * padded to length with the default palette so the UI always has
     * something sensible to render when extruder_count grows
     * (printer reconfig, Snapmaker U1 → Centauri Carbon swap, etc.).
     */
    fun pad(saved: List<String>?, count: Int): List<String> {
        if (count <= 0) return emptyList()
        val out = ArrayList<String>(count)
        for (i in 0 until count) {
            val color = saved?.getOrNull(i)?.takeIf { it.isNotBlank() }
                ?: defaultPalette[i % defaultPalette.size]
            out += color
        }
        return out
    }

    private fun encode(slots: Map<String, List<String>>): String {
        val obj = JSONObject()
        for ((id, colors) in slots) {
            val arr = JSONArray()
            for (c in colors) arr.put(c)
            obj.put(id, arr)
        }
        return obj.toString()
    }

    private fun decode(raw: String): Map<String, List<String>> = runCatching {
        val obj = JSONObject(raw)
        val out = mutableMapOf<String, List<String>>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val arr = obj.optJSONArray(id) ?: continue
            val colors = (0 until arr.length()).map { arr.optString(it, "") }
                .filter { it.isNotBlank() }
            out[id] = colors
        }
        out
    }.getOrDefault(emptyMap())

    companion object {
        private val KEY = stringPreferencesKey("slots_json")
    }
}

private val Context.filamentSlotsDataStore by preferencesDataStore("orcaxr.filament_slots")
