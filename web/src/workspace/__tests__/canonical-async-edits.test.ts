import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController, CanonicalPartialPrintabilityError } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x714ed)),
    clock: () => '2026-10-06T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const first = controller.importBufferGeometry(geometry, { name: 'First', transform: pose(20) });
  const second = controller.importBufferGeometry(geometry, { name: 'Second', transform: pose(40) });
  geometry.dispose();
  return { controller, first, second };
}
function pose(x: number) {
  return { ...identityTransform(), translationMm: [x, 0, 20] as const };
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

const operations = {
  object: ({ controller, first }: ReturnType<typeof setup>) => controller.renameObject(first.objectId, 'Renamed'),
  volume: ({ controller, first }: ReturnType<typeof setup>) => controller.renameVolume(first.volumeId, 'Part'),
  printable: ({ controller, first }: ReturnType<typeof setup>) =>
    controller.setInstancePrintable([first.instanceId], false),
  transform: ({ controller, first }: ReturnType<typeof setup>) =>
    controller.setInstanceTransform(first.instanceId, pose(50)),
  batch: ({ controller, first, second }: ReturnType<typeof setup>) =>
    controller.setInstanceTransforms([
      { instanceId: first.instanceId, transform: pose(50) },
      { instanceId: second.instanceId, transform: pose(70) },
    ]),
  drop: ({ controller, first }: ReturnType<typeof setup>) => controller.dropInstancesToBed([first.instanceId]),
  mirror: ({ controller, first }: ReturnType<typeof setup>) => controller.mirrorInstances([first.instanceId], 'x'),
  center: ({ controller, first }: ReturnType<typeof setup>) =>
    controller.centerInstancesOnPlate([first.instanceId], [270, 270]),
  fit: ({ controller, first }: ReturnType<typeof setup>) =>
    controller.scaleInstancesToFitPrintVolume([first.instanceId], { x: 270, y: 270, z: 250 }),
};
for (const [name, operation] of Object.entries(operations)) {
  await test(`${name} waits for acknowledgement and retains exact undo/redo and mesh identity`, async () => {
    const s = setup();
    const { controller, first } = s;
    try {
      const mesh = controller.surface.getVolumeMesh(first.instanceId, first.volumeId)!;
      const geometry = mesh.geometry;
      const before = footprint(controller);
      const pending = operation(s);
      assert.deepEqual(footprint(controller), before);
      await pending;
      const after = footprint(controller);
      assert.equal(after.summary.history.undoCount, before.summary.history.undoCount + 1);
      assert.equal(after.identity.assetFingerprint, before.identity.assetFingerprint);
      assert.equal(mesh.geometry, geometry);
      assert.equal(await controller.undoAsync(), true);
      assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
      assert.deepEqual(controller.getObjectsTree().selection, before.tree.selection);
      assert.equal(await controller.redoAsync(), true);
      assert.equal(controller.captureProjectExportGuard().semanticHash, after.identity.semanticHash);
    } finally {
      controller.dispose();
    }
  });
  for (const drift of ['edit', 'checkpoint', 'reset', 'dispose'] as const) {
    await test(`${name} refuses queued ${drift} without rebasing or extra history`, async () => {
      const s = setup();
      const { controller } = s;
      try {
        const pending = operation(s);
        if (drift === 'edit') controller.setProjectConfig({ edit_probe: 'newer' });
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
}

await test('captures transform inputs and rejects competing queued edits instead of rebasing', async () => {
  const { controller, first } = setup();
  try {
    const transform = { ...identityTransform(), translationMm: [11, 12, 13] as [number, number, number] };
    const pending = controller.setInstanceTransform(first.instanceId, transform);
    transform.translationMm[0] = 999;
    const competing = controller.renameObject(first.objectId, 'Competing');
    await pending;
    await assert.rejects(competing, stale);
    assert.deepEqual(controller.getInstanceTransform(first.instanceId)?.translationMm, [11, 12, 13]);
  } finally {
    controller.dispose();
  }
});

await test('printability validates all IDs before submission and keeps separate acknowledged undo entries', async () => {
  const { controller, first, second } = setup();
  try {
    const before = footprint(controller);
    await assert.rejects(
      controller.setInstancePrintable([first.instanceId, entityId<'instance'>('import:missing:id')], false),
      /Unknown instance/,
    );
    assert.deepEqual(footprint(controller), before);
    assert.equal(
      await controller.setInstancePrintable([first.instanceId, first.instanceId, second.instanceId], false),
      2,
    );
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 2);
    const done = footprint(controller);
    assert.equal(await controller.setInstancePrintable([first.instanceId, second.instanceId], false), 0);
    assert.deepEqual(footprint(controller), done);
    await controller.undoAsync();
    assert.equal(controller.areInstancesPrintable([second.instanceId]), true);
    assert.equal(controller.areInstancesPrintable([first.instanceId]), false);
  } finally {
    controller.dispose();
  }
});

await test('interrupted printability reports committed members and leaves later targets untouched', async () => {
  const { controller, first, second } = setup();
  try {
    let intervened = false;
    const unsubscribe = controller.subscribe(
      () => {
        if (!intervened && !controller.areInstancesPrintable([first.instanceId])) {
          intervened = true;
          controller.setProjectConfig({ interrupt_probe: 'newer' });
        }
      },
      { emitCurrent: false },
    );
    await assert.rejects(
      controller.setInstancePrintable([first.instanceId, second.instanceId], false),
      (error) => error instanceof CanonicalPartialPrintabilityError && error.completedCount === 1 && stale(error.cause),
    );
    unsubscribe();
    assert.equal(controller.areInstancesPrintable([first.instanceId]), false);
    assert.equal(controller.areInstancesPrintable([second.instanceId]), true);
  } finally {
    controller.dispose();
  }
});

await test('a gesture owns one dispatched edit and the latest pose, chains receipts and coalesces undo', async () => {
  const { controller, first } = setup();
  try {
    controller.selectInstance(first.instanceId);
    const before = footprint(controller);
    const held = deferred();
    const committed = deferred();
    const original = controller.setInstanceTransform.bind(controller);
    const calls: number[] = [];
    controller.setInstanceTransform = async (...args) => {
      calls.push(args[1].translationMm[0]);
      const receipt = await original(...args);
      if (calls.length === 1) {
        committed.resolve();
        await held.promise;
      }
      return receipt;
    };
    const gesture = controller.beginTransformGesture([first.instanceId], 'bounded-drag');
    gesture.update([{ instanceId: first.instanceId, transform: pose(1) }]);
    await committed.promise;
    for (let i = 2; i <= 1000; i++) gesture.update([{ instanceId: first.instanceId, transform: pose(i) }]);
    let finished = false;
    const finish = gesture.finish().then(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.deepEqual(calls, [1]);
    held.resolve();
    await finish;
    assert.deepEqual(calls, [1, 1000]);
    assert.equal(controller.getInstanceTransform(first.instanceId)?.translationMm[0], 1000);
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);
    await controller.undoAsync();
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

for (const drift of ['selection', 'project', 'checkpoint', 'cancel', 'close'] as const) {
  await test(`gesture ${drift} discards pending poses and preserves an already committed edit`, async () => {
    const { controller, first, second } = setup();
    try {
      controller.selectInstance(first.instanceId);
      const held = deferred();
      const committed = deferred();
      let calls = 0;
      const original = controller.setInstanceTransform.bind(controller);
      controller.setInstanceTransform = async (...args) => {
        calls++;
        const receipt = await original(...args);
        committed.resolve();
        await held.promise;
        return receipt;
      };
      const gesture = controller.beginTransformGesture([first.instanceId], 'interrupted-drag');
      gesture.update([{ instanceId: first.instanceId, transform: pose(1) }]);
      await committed.promise;
      gesture.update([{ instanceId: first.instanceId, transform: pose(2) }]);
      if (drift === 'selection') controller.selectInstance(second.instanceId);
      if (drift === 'project') controller.setProjectConfig({ gesture_probe: 'newer' });
      if (drift === 'checkpoint') controller.acknowledgeProjectExport(controller.captureProjectExportGuard());
      if (drift === 'cancel') gesture.cancel();
      if (drift === 'close') controller.dispose();
      const finish = gesture.finish();
      held.resolve();
      await assert.rejects(
        finish,
        drift === 'cancel' ? { code: 'cancelled' } : drift === 'close' ? { code: 'disposed' } : stale,
      );
      assert.equal(calls, 1);
      if (drift !== 'close') assert.equal(controller.getInstanceTransform(first.instanceId)?.translationMm[0], 1);
    } finally {
      controller.dispose();
    }
  });
}

await test('gesture captures poses before dispatch, refuses changed targets, and cancels pre-dispatch work', async () => {
  const { controller, first, second } = setup();
  try {
    const before = footprint(controller);
    const bad = controller.beginTransformGesture([first.instanceId], 'bad-target');
    assert.throws(() => bad.update([{ instanceId: second.instanceId, transform: pose(5) }]), /targets changed/);
    await assert.rejects(bad.finish(), /targets changed/);
    const cancel = controller.beginTransformGesture([first.instanceId], 'cancel');
    cancel.update([{ instanceId: first.instanceId, transform: pose(10) }]);
    cancel.cancel();
    await assert.rejects(cancel.finish(), { code: 'cancelled' });
    assert.deepEqual(footprint(controller), before);
    const gesture = controller.beginTransformGesture([first.instanceId, second.instanceId], 'batch-capture');
    const mutable = { ...identityTransform(), translationMm: [8, 9, 10] as [number, number, number] };
    gesture.update([
      { instanceId: first.instanceId, transform: mutable },
      { instanceId: second.instanceId, transform: pose(15) },
    ]);
    mutable.translationMm[0] = 900;
    await gesture.finish();
    assert.equal(controller.getInstanceTransform(first.instanceId)?.translationMm[0], 8);
    assert.equal(controller.getSummary().history.undoCount, before.summary.history.undoCount + 1);
  } finally {
    controller.dispose();
  }
});

await test('selection changing away and back cancels even a dispatched gesture before commit', async () => {
  const { controller, first, second } = setup();
  try {
    controller.selectInstance(first.instanceId);
    const before = controller.captureProjectExportGuard();
    const gesture = controller.beginTransformGesture([first.instanceId], 'roundtrip-selection');
    gesture.update([{ instanceId: first.instanceId, transform: pose(12) }]);
    // Let the pump submit to the transport, without allowing queued execution.
    await Promise.resolve();
    controller.selectInstance(second.instanceId);
    controller.selectInstance(first.instanceId);
    await assert.rejects(gesture.finish(), stale);
    assert.deepEqual(controller.captureProjectExportGuard(), before);
  } finally {
    controller.dispose();
  }
});

await test('a missing acknowledgement never retries or rolls back a committed gesture step', async () => {
  const { controller, first } = setup();
  try {
    const original = controller.setInstanceTransform.bind(controller);
    let calls = 0;
    controller.setInstanceTransform = async (...args) => {
      calls++;
      await original(...args);
      throw new Error('Synthetic lost acknowledgement');
    };
    const gesture = controller.beginTransformGesture([first.instanceId], 'uncertain');
    gesture.update([{ instanceId: first.instanceId, transform: pose(123) }]);
    await assert.rejects(gesture.finish(), /lost acknowledgement/);
    assert.throws(
      () => gesture.update([{ instanceId: first.instanceId, transform: pose(456) }]),
      /lost acknowledgement/,
    );
    assert.equal(calls, 1);
    assert.equal(controller.getInstanceTransform(first.instanceId)?.translationMm[0], 123);
  } finally {
    controller.dispose();
  }
});

console.log(`\nAsynchronous object and transform editing: ${passed} tests passed.`);
