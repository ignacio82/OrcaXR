package dev.orcaxr.app

/**
 * Smart Auto-Paint — M3: FullSpectrum gamut for the quantizers.
 *
 * The "FullSpectrum drop-in seam" the proposal designed for: instead of
 * quantizing target colors only to the physical filaments, also offer
 * the colors FullSpectrum can synthesize by blending two of them. This
 * is **pure** and changes nothing about the engines: it just builds a
 * wider [AutoPaintImageEngine.PaletteSlot] list (physical + predicted
 * blends) that the existing CIEDE2000 nearest-slot quantizers
 * ([AutoPaintImageEngine], [SemanticPaintPlanner]) consume unchanged.
 *
 * Blend entries get *placeholder* slot ids past the physical range;
 * after the engine picks them, [materialize] turns the used ones into
 * real virtual `MixedFilamentEntry` rows (reusing the exact
 * `ensureBlendRow` semantics `GamutMatcher.applyGamutMatches` /
 * "Match to my filaments" already ship in `main`) and reports the real
 * painted-face id `physicalCount + rowIndex` (the
 * `extendPaletteWithVirtualRows` / gotcha #20 convention). A blend that
 * can't fit under [MAX_PAINT_SLOTS] falls back to its nearest physical
 * slot, so the paint is always representable and sliceable.
 *
 * Predicted colors come from the *same* pigment-aware mixer the slice
 * preview uses (via `GamutMatcher.enumerateGamut`'s default blender),
 * so the reported swatch equals what the slicer emits.
 *
 * Status: experimental. The FS Local-Z engine port is software-verified
 * (patches 0067 + `MixedFilamentWireFormatTest`); the hardware print on
 * a Snapmaker U1 is the only step pending. Physical-only stays the
 * default; FS is strictly opt-in (`use_full_spectrum=true`).
 */
internal object FullSpectrumGamut {

    data class Built(
        /** physical + virtual-placeholder slots; feed to the engines. */
        val paletteSlots: List<AutoPaintImageEngine.PaletteSlot>,
        /** slot → recipe (only blend placeholders appear here). */
        val recipeOf: Map<Int, GamutMatcher.GamutRecipe>,
        /** slot → predicted printed `#RRGGBB`. */
        val predictedHexOf: Map<Int, String>,
        /** virtual placeholder slot → nearest physical slot (the
         *  always-safe fallback when a blend can't be materialized). */
        val fallbackPhysicalOf: Map<Int, Int>,
        /** number of physical filament slots (N in the `N + k` id). */
        val physicalCount: Int,
    )

    /**
     * @param physicalHex 0-based physical slot colors (the active
     *   `previewPalette`). Slot id of physical filament i is `i + 1`.
     * @param maxSlots hard ceiling on any painted-face id.
     */
    fun build(
        physicalHex: List<String>,
        mixStepPercent: Int = 10,
        maxSlots: Int = MAX_PAINT_SLOTS,
    ): Built {
        val physicalCount = physicalHex.size
        val physical = ArrayList<AutoPaintImageEngine.PaletteSlot>()
        val physicalLabs = ArrayList<Pair<Int, ColorScience.Lab>>() // (slot, lab)
        physicalHex.forEachIndexed { i, hex ->
            val lab = ColorScience.parseLab(hex) ?: return@forEachIndexed
            physical.add(AutoPaintImageEngine.PaletteSlot(i + 1, lab))
            physicalLabs.add((i + 1) to lab)
        }
        if (physical.isEmpty()) {
            return Built(emptyList(), emptyMap(), emptyMap(), emptyMap(), physicalCount)
        }

        val recipeOf = HashMap<Int, GamutMatcher.GamutRecipe>()
        val predictedHexOf = HashMap<Int, String>()
        val fallbackPhysicalOf = HashMap<Int, Int>()
        val virtual = ArrayList<AutoPaintImageEngine.PaletteSlot>()
        var nextPlaceholder = physicalCount + 1

        for (cand in GamutMatcher.enumerateGamut(physicalHex, mixStepPercent)) {
            val recipe = cand.recipe
            if (recipe !is GamutMatcher.GamutRecipe.Blend) continue // physicals handled above
            if (nextPlaceholder > maxSlots) break
            val lab = ColorScience.parseLab(cand.hex) ?: continue
            val slot = nextPlaceholder++
            virtual.add(AutoPaintImageEngine.PaletteSlot(slot, lab))
            recipeOf[slot] = recipe
            predictedHexOf[slot] = cand.hex
            // Nearest physical slot to the blend — the safe fallback.
            var fb = physicalLabs[0].first
            var fbD = Double.POSITIVE_INFINITY
            for ((ps, pl) in physicalLabs) {
                val d = ColorScience.ciede2000(lab, pl)
                if (d < fbD) { fbD = d; fb = ps }
            }
            fallbackPhysicalOf[slot] = fb
        }
        return Built(physical + virtual, recipeOf, predictedHexOf, fallbackPhysicalOf, physicalCount)
    }

