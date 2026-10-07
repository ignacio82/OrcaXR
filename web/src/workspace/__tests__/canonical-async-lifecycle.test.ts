import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import {
  LocalProjectSessionTransport,
  ProjectReceiptUnavailableError,
} from '../../project/LocalProjectSessionTransport';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

async function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x17ecaf)),
    clock: () => '2026-10-06T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const first = controller.importBufferGeometry(geometry, { name: 'First', transform: identityTransform() });
  const second = controller.importBufferGeometry(geometry, { name: 'Second', transform: identityTransform() });
  geometry.dispose();
  const plate = controller.getSummary().activePlateId;
  const destination = await controller.addPlate('Destination');
  await controller.activatePlate(plate);
  controller.selectInstance(first.instanceId);
  const extra = (await controller.duplicateSelectedInstance())!;
  controller.selectInstance(first.instanceId);
  const transport = (controller as unknown as { sessionTransport: LocalProjectSessionTransport }).sessionTransport;
  return { controller, transport, first, second, extra, plate, destination };
}
function footprint(controller: CanonicalWorkspaceController) {
  return {
    summary: controller.getSummary(),
    identity: controller.captureProjectExportGuard(),
    tree: controller.getObjectsTree(),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const operations = {
  instanceDelete: ({ controller, first }: Fixture) => controller.deleteInstance(first.instanceId),
  objectDelete: ({ controller, second }: Fixture) => controller.deleteInstance(second.instanceId),
  selectedDelete: ({ controller }: Fixture) => controller.deleteSelectedInstance(),
  clearPlate: ({ controller }: Fixture) => controller.deleteAllObjectsOnPlate(),
  duplicate: ({ controller }: Fixture) => controller.duplicateSelectedObject(),
  move: ({ controller, first, destination }: Fixture) => controller.moveObjectToPlate(first.objectId, destination),
  convert: ({ controller, first }: Fixture) => controller.convertInstanceToIndependentObject(first.instanceId),
  cut: ({ controller }: Fixture) => controller.cutSelectedObject(),
};
for (const [name, operation] of Object.entries(operations)) {
  await test(`${name} queues one guarded intent and preserves exact undo/redo and assets`, async () => {
    const s = await setup();
    const { controller, transport } = s;
    try {
      const before = footprint(controller);
      const original = transport.executeIntent.bind(transport);
      let calls = 0;
      transport.executeIntent = (...args) => {
        calls++;
        assert.ok(args[1]?.guard);
        return original(...args);
      };
      const pending = operation(s);
      assert.deepEqual(footprint(controller), before);
      await pending;
      assert.equal(calls, 1);
      const after = footprint(controller);
      assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
      assert.equal(after.identity.assetFingerprint, before.identity.assetFingerprint);
      await controller.undoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      assert.deepEqual(controller.getObjectsTree().selection, before.tree.selection);
      await controller.redoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, after.identity.semanticHash);
      assert.deepEqual(controller.getObjectsTree().selection, after.tree.selection);
    } finally {
      controller.dispose();
    }
  });
  for (const drift of ['edit', 'checkpoint', 'reset', 'dispose'] as const) {
    await test(`${name} rejects queued ${drift} without rebasing the captured target`, async () => {
      const s = await setup();
      const { controller } = s;
      try {
        const pending = operation(s);
        if (drift === 'edit') controller.setProjectConfig({ lifecycle_probe: 'newer' });
        if (drift === 'checkpoint') controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
        if (drift === 'reset') controller.resetProject();
        if (drift === 'dispose') controller.dispose();
        const newer = drift === 'dispose' ? undefined : footprint(controller);
        await assert.rejects(pending, drift === 'dispose' ? { code: 'disposed' } : stale);
        if (newer) assert.deepEqual(footprint(controller), newer);
      } finally {
        controller.dispose();
      }
    });
  }
  for (const unavailable of [false, true]) {
    await test(`${name} preserves committed work and never retries a ${unavailable ? 'summary overflow' : 'lost reply'}`, async () => {
      const s = await setup();
      const { controller, transport } = s;
      try {
        const before = footprint(controller);
        const original = transport.executeIntent.bind(transport);
        const failure = unavailable ? new ProjectReceiptUnavailableError(true) : new Error('Lost lifecycle receipt');
        let calls = 0;
        transport.executeIntent = async (...args) => {
          calls++;
          await original(...args);
          throw failure;
        };
        await assert.rejects(operation(s), (error) => error === failure);
        assert.equal(calls, 1);
        assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);
        assert.notEqual(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
        assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.identity.assetFingerprint);
        await controller.undoAsync();
        assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      } finally {
        controller.dispose();
      }
    });
  }
}
await test('selection-only changes cannot redirect a queued deletion or overwrite unrelated selection', async () => {
  const { controller, first, second } = await setup();
  try {
    const pending = controller.deleteSelectedInstance();
    controller.selectInstance(second.instanceId);
    const deleted = await pending;
    assert.equal(deleted?.instanceId, first.instanceId);
    assert.equal(controller.getInstance(first.instanceId), undefined);
    assert.equal(controller.getSummary().primaryInstanceId, second.instanceId);
  } finally {
    controller.dispose();
  }
});
await test('duplicate summary belongs to the acknowledged operation even after later edits and disposal', async () => {
  const { controller, transport, first, plate, destination } = await setup();
  const held = deferred(),
    committed = deferred();
  try {
    const original = transport.executeIntent.bind(transport);
    let count = 0;
    transport.executeIntent = async (...args) => {
      const first = count++ === 0;
      const receipt = await original(...args);
      if (first) {
        committed.resolve();
        await held.promise;
      }
      return receipt;
    };
    const pending = controller.duplicateSelectedObject();
    await committed.promise;
    const duplicate = controller.getInstance(controller.getSummary().primaryInstanceId!)!;
    await controller.renameObject(duplicate.objectId, 'Later name');
    await controller.moveObjectToPlate(duplicate.objectId, destination);
    controller.dispose();
    held.resolve();
    const result = await pending;
    assert.equal(result?.objectId, duplicate.objectId);
    assert.equal(result?.sourceObjectId, first.objectId);
    assert.equal(result?.name, 'First copy');
    assert.equal(result?.plateId, plate);
    assert.ok(Object.isFrozen(result?.instanceIds));
  } finally {
    held.resolve();
    controller.dispose();
  }
});
await test('cut retains its copied content on refusal and a newer copy wins over late acknowledgement', async () => {
  const { controller, transport, first, second } = await setup();
  const held = deferred(),
    committed = deferred();
  try {
    const failed = controller.cutSelectedObject();
    assert.equal(controller.hasClipboard(), true);
    controller.setProjectConfig({ cut_probe: 'newer' });
    await assert.rejects(failed, stale);
    const recovered = await controller.pasteClipboard();
    assert.equal(recovered?.name, 'First copy');
    await controller.undoAsync();
    controller.selectInstance(first.instanceId);
    const original = transport.executeIntent.bind(transport);
    transport.executeIntent = async (...args) => {
      const receipt = await original(...args);
      committed.resolve();
      await held.promise;
      return receipt;
    };
    const pending = controller.cutSelectedObject();
    await committed.promise;
    controller.selectInstance(second.instanceId);
    controller.copySelectedObject();
    held.resolve();
    await pending;
    const pasted = await controller.pasteClipboard();
    assert.equal(pasted?.name, 'Second copy');
  } finally {
    held.resolve();
    controller.dispose();
  }
});
await test('no selection, empty plates and same-plate moves preserve history; invalid targets reject', async () => {
  const { controller, first, second, plate, destination } = await setup();
  try {
    controller.clearSelection();
    const before = footprint(controller);
    assert.equal(await controller.deleteSelectedInstance(), undefined);
    assert.equal(await controller.duplicateSelectedObject(), undefined);
    assert.equal(await controller.cutSelectedObject(), undefined);
    assert.equal(await controller.deleteAllObjectsOnPlate(destination), 0);
    await controller.moveObjectToPlate(first.objectId, plate);
    assert.deepEqual(footprint(controller), before);
    await assert.rejects(controller.convertInstanceToIndependentObject(second.instanceId), /sole instance/);
    await assert.rejects(
      controller.deleteInstance(entityId<'instance'>('import:missing:instance')),
      /Unknown instance/,
    );
    assert.deepEqual(footprint(controller), before);
    await assert.rejects(controller.moveObjectToPlate(first.objectId, entityId<'plate'>('import:missing:plate')));
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});
console.log(`\nAsynchronous object lifecycle: ${passed} cases passed.`);
