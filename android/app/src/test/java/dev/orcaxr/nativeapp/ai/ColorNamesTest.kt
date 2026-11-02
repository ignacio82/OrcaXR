package dev.orcaxr.nativeapp.ai

import org.junit.Assert.assertEquals
import org.junit.Test

class ColorNamesTest {
    @Test
    fun testStandardFilamentColors() {
        assertEquals("Light Blue", ColorNames.nameOf("#8BD5EE"))
        assertEquals("Green", ColorNames.nameOf("#519F61"))
        assertEquals("Orange", ColorNames.nameOf("#E65100"))
        assertEquals("White", ColorNames.nameOf("#FFFFFF"))
        assertEquals("Black", ColorNames.nameOf("#000000"))
        assertEquals("Red", ColorNames.nameOf("#FF0000"))
        assertEquals("Yellow", ColorNames.nameOf("#FFFF00"))
        assertEquals("Purple", ColorNames.nameOf("#A020F0"))
        assertEquals("Gray", ColorNames.nameOf("#808080"))
    }

    @Test
    fun testFindSlotByColorOrNumber() {
        val filaments = listOf(
            dev.orcaxr.core.FilamentOption("fil_1", false, "Bambu White PLA", "#FFFFFF", true, "PLA", null, 0, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_2", false, "Bambu Blue PLA", "#1E88E5", true, "PLA", null, 1, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_3", false, "Bambu Orange PLA", "#E65100", true, "PLA", null, 2, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_4", false, "Bambu Green PLA", "#519F61", true, "PLA", null, 3, null, emptyList(), emptyList()),
        )

        assertEquals("1", ColorNames.findSlotByColorOrNumber("1", filaments))
        assertEquals("2", ColorNames.findSlotByColorOrNumber(2, filaments))
        assertEquals("1", ColorNames.findSlotByColorOrNumber("white", filaments))
        assertEquals("2", ColorNames.findSlotByColorOrNumber("blue", filaments))
        assertEquals("3", ColorNames.findSlotByColorOrNumber("orange", filaments))
        assertEquals("4", ColorNames.findSlotByColorOrNumber("green", filaments))
    }

    @Test
    fun testFindFilamentIdByColorOrNumber() {
        val filaments = listOf(
            dev.orcaxr.core.FilamentOption("fil_1", false, "Bambu White PLA", "#FFFFFF", true, "PLA", null, 0, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_2", false, "Bambu Blue PLA", "#1E88E5", true, "PLA", null, 1, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_3", false, "Bambu Orange PLA", "#E65100", true, "PLA", null, 2, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_4", false, "Bambu Green PLA", "#519F61", true, "PLA", null, 3, null, emptyList(), emptyList()),
        )

        assertEquals("fil_1", ColorNames.findFilamentIdByColorOrNumber("1", filaments))
        assertEquals("fil_2", ColorNames.findFilamentIdByColorOrNumber(2, filaments))
        assertEquals("fil_1", ColorNames.findFilamentIdByColorOrNumber("white", filaments))
        assertEquals("fil_2", ColorNames.findFilamentIdByColorOrNumber("blue", filaments))
        assertEquals("fil_3", ColorNames.findFilamentIdByColorOrNumber("orange", filaments))
        assertEquals("fil_4", ColorNames.findFilamentIdByColorOrNumber("green", filaments))
        assertEquals("fil_3", ColorNames.findFilamentIdByColorOrNumber("fil_3", filaments))
    }

    @Test
    fun testHexForColorName() {
        assertEquals("#FFFFFF", ColorNames.hexForColorName("white"))
        assertEquals("#000000", ColorNames.hexForColorName("black"))
        assertEquals("#0000FF", ColorNames.hexForColorName("blue"))
        assertEquals("#FF6A13", ColorNames.hexForColorName("orange"))
        assertEquals("#8BD5EE", ColorNames.hexForColorName("light blue"))
        assertEquals(null, ColorNames.hexForColorName("nonexistent_color_xyz"))
    }
}
