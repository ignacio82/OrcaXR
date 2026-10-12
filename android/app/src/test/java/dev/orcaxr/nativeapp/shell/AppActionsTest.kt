package dev.orcaxr.nativeapp.shell

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.project.ProjectEditing
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppActionsTest {
    @Test fun everyPerformedActionHasTheBrowsersGlyphWordsAndHint() {
        // The palette never lists an action the app cannot perform, and each it lists is drawn and worded as the browser's.
        assertEquals(AppActions.PERFORMED, OrcaActionGlyphs.actions.keys)
        assertEquals(AppActions.PERFORMED, ActionTexts.LABELS.keys)
        assertEquals(AppActions.PERFORMED, ActionTexts.HINTS.keys)
        assertTrue(ProjectEditing.PERFORMED.all { it in AppActions.PERFORMED })
        assertTrue(ProjectEditing.CREATED.all { it in AppActions.PERFORMED })
        assertTrue(AppActions.TOOLBAR.all { it in AppActions.PERFORMED })
        assertTrue(AppActions.QUICK.all { it in AppActions.PERFORMED })
        assertEquals(65, AppActions.PERFORMED.size)
    }

    @Test fun everyCatalogueGroupHeadsItsSectionsInTheAppsLanguage() {
        // The browser's GROUPS in their declared order, each a resource carrying `actionGroup.<id>.label` (its translations
        // generated from the browser's catalogues), so a menu of translated entries is never headed in the core's English.
        assertEquals(
            listOf("file", "edit", "view", "scene", "paint", "slice", "filament", "output", "calibration", "advanced", "help", "system"),
            ActionTexts.GROUPS.keys.toList(),
        )
        assertEquals(ActionTexts.GROUPS.size, ActionTexts.GROUPS.values.toSet().size)
    }

    @Test fun theMenusShortcutsAreTheBrowsers() {
        // DomShell's `shortcutHint`: the first binding, Control as Ctrl, Shift as ⇧.
        assertEquals("Ctrl+Z", OrcaActionGlyphs.actions.getValue("edit_undo").shortcut)
        assertEquals("Ctrl+⇧+Z", OrcaActionGlyphs.actions.getValue("edit_redo").shortcut)
        assertEquals("Delete", OrcaActionGlyphs.actions.getValue("edit_delete_selected").shortcut)
        assertEquals("Escape", OrcaActionGlyphs.actions.getValue("edit_deselect_all").shortcut)
        // The gizmo's tools, each its letter.
        assertEquals(listOf("G", "R", "S"), AppActions.GIZMO.map { OrcaActionGlyphs.actions.getValue(it).shortcut })
        assertEquals(7, OrcaActionGlyphs.actions.values.count { it.shortcut != null })
    }

    @Test fun anActionRunsWhereItCan() {
        AppActions.DOCUMENT.forEach { assertTrue(it, AppActions.needsProject(it)) }
        assertEquals(
            listOf("view_camera_default", "view_camera_top", "view_camera_front", "view_camera_left", "view_camera_right", "view_camera_rear", "view_camera_bottom"),
            AppActions.CAMERA,
        )
        (AppActions.CAMERA + AppActions.TOOLS + AppActions.GIZMO).forEach { assertTrue(it, AppActions.needsWorkspace(it)) }
        assertEquals(listOf("tool_move", "tool_rotate", "tool_scale"), AppActions.GIZMO)
        (AppActions.TOOLS + AppActions.GIZMO).forEach { assertTrue(it, AppActions.isTool(it)) }
        assertFalse(AppActions.isTool("drop_to_bed"))
        listOf("edit_undo", "add_primitive_cube", "delete_models", "drop_to_bed", "mirror_x").forEach {
            assertFalse(it, AppActions.needsWorkspace(it) || AppActions.needsProject(it))
        }
    }

    @Test fun onlyPerformedActionsAreListedInTheCoresOrder() {
        val listed = listOf(
            ProjectActionState("tool_move", "Move", false, "Select a model instance for this action."),
            ProjectActionState("tool_boolean", "Boolean", false, "Select a model instance for this action."),
            ProjectActionState("tool_lay_on_face", "Lay flat", true),
            ProjectActionState("tool_paint", "Paint", true),
            ProjectActionState("drop_to_bed", "Drop to bed", true),
            ProjectActionState("tool_cut", "Cut (Plane)", false, "Plane cutting is disabled"),
            ProjectActionState("help_about", "About OrcaXR", true),
        )
        assertEquals(listOf("tool_move", "tool_lay_on_face", "tool_paint", "drop_to_bed"), AppActions.performed(listed).map { it.id })
    }

    @Test fun aPickTheCoreRefusesSaysWhyAsTheBrowsersStatus() {
        assertEquals("Delete: Select a model instance for this action.", AppActions.unavailable("Delete", "Select a model instance for this action."))
    }

    @Test fun theHighlightMovesAsTheBrowsersKeysMoveIt() {
        assertEquals(1, AppActions.Selection.down(0, 3))
        assertEquals(2, AppActions.Selection.down(2, 3))
        assertEquals(0, AppActions.Selection.down(0, 0))
        assertEquals(0, AppActions.Selection.up(0))
        assertEquals(1, AppActions.Selection.up(2))
    }
}
