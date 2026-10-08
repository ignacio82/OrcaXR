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

await test('an SVG part is cut, re-cut and undone through acknowledged staged work', async () => {
  const { controller, imported } = setup();
  try {
    const drawing =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="6"/></svg>';
    const before = footprint(controller);
    const pending = controller.addSvgPart(imported.objectId, drawing, { fileName: 'badge.svg', depthMm: 1 });
    assert.deepEqual(footprint(controller), before, 'nothing applies before acknowledgement');
    const { volumeId } = await pending;
    assert.ok(volumes(controller).length === 2);
    const afterAdd = footprint(controller);
    const recut = await controller.editSvgPart(volumeId, drawing, { fileName: 'badge.svg', depthMm: 2 });
    assert.ok(recut.mesh.triangleCount > 0);
    assert.notEqual(controller.captureProjectExportGuard().semanticHash, afterAdd.identity.semanticHash);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, afterAdd.identity.semanticHash);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

await test('a mesh import commits its object and bytes as staged work, reusing identical bytes', async () => {
  const { controller } = setup();
  try {
    const before = footprint(controller);
    const geometry = new THREE.BoxGeometry(12, 12, 12);
    const pending = controller.importGeometry(geometry, { name: 'Imported' });
    assert.deepEqual(footprint(controller), before, 'nothing applies before acknowledgement');
    const first = await pending;
    assert.equal(first.reusedAsset, false);
    assert.equal(controller.getSummary().objectCount, before.summary.objectCount + 1);
    const second = await controller.importGeometry(geometry, { name: 'Imported again' });
    geometry.dispose();
    assert.equal(second.reusedAsset, true, 'identical mesh bytes are stored once');
    assert.equal(second.assetId, first.assetId);
    assert.equal(controller.getSummary().objectCount, before.summary.objectCount + 2);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

await test('settled resolves after every queued edit, applied or refused, so captures hold them', async () => {
  const { controller } = setup();
  try {
    const order: string[] = [];
    const record = (label: string) => (outcome: unknown) =>
      order.push(outcome instanceof Error ? `${label} ${stale(outcome) ? 'refused' : 'failed'}` : label);
    // Refused: a newer edit replaces the state it was guarded on.
    const refused = controller.addHelperVolume('support-blocker').then(record('helper'), record('helper'));
    controller.setProjectConfig({ edit_probe: 'newer' });
    const applied = controller
      .addMagnetHole({ diameterMm: 6, discHeightMm: 3 })
      .then(record('magnet'), record('magnet'));
    await controller.settled();
    // The commits are acknowledged in order; a caller's own continuation may
    // run later, but a capture taken now holds the applied edit.
    assert.deepEqual(volumes(controller), ['model', 'negative-volume'], 'a capture now holds the applied edit');
    order.push('settled');
    await Promise.all([refused, applied]);
    assert.deepEqual(order.sort(), ['helper refused', 'magnet', 'settled']);
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async geometry tests passed: ${passed}`);
