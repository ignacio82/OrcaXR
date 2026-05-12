package dev.orcaxr.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Base64

/**
 * Roadmap B13 — full export/import of OrcaXR's persistent settings.
 *
 * **Why a single bundle:** OrcaXR persists its session state across
 * eleven discrete on-device stores (one SharedPreferences blob, ten
 * DataStore Preferences files). Cross-device sync, factory-wipe-then-
 * restore, and bug-report bundles all want a single artifact a user
 * can save / share / re-import. Without this they'd have to copy each
 * store's underlying file by hand — every Galaxy XR's filesystem is
 * read-only outside the app sandbox.
 *
 * **Round-trip fidelity:** the canonical-bundle path snapshots each
 * DataStore's underlying `.preferences_pb` file as a base64-encoded
 * blob (lossless — the file IS the persistent state). On the
 * SharedPreferences side, we walk the live key/value map. Both sides
 * carry an explicit `version` so a future schema break can be flagged
 * cleanly instead of silently restoring stale shapes.
 *
 * **Restart semantics:** import REPLACES on-disk state, but the
 * in-process DataStore objects cache their last-read state in memory.
 * After an import the caller MUST surface a "Restart OrcaXR" prompt;
 * we don't try to invalidate every flow because some stores compute
 * derived state at app boot (active profile, plate 1 default) that
 * would partially desync. The MCP tool returns `restart_required=true`
 * to make this explicit to a driving LLM.
 *
 * **Format (V1):**
 * ```
 * {
 *   "version": 1,
 *   "exported_at_ms": 1234567890000,
 *   "shared_preferences": {
 *     "orcaxr.prefs": {
 *       "<key>": { "type": "string"|"bool"|"int"|"long"|"float"|"set",
 *                  "value": <typed JSON> },
 *       …
 *     }
 *   },
 *   "datastore": {
 *     "orcaxr.plates":          { "encoding": "preferences_pb_base64", "data": "…" },
 *     "orcaxr.printers":        { "encoding": "preferences_pb_base64", "data": "…" },
 *     "orcaxr.filament_slots":  { …}, "orcaxr.filament_entries": { …},
 *     "orcaxr.user_profiles":   { …}, "orcaxr.mixed_filament":   { …},
 *     "orcaxr.custom_gcode":    { …}, "orcaxr.recent_files":     { …},
 *     "orcaxr.llm":             { …}, "orcaxr.mcp":              { …}
 *   }
 * }
 * ```
 *
 * The `encoding` field reserves space for a future structured
 * serialization (e.g. each store's domain model as JSON) without
 * breaking V1 readers — they just see an unknown encoding and skip
 * that store cleanly.
 */
object SettingsBackup {

    /** Version pin for the envelope. Bump when adding non-additive fields. */
    const val VERSION = 1

    /**
     * Canonical list of DataStore Preferences files OrcaXR persists.
     * Add a new entry here when a new `private val Context.xDataStore
     * by preferencesDataStore("orcaxr.X")` ships — the test in
     * SettingsBackupTest pins this list against a grep of the source
     * tree so missed updates fail loudly.
     */
    val DATASTORE_NAMES: List<String> = listOf(
        "orcaxr.plates",
        "orcaxr.printers",
        "orcaxr.filament_slots",
        "orcaxr.filament_entries",
        "orcaxr.user_profiles",
        "orcaxr.mixed_filament",
        "orcaxr.custom_gcode",
        "orcaxr.recent_files",
        "orcaxr.llm",
        "orcaxr.mcp",
        "orcaxr.remote_mcp",
    )

    /** Single SharedPreferences instance used by [UserPreferences]. */
    const val SHARED_PREFS_NAME: String = "orcaxr.prefs"

