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
 * DataStore-backed catalog of *user-defined* slicer profiles. The
 * built-in catalog (`Profiles.all`) is hard-coded and lives in source;
 * this store carries whatever the user saved on top — typically a
 * tweaked variant of a built-in (different layer height, custom
 * filament temps, etc.) with a name they'll recognize next session.
 *
 * Persistence shape: a single Preferences string keyed under
 * `profiles_json` containing a JSON array of objects with keys
 * `id`, `name`, `desc`, `config` (an object of String→String). Each
 * `id` is unique app-wide; saving a profile with an existing id
 * overwrites it (matches "Save" / "Save As" semantics with the same
 * name → upsert).
 *
 * We use `org.json` (Android stdlib) rather than kotlinx.serialization
 * to avoid pulling in the serialization gradle plugin for a single
 * structured record. The shape is small enough that hand-rolled
 * encoding is cheaper than another build dependency.
 */
class UserProfilesStore(ctx: Context) {

    private val appCtx = ctx.applicationContext
    private val store = appCtx.userProfilesDataStore

    /** Current set of saved profiles. Empty until the user saves one. */
    val profiles: Flow<List<SlicerProfile>> = store.data.map { prefs ->
        decode(prefs[KEY] ?: "[]")
    }

    /** Insert or update a profile by id. */
    suspend fun upsert(profile: SlicerProfile) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]").toMutableList()
            current.removeAll { it.id == profile.id }
            current.add(profile)
            prefs[KEY] = encode(current)
        }
    }

    /** Remove a profile by id. No-op if it doesn't exist. */
    suspend fun delete(id: String) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "[]")
            prefs[KEY] = encode(current.filterNot { it.id == id })
        }
    }

    private fun encode(profiles: List<SlicerProfile>): String {
        val arr = JSONArray()
        for (p in profiles) {
            val obj = JSONObject()
            obj.put("id", p.id)
            obj.put("name", p.displayName)
            obj.put("desc", p.description)
            val cfg = JSONObject()
            for ((k, v) in p.config) cfg.put(k, v)
            obj.put("config", cfg)
            arr.put(obj)
        }
        return arr.toString()
    }

    private fun decode(raw: String): List<SlicerProfile> = runCatching {
        val arr = JSONArray(raw)
        buildList {
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val cfgObj = obj.optJSONObject("config") ?: JSONObject()
                val cfg = mutableMapOf<String, String>()
                val keys = cfgObj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    cfg[k] = cfgObj.optString(k, "")
                }
                add(
                    SlicerProfile(
                        id = obj.getString("id"),
                        displayName = obj.optString("name", obj.getString("id")),
                        description = obj.optString("desc", ""),
                        config = cfg.toMap(),
                    ),
                )
            }
        }
    }.getOrDefault(emptyList())

    companion object {
        private val KEY = stringPreferencesKey("profiles_json")
    }
}

// File-level extension so we get one DataStore instance per Context;
// Preferences DataStore demands a single owner per name.
private val Context.userProfilesDataStore by preferencesDataStore("orcaxr.user_profiles")
