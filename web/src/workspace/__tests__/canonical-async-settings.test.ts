/**
 * Settings commits through the guarded asynchronous session route.
 *
 * The browser's settings panels commit with `applyProjectSettingsOverrides`
 * and `applyScopedOverrides`, which submit the same `setProjectSettingsOverrides`
 * and `setScopedOverrides` intents a native session receives. These cases pin
 * that the async route lands exactly where the synchronous command does, waits
 * for acknowledgement, and refuses what the command refuses before anything is
 * submitted.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform, type ConfigMap } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import {
  SettingScopeError,
  StaleScopedOverrideError,
  UnknownScopedOverrideTargetError,
  type ScopedOverrideTarget,
} from '../../project';
import { StaleProjectSettingsOverrideError } from '../../project/settingsOverrides';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x5e771)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectName: 'Async settings',
    toolCount: 2,
    initialProjectConfig: {
      printable_area: ['0x0', '270x0', '270x270', '0x270'],
      layer_height: 0.24,
      wall_loops: 2,
    },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const imported = controller.importBufferGeometry(geometry, {
    name: 'Cube',
    transform: { ...identityTransform(), translationMm: [20, 0, 20] as const },
  });
  geometry.dispose();
  return { controller, imported };
}
function footprint(controller: CanonicalWorkspaceController) {
  return {
    summary: controller.getSummary(),
    identity: controller.captureProjectExportGuard(),
  };
}
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Every node the fixture exposes, with an in-scope edit for it. */
function edits({
  controller,
  imported,
}: ReturnType<typeof setup>): { target: ScopedOverrideTarget; overrides: ConfigMap }[] {
  const plate = controller.listScopedOverrideTargets().find((option) => option.scope === 'plate');
  assert.ok(plate, 'the fixture has a plate');
  return [
    { target: { scope: 'project' } as ScopedOverrideTarget, overrides: { layer_height: 0.12, wall_loops: 5 } },
    { target: plate.target, overrides: { print_sequence: 'by object' } },
    { target: { scope: 'object', objectId: imported.objectId } as ScopedOverrideTarget, overrides: { wall_loops: 4 } },
    { target: { scope: 'part', volumeId: imported.volumeId } as ScopedOverrideTarget, overrides: { wall_loops: 3 } },
  ];
}

await test('project overrides wait for acknowledgement and land where the command does', async () => {
  const sync = setup();
  const async = setup();
  try {
    const initial = async.controller.getProjectSettingsOverrideSnapshot();
    const update = {
      inheritedConfig: { ...initial.inheritedConfig, layer_height: 0.28 },
      overrides: { layer_height: 0.1, adaptive_probe: { thresholds: [4, 5, 6] } },
    };
    const expected = sync.controller.setProjectSettingsOverrides(
      update,
      sync.controller.getProjectSettingsOverrideSnapshot(),
    );
    const before = footprint(async.controller);
    const pending = async.controller.applyProjectSettingsOverrides(update, initial);
    assert.deepEqual(footprint(async.controller), before, 'nothing applies before acknowledgement');
    const applied = await pending;
    assert.deepEqual(applied, expected);
    assert.equal(Object.isFrozen(applied.effectiveConfig), true);
    const after = footprint(async.controller);
    assert.deepEqual(after.identity, footprint(sync.controller).identity);
    assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
    assert.equal(after.summary.history.undoLabel, 'Update project setting overrides');
    assert.equal(await async.controller.undoAsync(), true);
    assert.equal(async.controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
    assert.equal(await async.controller.redoAsync(), true);
    assert.equal(async.controller.captureProjectExportGuard().semanticHash, after.identity.semanticHash);
  } finally {
    sync.controller.dispose();
    async.controller.dispose();
  }
});

await test('scoped overrides on every scope match the synchronous command exactly', async () => {
  const sync = setup();
  const async = setup();
  try {
    const syncEdits = edits(sync);
    for (const [i, edit] of edits(async).entries()) {
      const label = edit.target.scope;
      const expected = sync.controller.setScopedOverrides(
        syncEdits[i].target,
        syncEdits[i].overrides,
        sync.controller.getScopedOverrideSnapshot(syncEdits[i].target),
      );
      const before = footprint(async.controller);
      const pending = async.controller.applyScopedOverrides(
        edit.target,
        edit.overrides,
        async.controller.getScopedOverrideSnapshot(edit.target),
      );
      assert.deepEqual(footprint(async.controller), before, `${label} waits for acknowledgement`);
      assert.deepEqual(await pending, expected, `${label} snapshot`);
      assert.deepEqual(footprint(async.controller).identity, footprint(sync.controller).identity, `${label} project`);
      assert.equal(async.controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);
    }
    for (const edit of edits(async)) {
      const node = async.controller.getScopedOverrideSnapshot(edit.target);
      for (const [key, value] of Object.entries(edit.overrides)) {
        assert.deepEqual(node.overrides[key], value, `${edit.target.scope} ${key}`);
      }
    }
  } finally {
    sync.controller.dispose();
    async.controller.dispose();
  }
});

await test('refuses a stale guard, an unknown node or an out-of-scope key before submitting anything', async () => {
  const s = setup();
  try {
    const project = s.controller.getProjectSettingsOverrideSnapshot();
    const object = { scope: 'object', objectId: s.imported.objectId } as const;
    const objectGuard = s.controller.getScopedOverrideSnapshot(object);
    s.controller.setProjectConfig({ ...project.inheritedConfig, wall_loops: 6 });
    const before = footprint(s.controller);
    await assert.rejects(
      s.controller.applyProjectSettingsOverrides({ inheritedConfig: project.inheritedConfig, overrides: {} }, project),
      StaleProjectSettingsOverrideError,
    );
    await assert.rejects(
      s.controller.applyScopedOverrides(object, { wall_loops: 4 }, objectGuard),
      StaleScopedOverrideError,
    );
    const plate = edits(s)[1].target;
    await assert.rejects(
      s.controller.applyScopedOverrides(plate, { wall_loops: 4 }, s.controller.getScopedOverrideSnapshot(plate)),
      (error: unknown) => error instanceof SettingScopeError && /cannot be set on a plate/.test(error.message),
    );
    const guard = s.controller.getProjectSettingsOverrideSnapshot();
    await assert.rejects(
      s.controller.applyScopedOverrides(
        { scope: 'object', objectId: entityId<'object'>('import:missing:object') },
        { wall_loops: 4 },
        guard,
      ),
      (error: unknown) =>
        error instanceof UnknownScopedOverrideTargetError &&
        /No object node matches import:missing:object/.test(error.message),
    );
    assert.deepEqual(footprint(s.controller), before);
  } finally {
    s.controller.dispose();
  }
});

await test('a queued settings commit refuses a competing edit instead of rebasing', async () => {
  for (const scope of ['project', 'object'] as const) {
    const s = setup();
    try {
      const target: ScopedOverrideTarget = scope === 'project' ? { scope } : { scope, objectId: s.imported.objectId };
      const pending = s.controller.applyScopedOverrides(
        target,
        { wall_loops: 4 },
        s.controller.getScopedOverrideSnapshot(target),
      );
      s.controller.setProjectConfig({ edit_probe: 'newer' });
      const newer = footprint(s.controller);
      await assert.rejects(pending, stale);
      assert.deepEqual(footprint(s.controller), newer, `${scope} leaves the newer project alone`);
    } finally {
      s.controller.dispose();
    }
  }
});

console.log(`canonical async settings tests passed: ${passed}`);
