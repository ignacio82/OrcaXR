package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pin the "as will print" palette resolver. The in-XR preview hands this
 * list straight to the colored-GLB writer (see MainActivity.previewStl),
 * so every case here corresponds to a class of visual regression the
 * user would notice in the headset.
 */
class PreviewPaletteTest {

    private val suggestions = listOf(
        "#FF0000", // T0 default
        "#00FF00", // T1 default
        "#0000FF", // T2 default
        "#FFFFFF", // T3 default
    )

    private fun fil(slot: Int, color: String, physical: Int? = null, virtual: Int? = null) =
        FilamentEntry(
            id = "s$slot",
            color = color,
            slotIndex = slot,
            filamentType = "PLA",
            physicalSlot = physical,
            virtualSlot = virtual,
        )

    @Test fun identityFallsBackToPrinterSlotColor() {
        // No remap → "default = T_N" — picks the printer's loaded color
        // for slot N (with palette suggestion as fallback). The model's
        // authored color is intentionally NOT used: identity prints
        // from T_N regardless of what the author painted.
        val authored = listOf(
            fil(0, "#112233"),
            fil(1, "#445566"),
            fil(2, "#778899"),
            fil(3, "#AABBCC"),
        )
        val loaded = listOf(
            FilamentSlot(0, "#FFAA00", "PLA", "Elegoo"),
            FilamentSlot(1, "#00AAFF", "PLA", "Elegoo"),
        )
        val resolved = resolveAsWillPrintPalette(
            filaments = authored,
            printerLoadedSlots = loaded,
            paletteSuggestions = suggestions,
            virtualRows = emptyList(),
            slotCount = 4,
        )
        assertEquals(listOf("#FFAA00", "#00AAFF", "#0000FF", "#FFFFFF"), resolved)
    }

    @Test fun physicalRemapPicksLoadedSlotColor() {
        // User mapped project filament 0 → physical T2. Resolver returns
        // T2's loaded color for index 0, leaving every other slot at its
        // identity.
        val filaments = listOf(
            fil(0, "#112233", physical = 2),
            fil(1, "#445566"),
            fil(2, "#778899"),
            fil(3, "#AABBCC"),
        )
        val loaded = listOf(
            FilamentSlot(0, "#111111", "PLA", "Elegoo"),
            FilamentSlot(1, "#222222", "PLA", "Elegoo"),
            FilamentSlot(2, "#333333", "PLA", "Elegoo"),
            FilamentSlot(3, "#444444", "PLA", "Elegoo"),
        )
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = loaded,
            paletteSuggestions = suggestions,
            virtualRows = emptyList(),
            slotCount = 4,
        )
        assertEquals(listOf("#333333", "#222222", "#333333", "#444444"), resolved)
    }

    @Test fun virtualRemapBlendsComponents() {
        // V1 = T1 + T2 (1:1). Project filament 0 → V1 should blend
        // pure red and pure blue → midway purple.
        val filaments = listOf(
            fil(0, "#000000", virtual = 1),
            fil(1, "#FFFFFF"),
        )
        val loaded = listOf(
            FilamentSlot(0, "#FF0000", "PLA", "Elegoo"),
            FilamentSlot(1, "#0000FF", "PLA", "Elegoo"),
        )
        val virtualRows = listOf(
            MixedFilamentEntry(id = "v1", componentA = 1, componentB = 2, ratioA = 1, ratioB = 1),
        )
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = loaded,
            paletteSuggestions = suggestions,
            virtualRows = virtualRows,
            slotCount = 2,
        )
        // 50/50 blend of #FF0000 and #0000FF → #7F007F (each channel
        // averaged via blendMixedColor's int truncation).
        assertEquals("#7F007F", resolved[0])
        // Slot 1 was untouched, defaults to T1's loaded color.
        assertEquals("#0000FF", resolved[1])
    }

    @Test fun missingVirtualRowSurfacesNeutral() {
        // User pointed slot 0 at V2, but only V1 exists. The resolver
        // shouldn't pretend the print succeeds — return the same
        // "missing" neutral the panel chip uses so the in-XR preview
        // visibly reads "something's off."
        val filaments = listOf(fil(0, "#000000", virtual = 2))
        val virtualRows = listOf(
            MixedFilamentEntry(id = "v1", componentA = 1, componentB = 2),
        )
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = emptyList(),
            paletteSuggestions = suggestions,
            virtualRows = virtualRows,
            slotCount = 1,
        )
        assertEquals(listOf("#888888"), resolved)
    }

    @Test fun deletedOrDisabledVirtualRowsAreSkipped() {
        // Visible virtual list filters out deleted + disabled rows.
        // V1 visible = the second `MixedFilamentEntry` (the first is
        // deleted), so virtualSlot=1 should resolve to that row.
        val filaments = listOf(fil(0, "#000000", virtual = 1))
        val loaded = listOf(
            FilamentSlot(0, "#FF0000", "PLA", "Elegoo"),
            FilamentSlot(1, "#00FF00", "PLA", "Elegoo"),
        )
        val virtualRows = listOf(
            MixedFilamentEntry(id = "tombstoned", componentA = 1, componentB = 2, deleted = true),
            MixedFilamentEntry(id = "v1_real", componentA = 1, componentB = 2, ratioA = 1, ratioB = 1),
        )
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = loaded,
            paletteSuggestions = suggestions,
            virtualRows = virtualRows,
            slotCount = 1,
        )
        assertEquals("#7F7F00", resolved[0])
    }

    @Test fun partialPrinterLoadoutFallsBackToSuggestions() {
        // Only T0 detected. Identity rows for T1..T3 fall back to the
        // palette suggestions instead of "#FFFFFF" — keeps the preview
        // showing reasonable defaults when the printer's offline.
        val filaments = (0..3).map { fil(it, "#000000") }
        val loaded = listOf(FilamentSlot(0, "#ABCDEF", "PLA", "Elegoo"))
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = loaded,
            paletteSuggestions = suggestions,
            virtualRows = emptyList(),
            slotCount = 4,
        )
        assertEquals(listOf("#ABCDEF", "#00FF00", "#0000FF", "#FFFFFF"), resolved)
    }

    @Test fun slotCountBeyondFilamentListPaddedFromPrinter() {
        // slotCount can exceed filaments.size during transitional states
        // (e.g. fresh printer pick, async store hydrating). Out-of-range
        // entries treat as identity → printer loadout / suggestion.
        val filaments = listOf(fil(0, "#000000"))
        val resolved = resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = emptyList(),
            paletteSuggestions = suggestions,
            virtualRows = emptyList(),
            slotCount = 4,
        )
        assertEquals(suggestions, resolved)
    }
}
