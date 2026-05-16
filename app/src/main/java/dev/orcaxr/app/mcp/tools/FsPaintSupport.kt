package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AutoPaintImageEngine
import dev.orcaxr.app.FullSpectrumGamut
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.MixedFilamentEntry
import dev.orcaxr.app.mcp.ToolContext
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/**
 * M3 glue shared by the auto-paint tools: turn an opt-in
 * `use_full_spectrum` into (a) a wider quantization palette and (b)
 * materialized virtual `MixedFilamentEntry` rows persisted for the
 * active printer — the exact store seam `set_mixed_filament_row` /
 * "Match to my filaments" already ship in `main`.
 *
 * Physical-only stays the default. FS is **experimental**: it degrades
 * gracefully (physical-only + a stated reason) when there's no active
 * printer or no persistence seam, and a blend that can't fit under
 * [MAX_PAINT_SLOTS] falls back to its nearest physical slot — the paint
 * is always representable and sliceable.
 */
internal object FsPaintSupport {

    /** Narrow seam over the per-printer mixed-filament store so the
     *  tools stay unit-testable without an Android Context. */
    interface MixedRowStore {
        suspend fun get(printerId: String): List<MixedFilamentEntry>
        suspend fun set(printerId: String, rows: List<MixedFilamentEntry>)
    }

    /** Production adapter over [ToolContext.mixedFilaments]. */
    class CtxMixedRowStore(private val ctx: ToolContext) : MixedRowStore {
        override suspend fun get(printerId: String): List<MixedFilamentEntry> =
            ctx.mixedFilaments.all.first()[printerId].orEmpty()
        override suspend fun set(printerId: String, rows: List<MixedFilamentEntry>) =
            ctx.mixedFilaments.set(printerId, rows)
    }

    /**
     * @property paletteSlots feed to the (unchanged) quantizers.
     * @property built non-null only when FS is actually active; pass it
     *   back to [finalize].
     * @property note a human reason when FS was requested but degraded
     *   to physical-only (no printer / no store), else null.
     */
    data class Palette(
        val paletteSlots: List<AutoPaintImageEngine.PaletteSlot>,
        val built: FullSpectrumGamut.Built?,
        val note: String?,
    )

    fun resolvePalette(
        useFullSpectrum: Boolean,
        hexTaken: List<String>,
        store: MixedRowStore?,
        printerId: String?,
        mixStepPercent: Int = 10,
    ): Palette {
        val physical = AutoPaintImageEngine.paletteFromHex(hexTaken)
        if (!useFullSpectrum) return Palette(physical, null, null)
        if (store == null || printerId.isNullOrBlank()) {
            return Palette(
                physical, null,
                "full_spectrum requested but no active printer / store — applied " +
                    "physical-only. Select a printer and retry for FS blends.",
            )
        }
        val built = FullSpectrumGamut.build(hexTaken, mixStepPercent, MAX_PAINT_SLOTS)
        if (built.paletteSlots.size <= physical.size) {
            // No blend candidates fit (≤1 physical, or palette already
            // fills MAX_PAINT_SLOTS) — nothing FS can add.
            return Palette(
                physical, null,
                "full_spectrum had no representable blends for this palette — " +
                    "applied physical-only.",
            )
        }
        return Palette(built.paletteSlots, built, null)
    }

    data class Finalized(val paint: ByteArray, val report: JSONObject)

    /**
     * Materialize the blend placeholders the engine actually selected
     * into real virtual rows, persist them for [printerId], and rewrite
     * [paint] to the real painted-face ids.
     */
    suspend fun finalize(
        built: FullSpectrumGamut.Built,
        paint: ByteArray,
        store: MixedRowStore,
        printerId: String,
    ): Finalized {
        val used = HashSet<Int>()
        for (b in paint) {
            val s = b.toInt() and 0xff
            if (built.recipeOf[s] is dev.orcaxr.app.GamutMatcher.GamutRecipe.Blend) used.add(s)
        }
        val existing = store.get(printerId)
        val m = FullSpectrumGamut.materialize(used, built, existing)
        val remapped = FullSpectrumGamut.remapPaint(paint, built, m)
        if (used.isNotEmpty()) store.set(printerId, m.rows)

        val blends = JSONArray()
        for (slot in used.sorted()) {
            val r = built.recipeOf[slot]
            if (r !is dev.orcaxr.app.GamutMatcher.GamutRecipe.Blend) continue
            blends.put(JSONObject().apply {
                put("recipe", "${r.componentA1}+${r.componentB1}@${r.mixBPercent}%")
                put("predicted_color", built.predictedHexOf[slot] ?: JSONObject.NULL)
                put("painted_id", m.remap[slot] ?: JSONObject.NULL)
                put("fell_back_to_physical", slot in m.overflowed)
            })
        }
        val report = JSONObject().apply {
            put("full_spectrum", true)
            put("blends_used", blends)
            put("virtual_rows_total", m.rows.size)
            put("overflowed_to_physical", m.overflowed.size)
            put("experimental", true)
        }
        return Finalized(remapped, report)
    }
}
