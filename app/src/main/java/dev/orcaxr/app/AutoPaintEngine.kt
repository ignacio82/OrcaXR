package dev.orcaxr.app

import kotlin.math.floor
import kotlin.math.sqrt

/**
 * Smart Auto-Paint — M1: deterministic geometric strategies.
 *
 * Design + milestone plan: `docs/proposals/smart-auto-paint.md`.
 *
 * Unlike [AiProceduralPaint] (which buckets *some* triangles per stop
 * and leaves the rest untouched so an LLM can paint partial gradients),
 * this engine produces a **full-coverage** per-triangle slot assignment
 * — every triangle of the model gets a 1-based filament-slot tag — so
 * one call paints the whole model in a single undo step via
 * [WorkspaceAction.LoadPaintState].
 *
 * Coordinate frame: the [MeshBvh] is in `centered_preview_mm` (gotcha
 * #11d) and the triangle index space is the derived-STL binary order —
 * the same space as `PlacedModel.paintFilamentIndex`. The engine never
 * touches a camera, so the frame only matters for the axis a height-band
 * is measured along (`+Z` = build height, which is what the user means
 * by "rainbow by height").
 *
 * Determinism: every strategy is a pure function of the mesh geometry
 * and the palette size. No `Random`, no float reduction order
 * dependence, no `HashSet` iteration. Two runs over the same fixture
 * produce byte-identical output — pinned by `AutoPaintEngineTest`.
 *
 * M1 is **physical-only**: slots map 1:1 to the active filament palette.
 * The FullSpectrum gamut option is a `GamutMatcher` parameter flip,
 * deferred until `PeggyPaletteFullSpectrumParityTest` is green (see the
 * proposal's "FullSpectrum drop-in seam").
 */
internal object AutoPaintEngine {

    /** Available geometric strategies. `name` is the MCP `strategy` arg. */
    enum class Strategy(val key: String) {
        /** Slot ramps with centroid position along [Axis]. The
         *  "rainbow by build height" look when axis = Z. */
        HeightBands("height_bands"),

        /** Each disconnected shell (shared-vertex connected component)
         *  gets its own slot. Components sorted by descending triangle
         *  count so the biggest part is always slot 1 — stable and
         *  meaningful for assemblies / multi-part prints. */
        Components("components"),

        /** Per-triangle concavity (a cheap curvature proxy: the dot of
         *  the face normal with the mean of its neighbours' normals)
         *  banded across the palette. Recessed features cluster at the
         *  high-slot end so a contrast filament picks out eye sockets /
         *  grooves / finger gaps. */
        Cavity("cavity");

        companion object {
            fun fromKey(k: String): Strategy? = entries.firstOrNull { it.key == k }
        }
    }

    /** Axis a [Strategy.HeightBands] is measured along. */
    enum class Axis(val key: String, val x: Float, val y: Float, val z: Float) {
        X("x", 1f, 0f, 0f),
        Y("y", 0f, 1f, 0f),
        Z("z", 0f, 0f, 1f);

        companion object {
            fun fromKey(k: String): Axis? = entries.firstOrNull { it.key == k }
        }
    }

