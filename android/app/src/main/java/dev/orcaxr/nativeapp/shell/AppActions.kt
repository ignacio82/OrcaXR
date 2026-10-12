package dev.orcaxr.nativeapp.shell

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.prepare.PrepareCommands
import dev.orcaxr.nativeapp.project.ProjectEditing
import dev.orcaxr.renderer.CameraView

/**
 * The catalogue actions the app performs, kept free of Android so they are
 * checked on the JVM: what the command palette may list (never an action the
 * app cannot perform), what the Workspace's toolbar draws, and where running
 * one has to happen. Every one runs through `ProjectModel.perform`, the call
 * the menus, the toolbar, the context menus and the shortcuts make — except
 * the Prepare area's, which it carries out as its buttons do.
 */
object AppActions {
    /** The File menu's document actions: the Project area's pickers and dialogs carry them out. */
    val DOCUMENT = listOf("file_new_project", "file_open_project", "file_save_project", "file_save_project_as", "file_import_model")

    /** Undo and redo, the history's own. */
    val HISTORY = listOf("edit_undo", "edit_redo")

    /** The View menu's camera views, on the Workspace's 3D view. */
    val CAMERA = CameraView.entries.map { "view_camera_${it.id}" }

    /** The model toolbar's tools: each takes the Workspace's touch until it is chosen again or ended. */
    val TOOLS = listOf("tool_lay_on_face", "tool_paint", "tool_support_paint", "tool_seam_paint", "tool_fuzzy_skin", "tool_measure")

    /** The model toolbar's actions the app performs (`dom-toolbar`); the core's catalogue order decides where each goes. */
    val TOOLBAR = TOOLS + listOf("drop_to_bed", "delete_models")

    /** The browser's menu strip quick actions (DomShell's `QUICK_ACTIONS`), in its order: bare symbols beside the menus. */
    val QUICK = listOf("file_save_project", "edit_undo", "edit_redo")

    /** Slice, Slice All Plates, Cancel Slice and Send to Printer: the Prepare area's buttons, enabled as they are ([PrepareCommands]). */
    val PREPARE = PrepareCommands.IDS

    /** Every catalogue action the app performs. */
    val PERFORMED: Set<String> = (DOCUMENT + HISTORY + CAMERA + TOOLBAR + PREPARE).toSet() + ProjectEditing.PERFORMED + ProjectEditing.CREATED

    /** Whether running [id] needs the Workspace's 3D view on screen: a camera view, or a tool that takes its touch. */
    fun needsWorkspace(id: String): Boolean = id in CAMERA || id in TOOLS

    /** Whether running [id] needs the Project area, whose pickers and dialogs carry it out. */
    fun needsProject(id: String): Boolean = id in DOCUMENT

    /** Whether running [id] is the Prepare area's: its buttons carry it out, with their progress and outcome. */
    fun needsPrepare(id: String): Boolean = id in PREPARE

    /** The [actions] (a surface's, in catalogue order) the app performs, in that order. */
    fun performed(actions: List<ProjectActionState>): List<ProjectActionState> = actions.filter { it.id in PERFORMED }

    /** The browser's status for a palette pick the core does not enable (`reportCapabilityUnavailable`). */
    fun unavailable(label: String, reason: String?): String = "$label: ${reason.orEmpty()}"

    /**
     * The palette's highlighted row as the browser's keys and pointer move it:
     * ArrowDown and ArrowUp step within [size] rows, a new search starts at
     * the first, and the pointer over a row highlights it.
     */
    object Selection {
        fun down(selected: Int, size: Int): Int = if (size <= 0) 0 else minOf(selected + 1, size - 1)
        fun up(selected: Int): Int = maxOf(selected - 1, 0)
    }
}
