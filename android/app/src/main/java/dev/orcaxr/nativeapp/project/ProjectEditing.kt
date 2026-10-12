package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.GizmoMode
import dev.orcaxr.core.HelperVolumeRole
import dev.orcaxr.core.PrimitiveShape
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.TransformTool

/**
 * The Project area's editing choices, as the browser makes them, kept free
 * of Android so they are checked on the JVM: how a tree row's activation
 * selects (web/src/ui/dom/ObjectsPanel.ts `selectionMode`), which rows a
 * person may rename, which catalogue actions a row's menu offers (the
 * catalogue's context menus — ObjectsPanel's `contextTargetForRow` — limited
 * to the actions this app performs) and which the Edit menu lists.
 */
object ProjectEditing {
    /** What a row's long-press menu or the Edit menu can ask of the project. */
    sealed interface Choice {
        /** A catalogue action ([ProjectActionState.id]) the app performs. */
        data class Action(val state: ProjectActionState) : Choice
        /** The Objects panel's own Rename, for an editable object or part. */
        data class Rename(val entity: ProjectIntents.ObjectTreeEntity, val name: String) : Choice
    }

    /**
     * The placement actions, after the Edit menu's edits and in catalogue
     * order: the Lay flat tool (a Workspace tap then lays the tapped facet on
     * the bed), the scene's mirror, resets, centre and scale to fit, Drop to
     * bed and the plate's Auto-arrange.
     */
    val PLACEMENT_MENU = listOf(
        "tool_lay_on_face", "mirror_x", "mirror_y", "mirror_z", "reset_rotation", "reset_scale", "center_on_plate",
        "scale_to_fit_volume", "drop_to_bed", "arrange_all",
    )

    /**
     * The model tools, after the placement actions: the browser's split and
     * simplify (its Tools menu, also an object's context actions) and its
     * toolbar's Measure, a Workspace tap tool as Lay flat is.
     */
    val TOOLS_MENU = listOf("split_to_objects", "split_to_parts", "simplify_model", "tool_measure")

    /** The catalogue actions the app performs, by ID. */
    val PERFORMED = setOf(
        "edit_select_all", "edit_deselect_all", "edit_duplicate", "add_instance", "edit_delete_selected", "edit_delete_all",
        "toggle_printable", "instance_to_object", "add_plate", "duplicate_plate", "delete_plate",
    ) + PLACEMENT_MENU + TOOLS_MENU

    /** The Edit menu, in the browser's menu order (web/src/actions/groups/edit.ts, then the scene's object edits). */
    val EDIT_MENU = listOf(
        "edit_select_all", "edit_deselect_all", "edit_duplicate", "edit_delete_selected", "edit_delete_all",
        "toggle_printable", "instance_to_object",
    )

    /** The Edit menu's clipboard, first as in the browser's Edit menu, and its instance creations, after its object edits. */
    val EDIT_CLIPBOARD = listOf("edit_cut", "edit_copy", "edit_paste")
    val EDIT_INSTANCES = listOf("add_instance", "fill_bed_with_instances")

    /** The Add menu: the browser's `add` section primitives (scene.ts), then the helper volumes for the selected object (gizmos.ts). */
    val ADD_MENU = PrimitiveShape.PRIMITIVES.mapNotNull { it.actionId } +
        HelperVolumeRole.entries.mapNotNull { it.actionId }

    /** Creation's catalogue actions the app performs: the clipboard, the bed fill and the Add menu. */
    val CREATED = (EDIT_CLIPBOARD + EDIT_INSTANCES + ADD_MENU).toSet()

