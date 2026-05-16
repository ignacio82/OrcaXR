package dev.orcaxr.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * Smart Auto-Paint — M4: resolve a vision-LLM "paint plan" into a
 * full-coverage per-triangle slot assignment. PURE — no network, no
 * Android — so the orchestration tool stays thin and this is
 * unit-testable with a synthetic plan.
 *
 * Plan shape (what the vision model is asked to return):
 * ```
 * {
 *   "base_color": "#RRGGBB",                 // whole-model base
 *   "regions": [
 *     {"name": "stripe", "color": "#RRGGBB",
 *      "polygons": [[x1,y1,x2,y2,...], ...]}  // pixel coords in the
 *   ]                                         // rendered view's frame
 * }
 * ```
 *
 * Resolution: the base color fills every triangle (so the back / any
 * face the camera never saw is still covered — honest for a single
 * reference view); each region's polygons are rasterized in the
 * rendered view's pixel space and reverse-projected to triangles
 * ([AiMaskProjection], the same path `get_mask_for_text` uses), and
 * those triangles are overwritten with the region's color. Colors are
 * quantized to the perceptually-nearest filament slot via
 * [ColorScience] CIEDE2000 — the same metric M2 / `GamutMatcher` use.
 *
 * Coordinate / index invariants are M2's: camera in
 * `centered_preview_mm`, triangle ids in derived-STL order (==
 * `paintFilamentIndex`). Physical-only (FS deferred, M3).
 */
internal object SemanticPaintPlanner {

    data class RegionStat(val name: String, val slot: Int, val triangleCount: Int)

    data class Resolved(
        /** size = `bvh.triCount`, every entry a 1-based slot (full coverage). */
        val perTriangleSlot: ByteArray,
        val baseSlot: Int,
        val regions: List<RegionStat>,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Resolved) return false
            return perTriangleSlot.contentEquals(other.perTriangleSlot) &&
                baseSlot == other.baseSlot && regions == other.regions
        }

        override fun hashCode(): Int = perTriangleSlot.contentHashCode()
    }

    /**
     * @return null when the plan has no usable `base_color` or the
     *   palette is empty (the caller surfaces an error). Regions whose
     *   color is unparseable or whose polygons are degenerate / project
     *   to nothing are skipped (recorded with triangleCount 0) rather
     *   than failing the whole plan.
     */
    fun resolve(
        bvh: MeshBvh,
        camera: AiRenderEngine.CameraSpec,
        plan: JSONObject,
        palette: List<AutoPaintImageEngine.PaletteSlot>,
    ): Resolved? {
        val n = bvh.triCount
        if (n == 0 || palette.isEmpty()) return null
        if (camera.widthPx <= 0 || camera.heightPx <= 0) return null
        val baseLab = ColorScience.parseLab(plan.optString("base_color").trim()) ?: return null
        val baseSlot = nearestSlot(baseLab, palette)
        val out = ByteArray(n) { baseSlot.toByte() }

        val stats = ArrayList<RegionStat>()
        val regionsArr: JSONArray? = plan.optJSONArray("regions")
        if (regionsArr != null) {
            for (i in 0 until regionsArr.length()) {
                val r = regionsArr.optJSONObject(i) ?: continue
                val name = r.optString("name").trim().ifEmpty { "region_$i" }
                val colLab = ColorScience.parseLab(r.optString("color").trim())
                if (colLab == null) { stats.add(RegionStat(name, 0, 0)); continue }
                val slot = nearestSlot(colLab, palette)
                val polys = parsePolygons(r.optJSONArray("polygons"))
                if (polys.isEmpty()) { stats.add(RegionStat(name, slot, 0)); continue }
                val mask = AiMaskProjection.rasterizePolygons(polys, camera.widthPx, camera.heightPx)
                val tris = AiMaskProjection.project(
                    bvh = bvh, camera = camera, mask = mask,
                    depthMode = AiMaskProjection.DepthMode.FrontFacingOnly,
                    backFaceFilter = true,
                )
                for (t in tris) if (t in 0 until n) out[t] = slot.toByte()
                stats.add(RegionStat(name, slot, tris.size))
            }
        }
        return Resolved(out, baseSlot, stats)
    }

    private fun nearestSlot(
        lab: ColorScience.Lab,
        palette: List<AutoPaintImageEngine.PaletteSlot>,
    ): Int {
        var best = palette[0].slot
        var bestD = Double.POSITIVE_INFINITY
        for (p in palette) {
            val d = ColorScience.ciede2000(lab, p.lab)
            if (d < bestD) { bestD = d; best = p.slot }
        }
        return best
    }

    /** Flat `[x1,y1,x2,y2,...]` float polygons; an entry is rejected if
     *  it isn't an even-length list of ≥3 vertices. Mirrors
     *  AiVisionMaskTools' polygon parsing contract. */
    private fun parsePolygons(arr: JSONArray?): List<FloatArray> {
        if (arr == null) return emptyList()
        val out = ArrayList<FloatArray>(arr.length())
        for (i in 0 until arr.length()) {
            val poly = arr.optJSONArray(i) ?: continue
            val len = poly.length()
            if (len < 6 || len % 2 != 0) continue
            val fa = FloatArray(len) { poly.optDouble(it, Double.NaN).toFloat() }
            if (fa.any { it.isNaN() }) continue
            out.add(fa)
        }
        return out
    }
}
