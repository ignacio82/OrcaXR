/** Capability truth and cross-surface registry tests. */
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionContext } from '../ActionContext';
import type { ActionSurface } from '../ActionRegistry';
import { GROUPS } from '../ActionRegistry';
import { buildRegistry } from '../catalog';
import { hasIcon } from '../../ui/icons';
import { xrToolRailActions } from '../../ui/xr/XrShell';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const registry = buildRegistry();
const actions = registry.all();

const UNAVAILABLE_IDS = [
  'add_emboss',
  'add_magnet',
  'scan_network',
  'view_webcam',
  'edit_undo',
  'edit_redo',
  'edit_select_all',
  'file_export_all_plates',
  'file_export_obj',
  'file_open_gcode',
  'file_export_logs',
  'send_to_printer',
  'help_config_folder',
  'view_perspective_toggle',
  'view_auto_perspective',
  'view_show_navigator',
  'view_show_outline',
  'view_show_gcode_window',
  'split_to_parts',
  'tool_support_paint',
  'tool_seam_paint',
  'tool_fuzzy_skin',
  'tool_brim_ears',
  'tool_measure',
  'tool_assembly',
  'tool_face_detector',
  'tool_svg',
  'tool_hollow',
  'add_modifier',
  'add_support_enforcer',
  'add_support_blocker',
  'add_height_range',
  'set_negative_part',
  'variable_layer_height',
].sort();

const FULL_STATE = {
  mode: 'prepare',
  activeTool: 'move',
  modelCount: 3,
  plateCount: 2,
  hasSelection: true,
  hasClipboard: true,
  isSlicing: false,
  gcodeReady: true,
  extruderCount: 4,
  hasMultiColorPaint: true,
  status: 'ready',
  progress: null,
  preflightBlocked: false,
} as const;

test('all audited status-only placeholders are explicitly unavailable', () => {
  const actual = actions
    .filter((action) => action.capability.status === 'unavailable')
    .map((action) => action.id)
    .sort();
  assert.deepStrictEqual(actual, UNAVAILABLE_IDS);
});

test('unavailable capabilities have a reason and no executable handler', () => {
  for (const action of actions.filter((item) => item.capability.status === 'unavailable')) {
    assert.ok(action.capability.reason?.trim(), `${action.id} has no disabled reason`);
    assert.strictEqual(action.run, undefined, `${action.id} must not retain a handler`);
    assert.deepStrictEqual(action.capability.testIds, []);
  }
});

test('every executable capability has a handler and test mapping', () => {
  for (const action of actions.filter(
    (item) => item.capability.status === 'implemented' || item.capability.status === 'partial',
  )) {
    assert.strictEqual(typeof action.run, 'function', `${action.id} has no handler`);
    assert.ok(action.capability.testIds.length > 0, `${action.id} has no test mapping`);
    if (action.capability.status === 'partial') {
      assert.ok(action.capability.reason?.trim(), `${action.id} has no partial reason`);
    }
  }
});

test('every action declares command-palette plus its presentation surfaces', () => {
  const presentation: Record<string, readonly ActionSurface[]> = {
    primary: ['dom-primary', 'xr-primary'],
    toolbar: ['dom-toolbar', 'xr-toolbar'],
    menu: ['dom-menu', 'xr-menu'],
    inspector: ['dom-inspector'],
  };
  for (const action of actions) {
    assert.ok(action.capability.surfaces.includes('command-palette'), `${action.id} missing palette`);
    for (const surface of presentation[action.disclosure]) {
      assert.ok(action.capability.surfaces.includes(surface), `${action.id} missing ${surface}`);
      assert.notStrictEqual(
        registry.availability(action, surface, FULL_STATE).state,
        'hidden',
        `${action.id} declared but hidden on ${surface}`,
      );
    }
  }
});

test('all XR toolbar actions are reachable by finite rail or Tools overflow', () => {
  const toolbar = registry.forSurface('xr-toolbar');
  const rail = xrToolRailActions(toolbar);
  const overflow = toolbar.filter((action) => !rail.includes(action));
  assert.strictEqual(toolbar.length, 19);
  assert.strictEqual(rail.length, 7);
  assert.strictEqual(overflow.length, 12);
  assert.deepStrictEqual(new Set([...rail, ...overflow]), new Set(toolbar));
});

