package dev.orcaxr.app

import kotlin.math.abs
import kotlin.math.min

/**
 * Smart Auto-Paint — M2: target-image projection core.
 *
 * Design + milestone plan: `docs/proposals/smart-auto-paint.md`.
 *
 * Pipeline (one camera):
 *  1. Render [bvh] from the camera in [AiRenderEngine.RenderMode.TriangleId]
 *     → an occlusion-correct per-pixel triangle-id map (the depth buffer
 *     resolves self-occlusion for free; no per-pixel BVH raycast).
 *  2. Map the target image onto the camera frame by aligning the
 *     image's *foreground bbox* to the model's *rendered silhouette
 *     bbox* — so the subject in a photo lands on the subject in the
 *     render even when zoom / framing differ (the B1 "roughly aligned"
 *     case).
 *  3. Accumulate mean RGB per triangle, then quantize each triangle's
 *     mean to the perceptually-nearest palette slot via [ColorScience]
 *     CIEDE2000 — the *same* metric `GamutMatcher` uses, not the crude
 *     RGB-Euclidean the older decal path uses.
 *  4. Triangles with no sampled pixel stay slot 0; the caller runs
 *     [AutoPaintEngine.diffuseFill] so the back / occluded faces inherit
 *     the nearest visible color and the whole model is covered.
 *
 * With a single target image only the camera-facing side carries real
 * color; that is honest for B1. Multi-image / semantic transfer is M4.
 *
 * Coordinate / index invariants: the camera lives in
 * `centered_preview_mm` (same frame the BVH was built in, gotcha #11d);
 * `triangleIdMap` ids and the returned `perTriangleSlot` are in the
 * derived-STL triangle index space — identical to
 * `PlacedModel.paintFilamentIndex`.
 *
 * Physical-only: a palette slot is one filament. The FullSpectrum
 * gamut is a `GamutMatcher` parameter flip, deferred (proposal
 * §FullSpectrum drop-in seam).
 */
internal object AutoPaintImageEngine {

    /** A 1-based filament slot and its CIELAB color. */
    data class PaletteSlot(val slot: Int, val lab: ColorScience.Lab)

