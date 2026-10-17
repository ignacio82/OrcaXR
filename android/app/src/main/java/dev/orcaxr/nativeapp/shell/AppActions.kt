package dev.orcaxr.nativeapp.shell

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.exports.ExportCommands
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
    val TOOLS = listOf(
        "tool_lay_on_face", "tool_paint", "tool_support_paint", "tool_seam_paint", "tool_fuzzy_skin", "tool_measure", "tool_assembly",
        "tool_brim_ears", "add_emboss", "tool_svg", "variable_layer_height",
        "tool_smart_paint", "tool_smart_paint_image",
    )

    /**
     * A tool panel's own actions the palette runs too: the Brim ears panel's
     * Place on corners, whose ears the Workspace draws (its tool opens), and
     * Clear all; the Emboss and SVG part panels' Load (their tool opens with
     * its picker) and Add; the Measure panel's Align picked faces and Explode
     * the assembly, which open the Assembly tool, where the faces are picked
     * and the factor is chosen.
     */
    val PANELS = listOf(
        "brim_ears_auto", "brim_ears_clear", "emboss_load_font", "emboss_apply", "svg_load_drawing", "svg_apply",
        "assembly_align", "assembly_explode",
        "paint_smart_configure", "paint_smart_request", "paint_smart_apply", "paint_smart_cancel",
    )

    /** Panel actions that open their tool on the Workspace: automatic brim ears, choosing a font or a drawing, and the assembly's. */
    private val OPENS_TOOL = setOf(
        "brim_ears_auto", "emboss_load_font", "svg_load_drawing", "assembly_align", "assembly_explode",
        "tool_smart_paint", "tool_smart_paint_image",
    )

    /** The gizmo's Move, Rotate and Scale (G, R and S): each chooses what a drag of the gizmo's handles does. */
    val GIZMO = ProjectEditing.GIZMO_TOOLS

    /** The model toolbar's actions the app performs (`dom-toolbar`); the core's catalogue order decides where each goes. */
    val TOOLBAR = GIZMO + TOOLS + listOf("drop_to_bed", "delete_models")

    /** The browser's menu strip quick actions (DomShell's `QUICK_ACTIONS`), in its order: bare symbols beside the menus. */
    val QUICK = listOf("file_save_project", "edit_undo", "edit_redo")

    /** Slice, Slice All Plates, Cancel Slice and Send to Printer: the Prepare area's buttons, enabled as they are ([PrepareCommands]). */
    val PREPARE = PrepareCommands.IDS

    /** The File menu's exports and the Download actions: the system's picker takes the file, from any area ([ExportCommands]). */
    val EXPORT = ExportCommands.IDS

    /** The View menu's display toggles and projection controls. */
    val VIEW = listOf(
        "view_show_wireframe", "view_show_printable_box", "view_show_labels", "view_show_overhang",
        "view_show_navigator", "view_show_outline", "view_perspective_toggle",
    )

    /** The Help menu's documentation, shortcuts, bug reports, about, tutorial, tip of the day, update check, setup wizard and help search. */
    val HELP = listOf(
        "help_shortcuts", "help_docs", "help_report_bug", "help_about", "help_language",
        "help_tutorial", "help_tip_of_day", "help_check_updates", "help_setup_wizard", "help_search",
    )

    /** Preset management: installing printers, custom presets, and preset bundles. */
    val PRESETS = listOf(
        "presets_install_printer", "presets_create_custom", "presets_update_custom",
        "presets_delete_custom", "presets_export_bundle", "presets_import_bundle",
    )

    /** The Calibration menu's workflows. */
    val CALIBRATION_WORKFLOWS = listOf(
        "calib_temperature", "calib_flow_pass1", "calib_flow_pass2", "calib_flow_yolo", "calib_flow_yolo_perfectionist",
        "calib_pressure_advance", "calib_retraction", "calib_max_flow", "calib_vfa", "calib_tolerance",
        "calib_junction_deviation", "calib_input_shaping_frequency", "calib_input_shaping_damping",
    )

    /** Calibration history ledger operations. */
    val CALIBRATION_HISTORY = listOf(
        "calib_view_history", "calib_record_result", "calib_compare_results", "calib_rerun_result",
        "calib_apply_result", "calib_delete_result", "calib_export_history",
    )

    /** Calibration session lifecycle, parameter configuration and materialisation. */
    val CALIBRATION_SESSION = listOf(
        "calib_choose", "calib_configure", "calib_reset_parameters",
        "calib_place_geometry", "calib_sweep_export", "calib_session_discard", "calib_session_keep",
    )

    val CALIBRATION = CALIBRATION_WORKFLOWS + CALIBRATION_HISTORY + CALIBRATION_SESSION

    /** Advanced actions: syncing filaments from the printer and full-spectrum color recreation. */
    val ADVANCED = listOf("printer_inspect_filaments", "recreate_model_colors_fullspectrum")

    /** Every catalogue action the app performs. */
    val PERFORMED: Set<String> = (DOCUMENT + HISTORY + CAMERA + TOOLBAR + PANELS + PREPARE + EXPORT + VIEW + HELP + PRESETS + CALIBRATION + ADVANCED).toSet() + ProjectEditing.PERFORMED + ProjectEditing.CREATED

    /**
     * Whether running [id] needs the Workspace's 3D view on screen: a camera
     * view, a tool that takes its touch or shows its panel there, the
     * gizmo's, or a panel action that opens its tool there.
     */
    fun needsWorkspace(id: String): Boolean = id in CAMERA || isTool(id) || id in OPENS_TOOL

    /** Whether [id] is one of the toolbar's tools, shown as the Workspace's tool while it is ([ProjectModel.toolActive]). */
    fun isTool(id: String): Boolean = id in TOOLS || id in GIZMO

    /** Whether running [id] needs the Project area, whose pickers and dialogs carry it out. */
    fun needsProject(id: String): Boolean = id in DOCUMENT

    /** Whether running [id] is an export: written where the operator picks, whichever area shows. */
    fun needsExport(id: String): Boolean = id in EXPORT

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
