package dev.orcaxr.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

// FullSpectrum mixed-filament panel data model. Mirrors the
// MixedFilament struct from
// third_party/OrcaSlicer/src/libslic3r/MixedFilament.hpp (ported as
// patch 0015): two physical filament IDs (1-based) combined via
// alternating-layer cadence to produce an apparent third color. This
// Kotlin shape stores only what the XR UI needs — the full C++ struct
// has 20+ fields covering local-Z dithering and pointillisme modes
// that we don't surface yet.
//
// Until the Print/PrintObject/GCode integration from FullSpectrum is
// also ported (see docs/FULLSPECTRUM_PORT_STATUS.md, phases 4-5),
// these definitions are stored locally and will be serialized into
// the `mixed_filament_definitions` config key (registered in patch
// 0016) — but the slicer doesn't read them yet, so a slice with
// mixed-filament rows still emits single-filament G-code per
// assigned slot. Wiring this properly requires the engine work.
data class MixedFilamentEntry(
    /** Stable id — UUID-ish so painted MMU assignments survive list rebuilds. */
    val id: String,
    /** 1-based physical filament IDs (matches MixedFilament.hpp). */
    val componentA: Int,
    val componentB: Int,
    /** Alternation ratio: ratioA layers of A then ratioB layers of B, repeating. */
    val ratioA: Int = 1,
    val ratioB: Int = 1,
    /** Optional bias percentage [-100..100] — recesses one component slightly to shift hue. */
    val biasPercent: Int = 0,
    /** Whether this row is exposed for assignment. */
    val enabled: Boolean = true,
    /** Tombstones a row so auto-regeneration doesn't bring it back. */
    val deleted: Boolean = false,
    /** Cached blended color "#RRGGBB" — recomputed when components change. */
    val displayColor: String = "#FFFFFF",
)

private val Context.mixedFilamentDataStore by preferencesDataStore("orcaxr.mixed_filament")

/**
 * DataStore-backed list of [MixedFilamentEntry] per printer. Same
 * pattern as the other stores. Each printer ID maps to a JSON array
 * of mixed-filament rows.
 */
class MixedFilamentStore(ctx: Context) {

    private val store = ctx.applicationContext.mixedFilamentDataStore
    private val KEY = stringPreferencesKey("entries_json")

    val all: Flow<Map<String, List<MixedFilamentEntry>>> = store.data.map { prefs ->
        decode(prefs[KEY] ?: "{}")
    }

    suspend fun set(printerId: String, entries: List<MixedFilamentEntry>) {
        store.edit { prefs ->
            val current = decode(prefs[KEY] ?: "{}").toMutableMap()
            current[printerId] = entries
            prefs[KEY] = encode(current)
        }
    }

    /**
     * Auto-generate one mixed-filament row per unordered physical-pair.
     * For N filaments, that's N*(N-1)/2 rows. Mirrors FullSpectrum's
     * sidebar default behavior. Caller stores them via [set].
     */
    fun autoGeneratePairs(physicalCount: Int): List<MixedFilamentEntry> {
        if (physicalCount < 2) return emptyList()
        val out = mutableListOf<MixedFilamentEntry>()
        for (a in 1..physicalCount) {
            for (b in (a + 1)..physicalCount) {
                out += MixedFilamentEntry(
                    id = "auto_${a}_${b}",
                    componentA = a,
                    componentB = b,
                )
            }
        }
        return out
    }