    data class ProjectResult(
        /** size = `bvh.triCount`; 0 = no image data (caller fills). */
        val perTriangleSlot: ByteArray,
        /** triangles that received a directly-sampled color. */
        val coveredTriangles: Int,
        /** target pixels that mapped onto a model triangle. */
        val sampledPixels: Int,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is ProjectResult) return false
            return perTriangleSlot.contentEquals(other.perTriangleSlot) &&
                coveredTriangles == other.coveredTriangles &&
                sampledPixels == other.sampledPixels
        }

        override fun hashCode(): Int = perTriangleSlot.contentHashCode()
    }

    /** Build the slot palette (slot index 1-based) from `#RRGGBB`
     *  strings; blank / unparseable entries are skipped. */
    fun paletteFromHex(hex: List<String>): List<PaletteSlot> {
        val out = ArrayList<PaletteSlot>(hex.size)
        hex.forEachIndexed { i, h ->
            val lab = ColorScience.parseLab(h) ?: return@forEachIndexed
            out.add(PaletteSlot(i + 1, lab))
        }
        return out
    }

    /** Bbox in the BVH (centered_preview_mm) frame. */
    fun bboxOf(bvh: MeshBvh): AiIntrospection.Bbox = AiIntrospection.Bbox(
        bvh.bboxMin.x, bvh.bboxMin.y, bvh.bboxMin.z,
        bvh.bboxMax.x, bvh.bboxMax.y, bvh.bboxMax.z,
    )

    /**
     * Project [targetRgba] (`targetW`×`targetH`, RGBA, top-left origin)
     * onto [bvh] from [camera] and quantize per triangle to [palette].
     *
     * Background pixels are excluded so they do not bleed onto the model:
     * an explicit [backgroundRgb] (3 ints) wins; otherwise pixels with
     * alpha &lt; [alphaThreshold] are background, and for fully-opaque
     * images the dominant corner color (± [bgTolerance] per channel) is
     * treated as background.
     */
    fun project(
        bvh: MeshBvh,
        camera: AiRenderEngine.CameraSpec,
        targetRgba: ByteArray,
        targetW: Int,
        targetH: Int,
        palette: List<PaletteSlot>,
        backgroundRgb: IntArray? = null,
        alphaThreshold: Int = 16,
        bgTolerance: Int = 24,
    ): ProjectResult {
        val n = bvh.triCount
        val out = ByteArray(n)
        if (n == 0 || palette.isEmpty() || targetW <= 0 || targetH <= 0) {
            return ProjectResult(out, 0, 0)
        }

        val render = AiRenderEngine.render(bvh, camera, AiRenderEngine.RenderMode.TriangleId)
        val triMap = render.triangleIdMap ?: return ProjectResult(out, 0, 0)
        val camW = render.widthPx
        val camH = render.heightPx

        // Rendered-silhouette bbox in camera pixels.
        var sMinX = camW; var sMinY = camH; var sMaxX = -1; var sMaxY = -1
        for (y in 0 until camH) {
            val row = y * camW
            for (x in 0 until camW) {
                if (triMap[row + x] >= 0) {
                    if (x < sMinX) sMinX = x; if (x > sMaxX) sMaxX = x
                    if (y < sMinY) sMinY = y; if (y > sMaxY) sMaxY = y
                }
            }
        }
        if (sMaxX < sMinX || sMaxY < sMinY) return ProjectResult(out, 0, 0)

        // Target foreground bbox (background-excluded).
        val bg = backgroundRgb ?: inferCornerBackground(targetRgba, targetW, targetH, alphaThreshold)
        var tMinX = targetW; var tMinY = targetH; var tMaxX = -1; var tMaxY = -1
        for (y in 0 until targetH) {
            val row = y * targetW
            for (x in 0 until targetW) {
                if (!isBackground(targetRgba, (row + x) * 4, bg, alphaThreshold, bgTolerance)) {
                    if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x
                    if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y
                }
            }
        }
        if (tMaxX < tMinX || tMaxY < tMinY) return ProjectResult(out, 0, 0) // empty image

        val sW = (sMaxX - sMinX + 1).toFloat()
        val sH = (sMaxY - sMinY + 1).toFloat()
        val tW = (tMaxX - tMinX + 1).toFloat()
        val tH = (tMaxY - tMinY + 1).toFloat()

        val sumR = LongArray(n)
        val sumG = LongArray(n)
        val sumB = LongArray(n)
        val cnt = IntArray(n)
        var sampled = 0
        for (cy in sMinY..sMaxY) {
            val crow = cy * camW
            // Normalized v within the rendered silhouette bbox.
            val v = (cy - sMinY + 0.5f) / sH
            val ty = (tMinY + v * tH).toInt().coerceIn(tMinY, tMaxY)
            for (cx in sMinX..sMaxX) {
                val tri = triMap[crow + cx]
                if (tri < 0) continue
                val u = (cx - sMinX + 0.5f) / sW
                val tx = (tMinX + u * tW).toInt().coerceIn(tMinX, tMaxX)
                val ti = (ty * targetW + tx) * 4
                if (isBackground(targetRgba, ti, bg, alphaThreshold, bgTolerance)) continue
                sumR[tri] += (targetRgba[ti].toInt() and 0xff).toLong()
                sumG[tri] += (targetRgba[ti + 1].toInt() and 0xff).toLong()
                sumB[tri] += (targetRgba[ti + 2].toInt() and 0xff).toLong()
                cnt[tri]++
                sampled++
            }
        }

        var covered = 0
        val labCache = HashMap<Int, Int>() // packed-mean-rgb → slot, cheap reuse
        for (tri in 0 until n) {
            val c = cnt[tri]
            if (c == 0) continue
            val r = (sumR[tri] / c).toInt()
            val g = (sumG[tri] / c).toInt()
            val b = (sumB[tri] / c).toInt()
            val key = (r shl 16) or (g shl 8) or b
            val slot = labCache.getOrPut(key) {
                val lab = ColorScience.rgbToLab(r, g, b)
                var best = palette[0].slot
                var bestD = Double.POSITIVE_INFINITY
                for (p in palette) {
                    val d = ColorScience.ciede2000(lab, p.lab)
                    if (d < bestD) { bestD = d; best = p.slot }
                }
                best
            }
            out[tri] = slot.toByte()
            covered++
        }
        return ProjectResult(out, covered, sampled)
    }

    /**
     * When the caller doesn't supply a camera: render the model in each
     * named preset, compare its silhouette to the target's foreground
     * silhouette (both normalized into their bounding boxes so the score
     * is zoom/translation-invariant — it measures *pose*, not framing)
     * and return the highest-IoU preset's camera at [widthPx]×[heightPx].
     *
     * @return `(presetName, camera, iou)` for the best preset.
     */
    fun bestPresetBySilhouette(
        bvh: MeshBvh,
        targetRgba: ByteArray,
        targetW: Int,
        targetH: Int,
        widthPx: Int,
        heightPx: Int,
        backgroundRgb: IntArray? = null,
        alphaThreshold: Int = 16,
        bgTolerance: Int = 24,
        presetNames: List<String> = AiRenderEngine.NAMED_PRESETS,
        searchRes: Int = 96,
    ): Triple<String, AiRenderEngine.CameraSpec, Double> {
        val bbox = bboxOf(bvh)
        val bg = backgroundRgb ?: inferCornerBackground(targetRgba, targetW, targetH, alphaThreshold)
        val targetMask = normalizedMaskFromImage(
            targetRgba, targetW, targetH, bg, alphaThreshold, bgTolerance, searchRes,
        )
        var bestName = presetNames.firstOrNull() ?: "iso"
        var bestIou = -1.0
        for (name in presetNames) {
            val cam = AiRenderEngine.namedPreset(name, bbox, searchRes, searchRes)
            val r = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.TriangleId)
            val tm = r.triangleIdMap ?: continue
            val mask = normalizedMaskFromTriIds(tm, r.widthPx, r.heightPx, searchRes)
            val iou = iou(targetMask, mask)
            if (iou > bestIou) { bestIou = iou; bestName = name }
        }
        return Triple(bestName, AiRenderEngine.namedPreset(bestName, bbox, widthPx, heightPx), bestIou)
    }

    // ---- background / silhouette helpers ----

    private fun isBackground(
        rgba: ByteArray, off: Int, bg: IntArray?, alphaThreshold: Int, tol: Int,
    ): Boolean {
        if ((rgba[off + 3].toInt() and 0xff) < alphaThreshold) return true
        if (bg == null) return false
        val r = rgba[off].toInt() and 0xff
        val g = rgba[off + 1].toInt() and 0xff
        val b = rgba[off + 2].toInt() and 0xff
        return abs(r - bg[0]) <= tol && abs(g - bg[1]) <= tol && abs(b - bg[2]) <= tol
    }

    /** Dominant of the four corner pixels (each opaque corner votes);
     *  null when corners disagree (no clean background to key out). */
    private fun inferCornerBackground(
        rgba: ByteArray, w: Int, h: Int, alphaThreshold: Int,
    ): IntArray? {
        if (w < 2 || h < 2) return null
        val corners = intArrayOf(
            0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4,
        )
        val cols = ArrayList<IntArray>(4)
        for (o in corners) {
            if ((rgba[o + 3].toInt() and 0xff) < alphaThreshold) continue
            cols.add(intArrayOf(
                rgba[o].toInt() and 0xff, rgba[o + 1].toInt() and 0xff, rgba[o + 2].toInt() and 0xff,
            ))
        }
        if (cols.isEmpty()) return null // all corners transparent → alpha keys it
        // Require the corners to agree within a loose tolerance, else
        // the image has no uniform background (don't key anything out).
        val a = cols[0]
        for (c in cols) {
            if (abs(c[0] - a[0]) > 40 || abs(c[1] - a[1]) > 40 || abs(c[2] - a[2]) > 40) return null
        }
        var r = 0; var g = 0; var b = 0
        for (c in cols) { r += c[0]; g += c[1]; b += c[2] }
        return intArrayOf(r / cols.size, g / cols.size, b / cols.size)
    }

    /** Foreground mask of an image, stretched so its foreground bbox
     *  fills a [res]×[res] grid (zoom/translation-invariant shape). */
    private fun normalizedMaskFromImage(
        rgba: ByteArray, w: Int, h: Int, bg: IntArray?, alphaThreshold: Int, tol: Int, res: Int,
    ): BooleanArray {
        var minX = w; var minY = h; var maxX = -1; var maxY = -1
        for (y in 0 until h) {
            val row = y * w
            for (x in 0 until w) {
                if (!isBackground(rgba, (row + x) * 4, bg, alphaThreshold, tol)) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x
                    if (y < minY) minY = y; if (y > maxY) maxY = y
                }
            }
        }
        val out = BooleanArray(res * res)
        if (maxX < minX || maxY < minY) return out
        val bw = (maxX - minX + 1).toFloat()
        val bh = (maxY - minY + 1).toFloat()
        for (j in 0 until res) {
            val sy = (minY + ((j + 0.5f) / res) * bh).toInt().coerceIn(minY, maxY)
            for (i in 0 until res) {
                val sx = (minX + ((i + 0.5f) / res) * bw).toInt().coerceIn(minX, maxX)
                out[j * res + i] = !isBackground(rgba, (sy * w + sx) * 4, bg, alphaThreshold, tol)
            }
        }
        return out
    }

    private fun normalizedMaskFromTriIds(
        triMap: IntArray, w: Int, h: Int, res: Int,
    ): BooleanArray {
        var minX = w; var minY = h; var maxX = -1; var maxY = -1
        for (y in 0 until h) {
            val row = y * w
            for (x in 0 until w) {
                if (triMap[row + x] >= 0) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x
                    if (y < minY) minY = y; if (y > maxY) maxY = y
                }
            }
        }
        val out = BooleanArray(res * res)
        if (maxX < minX || maxY < minY) return out
        val bw = (maxX - minX + 1).toFloat()
        val bh = (maxY - minY + 1).toFloat()
        for (j in 0 until res) {
            val sy = (minY + ((j + 0.5f) / res) * bh).toInt().coerceIn(minY, maxY)
            for (i in 0 until res) {
                val sx = (minX + ((i + 0.5f) / res) * bw).toInt().coerceIn(minX, maxX)
                out[j * res + i] = triMap[sy * w + sx] >= 0
            }
        }
        return out
    }

    /**
     * Guarantee whole-model coverage after a single-camera projection:
     * BFS-diffuse the sampled colors into unsampled triangles, then
     * backfill any triangles still 0 (a fully-occluded disconnected
     * island the camera never saw) with the model's majority slot.
     * Returns false only when nothing was sampled at all.
     */
    fun finalizeCoverage(bvh: MeshBvh, slots: ByteArray): Boolean {
        if (slots.isEmpty()) return false
        var any = false
        for (s in slots) if (s.toInt() != 0) { any = true; break }
        if (!any) return false
        AutoPaintEngine.diffuseFill(bvh, slots)
        var remaining = 0
        for (s in slots) if (s.toInt() == 0) remaining++
        if (remaining > 0) {
            val hist = IntArray(MAX_PAINT_SLOTS + 1)
            for (s in slots) hist[s.toInt() and 0xff]++
            var maj = 1; var majC = -1
            for (slot in 1..MAX_PAINT_SLOTS) if (hist[slot] > majC) { majC = hist[slot]; maj = slot }
            for (i in slots.indices) if (slots[i].toInt() == 0) slots[i] = maj.toByte()
        }
        return true
    }

    private fun iou(a: BooleanArray, b: BooleanArray): Double {
        val n = min(a.size, b.size)
        var inter = 0; var union = 0
        for (i in 0 until n) {
            val ai = a[i]; val bi = b[i]
            if (ai || bi) union++
            if (ai && bi) inter++
        }
        return if (union == 0) 0.0 else inter.toDouble() / union
    }
}
