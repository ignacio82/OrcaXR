import assert from 'node:assert/strict';

import type { Transform } from '../../project/domain/model';
import {
  eulerFromQuaternion,
  quaternionFromEuler,
  TRANSFORM_FIELD_TITLES,
  transformFieldInput,
  transformFieldText,
  transformFieldValue,
  transformFieldValues,
  withTransformFieldInput,
} from '../TransformFields';
import { printableAreaText, printableHeightMm, wipeTowerKeepOut, workspaceBed } from '../WorkspaceBed';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const u1 = ['0.5x1', '270.5x1', '270.5x271', '0.5x271'];

test('the bed is the far corner of the printable area, which keeps its own origin', () => {
  assert.deepEqual(workspaceBed({ printable_area: u1, printable_height: '250' }), {
    sizeMm: [270.5, 271],
    printableArea: { xMin: 0.5, yMin: 1, xMax: 270.5, yMax: 271 },
    printableHeightMm: 250,
  });
  assert.deepEqual(workspaceBed({ printable_area: u1.join(',') }).sizeMm, [270.5, 271]);
});

test('without a printable area the plate is 200 mm, and no height is none', () => {
  assert.deepEqual(workspaceBed({}), { sizeMm: [200, 200] });
  assert.equal(printableAreaText(['0x0', 5]), '');
  assert.equal(printableHeightMm({ printable_height: '0' }), undefined);
  assert.equal(printableHeightMm({ printable_height: [' 42mm'] }), 42);
});

test('an enabled tower keeps a square of its drawn width clear', () => {
  const tower = { enabled: true, positionMm: [200, 210] as const, rotationDeg: 0 };
  assert.deepEqual(wipeTowerKeepOut({ prime_tower_width: '35' }, tower), {
    minX: 200,
    minY: 210,
    maxX: 235,
    maxY: 245,
  });
  assert.deepEqual(wipeTowerKeepOut({ wipe_tower_width: '0' }, tower), { minX: 200, minY: 210, maxX: 260, maxY: 270 });
  assert.equal(wipeTowerKeepOut({}, { ...tower, enabled: false }), undefined);
  assert.equal(wipeTowerKeepOut({}, undefined), undefined);
});

test('the fields show millimetres, degrees and percent with two decimals', () => {
  const transform: Transform = {
    translationMm: [12.5, -3.25, 0.004999],
    rotation: quaternionFromEuler([Math.PI / 6, 0, Math.PI / 2]),
    scale: [0.5, 2, 1.25],
  };
  assert.deepEqual(transformFieldValues('move', transform).map(transformFieldText), ['12.50', '-3.25', '0.00']);
  assert.deepEqual(transformFieldValues('rotate', transform).map(transformFieldText), ['30.00', '0.00', '90.00']);
  assert.deepEqual(transformFieldValues('scale', transform).map(transformFieldText), ['50.00', '200.00', '125.00']);
  assert.deepEqual(TRANSFORM_FIELD_TITLES, { move: 'Move (mm)', rotate: 'Rotate (deg)', scale: 'Scale (%)' });
});

test('a field edit reads parseFloat and sets the tool part alone', () => {
  assert.deepEqual(['12abc', '', '-0', 'x'].map(transformFieldValue), [12, 0, 0, 0]);
  const base: Transform = { translationMm: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  assert.deepEqual(withTransformFieldInput('scale', base, transformFieldInput('scale', [50, 100, 200])), {
    ...base,
    scale: [0.5, 1, 2],
  });
  const turned = withTransformFieldInput('rotate', base, transformFieldInput('rotate', [0, 0, 90]));
  assert.deepEqual(turned.translationMm, [1, 2, 3]);
  const [x, y, z] = eulerFromQuaternion(turned.rotation);
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12 && Math.abs(z - Math.PI / 2) < 1e-12);
});

console.log(`workspace-bed-fields: ${passed} passed`);
