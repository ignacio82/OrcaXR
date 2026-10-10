/**
 * Where the workspace places a model built from a geometry
 * (`geometryBedPlacement`, the body of `OrcaWorkspace.addModelFromGeometry`):
 * centred on the bed from three's Float32 bounds and resting on it, unless the
 * geometry keeps its own printer X/Y or Z.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { primitiveGeometry } from '../../project/objects/primitives';
import { geometryBedPlacement } from '../geometryPlacement';

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('a primitive lands centred on the bed and resting on it', () => {
  const cube = geometryBedPlacement(primitiveGeometry('cube'), { x: 200, y: 200 });
  assert.deepEqual(cube, { translationMm: [100, 100, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  // The U1's bed: centred on its far corner's half, whatever the printable origin.
  assert.deepEqual(
    geometryBedPlacement(primitiveGeometry('torus'), { x: 270.5, y: 271 }).translationMm,
    [135.25, 135.5, 2.5],
  );
});

test('bounds are the Float32 coordinates three stores', () => {
  // The disc is 0.2 mm thick: its lowest point is Math.fround(-0.1).
  const disc = geometryBedPlacement(primitiveGeometry('disc'), { x: 200, y: 200 });
  assert.equal(disc.translationMm[2], -Math.fround(-0.1));
  assert.notEqual(disc.translationMm[2], 0.1);
});

test('a geometry in printer space keeps its own X/Y or Z', () => {
  const geometry = new THREE.BoxGeometry(10, 10, 10).translate(30, 40, 50).toNonIndexed();
  assert.deepEqual(
    geometryBedPlacement(geometry, { x: 200, y: 200 }, { preservePrinterXY: true }).translationMm,
    [0, 0, -45],
  );
  assert.deepEqual(
    geometryBedPlacement(geometry, { x: 200, y: 200 }, { preservePrinterZ: true }).translationMm,
    [70, 60, 0],
  );
});

test('an empty geometry has no bounds to place', () => {
  assert.throws(() => geometryBedPlacement(new THREE.BufferGeometry(), { x: 200, y: 200 }), /no finite bounds/);
});

console.log(`geometry placement tests passed: ${passed}`);
