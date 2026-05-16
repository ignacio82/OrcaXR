package dev.orcaxr.app

/**
 * Smart Auto-Paint — metadata-aware prioritized cascade (borrowed idea
 * #1 from `u1-slicer-for-android`'s SegmentationCascade, adapted to
 * OrcaXR's single-`PlacedModel` / BVH context).
 *
 * Real-world models carry segmentation signal that pure geometry throws
 * away. The cascade exploits it in priority order, only falling back to
 * geometry when nothing better is available — the geometric branch is
 * guaranteed to succeed, so the cascade always produces full coverage.
 *
 * Branches (first non-trivial wins):
 *  - **PaintState** — the model already has per-triangle paint
 *    (`paintFilamentIndex`, e.g. an MMU/SEMM-authored 3MF). Respect it:
 *    each painted tag becomes a region, unpainted triangles inherit the
 *    nearest painted color ([AutoPaintEngine.diffuseFill]).
 *  - **Components** — shared-vertex shells. Borrowed idea #4 (B113
 *    "confetti" guard): components below [MIN_COMPONENT_FRACTION] are
 *    absorbed into the largest shell, and the distinct shells are
 *    capped to the palette size, so a high-fragmentation / decimated
 *    mesh can't explode into hundreds of one-triangle colors.
 *  - **HeightBands** — the always-succeeds geometric fallback.
 *
 * Borrowed idea #5: the result reports which branch produced it
 * ([Result.source]) and the next branch a follow-up call could use
 * ([Result.alternateSource]) plus [Result.branchesAvailable], so an
 * agent can reason about / override the choice.
 *
 * Pure & deterministic — unit-tested without a device.
 */
internal object AutoPaintCascade {

    /** Which branch produced a segmentation. `key` is the value
     *  surfaced in the `auto_paint` tool result. */
    enum class Source(val key: String) {
        PaintState("paint_state"),
        Components("components"),
        HeightBands("height_bands"),
    }

    /** A painted model must cover at least this fraction of its
     *  triangles for the PaintState branch to be considered
     *  non-trivial (a stray dab is not a segmentation). */
    const val MIN_PAINT_FRACTION = 0.02

    /** Shells smaller than this fraction of the mesh are absorbed into
     *  the largest shell rather than each getting their own color. */
    const val MIN_COMPONENT_FRACTION = 0.005

