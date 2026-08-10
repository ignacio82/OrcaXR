/**
 * Scoped setting overrides (P6.5).
 *
 * The interesting cases are the ones where the obvious answer is wrong: a key
 * stored where the engine never reads it, and a height range that outranks the
 * part it cuts through even though every UI nests it the other way round.
 */
import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  SetProjectSettingsOverridesCommand,
  SetScopedOverridesCommand,
  SettingScopeError,
  StaleScopedOverrideError,
  UnknownScopedOverrideTargetError,
  canonicalStringify,
  entityId,
  explainScopedSetting,
  narrowestScopeForSetting,
  projectScopeUpdate,
  resolveConfig,
  resolveScopedConfig,
  sanitizeScopedOverrides,
  scopedConfigBytes,
  scopedOverrideSnapshot,
  scopesForSetting,
  settingScopeAllows,
  validateScopedOverrides,
  SETTING_SCOPE_KEYS,
  SETTING_SCOPE_ORDER,
  SETTING_SCOPE_SOURCE,
  type PlateId,
  type ScopedOverrideTarget,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, project, bus };
}

function guardOf(project: ProjectStore) {
  const snapshot = project.getSnapshot();
  return { sourceRevision: snapshot.revision, sourceHash: snapshot.hash };
}

test('carries the pinned engine provenance the table was read from', () => {
  assert.match(SETTING_SCOPE_SOURCE.commit, /^[0-9a-f]{40}$/);
  assert.equal(SETTING_SCOPE_SOURCE.files.length, 4);
  for (const file of SETTING_SCOPE_SOURCE.files) assert.match(file.blob, /^[0-9a-f]{40}$/);
  assert.deepEqual([...SETTING_SCOPE_ORDER], ['project', 'plate', 'object', 'part', 'layerRange']);
});

test('keeps each scope to the keys the engine reads there', () => {
  // A plate overrides a deliberately tiny set; storing a wall count on one does
  // nothing at all, which is exactly the mistake the table exists to catch.
  assert.equal(settingScopeAllows('plate', 'print_sequence'), true);
  assert.equal(settingScopeAllows('plate', 'wall_loops'), false);
  assert.equal(settingScopeAllows('part', 'wall_loops'), true);
  assert.equal(settingScopeAllows('part', 'layer_height'), false);
  assert.equal(settingScopeAllows('layerRange', 'layer_height'), true);
  assert.equal(settingScopeAllows('object', 'brim_type'), true);
  assert.equal(settingScopeAllows('part', 'brim_type'), false);
  assert.equal(settingScopeAllows('project', 'nozzle_temperature'), true);

  // `TabPrintModel` intersects every model scope with the print preset, so a
  // key editable on an object, part, or height range is always editable on the
  // project too.
  for (const scope of ['object', 'part', 'layerRange'] as const) {
    for (const key of SETTING_SCOPE_KEYS[scope]) {
      assert.ok(settingScopeAllows('project', key), `${key} (${scope}) is missing from the project scope`);
    }
  }
  // Plates are the exception: five of their eight keys describe a plate's own
  // arrangement and exist at no other scope.
  assert.deepEqual(
    SETTING_SCOPE_KEYS.plate.filter((key) => !settingScopeAllows('project', key)),
    [
      'curr_bed_type',
      'first_layer_print_sequence',
      'first_layer_sequence_choice',
      'other_layers_print_sequence',
      'other_layers_sequence_choice',
    ],
  );
  assert.deepEqual(scopesForSetting('layer_height'), ['project', 'object', 'layerRange']);
  assert.equal(narrowestScopeForSetting('brim_type'), 'object');
  assert.equal(narrowestScopeForSetting('not_a_setting'), undefined);
});

