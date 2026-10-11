/**
 * Where the workspace places a model built from a geometry
 * (`geometryBedPlacement`, the body of `OrcaWorkspace.addModelFromGeometry`):
 * centred on the printable area from three's Float32 bounds and resting on the
 * bed, unless the geometry keeps its own printer X/Y or Z.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { primitiveGeometry } from '../../project/objects/primitives';
import { geometryBedPlacement } from '../geometryPlacement';

let passed = 0;
/** A bed from its corner: [x, y] mm. */
const bed = (x: number, y: number) => ({ xMin: 0, yMin: 0, xMax: x, yMax: y });

function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('a primitive lands centred on the printable area and resting on the bed', () => {
  const cube = geometryBedPlacement(primitiveGeometry('cube'), bed(200, 200));
  assert.deepEqual(cube, { translationMm: [100, 100, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  // The U1's printable area starts at 0.5 × 1 mm: centred on its corners'
  // midpoint, not on half its far corner (135.25, 135.5).
  assert.deepEqual(
    geometryBedPlacement(primitiveGeometry('torus'), { xMin: 0.5, yMin: 1, xMax: 270.5, yMax: 271 }).translationMm,
    [135.5, 136, 2.5],
  );
});

test('bounds are the Float32 coordinates three stores', () => {
  // The disc is 0.2 mm thick: its lowest point is Math.fround(-0.1).
  const disc = geometryBedPlacement(primitiveGeometry('disc'), bed(200, 200));
  assert.equal(disc.translationMm[2], -Math.fround(-0.1));
  assert.notEqual(disc.translationMm[2], 0.1);
});

test('a geometry in printer space keeps its own X/Y or Z', () => {
  const geometry = new THREE.BoxGeometry(10, 10, 10).translate(30, 40, 50).toNonIndexed();
  assert.deepEqual(
    geometryBedPlacement(geometry, bed(200, 200), { preservePrinterXY: true }).translationMm,
    [0, 0, -45],
  );
  assert.deepEqual(
    geometryBedPlacement(geometry, bed(200, 200), { preservePrinterZ: true }).translationMm,
    [70, 60, 0],
  );
});

test('an empty geometry has no bounds to place', () => {
  assert.throws(() => geometryBedPlacement(new THREE.BufferGeometry(), bed(200, 200)), /no finite bounds/);
});

console.log(`geometry placement tests passed: ${passed}`);
