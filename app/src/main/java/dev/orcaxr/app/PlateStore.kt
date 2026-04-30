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
 * Metadata for one virtual build plate.
 */
data class PlateMetadata(
    val id: Int,
    val label: String,
    val createdAt: Long = System.currentTimeMillis()
)

/**
 * DataStore-backed list of virtual plates. Plate 1 is the "default"
 * plate and cannot be deleted.
 */
class PlateStore(ctx: Context) {

    private val store = ctx.applicationContext.plateDataStore

    val plates: Flow<List<PlateMetadata>> = store.data.map { prefs ->
        val list = decode(prefs[KEY] ?: "[]")
        // Ensure plate 1 always exists
        if (list.none { it.id == 1 }) {
            listOf(PlateMetadata(1, "Plate 1")) + list
        } else {
            list
        }
    }

    suspend fun upsert(plate: PlateMetadata) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]").toMutableList()
            current.removeAll { it.id == plate.id }
            current.add(plate)
            prefs[KEY] = encode(current)
        }
    }

    suspend fun delete(id: Int) {
        if (id == 1) return // Cannot delete plate 1
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]")
            prefs[KEY] = encode(current.filterNot { it.id == id })
        }
    }

    private fun encode(plates: List<PlateMetadata>): String {
        val arr = JSONArray()
        for (p in plates) {
            val obj = JSONObject()
            obj.put("id", p.id)
            obj.put("label", p.label)
            obj.put("createdAt", p.createdAt)
            arr.put(obj)
        }
        return arr.toString()
    }

    private fun decode(raw: String): List<PlateMetadata> = runCatching {
        val arr = JSONArray(raw)
        buildList {
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                add(
                    PlateMetadata(
                        id = obj.getInt("id"),
                        label = obj.getString("label"),
                        createdAt = obj.optLong("createdAt", System.currentTimeMillis())
                    ),
                )
            }
        }
    }.getOrDefault(emptyList())

    companion object {
        private val KEY = stringPreferencesKey("plates_json")
    }
}

private val Context.plateDataStore by preferencesDataStore("orcaxr.plates")
