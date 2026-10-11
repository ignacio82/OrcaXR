package dev.orcaxr.nativeapp.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeChoiceTest {
    @Test fun withoutAChoiceTheSystemDecides() {
        assertTrue(ThemeChoice.dark(null, systemDark = true))
        assertFalse(ThemeChoice.dark(null, systemDark = false))
        // Anything else stored (an older value, a typo) is no choice.
        assertTrue(ThemeChoice.dark("sepia", systemDark = true))
    }

    @Test fun aChoiceOutranksTheSystem() {
        assertFalse(ThemeChoice.dark(ThemeChoice.LIGHT, systemDark = true))
        assertTrue(ThemeChoice.dark(ThemeChoice.DARK, systemDark = false))
    }

    @Test fun theSwitchChoosesTheOtherThemeThanTheOneShown() {
        // The browser's `setDomTheme(active === 'dark' ? 'light' : 'dark')`, with its stored words.
        assertEquals("light", ThemeChoice.toggled(dark = true))
        assertEquals("dark", ThemeChoice.toggled(dark = false))
        // Pressed under the system's dark theme with no choice yet: light is chosen, and stays.
        val chosen = ThemeChoice.toggled(ThemeChoice.dark(null, systemDark = true))
        assertFalse(ThemeChoice.dark(chosen, systemDark = true))
    }
}
