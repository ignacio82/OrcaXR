import assert from 'node:assert/strict';

import {
  Bbs3mfProjectSerializer,
  CommandBus,
  InMemoryAssetRepository,
  ORCAXR_EXTENSION_PATH,
  ProjectStore,
  SelectionStore,
  SetProjectSettingsOverridesCommand,
  applyProjectSettingsOverrides,
  canonicalStringify,
  cloneProjectState,
  projectFingerprint,
  projectSettingsOverrideSnapshot,
  readSafeZip,
  validateProjectState,
  writeDeterministicZip,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function commandHarness() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, project, bus };
}

await test('normalizes legacy states as inherited config plus empty frozen overrides without changing their hash', () => {
  const fixture = createProjectFixture();
  assert.equal(Object.hasOwn(fixture.state, 'settingsBaseConfig'), false);
  assert.equal(Object.hasOwn(fixture.state, 'settingsOverrides'), false);
  assert.deepEqual(validateProjectState(fixture.state), []);

  const project = new ProjectStore(fixture.state);
  const before = project.getSnapshot();
  const adapter = projectSettingsOverrideSnapshot(before);
  assert.deepEqual(adapter.inheritedConfig, fixture.state.config);
  assert.deepEqual(adapter.overrides, {});
  assert.deepEqual(adapter.effectiveConfig, fixture.state.config);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.inheritedConfig), true);
  assert.equal(Object.isFrozen(adapter.overrides), true);
  assert.equal(project.getSnapshot().hash, before.hash);
  assert.equal(Object.hasOwn(project.getSnapshot().state, 'settingsBaseConfig'), false);
  assert.equal(Object.hasOwn(project.getSnapshot().state, 'settingsOverrides'), false);
});

await test('updates base, overrides, and effective config as one exact reversible command', () => {
  const { project, bus } = commandHarness();
  const before = project.getSnapshot();
  const beforeBytes = canonicalStringify(before.state);
  const inheritedConfig = {
    ...before.state.config,
    layer_height: 0.24,
    tuning_curve: { points: [1, 2, 3] },
  };
  const overrides = {
    layer_height: 0.1,
    tuning_curve: { points: [4, 5, 6] },
  };
  const command = new SetProjectSettingsOverridesCommand(
    { sourceRevision: before.revision, sourceHash: before.hash },
    { inheritedConfig, overrides },
  );
  inheritedConfig.layer_height = 0.3;
  overrides.layer_height = 0.08;
  overrides.tuning_curve.points[0] = 99;

  bus.execute(command);
  const applied = project.getSnapshot();
  assert.equal(applied.revision, before.revision + 1);
  assert.deepEqual(applied.state.settingsBaseConfig?.layer_height, 0.24);
  assert.deepEqual(applied.state.settingsOverrides?.layer_height, 0.1);
  assert.deepEqual(applied.state.settingsOverrides?.tuning_curve, { points: [4, 5, 6] });
  assert.deepEqual(applied.state.config.layer_height, 0.1);
  assert.deepEqual(applied.state.config.tuning_curve, { points: [4, 5, 6] });
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.equal(bus.getHistorySnapshot().undoLabel, 'Update project setting overrides');

  const beforeNoop = project.getSnapshot();
  const historyBeforeNoop = bus.getHistorySnapshot();
  bus.execute(
    new SetProjectSettingsOverridesCommand(
      { sourceRevision: beforeNoop.revision, sourceHash: beforeNoop.hash },
      {
        inheritedConfig: beforeNoop.state.settingsBaseConfig!,
        overrides: beforeNoop.state.settingsOverrides!,
      },
    ),
  );
  assert.deepEqual(project.getSnapshot(), beforeNoop);
  assert.deepEqual(bus.getHistorySnapshot(), historyBeforeNoop);

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), beforeBytes);
  assert.equal(Object.hasOwn(project.getSnapshot().state, 'settingsBaseConfig'), false);
  assert.equal(Object.hasOwn(project.getSnapshot().state, 'settingsOverrides'), false);
  assert.equal(bus.redo(), true);
  assert.deepEqual(project.getSnapshot().state.settingsBaseConfig?.layer_height, 0.24);
  assert.deepEqual(project.getSnapshot().state.settingsOverrides?.layer_height, 0.1);
  assert.deepEqual(project.getSnapshot().state.config.layer_height, 0.1);
});