test('refuses an out-of-scope override instead of dropping it', () => {
  const issues = validateScopedOverrides([{ scope: 'plate', id: 'p1', overrides: { wall_loops: 4 } }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'setting-not-in-scope');
  assert.equal(issues[0].path, 'layers[0].wall_loops');
  assert.match(issues[0].message, /cannot be set on a plate/);
  assert.match(issues[0].message, /object, part or height range/);

  assert.throws(
    () => resolveScopedConfig({}, [{ scope: 'plate', overrides: { wall_loops: 4 } }]),
    (error: unknown) => error instanceof SettingScopeError,
  );
  assert.deepEqual(
    validateScopedOverrides([
      { scope: 'object', id: 'o1', overrides: {} },
      { scope: 'object', id: 'o1', overrides: {} },
    ]).map((issue) => issue.code),
    ['duplicate-scope-layer'],
  );
});

test('lets a height range outrank the part it cuts through', () => {
  const bytes = scopedConfigBytes({ sparse_infill_density: 15 }, [
    { scope: 'layerRange', id: 'r1', overrides: { sparse_infill_density: 40 } },
    { scope: 'part', id: 'v1', overrides: { sparse_infill_density: 25 } },
  ]);
  assert.equal(bytes, canonicalStringify({ sparse_infill_density: 40 }));

  // Argument order must not matter — the sort is by scope, not by position.
  assert.equal(
    bytes,
    scopedConfigBytes({ sparse_infill_density: 15 }, [
      { scope: 'part', id: 'v1', overrides: { sparse_infill_density: 25 } },
      { scope: 'layerRange', id: 'r1', overrides: { sparse_infill_density: 40 } },
    ]),
  );
});

test('sanitizes a foreign map and names everything it removed', () => {
  const result = sanitizeScopedOverrides('plate', { print_sequence: 'by object', wall_loops: 4 }, 'plate-1');
  assert.deepEqual(result.overrides, { print_sequence: 'by object' });
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].path, 'plate[plate-1].wall_loops');
});

test('reports a stored key the engine never reads rather than layering it', () => {
  const { fixture } = harness();
  // The fixture plate carries `layer_height`, which a plate cannot override.
  const resolved = resolveConfig(fixture.state, { plateId: fixture.state.activePlateId });
  assert.equal(resolved.effective.layer_height, 0.24);
  assert.deepEqual(
    resolved.ignored.map((entry) => [entry.scope.kind, entry.key]),
    [['plate', 'layer_height']],
  );
  assert.match(resolved.ignored[0].reason, /not from the plate scope/);
});

test('shows one node its own overrides, its chain, and what the chain resolves to', () => {
  const { fixture, project } = harness();
  const target: ScopedOverrideTarget = { scope: 'part', volumeId: fixture.object.volumes[0].id };
  const view = scopedOverrideSnapshot(project.getSnapshot(), target);

  assert.equal(view.scope, 'part');
  assert.equal(view.label, 'Body');
  assert.deepEqual(view.overrides, { wall_loops: 3 });
  assert.deepEqual(view.foreign, {});
  assert.deepEqual(
    view.chain.map((entry) => [entry.scope, entry.isTarget]),
    [
      ['project', false],
      ['plate', false],
      ['object', false],
      ['part', true],
    ],
  );
  // The plate's out-of-scope `layer_height` never reaches the chain, so the
  // object's 0.2 wins exactly as it would in the engine.
  assert.deepEqual(view.chain[1].overrides, {});
  assert.equal(view.effectiveConfig.layer_height, 0.2);
  assert.equal(view.effectiveConfig.wall_loops, 3);
  assert.equal(view.effectiveConfig.sparse_infill_density, 15);

  const explained = explainScopedSetting(project.getSnapshot(), target, 'wall_loops');
  assert.equal(explained.value, 3);
  assert.equal(explained.source, 'part');
  assert.deepEqual(
    explained.shadowed.map((entry) => [entry.scope, entry.value]),
    [['object', 2]],
  );
});

test('separates pass-through keys from overrides and writes them back untouched', () => {
  const { fixture, project, bus } = harness();
  const plateId = fixture.state.activePlateId;
  const before = scopedOverrideSnapshot(project.getSnapshot(), { scope: 'plate', plateId });
  assert.deepEqual(before.overrides, {});
  assert.deepEqual(before.foreign, { layer_height: 0.2 });
  assert.equal(before.foreignIssues.length, 1);

  bus.execute(
    new SetScopedOverridesCommand(guardOf(project), { scope: 'plate', plateId }, { print_sequence: 'by object' }),
  );
  const plate = project.getSnapshot().state.plates.find((entry) => entry.id === plateId)!;
  // P1 keeps 3MF round-trips lossless, so a key this scope does not own is
  // preserved rather than tidied away by an unrelated edit.
  assert.deepEqual(plate.config, { layer_height: 0.2, print_sequence: 'by object' });
});

