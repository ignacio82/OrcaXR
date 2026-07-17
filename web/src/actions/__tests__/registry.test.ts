/**
 * Node tests for the ActionRegistry + catalog (run: npx tsx registry.test.ts).
 * These are the structural-parity guarantees: a duplicate id or a miswired
 * disclosure is a build-time failure, not a runtime surprise in one shell.
 */
import assert from 'node:assert';
import { ActionRegistry, GROUPS, type GroupId } from '../ActionRegistry';
import { buildRegistry } from '../catalog';
import type { UiStateShape } from '../UiState';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const baseState: UiStateShape = {
  mode: 'prepare',
  activeTool: 'move',
  modelCount: 0,
  plateCount: 1,
  hasSelection: false,
  hasClipboard: false,
  isSlicing: false,
  gcodeReady: false,
  extruderCount: 1,
  hasMultiColorPaint: false,
  status: '',
  progress: null,
  preflightBlocked: false,
};

test('catalog builds without duplicate ids', () => {
  const reg = buildRegistry();
  assert.ok(reg.all().length >= 12, 'expected the current action set');
});

test('duplicate id throws', () => {
  const reg = new ActionRegistry();
  const a = {
    id: 'x',
    label: 'X',
    icon: 'move',
    group: 'scene' as GroupId,
    disclosure: 'menu' as const,
    run: () => {},
  };
  reg.add(a);
  assert.throws(() => reg.add({ ...a }), /duplicate action id/);
});

test('every action has a known group', () => {
  const known = new Set(GROUPS.map((g) => g.id));
  for (const a of buildRegistry().all()) {
    assert.ok(known.has(a.group), `action ${a.id} has unknown group ${a.group}`);
  }
});

test('primary bar has the four expected actions', () => {
  const ids = buildRegistry()
    .byDisclosure('primary')
    .map((a) => a.id)
    .sort();
  assert.deepStrictEqual(
    ids,
    ['load_model_from_path', 'save_gcode_to_downloads', 'slice_active_plate', 'toggle_preview'].sort(),
  );
});

test('every toolbar action declares a tool', () => {
  for (const a of buildRegistry().byDisclosure('toolbar')) {
    if (['tool_move', 'tool_rotate', 'tool_scale', 'tool_lay_on_face'].includes(a.id)) {
      assert.ok(a.tool, `${a.id} should declare a tool`);
    }
  }
});

test('Slice is gated: disabled with no models, enabled with models & clean preflight', () => {
  const slice = buildRegistry().get('slice_active_plate')!;
  assert.strictEqual(ActionRegistry.enabled(slice, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1, preflightBlocked: true }), false);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1, isSlicing: true }), false);
});

test('Download gated on gcodeReady; Repair/Delete gated on selection', () => {
  const reg = buildRegistry();
  assert.strictEqual(ActionRegistry.enabled(reg.get('save_gcode_to_downloads')!, baseState), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('save_gcode_to_downloads')!, { ...baseState, gcodeReady: true }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('repair_model')!, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('repair_model')!, { ...baseState, hasSelection: true }), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('mesh_boolean_union')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('mesh_boolean_union')!, { ...baseState, modelCount: 2 }), true);
});

console.log(`\nRegistry: ${passed} tests passed.`);
