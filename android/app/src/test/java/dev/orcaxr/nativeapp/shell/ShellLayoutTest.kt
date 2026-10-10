package dev.orcaxr.nativeapp.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShellLayoutTest {
    @Test
    fun materialWidthClassesSplitAt600And840Dp() {
        assertEquals(WidthClass.Compact, WidthClass.of(0))
        assertEquals(WidthClass.Compact, WidthClass.of(599))
        assertEquals(WidthClass.Medium, WidthClass.of(600))
        assertEquals(WidthClass.Medium, WidthClass.of(839))
        assertEquals(WidthClass.Expanded, WidthClass.of(840))
        assertEquals(WidthClass.Expanded, WidthClass.of(2560))
    }

    @Test
    fun aPhoneKeepsTheBottomBarAndOneAreaAtATime() {
        // The emulator smoke's phone: 720 x 1280 px at 240 dpi is 480 dp wide; a large phone is 411 dp.
        for (width in listOf(360, 411, 480, 599)) {
            for (area in ShellArea.entries) {
                val layout = ShellLayout.of(width, area)
                assertEquals(Navigation.Bar, layout.navigation)
                assertNull("$area at $width dp", layout.viewport)
            }
        }
    }

    @Test
    fun aMediumWindowHasTheRailAndStillOneAreaAtATime() {
        // A portrait tablet or a half-screen desktop window; the smoke's 720 px at 160 dpi.
        for (width in listOf(600, 720, 839)) {
            for (area in ShellArea.entries) {
                val layout = ShellLayout.of(width, area)
                assertEquals(Navigation.Rail, layout.navigation)
                assertNull("$area at $width dp", layout.viewport)
            }
        }
    }

    @Test
    fun anExpandedWindowPutsTheAreasPanelBesideTheViewportAsTheBrowsersSidebar() {
        for (width in listOf(840, 1280)) {
            fun viewport(area: ShellArea) = ShellLayout.of(width, area).let {
                assertEquals(Navigation.Rail, it.navigation)
                it.viewport
            }
            assertEquals(Viewport.Workspace, viewport(ShellArea.Prepare))
            // The object tree, which the browser's sidebar shows as its Objects card.
            assertEquals(Viewport.Workspace, viewport(ShellArea.Project))
            assertEquals(Viewport.Toolpath, viewport(ShellArea.Preview))
            // The Workspace is the viewport itself; Device is a full page, as the browser's.
            assertNull(viewport(ShellArea.Workspace))
            assertNull(viewport(ShellArea.Device))
        }
    }

    @Test
    fun thePanelIsTheBrowsersSidebarWidthNarrowingInWindowsUpTo1180Dp() {
        assertEquals(312, ShellLayout.of(840, ShellArea.Prepare).panelWidthDp)
        assertEquals(312, ShellLayout.of(1180, ShellArea.Prepare).panelWidthDp)
        assertEquals(356, ShellLayout.of(1181, ShellArea.Prepare).panelWidthDp)
        assertEquals(356, ShellLayout.of(1280, ShellArea.Preview).panelWidthDp)
    }
}
