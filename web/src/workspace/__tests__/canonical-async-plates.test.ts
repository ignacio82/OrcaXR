import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { seededRandom, UuidIdSource, type PlateId } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function createController() {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x71a7e)),
    clock: () => '2026-10-05T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
}

async function setup() {
  const controller = createController();
  const first = controller.getSummary().activePlateId;
  const second = await controller.addPlate('Second', { activate: false });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const model = controller.importBufferGeometry(geometry, { name: 'Source' });
  geometry.dispose();
  return { controller, first, second, model };
}

function footprint(controller: CanonicalWorkspaceController) {
  return {
    summary: controller.getSummary(),
    identity: controller.captureProjectExportGuard(),
    tree: controller.getObjectsTree(),
  };
}

const operations = {
  add: (controller: CanonicalWorkspaceController, _first: PlateId, _second: PlateId) => controller.addPlate(),
  duplicate: (controller: CanonicalWorkspaceController, first: PlateId, _second: PlateId) =>
    controller.duplicatePlate(first),
  delete: (controller: CanonicalWorkspaceController, _first: PlateId, second: PlateId) =>
    controller.deletePlate(second),
  activate: (controller: CanonicalWorkspaceController, _first: PlateId, second: PlateId) =>
    controller.activatePlate(second),
  rename: (controller: CanonicalWorkspaceController, first: PlateId, _second: PlateId) =>
    controller.renamePlate(first, 'Renamed'),
  reorder: (controller: CanonicalWorkspaceController, first: PlateId, second: PlateId) =>
    controller.reorderPlates([second, first]),
  printable: (controller: CanonicalWorkspaceController, first: PlateId, _second: PlateId) =>
    controller.setPlatePrintable(first, false),
};

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

for (const [name, operation] of Object.entries(operations)) {
  await test(`${name} waits for the session, commits once, and preserves exact undo/redo`, async () => {
    const { controller, first, second } = await setup();
    try {
      const before = footprint(controller);
      const pending = operation(controller, first, second);
      assert.deepEqual(footprint(controller), before, 'submitting an edit must not commit it synchronously');
      await pending;
      const after = footprint(controller);
      assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
      assert.equal(after.identity.assetFingerprint, before.identity.assetFingerprint);
      assert.equal(await controller.undoAsync(), true);
      const undone = footprint(controller);
      assert.deepEqual(undone.summary.plates, before.summary.plates);
      assert.equal(undone.summary.activePlateId, before.summary.activePlateId);
      assert.equal(undone.identity.semanticHash, before.identity.semanticHash);
      assert.deepEqual(undone.tree.selection, before.tree.selection);
      assert.equal(await controller.redoAsync(), true);
      assert.equal(controller.captureProjectExportGuard().semanticHash, after.identity.semanticHash);
      assert.deepEqual(controller.getSummary().plates, after.summary.plates);
    } finally {
      controller.dispose();
    }
  });

  for (const drift of ['edit', 'checkpoint', 'reset'] as const) {
    await test(`${name} rejects ${drift} while queued and preserves the newer authority`, async () => {
      const { controller, first, second, model } = await setup();
      try {
        const pending = operation(controller, first, second);
        if (drift === 'edit') controller.renameObject(model.objectId, 'Newer edit');
        else if (drift === 'checkpoint') controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
        else controller.resetProject();
        const changed = footprint(controller);
        await assert.rejects(pending, (error) => error instanceof AsyncSessionError && error.code === 'stale');
        assert.deepEqual(footprint(controller), changed);
      } finally {
        controller.dispose();
      }
    });
  }

  await test(`${name} rejects pending work when its owner is disposed`, async () => {
    const { controller, first, second } = await setup();
    const pending = operation(controller, first, second);
    controller.dispose();
    await assert.rejects(pending, (error) => error instanceof AsyncSessionError && error.code === 'disposed');
  });
}