    /**
     * Serialize a printer's mixed-filament list into the wire format
     * that libslic3r's `mixed_filament_definitions` config key expects.
     * Mirrors `MixedFilamentManager::serialize_custom_entries` in
     * `third_party/OrcaSlicer/src/libslic3r/MixedFilament.cpp`:
     *
     *   row := A,B,enabled,custom,mix_b_pct,pointillism,
     *          gIDS,wWEIGHTS,mDIST,zZMAX,xaA_OFF,xbB_OFF,
     *          dDELETED,oORIGIN_AUTO,uSTABLE_ID[,manual_pattern]
     *   serialized := row(;row)*
     *
     * Tokens carry single/double-letter prefixes so the C++ parser can
     * round-trip future fields without breaking historical rows. We
     * only populate the fields the XR UI exposes — distribution_mode is
     * forced to 0 (LayerCycle, the simplest cadence), gradient lists
     * stay empty, surface offsets stay 0, pointillism is off. For a
     * future advanced-settings panel the rest can fan out.
     *
     * `stable_id` needs to be a 64-bit number that survives store
     * round-trips (it's how painted MMU assignments stay anchored to
     * the right virtual row across edits). The Kotlin entry id is a
     * UUID-ish string; we fold it into a positive 63-bit integer via
     * a stable hash so the libslic3r side gets something consistent.
     */
    fun toMixedFilamentDefinitions(entries: List<MixedFilamentEntry>): String {
        if (entries.isEmpty()) return ""

        fun stableId64(s: String): Long {
            // FNV-1a 64-bit. Keeps positive (drop sign bit).
            var hash = 0xcbf29ce484222325uL
            for (c in s) {
                hash = hash xor c.code.toULong()
                hash = (hash * 0x100000001b3uL)
            }
            return (hash.toLong() and Long.MAX_VALUE).coerceAtLeast(1L)
        }

        return entries.filter { !it.deleted }.joinToString(";") { e ->
            listOf(
                e.componentA.toString(),
                e.componentB.toString(),
                if (e.enabled) "1" else "0",
                "1",                              // custom = true (user / auto-pair we treat as live)
                e.biasPercent.coerceIn(0, 100).toString(),
                "0",                              // pointillism_all_filaments
                "g",                              // gradient_component_ids (empty)
                "w",                              // gradient_component_weights (empty)
                "m0",                             // distribution_mode = LayerCycle
                "z0",                             // local_z_max_sublayers
                "xa0",                            // component_a_surface_offset
                "xb0",                            // component_b_surface_offset
                "d" + (if (e.deleted) "1" else "0"),
                "o0",                             // origin_auto
                "u" + stableId64(e.id).toString(),
            ).joinToString(",")
        }
    }

    private fun encode(map: Map<String, List<MixedFilamentEntry>>): String {
        val root = JSONObject()
        for ((printerId, entries) in map) {
            val arr = JSONArray()
            for (e in entries) {
                arr.put(JSONObject().apply {
                    put("id", e.id)
                    put("a", e.componentA)
                    put("b", e.componentB)
                    put("ra", e.ratioA)
                    put("rb", e.ratioB)
                    put("bias", e.biasPercent)
                    put("on", e.enabled)
                    put("del", e.deleted)
                    put("color", e.displayColor)
                })
            }
            root.put(printerId, arr)
        }
        return root.toString()
    }

    private fun decode(s: String): Map<String, List<MixedFilamentEntry>> {
        if (s.isBlank()) return emptyMap()
        return runCatching {
            val root = JSONObject(s)
            val out = mutableMapOf<String, List<MixedFilamentEntry>>()
            val keys = root.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val arr = root.optJSONArray(k) ?: continue
                val list = mutableListOf<MixedFilamentEntry>()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    list += MixedFilamentEntry(
                        id = o.optString("id", "row_$i"),
                        componentA = o.optInt("a", 1),
                        componentB = o.optInt("b", 2),
                        ratioA = o.optInt("ra", 1),
                        ratioB = o.optInt("rb", 1),
                        biasPercent = o.optInt("bias", 0),
                        enabled = o.optBoolean("on", true),
                        deleted = o.optBoolean("del", false),
                        displayColor = o.optString("color", "#FFFFFF"),
                    )
                }
                out[k] = list
            }
            out
        }.getOrDefault(emptyMap())
    }
}

/**
 * Compute the apparent blended color of [a] + [b] mixed at the
 * given layer ratio. This is a simple linear RGB blend weighted by
 * the ratio — NOT the same as FullSpectrum's RYB-based
 * `filament_mixer_lerp` (which lives in the C++ side, patch 0015).
 * Acceptable for UI swatches at small scale; the printed result will
 * differ slightly. Worth swapping to a JNI call into filament_mixer
 * once we expose one.
 */
fun blendMixedColor(a: String, b: String, ratioA: Int, ratioB: Int): String {
    val ar = parseHex(a)
    val br = parseHex(b)
    val totalRatio = (ratioA + ratioB).coerceAtLeast(1)
    val wa = ratioA.toFloat() / totalRatio
    val wb = ratioB.toFloat() / totalRatio
    val r = (ar.first * wa + br.first * wb).toInt().coerceIn(0, 255)
    val g = (ar.second * wa + br.second * wb).toInt().coerceIn(0, 255)
    val bl = (ar.third * wa + br.third * wb).toInt().coerceIn(0, 255)
    return "#%02X%02X%02X".format(r, g, bl)
}

private fun parseHex(s: String): Triple<Int, Int, Int> {
    val h = s.trimStart('#').padStart(6, '0').take(6)
    return Triple(
        h.substring(0, 2).toIntOrNull(16) ?: 255,
        h.substring(2, 4).toIntOrNull(16) ?: 255,
        h.substring(4, 6).toIntOrNull(16) ?: 255,
    )
}