    data class Materialized(
        /** placeholder slot → real painted-face id (`physicalCount +
         *  rowIndex`), or the fallback physical slot when it can't fit. */
        val remap: Map<Int, Int>,
        /** the printer's virtual rows after reuse/append (persist this). */
        val rows: List<MixedFilamentEntry>,
        /** placeholder slots that fell back to physical (couldn't fit). */
        val overflowed: Set<Int>,
    )

    /**
     * Turn the blend placeholders the engine actually used into real
     * virtual rows. Reuse semantics are identical to
     * `GamutMatcher.applyGamutMatches.ensureBlendRow` (an existing
     * non-deleted plain row with the same components+mix is reused;
     * deleted rows are kept so painted ids stay aligned — gotcha #20).
     */
    fun materialize(
        usedSlots: Set<Int>,
        built: Built,
        existingRows: List<MixedFilamentEntry>,
        maxSlots: Int = MAX_PAINT_SLOTS,
    ): Materialized {
        val rows = existingRows.toMutableList()
        val remap = HashMap<Int, Int>()
        val overflowed = HashSet<Int>()

        fun ensureBlendRow(a1: Int, b1: Int, mixB: Int): Int {
            val existing = rows.indexOfFirst {
                !it.deleted &&
                    it.gradientComponentIds.isEmpty() &&
                    it.manualPattern.isNullOrBlank() &&
                    it.componentA == a1 && it.componentB == b1 &&
                    it.mixBPercent == mixB
            }
            if (existing >= 0) return existing + 1 // 1-based
            rows += MixedFilamentEntry(
                id = "match_${a1}_${b1}_${mixB}",
                componentA = a1,
                componentB = b1,
                mixBPercent = mixB,
                distributionMode = 0, // LayerCycle — forward-correct
                enabled = true,
                custom = true,
            )
            return rows.size
        }

        for (slot in usedSlots.sorted()) {
            val recipe = built.recipeOf[slot]
            if (recipe !is GamutMatcher.GamutRecipe.Blend) continue // physical — unchanged
            val rowIndex1 = ensureBlendRow(
                recipe.componentA1, recipe.componentB1, recipe.mixBPercent,
            )
            val realId = built.physicalCount + rowIndex1
            if (realId in 1..maxSlots) {
                remap[slot] = realId
            } else {
                remap[slot] = built.fallbackPhysicalOf[slot] ?: 1
                overflowed.add(slot)
            }
        }
        return Materialized(remap, rows, overflowed)
    }

    /**
     * Rewrite a per-triangle slot array: physical slots pass through;
     * blend placeholders become their materialized real id (or the
     * fallback physical slot). Virtual placeholders the engine never
     * actually selected are simply absent from [m].remap; any stray
     * one is mapped to its fallback so the output is always a valid
     * physical-or-virtual id.
     */
    fun remapPaint(slots: ByteArray, built: Built, m: Materialized): ByteArray {
        val out = ByteArray(slots.size)
        for (i in slots.indices) {
            val s = slots[i].toInt() and 0xff
            out[i] = when {
                built.recipeOf[s] !is GamutMatcher.GamutRecipe.Blend -> s
                m.remap.containsKey(s) -> m.remap.getValue(s)
                else -> built.fallbackPhysicalOf[s] ?: s
            }.toByte()
        }
        return out
    }
}
