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
 * A11 — DataStore-backed store of custom-gcode ticks per plate.
 *
 * Ticks are per-plate (matches libslic3r's
 * `Model::plates_custom_gcodes` map). Storing per-plate keeps the
 * round-trip clean: a saved 3MF carries one plate's ticks; reopening
 * restores them on the same plate index.
 *
 * The DataStore lives in `orcaxr.custom_gcode` and stores a single
 * JSON object keyed by plate id (1-based to match `PlateMetadata.id`).
 *
 * In-session edits route through MainActivity's `customGcodeTicks`
 * StateFlow (mirrored into [WorkspaceModel]); persistence happens on
 * each mutation. App restart re-hydrates the StateFlow from this
 * store.
 */
class CustomGcodeStore(ctx: Context) {

    private val store = ctx.applicationContext.customGcodeDataStore

    /**
     * Live map of plate-id → tick list. Plates with no authored ticks
     * are absent from the map (rather than mapped to an empty list)
     * so callers can use `Map.getOrDefault(emptyList())` cheaply.
     */
    val ticksByPlate: Flow<Map<Int, List<SlicerEngine.CustomGcodeTick>>> =
        store.data.map { prefs ->
            decode(prefs[KEY] ?: "{}")
        }

    /** Replace the tick list for one plate. Empty list deletes the entry. */
    suspend fun set(plateId: Int, ticks: List<SlicerEngine.CustomGcodeTick>) {
        store.edit { prefs ->
            val cur = decode(prefs[KEY] ?: "{}").toMutableMap()
            if (ticks.isEmpty()) cur.remove(plateId)
            else cur[plateId] = ticks
            prefs[KEY] = encode(cur)
        }
    }

    /** Append one tick to a plate's list (sorted by Z when read). */
    suspend fun add(plateId: Int, tick: SlicerEngine.CustomGcodeTick) {
        store.edit { prefs ->
            val cur = decode(prefs[KEY] ?: "{}").toMutableMap()
            val list = cur[plateId] ?: emptyList()
            cur[plateId] = (list + tick).sortedBy { it.printZmm }
            prefs[KEY] = encode(cur)
        }
    }

    /** Remove the tick at [index] from [plateId]'s list. No-op if out of range. */
    suspend fun removeAt(plateId: Int, index: Int) {
        store.edit { prefs ->
            val cur = decode(prefs[KEY] ?: "{}").toMutableMap()
            val list = cur[plateId] ?: return@edit
            if (index !in list.indices) return@edit
            val updated = list.toMutableList().apply { removeAt(index) }
            if (updated.isEmpty()) cur.remove(plateId) else cur[plateId] = updated
            prefs[KEY] = encode(cur)
        }
    }

    /** Wipe all ticks on a plate. */
    suspend fun clear(plateId: Int) {
        store.edit { prefs ->
            val cur = decode(prefs[KEY] ?: "{}").toMutableMap()
            cur.remove(plateId)
            prefs[KEY] = encode(cur)
        }
    }

    private fun encode(map: Map<Int, List<SlicerEngine.CustomGcodeTick>>): String {
        val root = JSONObject()
        for ((plateId, ticks) in map) {
            val arr = JSONArray()
            for (t in ticks) arr.put(JSONObject().apply {
                put("z_mm", t.printZmm.toDouble())
                put("kind", t.kind.name)
                put("extruder", t.extruder)
                put("color", t.color)
                put("extra", t.extra)
            })
            root.put(plateId.toString(), arr)
        }
        return root.toString()
    }

    private fun decode(raw: String): Map<Int, List<SlicerEngine.CustomGcodeTick>> = runCatching {
        val root = JSONObject(raw)
        val out = HashMap<Int, List<SlicerEngine.CustomGcodeTick>>()
        val keys = root.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val plateId = k.toIntOrNull() ?: continue
            val arr = root.optJSONArray(k) ?: continue
            val list = ArrayList<SlicerEngine.CustomGcodeTick>(arr.length())
            for (i in 0 until arr.length()) {
                val t = arr.optJSONObject(i) ?: continue
                val kindRaw = t.optString("kind", "")
                val kind = runCatching {
                    SlicerEngine.CustomGcodeKind.valueOf(kindRaw)
                }.getOrNull() ?: continue
                list += SlicerEngine.CustomGcodeTick(
                    printZmm = t.optDouble("z_mm", 0.0).toFloat(),
                    kind = kind,
                    extruder = t.optInt("extruder", 0),
                    color = t.optString("color", ""),
                    extra = t.optString("extra", ""),
                )
            }
            if (list.isNotEmpty()) out[plateId] = list.sortedBy { it.printZmm }
        }
        out
    }.getOrDefault(emptyMap())

    companion object {
        private val KEY = stringPreferencesKey("custom_gcode_ticks_json")
    }
}

private val Context.customGcodeDataStore by preferencesDataStore("orcaxr.custom_gcode")
