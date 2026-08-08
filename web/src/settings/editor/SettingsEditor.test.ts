import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EngineOptionCatalog, parseEngineOptionSchema } from '../generated/loader';
import type { EngineOptionDefinition } from '../generated/types';
import { parseSettingDraft, serializeSettingValue, validateSettingValue } from './codec';
import { assessFieldSupport, projectSettingsFields } from './fields';
import { SettingsDraftEditor } from './SettingsDraftEditor';
import { SettingsDraftCommitError } from './types';

const schema = parseEngineOptionSchema(
  readFileSync(new URL('../generated/engine-options.schema.json', import.meta.url), 'utf8'),
);
const catalog = new EngineOptionCatalog(schema);

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function definition(key: string): EngineOptionDefinition {
  return catalog.get(key);
}

function parsed(key: string, raw: string) {
  const result = parseSettingDraft(definition(key), raw);
  assert.equal(result.ok, true, `${key} should parse ${JSON.stringify(raw)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

test('projects deterministic schema fields by mode, technology, search, and honest support', () => {
  const query = { mode: 'advanced' as const, technology: 'fff' as const, search: 'layer height' };
  const first = projectSettingsFields(catalog, query);
  const second = projectSettingsFields(catalog, query);
  assert.deepEqual(
    first.map((field) => field.id),
    second.map((field) => field.id),
  );
  assert.ok(first.some((field) => field.key === 'layer_height'));
  assert.ok(first.every((field) => field.mode !== 'develop'));
  assert.ok(first.every((field) => field.applicability === 'applicable'));
  assert.ok(first.find((field) => field.key === 'layer_height')!.searchMatches.length > 0);
  const layerHeight = first.find((field) => field.key === 'layer_height')!;
  assert.equal(layerHeight.primaryGuiLocation?.tab.label, 'Quality');
  assert.equal(layerHeight.primaryGuiLocation?.group.label, 'Layer height');
  assert.deepEqual(
    layerHeight.guiLocations.map((location) => location.tab.label),
    ['Quality', 'Frequent'],
  );

  const sla = projectSettingsFields(catalog, {
    mode: 'develop',
    technology: 'sla',
    search: 'enable support',
  });
  assert.equal(
    sla.some((field) => field.key === 'enable_support'),
    false,
  );
  const unknown = projectSettingsFields(catalog, {
    mode: 'advanced',
    technology: 'fff',
    search: 'first layer height',
    includeUnknownApplicability: true,
  });
  assert.ok(unknown.some((field) => field.applicability === 'unknown'));

  assert.deepEqual(assessFieldSupport(catalog, definition('layer_height')), { status: 'implemented' });
  assert.equal(assessFieldSupport(catalog, definition('compatible_printers')).reason, 'custom-tab-widget');
  assert.equal(assessFieldSupport(catalog, definition('printer_model')).reason, 'no-literal-gui-placement');
  assert.match(assessFieldSupport(catalog, definition('wall_filament')).reason!, /^special-widget:/);
  assert.match(assessFieldSupport(catalog, definition('filament_colour')).reason!, /^special-widget:/);
  assert.equal(assessFieldSupport(catalog, definition('curr_bed_type')).reason, 'conditional-enum-domain');
});

test('parses, validates, and serializes every supported scalar family without locale coercion', () => {
  assert.deepEqual(parsed('enable_support', 'true'), { ok: true, value: true, serialized: '1' });
  assert.deepEqual(parsed('wall_loops', '4'), { ok: true, value: 4, serialized: '4' });
  assert.equal(parseSettingDraft(definition('wall_loops'), '4.2').ok, false);
  assert.deepEqual(parsed('layer_height', '.24'), { ok: true, value: 0.24, serialized: '0.24' });
  assert.equal(parseSettingDraft(definition('layer_height'), '0,24').ok, false);
  assert.ok(validateSettingValue(definition('layer_height'), -0.1).some((item) => item.code === 'below-minimum'));
  assert.deepEqual(parsed('sparse_infill_density', '25%'), {
    ok: true,
    value: 25,
    serialized: '25%',
  });
  assert.equal(parseSettingDraft(definition('sparse_infill_density'), '101%').ok, false);
  assert.deepEqual(parsed('bridge_acceleration', '50%'), {
    ok: true,
    value: { percent: true, value: 50 },
    serialized: '50%',
  });
  assert.deepEqual(parsed('bridge_acceleration', '1200'), {
    ok: true,
    value: { percent: false, value: 1200 },
    serialized: '1200',
  });
  const gcode = 'G28\nM104 S220 ; keep exact spacing';
  assert.deepEqual(parsed('machine_start_gcode', gcode), {
    ok: true,
    value: gcode,
    serialized: gcode,
  });
  assert.deepEqual(parsed('brim_type', 'outer_only'), {
    ok: true,
    value: 'outer_only',
    serialized: 'outer_only',
  });
  assert.equal(parseSettingDraft(definition('brim_type'), 'Outer brim only').ok, false);
  assert.deepEqual(parsed('bed_mesh_max', '12.5,-3'), {
    ok: true,
    value: [12.5, -3],
    serialized: '12.5,-3',
  });
});

test('uses schema-exact vector, point, percent, and nullable delimiters and fails delimiter drift closed', () => {
  assert.deepEqual(parsed('compatible_printers', 'U1;Centauri Carbon;Custom'), {
    ok: true,
    value: ['U1', 'Centauri Carbon', 'Custom'],
    serialized: 'U1;Centauri Carbon;Custom',
  });
  assert.deepEqual(parsed('nozzle_diameter', '0.4,0.6'), {
    ok: true,
    value: [0.4, 0.6],
    serialized: '0.4,0.6',
  });
  assert.deepEqual(parsed('activate_air_filtration', '1,0,true'), {
    ok: true,
    value: [true, false, true],
    serialized: '1,0,1',
  });
  assert.deepEqual(parsed('filament_retraction_length', 'nil,0.8'), {
    ok: true,
    value: [null, 0.8],
    serialized: 'nil,0.8',
  });
  assert.deepEqual(parsed('filament_retract_before_wipe', 'nil,85%'), {
    ok: true,
    value: [null, 85],
    serialized: 'nil,85%',
  });
  assert.deepEqual(parsed('printable_area', '0x0,200x0,200x200,0x200'), {
    ok: true,
    value: [
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ],
    serialized: '0x0,200x0,200x200,0x200',
  });

  const delimiterMutation = JSON.parse(JSON.stringify(definition('compatible_printers'))) as EngineOptionDefinition;
  (delimiterMutation.storage.serialization as { collectionDelimiter: string }).collectionDelimiter = ',';
  const mutationResult = parseSettingDraft(delimiterMutation, 'PLA;PETG');
  assert.equal(mutationResult.ok, false);
  if (!mutationResult.ok) {
    assert.ok(mutationResult.issues.some((item) => item.code === 'string-vector-must-use-semicolon'));
  }
  assert.throws(() => serializeSettingValue(definition('compatible_printers'), ['contains;delimiter']));
});

test('tracks inherited/default/changed state and commits all valid drafts atomically', () => {
  const editor = new SettingsDraftEditor(catalog, {
    mode: 'advanced',
    technology: 'fff',
    inherited: { layer_height: 0.24, wall_loops: 2 },
    overrides: { wall_loops: 3, enable_support: false },
  });
  const layer = definition('layer_height').id;
  const walls = definition('wall_loops').id;
  const support = definition('enable_support').id;
  const density = definition('sparse_infill_density').id;

  assert.equal(editor.getFieldState(layer).origin, 'inherited');
  assert.equal(editor.getFieldState(walls).origin, 'changed');
  assert.equal(editor.getFieldState(support).origin, 'default');
  assert.equal(editor.getFieldState(support).hasLocalOverride, true);
  assert.equal(editor.compare(walls).effectiveEqualsDefault, false);

  editor.setDraft(walls, '4');
  editor.setDraft(layer, '-1');
  const beforeFailedCommit = editor.getOverrides();
  assert.throws(() => editor.commit(), SettingsDraftCommitError);
  assert.equal(editor.getRevision(), 0);
  assert.deepEqual(editor.getOverrides(), beforeFailedCommit);
  assert.equal(editor.getFieldState(walls).draftValue, 4);

  editor.clearDraft(layer);
  editor.resetToInherited(walls);
  editor.setDraft(density, '25%');
  const commit = editor.commit();
  assert.equal(commit.baseRevision, 0);
  assert.equal(commit.revision, 1);
  assert.deepEqual(
    commit.changes.map((change) => [change.key, change.action, change.serialized]),
    [
      ['sparse_infill_density', 'set', '25%'],
      ['wall_loops', 'remove', undefined],
    ],
  );
  assert.equal('wall_loops' in commit.nextOverrides, false);
  assert.equal(commit.nextOverrides.sparse_infill_density, 25);
  assert.equal(editor.getFieldState(walls).origin, 'inherited');
  assert.equal(editor.getFieldState(density).origin, 'changed');

  assert.throws(() => editor.setDraft(definition('wall_filament').id, '2'), /unavailable/);
  editor.resetToDefault(density);
  const reset = editor.commit();
  assert.equal(reset.changes[0].serialized, '20%');
});

test('fails project/process drafts closed for filament, printer, and plate-only GUI surfaces', () => {
  const editor = new SettingsDraftEditor(catalog, {
    mode: 'advanced',
    technology: 'fff',
    guiSurface: 'process',
  });
  assert.throws(() => editor.setDraft(definition('printable_height').id, '250'), /gui-surface-unavailable:process/);
  assert.throws(() => editor.setDraft(definition('filament_diameter').id, '1.75'), /gui-surface-unavailable:process/);
  assert.throws(
    () => editor.setDraft(definition('first_layer_sequence_choice').id, '0'),
    /gui-surface-unavailable:process/,
  );
  editor.setDraft(definition('layer_height').id, '0.22');

  const revalidated = new SettingsDraftEditor(catalog, { mode: 'advanced', technology: 'fff' });
  revalidated.setDraft(definition('printable_height').id, '250');
  (revalidated as unknown as { guiSurface: 'process' | undefined }).guiSurface = 'process';
  assert.throws(() => revalidated.commit(), SettingsDraftCommitError);
  assert.equal(revalidated.getRevision(), 0);
});

console.log(`\nSchema-driven settings editor: ${passed} tests passed.`);
