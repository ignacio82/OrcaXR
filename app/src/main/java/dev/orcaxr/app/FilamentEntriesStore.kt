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
 * One filament loaded into the project's palette. Mirrors how Snapmaker
 * OrcaSlicer's filament tab models the U1's 4-tool toolchanger:
 * filaments are *project-level* (you add as many as the model uses),
 * and each filament is mapped to one of the printer's physical slots
 * (0-based: slot 0 = T0 = first toolhead).
 *
 * Multiple filaments mapping to the same slot is *not* allowed at the
 * UI level — assigning slot N to filament A bumps any prior occupant
 * of slot N to "unassigned" (slotIndex = null). Unassigned filaments
 * are still in the palette but don't drive a printer slot.
 */
data class FilamentEntry(
    val id: String,
    val color: String,        // "#RRGGBB"
    /** 0..(extruderCount-1) inclusive, or null for unassigned. */
    val slotIndex: Int?,
    /**
     * Material type — fixed enum picker per Snapmaker's Android fork
     * convention (`FilamentScreen.kt`, line 251). Drives nozzle/bed
     * temp defaults when we eventually wire per-filament temp
     * overrides. Default PLA covers the typical case.
     */
    val filamentType: String = "Generic PLA",
    /**
     * Physical printer slot (0-based, T0 = 0) that should print this
     * project filament. Null = identity (project filament index N
     * prints on physical T_N). Set when the user explicitly picks
     * one of the printer's "Loaded in printer" swatches in the inline
     * color picker — that's the user's signal to "use whatever spool
     * is loaded at T_M for this project filament" regardless of slot
     * order. mergedConfig translates this into the libslic3r
     * `filament_map` config key (1-based) so painted facets at index
     * N emit the matching physical T-number in G-code instead of T_N.
     * Cleared back to null whenever the user re-edits color via the
     * manual-hex / common-colors paths, since those don't carry a
     * physical-slot signal.
     */
    val physicalSlot: Int? = null,
    /**
     * FullSpectrum virtual mixed-filament target (1-based row index in
     * the active printer's MixedFilamentStore list). Null = no virtual
     * remap (the project filament prints either via [physicalSlot] or
     * via identity). Non-null means this project filament should paint
     * its painted faces with virtual mixed-filament K — at slice time
     * the JNI layer rewrites the painted face state from this slot's
     * 1-based index to (num_physical + K), libslic3r's PrintApply
     * picks up that ID via painted_regions, and ToolOrdering's
     * resolve_mixed_1based alternates the underlying physical
     * extruder per layer (LayerCycle mode). Cleared whenever the user
     * picks a physical color again (mutually exclusive with
     * [physicalSlot]'s "loaded in printer" intent).
     */
    val virtualSlot: Int? = null,
)

/** (FILAMENT_TYPES removed, dynamically sourced from OrcaProfileLoader) */

/**
 * DataStore-backed list of [FilamentEntry] per printer. Replaces the
 * fixed-4-swatch model in [FilamentSlotsStore] with a variable-length
 * project palette + explicit slot mapping. Same persistence pattern
 * as the existing stores: Preferences DataStore + JSON via org.json.
 *
 * On first read for a printer that has no saved entries, callers get
 * an empty list — the UI can then seed it with one entry per slot
 * using the default palette so the user has something to start from.
 */
class FilamentEntriesStore(ctx: Context) {

    private val store = ctx.applicationContext.filamentEntriesDataStore

    val all: Flow<Map<String, List<FilamentEntry>>> = store.data.map { prefs ->
        decode(prefs[KEY] ?: "{}")
    }

    /**
     * Replace the entry list for [printerId] with [entries]. The store
     * doesn't enforce uniqueness — callers should de-conflict slot
     * assignments before writing (the UI does this).
     */
    suspend fun set(printerId: String, entries: List<FilamentEntry>) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "{}").toMutableMap()
            current[printerId] = entries
            prefs[KEY] = encode(current)
        }
    }

    /**
     * Build a slot palette from the entries. For slot index 0..count-1,
     * return the color of the (single) entry mapped there, or null if
     * unassigned. Callers can fall back to a default palette for null
     * slots — see [FilamentSlotsStore.pad] for the convention.
     */
    fun slotPalette(entries: List<FilamentEntry>, count: Int): List<String?> {
        val out = arrayOfNulls<String>(count)
        for (e in entries) {
            val s = e.slotIndex ?: continue
            if (s in 0 until count) out[s] = e.color
        }
        return out.toList()
    }

    private fun encode(byPrinter: Map<String, List<FilamentEntry>>): String {
        val obj = JSONObject()
        for ((id, entries) in byPrinter) {
            val arr = JSONArray()
            for (e in entries) {
                val o = JSONObject()
                o.put("id", e.id)
                o.put("color", e.color)
                if (e.slotIndex != null) o.put("slot", e.slotIndex)
                o.put("type", e.filamentType)
                if (e.physicalSlot != null) o.put("physical_slot", e.physicalSlot)
                if (e.virtualSlot != null) o.put("virtual_slot", e.virtualSlot)
                arr.put(o)
            }
            obj.put(id, arr)
        }
        return obj.toString()
    }

    private fun decode(raw: String): Map<String, List<FilamentEntry>> = runCatching {
        val obj = JSONObject(raw)
        val out = mutableMapOf<String, List<FilamentEntry>>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val printerId = keys.next()
            val arr = obj.optJSONArray(printerId) ?: continue
            val entries = (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                FilamentEntry(
                    id = o.optString("id", "f_$i"),
                    color = o.optString("color", "#FFFFFF"),
                    slotIndex = if (o.has("slot")) o.optInt("slot", -1).takeIf { it >= 0 } else null,
                    filamentType = o.optString("type", "Generic PLA").ifBlank { "Generic PLA" }.let {
                        when (it) {
                            "PLA" -> "Generic PLA"
                            "PETG" -> "Generic PETG"
                            "ABS" -> "Generic ABS"
                            "TPU" -> "Generic TPU"
                            "ASA" -> "Generic ASA"
                            "PA" -> "Generic PA"
                            "PVA" -> "Generic PVA"
                            else -> it
                        }
                    },
                    physicalSlot = if (o.has("physical_slot")) o.optInt("physical_slot", -1).takeIf { it >= 0 } else null,
                    virtualSlot = if (o.has("virtual_slot")) o.optInt("virtual_slot", -1).takeIf { it >= 1 } else null,
                )
            }
            out[printerId] = entries
        }
        out
    }.getOrDefault(emptyMap())

    companion object {
        private val KEY = stringPreferencesKey("entries_json")
    }
}

private val Context.filamentEntriesDataStore by preferencesDataStore("orcaxr.filament_entries")
