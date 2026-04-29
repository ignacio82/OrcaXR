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

    return (0 until slotCount).map { i ->
        val entry = filaments.getOrNull(i)
        val virtualSlot = entry?.virtualSlot
        val physicalSlot = entry?.physicalSlot
        when {
            virtualSlot != null -> {
                val row = visibleVirtual.getOrNull(virtualSlot - 1)
                if (row != null) {
                    val a = physicalColor(row.componentA - 1)
                    val b = physicalColor(row.componentB - 1)
                    blendMixedColor(a, b, row.ratioA, row.ratioB)
                } else {
                    // Dangling virtual reference (row was removed under
                    // the selection). Surface the same neutral the panel
                    // chip uses so the preview doesn't pretend the print
                    // will succeed.
                    "#888888"
                }
            }
            physicalSlot != null -> physicalColor(physicalSlot)
            else -> physicalColor(i)
        }
    }
}
