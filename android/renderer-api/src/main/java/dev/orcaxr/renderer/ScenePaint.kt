package dev.orcaxr.renderer

import dev.orcaxr.core.PaintFacetPackets
import dev.orcaxr.core.ProjectPaintFacets
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * One volume's paint facets as the session answered them
 * ([ProjectPaintFacets]): each state's display colour (`0xRRGGBB`), the whole
 * facets as `[first, count, state]` runs, and the leaves of subdivided facets
 * (nine volume-millimetre corners each, with its state).
 */
class PaintFacetData(
    val colors: IntArray,
    val runs: IntArray,
    val leafCorners: FloatArray,
    val leafStates: IntArray,
) {
    init {
        require(runs.size % 3 == 0 && leafCorners.size == leafStates.size * 9) { "Malformed paint facets" }
        require((runs.indices step 3).all { runs[it] >= 0 && runs[it + 1] > 0 && runs[it + 2] in colors.indices }) { "Paint facet run outside its states" }
        require(leafStates.all { it in colors.indices }) { "Paint leaf outside its states" }
    }

    val empty get() = runs.isEmpty() && leafStates.isEmpty()

    companion object {
        val NONE = PaintFacetData(IntArray(0), IntArray(0), FloatArray(0), IntArray(0))

        /** `#rrggbb` (or `#rgb`) as `0xRRGGBB`. */
        fun rgb(text: String): Int {
            val hex = text.removePrefix("#")
            require(text.startsWith("#") && (hex.length == 6 || hex.length == 3) && hex.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) { "Invalid paint colour $text" }
            return if (hex.length == 3) hex.map { "$it$it" }.joinToString("").toInt(16) else hex.toInt(16)
        }

        /** Every run and leaf of [capture], paged at the session's limit. */
        fun read(capture: ProjectPaintFacets): PaintFacetData {
            val summary = capture.summary()
            fun pages(total: Long, page: (Long, Long) -> ByteArray): List<ByteArray> {
                val out = ArrayList<ByteArray>()
                var start = 0L
                while (start < total) {
                    val count = minOf(ProjectPaintFacets.MAX_PAGE, total - start)
                    out += page(start, count)
                    start += count
                }
                return out
            }
            val runs = pages(summary.runs) { start, count -> capture.runs(start, count) }.flatMap { PaintFacetPackets.runs(it).asList() }.toIntArray()
            val leaves = pages(summary.leaves) { start, count -> capture.leaves(start, count) }.map(PaintFacetPackets::leaves)
            return PaintFacetData(
                summary.colors.map(::rgb).toIntArray(),
                runs,
                leaves.flatMap { it.first.asList() }.toFloatArray(),
                leaves.flatMap { it.third.asList() }.toIntArray(),
            )
        }
    }
}

/** Facets of one volume whose vertex colours change, from [first]: one vertex colour per facet. */
class PaintRange(val first: Int, val colors: IntArray)

/** The leaves drawn over a volume's subdivided facets: nine corners (volume millimetres) and one vertex colour per leaf. */
class PaintLeaves(val corners: FloatArray, val colors: IntArray) {
    val count get() = colors.size
}

/**
 * A volume's paint as a renderer applies it: the facets whose vertex colours
 * changed (each range at most [ScenePaint.MAX_RANGE] facets) and, when they
 * changed, the leaves drawn over subdivided facets (null for none).
 */
class PaintUpdate(
    val volumeId: String,
    val assetId: String,
    val facetCount: Int,
    val ranges: List<PaintRange>,
    val leavesChanged: Boolean,
    val leaves: PaintLeaves?,
)

/**
 * The paint a renderer draws on each volume's own facets, as the browser's
 * workspace draws its paint overlays: a painted facet in its state's colour,
 * every other facet in the volume's filament colour, and — while a stroke is
 * in flight — the stroke's preview over them at the browser's 55% opacity
 * (`PAINT_PREVIEW_MATERIAL`), the canonical paint hidden behind a refined
 * preview as the browser hides its overlay.
 *
 * Vertex colours carry the shading the mesh baked: a painted facet's is its
 * colour under the facet's shade with alpha 0 (the draw's tint does not
 * apply), any other facet's is the shade grey with alpha 255 (the draw's
 * filament tint applies). Each change answers only the facets whose colour
 * changed, so a renderer updates colour bytes and never geometry.
 * Platform-free; one thread at a time.
 */
