package dev.orcaxr.app.mobile

import dev.orcaxr.app.FilamentEntry
import dev.orcaxr.app.GamutMatcher
import dev.orcaxr.app.GamutMatcher.GamutRecipe
import dev.orcaxr.app.GamutMatcher.MatchQuality
import dev.orcaxr.app.MixedFilamentEntry
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.SlicerProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileFilamentPaletteTest {

    private val embeddedSix = listOf(
        "#111111", "#222222", "#333333", "#444444", "#555555", "#666666",
    )

    @Test
    fun normalizePreservesSixProjectColorsOnFourSlotPrinter() {
        val existing = listOf(
            FilamentEntry(id = "p0", color = "#AAAAAA", slotIndex = 0, physicalSlot = 2),
            FilamentEntry(id = "p4", color = "#BBBBBB", slotIndex = 4, virtualSlot = 1),
        )

        val normalized = normalizeMobileProjectFilaments(
            embeddedPalette = embeddedSix,
            existingEntries = existing,
            physicalSlotCount = 4,
            defaultPalette = listOf("#FF0000", "#00FF00", "#0000FF", "#FFFFFF"),
        )

        assertEquals(6, normalized.size)
        assertEquals(embeddedSix, normalized.map { it.color })
        assertEquals((0 until 6).toList(), normalized.map { it.slotIndex })
        assertEquals(2, normalized[0].physicalSlot)
        assertEquals(1, normalized[4].virtualSlot)
    }

    @Test
    fun applyMobileMatchesWritesPhysicalAndVirtualMappings() {
        val filaments = normalizeMobileProjectFilaments(
            embeddedPalette = listOf("#00FF00", "#7A7A7A"),
            existingEntries = emptyList(),
            physicalSlotCount = 4,
            defaultPalette = listOf("#00FF00", "#FFFFFF", "#000000", "#FF0000"),
        )
        val matches = listOf(
            GamutMatcher.GamutMatch(
                sourceIndex = 0,
                sourceHex = "#00FF00",
                targetHex = "#00FF00",
                recipe = GamutRecipe.Physical(0),
                deltaE = 0.0,
                quality = MatchQuality.EXACT,
            ),
            GamutMatcher.GamutMatch(
                sourceIndex = 1,
                sourceHex = "#7A7A7A",
                targetHex = "#7A7A7A",
                recipe = GamutRecipe.Blend(componentA1 = 2, componentB1 = 3, mixBPercent = 50),
                deltaE = 1.0,
                quality = MatchQuality.CLOSE,
            ),
        )

        val result = GamutMatcher.applyGamutMatches(filaments, emptyList(), matches)

        assertEquals(0, result.filaments[0].physicalSlot)
        assertNull(result.filaments[0].virtualSlot)
        assertNull(result.filaments[1].physicalSlot)
        assertEquals(1, result.filaments[1].virtualSlot)
        assertEquals(1, result.virtualRows.size)
        assertEquals(2, result.virtualRows.single().componentA)
        assertEquals(3, result.virtualRows.single().componentB)
        assertEquals(50, result.virtualRows.single().mixBPercent)
        assertTrue(result.virtualRows.single().custom)
    }

    @Test
    fun buildConfigIncludesMixedDefinitionsFilamentMapAndVirtualRemap() {
        val profile = SlicerProfile(
            id = "u1",
            displayName = "U1",
            description = "test",
            config = mapOf(
                "nozzle_diameter" to "0.4,0.4,0.4,0.4",
                "filament_diameter" to "1.75",
                "filament_type" to "PLA",
                "filament_density" to "1.24",
                "layer_height" to "0.20",
                "initial_layer_print_height" to "0.20",
            ),
        )
        val project = embeddedSix.mapIndexed { index, color ->
            FilamentEntry(
                id = "f$index",
                color = color,
                slotIndex = index,
                virtualSlot = if (index == 4) 1 else null,
            )
        }
        val virtualRows = listOf(
            MixedFilamentEntry(
                id = "mix_1_2",
                componentA = 1,
                componentB = 2,
                mixBPercent = 50,
                custom = true,
            ),
        )

        val built = buildMobileSliceFilamentConfig(
            profile = profile,
            layerHeightInput = "",
            projectFilaments = project,
            physicalSlotCount = 4,
            physicalSlotColors = listOf("#111111", "#222222", "#333333", "#444444"),
            defaultPalette = listOf("#111111", "#222222", "#333333", "#444444"),
            virtualRows = virtualRows,
        )

        assertEquals(4, built.physicalSlotCount)
        assertEquals(6, built.projectFilaments.size)
        assertEquals("1,2,3,4,1,2", built.config["filament_map"])
        assertTrue(built.config["mixed_filament_definitions"]!!.isNotBlank())
        assertEquals(0, built.virtualRemap[0])
        assertEquals(1, built.virtualRemap[4])
        assertNotNull(built.effectiveVirtualRemap)
    }

    @Test
    fun u1PhysicalSlotCountDoesNotFollowProjectPaletteLength() {
        val count = mobilePhysicalSlotCount(
            printer = PrinterConfig(id = "p", name = "Snapmaker U1", host = "printer.local"),
            profile = null,
            savedPhysicalColors = embeddedSix,
        )

        assertEquals(4, count)
    }
}
