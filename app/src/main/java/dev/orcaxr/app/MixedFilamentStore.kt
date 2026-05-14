package dev.orcaxr.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// FullSpectrum mixed-filament data model. Mirrors the MixedFilament struct
// from third_party/OrcaSlicer/src/libslic3r/MixedFilament.hpp (ported as
// patch 0015) at FullSpectrum v0.9.9 parity. A virtual "mixed" filament
// is two (or more) physical filaments combined via per-layer cadence and
// optionally same-layer XY pointillisme + Local-Z sub-layering, producing
// an apparent third color the eye averages.
//
// Until the libslic3r engine emission patches (0027-0034 — port of
// PrintObjectSlice / GCode / WipeTower2 / ToolOrdering) land, the slicer
// silently ignores virtual rows; OrcaXR can author and round-trip 3MFs
// with mixed-filament rows but the emitted G-code is still
// single-filament per assigned slot.
data class MixedFilamentEntry(
    /** Stable id — UUID-ish so painted MMU assignments survive list rebuilds. */
    val id: String,
    /** 1-based physical filament IDs (matches MixedFilament.hpp). */
    val componentA: Int,
    val componentB: Int,
    /** Layer-alternation ratio: ratioA layers of A then ratioB layers of B. */
    val ratioA: Int = 1,
    val ratioB: Int = 1,
    /** Blend percentage of component B in [0..100] — drives auto pattern. */
    val mixBPercent: Int = 50,
    /**
     * Signed UI bias in [-100..100]. Positive shifts cadence toward B by
     * recessing it slightly into the surface; negative does the same for A.
     * Translated to `component_a/b_surface_offset` (mm) at serialize time.
     */
    val biasPercent: Int = 0,
    /** Optional manual cycle pattern, e.g. "11112222" or "121212". */
    val manualPattern: String? = null,
    /**
     * Optional gradient component IDs as compact digits, e.g. "123" for
     * filaments 1+2+3 (3-way mix). Empty for the default 2-way A+B cadence.
     */
    val gradientComponentIds: String = "",
    /** Optional gradient weights as "/-joined ints, e.g. "50/25/25". */
    val gradientComponentWeights: String = "",
    /** Distribution mode: 0=LayerCycle, 1=SameLayerPointillisme, 2=Simple. */
    val distributionMode: Int = 0,
    /** Local-Z cap: 0 = disabled, otherwise max sublayers in painted zone. */
    val localZMaxSublayers: Int = 0,
    /** Legacy pointillism flag (predates distributionMode). */
    val pointillismAllFilaments: Boolean = false,
    /** Whether this row is exposed for assignment. */
    val enabled: Boolean = true,
    /** Tombstones a row so auto-regeneration doesn't bring it back. */
    val deleted: Boolean = false,
    /** True for user-authored / round-tripped rows; false for fresh auto-pairs. */
    val custom: Boolean = false,
    /** True when this row originated as an auto-generated pair. */
    val originAuto: Boolean = false,
    /** Cached blended color "#RRGGBB" — recomputed when components change. */
    val displayColor: String = "#FFFFFF",
)

private val Context.mixedFilamentDataStore by preferencesDataStore("orcaxr.mixed_filament")

/** Reference nozzle width used to convert UI bias-percent into mm-offset
 *  before serialization. The libslic3r side clamps to per-print
 *  reference_width at slice time (see surface_offset_pair_from_signed_bias
 *  in MixedFilament.cpp), so getting this wrong only affects the
 *  authored 3MF default — re-slicing with the actual nozzle re-clamps. */
private const val DEFAULT_NOZZLE_MM = 0.4f

/** Mirrors `max_component_surface_offset_mm` in MixedFilament.cpp. */
private fun maxBiasMm(referenceWidthMm: Float = DEFAULT_NOZZLE_MM): Float {
    val safe = max(0.05f, abs(referenceWidthMm))
    return min(0.35f, max(0.01f, safe))
}

