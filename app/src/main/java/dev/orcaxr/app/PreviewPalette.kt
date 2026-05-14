package dev.orcaxr.app

/**
 * Resolves the project filament palette into "as will print" hex colors —
 * what each project filament will actually look like once the user's
 * physical / virtual remap is applied. The 3MF colored-GLB writer and the
 * STL paint-preview writer both consume one entry per project filament
 * index, so swapping authored colors for resolved colors at this seam
 * makes the in-XR preview match the printed result without touching native.
 *
 * Resolution mirrors UiPanels.resolveMappingTarget: virtualSlot wins, then
 * physicalSlot, then identity. "Identity" here means "the physical slot
 * with the same index" — same semantics as the panel's "Default — T_N"
 * row — which intentionally drops the model author's color on the floor:
 * with no remap the print uses whatever spool is loaded at T_N. If you
 * want the authored palette back, that's [paddedSlots] in MainActivity;
 * keep both available so callers can pick.
 *
 * Per-slot fallback for physical lookups: Moonraker-detected color →
 * paletteSuggestions[i] → "#FFFFFF". Same fallback chain the panel uses
 * to populate `EffectivePrinterSlot`.
 */
fun resolveAsWillPrintPalette(
    filaments: List<FilamentEntry>,
    printerLoadedSlots: List<FilamentSlot>,
    paletteSuggestions: List<String>,
    virtualRows: List<MixedFilamentEntry>,
    slotCount: Int,
): List<String> {
    val byPhysical = printerLoadedSlots.associateBy { it.slotIndex }
    fun physicalColor(physicalIndex: Int): String =
        byPhysical[physicalIndex]?.colorHex
            ?: paletteSuggestions.getOrNull(physicalIndex)
            ?: "#FFFFFF"

    val visibleVirtual = virtualRows.filter { !it.deleted && it.enabled }

    // Iterate to whichever is larger so that authored project filaments
    // beyond the printer's physical slot count (virtual mixtures, manual
    // physical-swap workflows) still get a resolved color in the GLB
    // writer. Truncating to slotCount here was the cause of the "extra
    // colors default to white in the GLB" bug — entries past the bed's
    // slot count fell off the array and slic3r_jni's nativeWriteColoredGlb
    // saw the missing slots as #FFFFFF.
    val resolvedCount = maxOf(filaments.size, slotCount)
    val byProjectIndex = (0 until resolvedCount).map { i ->
        val entry = filaments.getOrNull(i)
        val virtualSlot = entry?.virtualSlot
        val physicalSlot = entry?.physicalSlot
        when {
            virtualSlot != null -> {
                val row = virtualRows.getOrNull(virtualSlot - 1)
                if (row != null) {
                    // Route through resolveMixedRowDisplayColor so the
                    // native pigment blender fires when wired (matches
                    // OrcaSlicer FullSpectrum swatch output). Falls back
                    // to gamma-correct sRGB in pure-JVM tests.
                    resolveMixedRowDisplayColor(
                        row,
                        (0 until slotCount).map { physicalColor(it) },
                    )
                } else {
                    // Dangling virtual reference (row was removed under
                    // the selection). Surface the same neutral the panel
                    // chip uses so the preview doesn't pretend the print
                    // will succeed.
                    "#888888"
                }
            }
            physicalSlot != null -> physicalColor(physicalSlot)
            // Identity fallback (project filament N → physical T_N).
            // Beyond the printer's physical slot count there is no T_N
            // to identity-map onto, so the authored color is the only
            // meaningful signal — without this, GLB indices 4+ on a 4-
            // slot printer would all render white. Inside the slot-
            // count range, keep the historical "use whatever's loaded
            // at T_N" semantics.
            i < slotCount -> physicalColor(i)
            else -> entry?.color ?: "#FFFFFF"
        }
    }

    // Append one entry per virtual mix row so painted faces / per-volume
    // extruder assignments that target a FullSpectrum virtual slot
    // (libslic3r encodes them as `filament_id = num_physical + 1 + idx`
    // — see MixedFilamentManager::mixed_index_from_filament_id) resolve
    // to the row's authored blend color in the GLB writer. Without this
    // extension, painted-face id 5 on a 4-physical-slot print read
    // palette[4] = out of bounds → nativeWriteColoredGlb emitted white,
    // i.e. the user saw "only 4 colors" on the SnOrca hexagon and
    // similar FullSpectrum 3MFs.
    //
    // Deleted/disabled rows keep their palette slot because libslic3r
    // indexes m_mixed[] by raw row position (see the long-standing
    // comment in parseMixedDefinitionsForKotlin). Skipping them would
    // shift every later virtual id down by one and mis-color the model.
    val physicalPalette = (0 until slotCount).map { physicalColor(it) }
    val virtualPalette = virtualRows.map { row ->
        resolveMixedRowDisplayColor(row, physicalPalette)
    }
    return byProjectIndex + virtualPalette
}
