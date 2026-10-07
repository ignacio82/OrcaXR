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
  const idSource = new UuidIdSource(seededRandom(0xa1157));
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource,
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
  const transport = (controller as unknown as { sessionTransport: LocalProjectSessionTransport }).sessionTransport;
  return { controller, transport, idSource, first, second, plate, destination };
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
const emptyPool = { resources: 0, commands: 0, units: 0, assetBytes: 0 };
type Fixture = Awaited<ReturnType<typeof setup>>;
const operations = {
  duplicate: ({ controller }: Fixture) => controller.duplicateSelectedInstance(),
  fill: ({ controller, first }: Fixture) =>
    controller.fillPlateWithInstances(first.instanceId, { bedSizeMm: [270, 270] }, 70),
};
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
for (const [name, operation] of Object.entries(operations)) {
  await test(`${name} submits one measured input and keeps exact history and asset ownership`, async () => {
    const s = await setup();
    const { controller, transport } = s;
    try {
      const before = footprint(controller);
      const original = transport.executeStaged.bind(transport);
      let calls = 0;
      transport.executeStaged = (work, options) => {
        calls++;
        assert.ok(options.guard);
        assert.equal(work.commandCount, name === 'fill' ? 70 : 1);
        assert.ok(work.inputUnits > 0);
        return original(work, options);
      };
      const pending = operation(s);
      assert.deepEqual(footprint(controller), before);
      assert.equal(transport.stagingUsage().resources, 1);
      const result = await pending;
      assert.ok(result);
      if ('created' in result) assert.equal(result.created, 70);
      const after = footprint(controller);
      assert.equal(calls, 1);
      assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
      assert.equal(after.summary.history.undoLabel, name === 'fill' ? 'Fill 70 instances' : 'Create instance');
      assert.equal(after.summary.instanceCount, before.summary.instanceCount + (name === 'fill' ? 70 : 1));
      assert.equal(after.identity.assetFingerprint, before.identity.assetFingerprint);
      assert.deepEqual(transport.stagingUsage(), emptyPool);
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
    await test(`${name} rejects ${drift} before execution and releases its input`, async () => {
      const s = await setup();
      const { controller, transport } = s;
      try {
        const pending = operation(s);
        if (drift === 'edit') controller.setProjectConfig({ instance_probe: 'newer' });
        if (drift === 'checkpoint') controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
        if (drift === 'reset') controller.resetProject();
        if (drift === 'dispose') controller.dispose();
        const newer = drift === 'dispose' ? undefined : footprint(controller);
        await assert.rejects(pending, drift === 'dispose' ? { code: 'disposed' } : stale);
        assert.deepEqual(transport.stagingUsage(), emptyPool);
        if (newer) assert.deepEqual(footprint(controller), newer);
      } finally {
        controller.dispose();
      }
    });
  }
  for (const unavailable of [false, true]) {
    await test(`${name} keeps committed work without retrying a ${unavailable ? 'summary overflow' : 'lost reply'}`, async () => {
      const s = await setup();
      const { controller, transport } = s;
      try {
        const before = footprint(controller);
        const original = transport.executeStaged.bind(transport);
        const failure = unavailable ? new ProjectReceiptUnavailableError(true) : new Error('Lost instance receipt');
        let calls = 0;
        transport.executeStaged = async (...args) => {
          calls++;
          await original(...args);
          throw failure;
        };
        await assert.rejects(operation(s), (error) => error === failure);
        assert.equal(calls, 1);
        assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);
        assert.notEqual(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
        assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.identity.assetFingerprint);
        assert.deepEqual(transport.stagingUsage(), emptyPool);
        await controller.undoAsync();
        assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      } finally {
        controller.dispose();
      }
    });
  }
  await test(`${name} refuses exhausted staging capacity without a partial edit`, async () => {
    const s = await setup();
    const { controller, transport } = s;
    try {
      const before = footprint(controller);
      transport.configureStaging({ maxResources: 0, maxCommands: 0, maxUnits: 0, maxAssetBytes: 0 });
      await assert.rejects(operation(s), { code: 'resourceLimit' });
      assert.deepEqual(footprint(controller), before);
      assert.deepEqual(transport.stagingUsage(), emptyPool);
    } finally {
      controller.dispose();
    }
  });
}
await test('duplicate result keeps its captured identity, transform and name after later edits and disposal', async () => {
  const { controller, transport, first, plate, destination } = await setup();
  const held = deferred(),
    committed = deferred();
  try {
    const original = transport.executeStaged.bind(transport);
    transport.executeStaged = async (...args) => {
      const result = await original(...args);
      committed.resolve();
      await held.promise;
      return result;
    };
    const pending = controller.duplicateSelectedInstance();
    await committed.promise;
    const id = controller.getSummary().primaryInstanceId!;
    await controller.renameObject(first.objectId, 'Later name');
    await controller.setInstanceTransform(id, { ...identityTransform(), translationMm: [20, 30, 40] });
    await controller.moveObjectToPlate(first.objectId, destination);
    controller.dispose();
    held.resolve();
    const result = await pending;
    assert.equal(result?.instanceId, id);
    assert.equal(result?.sourceInstanceId, first.instanceId);
    assert.equal(result?.plateId, plate);
    assert.equal(result?.name, 'First');
    assert.deepEqual(result?.transform, identityTransform());
    assert.ok(Object.isFrozen(result?.transform.translationMm));
  } finally {
    held.resolve();
    controller.dispose();
  }
});
await test('selection changes do not retarget a queued instance command', async () => {
  const { controller, first, second } = await setup();
  try {
    const pending = controller.duplicateSelectedInstance();
    controller.selectInstance(second.instanceId);
    const result = await pending;
    assert.equal(result?.objectId, first.objectId);
    assert.equal(result?.sourceInstanceId, first.instanceId);
    assert.equal(controller.getSummary().primaryInstanceId, result?.instanceId);
  } finally {
    controller.dispose();
  }
});
await test('the preparation guard precedes ID allocation and rejects reentrant edits', async () => {
  const s = await setup();
  const { controller, idSource, transport } = s;
  try {
    const next = idSource.next.bind(idSource);
    idSource.next = (family) => {
      controller.setProjectConfig({ instance_probe: 'changed during preparation' });
      return next(family);
    };
    const pending = controller.duplicateSelectedInstance();
    const newer = footprint(controller);
    await assert.rejects(pending, stale);
    assert.deepEqual(footprint(controller), newer);
    assert.deepEqual(transport.stagingUsage(), emptyPool);
  } finally {
    controller.dispose();
  }
});
await test('the production pool bounds concurrent inputs and settles stale neighbors', async () => {
  const { controller, transport } = await setup();
  try {
    const before = controller.getSummary();
    const pending = Array.from({ length: 5 }, () => controller.duplicateSelectedInstance());
    assert.equal(transport.stagingUsage().resources, 4);
    const results = await Promise.allSettled(pending);
    assert.equal(results[0].status, 'fulfilled');
    for (const result of results.slice(1, 4)) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.ok(stale(result.reason));
    }
    assert.equal(results[4].status, 'rejected');
    if (results[4].status === 'rejected') assert.equal(results[4].reason.code, 'resourceLimit');
    assert.equal(controller.getSummary().history.undoCount, before.history.undoCount + 1);
    assert.equal(controller.getSummary().instanceCount, before.instanceCount + 1);
    assert.deepEqual(transport.stagingUsage(), emptyPool);
  } finally {
    controller.dispose();
  }
});
await test('a one-copy fill preserves its transaction label and reports withheld slots', async () => {
  const { controller, first } = await setup();
  try {
    const result = await controller.fillPlateWithInstances(first.instanceId, { bedSizeMm: [270, 270] }, 1);
    assert.equal(result.created, 1);
    assert.ok(result.withheld > 0);
    assert.equal(controller.getSummary().history.undoLabel, 'Duplicate instance');
  } finally {
    controller.dispose();
  }
});
await test('a later member failure rolls back the entire fill and releases staging capacity', async () => {
  const s = await setup();
  const { controller, transport, idSource, first } = s;
  try {
    const before = footprint(controller);
    const next = idSource.next.bind(idSource);
    const collision = next('instance');
    idSource.next = (family) =>
      family === 'instance' ? (collision as ReturnType<typeof idSource.next<typeof family>>) : next(family);
    await assert.rejects(controller.fillPlateWithInstances(first.instanceId, { bedSizeMm: [270, 270] }, 2));
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
    assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.identity.assetFingerprint);
    assert.deepEqual(controller.getObjectsTree().selection, before.tree.selection);
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount);
    assert.deepEqual(transport.stagingUsage(), emptyPool);
  } finally {
    controller.dispose();
  }
});
await test('no selection, a full bed and over-budget or missing targets leave state unchanged', async () => {
  const { controller, first } = await setup();
  try {
    controller.clearSelection();
    const before = footprint(controller);
    assert.equal(await controller.duplicateSelectedInstance(), undefined);
    assert.deepEqual(await controller.fillPlateWithInstances(first.instanceId, { bedSizeMm: [1, 1] }), {
      created: 0,
      withheld: 0,
    });
    await assert.rejects(controller.fillPlateWithInstances(first.instanceId, { bedSizeMm: [270, 270] }, 4097), {
      code: 'resourceLimit',
    });
    await assert.rejects(
      controller.fillPlateWithInstances(entityId<'instance'>('import:missing:instance'), { bedSizeMm: [270, 270] }),
      /Unknown instance/,
    );
    assert.deepEqual(footprint(controller), before);
  } finally {
    controller.dispose();
  }
});
console.log(`\nAsynchronous instance staging: ${passed} cases passed.`);
