package dev.orcaxr.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Roadmap B7 — most-recently-used model files, persisted across
 * sessions. Powers the empty-state Import panel's "Recent" row so a
 * user who slices the same model repeatedly doesn't have to navigate
 * the full picker every time.
 *
 * Storage shape: a single Preferences string under `recents_json`
 * holding a JSON array of `{path, label, openedAtMs}` records,
 * newest-first. Capped at [MAX_ENTRIES] = 12 so the row stays scannable
 * at a glance and the JSON blob stays small even after a long session.
 *
 * Files that no longer exist on disk (user deleted them, removable
 * media unmounted) are filtered out at read time — see [validRecents]
 * — so the UI doesn't surface stale paths the user can't actually open.
 *
 * Equality is by absolute path, so re-opening the same file bumps it
 * to the top instead of double-listing.
 */
class RecentFilesStore(ctx: Context) {

    private val store = ctx.applicationContext.recentFilesDataStore

    /** All recents, newest-first, including stale entries. Use
     *  [validRecents] from the UI when you need a "files that exist
     *  right now" view. */
    val all: Flow<List<RecentFile>> = store.data.map { prefs ->
        RecentFilesCodec.decode(prefs[KEY] ?: "[]")
    }

    /** Filtered to entries whose underlying file still exists. */
    val validRecents: Flow<List<RecentFile>> = all.map { list ->
        list.filter { runCatching { File(it.path).exists() }.getOrDefault(false) }
    }

    /**
     * Add (or move-to-front) [file] in the recents list. Idempotent:
     * adding the same path twice keeps a single entry whose
     * [openedAtMs] is the newer call. Capped at [MAX_ENTRIES] —
     * the oldest entry is dropped on overflow.
     */
    suspend fun add(file: File, label: String = file.name, nowMs: Long = System.currentTimeMillis()) {
        val absolute = runCatching { file.absoluteFile.canonicalFile.absolutePath }
            .getOrDefault(file.absolutePath)
        store.edit { prefs ->
            val current = RecentFilesCodec.decode(prefs[KEY] ?: "[]")
            val next = RecentFilesCodec.upsert(current, RecentFile(absolute, label, nowMs))
            prefs[KEY] = RecentFilesCodec.encode(next)
        }
    }

    /** Drop the entry pointing at [path], if any. */
    suspend fun remove(path: String) {
        store.edit { prefs ->
            val current = RecentFilesCodec.decode(prefs[KEY] ?: "[]")
            val next = current.filter { it.path != path }
            prefs[KEY] = RecentFilesCodec.encode(next)
        }
    }

    /** Wipe the entire recents list. */
    suspend fun clear() {
        store.edit { prefs -> prefs.remove(KEY) }
    }

    companion object {
        const val MAX_ENTRIES = 12
        internal val KEY = stringPreferencesKey("recents_json")
    }
}

/**
 * Pure encode/decode/upsert helpers for the recents list. Factored out
 * of [RecentFilesStore] so the JSON shape and the cap-and-de-dupe rule
 * are unit-testable without spinning up a DataStore Context.
 */
internal object RecentFilesCodec {
    fun encode(list: List<RecentFile>): String {
        val arr = JSONArray()
        for (e in list) {
            val o = JSONObject()
            o.put("path", e.path)
            o.put("label", e.label)
            o.put("openedAtMs", e.openedAtMs)
            arr.put(o)
        }
        return arr.toString()
    }

    fun decode(raw: String): List<RecentFile> = runCatching {
        val arr = JSONArray(raw)
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val path = o.optString("path", "").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            RecentFile(
                path = path,
                label = o.optString("label", File(path).name),
                openedAtMs = o.optLong("openedAtMs", 0L),
            )
        }
    }.getOrDefault(emptyList())

    /**
     * Insert [next] at the head, drop any existing entry with the same
     * path so re-opening a file bumps it to the top instead of double-
     * listing, and trim the result to [RecentFilesStore.MAX_ENTRIES].
     */
    fun upsert(current: List<RecentFile>, next: RecentFile): List<RecentFile> {
        val without = current.filter { it.path != next.path }
        return (listOf(next) + without).take(RecentFilesStore.MAX_ENTRIES)
    }
}

/** One entry in the recents list. */
data class RecentFile(
    val path: String,
    val label: String,
    val openedAtMs: Long,
)

private val Context.recentFilesDataStore by preferencesDataStore("orcaxr.recent_files")
