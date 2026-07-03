package dev.orcaxr.app.mobile

import dev.orcaxr.app.FilamentEntry
import dev.orcaxr.app.FilamentSlot
import dev.orcaxr.app.MixedFilamentEntry
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.fullSpectrumExtraOverrides
import dev.orcaxr.app.mergedConfig
import dev.orcaxr.app.resolveAsWillPrintPalette
import dev.orcaxr.app.serializeMixedFilamentDefinitions

internal data class MobileSliceFilamentConfig(
    val projectFilaments: List<FilamentEntry>,
    val physicalSlotCount: Int,
    val physicalPalette: List<String>,
    val asWillPrintPalette: List<String>,
    val slotRemap: List<Int?>,
    val virtualRemap: IntArray,
    val config: Map<String, String>,
) {
    val effectiveVirtualRemap: IntArray?
        get() = virtualRemap.takeUnless { it.all { v -> v == 0 } }
}

internal fun mobilePhysicalSlotCount(
    printer: PrinterConfig?,
    profile: SlicerProfile?,
    savedPhysicalColors: List<String>? = null,
): Int {
    if (printer != null) {
        val name = printer.name.lowercase()
        if ("u1" in name || "snapmaker" in name) return 4
    }
    val profileCount = profile?.config?.get("nozzle_diameter")
        ?.split(',')
        ?.count { it.trim().isNotEmpty() }
        ?: 0
    val savedCount = savedPhysicalColors?.size ?: 0
    return maxOf(profileCount, savedCount, 1)
}

internal fun normalizeMobileProjectFilaments(
    embeddedPalette: List<String>,
    existingEntries: List<FilamentEntry>,
    physicalSlotCount: Int,
    defaultPalette: List<String>,
): List<FilamentEntry> {
    val bySlot = existingEntries.mapNotNull { entry ->
        entry.slotIndex?.let { it to entry }
    }.toMap()
    val existingMax = bySlot.keys.maxOrNull()?.plus(1) ?: 0
    val count = maxOf(embeddedPalette.size, physicalSlotCount, existingMax)
    if (count <= 0) return emptyList()

    fun fallbackColor(index: Int): String =
        if (defaultPalette.isEmpty()) "#FFFFFF"
        else defaultPalette.getOrNull(index % defaultPalette.size) ?: "#FFFFFF"

    return (0 until count).map { index ->
        val existing = bySlot[index]
        FilamentEntry(
            id = existing?.id ?: "slot_$index",
            color = embeddedPalette.getOrNull(index)
                ?: existing?.color
                ?: fallbackColor(index),
            slotIndex = index,
            filamentType = existing?.filamentType ?: "Generic PLA",
            physicalSlot = existing?.physicalSlot,
            virtualSlot = existing?.virtualSlot,
        )
    }
}

internal fun buildMobileSliceFilamentConfig(
    profile: SlicerProfile,
    layerHeightInput: String,
    projectFilaments: List<FilamentEntry>,
    physicalSlotCount: Int,
    physicalSlotColors: List<String>,
    defaultPalette: List<String>,
    virtualRows: List<MixedFilamentEntry>,
    allFilaments: Map<String, Map<String, String>> = emptyMap(),
): MobileSliceFilamentConfig {
    fun defaultColor(index: Int): String =
        if (defaultPalette.isEmpty()) "#FFFFFF"
        else defaultPalette.getOrNull(index % defaultPalette.size) ?: "#FFFFFF"

    val physicalPalette = (0 until physicalSlotCount.coerceAtLeast(1)).map { index ->
        physicalSlotColors.getOrNull(index)?.takeIf { it.isNotBlank() }
            ?: defaultColor(index)
    }
    val normalized = normalizeMobileProjectFilaments(
        embeddedPalette = emptyList(),
        existingEntries = projectFilaments,
        physicalSlotCount = physicalPalette.size,
        defaultPalette = physicalPalette.ifEmpty { defaultPalette },
    )
    val slotRemap = normalized.map { it.physicalSlot }
    val virtualRemap = IntArray(normalized.size) { index ->
        normalized[index].virtualSlot ?: 0
    }
    val mixedDefinitions = serializeMixedFilamentDefinitions(virtualRows)
    val config = mergedConfig(
        profile = profile,
        layerHeightInput = layerHeightInput,
        slotColors = normalized.map { it.color },
        mixedFilamentDefinitions = mixedDefinitions,
        slotRemap = slotRemap,
        extraOverrides = fullSpectrumExtraOverrides(mixedDefinitions.isNotBlank()),
        slotTypes = normalized.map { it.filamentType },
        allFilaments = allFilaments,
    )
    val physicalSlots = physicalPalette.mapIndexed { index, color ->
        FilamentSlot(
            slotIndex = index,
            colorHex = color,
            material = "",
            vendor = "",
        )
    }
    return MobileSliceFilamentConfig(
        projectFilaments = normalized,
        physicalSlotCount = physicalPalette.size,
        physicalPalette = physicalPalette,
        asWillPrintPalette = resolveAsWillPrintPalette(
            filaments = normalized,
            printerLoadedSlots = physicalSlots,
            paletteSuggestions = defaultPalette,
            virtualRows = virtualRows,
            slotCount = physicalPalette.size,
        ),
        slotRemap = slotRemap,
        virtualRemap = virtualRemap,
        config = config,
    )
}
