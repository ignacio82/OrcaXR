package dev.orcaxr.nativeapp.shell

import dev.orcaxr.nativeapp.project.ProjectEditing
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HelpAndPresetsActionsTest {
    @Test
    fun helpActionsAreCompleteAndConfigured() {
        val expectedHelp = listOf(
            "help_shortcuts", "help_docs", "help_report_bug", "help_about", "help_language",
            "help_tutorial", "help_tip_of_day", "help_check_updates", "help_setup_wizard", "help_search",
            "help_mcp_settings", "help_ai_assistant",
        )
        assertEquals(expectedHelp.sorted(), AppActions.HELP.sorted())
        for (action in AppActions.HELP) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
            assertFalse(action, AppActions.needsWorkspace(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }
        assertEquals(expectedHelp.size, ProjectEditing.HELP_MENU.size)
        assertTrue(ProjectEditing.HELP_MENU.all { it in AppActions.HELP })
    }

    @Test
    fun presetActionsAreCompleteAndConfigured() {
        val expectedPresets = listOf(
            "presets_install_printer", "presets_create_custom", "presets_update_custom",
            "presets_delete_custom", "presets_export_bundle", "presets_import_bundle",
        )
        assertEquals(expectedPresets.sorted(), AppActions.PRESETS.sorted())
        for (action in AppActions.PRESETS) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
            assertFalse(action, AppActions.needsWorkspace(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }
    }

    @Test
    fun mcpActionIsConfiguredInPerformedAndHelp() {
        assertTrue("help_mcp_settings" in AppActions.HELP)
        assertTrue("help_mcp_settings" in AppActions.PERFORMED)
        assertTrue("help_mcp_settings" in ProjectEditing.HELP_MENU)
        assertTrue("help_mcp_settings" in ActionTexts.LABELS)
        assertTrue("help_mcp_settings" in ActionTexts.HINTS)
        assertTrue("help_mcp_settings" in OrcaActionGlyphs.actions)
    }
}
