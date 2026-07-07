/**
 * Parity test (run: npx tsx parity.test.ts).
 *
 * Guards the two invariants the shared-registry architecture exists to protect:
 *
 *  1. Shell parity — every non-inspector action resolves to an explicit glyph in
 *     BOTH the `xr` and `dom` icon maps, so the DOM shell and the (registry-driven)
 *     XR shell can render the identical action set. Adding an action without a
 *     both-shell icon fails here.
 *  2. MCP parity — every action's `mcpTool` is a real member of the canonical
 *     Android MCP tool surface (extracted live from the Kotlin sources), so the
 *     web UI can't drift a button onto a tool that doesn't exist, and the core
 *     capabilities stay mapped to the catalogue.
 *
 * Also locks in the Phase-5 cleanup: no orphaned `*Panel.ts` view files remain.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '../catalog';
import { GROUPS, ActionRegistry as Reg } from '../ActionRegistry';
import { hasIcon } from '../../ui/icons';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Recursively collect every MCP tool name declared as `name = "…"` in Kotlin. */
function extractMcpToolNames(): Set<string> {
  const dir = `${repoRoot}app/src/main/java/dev/orcaxr/app/mcp`;
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.kt')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/name\s*=\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
      }
    }
  };
  walk(dir);
  return names;
}

const registry = buildRegistry();
const actions = registry.all();
const mcp = extractMcpToolNames();

test('MCP surface extracts the full canonical catalogue', () => {
  // The project treats 163 tools as canonical; guard against a broken extraction.
  assert.ok(mcp.size >= 150, `expected >=150 MCP tools, got ${mcp.size}`);
});

test('every action maps to a REAL MCP tool (no drift)', () => {
  const bad = actions.filter((a) => a.mcpTool && !mcp.has(a.mcpTool));
  assert.deepStrictEqual(bad.map((a) => `${a.id}→${a.mcpTool}`), [],
    'actions reference non-existent MCP tools');
});

test('core capabilities are mapped to the MCP catalogue', () => {
  // These must never silently lose their tie to the canonical surface.
  const mustMap = [
    'load_model_from_path', 'slice_active_plate', 'save_gcode_to_downloads',
    'repair_model', 'simplify_model', 'delete_models',
    'add_handy_model', 'add_primitive_cube', 'mesh_boolean_union',
  ];
  for (const id of mustMap) {
    const a = registry.get(id);
    assert.ok(a, `missing action ${id}`);
    assert.ok(a!.mcpTool && mcp.has(a!.mcpTool), `${id} not mapped to a real MCP tool`);
  }
});

test('every non-inspector action renders in BOTH shells (icon in xr + dom)', () => {
  const unrenderable = actions
    .filter((a) => a.disclosure !== 'inspector')
    .filter((a) => !hasIcon(a.icon))
    .map((a) => `${a.id} (icon:${a.icon})`);
  assert.deepStrictEqual(unrenderable, [], 'actions lack a both-shell icon glyph');
});

test('group icons also resolve in both shells', () => {
  const missing = GROUPS.filter((g) => !hasIcon(g.icon)).map((g) => g.id);
  assert.deepStrictEqual(missing, [], 'groups lack a both-shell icon glyph');
});

test('no orphaned *Panel.ts view files remain (Phase 5 cleanup)', () => {
  const wsDir = `${here}../../workspace`;
  const panels = readdirSync(wsDir).filter((f) => f.endsWith('Panel.ts'));
  assert.deepStrictEqual(panels, [], `stale Panel view files: ${panels.join(', ')}`);
});