await test('all exact plate no-ops preserve selection, history, dirty state and revision', async () => {
  const { controller, first, second, model } = await setup();
  try {
    controller.selectInstance(model.instanceId);
    controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
    const before = footprint(controller);
    await controller.activatePlate(first);
    await controller.renamePlate(first, before.summary.plates[0].name);
    await controller.reorderPlates([first, second]);
    await controller.setPlatePrintable(first, true);
    assert.deepEqual(footprint(controller), before);
    const pending = controller.activatePlate(first);
    controller.renameObject(model.objectId, 'No-op source changed');
    await assert.rejects(pending, (error) => error instanceof AsyncSessionError && error.code === 'stale');
  } finally {
    controller.dispose();
  }
});

await test('captures the requested order and refuses competing requests from the same revision', async () => {
  const { controller, first, second } = await setup();
  try {
    const order = [second, first];
    const pending = controller.reorderPlates(order);
    order.reverse();
    await pending;
    assert.deepEqual(
      controller.getSummary().plates.map((plate) => plate.id),
      [second, first],
    );
    const rename = controller.renamePlate(first, 'First accepted');
    const duplicate = controller.duplicatePlate(first);
    await rename;
    await assert.rejects(duplicate, (error) => error instanceof AsyncSessionError && error.code === 'stale');
    assert.equal(controller.getSummary().plates.length, 2);
    const copy = await controller.duplicatePlate(first);
    assert.equal(controller.getSummary().activePlateId, copy);
    assert.equal(controller.getSummary().plates.find((plate) => plate.id === copy)?.instanceCount, 1);
  } finally {
    controller.dispose();
  }
});

await test('displayed revision, invalid names and last-plate protection reject without edits', async () => {
  const controller = createController();
  try {
    const before = footprint(controller);
    const first = before.summary.activePlateId;
    await assert.rejects(controller.deletePlate(first), /last plate/);
    await assert.rejects(controller.renamePlate(first, '  '), /cannot be empty/);
    await assert.rejects(controller.renamePlate(first, 'Late', before.summary.revision + 1), /stale/);
    await assert.rejects(controller.setPlatePrintable(first, false, Number.NaN), /safe integer/);
    assert.deepEqual(footprint(controller), before);
  } finally {
    controller.dispose();
  }
});

await test('activation receipts expire on history, edits, owner replacement and disposal', async () => {
  const { controller, first, second, model } = await setup();
  const other = createController();
  try {
    const receipt = await controller.activatePlate(second);
    assert.equal(controller.isSessionGuardCurrent(receipt.guard), true);
    assert.equal(other.isSessionGuardCurrent(receipt.guard), false);
    controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
    assert.equal(controller.isSessionGuardCurrent(receipt.guard), false);
    const checkpoint = await controller.activatePlate(second);
    assert.equal(controller.isSessionGuardCurrent(checkpoint.guard), true);
    controller.renameObject(model.objectId, 'Newer edit');
    assert.equal(controller.isSessionGuardCurrent(checkpoint.guard), false);
    const edited = await controller.activatePlate(first);
    controller.resetProject();
    assert.equal(controller.isSessionGuardCurrent(edited.guard), false);
    const reset = await controller.activatePlate(controller.getSummary().activePlateId);
    controller.dispose();
    assert.equal(controller.isSessionGuardCurrent(reset.guard), false);
  } finally {
    controller.dispose();
    other.dispose();
  }
});

await test('preserves the distinct existing add and rename name limits', async () => {
  const controller = createController();
  try {
    const plate = await controller.addPlate('a'.repeat(160));
    assert.equal(controller.getSummary().plates.find((item) => item.id === plate)?.name, 'a'.repeat(160));
    await assert.rejects(controller.addPlate('b'.repeat(161)), /160/);
    await controller.renamePlate(plate, 'r'.repeat(120));
    await assert.rejects(controller.renamePlate(plate, 'r'.repeat(121)), /120/);
    await controller.undoAsync();
    assert.equal(controller.getSummary().plates.find((item) => item.id === plate)?.name, 'a'.repeat(160));
  } finally {
    controller.dispose();
  }
});

console.log(`\nAsynchronous plate commands: ${passed} tests passed.`);