    /** Result of an [importJson] call. The UI / MCP tool surfaces these. */
    data class ImportReport(
        val storesRestored: Int,
        val sharedPrefKeysRestored: Int,
        val skippedUnknownEncodings: List<String>,
        val warnings: List<String>,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("stores_restored", storesRestored)
            put("shared_pref_keys_restored", sharedPrefKeysRestored)
            put("skipped_unknown_encodings", JSONArray(skippedUnknownEncodings))
            put("warnings", JSONArray(warnings))
            // Always true in V1 — see the type-doc rationale.
            put("restart_required", true)
        }
    }

    /**
     * Build the JSON envelope describing every persistent setting.
     * Pure file-system reads — no DataStore APIs touched, so this is
     * safe to call from any thread (the underlying `.preferences_pb`
     * is rewritten atomically by DataStore so a partial read can't
     * land mid-write).
     */
    fun exportJson(ctx: Context): JSONObject {
        val app = ctx.applicationContext
        val root = JSONObject()
        root.put("version", VERSION)
        root.put("exported_at_ms", System.currentTimeMillis())
        root.put("app_version_name", appVersionName(app))

        // SharedPreferences side — UserPreferences is the only one.
        val spJson = JSONObject()
        val sp = app.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
        val spEntries = JSONObject()
        for ((k, v) in sp.all) {
            spEntries.put(k, encodeSpValue(v))
        }
        spJson.put(SHARED_PREFS_NAME, spEntries)
        root.put("shared_preferences", spJson)

        // DataStore side — opaque base64 of the preferences_pb file.
        val dsJson = JSONObject()
        for (name in DATASTORE_NAMES) {
            val pb = preferencesPbFile(app, name)
            val entry = JSONObject()
            if (pb.exists() && pb.length() > 0) {
                entry.put("encoding", "preferences_pb_base64")
                entry.put(
                    "data",
                    Base64.getEncoder().encodeToString(pb.readBytes()),
                )
                entry.put("size_bytes", pb.length())
            } else {
                // Empty store — emit an explicit zero-length record so
                // import can still detect "this store was intentionally
                // empty in the export" vs "this store wasn't in the
                // export at all".
                entry.put("encoding", "preferences_pb_base64")
                entry.put("data", "")
                entry.put("size_bytes", 0)
            }
            dsJson.put(name, entry)
        }
        root.put("datastore", dsJson)
        return root
    }

    /**
     * Apply a previously-exported envelope to the device. Returns an
     * [ImportReport] summarizing what was restored / skipped.
     *
     * `mode = "merge"` keeps the user's current state and only overwrites
     * keys / stores explicitly present in the JSON. `mode = "replace"`
     * clears each persisted store before writing — useful for "reset to
     * a known-good state". Default is `merge` because that's safer for
     * cross-device sync.
     *
     * The caller should prompt the user to restart OrcaXR after import
     * (the [ImportReport] surfaces this via `restart_required` in JSON).
     */
    fun importJson(
        ctx: Context,
        json: JSONObject,
        mode: String = "merge",
    ): ImportReport {
        val app = ctx.applicationContext
        val warnings = mutableListOf<String>()
        val skipped = mutableListOf<String>()
        var storesRestored = 0
        var spKeysRestored = 0

        val ver = json.optInt("version", -1)
        if (ver < 1 || ver > VERSION) {
            warnings += "Unrecognized envelope version=$ver; expected 1..$VERSION"
            // We still try the rest — V1 readers should ignore unknown
            // top-level fields and surface a warning.
        }

        // SharedPreferences first — UserPreferences is the only one.
        val spRoot = json.optJSONObject("shared_preferences")
        if (spRoot != null) {
            val entries = spRoot.optJSONObject(SHARED_PREFS_NAME)
            if (entries != null) {
                val sp = app.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
                val editor = sp.edit()
                if (mode == "replace") editor.clear()
                val it = entries.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    val v = entries.optJSONObject(k) ?: continue
                    if (decodeSpInto(editor, k, v)) {
                        spKeysRestored++
                    } else {
                        warnings += "skipped shared-pref key '$k': unrecognized type"
                    }
                }
                editor.apply()
            }
        }

        // DataStore side — overwrite the .preferences_pb file directly.
        // DataStore process-singletons cache the previous read in memory,
        // which is why we mark restart_required=true below.
        val dsRoot = json.optJSONObject("datastore")
        if (dsRoot != null) {
            for (name in DATASTORE_NAMES) {
                val entry = dsRoot.optJSONObject(name) ?: continue
                val encoding = entry.optString("encoding", "")
                if (encoding != "preferences_pb_base64") {
                    skipped += name
                    continue
                }
                val raw = entry.optString("data", "")
                val pb = preferencesPbFile(app, name)
                pb.parentFile?.mkdirs()
                if (raw.isEmpty()) {
                    if (mode == "replace") pb.delete()
                    storesRestored++
                    continue
                }
                runCatching {
                    val bytes = Base64.getDecoder().decode(raw)
                    // Atomic-ish: write to .tmp, fsync via close, rename.
                    val tmp = File(pb.parentFile, "${pb.name}.import.tmp")
                    tmp.writeBytes(bytes)
                    if (pb.exists()) pb.delete()
                    if (!tmp.renameTo(pb)) {
                        tmp.copyTo(pb, overwrite = true); tmp.delete()
                    }
                    storesRestored++
                }.onFailure { e ->
                    warnings += "failed to restore $name: ${e.message}"
                }
            }
        }

        return ImportReport(
            storesRestored = storesRestored,
            sharedPrefKeysRestored = spKeysRestored,
            skippedUnknownEncodings = skipped,
            warnings = warnings,
        )
    }

    // --- internals --------------------------------------------------------

    /** Resolve the on-disk .preferences_pb path for a DataStore name. */
    fun preferencesPbFile(ctx: Context, name: String): File =
        File(ctx.filesDir, "datastore/$name.preferences_pb")

    /** Test seam — exposed `internal` so the unit test can pin
     *  per-type encoding without spinning up an Android Context. */
    internal fun encodeSpValueForTest(v: Any?): JSONObject = encodeSpValue(v)

    private fun encodeSpValue(v: Any?): JSONObject {
        val obj = JSONObject()
        when (v) {
            is Boolean -> { obj.put("type", "bool"); obj.put("value", v) }
            is Int -> { obj.put("type", "int"); obj.put("value", v) }
            is Long -> { obj.put("type", "long"); obj.put("value", v) }
            is Float -> { obj.put("type", "float"); obj.put("value", v.toDouble()) }
            is String -> { obj.put("type", "string"); obj.put("value", v) }
            is Set<*> -> {
                obj.put("type", "set")
                val arr = JSONArray()
                for (item in v) if (item is String) arr.put(item)
                obj.put("value", arr)
            }
            else -> {
                // Unknown types (Double, etc.) get stringified; restore
                // will skip them since the type tag won't match.
                obj.put("type", "unknown")
                obj.put("value", v?.toString() ?: "")
            }
        }
        return obj
    }

    /**
     * Apply one shared-pref key/value entry to the editor.
     * Returns true if the type was recognized; false if it was
     * skipped (caller surfaces the skipped count as a warning).
     */
    private fun decodeSpInto(
        editor: android.content.SharedPreferences.Editor,
        key: String,
        json: JSONObject,
    ): Boolean {
        return when (json.optString("type", "")) {
            "bool" -> { editor.putBoolean(key, json.optBoolean("value")); true }
            "int" -> { editor.putInt(key, json.optInt("value")); true }
            "long" -> { editor.putLong(key, json.optLong("value")); true }
            "float" -> { editor.putFloat(key, json.optDouble("value").toFloat()); true }
            "string" -> { editor.putString(key, json.optString("value")); true }
            "set" -> {
                val arr = json.optJSONArray("value") ?: return false
                val set = mutableSetOf<String>()
                for (i in 0 until arr.length()) set += arr.optString(i)
                editor.putStringSet(key, set); true
            }
            else -> false
        }
    }

    private fun appVersionName(ctx: Context): String =
        runCatching {
            val pkg = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            pkg.versionName ?: "unknown"
        }.getOrDefault("unknown")
}
