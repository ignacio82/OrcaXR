package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.core.ProjectView

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

    /** The catalogue actions the app performs, by ID. */
    val PERFORMED = setOf(
        "edit_select_all", "edit_deselect_all", "edit_duplicate", "add_instance", "edit_delete_selected", "edit_delete_all",
        "toggle_printable", "instance_to_object", "add_plate", "duplicate_plate", "delete_plate",
    )

    /** The Edit menu, in the browser's menu order (web/src/actions/groups/edit.ts, then the scene's object edits). */
    val EDIT_MENU = listOf(
        "edit_select_all", "edit_deselect_all", "edit_duplicate", "edit_delete_selected", "edit_delete_all",
        "toggle_printable", "instance_to_object",
    )

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
        menu.filter { it.id in PERFORMED }.forEach { add(Choice.Action(it)) }
    }

    /** The Edit menu's actions with the core's enablement; one the core has not answered for yet is disabled. */
    fun editMenu(view: ProjectView): List<ProjectActionState> =
        EDIT_MENU.map { id -> view.actions[id] ?: ProjectActionState(id, id, enabled = false) }

    /** Whether the core enables action [id] now. */
    fun enabled(view: ProjectView, id: String): Boolean = view.actions[id]?.enabled == true
}
