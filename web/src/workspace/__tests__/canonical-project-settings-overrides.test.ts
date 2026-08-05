import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { EntityId, IdSource } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { StaleProjectSettingsOverrideError } from '../../project/settingsOverrides';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

const NOW = '2026-07-23T12:00:00.000Z';
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    const id = `import:settings-controller-test:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    return id;
  }
}

function createController(): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectName: 'Settings fixture',
    toolCount: 2,
    initialProjectConfig: {
      printable_area: ['0x0', '270x0', '270x270', '0x270'],
      layer_height: 0.24,
      wall_loops: 2,
    },
    projectImportParser: new BbsProjectImportParser(),
  });
}

await test('guards one canonical base/override update with frozen snapshots, exact no-op, undo, and redo', () => {
  const controller = createController();
  const initial = controller.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(initial.overrides, {});
  assert.deepEqual(initial.inheritedConfig, initial.effectiveConfig);
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.inheritedConfig), true);
  assert.equal(Object.isFrozen(initial.overrides), true);

  const inheritedConfig = {
    ...initial.inheritedConfig,
    layer_height: 0.24,
    adaptive_probe: { thresholds: [1, 2, 3] },
  };
  const overrides = {
    layer_height: 0.1,
    adaptive_probe: { thresholds: [4, 5, 6] },
  };
  const beforeApply = controller.getSummary();
  const applied = controller.setProjectSettingsOverrides({ inheritedConfig, overrides }, initial);
  const appliedSummary = controller.getSummary();
  assert.equal(applied.sourceRevision, initial.sourceRevision + 1);
  assert.equal(applied.sourceRevision, appliedSummary.revision);
  assert.equal(applied.sourceHash, appliedSummary.projectHash);
  assert.equal(appliedSummary.history.undoCount, beforeApply.history.undoCount + 1);
  assert.equal(appliedSummary.history.undoLabel, 'Update project setting overrides');
  assert.equal(applied.inheritedConfig.layer_height, 0.24);
  assert.equal(applied.overrides.layer_height, 0.1);
  assert.equal(applied.effectiveConfig.layer_height, 0.1);
  assert.deepEqual(applied.effectiveConfig.adaptive_probe, { thresholds: [4, 5, 6] });
  assert.equal(Object.isFrozen(applied.effectiveConfig), true);
  assert.equal(Object.isFrozen(applied.effectiveConfig.adaptive_probe as object), true);
  assert.equal(
    Object.isFrozen((applied.effectiveConfig.adaptive_probe as { readonly thresholds: readonly number[] }).thresholds),
    true,
  );

  inheritedConfig.layer_height = 0.3;
  overrides.layer_height = 0.08;
  overrides.adaptive_probe.thresholds[0] = 99;
  assert.equal(controller.getProjectSettingsOverrideSnapshot().inheritedConfig.layer_height, 0.24);
  assert.deepEqual(controller.getProjectSettingsOverrideSnapshot().overrides.adaptive_probe, {
    thresholds: [4, 5, 6],
  });

  const beforeNoop = controller.getSummary();
  const noOp = controller.setProjectSettingsOverrides(
    { inheritedConfig: applied.inheritedConfig, overrides: applied.overrides },
    applied,
  );
  assert.deepEqual(controller.getSummary(), beforeNoop);
  assert.deepEqual(noOp, applied);

  const beforeStale = controller.getSummary();
  assert.throws(
    () =>
      controller.setProjectSettingsOverrides(
        { inheritedConfig: initial.inheritedConfig, overrides: { layer_height: 0.12 } },
        initial,
      ),
    StaleProjectSettingsOverrideError,
  );
  assert.deepEqual(controller.getSummary(), beforeStale);

  assert.equal(controller.undo(), true);
  const undone = controller.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(undone.overrides, {});
  assert.equal(undone.effectiveConfig.layer_height, 0.24);
  assert.deepEqual(undone.inheritedConfig, undone.effectiveConfig);
  assert.equal(controller.redo(), true);
  const redone = controller.getProjectSettingsOverrideSnapshot();
  assert.equal(redone.inheritedConfig.layer_height, 0.24);
  assert.equal(redone.overrides.layer_height, 0.1);
  assert.equal(redone.effectiveConfig.layer_height, 0.1);

  const beforeInvalid = controller.getSummary();
  assert.throws(
    () =>
      controller.setProjectSettingsOverrides({ inheritedConfig: { layer_height: Number.NaN }, overrides: {} }, redone),
    /finite canonical JSON/,
  );
  assert.deepEqual(controller.getSummary(), beforeInvalid);
  controller.dispose();
});

await test('restores distinct inherited values and lets profile application preserve, replace, or clear overrides', () => {
  const controller = createController();
  const initial = controller.getProjectSettingsOverrideSnapshot();
  const overridden = controller.setProjectSettingsOverrides(
    {
      inheritedConfig: initial.inheritedConfig,
      overrides: { layer_height: 0.1 },
    },
    initial,
  );
  assert.equal(overridden.inheritedConfig.layer_height, 0.24);
  assert.equal(overridden.effectiveConfig.layer_height, 0.1);

  const cleared = controller.setProjectSettingsOverrides(
    { inheritedConfig: overridden.inheritedConfig, overrides: {} },
    overridden,
  );
  assert.equal(cleared.inheritedConfig.layer_height, 0.24);
  assert.equal(cleared.effectiveConfig.layer_height, 0.24);
  assert.deepEqual(cleared.overrides, {});
  assert.equal(controller.undo(), true);
  assert.equal(controller.getProjectSettingsOverrideSnapshot().effectiveConfig.layer_height, 0.1);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getProjectSettingsOverrideSnapshot().effectiveConfig.layer_height, 0.24);

  const current = controller.getProjectSettingsOverrideSnapshot();
  controller.setProjectSettingsOverrides(
    { inheritedConfig: current.inheritedConfig, overrides: { layer_height: 0.1 } },
    current,
  );
  const slicing = controller.getSlicingConfiguration();
  assert.equal(slicing.config.layer_height, 0.24, 'slicing configuration exposes the inherited base');
  assert.deepEqual(slicing.settingsOverrides, { layer_height: 0.1 });
  controller.setSlicingConfiguration({
    printer: slicing.printer,
    config: {
      printable_area: ['0x0', '300x0', '300x300', '0x300'],
      layer_height: 0.3,
      wall_loops: 4,
    },
    filaments: slicing.filaments,
  });
  const preserved = controller.getProjectSettingsOverrideSnapshot();
  assert.equal(preserved.inheritedConfig.layer_height, 0.3);
  assert.equal(preserved.overrides.layer_height, 0.1);
  assert.equal(preserved.effectiveConfig.layer_height, 0.1);
  assert.equal(preserved.effectiveConfig.wall_loops, 4);

  const afterPreserve = controller.getSlicingConfiguration();
  controller.setSlicingConfiguration({
    ...afterPreserve,
    config: { ...afterPreserve.config, layer_height: 0.32, wall_loops: 5 },
    settingsOverrides: { wall_loops: 7 },
  });
  const replaced = controller.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(replaced.overrides, { wall_loops: 7 });
  assert.equal(replaced.inheritedConfig.layer_height, 0.32);
  assert.equal(replaced.inheritedConfig.wall_loops, 5);
  assert.equal(replaced.effectiveConfig.layer_height, 0.32);
  assert.equal(replaced.effectiveConfig.wall_loops, 7);

  const beforeBaseOnlyChange = controller.getSummary();
  controller.setProjectConfig({ ...replaced.inheritedConfig, wall_loops: 6 });
  const changedBase = controller.getProjectSettingsOverrideSnapshot();
  assert.equal(changedBase.sourceRevision, beforeBaseOnlyChange.revision + 1);
  assert.equal(changedBase.inheritedConfig.wall_loops, 6);
  assert.equal(changedBase.effectiveConfig.wall_loops, 7);
  const restoredNewBase = controller.setProjectSettingsOverrides(
    { inheritedConfig: changedBase.inheritedConfig, overrides: {} },
    changedBase,
  );
  assert.equal(restoredNewBase.effectiveConfig.wall_loops, 6);

  const clearSlicing = controller.getSlicingConfiguration();
  controller.setSlicingConfiguration({
    ...clearSlicing,
    config: { ...clearSlicing.config, layer_height: 0.36 },
    settingsOverrides: {},
  });
  const explicitlyCleared = controller.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(explicitlyCleared.overrides, {});
  assert.equal(explicitlyCleared.inheritedConfig.layer_height, 0.36);
  assert.equal(explicitlyCleared.effectiveConfig.layer_height, 0.36);
  const beforeNoop = controller.getSummary();
  controller.setSlicingConfiguration(controller.getSlicingConfiguration());
  assert.deepEqual(controller.getSummary(), beforeNoop);
  controller.dispose();
});

await test('retains canonical inherited and override maps across controller save and reopen', async () => {
  const source = createController();
  const initial = source.getProjectSettingsOverrideSnapshot();
  const applied = source.setProjectSettingsOverrides(
    {
      inheritedConfig: { ...initial.inheritedConfig, layer_height: 0.22 },
      overrides: { layer_height: 0.09, wall_loops: 5 },
    },
    initial,
  );
  const saved = await source.saveCanonical3mf();
  const reopened = createController();
  await reopened.openCanonical3mf(saved.bytes);
  const restored = reopened.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(restored.inheritedConfig, applied.inheritedConfig);
  assert.deepEqual(restored.overrides, applied.overrides);
  assert.deepEqual(restored.effectiveConfig, applied.effectiveConfig);

  const cleared = reopened.setProjectSettingsOverrides(
    { inheritedConfig: restored.inheritedConfig, overrides: {} },
    restored,
  );
  assert.equal(cleared.effectiveConfig.layer_height, 0.22);
  assert.equal(cleared.effectiveConfig.wall_loops, 2);
  source.dispose();
  reopened.dispose();
});

console.log(`canonical project settings override tests passed: ${passed}`);
