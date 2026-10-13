package dev.orcaxr.nativeapp.shell

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import dev.orcaxr.core.ActionSection
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.R

/**
 * The words the app shows for a catalogue action: the browser's label and
 * hint for it (`action.<id>.label` and `.hint`, as `ActionRegistry`'s text
 * source localizes them), as string resources in the app's language. The
 * hint is the browser's tooltip and the command palette's second column.
 * And a catalogue group's label (`actionGroup.<id>.label`), a grouped
 * menu's section heading as the browser's `groupLabel` words it.
 */
object ActionTexts {
    /** Every catalogue group, in the browser's declared order (`GROUPS`), with its label. */
    val GROUPS: Map<String, Int> = linkedMapOf(
        "file" to R.string.action_group_file,
        "edit" to R.string.action_group_edit,
        "view" to R.string.action_group_view,
        "scene" to R.string.action_group_scene,
        "paint" to R.string.action_group_paint,
        "slice" to R.string.action_group_slice,
        "filament" to R.string.action_group_filament,
        "output" to R.string.action_group_output,
        "calibration" to R.string.action_group_calibration,
        "advanced" to R.string.action_group_advanced,
        "help" to R.string.action_group_help,
        "system" to R.string.action_group_system,
    )

    /** Each action the app performs, by catalogue id, with its label. */
    val LABELS: Map<String, Int> = mapOf(
        "file_new_project" to R.string.project_new,
        "file_open_project" to R.string.project_open,
        "file_import_model" to R.string.project_import,
        "file_save_project" to R.string.project_save,
        "file_save_project_as" to R.string.project_save_as,
        "edit_undo" to R.string.project_undo,
        "edit_redo" to R.string.project_redo,
        "edit_cut" to R.string.project_edit_cut,
        "edit_copy" to R.string.project_edit_copy,
        "edit_paste" to R.string.project_edit_paste,
        "edit_duplicate" to R.string.project_edit_duplicate,
        "edit_delete_selected" to R.string.project_edit_delete_selected,
        "edit_delete_all" to R.string.project_edit_delete_all,
        "edit_select_all" to R.string.project_edit_select_all,
        "edit_deselect_all" to R.string.project_edit_deselect_all,
        "view_camera_default" to R.string.view_camera_default,
        "view_camera_top" to R.string.view_camera_top,
        "view_camera_front" to R.string.view_camera_front,
        "view_camera_left" to R.string.view_camera_left,
        "view_camera_right" to R.string.view_camera_right,
        "view_camera_rear" to R.string.view_camera_rear,
        "view_camera_bottom" to R.string.view_camera_bottom,
        "tool_move" to R.string.workspace_tool_move,
        "tool_rotate" to R.string.workspace_tool_rotate,
        "tool_scale" to R.string.workspace_tool_scale,
        "tool_lay_on_face" to R.string.project_lay_flat,
        "tool_paint" to R.string.workspace_paint,
        "add_instance" to R.string.project_add_instance,
        "instance_to_object" to R.string.project_instance_to_object,
        "fill_bed_with_instances" to R.string.project_fill_bed,
        "mirror_x" to R.string.project_mirror_x,
        "mirror_y" to R.string.project_mirror_y,
        "mirror_z" to R.string.project_mirror_z,
        "reset_rotation" to R.string.project_reset_rotation,
        "reset_scale" to R.string.project_reset_scale,
        "center_on_plate" to R.string.project_center_on_plate,
        "toggle_printable" to R.string.project_toggle_printable,
        "scale_to_fit_volume" to R.string.project_scale_to_fit_volume,
        "drop_to_bed" to R.string.project_drop_to_bed,
        "delete_models" to R.string.action_delete_models,
        "add_primitive_cube" to R.string.project_add_cube,
        "add_primitive_cylinder" to R.string.project_add_cylinder,
        "add_primitive_sphere" to R.string.project_add_sphere,
        "add_primitive_cone" to R.string.project_add_cone,
        "add_primitive_disc" to R.string.project_add_disc,
        "add_primitive_torus" to R.string.project_add_torus,
        "simplify_model" to R.string.project_simplify_model,
        "add_plate" to R.string.project_add_plate,
        "delete_plate" to R.string.project_delete_plate,
        "arrange_all" to R.string.project_arrange_all,
        "duplicate_plate" to R.string.project_duplicate_plate,
        "split_to_objects" to R.string.project_split_to_objects,
        "split_to_parts" to R.string.project_split_to_parts,
        "tool_support_paint" to R.string.action_tool_support_paint,
        "tool_seam_paint" to R.string.action_tool_seam_paint,
        "tool_fuzzy_skin" to R.string.action_tool_fuzzy_skin,
        "tool_measure" to R.string.project_measure,
        "tool_assembly" to R.string.workspace_assembly,
        "assembly_align" to R.string.assembly_align_action,
        "assembly_explode" to R.string.assembly_explode,
        "tool_brim_ears" to R.string.workspace_brim_ears,
        "brim_ears_auto" to R.string.brim_ears_auto,
        "brim_ears_clear" to R.string.brim_ears_clear,
        "add_emboss" to R.string.workspace_emboss,
        "emboss_load_font" to R.string.emboss_load_font,
        "emboss_apply" to R.string.emboss_apply,
        "tool_svg" to R.string.workspace_svg_part,
        "svg_load_drawing" to R.string.svg_load_drawing,
        "svg_apply" to R.string.svg_apply,
        "auto_place_wipe" to R.string.project_auto_place_wipe,
        "add_modifier" to R.string.project_add_modifier,
        "add_support_enforcer" to R.string.project_add_support_enforcer,
        "add_support_blocker" to R.string.project_add_support_blocker,
        "set_negative_part" to R.string.project_set_negative_part,
        "slice_active_plate" to R.string.prepare_slice,
        "slice_all_plates" to R.string.prepare_slice_all,
        "slice_cancel" to R.string.prepare_cancel,
        "send_to_printer" to R.string.send_action,
        "file_export_gcode" to R.string.export_gcode,
        "file_export_all_plates" to R.string.export_all_plates,
        "file_export_stl" to R.string.export_stl,
        "file_export_all_stls" to R.string.export_all_stls,
        "file_export_3mf" to R.string.export_3mf,
        "file_export_config" to R.string.export_config,
        "file_export_obj" to R.string.export_obj,
        "file_export_logs" to R.string.export_logs,
        "save_gcode_to_downloads" to R.string.export_download,
        "save_all_plate_gcode" to R.string.export_download_all,
    )

