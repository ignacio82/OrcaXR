/**
 * Truthful parity ownership for ActionRegistry entries.
 *
 * `docs/parity.md` gives its individual tasks bold list labels rather than
 * Markdown headings, so those labels do not have linkable anchors. Keep the
 * exact task ID machine-readable here and link to its real containing phase
 * heading. The registry test verifies both halves against the document.
 *
 * The generated `actions.registry.metadata-only.*` test IDs deliberately
 * describe declaration coverage only. They prove that an action is catalogued,
 * classified, reachable, and linked; they are not behavioral or acceptance
 * evidence and must never be used to promote an action to `implemented`.
 */

export const ACTION_IDS_BY_PARITY_TASK = {
  'P1.2': ['edit_undo', 'edit_redo'],
  'P2.1': ['objects_select', 'objects_reveal'],
  'P2.2': [
    'objects_rename',
    'edit_cut',
    'edit_copy',
    'edit_paste',
    'edit_duplicate',
    'edit_delete_selected',
    'edit_delete_all',
    'delete_models',
    'add_instance',
    'instance_to_object',
    'fill_bed_with_instances',
    'toggle_printable',
  ],
  'P2.3': ['objects_assign_filament'],
  'P2.4': [
    'objects_convert_volume_role',
    'add_modifier',
    'add_support_enforcer',
    'add_support_blocker',
    'set_negative_part',
  ],
  'P2.5': ['objects_edit_layer_range', 'add_height_range'],
  'P3.2': ['filament_virtual_mutate'],
  'P4.3': ['tool_paint', 'paint_erase_all'],
  'P4.4': [
    'paint_configure',
    'paint_select_filament_1',
    'paint_select_filament_2',
    'paint_select_filament_3',
    'paint_select_filament_4',
    'paint_select_filament_5',
    'paint_select_filament_6',
    'paint_select_filament_7',
    'paint_select_filament_8',
    'paint_select_filament_9',
  ],
  'P4.5': ['filament_remap'],
  'P4.6': ['tool_support_paint'],
  'P4.7': ['tool_seam_paint'],
  'P4.8': ['tool_fuzzy_skin'],
  'P4.9': [
    'tool_smart_paint',
    'tool_smart_paint_image',
    'paint_smart_configure',
    'paint_smart_request',
    'paint_smart_apply',
    'paint_smart_cancel',
    'recreate_model_colors_fullspectrum',
  ],
  'P5.1': [
    'edit_select_all',
    'edit_deselect_all',
    'tool_move',
    'tool_rotate',
    'tool_scale',
    'tool_lay_on_face',
    'drop_to_bed',
    'mirror_x',
    'mirror_y',
    'mirror_z',
    'reset_rotation',
    'reset_scale',
    'center_on_plate',
    'scale_to_fit_volume',
  ],
  'P5.2': [
    'repair_model',
    'simplify_model',
    'mesh_boolean_union',
    'mesh_boolean_subtract',
    'mesh_boolean_intersection',
    'split_to_objects',
    'split_to_parts',
    'tool_cut',
  ],
  'P5.3': [
    'assembly_explode',
    // The preview session belongs with the pinned Simplify gizmo (P5.3.5),
    // not with the one-shot topology command P5.2 owns. Same decimation
    // underneath, different parity claim on top.
    'simplify_preview',
    'simplify_apply',
    'simplify_cancel',
    'tool_brim_ears',
    'brim_ears_configure',
    'brim_ears_auto',
    'brim_ears_remove',
    'brim_ears_clear',
    'tool_measure',
    'measure_clear',
    'tool_assembly',
    'assembly_align',
    'tool_face_detector',
    'tool_svg',
    'svg_load_drawing',
    'svg_configure',
    'svg_apply',
    'tool_hollow',
    'add_emboss',
    'emboss_load_font',
    'emboss_configure',
    'emboss_apply',
    'add_magnet',
  ],
  'P5.4': [
    'add_plate',
    'activate_plate',
    'delete_plate',
    'duplicate_plate',
    'rename_plate',
    'reorder_plates',
    'set_plate_printable',
  ],
  'P5.5': ['arrange_all', 'auto_place_wipe'],
  'P5.6': ['file_import_model', 'file_import_zip', 'load_model_from_path'],
  'P5.7': [
    'file_export_gcode',
    'file_export_all_plates',
    'file_export_stl',
    'file_export_all_stls',
    'file_export_3mf',
    'file_export_obj',
    'file_open_gcode',
  ],
  'P5.8': [
    'add_handy_model',
    'add_primitive_cube',
    'add_primitive_cylinder',
    'add_primitive_sphere',
    'add_primitive_cone',
    'add_primitive_disc',
    'add_primitive_torus',
  ],
  'P5.9': ['variable_layer_height'],
  'P6.3': ['file_import_config', 'file_export_config'],
  'P6.2': ['settings_apply_project'],
  'P6.5': ['settings_apply_scoped'],
  'P6.4': [
    'help_setup_wizard',
    'presets_install_printer',
    'presets_create_custom',
    'presets_update_custom',
    'presets_delete_custom',
    'presets_export_bundle',
    'presets_import_bundle',
  ],
  'P7.1': ['slice_active_plate', 'slice_all_plates', 'slice_cancel'],
  'P7.4': ['toggle_preview', 'preview_configure'],
  'P7.5': ['view_show_gcode_window'],
  'P7.7': ['save_gcode_to_downloads', 'view_open_gcode', 'save_all_plate_gcode'],
  'P7.8': ['layer_event_mutate'],
  'P8.3': [
    'calib_place_geometry',
    'calib_sweep_export',
    'calib_choose',
    'calib_configure',
    'calib_reset_parameters',
    'calib_session_discard',
    'calib_session_keep',
    'calib_apply_result',
    'add_calibration_tower',
    'add_calibration_cube',
    'calib_temperature',
    'calib_flow_pass1',
    'calib_flow_pass2',
    'calib_flow_yolo',
    'calib_pressure_advance',
    'calib_retraction',
    'calib_max_flow',
    'calib_vfa',
    'calib_tolerance',
  ],
  'P9.1': ['printer_test_connection'],
  'P9.2': ['scan_network'],
  'P9.3': ['printer_inspect_filaments'],
  'P9.4': [
    'send_to_printer',
    'printer_pause_print',
    'printer_resume_print',
    'printer_cancel_print',
    'printer_emergency_stop',
  ],
  'P9.5': [
    'printer_browse_storage',
    'printer_print_stored_file',
    'printer_rename_stored_file',
    'printer_download_stored_file',
    'printer_delete_stored_file',
  ],
  'P9.6': ['view_webcam', 'printer_console_send', 'printer_run_macro', 'printer_list_macros', 'printer_view_history'],
  'P8.5': [
    'calib_view_history',
    'calib_record_result',
    'calib_compare_results',
    'calib_rerun_result',
    'calib_delete_result',
    'calib_export_history',
  ],
  'P9.7': ['printer_show_status'],
  'P10.3': ['help_shortcuts'],
  'P10.4': ['help_language'],
  'P11.1': ['file_new_project', 'file_open_project', 'file_save_project', 'file_save_project_as'],
  'P11.2': [
    'view_camera_default',
    'view_camera_top',
    'view_camera_front',
    'view_camera_left',
    'view_camera_right',
    'view_camera_rear',
    'view_camera_bottom',
    'view_perspective_toggle',
    'view_show_labels',
    'view_show_overhang',
    'view_show_wireframe',
    'view_auto_perspective',
    'view_show_navigator',
    'view_show_outline',
    'view_show_printable_box',
  ],
  'P11.3': ['help_search', 'help_tutorial', 'help_docs', 'help_report_bug', 'help_tip_of_day'],
  'P11.4': ['file_export_logs'],
  'P11.6': ['help_about'],
  'P11.7': ['help_config_folder', 'help_check_updates'],
} as const;