    /** A row activation's selection: Shift extends a range, Ctrl or Meta toggles, a plain tap replaces. */
    fun rowMode(shift: Boolean, toggle: Boolean): ProjectRowSelection = when {
        shift -> ProjectRowSelection.Range
        toggle -> ProjectRowSelection.Toggle
        else -> ProjectRowSelection.Replace
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** The row's entity a rename changes: an object or a part the project lets a person edit. */
    fun renameable(row: ProjectIntents.ObjectTreeRow): ProjectIntents.ObjectTreeEntity? {
        val entity = (row.entity as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value ?: return null
        val kind = entity is ProjectIntents.ObjectTreeEntity.Object || entity is ProjectIntents.ObjectTreeEntity.Volume
        return entity.takeIf { kind && row.indicators.editable }
    }

    /** Whether activating the row selects something: rows of an entity; groups and settings rows select nothing. */
    fun selectable(row: ProjectIntents.ObjectTreeRow): Boolean = row.entity is ProjectIntents.OptionalObjectTreeEntity.Value

    /**
     * A row's long-press menu: Rename for an editable object or part, then
     * the catalogue's menu for the row — a plate's for a plate row, an
     * object's for an object or instance row (an instance is how a person
     * points at an object), none for parts and ranges — limited to what the
     * app performs, in catalogue order with the core's enablement.
     */
    fun rowMenu(row: ProjectIntents.ObjectTreeRow, view: ProjectView): List<Choice> = buildList {
        renameable(row)?.let { add(Choice.Rename(it, text(row.label))) }
        val menu = when (row.kind) {
            ProjectIntents.ObjectTreeRowKind.Plate -> view.plateMenu
            ProjectIntents.ObjectTreeRowKind.Object, ProjectIntents.ObjectTreeRowKind.Instance -> view.objectMenu
            else -> emptyList()
        }
        menu.filter { it.id in PERFORMED || it.id in CREATED }.forEach { add(Choice.Action(it)) }
    }

    /** The Edit menu's actions with the core's enablement; one the core has not answered for yet is disabled. */
    fun editMenu(view: ProjectView): List<ProjectActionState> =
        (EDIT_CLIPBOARD + EDIT_MENU + EDIT_INSTANCES).map { id -> view.actions[id] ?: ProjectActionState(id, id, enabled = false) }

    /** The Add menu's actions with the core's enablement, as [editMenu]. */
    fun addMenu(view: ProjectView): List<ProjectActionState> =
        ADD_MENU.map { id -> view.actions[id] ?: ProjectActionState(id, id, enabled = false) }

    /** The Edit menu's placement actions with the core's enablement; one the core has not answered for yet is disabled. */
    fun placementMenu(view: ProjectView): List<ProjectActionState> =
        PLACEMENT_MENU.map { id -> view.actions[id] ?: ProjectActionState(id, id, enabled = false) }

    /** The Edit menu's model tools with the core's enablement; one the core has not answered for yet is disabled. */
    fun toolsMenu(view: ProjectView): List<ProjectActionState> =
        TOOLS_MENU.map { id -> view.actions[id] ?: ProjectActionState(id, id, enabled = false) }

    /** Whether the core enables action [id] now. */
    fun enabled(view: ProjectView, id: String): Boolean = view.actions[id]?.enabled == true

    // The browser workspace's statuses for placement outcomes the project's history alone does not
    // show (OrcaWorkspace `dropSelectedToBed`, `scaleSelectionToFitPrintVolume`, `arrangePlate`) and
    // for refused inspector and Lay flat edits (main.ts `onTransformChange`, `layPickedFacetOnBed`).

    /** Drop to bed that moved nothing; null when it moved a model (or had nothing to drop). */
    fun droppedStatus(drops: List<ProjectIntents.PlacementDrop>?): String? = when {
        drops.isNullOrEmpty() || drops.any { it.deltaZMm != 0.0 } -> null
        drops.size == 1 -> "The selected model is already on the bed."
        else -> "The selected models are already on the bed."
    }

    /** Scale to build volume that changed nothing ([changed] 0); null otherwise. */
    fun scaledStatus(changed: Int?): String? = if (changed == 0) "The selection already fills the build volume." else null

    /** An arrangement some models did not fit, or that moved nothing; null when it simply arranged them. */
    fun arrangedStatus(arrangement: ProjectIntents.Arrangement?): String? {
        arrangement ?: return null
        val moved = arrangement.placements.size
        val unplaced = arrangement.unplacedInstanceIds.size
        return when {
            unplaced > 0 -> "Arranged $moved model(s); $unplaced did not fit on this plate."
            moved == 0 -> "The plate is already arranged."
            else -> null
        }
    }

    fun layFlatFailed(reason: String?): String = "Lay flat failed: ${reason.orEmpty()}"

    /** The gizmo's Move, Rotate and Scale, the toolbar's tools that choose its mode (the browser's `setTool`). */
    val GIZMO_TOOLS = listOf("tool_move", "tool_rotate", "tool_scale")

    /** The tool that chooses gizmo [mode]: Move translates, Rotate rotates, Scale scales. */
    fun gizmoAction(mode: GizmoMode): String = when (mode) {
        GizmoMode.TRANSLATE -> "tool_move"
        GizmoMode.ROTATE -> "tool_rotate"
        GizmoMode.SCALE -> "tool_scale"
    }

    /** How a drag in [mode] carries a selection round its proxy (the browser's `transformMode`). */
    fun transformTool(mode: GizmoMode): TransformTool = when (mode) {
        GizmoMode.TRANSLATE -> TransformTool.MOVE
        GizmoMode.ROTATE -> TransformTool.ROTATE
        GizmoMode.SCALE -> TransformTool.SCALE
    }
}

/**
 * The transform inspector's fields as the browser's Tool Settings panel runs
 * them (main.ts `updateToolSettings`), kept free of Android so they are
 * checked on the JVM: each tool's three fields, X, Y and Z; a field shows the
 * selection's text except while it holds the focus (the browser leaves the
 * active input alone); a change — the input's `change` event: Enter, or the
 * focus leaving the field, when its text differs from what it held at the
 * last change (or when focused) — submits the three fields' texts as typed,
 * which the core reads with `parseFloat`. Enter keeps the focus and the
 * typing, as the browser's input does, so leaving afterwards submits nothing
 * more unless the text changed again.
 */
object TransformInspector {
    /** The tools whose fields the inspector shows, in the browser's tool-rail order. */
    val TOOLS = listOf(TransformTool.MOVE, TransformTool.ROTATE, TransformTool.SCALE)
    const val AXES = 3

    /**
     * The texts a change of field [axis] submits: all three as [typed], or null when [axis] still holds
     * [since], its text at the last change (or when it took the focus).
     */
    fun change(since: String, typed: List<String>, axis: Int): List<String>? {
        require(typed.size == AXES && axis in 0 until AXES)
        return if (typed[axis] == since) null else typed
    }

    /** What the fields hold once [shown] changes: the selection's texts, except the [focused] field's own typing. */
    fun follow(shown: List<String>, typed: List<String>, focused: Int?): List<String> =
        List(AXES) { axis -> if (axis == focused) typed[axis] else shown[axis] }

    /** The core action whose enablement gates [tool]'s fields (the browser invokes it on `dom-inspector`). */
    fun action(tool: TransformTool): String = when (tool) {
        TransformTool.MOVE -> "tool_move"
        TransformTool.ROTATE -> "tool_rotate"
        TransformTool.SCALE -> "tool_scale"
    }
}