/**
 * DataStore-backed list of [MixedFilamentEntry] per printer. Same
 * pattern as the other stores. Each printer ID maps to a JSON array
 * of mixed-filament rows.
 *
 * JSON format is versioned via the top-level `_v` key so future schema
 * bumps can migrate. v1 = pre-FS-v0.9.9 (component A/B + ratio + bias);
 * v2 = current (adds manual_pattern, gradient, distribution_mode,
 * local_z_max_sublayers, custom, originAuto). Older v1 blobs are
 * promoted on first read, defaults filled in.
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
                    custom = false,
                    originAuto = true,
                )
            }
        }
        return out
    }

    /** Instance method delegate — pure logic lives in the top-level
     *  [serializeMixedFilamentDefinitions] so tests can call it without
     *  paying for the DataStore-init cost in the constructor. */
    fun toMixedFilamentDefinitions(entries: List<MixedFilamentEntry>): String =
        serializeMixedFilamentDefinitions(entries)

    private fun encode(map: Map<String, List<MixedFilamentEntry>>): String {
        val root = JSONObject()
        root.put("_v", 2)
        for ((printerId, entries) in map) {
            val arr = JSONArray()
            for (e in entries) {
                arr.put(JSONObject().apply {
                    put("id", e.id)
                    put("a", e.componentA)
                    put("b", e.componentB)
                    put("ra", e.ratioA)
                    put("rb", e.ratioB)
                    put("mix_b", e.mixBPercent)
                    put("bias", e.biasPercent)
                    if (!e.manualPattern.isNullOrEmpty()) put("pat", e.manualPattern)
                    if (e.gradientComponentIds.isNotEmpty()) put("gids", e.gradientComponentIds)
                    if (e.gradientComponentWeights.isNotEmpty()) put("gw", e.gradientComponentWeights)
                    put("dm", e.distributionMode)
                    put("lzm", e.localZMaxSublayers)
                    if (e.pointillismAllFilaments) put("pall", true)
                    put("on", e.enabled)
                    put("del", e.deleted)
                    put("cust", e.custom)
                    put("oa", e.originAuto)
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
                if (k == "_v") continue
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
                        mixBPercent = o.optInt("mix_b", 50),
                        biasPercent = o.optInt("bias", 0),
                        manualPattern = o.optString("pat", "").ifEmpty { null },
                        gradientComponentIds = o.optString("gids", ""),
                        gradientComponentWeights = o.optString("gw", ""),
                        distributionMode = o.optInt("dm", 0),
                        localZMaxSublayers = o.optInt("lzm", 0),
                        pointillismAllFilaments = o.optBoolean("pall", false),
                        enabled = o.optBoolean("on", true),
                        deleted = o.optBoolean("del", false),
                        custom = o.optBoolean("cust", false),
                        originAuto = o.optBoolean("oa", false),
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
 * Serialize a mixed-filament list into the wire format that libslic3r's
 * `mixed_filament_definitions` config key expects. Mirrors
 * `MixedFilamentManager::serialize_custom_entries` in
 * `third_party/OrcaSlicer/src/libslic3r/MixedFilament.cpp` (FS v0.9.9):
 *
 *   row := A,B,enabled,custom,mix_b_pct,pointillism,
 *          gIDS,wWEIGHTS,mDIST,zZMAX,xaA_OFF,xbB_OFF,
 *          dDELETED,oORIGIN_AUTO,uSTABLE_ID[,manual_pattern]
 *   serialized := row(;row)*
 *
 * Tokens carry single/double-letter prefixes so the C++ parser can
 * round-trip future fields without breaking historical rows.
 *
 * `stable_id` is a 64-bit number that survives store round-trips so
 * painted MMU assignments stay anchored to the right virtual row. We
 * fold the Kotlin entry id (UUID-ish) into a positive 63-bit FNV-1a
 * hash so the libslic3r side gets something consistent.
 *
 * Pure function — no Context / DataStore dependency. Unit-testable.
 */
fun serializeMixedFilamentDefinitions(entries: List<MixedFilamentEntry>): String {
    if (entries.isEmpty()) return ""

    fun stableId64(s: String): Long {
        var hash = 0xcbf29ce484222325uL
        for (c in s) {
            hash = hash xor c.code.toULong()
            hash = (hash * 0x100000001b3uL)
        }
        return (hash.toLong() and Long.MAX_VALUE).coerceAtLeast(1L)
    }

    // Map signed UI bias to the (a_offset, b_offset) pair libslic3r expects.
    // Mirrors surface_offset_pair_from_signed_bias() in MixedFilament.cpp.
    fun offsetsForBias(biasPct: Int): Pair<Float, Float> {
        val maxMm = maxBiasMm()
        val biasMm = (biasPct.coerceIn(-100, 100) / 100f) * maxMm
        return when {
            biasMm > 1e-6f -> 0f to biasMm
            biasMm < -1e-6f -> -biasMm to 0f
            else -> 0f to 0f
        }
    }

    fun fmtOffset(v: Float): String = "%.4f".format(v).trimEnd('0').trimEnd('.').ifEmpty { "0" }

    return entries.joinToString(";") { e ->
        val (aOff, bOff) = offsetsForBias(e.biasPercent)
        val tokens = mutableListOf(
            e.componentA.toString(),
            e.componentB.toString(),
            if (e.enabled) "1" else "0",
            if (e.custom) "1" else "0",
            e.mixBPercent.coerceIn(0, 100).toString(),
            if (e.pointillismAllFilaments) "1" else "0",
            "g" + e.gradientComponentIds,
            "w" + e.gradientComponentWeights,
            "m" + e.distributionMode.coerceIn(0, 2).toString(),
            "z" + max(0, e.localZMaxSublayers).toString(),
            "xa" + fmtOffset(aOff),
            "xb" + fmtOffset(bOff),
            "d" + if (e.deleted) "1" else "0",
            "o" + if (e.originAuto) "1" else "0",
            "u" + stableId64(e.id).toString(),
        )
        val pat = e.manualPattern?.takeIf { it.isNotBlank() }
        if (pat != null) tokens += pat
        tokens.joinToString(",")
    }
}

/**
 * Compute the apparent blended color of [a] + [b] mixed at the
 * given layer ratio.
 *
 * Uses gamma-correct (sRGB-aware) blending: hex colors are decoded as
 * sRGB, expanded to linear light (γ ≈ 2.2), averaged by ratio, then
 * compressed back to sRGB. The naive linear-RGB midpoint of two
 * saturated hex colors produces a muddy mid-tone that's visually
 * indistinguishable across different pairs (orange+cyan vs orange+green
 * vs cyan+green all read as "muddy yellow-gray" at swatch size); the
 * gamma-correct midpoint stays brighter and more distinct, which is
 * what the eye expects when looking at two filaments alternating on
 * the bed.
 *
 * Still not the perceptual blend libslic3r's filament_mixer.cpp uses —
 * worth a JNI call once we expose it — but the gamma fix gets us 80% of
 * the visual quality for one floating-point pow.
 */
fun blendMixedColor(a: String, b: String, ratioA: Int, ratioB: Int): String {
    val ar = parseHex(a)
    val br = parseHex(b)
    val totalRatio = (ratioA + ratioB).coerceAtLeast(1)
    val wa = ratioA.toFloat() / totalRatio
    val wb = ratioB.toFloat() / totalRatio

    fun srgbToLinear(c: Int): Float {
        val s = c / 255f
        // Standard sRGB → linear transfer. The piecewise formula below is
        // the exact IEC 61966-2-1 form; for a UI swatch the simpler
        // pow(s, 2.2f) approximation would do, but the cost is identical
        // and this matches what Compose's Color.toLinear does internally.
        return if (s <= 0.04045f) s / 12.92f
        else Math.pow(((s + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
    }
    fun linearToSrgb(l: Float): Int {
        val s = if (l <= 0.0031308f) 12.92f * l
        else (1.055f * Math.pow(l.toDouble(), 1.0 / 2.4).toFloat() - 0.055f)
        return (s.coerceIn(0f, 1f) * 255f + 0.5f).toInt()
    }

    val rLin = srgbToLinear(ar.first) * wa + srgbToLinear(br.first) * wb
    val gLin = srgbToLinear(ar.second) * wa + srgbToLinear(br.second) * wb
    val bLin = srgbToLinear(ar.third) * wa + srgbToLinear(br.third) * wb
    return "#%02X%02X%02X".format(
        linearToSrgb(rLin).coerceIn(0, 255),
        linearToSrgb(gLin).coerceIn(0, 255),
        linearToSrgb(bLin).coerceIn(0, 255),
    )
}

private fun parseHex(s: String): Triple<Int, Int, Int> {
    val h = s.trimStart('#').padStart(6, '0').take(6)
    return Triple(
        h.substring(0, 2).toIntOrNull(16) ?: 255,
        h.substring(2, 4).toIntOrNull(16) ?: 255,
        h.substring(4, 6).toIntOrNull(16) ?: 255,
    )
}

private fun srgbToLinearByte(c: Int): Float {
    val s = c / 255f
    return if (s <= 0.04045f) s / 12.92f
    else Math.pow(((s + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
}

private fun linearToSrgbByte(l: Float): Int {
    val s = if (l <= 0.0031308f) 12.92f * l
    else (1.055f * Math.pow(l.toDouble(), 1.0 / 2.4).toFloat() - 0.055f)
    return (s.coerceIn(0f, 1f) * 255f + 0.5f).toInt()
}

/**
 * Blend an arbitrary set of hex colors by per-component weight using
 * the same gamma-correct mixing [blendMixedColor] uses for 2-way pairs.
 * Falls back to "#FFFFFF" when [components] is empty or every weight is
 * zero. Weights are normalized by their sum; they don't have to add to
 * any specific total.
 */
fun blendComponentsHex(components: List<Pair<String, Float>>): String {
    val nonZero = components.filter { it.second > 0f }
    if (nonZero.isEmpty()) return "#FFFFFF"
    val totalWeight = nonZero.sumOf { it.second.toDouble() }.toFloat()
    if (totalWeight <= 0f) return "#FFFFFF"
    var rLin = 0f; var gLin = 0f; var bLin = 0f
    for ((hex, weight) in nonZero) {
        val w = weight / totalWeight
        val (r, g, b) = parseHex(hex)
        rLin += srgbToLinearByte(r) * w
        gLin += srgbToLinearByte(g) * w
        bLin += srgbToLinearByte(b) * w
    }
    return "#%02X%02X%02X".format(
        linearToSrgbByte(rLin).coerceIn(0, 255),
        linearToSrgbByte(gLin).coerceIn(0, 255),
        linearToSrgbByte(bLin).coerceIn(0, 255),
    )
}

/**
 * Resolve a FullSpectrum [MixedFilamentEntry] into its blended display
 * color given the active base palette. Mirrors how desktop FullSpectrum
 * renders its filament-tab swatches and the per-sphere shading the user
 * sees in OrcaSlicer's preview.
 *
 * Resolution rules:
 *  - If the row carries a gradient (`gradientComponentIds` non-empty,
 *    each char is a 1-based filament id; `gradientComponentWeights` is
 *    a `/`-separated weight list), use those — pads missing weights to 1.
 *  - Else if a `manualPattern` is present (digits 1..9, one filament id
 *    per cycle slot), each digit contributes one unit of weight to its
 *    corresponding base filament.
 *  - Else fall back to the 2-way A+B cadence with weights derived from
 *    `ratioA` / `ratioB`, biased by `mixBPercent` (0..100 = pure A → pure B).
 *
 * Out-of-range base indices are silently dropped so a row that
 * references a filament beyond [basePalette]'s end doesn't crash —
 * caller gets the blend of whatever components ARE in range.
 */
fun resolveMixedRowDisplayColor(
    row: MixedFilamentEntry,
    basePalette: List<String>,
): String {
    fun base(idx1: Int): String? =
        basePalette.getOrNull(idx1 - 1)

    if (row.gradientComponentIds.isNotEmpty()) {
        val ids = row.gradientComponentIds.mapNotNull { ch ->
            ch.digitToIntOrNull()?.takeIf { it in 1..basePalette.size }
        }
        val rawWeights = row.gradientComponentWeights
            .split('/').mapNotNull { it.trim().toFloatOrNull() }
        val components = ids.mapIndexedNotNull { i, id ->
            val hex = base(id) ?: return@mapIndexedNotNull null
            val w = rawWeights.getOrNull(i) ?: 1f
            hex to w
        }
        if (components.isNotEmpty()) return blendComponentsHex(components)
    }
    val pattern = row.manualPattern
    if (!pattern.isNullOrBlank()) {
        val tally = mutableMapOf<Int, Float>()
        for (ch in pattern) {
            val id = ch.digitToIntOrNull() ?: continue
            tally[id] = (tally[id] ?: 0f) + 1f
        }
        val components = tally.entries.mapNotNull { (id, w) ->
            val hex = base(id) ?: return@mapNotNull null
            hex to w
        }
        if (components.isNotEmpty()) return blendComponentsHex(components)
    }
    val a = base(row.componentA)
    val b = base(row.componentB)
    if (a == null && b == null) return "#FFFFFF"
    // Use mixBPercent when the user authored a non-50% blend; otherwise
    // fall back to the ratioA/ratioB cadence. Matches how desktop FS
    // resolves a row's swatch (mix_b_pct wins when authored explicitly).
    val mixB = row.mixBPercent.coerceIn(0, 100)
    val wB = if (mixB != 50 || row.ratioA == row.ratioB) {
        mixB.toFloat() / 100f
    } else {
        row.ratioB.toFloat() / (row.ratioA + row.ratioB).coerceAtLeast(1).toFloat()
    }
    val wA = 1f - wB
    val components = buildList {
        if (a != null && wA > 0f) add(a to wA)
        if (b != null && wB > 0f) add(b to wB)
    }
    return if (components.isEmpty()) "#FFFFFF" else blendComponentsHex(components)
}

/**
 * Extend [basePalette] with one entry per [virtualRows] so painted-face
 * filament IDs greater than the base size resolve to a visible blend
 * color in the preview. Mirrors libslic3r's MixedFilamentManager
 * convention where filament id N+k (k >= 1) maps to virtual row k-1.
 *
 * Deleted rows are kept (their slot is replicated in the wire format —
 * see the long comment in parseMixedDefinitionsForKotlin — and the
 * libslic3r side still indexes into them). Disabled rows are also kept
 * so the painted-face IDs line up with the on-disk row indices.
 */
fun extendPaletteWithVirtualRows(
    basePalette: List<String>,
    virtualRows: List<MixedFilamentEntry>,
): List<String> {
    if (virtualRows.isEmpty()) return basePalette
    val extended = ArrayList<String>(basePalette.size + virtualRows.size)
    extended.addAll(basePalette)
    for (row in virtualRows) {
        extended.add(resolveMixedRowDisplayColor(row, basePalette))
    }
    return extended
}