    data class Result(
        /** size = `bvh.triCount`, every entry a 1-based slot (full coverage). */
        val perTriangleSlot: ByteArray,
        val source: Source,
        /** The next branch a follow-up could use, or null if `source`
         *  is already the last (HeightBands). */
        val alternateSource: Source?,
        val branchesAvailable: List<String>,
        val slotsUsed: Int,
        val perSlotHistogram: IntArray,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Result) return false
            return perTriangleSlot.contentEquals(other.perTriangleSlot) &&
                source == other.source && alternateSource == other.alternateSource &&
                branchesAvailable == other.branchesAvailable && slotsUsed == other.slotsUsed &&
                perSlotHistogram.contentEquals(other.perSlotHistogram)
        }

        override fun hashCode(): Int = perTriangleSlot.contentHashCode()
    }

    /**
     * @param existingPaint the model's current `paintFilamentIndex`
     *   (null / wrong-size / empty → PaintState branch skipped).
     * @param paletteSize clamped to `1..MAX_PAINT_SLOTS`.
     */
    fun run(
        bvh: MeshBvh,
        existingPaint: ByteArray?,
        paletteSize: Int,
        axis: AutoPaintEngine.Axis = AutoPaintEngine.Axis.Z,
    ): Result {
        val n = bvh.triCount
        val k = paletteSize.coerceIn(1, MAX_PAINT_SLOTS)
        if (n == 0) {
            return Result(ByteArray(0), Source.HeightBands, null, emptyList(), 0, IntArray(MAX_PAINT_SLOTS + 1))
        }

        val paintSlots = paintStateBranch(existingPaint, n, k, bvh)
        val componentSlots = componentsBranch(bvh, k)
        val componentsViable = componentSlots != null
        val paintViable = paintSlots != null

        val available = buildList {
            if (paintViable) add(Source.PaintState.key)
            if (componentsViable) add(Source.Components.key)
            add(Source.HeightBands.key)
        }

        val (slots, source) = when {
            paintViable -> paintSlots!! to Source.PaintState
            componentsViable -> componentSlots!! to Source.Components
            else -> AutoPaintEngine.run(
                bvh, AutoPaintEngine.Strategy.HeightBands, k, axis,
            ).perTriangleSlot to Source.HeightBands
        }
        val alternate = when (source) {
            Source.PaintState -> if (componentsViable) Source.Components else Source.HeightBands
            Source.Components -> Source.HeightBands
            Source.HeightBands -> null
        }

        val hist = IntArray(MAX_PAINT_SLOTS + 1)
        for (s in slots) hist[s.toInt() and 0xff]++
        var used = 0
        for (slot in 1..MAX_PAINT_SLOTS) if (hist[slot] > 0) used++
        return Result(slots, source, alternate, available, used, hist)
    }

    // ---- branches ----

    /** Respect existing per-triangle paint; fold tags > k into the
     *  palette range; diffuse-fill the unpainted remainder so the
     *  whole model is covered. Null when there's no meaningful paint. */
    private fun paintStateBranch(
        paint: ByteArray?,
        n: Int,
        k: Int,
        bvh: MeshBvh,
    ): ByteArray? {
        if (paint == null || paint.size != n) return null
        var painted = 0
        val distinct = HashSet<Int>()
        for (b in paint) {
            val tag = b.toInt() and 0xff
            if (tag != 0) { painted++; distinct.add(tag) }
        }
        if (distinct.isEmpty()) return null
        if (painted.toDouble() / n < MIN_PAINT_FRACTION) return null
        val out = ByteArray(n)
        for (i in 0 until n) {
            val tag = paint[i].toInt() and 0xff
            out[i] = if (tag == 0) 0 else (((tag - 1) % k) + 1).toByte()
        }
        AutoPaintEngine.diffuseFill(bvh, out)
        // diffuseFill can't seed a fully-unpainted disconnected island;
        // backfill any straggler with the most common slot so coverage
        // is total (B111-style "never ship a partial mesh").
        if (out.any { it.toInt() == 0 }) {
            val h = IntArray(MAX_PAINT_SLOTS + 1)
            for (s in out) h[s.toInt() and 0xff]++
            var maj = 1; var majC = -1
            for (slot in 1..MAX_PAINT_SLOTS) if (h[slot] > majC) { majC = h[slot]; maj = slot }
            for (i in out.indices) if (out[i].toInt() == 0) out[i] = maj.toByte()
        }
        return out
    }

    /**
     * Shells, with the B113 confetti guard: absorb sub-[MIN_COMPONENT_FRACTION]
     * shells into the largest, cap the distinct shells to `k`. Null
     * (branch skipped) when there's effectively only one big shell —
     * geometry will segment it better.
     */
    private fun componentsBranch(bvh: MeshBvh, k: Int): ByteArray? {
        val n = bvh.triCount
        val (compOf, sizes) = AutoPaintEngine.componentLabels(bvh)
        if (sizes.size < 2) return null
        val minSize = maxOf((MIN_COMPONENT_FRACTION * n).toInt(), 1)
        // Rank by size desc, stable on component id.
        val order = sizes.indices.sortedWith(
            compareByDescending<Int> { sizes[it] }.thenBy { it },
        )
        val largest = order.first()
        // Large shells keep identity (capped to k by rank); small ones
        // fold into the largest shell's slot.
        val slotOfComp = IntArray(sizes.size)
        var largeCount = 0
        var rank = 0
        for (comp in order) {
            if (sizes[comp] >= minSize) {
                slotOfComp[comp] = (rank % k) + 1
                rank++
                largeCount++
            } else {
                slotOfComp[comp] = -1 // marker: fold into largest
            }
        }
        val largestSlot = slotOfComp[largest].let { if (it < 1) 1 else it }
        // Need ≥2 distinct large shells for this branch to beat geometry.
        if (largeCount < 2) return null
        val out = ByteArray(n)
        for (i in 0 until n) {
            val s = slotOfComp[compOf[i]]
            out[i] = (if (s < 1) largestSlot else s).toByte()
        }
        return out
    }
}
