import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InMemoryAssetRepository } from '../../project/assets';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import {
  LocalProjectSessionTransport,
  ProjectReceiptUnavailableError,
} from '../../project/LocalProjectSessionTransport';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const idSource = new UuidIdSource(seededRandom(0xc11b0a));
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource,
    clock: () => '2026-10-06T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const first = controller.importBufferGeometry(geometry, { name: 'First' });
  const second = controller.importBufferGeometry(geometry, { name: 'Second' });
  geometry.dispose();
  controller.selectInstance(first.instanceId);
  const host = controller as unknown as {
    assets: InMemoryAssetRepository;
    sessionTransport: LocalProjectSessionTransport;
  };
  return { controller, idSource, first, second, assets: host.assets, transport: host.sessionTransport };
}
function footprint(controller: CanonicalWorkspaceController) {
  return {
    identity: controller.captureProjectExportGuard(),
    summary: controller.getSummary(),
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
const emptyPool = { resources: 0, commands: 0, units: 0, assetBytes: 0 };
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
for (const source of ['present', 'deleted', 'reset'] as const) {
  await test(`paste from ${source} source queues one edit, restores exact assets and round-trips undo/redo`, async () => {
    const { controller, assets, first, transport } = setup();
    try {
      const asset = assets.list()[0];
      const record = assets.peek(asset.descriptor.id);
      controller.copySelectedObject();
      if (source === 'deleted') await controller.deleteInstance(first.instanceId);
      if (source === 'reset') controller.resetProject();
      const before = footprint(controller);
      const original = transport.executeStaged.bind(transport);
      let calls = 0;
      transport.executeStaged = (work, options) => {
        calls++;
        assert.equal(work.commandCount, 1);
        assert.ok(options.guard);
        return original(work, options);
      };
      const pending = controller.pasteClipboard();
      assert.deepEqual(footprint(controller), before);
      const result = await pending;
      assert.ok(result);
      assert.equal(result.name, 'First copy');
      assert.equal(calls, 1);
      const after = footprint(controller);
      assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
      assert.equal(after.summary.history.undoLabel, 'Paste model');
      assert.equal(assets.peek(asset.descriptor.id), record);
      assert.deepEqual(transport.stagingUsage(), emptyPool);
      // A valid native-domain edit must remain serializable after restoration.
      const archive = await controller.serializeProjectSnapshot();
      assert.ok(archive.serialized.bytes.length > 0);
      const reopened = await new Bbs3mfProjectSerializer().deserialize(archive.serialized.bytes);
      assert.ok(reopened.state.plates.some((plate) => plate.objects.some((object) => object.id === result.objectId)));
      assert.deepEqual(
        reopened.assets.find((value) => value.descriptor.id === asset.descriptor.id)?.bytes,
        asset.bytes,
      );
      await controller.undoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.identity.assetFingerprint);
      assert.deepEqual(controller.getObjectsTree().selection, before.tree.selection);
      await controller.redoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, after.identity.semanticHash);
      assert.equal(assets.peek(asset.descriptor.id), record);
    } finally {
      controller.dispose();
    }
  });
}
for (const drift of ['edit', 'checkpoint', 'reset', 'dispose'] as const) {
  await test(`queued paste rejects ${drift} without restoring any bytes or descriptors`, async () => {
    const { controller, assets, transport } = setup();
    try {
      controller.copySelectedObject();
      controller.resetProject();
      const pending = controller.pasteClipboard();
      if (drift === 'edit') controller.setProjectConfig({ paste_probe: 'newer' });
      if (drift === 'checkpoint') controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
      if (drift === 'reset') controller.resetProject();
      if (drift === 'dispose') controller.dispose();
      const newer = drift === 'dispose' ? undefined : footprint(controller);
      await assert.rejects(pending, drift === 'dispose' ? { code: 'disposed' } : stale);
      assert.equal(assets.list().length, 0);
      assert.deepEqual(transport.stagingUsage(), emptyPool);
      if (newer) assert.deepEqual(footprint(controller), newer);
    } finally {
      controller.dispose();
    }
  });
}
for (const unavailable of [false, true]) {
  await test(`a ${unavailable ? 'summary overflow' : 'lost reply'} preserves the committed paste without retry`, async () => {
    const { controller, transport, assets } = setup();
    try {
      controller.copySelectedObject();
      controller.resetProject();
      const before = footprint(controller);
      const original = transport.executeStaged.bind(transport);
      const error = unavailable ? new ProjectReceiptUnavailableError(true) : new Error('Lost paste receipt');
      let calls = 0;
      transport.executeStaged = async (...args) => {
        calls++;
        await original(...args);
        throw error;
      };
      await assert.rejects(controller.pasteClipboard(), (actual) => actual === error);
      assert.equal(calls, 1);
      assert.equal(controller.getSummary().objectCount, 1);
      assert.equal(assets.list().length, 1);
      assert.deepEqual(transport.stagingUsage(), emptyPool);
      await controller.undoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      assert.equal(assets.list().length, 0);
    } finally {
      controller.dispose();
    }
  });
}
await test('clipboard replacement cannot retarget a queued paste or be undone by its late receipt', async () => {
  const { controller, first, second, transport } = setup();
  const held = deferred(),
    committed = deferred();
  try {
    controller.copySelectedObject();
    const original = transport.executeStaged.bind(transport);
    transport.executeStaged = async (...args) => {
      const receipt = await original(...args);
      committed.resolve();
      await held.promise;
      return receipt;
    };
    const pending = controller.pasteClipboard();
    controller.selectInstance(second.instanceId);
    controller.copySelectedObject();
    await committed.promise;
    const pastedId = controller.getInstance(controller.getSummary().primaryInstanceId!)!.objectId;
    assert.notEqual(pastedId, first.objectId);
    await controller.renameObject(pastedId, 'Later name');
    controller.selectInstance(second.instanceId);
    held.resolve();
    const result = await pending;
    assert.equal(result?.name, 'First copy');
    assert.equal(result?.objectId, pastedId);
    assert.equal(controller.getSummary().primaryInstanceId, second.instanceId);
    const next = await controller.pasteClipboard();
    assert.equal(next?.name, 'Second copy');
  } finally {
    held.resolve();
    controller.dispose();
  }
});
await test('a captured result survives owner disposal and the controller clears its clipboard reference', async () => {
  const { controller, transport } = setup();
  const held = deferred(),
    committed = deferred();
  try {
    controller.copySelectedObject();
    const original = transport.executeStaged.bind(transport);
    transport.executeStaged = async (...args) => {
      const receipt = await original(...args);
      committed.resolve();
      await held.promise;
      return receipt;
    };
    const pending = controller.pasteClipboard();
    await committed.promise;
    controller.dispose();
    assert.equal(controller.hasClipboard(), false);
    held.resolve();
    assert.equal((await pending)?.name, 'First copy');
  } finally {
    held.resolve();
    controller.dispose();
  }
});
await test('invalid destination and exhausted staging cannot restore assets outside the command', async () => {
  const { controller, transport, assets } = setup();
  try {
    controller.copySelectedObject();
    controller.resetProject();
    const before = controller.captureProjectExportGuard();
    await assert.rejects(controller.pasteClipboard({ destinationPlateId: entityId<'plate'>('import:missing:plate') }));
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
    assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.assetFingerprint);
    assert.equal(controller.getSummary().history.undoCount, 0);
    assert.equal(assets.list().length, 0);
    transport.configureStaging({ maxResources: 0, maxCommands: 0, maxUnits: 0, maxAssetBytes: 0 });
    await assert.rejects(controller.pasteClipboard(), { code: 'resourceLimit' });
    assert.equal(assets.list().length, 0);
    assert.deepEqual(transport.stagingUsage(), emptyPool);
  } finally {
    controller.dispose();
  }
});
await test('copy rejects a missing byte dependency and preserves the previous clipboard', async () => {
  const { controller, assets, first, second } = setup();
  try {
    controller.copySelectedObject();
    const snapshot = assets.captureInternal();
    for (const asset of assets.list()) assets.remove(asset.descriptor.id);
    controller.selectInstance(second.instanceId);
    assert.throws(() => controller.copySelectedObject(), /Missing clipboard asset/);
    assets.restoreInternal(snapshot);
    controller.selectInstance(first.instanceId);
    assert.equal((await controller.pasteClipboard())?.name, 'First copy');
  } finally {
    controller.dispose();
  }
});
console.log(`\nAsynchronous clipboard paste: ${passed} cases passed.`);
