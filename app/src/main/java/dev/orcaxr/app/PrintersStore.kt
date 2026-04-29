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
 * Persistent record for one Moonraker-speaking printer on the user's
 * LAN. `host` may be an IP, a `.local` mDNS name, or a full URL with
 * scheme — [MoonrakerClient.baseUrl] copes with all three. `apiKey` is
 * optional; default Moonraker installs on a trusted LAN don't require
 * one, but Snapmaker's stock firmware tends to set one.
 */
data class PrinterConfig(
    val id: String,
    val name: String,
    val host: String,
    val port: Int = 7125,           // Moonraker's standard port
    val apiKey: String? = null,
)

/**
 * DataStore-backed list of configured printers. Mirrors
 * [UserProfilesStore]'s pattern: single Preferences string holding a
 * JSON array, encoded with `org.json` to avoid the
 * kotlinx.serialization Gradle plugin.
 */
class PrintersStore(ctx: Context) {

    private val store = ctx.applicationContext.printersDataStore

    val printers: Flow<List<PrinterConfig>> = store.data.map { prefs ->
        decode(prefs[KEY] ?: "[]")
    }

    suspend fun upsert(printer: PrinterConfig) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]").toMutableList()
            current.removeAll { it.id == printer.id }
            current.add(printer)
            prefs[KEY] = encode(current)
        }
    }

    suspend fun delete(id: String) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]")
            prefs[KEY] = encode(current.filterNot { it.id == id })
        }
    }

    private fun encode(printers: List<PrinterConfig>): String {
        val arr = JSONArray()
        for (p in printers) {
            val obj = JSONObject()
            obj.put("id", p.id)
            obj.put("name", p.name)
            obj.put("host", p.host)
            obj.put("port", p.port)
            if (!p.apiKey.isNullOrBlank()) obj.put("apiKey", p.apiKey)
            arr.put(obj)
        }
        return arr.toString()
    }

    private fun decode(raw: String): List<PrinterConfig> = runCatching {
        val arr = JSONArray(raw)
        buildList {
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                add(
                    PrinterConfig(
                        id = obj.getString("id"),
                        name = obj.optString("name", obj.getString("id")),
                        host = obj.optString("host", ""),
                        port = obj.optInt("port", 7125),
                        apiKey = obj.optString("apiKey", "").ifBlank { null },
                    ),
                )
            }
        }
    }.getOrDefault(emptyList())

    companion object {
        private val KEY = stringPreferencesKey("printers_json")
    }
}

private val Context.printersDataStore by preferencesDataStore("orcaxr.printers")
