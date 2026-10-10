package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.core.ProjectView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectEditingTest {
    private fun units(text: String) = text.map { it.code }

    private fun row(
        kind: ProjectIntents.ObjectTreeRowKind,
        entity: ProjectIntents.ObjectTreeEntity?,
        label: String = "cube",
        editable: Boolean = true,
    ) = ProjectIntents.ObjectTreeRow(
        units("row:$label"), kind, ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), units(label),
        ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
        entity?.let { ProjectIntents.OptionalObjectTreeEntity.Value(it) } ?: ProjectIntents.OptionalObjectTreeEntity.Absent(ProjectIntents.Empty),
        ProjectIntents.OptionalObjectTreeEntity.Absent(ProjectIntents.Empty),
        ProjectIntents.ObjectTreeIndicators(
            ProjectIntents.ObjectTreePrintable.Printable, ProjectIntents.OptionalObjectTreeFilament.Absent(ProjectIntents.Empty),
            ProjectIntents.OptionalObjectTreePaint.Absent(ProjectIntents.Empty), editable,
            ProjectIntents.OptionalCounter.Absent(ProjectIntents.Empty), ProjectIntents.OptionalVolumeRoleName.Absent(ProjectIntents.Empty),
        ),
        matchedFilter = true, focused = false, selected = false, level = 1, positionInSet = 1, setSize = 1,
        expansion = ProjectIntents.ObjectTreeRowExpansion.Leaf,
    )

    private val objectRow = row(ProjectIntents.ObjectTreeRowKind.Object, ProjectIntents.ObjectTreeEntity.Object(units("o")))
    private val volumeRow = row(ProjectIntents.ObjectTreeRowKind.Volume, ProjectIntents.ObjectTreeEntity.Volume(units("v")), "part")
    private val instanceRow = row(ProjectIntents.ObjectTreeRowKind.Instance, ProjectIntents.ObjectTreeEntity.Instance(units("i")), "Instance 1")
    private val plateRow = row(ProjectIntents.ObjectTreeRowKind.Plate, ProjectIntents.ObjectTreeEntity.Plate(units("p")), "Plate 1", editable = false)
    private val groupRow = row(ProjectIntents.ObjectTreeRowKind.InstanceGroup, null, "Instances (1)", editable = false)

    private fun action(id: String, enabled: Boolean = true) = ProjectActionState(id, id, enabled)

    private val view = ProjectView(
        objectMenu = listOf(action("edit_duplicate"), action("split_to_objects"), action("edit_delete_selected"), action("toggle_printable", false)),
        plateMenu = listOf(action("arrange_all"), action("edit_select_all"), action("add_plate"), action("delete_plate", false)),
        actions = mapOf("edit_select_all" to action("edit_select_all"), "edit_delete_selected" to action("edit_delete_selected", false)),
    )

    @Test
    fun rowActivationSelectsAsTheObjectsPanel() {
        // ObjectsPanel.ts `selectionMode`: Shift extends a range before Ctrl/Meta toggles.
        assertEquals(ProjectRowSelection.Replace, ProjectEditing.rowMode(shift = false, toggle = false))
        assertEquals(ProjectRowSelection.Toggle, ProjectEditing.rowMode(shift = false, toggle = true))
        assertEquals(ProjectRowSelection.Range, ProjectEditing.rowMode(shift = true, toggle = true))
    }

    @Test
    fun onlyEditableObjectsAndPartsRename() {
        assertEquals(ProjectIntents.ObjectTreeEntity.Object(units("o")), ProjectEditing.renameable(objectRow))
        assertEquals(ProjectIntents.ObjectTreeEntity.Volume(units("v")), ProjectEditing.renameable(volumeRow))
        assertNull(ProjectEditing.renameable(instanceRow))
        assertNull(ProjectEditing.renameable(plateRow))
        assertNull(ProjectEditing.renameable(objectRow.copy(indicators = objectRow.indicators.copy(editable = false))))
    }

    @Test
    fun groupsSelectNothing() {
        assertTrue(ProjectEditing.selectable(instanceRow))
        assertTrue(ProjectEditing.selectable(plateRow))
        assertFalse(ProjectEditing.selectable(groupRow))
    }

    @Test
    fun rowMenusAreTheCataloguesPerformedActionsInOrder() {
        fun ids(row: ProjectIntents.ObjectTreeRow) = ProjectEditing.rowMenu(row, view).map {
            when (it) {
                is ProjectEditing.Choice.Rename -> "rename"
                is ProjectEditing.Choice.Action -> it.state.id
            }
        }
        // An object offers Rename and the object menu; actions the app does not perform are left out.
        assertEquals(listOf("rename", "edit_duplicate", "edit_delete_selected", "toggle_printable"), ids(objectRow))
        // An instance points at its object: the object menu, but no Rename.
        assertEquals(listOf("edit_duplicate", "edit_delete_selected", "toggle_printable"), ids(instanceRow))
        assertEquals(listOf("edit_select_all", "add_plate", "delete_plate"), ids(plateRow))
        assertEquals(listOf("rename"), ids(volumeRow))
        assertEquals(emptyList<String>(), ids(groupRow))
        // The core's enablement travels with each action.
        val toggle = ProjectEditing.rowMenu(objectRow, view).filterIsInstance<ProjectEditing.Choice.Action>().last()
        assertFalse(toggle.state.enabled)
        val rename = ProjectEditing.rowMenu(objectRow, view).first() as ProjectEditing.Choice.Rename
        assertEquals("cube", rename.name)
    }

    @Test
    fun theEditMenuListsTheBrowsersEditsDisabledUntilTheCoreAnswers() {
        val menu = ProjectEditing.editMenu(view)
        assertEquals(ProjectEditing.EDIT_MENU, menu.map { it.id })
        assertTrue(menu.first { it.id == "edit_select_all" }.enabled)
        assertFalse(menu.first { it.id == "edit_delete_selected" }.enabled)
        assertFalse(menu.first { it.id == "edit_delete_all" }.enabled)
        assertTrue(ProjectEditing.PERFORMED.containsAll(ProjectEditing.EDIT_MENU))
        assertTrue(ProjectEditing.enabled(view, "edit_select_all"))
        assertFalse(ProjectEditing.enabled(view, "add_plate"))
    }
}
