/**
 * Import confirmation through the guarded asynchronous session route: the
 * whole next project and its assets commit as one staged `Import <filename>`
 * entry once the session acknowledges it; a preview the project moved away
 * from is refused by its own checks, and an edit queued ahead of the commit
 * refuses the commit instead of rebasing it, leaving the preview cancellable.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { StaleImportPreviewError } from '../../project/import/types';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x1a9)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const geometry = new THREE.BoxGeometry(20, 20, 20);
  const imported = controller.importBufferGeometry(geometry, { name: 'Block', transform: identityTransform() });
  geometry.dispose();
  controller.selectInstance(imported.instanceId);
  return controller;
}
/** A binary STL tetrahedron. */
function tetrahedron(): Uint8Array {
  const corners = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
    [0, 0, 10],
  ];
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ];
  const bytes = new Uint8Array(84 + faces.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, faces.length, true);
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12;
    for (const corner of face) {
      for (const coordinate of corners[corner]) {
        view.setFloat32(offset, coordinate, true);
        offset += 4;
      }
    }
  });
  return bytes;
}
const objects = (controller: CanonicalWorkspaceController) => controller.getSummary().objectCount;
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
const confirmation = { confirmed: true, acknowledgedNoticeIds: [] } as const;
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('a confirmed import commits as one staged entry after acknowledgement and undoes exactly', async () => {
  const controller = setup();
  try {
    const before = controller.captureProjectExportGuard();
    const prepared = await controller.prepareModelImport(tetrahedron(), { filename: 'tetra.stl' });
    const pending = controller.confirmImport(prepared, confirmation);
    assert.equal(objects(controller), 1, 'nothing applies before acknowledgement');
    const result = await pending;
    assert.equal(objects(controller), 2);
    assert.equal(result.project.revision, controller.getSummary().revision);
    const summary = controller.getSummary();
    assert.equal(summary.history.undoLabel, 'Import tetra.stl');
    assert.notEqual(controller.captureProjectExportGuard().assetFingerprint, before.assetFingerprint);
    assert.throws(() => prepared.cancel(), /committed import cannot be cancelled/);

    assert.equal(await controller.undoAsync(), true);
    assert.equal(objects(controller), 1);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
    assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.assetFingerprint);
    assert.equal(await controller.redoAsync(), true);
    assert.equal(objects(controller), 2);
  } finally {
    controller.dispose();
  }
});

await test('a preview the project moved away from is refused before anything is submitted', async () => {
  const controller = setup();
  try {
    const prepared = await controller.prepareModelImport(tetrahedron(), { filename: 'tetra.stl' });
    controller.setProjectConfig({ edit_probe: 'newer' });
    const undoCount = controller.getSummary().history.undoCount;
    await assert.rejects(controller.confirmImport(prepared, confirmation), StaleImportPreviewError);
    assert.equal(objects(controller), 1);
    assert.equal(controller.getSummary().history.undoCount, undoCount);
    prepared.cancel('stale preview');
  } finally {
    controller.dispose();
  }
});

await test('an edit queued ahead of the commit refuses it instead of rebasing; the preview stays cancellable', async () => {
  const controller = setup();
  try {
    const prepared = await controller.prepareModelImport(tetrahedron(), { filename: 'tetra.stl' });
    const helper = controller.addHelperVolume('support-blocker');
    await assert.rejects(controller.confirmImport(prepared, confirmation), stale);
    await helper;
    assert.equal(objects(controller), 1, 'the queued edit applied; the import did not');
    assert.notEqual(controller.getSummary().history.undoLabel, 'Import tetra.stl');
    prepared.cancel('superseded');
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async import tests passed: ${passed}`);