export type ParityTaskId = keyof typeof ACTION_IDS_BY_PARITY_TASK;
export type ParityPhaseId = `P${number}`;

/** Real GitHub/CommonMark heading anchors in docs/parity.md. */
export const PARITY_PHASE_HELP_HREFS = {
  P1: 'docs/parity.md#7-p1--canonical-project-graph-history-and-lossless-3mf',
  P2: 'docs/parity.md#8-p2--objects-panel-parts-instances-and-per-scope-assignment',
  P3: 'docs/parity.md#9-p3--fullspectrum-physical-and-virtual-filament-workflow',
  P4: 'docs/parity.md#10-p4--facet-annotations-and-painting-parity',
  P5: 'docs/parity.md#11-p5--prepare-tools-geometry-plates-and-file-interchange',
  P6: 'docs/parity.md#12-p6--engine-derived-settings-profiles-and-preferences',
  P7: 'docs/parity.md#13-p7--slicing-validation-preview-and-output-inspection',
  P8: 'docs/parity.md#14-p8--calibration-workflows',
  P9: 'docs/parity.md#15-p9--moonraker-printers-and-print-operations',
  P10: 'docs/parity.md#16-p10--ux-accessibility-spatial-design-localization-performance-and-security',
  P11: 'docs/parity.md#17-p11--application-help-diagnostics-and-automation-surface',
} as const satisfies Readonly<Partial<Record<ParityPhaseId, string>>>;

const taskByActionId = new Map<string, ParityTaskId>();
for (const [taskId, actionIds] of Object.entries(ACTION_IDS_BY_PARITY_TASK) as [ParityTaskId, readonly string[]][]) {
  for (const actionId of actionIds) {
    const previous = taskByActionId.get(actionId);
    if (previous) {
      throw new Error(`CapabilityEvidence: action "${actionId}" belongs to both ${previous} and ${taskId}`);
    }
    taskByActionId.set(actionId, taskId);
  }
}

export function parityTaskForAction(actionId: string): ParityTaskId {
  const taskId = taskByActionId.get(actionId);
  if (!taskId) {
    throw new Error(`CapabilityEvidence: action "${actionId}" has no parity-task owner`);
  }
  return taskId;
}

export function parityPhaseForTask(taskId: ParityTaskId): keyof typeof PARITY_PHASE_HELP_HREFS {
  const phase = taskId.slice(0, taskId.indexOf('.')) as keyof typeof PARITY_PHASE_HELP_HREFS;
  if (!(phase in PARITY_PHASE_HELP_HREFS)) {
    throw new Error(`CapabilityEvidence: task "${taskId}" has no phase help anchor`);
  }
  return phase;
}

export function parityHelpHrefForTask(taskId: ParityTaskId): string {
  return PARITY_PHASE_HELP_HREFS[parityPhaseForTask(taskId)];
}

export function registryMetadataTestId(actionId: string, taskId: ParityTaskId): string {
  return `actions.registry.metadata-only.${taskId.toLowerCase()}.${actionId}`;
}