test('treats the submitted map as complete, so an omitted key resets to inherited', () => {
  const { fixture, project, bus } = harness();
  const target = { scope: 'part' as const, volumeId: fixture.object.volumes[0].id };
  bus.execute(new SetScopedOverridesCommand(guardOf(project), target, { sparse_infill_density: 42 }));
  const view = scopedOverrideSnapshot(project.getSnapshot(), target);
  assert.deepEqual(view.overrides, { sparse_infill_density: 42 });
  assert.equal(view.effectiveConfig.wall_loops, 2, 'the part no longer overrides the object');
  assert.equal(view.effectiveConfig.sparse_infill_density, 42);
});

test('is reversible and refuses to author a key the scope does not own', () => {
  const { fixture, project, bus } = harness();
  const target = { scope: 'object' as const, objectId: fixture.object.id };
  const original = canonicalStringify(project.getSnapshot().state);

  bus.execute(new SetScopedOverridesCommand(guardOf(project), target, { layer_height: 0.3, wall_loops: 5 }));
  assert.equal(scopedOverrideSnapshot(project.getSnapshot(), target).effectiveConfig.layer_height, 0.3);
  bus.undo();
  assert.equal(canonicalStringify(project.getSnapshot().state), original);
  bus.redo();
  assert.equal(scopedOverrideSnapshot(project.getSnapshot(), target).effectiveConfig.wall_loops, 5);

  assert.throws(
    () =>
      new SetScopedOverridesCommand(
        guardOf(project),
        { scope: 'part', volumeId: fixture.object.volumes[0].id },
        { brim_type: 'outer_only' },
      ),
    (error: unknown) => error instanceof SettingScopeError && /cannot be set on a part/.test(error.message),
  );
});

test('rejects a stale draft and an unknown node instead of writing somewhere else', () => {
  const { fixture, project, bus } = harness();
  const stale = guardOf(project);
  bus.execute(
    new SetScopedOverridesCommand(
      guardOf(project),
      { scope: 'object', objectId: fixture.object.id },
      { wall_loops: 4 },
    ),
  );
  assert.throws(
    () =>
      bus.execute(
        new SetScopedOverridesCommand(stale, { scope: 'object', objectId: fixture.object.id }, { wall_loops: 6 }),
      ),
    (error: unknown) => error instanceof StaleScopedOverrideError,
  );
  assert.throws(
    () =>
      scopedOverrideSnapshot(project.getSnapshot(), {
        scope: 'plate',
        plateId: entityId<'plate'>('import:test:absent') as PlateId,
      }),
    (error: unknown) => error instanceof UnknownScopedOverrideTargetError,
  );
});

test('routes the project scope to its own base/override/effective triple', () => {
  const { project, bus } = harness();
  const snapshot = project.getSnapshot();
  const update = projectScopeUpdate(snapshot, { sparse_infill_density: 33 });
  assert.equal(update.effectiveConfig.sparse_infill_density, 33);
  assert.equal(update.effectiveConfig.layer_height, 0.24);

  bus.execute(
    new SetProjectSettingsOverridesCommand(
      { sourceRevision: snapshot.revision, sourceHash: snapshot.hash },
      { inheritedConfig: update.inheritedConfig, overrides: update.overrides },
    ),
  );
  const view = scopedOverrideSnapshot(project.getSnapshot(), { scope: 'project' });
  assert.deepEqual(view.overrides, { sparse_infill_density: 33 });
  assert.equal(view.effectiveConfig.sparse_infill_density, 33);

  assert.throws(
    () => projectScopeUpdate(project.getSnapshot(), { not_a_setting: 1 }),
    (error: unknown) => error instanceof SettingScopeError,
  );
});

console.log(`\nScoped setting overrides: ${passed} tests passed.`);