class ScenePaint {
    companion object {
        /** The browser's preview opacity. */
        const val PREVIEW_OPACITY = .55
        /** The most facets one range holds. */
        const val MAX_RANGE = 16_384
        /** Unchanged facets this short between changed ones ride along, to keep uploads few. */
        private const val GAP = 32

        /** A facet in its own [rgb] colour under the baked [shade]: alpha 0. */
        fun own(shade: Int, rgb: Int): Int {
            val light = (shade and 0xff) / 255.0
            fun channel(shift: Int) = (((rgb ushr shift) and 0xff) * light).roundToInt().coerceIn(0, 255)
            return (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
        }

        /** [color] (unlit `0xRRGGBB`) at the preview's opacity over [under] (lit `0xRRGGBB`): alpha 0. */
        fun preview(color: Int, under: Int): Int {
            fun channel(shift: Int) = (((color ushr shift) and 0xff) * PREVIEW_OPACITY + ((under ushr shift) and 0xff) * (1 - PREVIEW_OPACITY)).roundToInt().coerceIn(0, 255)
            return (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
        }

        /** What a vertex colour shows under a draw tinted [tint] (`0xAARRGGBB`): lit `0xRRGGBB`. */
        fun lit(vertex: Int, tint: Int): Int {
            if (vertex ushr 24 == 0) return vertex and 0xffffff
            val shade = (vertex and 0xff) / 255.0
            fun channel(shift: Int) = (((tint ushr shift) and 0xff) * shade).roundToInt().coerceIn(0, 255)
            return (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
        }

        /** The baked shade of a leaf with corners [at] in [corners]. */
        private fun leafShade(corners: FloatArray, at: Int): Int {
            fun p(k: Int) = Point3(corners[at + k * 3].toDouble(), corners[at + k * 3 + 1].toDouble(), corners[at + k * 3 + 2].toDouble())
            val normal = (p(1) - p(0)).cross(p(2) - p(0))
            val length = sqrt(normal.dot(normal))
            return PacketMeshes.shade(if (length > 1e-12 && length.isFinite()) normal * (1 / length) else null)
        }
    }

    private class Volume(val assetId: String, val mesh: TriangleMesh, var tint: Int) {
        /** Per facet, the canonical paint colour (`0xRRGGBB`) or -1. */
        var canonical: IntArray? = null
        var canonicalLeaves: PaintFacetData? = null
        var preview: PaintFacetData? = null
        var hideCanonical = false
        /** Per facet, the vertex colour shown (null: the mesh's own shades, nothing painted). */
        var shown: IntArray? = null
        var shownLeaves: PaintLeaves? = null
    }

    private val volumes = LinkedHashMap<String, Volume>()

    /** Paint is shown on these volumes. */
    val volumeIds: Set<String> get() = volumes.keys

    private fun facetColors(data: PaintFacetData, count: Int): IntArray? {
        if (data.runs.isEmpty()) return null
        val colors = IntArray(count) { -1 }
        for (at in data.runs.indices step 3) {
            val first = data.runs[at]
            val end = first + data.runs[at + 1]
            require(end <= count) { "Paint facet run outside the mesh" }
            colors.fill(data.colors[data.runs[at + 2]], first, end)
        }
        return colors
    }

    /**
     * [volumeId]'s canonical paint, drawn on [mesh] (its asset [assetId]) in a
     * draw tinted [tint]; [data] null or empty clears it. Answers what to
     * update, or null when nothing shown changed.
     */
    fun canonical(volumeId: String, assetId: String, mesh: TriangleMesh, tint: Int, data: PaintFacetData?): PaintUpdate? {
        val existing = volumes[volumeId]
        val volume = if (existing != null && existing.assetId == assetId && existing.mesh === mesh) existing.also { it.tint = tint }
        else Volume(assetId, mesh, tint).also { volumes[volumeId] = it }
        val fresh = volume !== existing
        val painted = data?.takeUnless { it.empty }
        volume.canonical = painted?.let { facetColors(it, mesh.facetCount) }
        volume.canonicalLeaves = painted?.takeIf { it.leafStates.isNotEmpty() }
        return show(volumeId, volume, fresh)
    }

    /**
     * A stroke's live preview on [volumeId] ([data] null ends it); a refined
     * preview ([hideCanonical]) hides the canonical paint, as the browser
     * hides its overlay. Null when the volume shows no paint state yet or
     * nothing shown changed.
     */
    fun preview(volumeId: String, data: PaintFacetData?, hideCanonical: Boolean = false): PaintUpdate? {
        val volume = volumes[volumeId] ?: return null
        volume.preview = data?.takeUnless { it.empty }
        volume.hideCanonical = volume.preview != null && hideCanonical
        return show(volumeId, volume, false)
    }

    /** Forgets every volume but [kept]. */
    fun retain(kept: Set<String>) {
        volumes.keys.retainAll(kept)
    }

    /** Everything shown, for a renderer made afresh: every painted facet and every leaf. */
    fun everything(): List<PaintUpdate> = volumes.mapNotNull { (id, volume) ->
        val shown = volume.shown
        val ranges = if (shown == null) emptyList() else ranges(volume.mesh, shown) { facet -> shown[facet] != volume.mesh.colors[facet] }
        if (ranges.isEmpty() && volume.shownLeaves == null) null
        else PaintUpdate(id, volume.assetId, volume.mesh.facetCount, ranges, volume.shownLeaves != null, volume.shownLeaves)
    }

    private fun show(volumeId: String, volume: Volume, fresh: Boolean): PaintUpdate? {
        val mesh = volume.mesh
        val count = mesh.facetCount
        val canonical = volume.canonical.takeUnless { volume.hideCanonical }
        val preview = volume.preview?.let { facetColors(it, count) }
        // Nothing painted, before or now: nothing to compare.
        if (canonical == null && preview == null && volume.shown == null && volume.canonicalLeaves == null &&
            volume.preview == null && volume.shownLeaves == null) return null
        val next: IntArray? = if (canonical == null && preview == null) null else IntArray(count) { facet ->
            val base = canonical?.get(facet)?.takeIf { it >= 0 }?.let { own(mesh.colors[facet], it) } ?: mesh.colors[facet]
            val over = preview?.get(facet) ?: -1
            if (over < 0) base else preview(over, lit(base, volume.tint))
        }
        val before = volume.shown
        volume.shown = next
        fun at(colors: IntArray?, facet: Int) = colors?.get(facet) ?: mesh.colors[facet]
        val ranges = ranges(mesh, next ?: mesh.colors) { facet -> at(next, facet) != at(before, facet) || (fresh && at(next, facet) != mesh.colors[facet]) }
        val leaves = leaves(volume)
        val leavesChanged = !sameLeaves(leaves, volume.shownLeaves) || (fresh && leaves != null)
        volume.shownLeaves = leaves
        return if (ranges.isEmpty() && !leavesChanged) null else PaintUpdate(volumeId, volume.assetId, count, ranges, leavesChanged, leaves)
    }

    private fun leaves(volume: Volume): PaintLeaves? {
        val corners = ArrayList<Float>()
        val colors = ArrayList<Int>()
        fun add(data: PaintFacetData, color: (Int, Int) -> Int) {
            for (leaf in data.leafStates.indices) {
                val shade = leafShade(data.leafCorners, leaf * 9)
                for (k in 0 until 9) corners += data.leafCorners[leaf * 9 + k]
                colors += color(shade, data.colors[data.leafStates[leaf]])
            }
        }
        if (!volume.hideCanonical) volume.canonicalLeaves?.let { add(it) { shade, rgb -> own(shade, rgb) } }
        volume.preview?.takeIf { it.leafStates.isNotEmpty() }?.let { data ->
            add(data) { shade, rgb -> preview(rgb, lit(shade, volume.tint)) }
        }
        return if (colors.isEmpty()) null else PaintLeaves(corners.toFloatArray(), colors.toIntArray())
    }

    private fun sameLeaves(a: PaintLeaves?, b: PaintLeaves?) =
        a === b || (a != null && b != null && a.colors.contentEquals(b.colors) && a.corners.contentEquals(b.corners))

    /** The changed facets as ranges of at most [MAX_RANGE], short unchanged gaps included. */
    private fun ranges(mesh: TriangleMesh, colors: IntArray, changed: (Int) -> Boolean): List<PaintRange> {
        val out = ArrayList<PaintRange>()
        var facet = 0
        val count = mesh.facetCount
        while (facet < count) {
            if (!changed(facet)) { facet++; continue }
            val first = facet
            var last = facet
            var probe = facet + 1
            while (probe < count && probe - first < MAX_RANGE) {
                if (changed(probe)) { last = probe; probe++; continue }
                if (probe - last > GAP) break
                probe++
            }
            out += PaintRange(first, colors.copyOfRange(first, last + 1))
            facet = last + 1
        }
        return out
    }
}
