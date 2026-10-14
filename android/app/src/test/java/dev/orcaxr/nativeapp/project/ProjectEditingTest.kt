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
        objectMenu = listOf(action("edit_duplicate"), action("tool_cut"), action("edit_delete_selected"), action("toggle_printable", false)),
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
        // The plate menu's Auto-arrange is performed too (on the active plate, as the browser's).
        assertEquals(listOf("arrange_all", "edit_select_all", "add_plate", "delete_plate"), ids(plateRow))
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
        assertEquals(ProjectEditing.EDIT_CLIPBOARD + ProjectEditing.EDIT_MENU + ProjectEditing.EDIT_INSTANCES, menu.map { it.id })
        assertTrue(menu.first { it.id == "edit_select_all" }.enabled)
        assertFalse(menu.first { it.id == "edit_delete_selected" }.enabled)
        assertFalse(menu.first { it.id == "edit_delete_all" }.enabled)
        assertTrue(ProjectEditing.PERFORMED.containsAll(ProjectEditing.EDIT_MENU))
        assertTrue(ProjectEditing.enabled(view, "edit_select_all"))
        assertFalse(ProjectEditing.enabled(view, "add_plate"))
    }

    @Test
    fun placementFollowsTheEditsInCatalogueOrderWithTheCoresEnablement() {
        // web/src/actions/groups: the Lay flat tool, the scene's edits, its toolbar's Drop to bed, the plate's Auto-arrange.
        assertEquals(
            listOf(
                "tool_lay_on_face", "mirror_x", "mirror_y", "mirror_z", "reset_rotation", "reset_scale", "center_on_plate",
                "scale_to_fit_volume", "drop_to_bed", "arrange_all",
            ),
            ProjectEditing.PLACEMENT_MENU,
        )
        assertTrue(ProjectEditing.PERFORMED.containsAll(ProjectEditing.PLACEMENT_MENU))
        val placed = view.copy(actions = mapOf("mirror_x" to action("mirror_x"), "center_on_plate" to action("center_on_plate", false)))
        val menu = ProjectEditing.placementMenu(placed)
        assertEquals(ProjectEditing.PLACEMENT_MENU, menu.map { it.id })
        assertTrue(menu.first { it.id == "mirror_x" }.enabled)
        assertFalse(menu.first { it.id == "center_on_plate" }.enabled)
        // Not answered yet: disabled.
        assertFalse(menu.first { it.id == "drop_to_bed" }.enabled)
        // An object row's menu offers the catalogue's placement actions the app performs, in its order.
        val objectMenu = view.copy(objectMenu = listOf(action("tool_lay_on_face"), action("tool_cut"), action("mirror_x"), action("drop_to_bed", false)))
        val ids = ProjectEditing.rowMenu(instanceRow, objectMenu).filterIsInstance<ProjectEditing.Choice.Action>().map { it.state.id }
        assertEquals(listOf("tool_lay_on_face", "mirror_x", "drop_to_bed"), ids)
    }

    private fun idList(vararg ids: String) = ids.map { units(it) }

    @Test
    fun placementStatusesAreTheBrowsers() {
        fun drop(delta: Double) = ProjectIntents.PlacementDrop(units("i"), 5.0, delta)
        // OrcaWorkspace.dropSelectedToBed: said only when nothing moved.
        assertEquals("The selected model is already on the bed.", ProjectEditing.droppedStatus(listOf(drop(0.0))))
        assertEquals("The selected models are already on the bed.", ProjectEditing.droppedStatus(listOf(drop(0.0), drop(0.0))))
        assertNull(ProjectEditing.droppedStatus(listOf(drop(0.0), drop(-2.0))))
        assertNull(ProjectEditing.droppedStatus(null))
        // scaleSelectionToFitPrintVolume: nothing changed.
        assertEquals("The selection already fills the build volume.", ProjectEditing.scaledStatus(0))
        assertNull(ProjectEditing.scaledStatus(2))
        assertNull(ProjectEditing.scaledStatus(null))
        // arrangePlate: some did not fit, or nothing moved.
        fun placement(id: String) = ProjectIntents.ArrangePlacement(
            units(id), ProjectIntents.Transform(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0)),
            ProjectIntents.ArrangeRegion(0.0, 0.0, 1.0, 1.0),
        )
        assertEquals("Arranged 2 model(s); 1 did not fit on this plate.", ProjectEditing.arrangedStatus(ProjectIntents.Arrangement(listOf(placement("a"), placement("b")), idList("c"), emptyList())))
        assertEquals("The plate is already arranged.", ProjectEditing.arrangedStatus(ProjectIntents.Arrangement(emptyList(), emptyList(), emptyList())))
        assertNull(ProjectEditing.arrangedStatus(ProjectIntents.Arrangement(listOf(placement("a")), emptyList(), emptyList())))
        // layPickedFacetOnBed (main.ts's "Transform failed" is a mapped resource, project_transform_failed).
        assertEquals("Lay flat failed: Unknown instance i", ProjectEditing.layFlatFailed("Unknown instance i"))
    }

    @Test
    fun modelToolsFollowPlacementAndObjectsOfferSplitAndSimplify() {
        // The browser's Tools menu split and simplify, its toolbar's Measure, Brim Ears, Emboss Text and SVG Part,
        // then its Tools menu's wipe-tower placement: performed, with the core's enablement.
        assertEquals(
            listOf(
                "split_to_objects", "split_to_parts", "simplify_model", "repair_model", "mesh_boolean_union", "mesh_boolean_subtract", "mesh_boolean_intersection",
                "variable_layer_height", "tool_measure", "tool_assembly", "tool_brim_ears", "add_emboss", "tool_svg",
                "auto_place_wipe",
            ),
            ProjectEditing.TOOLS_MENU,
        )
        assertTrue(ProjectEditing.PERFORMED.containsAll(ProjectEditing.TOOLS_MENU))
        val tooled = view.copy(
            actions = mapOf("split_to_parts" to action("split_to_parts"), "tool_measure" to action("tool_measure", false)),
            objectMenu = listOf(action("split_to_objects"), action("split_to_parts", false), action("simplify_model"), action("tool_cut")),
        )
        val menu = ProjectEditing.toolsMenu(tooled)
        assertEquals(ProjectEditing.TOOLS_MENU, menu.map { it.id })
        assertTrue(menu.first { it.id == "split_to_parts" }.enabled)
        assertFalse(menu.first { it.id == "tool_measure" }.enabled)
        // Not answered yet: disabled.
        assertFalse(menu.first { it.id == "split_to_objects" }.enabled)
        // An object's menu (and an instance's, which points at it) offers the catalogue's split and simplify in its order.
        fun ids(row: ProjectIntents.ObjectTreeRow) = ProjectEditing.rowMenu(row, tooled)
            .filterIsInstance<ProjectEditing.Choice.Action>().map { it.state.id to it.state.enabled }
        assertEquals(listOf("split_to_objects" to true, "split_to_parts" to false, "simplify_model" to true), ids(instanceRow))
        assertEquals(ids(instanceRow), ids(objectRow))
    }

    @Test
    fun creationOffersTheBrowsersClipboardAddMenuAndBedFill() {
        // The clipboard opens the Edit menu, as in the browser's; instance creations close it.
        assertEquals(listOf("edit_cut", "edit_copy", "edit_paste"), ProjectEditing.editMenu(view).take(3).map { it.id })
        assertEquals(listOf("add_instance", "fill_bed_with_instances"), ProjectEditing.editMenu(view).takeLast(2).map { it.id })
        // The Add menu: the six primitives in the browser's order, calibration models, then the helper volumes, Set as Negative Part, and Add Magnet Hole.
        assertEquals(
            listOf(
                "add_primitive_cube", "add_primitive_cylinder", "add_primitive_sphere", "add_primitive_cone", "add_primitive_disc",
                "add_primitive_torus", "add_calibration_cube", "add_calibration_tower", "add_handy_model",
                "add_modifier", "add_support_enforcer", "add_support_blocker", "set_negative_part", "add_magnet",
            ),
            ProjectEditing.ADD_MENU,
        )
        val creating = view.copy(
            actions = mapOf("add_primitive_cube" to action("add_primitive_cube"), "add_modifier" to action("add_modifier", false)),
            objectMenu = listOf(action("add_instance"), action("fill_bed_with_instances"), action("tool_cut")),
            plateMenu = listOf(action("add_primitive_torus"), action("arrange_all")),
        )
        val add = ProjectEditing.addMenu(creating)
        assertTrue(add.first { it.id == "add_primitive_cube" }.enabled)
        assertFalse(add.first { it.id == "add_modifier" }.enabled)
        assertFalse(add.first { it.id == "add_support_blocker" }.enabled)
        // An action the core has not answered for yet is disabled.
        assertFalse(add.first { it.id == "set_negative_part" }.enabled)
        // Row menus offer the creations the app performs beside its other actions: a bed fill for an object, a primitive for a
        // plate (whose Arrange, as the browser's, arranges the active plate); what the app does not perform stays out.
        fun ids(row: ProjectIntents.ObjectTreeRow) = ProjectEditing.rowMenu(row, creating)
            .filterIsInstance<ProjectEditing.Choice.Action>().map { it.state.id }
        assertEquals(listOf("add_instance", "fill_bed_with_instances"), ids(instanceRow))
        assertEquals(listOf("add_primitive_torus", "arrange_all"), ids(plateRow))
    }

    @Test
    fun viewAndHelpMenusOfferTheBrowsersActions() {
        assertEquals(ProjectEditing.VIEW_MENU, ProjectEditing.viewMenu(view).map { it.id })
        assertEquals(ProjectEditing.HELP_MENU, ProjectEditing.helpMenu(view).map { it.id })
        assertTrue(ProjectEditing.viewMenu(view.copy(ready = true)).all { it.enabled })
        assertTrue(ProjectEditing.helpMenu(view.copy(ready = true)).all { it.enabled })
    }
}
