import assert from 'node:assert/strict';

import type { Transform } from '../../domain/model';
import { placePaintHit } from '../PaintPlacement';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const transform = (fields: Partial<Transform> = {}): Transform => ({
  translationMm: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  ...fields,
});
const turn = (axis: [number, number, number], angle: number): [number, number, number, number] => {
  const length = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const close = (values: readonly number[], expected: readonly number[]) =>
  values.every((value, i) => Math.abs(value - expected[i]) < 1e-12);

test('a uniform 200% instance agrees on every axis, so the brush divides by 2, and the band starts at the bed Z', () => {
  const placed = placePaintHit(
    {
      instance: transform({ translationMm: [10, 0, 1], rotation: turn([0, 0, 1], 0.6), scale: [2, 2, 2] }),
      volume: transform(),
    },
    [1, 2, 3],
  )!;
  assert.ok(close(placed.transform.scalingFactors, [2, 2, 2]), String(placed.transform.scalingFactors));
  assert.equal(placed.plateZMm, 7);
  assert.deepEqual(placed.transform.translation, [10, 0, 1]);
});

test('a stretch along a turned part is not mistaken for a uniform scale', () => {
  // The part turned so the instance's (2, 1, 1) stretch runs along its own
  // (1, 1, 1) diagonal: the diagonal of Orca's polar scale factor reads
  // (4/3, 4/3, 4/3) there; the singular values keep it non-uniform, so the
  // selector works on the bed.
  const placed = placePaintHit(
    {
      instance: transform({ scale: [2, 1, 1] }),
      volume: transform({ rotation: turn([0, 1, -1], Math.acos(1 / Math.sqrt(3))) }),
    },
    [0, 0, 0],
  )!;
  assert.ok(close(placed.transform.scalingFactors, [2, 1, 1]), String(placed.transform.scalingFactors));
});

test('a mirrored uniform scale is the same size every way; a flat part places nothing', () => {
  const mirrored = placePaintHit(
    { instance: transform({ scale: [-1.5, 1.5, 1.5] }), volume: transform() },
    [0, 0, -2],
  )!;
  assert.ok(close(mirrored.transform.scalingFactors, [1.5, 1.5, 1.5]));
  assert.equal(mirrored.plateZMm, -3);
  assert.equal(placePaintHit({ instance: transform({ scale: [1, 0, 1] }), volume: transform() }, [0, 0, 0]), undefined);
});

console.log(`\nPaint placement: ${passed} tests passed.`);