test('registry guard explains unavailable actions without invoking a handler', () => {
  const reports: string[] = [];
  const ctx = {
    reportCapabilityUnavailable: (label: string, reason: string) => reports.push(`${label}: ${reason}`),
  } as unknown as ActionContext;
  void registry.invoke('edit_undo', 'dom-menu', ctx, FULL_STATE);
  assert.strictEqual(reports.length, 1);
  assert.ok(reports[0].includes('Project-wide command history'));
});

test('prerequisite evaluator gives actionable disabled reasons', () => {
  const empty = { ...FULL_STATE, modelCount: 0, hasSelection: false, gcodeReady: false };
  assert.deepStrictEqual(registry.availability('tool_move', 'dom-toolbar', empty), {
    state: 'disabled',
    reason: 'Select a model first.',
  });
  assert.deepStrictEqual(registry.availability('toggle_preview', 'dom-primary', empty), {
    state: 'disabled',
    reason: 'Slice successfully first.',
  });
});

test('every non-inspector action and group resolves an icon', () => {
  const unrenderable = actions
    .filter((action) => action.disclosure !== 'inspector' && !hasIcon(action.icon))
    .map((action) => `${action.id} (icon:${action.icon})`);
  assert.deepStrictEqual(unrenderable, []);
  assert.deepStrictEqual(
    GROUPS.filter((group) => !hasIcon(group.icon)).map((group) => group.id),
    [],
  );
});

const REQUIRED_ORCA_ACTIONS = [
  'file_new_project',
  'file_open_project',
  'file_import_model',
  'file_import_config',
  'file_import_zip',
  'file_save_project',
  'file_save_project_as',
  'file_export_gcode',
  'file_export_all_plates',
  'file_export_stl',
  'file_export_3mf',
  'file_export_config',
  'file_export_obj',
  'file_open_gcode',
  'file_export_logs',
  'edit_undo',
  'edit_redo',
  'edit_cut',
  'edit_copy',
  'edit_paste',
  'edit_duplicate',
  'edit_delete_selected',
  'edit_delete_all',
  'edit_select_all',
  'edit_deselect_all',
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
  'view_show_gcode_window',
  'view_show_printable_box',
  'tool_move',
  'tool_rotate',
  'tool_scale',
  'tool_lay_on_face',
  'tool_paint',
  'drop_to_bed',
  'delete_models',
  'repair_model',
  'simplify_model',
  'mesh_boolean_union',
  'mesh_boolean_subtract',
  'mesh_boolean_intersection',
  'arrange_all',
  'split_to_objects',
  'split_to_parts',
  'tool_cut',
  'tool_support_paint',
  'tool_seam_paint',
  'tool_fuzzy_skin',
  'tool_brim_ears',
  'tool_measure',
  'tool_assembly',
  'tool_face_detector',
  'tool_svg',
  'tool_hollow',
  'add_modifier',
  'add_support_enforcer',
  'add_support_blocker',
  'add_height_range',
  'set_negative_part',
  'variable_layer_height',
  'add_handy_model',
  'add_primitive_cube',
  'add_primitive_cylinder',
  'add_primitive_sphere',
  'add_plate',
  'delete_plate',
  'duplicate_plate',
  'slice_active_plate',
  'toggle_preview',
  'save_gcode_to_downloads',
  'send_to_printer',
  'calib_temperature',
  'calib_flow_pass1',
  'calib_flow_pass2',
  'calib_flow_yolo',
  'calib_pressure_advance',
  'calib_retraction',
  'calib_max_flow',
  'calib_vfa',
  'calib_tolerance',
  'add_emboss',
  'add_magnet',
  'auto_place_wipe',
  'help_setup_wizard',
  'help_shortcuts',
  'help_config_folder',
  'help_tutorial',
  'help_docs',
  'help_report_bug',
  'help_tip_of_day',
  'help_check_updates',
  'help_about',
];

test('required Snapmaker outcomes remain represented without implying completion', () => {
  assert.deepStrictEqual(
    REQUIRED_ORCA_ACTIONS.filter((id) => !registry.get(id)),
    [],
  );
});

test('no orphaned legacy *Panel.ts workspace views remain', () => {
  const wsDir = fileURLToPath(new URL('../../workspace', import.meta.url));
  assert.deepStrictEqual(
    readdirSync(wsDir).filter((file) => file.endsWith('Panel.ts')),
    [],
  );
});

const counts = Object.fromEntries(
  ['implemented', 'partial', 'unavailable', 'blocked'].map((status) => [
    status,
    actions.filter((action) => action.capability.status === status).length,
  ]),
);
console.log(`\nCapability parity: ${passed} tests passed. ${JSON.stringify(counts)}`);
