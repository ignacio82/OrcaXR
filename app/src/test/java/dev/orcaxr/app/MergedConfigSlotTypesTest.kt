package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * B3 — when the user picks a per-slot filament type
 * (e.g. "Generic PLA" on slot 0, "Generic PETG" on slot 1), the
 * matching flattened filament profile from
 * [OrcaProfileLoader.loadFilaments] must override the active machine
 * profile's per-extruder vector at slice time. PLA at 215 + PETG at
 * 240 should land in `nozzle_temperature` slot-by-slot, NOT collapse
 * to whatever the machine profile happens to default to.
 */
class MergedConfigSlotTypesTest {

    private val baseProfile = SlicerProfile(
        id = "test_profile",
        displayName = "Test profile",
        description = "Synthetic for B3 slot-type override",
        config = mapOf(
            "layer_height" to "0.20",
            "nozzle_diameter" to "0.4",
            "nozzle_temperature" to "200",
            "filament_max_volumetric_speed" to "12",
        ),
    )

    private fun parseCsv(s: String?): List<String> =
        s.orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }

    @Test fun perSlotFilamentTypeOverridesNozzleTemperature() {
        val pla = mapOf(
            "nozzle_temperature" to "215",
            "filament_max_volumetric_speed" to "10",
        )
        val petg = mapOf(
            "nozzle_temperature" to "240",
            "filament_max_volumetric_speed" to "8",
        )
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00"),
            slotTypes = listOf("Generic PLA", "Generic PETG"),
            allFilaments = mapOf(
                "Generic PLA" to pla,
                "Generic PETG" to petg,
            ),
        )
        assertEquals(listOf("215", "240"), parseCsv(cfg["nozzle_temperature"]))
        assertEquals(listOf("10", "8"), parseCsv(cfg["filament_max_volumetric_speed"]))
    }

    @Test fun unknownSlotTypeFallsBackToProfileVector() {
        // Slot 0 known, slot 1's material is missing from catalog —
        // slot 1 should fall back to the active profile's value (200).
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00"),
            slotTypes = listOf("Generic PLA", "Mystery Goo"),
            allFilaments = mapOf(
                "Generic PLA" to mapOf("nozzle_temperature" to "215"),
            ),
        )
        assertEquals(listOf("215", "200"), parseCsv(cfg["nozzle_temperature"]))
    }

    @Test fun emptySlotTypesPreservesLegacyResizeBehavior() {
        // Default-empty slotTypes/allFilaments → legacy resize
        // (replicate first entry across all slots).
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00", "#0000FF"),
        )
        assertEquals(listOf("200", "200", "200"), parseCsv(cfg["nozzle_temperature"]))
    }
}
