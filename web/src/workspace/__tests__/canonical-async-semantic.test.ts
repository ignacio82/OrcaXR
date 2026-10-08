/**
 * Layer events, height ranges and part roles through the guarded asynchronous
 * session route: each edit waits for acknowledgement, keeps exact undo/redo,
 * patches a layer event field by field (keep, clear, set), refuses a stale or
 * competing edit without rebasing, and reports a refused command with the
 * browser's own error rather than the session's code.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController, StaleCanonicalLayerEventMutationError } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x1a7e5)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
    toolCount: 2,
  });
  const geometry = new THREE.BoxGeometry(10, 10, 20);
  const imported = controller.importBufferGeometry(geometry, { name: 'Tower', transform: identityTransform() });
  geometry.dispose();
  return { controller, imported };
}
const footprint = (controller: CanonicalWorkspaceController) => ({
  summary: controller.getSummary(),
  identity: controller.captureProjectExportGuard(),
});
const guard = (controller: CanonicalWorkspaceController) => {
  const summary = controller.getSummary();
  return { expectedRevision: summary.revision, sourceHash: summary.projectHash };
};
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('layer events add, patch field by field and delete, each acknowledged with exact undo', async () => {
  const { controller } = setup();
  try {
    const filament = controller.getSummary().plates.length ? controller.getLayerEventSnapshot() : undefined;
    assert.deepEqual(filament?.events, []);
    const before = footprint(controller);
    const pending = controller.mutateLayerEvent({
      ...guard(controller),
      operation: 'add',
      type: 'pause',
      topZMm: 5,
      message: 'Insert magnets ✓',
      toolIndex: 1,
    });
    assert.deepEqual(footprint(controller), before, 'nothing applies before acknowledgement');
    const id = (await pending)!;
    const [added] = controller.getLayerEventSnapshot().events;
    assert.equal(added.id, id);
    assert.deepEqual(added.event, { type: 'pause', topZMm: 5, toolIndex: 1, message: 'Insert magnets ✓' });
    const afterAdd = footprint(controller);
    assert.equal(afterAdd.summary.history.undoCount, before.summary.history.undoCount + 1);

    // Absent keeps, undefined clears, a value sets.
    await controller.mutateLayerEvent({
      ...guard(controller),
      operation: 'edit',
      id,
      patch: { topZMm: 7.5, toolIndex: undefined, color: '#ff8800' },
    });
    assert.deepEqual(controller.getLayerEventSnapshot().events[0].event, {
      type: 'pause',
      topZMm: 7.5,
      color: '#ff8800',
      message: 'Insert magnets ✓',
    });
    await controller.mutateLayerEvent({
      ...guard(controller),
      operation: 'edit',
      id,
      patch: { type: 'custom', code: 'M117 hi' },
    });
    assert.equal(controller.getLayerEventSnapshot().events[0].code, 'M117 hi');
    assert.equal(controller.getLayerEventSnapshot().events[0].event.type, 'custom');

    assert.equal(await controller.mutateLayerEvent({ ...guard(controller), operation: 'delete', id }), undefined);
    assert.deepEqual(controller.getLayerEventSnapshot().events, []);
    for (let i = 0; i < 3; i++) assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, afterAdd.identity.semanticHash);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

await test('refused commands report the browser error; stale and competing edits never rebase', async () => {
  const { controller } = setup();
  try {
    const before = footprint(controller);
    await assert.rejects(
      controller.mutateLayerEvent({
        ...guard(controller),
        expectedRevision: 0,
        sourceHash: 'drift',
        operation: 'delete',
        id: 'import:none:x' as never,
      }),
      StaleCanonicalLayerEventMutationError,
    );
    assert.deepEqual(footprint(controller), before, 'a stale request is refused before submission');
    // Only the command, applied by the session, knows the event is missing.
    // Its rollback keeps the project and history exactly; like every refused
    // command on the bus, it still advances the revision.
    await assert.rejects(
      controller.mutateLayerEvent({
        ...guard(controller),
        operation: 'edit',
        id: 'import:none:x' as never,
        patch: { topZMm: 3 },
      }),
      /Unknown layer event import:none:x/,
    );
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
    assert.deepEqual(controller.getSummary().history, before.summary.history);

    const pending = controller.mutateLayerEvent({ ...guard(controller), operation: 'add', type: 'pause', topZMm: 4 });
    controller.setProjectConfig({ edit_probe: 'newer' });
    const newer = footprint(controller);
    await assert.rejects(pending, stale);
    assert.deepEqual(footprint(controller), newer);
  } finally {
    controller.dispose();
  }
});

await test('height ranges and part roles take the same route', async () => {
  const { controller, imported } = setup();
  try {
    const objectGuard = () => ({ ...guard(controller), objectId: imported.objectId });
    const range = controller.createLayerRangeId();
    const before = footprint(controller);
    const pending = controller.editSemanticLayerRange({
      ...objectGuard(),
      operation: 'add',
      layerRangeId: range,
      minZMm: 2,
      maxZMm: 6,
    });
    assert.deepEqual(footprint(controller), before);
    await pending;
    controller.selectInstance(imported.instanceId);
    assert.deepEqual(controller.getSemanticObjectEditorSnapshot()?.layerRanges, [{ id: range, minZMm: 2, maxZMm: 6 }]);
    // The overlap is the command's own judgement, reported in its words.
    await assert.rejects(
      controller.editSemanticLayerRange({
        ...objectGuard(),
        operation: 'add',
        layerRangeId: controller.createLayerRangeId(),
        minZMm: 4,
        maxZMm: 8,
      }),
      (error: unknown) =>
        error instanceof Error && !(error instanceof AsyncSessionError) && /overlap/i.test(error.message),
    );
    await assert.rejects(
      controller.convertSemanticVolumeRole({
        ...objectGuard(),
        volumeId: imported.volumeId,
        nextRole: 'negative-volume',
      }),
      /last model part/,
    );
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async semantic edit tests passed: ${passed}`);
