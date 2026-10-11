/**
 * An imported model splits: `ModelImportParser` gives every object it imports
 * its provenance (`orcaxr:importSource`), which Split to Parts keeps with the
 * object and Split to Objects copies to every object it makes. Any other
 * object extension key still refuses the promotion, never the parts split.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { seededRandom, UuidIdSource, type InstanceId } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { splitSourceOf } from '../SplitSource';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** A binary STL of two separate tetrahedra, 15 mm apart: one mesh, two bodies. */
function twoBodies(): Uint8Array {
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
  const bytes = new Uint8Array(84 + faces.length * 2 * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, faces.length * 2, true);
  [0, 15].forEach((shift, body) =>
    faces.forEach((face, index) => {
      let offset = 84 + (body * faces.length + index) * 50 + 12;
      for (const corner of face) {
        corners[corner].forEach((coordinate, axis) => {
          view.setFloat32(offset, axis === 0 ? coordinate + shift : coordinate, true);
          offset += 4;
        });
      }
    }),
  );
  return bytes;
}

/** A workspace with pair.stl imported through the production model import, its instance selected. */
async function imported(): Promise<{ controller: CanonicalWorkspaceController; instanceId: InstanceId }> {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x5e17)),
    clock: () => '2026-10-11T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const prepared = await controller.prepareModelImport(twoBodies(), { filename: 'pair.stl' });
  await controller.confirmImport(prepared, { confirmed: true, acknowledgedNoticeIds: [] });
  const [object] = controller.createCanonicalSliceSource().capture().state.plates[0].objects;
  assert.ok(object.extensionData?.['orcaxr:importSource'], 'the import records where the object came from');
  const instanceId = object.instances[0].id;
  controller.selectInstance(instanceId);
  return { controller, instanceId };
}

const objects = (controller: CanonicalWorkspaceController) =>
  controller.createCanonicalSliceSource().capture().state.plates[0].objects;

await test('an imported STL with two bodies splits to parts, its object keeping its provenance', async () => {
  const { controller } = await imported();
  try {
    const [before] = objects(controller);
    const split = await controller.splitSelectedToParts();
    assert.equal(split.partCount, 2);
    const [after] = objects(controller);
    assert.equal(after.id, before.id);
    assert.equal(after.volumes.length, 2);
    assert.deepEqual(after.extensionData, before.extensionData);
  } finally {
    controller.dispose();
  }
});

await test('an imported STL with two bodies splits to objects, each keeping a copy of its provenance', async () => {
  const { controller } = await imported();
  try {
    const [source] = objects(controller);
    const confirmation = controller.getSplitToObjectsConfirmation();
    assert.equal(confirmation.strategy, 'connected-components');
    const result = await controller.splitSelectedToObjects(confirmation.guard);
    assert.equal(result.objectIds.length, 2);
    const split = objects(controller);
    assert.deepEqual(
      split.map((object) => object.id),
      result.objectIds,
    );
    for (const object of split) assert.deepEqual(object.extensionData, source.extensionData);
    // Undone, the imported object is back as it was.
    assert.equal(await controller.undoAsync(), true);
    assert.deepEqual(objects(controller), [source]);
  } finally {
    controller.dispose();
  }
});

await test('its parts promote to objects, each keeping a copy of its provenance', async () => {
  const { controller } = await imported();
  try {
    const [source] = objects(controller);
    await controller.splitSelectedToParts();
    const confirmation = controller.getSplitToObjectsConfirmation();
    assert.equal(confirmation.strategy, 'existing-volumes');
    const result = await controller.splitSelectedToObjects(confirmation.guard);
    assert.equal(result.objectIds.length, 2);
    for (const object of objects(controller)) assert.deepEqual(object.extensionData, source.extensionData);
  } finally {
    controller.dispose();
  }
});

await test('an unknown object extension key refuses Split to Objects, never Split to Parts', async () => {
  const { controller, instanceId } = await imported();
  try {
    const state = structuredClone(controller.createCanonicalSliceSource().capture().state);
    const [object] = state.plates[0].objects;
    object.extensionData = { ...object.extensionData, 'https://example.org/kept': { note: 'kept' } };
    assert.throws(
      () => splitSourceOf(state, instanceId, 'objects', 50_000),
      /Split to Objects requires an explicit object-extension distribution before promotion/,
    );
    assert.equal(splitSourceOf(state, instanceId, 'parts', 50_000).objectId, object.id);
    // Height ranges are the object's too: only the promotion refuses them.
    object.layerRanges = [{ id: 'import:range:kept' as never, minZMm: 0, maxZMm: 5, config: {} }];
    assert.throws(() => splitSourceOf(state, instanceId, 'objects', 50_000), /layer-range distribution/);
    assert.equal(splitSourceOf(state, instanceId, 'parts', 50_000).objectId, object.id);
  } finally {
    controller.dispose();
  }
});

console.log(`\nSplit an imported model: ${passed} tests passed.`);