// --- Snapmaker Orca surface coverage -------------------------------------
//
// Every actionable control in Snapmaker Orca must have an OrcaXR equivalent
// (wired or a `comingSoon` placeholder). This checklist is the machine-checked
// contract behind docs/orca_parity_plan.md: deleting a parity action fails CI.
const REQUIRED_ORCA_ACTIONS: string[] = [
  // File menu
  'file_new_project', 'file_open_project', 'file_import_model', 'file_import_config',
  'file_import_zip', 'file_save_project', 'file_save_project_as', 'file_export_gcode',
  'file_export_all_plates', 'file_export_stl', 'file_export_3mf', 'file_export_config',
  'file_export_obj', 'file_open_gcode', 'file_export_logs',
  // Edit menu
  'edit_undo', 'edit_redo', 'edit_cut', 'edit_copy', 'edit_paste', 'edit_duplicate',
  'edit_delete_selected', 'edit_delete_all', 'edit_select_all', 'edit_deselect_all',
  // View menu
  'view_camera_default', 'view_camera_top', 'view_camera_front', 'view_camera_left',
  'view_camera_right', 'view_camera_rear', 'view_camera_bottom', 'view_perspective_toggle',
  'view_show_labels', 'view_show_overhang', 'view_show_wireframe', 'view_auto_perspective',
  'view_show_navigator', 'view_show_outline', 'view_show_gcode_window', 'view_show_printable_box',
  // Scene / gizmos / mesh ops
  'tool_move', 'tool_rotate', 'tool_scale', 'tool_lay_on_face', 'tool_paint',
  'drop_to_bed', 'delete_models', 'repair_model', 'simplify_model',
  'mesh_boolean_union', 'mesh_boolean_subtract', 'mesh_boolean_intersection',
  'arrange_all', 'split_to_objects', 'split_to_parts', 'tool_cut', 'tool_support_paint',
  'tool_seam_paint', 'tool_fuzzy_skin', 'tool_brim_ears', 'tool_measure', 'tool_assembly',
  'tool_face_detector', 'tool_svg', 'tool_hollow', 'add_modifier', 'add_support_enforcer',
  'add_support_blocker', 'add_height_range', 'set_negative_part', 'variable_layer_height',
  // Add menu
  'add_handy_model', 'add_primitive_cube', 'add_primitive_cylinder', 'add_primitive_sphere',
  'add_plate', 'delete_plate', 'duplicate_plate',
  // Slice / output
  'slice_active_plate', 'toggle_preview', 'save_gcode_to_downloads', 'send_to_printer',
  // Calibration menu
  'calib_temperature', 'calib_flow_pass1', 'calib_flow_pass2', 'calib_flow_yolo',
  'calib_pressure_advance', 'calib_retraction', 'calib_max_flow', 'calib_vfa', 'calib_tolerance',
  // Advanced
  'add_emboss', 'add_magnet', 'auto_place_wipe',
  // Help menu
  'help_setup_wizard', 'help_shortcuts', 'help_config_folder', 'help_tutorial',
  'help_docs', 'help_report_bug', 'help_tip_of_day', 'help_check_updates', 'help_about',
];

test('every required Snapmaker Orca control has an OrcaXR action', () => {
  const missing = REQUIRED_ORCA_ACTIONS.filter((id) => !registry.get(id));
  assert.deepStrictEqual(missing, [], `parity actions missing from the registry: ${missing.join(', ')}`);
});

test('coming-soon parity placeholders are always disabled', () => {
  // A placeholder must never be clickable, in any UI state.
  const anyState = { modelCount: 5, hasSelection: true, gcodeReady: true, plateCount: 3,
    isSlicing: false, preflightBlocked: false } as unknown as Parameters<typeof Reg.enabled>[1];
  const live = actions.filter((a) => a.comingSoon && Reg.enabled(a, anyState));
  assert.deepStrictEqual(live.map((a) => a.id), [], 'coming-soon actions must be disabled');
});

test('coming-soon actions carry a reason string for the tooltip', () => {
  const blank = actions.filter((a) => a.comingSoon !== undefined && a.comingSoon.trim() === '');
  assert.deepStrictEqual(blank.map((a) => a.id), [], 'coming-soon actions need a non-empty reason');
});

console.log(`\nParity: ${passed} tests passed. (${actions.length} actions, ` +
  `${actions.filter((a) => a.comingSoon).length} coming-soon, ${mcp.size} MCP tools)`);
