/**
 * Facet painting through the guarded asynchronous session route: a stroke
 * waits for acknowledgement; several regions commit as one labelled undo
 * entry, each guarded by the state the one before it leaves; erase-all and
 * a stale stroke behave as the synchronous bus did.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform, type PhysicalFilament } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0xfa1)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const filament = (key: string, toolId: number, color: string): PhysicalFilament => ({
    id: entityId<'physical-filament'>(`import:async-paint:${key}`),
    name: `${key} PLA`,
    toolId,
    material: 'PLA',
    color,
    config: {},
    enabled: true,
  });
  const physical = [filament('red', 0, '#FF0000'), filament('blue', 1, '#0000FF')];
  controller.setSlicingConfiguration({
    printer: { profileId: 'snapmaker-u1', toolCount: 2 },
    config: {},
    filaments: { physical, mixed: [] },
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const imported = controller.importBufferGeometry(geometry, { name: 'Cube', transform: identityTransform() });
  geometry.dispose();
  return { controller, imported, red: physical[0].id, blue: physical[1].id };
}
const colors = (controller: CanonicalWorkspaceController) =>
  controller['session'].project.getSnapshot().state.plates[0].objects[0].volumes[0].annotations.color;
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('a stroke waits for acknowledgement and an identical stroke is a no-op', async () => {
  const { controller, imported, red } = setup();
  try {
    const strokes = controller.createPaintStrokeService();
    const before = controller.getSummary();
    const pending = strokes.submitTriangles({
      volumeId: imported.volumeId,
      triangleIndices: [0, 1, 2],
      value: red,
      mode: 'paint',
    });
    assert.deepEqual(colors(controller), [], 'nothing applies before acknowledgement');
    const applied = await pending;
    assert.equal(applied.status, 'applied');
    assert.equal(applied.status === 'applied' && applied.revision, controller.getSummary().revision);
    assert.deepEqual(colors(controller), [{ value: red, triangles: [0, 1, 2] }]);
    assert.equal(controller.getSummary().history.undoCount, before.history.undoCount + 1);
    const repeat = await strokes.submitTriangles({
      volumeId: imported.volumeId,
      triangleIndices: [0, 1, 2],
      value: red,
      mode: 'paint',
    });
    assert.equal(repeat.status, 'noop');
    assert.equal(controller.getSummary().history.undoCount, before.history.undoCount + 1);
    assert.equal((await strokes.submitClear(imported.volumeId)).status, 'applied');
    assert.deepEqual(colors(controller), []);
  } finally {
    controller.dispose();
  }
});

await test('several regions commit as one labelled undo entry through predicted guards', async () => {
  const { controller, imported, red, blue } = setup();
  try {
    const strokes = controller.createPaintStrokeService();
    const before = controller.getSummary();
    const { result, applied } = await strokes.submitTriangleSet('Smart Paint colour facets', [
      { volumeId: imported.volumeId, triangleIndices: [0, 1, 2, 3], value: red, mode: 'paint' },
      { volumeId: imported.volumeId, triangleIndices: [], value: blue, mode: 'paint' },
      { volumeId: imported.volumeId, triangleIndices: [2, 3, 4], value: blue, mode: 'paint' },
    ]);
    assert.equal(result.status, 'applied');
    assert.deepEqual(applied, [true, false, true]);
    // Canonical order: assignments sorted by value.
    assert.deepEqual(colors(controller), [
      { value: blue, triangles: [2, 3, 4] },
      { value: red, triangles: [0, 1] },
    ]);
    const after = controller.getSummary();
    assert.equal(after.history.undoCount, before.history.undoCount + 1);
    assert.equal(after.history.undoLabel, 'Smart Paint colour facets');
    assert.equal(await controller.undoAsync(), true);
    assert.deepEqual(colors(controller), []);
  } finally {
    controller.dispose();
  }
});

await test('a queued stroke refuses a competing edit instead of rebasing', async () => {
  const { controller, imported, red } = setup();
  try {
    const strokes = controller.createPaintStrokeService();
    const pending = strokes.submitTriangles({
      volumeId: imported.volumeId,
      triangleIndices: [5],
      value: red,
      mode: 'paint',
    });
    controller.setProjectConfig({ edit_probe: 'newer' });
    await assert.rejects(pending, stale);
    assert.deepEqual(colors(controller), []);
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async paint tests passed: ${passed}`);