    /** Each action the app performs, by catalogue id, with its hint. */
    val HINTS: Map<String, Int> = mapOf(
        "file_new_project" to R.string.action_hint_file_new_project,
        "file_open_project" to R.string.action_hint_file_open_project,
        "file_import_model" to R.string.action_hint_file_import_model,
        "file_save_project" to R.string.action_hint_file_save_project,
        "file_save_project_as" to R.string.action_hint_file_save_project_as,
        "edit_undo" to R.string.action_hint_edit_undo,
        "edit_redo" to R.string.action_hint_edit_redo,
        "edit_cut" to R.string.action_hint_edit_cut,
        "edit_copy" to R.string.action_hint_edit_copy,
        "edit_paste" to R.string.action_hint_edit_paste,
        "edit_duplicate" to R.string.action_hint_edit_duplicate,
        "edit_delete_selected" to R.string.action_hint_edit_delete_selected,
        "edit_delete_all" to R.string.action_hint_edit_delete_all,
        "edit_select_all" to R.string.action_hint_edit_select_all,
        "edit_deselect_all" to R.string.action_hint_edit_deselect_all,
        "view_camera_default" to R.string.action_hint_view_camera_default,
        "view_camera_top" to R.string.action_hint_view_camera_top,
        "view_camera_front" to R.string.action_hint_view_camera_front,
        "view_camera_left" to R.string.action_hint_view_camera_left,
        "view_camera_right" to R.string.action_hint_view_camera_right,
        "view_camera_rear" to R.string.action_hint_view_camera_rear,
        "view_camera_bottom" to R.string.action_hint_view_camera_bottom,
        "tool_move" to R.string.action_hint_tool_move,
        "tool_rotate" to R.string.action_hint_tool_rotate,
        "tool_scale" to R.string.action_hint_tool_scale,
        "tool_lay_on_face" to R.string.action_hint_tool_lay_on_face,
        "tool_paint" to R.string.action_hint_tool_paint,
        "add_instance" to R.string.action_hint_add_instance,
        "instance_to_object" to R.string.action_hint_instance_to_object,
        "fill_bed_with_instances" to R.string.action_hint_fill_bed_with_instances,
        "mirror_x" to R.string.action_hint_mirror_x,
        "mirror_y" to R.string.action_hint_mirror_y,
        "mirror_z" to R.string.action_hint_mirror_z,
        "reset_rotation" to R.string.action_hint_reset_rotation,
        "reset_scale" to R.string.action_hint_reset_scale,
        "center_on_plate" to R.string.action_hint_center_on_plate,
        "toggle_printable" to R.string.action_hint_toggle_printable,
        "scale_to_fit_volume" to R.string.action_hint_scale_to_fit_volume,
        "drop_to_bed" to R.string.action_hint_drop_to_bed,
        "delete_models" to R.string.action_hint_delete_models,
        "add_primitive_cube" to R.string.action_hint_add_primitive_cube,
        "add_primitive_cylinder" to R.string.action_hint_add_primitive_cylinder,
        "add_primitive_sphere" to R.string.action_hint_add_primitive_sphere,
        "add_primitive_cone" to R.string.action_hint_add_primitive_cone,
        "add_primitive_disc" to R.string.action_hint_add_primitive_disc,
        "add_primitive_torus" to R.string.action_hint_add_primitive_torus,
        "simplify_model" to R.string.action_hint_simplify_model,
        "add_plate" to R.string.action_hint_add_plate,
        "delete_plate" to R.string.action_hint_delete_plate,
        "arrange_all" to R.string.action_hint_arrange_all,
        "duplicate_plate" to R.string.action_hint_duplicate_plate,
        "split_to_objects" to R.string.action_hint_split_to_objects,
        "split_to_parts" to R.string.action_hint_split_to_parts,
        "tool_support_paint" to R.string.action_hint_tool_support_paint,
        "tool_seam_paint" to R.string.action_hint_tool_seam_paint,
        "tool_fuzzy_skin" to R.string.action_hint_tool_fuzzy_skin,
        "tool_measure" to R.string.action_hint_tool_measure,
        "tool_assembly" to R.string.action_hint_tool_assembly,
        "assembly_align" to R.string.action_hint_assembly_align,
        "assembly_explode" to R.string.action_hint_assembly_explode,
        "tool_brim_ears" to R.string.action_hint_tool_brim_ears,
        "brim_ears_auto" to R.string.action_hint_brim_ears_auto,
        "brim_ears_clear" to R.string.action_hint_brim_ears_clear,
        "add_emboss" to R.string.action_hint_add_emboss,
        "emboss_load_font" to R.string.action_hint_emboss_load_font,
        "emboss_apply" to R.string.action_hint_emboss_apply,
        "tool_svg" to R.string.action_hint_tool_svg,
        "svg_load_drawing" to R.string.action_hint_svg_load_drawing,
        "svg_apply" to R.string.action_hint_svg_apply,
        "auto_place_wipe" to R.string.action_hint_auto_place_wipe,
        "add_modifier" to R.string.action_hint_add_modifier,
        "add_support_enforcer" to R.string.action_hint_add_support_enforcer,
        "add_support_blocker" to R.string.action_hint_add_support_blocker,
        "set_negative_part" to R.string.action_hint_set_negative_part,
        "slice_active_plate" to R.string.action_hint_slice_active_plate,
        "slice_all_plates" to R.string.action_hint_slice_all_plates,
        "slice_cancel" to R.string.action_hint_slice_cancel,
        "send_to_printer" to R.string.action_hint_send_to_printer,
        "file_export_gcode" to R.string.action_hint_file_export_gcode,
        "file_export_all_plates" to R.string.action_hint_file_export_all_plates,
        "file_export_stl" to R.string.action_hint_file_export_stl,
        "file_export_all_stls" to R.string.action_hint_file_export_all_stls,
        "file_export_3mf" to R.string.action_hint_file_export_3mf,
        "file_export_config" to R.string.action_hint_file_export_config,
        "file_export_obj" to R.string.action_hint_file_export_obj,
        "file_export_logs" to R.string.action_hint_file_export_logs,
        "save_gcode_to_downloads" to R.string.action_hint_save_gcode_to_downloads,
        "save_all_plate_gcode" to R.string.action_hint_save_all_plate_gcode,
    )

    /** [action]'s label in the app's language; the core's English one for an action the app has no words for. */
    @Composable
    fun label(action: ProjectActionState): String = LABELS[action.id]?.let { stringResource(it) } ?: action.label

    /**
     * [section]'s heading in the app's language: its group's label, as the
     * browser's `groupLabel` localizes it (the core's English for a group the
     * app does not know).
     */
    @Composable
    fun heading(section: ActionSection): String = GROUPS[section.group]?.let { stringResource(it) } ?: section.label

    /** [id]'s hint in the app's language, if it has one. */
    @Composable
    fun hint(id: String): String? = HINTS[id]?.let { stringResource(it) }

    /**
     * What a control for [action] says when pointed at, as the browser's
     * `title` does: why it cannot run when the core does not enable it,
     * otherwise its hint (or, without one, its label).
     */
    @Composable
    fun tooltip(action: ProjectActionState): String =
        if (!action.enabled && action.reason != null) action.reason!! else hint(action.id) ?: label(action)
}
