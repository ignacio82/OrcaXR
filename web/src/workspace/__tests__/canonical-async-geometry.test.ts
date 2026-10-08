/**
 * Helper volumes, magnet holes and adaptive layer heights through the guarded
 * asynchronous session route: new mesh bytes travel as measured staged work,
 * each edit waits for acknowledgement and keeps exact undo, and a queued edit
 * refuses a competing one instead of rebasing.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x6e0)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(20, 20, 20);
  const imported = controller.importBufferGeometry(geometry, { name: 'Block', transform: identityTransform() });
  geometry.dispose();
  controller.selectInstance(imported.instanceId);
  return { controller, imported };
}
const footprint = (controller: CanonicalWorkspaceController) => ({
  summary: controller.getSummary(),
  identity: controller.captureProjectExportGuard(),
});
const volumes = (controller: CanonicalWorkspaceController) =>
  controller['session'].project
    .getSnapshot()
    .state.plates.flatMap((plate) => plate.objects.flatMap((object) => object.volumes.map((volume) => volume.role)));
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('a helper volume and a magnet hole carry their bytes as staged work and undo exactly', async () => {
  const { controller } = setup();
  try {
    const before = footprint(controller);
    const pending = controller.addHelperVolume('support-blocker');
    assert.deepEqual(footprint(controller), before, 'nothing applies before acknowledgement');
    const added = await pending;
    assert.equal(added.role, 'support-blocker');
    assert.deepEqual(volumes(controller), ['model', 'support-blocker']);
    assert.notEqual(controller.captureProjectExportGuard().assetFingerprint, before.identity.assetFingerprint);
    await controller.addMagnetHole({ diameterMm: 6, discHeightMm: 3 });
    assert.deepEqual(volumes(controller), ['model', 'negative-volume', 'support-blocker'], 'Orca role order');
    assert.equal(await controller.undoAsync(), true);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
    assert.equal(await controller.redoAsync(), true);
    assert.deepEqual(volumes(controller), ['model', 'support-blocker']);
  } finally {
    controller.dispose();
  }
});

await test('adaptive layer heights wait for acknowledgement; a competing edit is refused', async () => {
  const { controller } = setup();
  try {
    const before = footprint(controller);
    const pending = controller.applyAdaptiveLayerHeight(0.5);
    assert.deepEqual(footprint(controller), before);
    await pending;
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);

    const competing = controller.addHelperVolume('parameter-modifier');
    controller.setProjectConfig({ edit_probe: 'newer' });
    const newer = footprint(controller);
    await assert.rejects(competing, stale);
    assert.deepEqual(footprint(controller), newer);
    assert.deepEqual(volumes(controller), ['model']);
  } finally {
    controller.dispose();
  }
});

await test('brim ears add, add as a set, remove and clear through acknowledged intents', async () => {
  const { controller, imported } = setup();
  try {
    const ears = () => controller.getBrimEars(imported.objectId);
    const before = footprint(controller);
    const ear = (x: number) => ({ positionMm: [x, 0, -10] as [number, number, number], headFrontRadiusMm: 4 });
    const pending = controller.addBrimEar(imported.objectId, ear(10));
    assert.equal(ears().length, 0, 'nothing applies before acknowledgement');
    await pending;
    await controller.addBrimEars(imported.objectId, [ear(-10), ear(5)]);
    assert.equal(ears().length, 3);
    await controller.removeBrimEar(imported.objectId, 0);
    assert.deepEqual(
      ears().map((placed) => placed.positionMm[0]),
      [-10, 5],
    );
    await controller.clearBrimEars(imported.objectId);
    assert.deepEqual(ears(), []);
    for (let i = 0; i < 4; i++) assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
    await assert.rejects(controller.removeBrimEar(imported.objectId, 7), /ear/i);
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async geometry tests passed: ${passed}`);