await test('validates canonical settings shape and the base-plus-overrides invariant', () => {
  const fixture = createProjectFixture();
  const missingBase = cloneProjectState(fixture.state);
  missingBase.settingsOverrides = { layer_height: 0.1 };
  missingBase.config.layer_height = 0.1;
  assert.ok(validateProjectState(missingBase).some((issue) => issue.code === 'missing-settings-base-config'));

  const mismatched = cloneProjectState(fixture.state);
  mismatched.settingsBaseConfig = cloneProjectState(fixture.state).config;
  mismatched.settingsOverrides = { layer_height: 0.1 };
  assert.ok(validateProjectState(mismatched).some((issue) => issue.code === 'mismatched-effective-settings-config'));

  const snapshot = new ProjectStore(fixture.state).getSnapshot();
  const guard = { sourceRevision: snapshot.revision, sourceHash: snapshot.hash };
  assert.throws(
    () =>
      new SetProjectSettingsOverridesCommand(guard, {
        inheritedConfig: { layer_height: Number.POSITIVE_INFINITY },
        overrides: {},
      }),
    /finite canonical JSON/,
  );
  assert.throws(
    () =>
      new SetProjectSettingsOverridesCommand(guard, {
        inheritedConfig: fixture.state.config,
        overrides: { '   ': 1 },
      }),
    /empty key/,
  );
});

await test('round-trips inherited settings and restores them when an override is removed after reopen', async () => {
  const fixture = createProjectFixture();
  const inheritedConfig = { ...fixture.state.config, layer_height: 0.24, override_probe: 'inherited' };
  const overrides = { layer_height: 0.1, override_probe: 'explicit' };
  fixture.state.settingsBaseConfig = inheritedConfig;
  fixture.state.settingsOverrides = overrides;
  fixture.state.config = applyProjectSettingsOverrides(inheritedConfig, overrides);
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 3,
    sourceHash: projectFingerprint(fixture.state),
  });
  const files = readSafeZip(saved.bytes);
  const standardSettings = JSON.parse(text(files.get('Metadata/project_settings.config')!)) as Record<string, unknown>;
  // BBS project settings are string-valued: the engine's JSON config reader
  // accepts strings only. The canonical numeric override survives in the
  // OrcaXR extension, which the assertions below check.
  assert.equal(standardSettings.layer_height, '0.1');
  assert.equal(standardSettings.override_probe, 'explicit');
  assert.equal(Object.hasOwn(standardSettings, 'settingsBaseConfig'), false);
  assert.equal(Object.hasOwn(standardSettings, 'settingsOverrides'), false);

  const reopened = await serializer.deserialize(saved.bytes);
  assert.deepEqual(reopened.state.settingsBaseConfig, inheritedConfig);
  assert.deepEqual(reopened.state.settingsOverrides, overrides);
  assert.deepEqual(reopened.state.config, applyProjectSettingsOverrides(inheritedConfig, overrides));

  const project = new ProjectStore(reopened.state);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  const adapter = projectSettingsOverrideSnapshot(project.getSnapshot());
  bus.execute(
    new SetProjectSettingsOverridesCommand(adapter, {
      inheritedConfig: adapter.inheritedConfig,
      overrides: {},
    }),
  );
  assert.deepEqual(project.getSnapshot().state.config.layer_height, 0.24);
  assert.deepEqual(project.getSnapshot().state.config.override_probe, 'inherited');
  assert.deepEqual(project.getSnapshot().state.settingsOverrides, {});

  const cleared = await serializer.serialize({
    state: project.getSnapshot().state,
    assets: [fixture.asset],
    sourceRevision: project.getSnapshot().revision,
    sourceHash: project.getSnapshot().hash,
  });
  const reopenedCleared = await serializer.deserialize(cleared.bytes);
  assert.deepEqual(reopenedCleared.state.settingsBaseConfig, inheritedConfig);
  assert.deepEqual(reopenedCleared.state.settingsOverrides, {});
  assert.equal(reopenedCleared.state.config.layer_height, 0.24);

  files.delete(ORCAXR_EXTENSION_PATH);
  const foreign = await serializer.deserialize(writeDeterministicZip(files));
  assert.equal(Object.hasOwn(foreign.state, 'settingsBaseConfig'), false);
  assert.equal(Object.hasOwn(foreign.state, 'settingsOverrides'), false);
  const foreignAdapter = projectSettingsOverrideSnapshot(new ProjectStore(foreign.state).getSnapshot());
  assert.deepEqual(foreignAdapter.overrides, {});
  // Without the extension this is an ordinary foreign BBS project, so the
  // value arrives in the engine's own string form.
  assert.equal(foreignAdapter.inheritedConfig.layer_height, '0.1');
  assert.equal(foreignAdapter.effectiveConfig.override_probe, 'explicit');
});

console.log(`settings override tests passed: ${passed}`);

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
