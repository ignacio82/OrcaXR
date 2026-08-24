/** Capability truth and cross-surface registry tests. */
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionContext } from '../ActionContext';
import type { ActionSurface } from '../ActionRegistry';
import { GROUPS } from '../ActionRegistry';
import {
  ACTION_IDS_BY_PARITY_TASK,
  parityHelpHrefForTask,
  parityPhaseForTask,
  registryMetadataTestId,
} from '../CapabilityEvidence';
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
const parityDocument = readFileSync(fileURLToPath(new URL('../../../../docs/parity.md', import.meta.url)), 'utf8');

function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const parityHeadingFragments = new Set(
  [...parityDocument.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((match) => `#${githubHeadingSlug(match[1])}`),
);
const parityTaskPhases = new Map<string, string>();
let currentPhase: string | undefined;
for (const line of parityDocument.split('\n')) {
  const phase = /^## \d+\. (P\d+) —/.exec(line);
  if (phase) currentPhase = phase[1];
  const task = /\*\*(P\d+\.\d+)\s+—/.exec(line);
  if (task && currentPhase) parityTaskPhases.set(task[1], currentPhase);
}

const UNAVAILABLE_IDS = [
  'file_export_3mf',
  'edit_cut',
  'edit_copy',
  'edit_paste',
  'edit_delete_all',
  'tool_cut',
  'add_magnet',
  'scan_network',
  'file_export_all_plates',
  'file_export_obj',
  'file_open_gcode',
  'help_config_folder',
  'view_perspective_toggle',
  'view_auto_perspective',
  'view_show_gcode_window',
  'tool_face_detector',
  'tool_hollow',
  'add_height_range',
  'set_negative_part',
  'variable_layer_height',
].sort();

const CANONICAL_CUTOVER_GATED_IDS = [
  'file_export_3mf',
  'edit_cut',
  'edit_copy',
  'edit_paste',
  'edit_delete_all',
  'tool_cut',
] as const;

const CANONICAL_ACTIONS_LEFT_ENABLED = [
  'file_new_project',
  'repair_model',
  'mesh_boolean_union',
  'mesh_boolean_subtract',
  'mesh_boolean_intersection',
  'split_to_parts',
  'add_modifier',
  'add_support_enforcer',
  'add_support_blocker',
  'file_open_project',
  'file_import_model',
  'file_import_zip',
  'paint_configure',
  'paint_erase_all',
  'tool_paint',
  'tool_lay_on_face',
  'arrange_all',
  'auto_place_wipe',
  'mirror_x',
  'reset_rotation',
  'center_on_plate',
  'tool_support_paint',
  'tool_seam_paint',
  'tool_fuzzy_skin',
  'file_save_project',
  'file_save_project_as',
  'edit_undo',
  'edit_redo',
  'edit_duplicate',
  'edit_delete_selected',
  'edit_select_all',
  'load_model_from_path',
  'tool_move',
  'tool_rotate',
  'tool_scale',
  'split_to_objects',
  'delete_models',
  'add_handy_model',
  'add_primitive_cube',
  'add_primitive_cylinder',
  'add_primitive_sphere',
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
  'add_plate',
  'delete_plate',
  'duplicate_plate',
  'slice_active_plate',
] as const;

const FULL_STATE = {
  mode: 'prepare',
  activeTool: 'move',
  modelCount: 3,
  plateCount: 2,
  hasSelection: true,
  hasInstanceSelection: true,
  hasClipboard: true,
  isSlicing: false,
  gcodeReady: true,
  extruderCount: 4,
  hasMultiColorPaint: true,
  canUndo: true,
  canRedo: true,
  dirty: true,
  projectionHealthy: true,
  status: 'ready',
  progress: null,
  preflightBlocked: false,
  // A connected, printing machine so the lifecycle actions are reachable.
  printerJobState: 'printing',
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

test('legacy mutating and lossy actions fail closed throughout the canonical cutover', () => {
  for (const id of CANONICAL_CUTOVER_GATED_IDS) {
    const action = registry.get(id);
    assert.ok(action, `${id} is missing`);
    assert.strictEqual(action.capability.status, 'unavailable', `${id} is not gated`);
    assert.match(action.capability.reason ?? '', /canonical/i, `${id} lacks an honest canonical reason`);
    assert.strictEqual(action.run, undefined, `${id} retained a legacy mutation handler`);
    assert.deepStrictEqual(registry.availability(action, 'command-palette', FULL_STATE), {
      state: 'disabled',
      reason: action.capability.reason,
    });
  }
});

test('store-backed actions needed by the live cutover remain executable', () => {
  for (const id of CANONICAL_ACTIONS_LEFT_ENABLED) {
    const action = registry.get(id);
    assert.ok(action, `${id} is missing`);
    assert.notStrictEqual(action.capability.status, 'unavailable', `${id} was incorrectly gated`);
    assert.notStrictEqual(action.capability.status, 'blocked', `${id} was incorrectly blocked`);
    assert.strictEqual(typeof action.run, 'function', `${id} lost its canonical handler`);
  }
});

test('workflow ownership covers every registry action exactly once', () => {
  const mappedIds = Object.values(ACTION_IDS_BY_PARITY_TASK).flat();
  assert.strictEqual(new Set(mappedIds).size, mappedIds.length, 'an action has multiple parity-task owners');
  assert.deepStrictEqual([...mappedIds].sort(), actions.map((action) => action.id).sort());
});

test('every task mapping exists in the plan and links to its real containing phase heading', () => {
  for (const action of actions) {
    const { helpHref, parityTaskId } = action.capability;
    const documentedPhase = parityTaskPhases.get(parityTaskId);
    assert.ok(documentedPhase, `${action.id} maps to missing task ${parityTaskId}`);
    assert.strictEqual(parityPhaseForTask(parityTaskId), documentedPhase, `${action.id} maps across phases`);
    assert.strictEqual(helpHref, parityHelpHrefForTask(parityTaskId), `${action.id} has a noncanonical help link`);

    const [path, fragment] = helpHref.split('#');
    assert.strictEqual(path, 'docs/parity.md', `${action.id} help must target the canonical parity plan`);
    assert.ok(fragment, `${action.id} help link has no anchor`);
    assert.ok(parityHeadingFragments.has(`#${fragment}`), `${action.id} help anchor #${fragment} does not exist`);
  }
});

test('every executable capability has status-appropriate evidence metadata', () => {
  for (const action of actions.filter(
    (item) => item.capability.status === 'implemented' || item.capability.status === 'partial',
  )) {
    assert.strictEqual(typeof action.run, 'function', `${action.id} has no handler`);
    assert.ok(action.capability.testIds.length > 0, `${action.id} has no test mapping`);
    if (action.capability.status === 'partial') {
      assert.ok(action.capability.reason?.trim(), `${action.id} has no partial reason`);
      assert.ok(action.capability.reason?.includes(action.capability.parityTaskId), `${action.id} reason omits owner`);
      assert.deepStrictEqual(action.capability.testIds, [
        registryMetadataTestId(action.id, action.capability.parityTaskId),
      ]);
    } else {
      assert.ok(
        action.capability.testIds.every((id) => !id.includes('.metadata-only.')),
        `${action.id} implemented status relies on metadata-only evidence`,
      );
    }
  }
  assert.ok(
    actions.every((action) => !action.capability.testIds.includes('actions.registry.enumeration')),
    'generic enumeration must not masquerade as per-action evidence',
  );
});

for (const action of actions.filter((item) => item.capability.status === 'partial')) {
  const metadataTestId = registryMetadataTestId(action.id, action.capability.parityTaskId);
  test(metadataTestId, () => {
    assert.deepStrictEqual(action.capability.testIds, [metadataTestId]);
    assert.strictEqual(typeof action.run, 'function');
    assert.ok(action.capability.surfaces.includes('command-palette'));
    assert.strictEqual(action.capability.helpHref, parityHelpHrefForTask(action.capability.parityTaskId));
  });
}

/**
 * Backing out is never DOM-only.
 *
 * An `xrUnsupportedReason` shared across a family of actions is how this got
 * wrong twice. Five brim-ear actions carried one sentence about a radius field
 * and an indexed list, which described two of them; the Smart Paint family
 * carried one about a per-region destination list, which described apply and
 * not the discard beside it. In both cases the effect was an operator who could
 * enter a state in the DOM shell, see it in a headset, and not get out of it.
 *
 * These are the actions that only ever *remove* pending or placed state. They
 * take no parameters, their result is visible in the scene, and none of them
 * can be the thing a headset withholds.
 */
test('every way of backing out of a state is reachable in a headset', () => {
  const registry = buildRegistry();
  for (const id of [
    'paint_smart_cancel',
    'brim_ears_clear',
    'brim_ears_auto',
    'simplify_cancel',
    'calib_session_discard',
    'calib_reset_parameters',
    'measure_clear',
  ]) {
    const action = registry.all().find((entry) => entry.id === id);
    assert.ok(action, `${id} is registered`);
    assert.equal(
      action.xrUnsupportedReason,
      undefined,
      `${id} takes no parameters and shows its result in the scene, so it must not be withheld in XR`,
    );
    assert.ok(
      action.capability.surfaces.some((surface: ActionSurface) => surface.startsWith('xr-')),
      `${id} must reach an XR surface`,
    );
  }
});

test('every action declares command-palette plus only its truthful presentation surfaces', () => {
  const domPresentation: Record<string, ActionSurface> = {
    primary: 'dom-primary',
    toolbar: 'dom-toolbar',
    menu: 'dom-menu',
    inspector: 'dom-inspector',
  };
  const xrPresentation: Partial<Record<string, ActionSurface>> = {
    primary: 'xr-primary',
    toolbar: 'xr-toolbar',
    menu: 'xr-menu',
  };
  for (const action of actions) {
    assert.ok(action.capability.surfaces.includes('command-palette'), `${action.id} missing palette`);
    const domSurface = domPresentation[action.disclosure];
    assert.ok(action.capability.surfaces.includes(domSurface), `${action.id} missing ${domSurface}`);
    assert.notStrictEqual(registry.availability(action, domSurface, FULL_STATE).state, 'hidden');

    const xrSurface = xrPresentation[action.disclosure];
    if (!xrSurface) continue;
    if (action.xrUnsupportedReason) {
      assert.ok(!action.capability.surfaces.includes(xrSurface), `${action.id} falsely advertises ${xrSurface}`);
      assert.deepStrictEqual(registry.availability(action, xrSurface, FULL_STATE), {
        state: 'hidden',
        reason: action.xrUnsupportedReason,
      });
    } else {
      assert.ok(action.capability.surfaces.includes(xrSurface), `${action.id} missing ${xrSurface}`);
      assert.notStrictEqual(
        registry.availability(action, xrSurface, FULL_STATE).state,
        'hidden',
        `${action.id} declared but hidden on ${xrSurface}`,
      );
    }
  }
});

test('DOM-only printer confirmation is never advertised as an immersive mutation path', () => {
  const send = registry.get('send_to_printer')!;
  assert.ok(send.capability.surfaces.includes('dom-menu'));
  assert.ok(send.capability.surfaces.includes('dom-inspector'));
  assert.ok(!send.capability.surfaces.includes('xr-menu'));
  assert.ok(!registry.forSurface('xr-menu').includes(send));
  const immersiveAvailability = registry.availability(send, 'xr-menu', FULL_STATE);
  assert.strictEqual(immersiveAvailability.state, 'hidden');
  if (immersiveAvailability.state === 'hidden') {
    assert.match(immersiveAvailability.reason, /XR-native dialog/);
  }
});

test('all XR toolbar actions are reachable by finite rail or Tools overflow', () => {
  const toolbar = registry.forSurface('xr-toolbar');
  const rail = xrToolRailActions(toolbar);
  const overflow = toolbar.filter((action) => !rail.includes(action));
  // Smart Paint, Smart Paint (Image), Assembly, Brim Ears, and the SVG part
  // tool are deliberately absent: each declares an XR exclusion for a reason a
  // headset cannot yet satisfy — typed consent, a per-region list, an indexed
  // list, a file picker.
  //
  // Measure is *not* in that list any more. Its exclusion said the readout was
  // DOM-only, and the measurement is drawn on the model now; picking a feature
  // is a ray against a mesh, which the four paint tools on this same toolbar
  // already do in a headset. A reason that has stopped being true is worse
  // than no reason, because it reads as a considered limit.
  assert.strictEqual(toolbar.length, 14);
  assert.strictEqual(rail.length, 7);
  assert.strictEqual(overflow.length, 7);
  for (const excluded of [
    'tool_smart_paint',
    'tool_smart_paint_image',
    'tool_assembly',
    'tool_brim_ears',
    'tool_svg',
  ]) {
    assert.equal(
      toolbar.some((action) => action.id === excluded),
      false,
      `${excluded} must stay out of the XR toolbar`,
    );
  }
  assert.deepStrictEqual(new Set([...rail, ...overflow]), new Set(toolbar));
});

test('registry guard explains unavailable actions without invoking a handler', () => {
  const reports: string[] = [];
  const ctx = {
    reportCapabilityUnavailable: (label: string, reason: string) => reports.push(`${label}: ${reason}`),
  } as unknown as ActionContext;
  void registry.invoke('file_export_3mf', 'dom-menu', ctx, FULL_STATE);
  assert.strictEqual(reports.length, 1);
  assert.match(reports[0], /drops canonical project metadata/i);
});

test('prerequisite evaluator gives actionable disabled reasons', () => {
  const empty = {
    ...FULL_STATE,
    modelCount: 0,
    hasSelection: false,
    hasInstanceSelection: false,
    gcodeReady: false,
  };
  assert.deepStrictEqual(registry.availability('tool_move', 'dom-toolbar', empty), {
    state: 'disabled',
    reason: 'Select a model instance for this action.',
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

/**
 * P10.5's structural half: XR is a complete surface or says exactly where it
 * is not. Before `xr-inspector` existed, 54 of 195 actions — every printer,
 * preset, calibration, and settings control — reached no XR surface and
 * declared no reason, which reads as "not built yet" and is indistinguishable
 * from an oversight. An action may still be absent from XR; it just has to say
 * so in `xrUnsupportedReason`.
 */
test('every action is reachable in XR or declares why it is not', () => {
  const silent = actions.filter(
    (action) => !action.capability.surfaces.some((surface) => surface.startsWith('xr')) && !action.xrUnsupportedReason,
  );
  assert.deepStrictEqual(
    silent.map((action) => action.id),
    [],
    'these actions are absent from XR without saying so',
  );

  // The declared refusals are real sentences, not empty strings standing in for
  // one, and they never claim a surface at the same time.
  for (const action of actions.filter((candidate) => candidate.xrUnsupportedReason)) {
    assert.ok((action.xrUnsupportedReason ?? '').trim().length > 10, `${action.id}: reason is not a sentence`);
    assert.deepStrictEqual(
      action.capability.surfaces.filter((surface) => surface.startsWith('xr')),
      [],
      `${action.id}: declares an XR reason and an XR surface`,
    );
  }
});

test('the inspector catalog is reachable through one XR menu section', () => {
  const inspector = registry.forSurface('xr-inspector');
  assert.ok(inspector.length > 0);
  // Every one is inspector-disclosure: the Panels section is the XR home for
  // exactly what the DOM shell keeps in its inspector, and nothing else.
  assert.deepStrictEqual(
    inspector.filter((action) => action.disclosure !== 'inspector').map((action) => action.id),
    [],
  );
  const workspaceSource = readFileSync(
    fileURLToPath(new URL('../../workspace/OrcaWorkspace.ts', import.meta.url)),
    'utf8',
  );
  assert.match(workspaceSource, /forSurface\('xr-inspector'\)/, 'the XR shell renders the surface it declares');
});

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

test('live printer reads use the registry and retired clients stay absent', () => {
  const mainSource = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8');
  assert.match(mainSource, /registry\.invoke\('printer_test_connection',\s*'dom-inspector'/);
  assert.match(mainSource, /registry\.invoke\('printer_inspect_filaments',\s*'dom-inspector'/);
  assert.doesNotMatch(mainSource, /MoonrakerClient|PrinterClient|PrintSendFlow|SubnetScanner/);

  for (const relativePath of [
    '../../features/MoonrakerClient.ts',
    '../../features/PrintSendFlow.ts',
    '../../features/SubnetScanner.ts',
    '../../net/PrinterClient.ts',
  ]) {
    assert.strictEqual(existsSync(fileURLToPath(new URL(relativePath, import.meta.url))), false, relativePath);
  }
});

test('composition root injects one registry into the workspace and DOM shell', () => {
  const mainSource = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8');
  const workspaceSource = readFileSync(
    fileURLToPath(new URL('../../workspace/OrcaWorkspace.ts', import.meta.url)),
    'utf8',
  );
  const domShellSource = readFileSync(fileURLToPath(new URL('../../ui/dom/DomShell.ts', import.meta.url)), 'utf8');
  const workspaceViewsSource = readFileSync(
    fileURLToPath(new URL('../../ui/dom/WorkspaceViews.ts', import.meta.url)),
    'utf8',
  );
  const workspaceToolsSource = readFileSync(
    fileURLToPath(new URL('../../mcp/WorkspaceTools.ts', import.meta.url)),
    'utf8',
  );

  assert.doesNotMatch(workspaceSource, /from ['"]\.\.\/actions\/catalog['"]/);
  assert.doesNotMatch(workspaceSource, /\bbuildRegistry\s*\(/);
  assert.match(workspaceSource, /constructor\(\s*private readonly actionRegistry: ActionRegistry,/);

  const registryConstruction = mainSource.indexOf('const registry = buildRegistry();');
  const workspaceConstruction = mainSource.indexOf('new OrcaWorkspace(registry');
  const domShellConstruction = mainSource.indexOf('new DomShell(registry, actionCtx, uiState)');
  assert.ok(registryConstruction >= 0, 'main must construct the registry');
  assert.ok(workspaceConstruction > registryConstruction, 'workspace must receive the composition-root registry');
  assert.ok(domShellConstruction > workspaceConstruction, 'DOM shell must receive that same registry variable');
  assert.strictEqual(mainSource.match(/\bbuildRegistry\s*\(/g)?.length, 1, 'main must construct exactly one registry');
  assert.match(mainSource, /setupDomUI\(workspace, uiState, actionCtx, registry[,)]/);
  // Localization is attached to the composition-root registry, not to a shell
  // (P10.4). Every surface reads its text through `all()`/`get()`, so this one
  // line is what keeps DOM, XR, the palette, and context menus in one language;
  // a shell that localized on its own would translate half the app.
  const textSourceWiring = mainSource.indexOf('registry.useTextSource(l10n)');
  assert.ok(textSourceWiring > registryConstruction, 'the registry must localize before any shell renders it');
  assert.ok(textSourceWiring < domShellConstruction, 'and before the DOM shell mounts from it');
  assert.match(mainSource, /new ActionContext\(workspace, uiState, registry\)/);
  assert.match(mainSource, /registerWorkspaceTools\(mcp, workspace, registry, actionCtx\)/);

  assert.match(mainSource, /emptyLoadModel\.onclick[\s\S]*?\.invoke\('load_model_from_path', 'dom-primary'/);
  assert.match(mainSource, /add\.onclick[\s\S]*?\.invoke\('add_plate', 'dom-menu'/);
  assert.match(mainSource, /btnCloseToolSettings\.onclick[\s\S]*?\.invoke\('tool_move', 'dom-toolbar'/);
  assert.match(
    mainSource,
    /chip\.onclick[\s\S]*?\.invoke\('activate_plate', 'dom-inspector', actionCtx, uiState\.get\(\), \{ plateId: p\.id \}\)/,
  );
  assert.match(mainSource, /\.invoke\('delete_plate', 'dom-menu', actionCtx, uiState\.get\(\), \{ plateId: p\.id \}\)/);
  assert.doesNotMatch(mainSource, /actionCtx\.activatePlate\(|workspace\.setWipeTowerAuto\(/);
  assert.doesNotMatch(workspaceToolsSource, /workspace\.setTool\(/);
  assert.match(workspaceToolsSource, /registry\.invoke\(actionId, 'automation'/);
  assert.doesNotMatch(domShellSource, /ctx\.setMode\(/);
  // The header is presentation only: `Slice plate` and `Print` run the shared
  // registry action for that step on a declared surface, and the Prepare /
  // Preview tabs run the same `toggle_preview` the menu and keyboard run. A
  // tab that changed the mode itself would be a second slice-workflow path.
  assert.match(domShellSource, /id: 'slice_active_plate', surface: 'dom-primary'/);
  assert.match(domShellSource, /id: 'send_to_printer', surface: 'dom-inspector'/);
  assert.doesNotMatch(workspaceViewsSource, /ctx\.setMode\(|workspace\.[A-Za-z]+\(/);
  assert.match(workspaceViewsSource, /this\.invoke\('toggle_preview'\)/);
  assert.match(
    mainSource,
    /new WorkspaceViews\([\s\S]*?registry\s*\n?\s*\.invoke\(actionId, 'dom-primary', actionCtx, uiState\.get\(\)\)/,
  );
  assert.match(workspaceSource, /\.invoke\('load_model_from_path', 'xr-primary'/);
});

const counts = Object.fromEntries(
  ['implemented', 'partial', 'unavailable', 'blocked'].map((status) => [
    status,
    actions.filter((action) => action.capability.status === status).length,
  ]),
);
console.log(`\nCapability parity: ${passed} tests passed. ${JSON.stringify(counts)}`);