    /**
     * @param perTriangleSlot one 1-based slot tag per triangle, sized
     *   `bvh.triCount`. Never 0 on a non-empty mesh (full coverage).
     * @param perSlotHistogram index = slot (0..[MAX_PAINT_SLOTS]); `[0]`
     *   is the unassigned count (0 after a successful run).
     * @param slotsUsed how many distinct slots actually appear — may be
     *   less than the palette size (e.g. one connected component).
     */
    data class Result(
        val perTriangleSlot: ByteArray,
        val perSlotHistogram: IntArray,
        val slotsUsed: Int,
        val strategy: String,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Result) return false
            return perTriangleSlot.contentEquals(other.perTriangleSlot) &&
                perSlotHistogram.contentEquals(other.perSlotHistogram) &&
                slotsUsed == other.slotsUsed && strategy == other.strategy
        }

        override fun hashCode(): Int = perTriangleSlot.contentHashCode()
    }

    /**
     * Run [strategy] over [bvh] and return a full-coverage slot
     * assignment. [paletteSize] is clamped to `1..MAX_PAINT_SLOTS`; a
     * size of 1 paints the whole model slot 1 (valid, if pointless).
     */
    fun run(
        bvh: MeshBvh,
        strategy: Strategy,
        paletteSize: Int,
        axis: Axis = Axis.Z,
    ): Result {
        val n = bvh.triCount
        val k = paletteSize.coerceIn(1, MAX_PAINT_SLOTS)
        if (n == 0) return Result(ByteArray(0), IntArray(MAX_PAINT_SLOTS + 1), 0, strategy.key)

        val slots = when (strategy) {
            Strategy.HeightBands -> bandByParameter(n, k) { i ->
                val c = bvh.triangleCentroid(i)
                c.x * axis.x + c.y * axis.y + c.z * axis.z
            }
            Strategy.Cavity -> bandByParameter(n, k) { i -> concavity(bvh, i) }
            Strategy.Components -> componentSlots(bvh, k)
        }

        // M1 strategies are full-coverage by construction; the diffusion
        // fill is a no-op safety net here and the reusable primitive M2
        // (image projection) needs. Cheap when there's nothing to fill.
        diffuseFill(bvh, slots)

        val hist = IntArray(MAX_PAINT_SLOTS + 1)
        for (s in slots) hist[s.toInt() and 0xff]++
        var used = 0
        for (slot in 1..MAX_PAINT_SLOTS) if (hist[slot] > 0) used++
        return Result(slots, hist, used, strategy.key)
    }

    // ---- strategies ----

    /**
     * Map a per-triangle scalar to a 1-based slot by min-max
     * normalizing the scalar over the mesh and flooring into [k] equal
     * bands. A degenerate range (every triangle identical, e.g. a flat
     * plate measured along its normal) collapses to slot 1 — full
     * coverage with one color rather than NaN.
     */
    private inline fun bandByParameter(
        n: Int,
        k: Int,
        param: (Int) -> Float,
    ): ByteArray {
        var lo = Float.POSITIVE_INFINITY
        var hi = Float.NEGATIVE_INFINITY
        val raw = FloatArray(n)
        for (i in 0 until n) {
            val v = param(i)
            raw[i] = v
            if (v < lo) lo = v
            if (v > hi) hi = v
        }
        val out = ByteArray(n)
        if (!(hi > lo)) {
            for (i in 0 until n) out[i] = 1
            return out
        }
        val invSpan = 1f / (hi - lo)
        for (i in 0 until n) {
            val t = ((raw[i] - lo) * invSpan).coerceIn(0f, 1f)
            // t == 1 must land in the last band, not band k.
            val band = floor(t * k).toInt().coerceIn(0, k - 1)
            out[i] = (band + 1).toByte()
        }
        return out
    }

    /**
     * Flood every shared-vertex connected component once (O(triangles)
     * total, single visited array — does NOT call
     * [MeshBvh.connectedComponent] per seed, which would allocate a
     * fresh `triCount` visited buffer per component). Components are
     * ranked by descending triangle count and assigned `rank % k`
     * so the largest shell is always slot 1.
     */
    private fun componentSlots(bvh: MeshBvh, k: Int): ByteArray {
        val (compOf, sizes) = componentLabels(bvh)
        // Rank components by size (desc), tie-break by first-seen
        // component id so the assignment is deterministic.
        val order = sizes.indices.sortedWith(
            compareByDescending<Int> { sizes[it] }.thenBy { it },
        )
        val slotOfComp = IntArray(sizes.size)
        for ((rank, comp) in order.withIndex()) slotOfComp[comp] = (rank % k) + 1
        val out = ByteArray(compOf.size)
        for (i in compOf.indices) out[i] = slotOfComp[compOf[i]].toByte()
        return out
    }

    /**
     * Single O(triangles) shared-vertex flood. Returns `(compOf,
     * sizes)`: `compOf[t]` is triangle t's 0-based component id;
     * `sizes[c]` is component c's triangle count. One visited array,
     * no per-seed allocation. Shared by [componentSlots] and the
     * metadata-aware cascade (which adds small-component merging and a
     * leaf cap on top of this — the B113 "confetti" guard).
     */
    fun componentLabels(bvh: MeshBvh): Pair<IntArray, IntArray> {
        val n = bvh.triCount
        val compOf = IntArray(n) { -1 }
        val sizes = ArrayList<Int>()
        val stack = IntArray(n)
        var nextComp = 0
        for (start in 0 until n) {
            if (compOf[start] != -1) continue
            val comp = nextComp++
            var sp = 0
            stack[sp++] = start
            compOf[start] = comp
            var size = 0
            while (sp > 0) {
                val cur = stack[--sp]
                size++
                for (nb in bvh.directNeighbors(cur)) {
                    if (compOf[nb] == -1) {
                        compOf[nb] = comp
                        stack[sp++] = nb
                    }
                }
            }
            sizes.add(size)
        }
        return compOf to sizes.toIntArray()
    }

    /**
     * Concavity proxy in `[-1, 1]`: `dot(faceNormal, mean(neighbour
     * faceNormals))`. ≈ +1 on flat / convex regions, drops toward 0 or
     * negative across creases and inside recesses. Banding the
     * *negated* value puts recessed triangles at the high-slot end so
     * a contrast filament lands in the grooves. Isolated triangles
     * (no neighbours) report fully convex (1).
     */
    private fun concavity(bvh: MeshBvh, tri: Int): Float {
        val nf = bvh.triangleNormal(tri)
        val nbrs = bvh.directNeighbors(tri)
        if (nbrs.isEmpty()) return -1f // negated below → flat end
        var mx = 0f; var my = 0f; var mz = 0f
        for (nb in nbrs) {
            val m = bvh.triangleNormal(nb)
            mx += m.x; my += m.y; mz += m.z
        }
        val len = sqrt(mx * mx + my * my + mz * mz)
        if (len < 1e-7f) return -1f
        val d = (nf.x * mx + nf.y * my + nf.z * mz) / len
        // Negate so concave (low d) → high parameter → high slot.
        return -d.coerceIn(-1f, 1f)
    }

    // ---- coverage fill (reused by M2) ----

    /**
     * Multi-source BFS over shared-vertex adjacency: every triangle
     * still tagged 0 inherits the slot of the nearest (fewest-hops)
     * assigned triangle. Deterministic — frontier is processed in
     * ascending triangle-index order. A no-op when [slots] is already
     * full-coverage (the M1 case). When the mesh has assigned *and*
     * disconnected unassigned islands, those islands stay 0 (nothing to
     * inherit from) — callers that must guarantee total coverage should
     * pair this with a strategy that seeds every component.
     */
    fun diffuseFill(bvh: MeshBvh, slots: ByteArray) {
        val n = slots.size
        var anyUnassigned = false
        var anyAssigned = false
        for (s in slots) {
            if (s.toInt() == 0) anyUnassigned = true else anyAssigned = true
            if (anyUnassigned && anyAssigned) break
        }
        if (!anyUnassigned || !anyAssigned) return
        val queue = IntArray(n)
        var head = 0
        var tail = 0
        for (i in 0 until n) if (slots[i].toInt() != 0) queue[tail++] = i
        while (head < tail) {
            val cur = queue[head++]
            val slot = slots[cur]
            for (nb in bvh.directNeighbors(cur)) {
                if (slots[nb].toInt() == 0) {
                    slots[nb] = slot
                    queue[tail++] = nb
                }
            }
        }
    }

    /** True iff every triangle carries a non-zero slot. */
    fun isFullCoverage(slots: ByteArray): Boolean {
        for (s in slots) if (s.toInt() == 0) return false
        return slots.isNotEmpty()
    }
}
