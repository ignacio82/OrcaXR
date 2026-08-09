import assert from 'node:assert/strict';

import { IDENTITY_TRANSFORM, type Quaternion, type Transform, type Vec3 } from '../../domain/model';
import {
  ASSEMBLY_ALIGNMENT_EPSILON,
  AssemblyError,
  PINNED_ASSEMBLY_SOURCE,
  inspectAssemblyActions,
  planAssemblyAlignment,
  projectExplosion,
} from '../assembly';
import type { SurfaceFeature } from '../measure';
import { rotateVector } from '../transformOperations';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const plane = (normal: Vec3, origin: Vec3, index = 0): SurfaceFeature => ({ kind: 'plane', index, normal, origin });
const edge = (from: Vec3, to: Vec3): SurfaceFeature => ({ kind: 'edge', from, to });

function transform(overrides: Partial<Transform> = {}): Transform {
  return { ...IDENTITY_TRANSFORM, ...overrides };
}

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} within ${tolerance}, received ${actual}`);
}

function closeVec(actual: Vec3, expected: Vec3, tolerance = 1e-9): void {
  for (let axis = 0; axis < 3; axis += 1) close(actual[axis], expected[axis], tolerance);
}

test('availability mirrors the pinned plane-pair rules', () => {
  assert.equal(PINNED_ASSEMBLY_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');

  // Facing planes 5 mm apart: parallel is already satisfied, distance is live.
  const facing = inspectAssemblyActions(plane([0, 0, 1], [0, 0, 0]), plane([0, 0, -1], [0, 0, 5]));
  assert.equal(facing.canSetToParallel, false, 'parallel planes cannot be made parallel again');
  assert.equal(facing.hasParallelDistance, true);
  close(facing.parallelDistanceMm, 5);
  assert.equal(facing.canRotateAroundFaceCenter, true);
  assert.equal(facing.canSetToCenterCoincidence, true);
  close(facing.angleRadians, 0);

  // Below the reference plane the signed distance flips.
  close(inspectAssemblyActions(plane([0, 0, 1], [0, 0, 0]), plane([0, 0, 1], [0, 0, -3])).parallelDistanceMm, -3);

  const crossing = inspectAssemblyActions(plane([0, 0, 1], [0, 0, 0]), plane([1, 0, 0], [4, 0, 0], 1));
  assert.equal(crossing.canSetToParallel, true);
  assert.equal(crossing.hasParallelDistance, false);
  assert.equal(crossing.canRotateAroundFaceCenter, false);
  close(crossing.angleRadians, Math.PI / 2);

  // Anything that is not a plane pair offers nothing but reversing feature 1.
  const mixed = inspectAssemblyActions(plane([0, 0, 1], [0, 0, 0]), edge([0, 0, 0], [1, 0, 0]));
  assert.equal(mixed.canSetToParallel, false);
  assert.equal(mixed.canSetToCenterCoincidence, false);
  assert.equal(mixed.canReverseFeature1, true);
  const neither = inspectAssemblyActions(edge([0, 0, 0], [1, 0, 0]), edge([0, 1, 0], [1, 1, 0]));
  assert.equal(neither.canReverseFeature1, false);
});

test('parallel turns the moving face to meet the fixed one', () => {
  const plan = planAssemblyAlignment({
    kind: 'parallel',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([1, 0, 0], [4, 0, 0], 1),
    movingTransform: transform(),
  });
  assert.equal(plan.noop, false);
  // The moving normal +X must end up on -Z, the reverse of the fixed normal.
  closeVec(rotateVector([1, 0, 0], plan.transform.rotation), [0, 0, -1], 1e-12);
  closeVec(plan.transform.translationMm, [0, 0, 0], 1e-12);
});

test('an already-aligned pair is a no-op rather than a rounding nudge', () => {
  const before = transform({ translationMm: [7, 8, 9] });
  assert.throws(
    () =>
      planAssemblyAlignment({
        kind: 'parallel',
        first: plane([0, 0, 1], [0, 0, 0]),
        second: plane([0, 0, -1], [0, 0, 5]),
        movingTransform: before,
      }),
    (error: unknown) => error instanceof AssemblyError && error.code === 'unavailable-action',
  );

  // Centre coincidence on an already anti-parallel pair only closes the gap.
  const plan = planAssemblyAlignment({
    kind: 'center-coincidence',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([0, 0, -1], [0, 0, 5]),
    movingTransform: before,
  });
  closeVec(plan.transform.translationMm, [7, 8, 4], 1e-9);
  assert.deepEqual(plan.transform.rotation, before.rotation, 'no rotation is applied when already anti-parallel');
});

test('centre coincidence brings the faces together after turning them', () => {
  const plan = planAssemblyAlignment({
    kind: 'center-coincidence',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([0, 0, 1], [10, 0, 6], 1),
    movingTransform: transform(),
  });
  // +Z must end up on -Z, and the face centre must land on the fixed centre.
  closeVec(rotateVector([0, 0, 1], plan.transform.rotation), [0, 0, -1], 1e-9);
  const movedCentre = [
    plan.transform.translationMm[0] + rotateVector([10, 0, 6], plan.transform.rotation)[0],
    plan.transform.translationMm[1] + rotateVector([10, 0, 6], plan.transform.rotation)[1],
    plan.transform.translationMm[2] + rotateVector([10, 0, 6], plan.transform.rotation)[2],
  ] as Vec3;
  closeVec(movedCentre, [0, 0, 0], 1e-9);
});

test('parallel distance places the moving face at an exact signed offset', () => {
  const moving = plane([0, 0, -1], [0, 0, 5], 1);
  for (const distance of [2, 0, -4]) {
    const plan = planAssemblyAlignment({
      kind: 'parallel-distance',
      first: plane([0, 0, 1], [0, 0, 0]),
      second: moving,
      movingTransform: transform({ translationMm: [1, 2, 3] }),
      parameter: distance,
    });
    // The face sat at z=5; it must end up exactly `distance` along +Z from z=0.
    close(plan.transform.translationMm[2], 3 + (distance - 5), 1e-9);
    closeVec([plan.transform.translationMm[0], plan.transform.translationMm[1], 0], [1, 2, 0], 1e-12);
  }

  assert.throws(
    () =>
      planAssemblyAlignment({
        kind: 'parallel-distance',
        first: plane([0, 0, 1], [0, 0, 0]),
        second: moving,
        movingTransform: transform(),
        parameter: Number.NaN,
      }),
    (error: unknown) => error instanceof AssemblyError && error.code === 'invalid-parameter',
  );
  assert.throws(
    () =>
      planAssemblyAlignment({
        kind: 'parallel-distance',
        first: plane([0, 0, 1], [0, 0, 0]),
        second: plane([1, 0, 0], [4, 0, 0], 1),
        movingTransform: transform(),
        parameter: 1,
      }),
    (error: unknown) => error instanceof AssemblyError && error.code === 'unavailable-action',
    'a crossing pair has no parallel distance to set',
  );
});

test('reverse rotation is a half turn about an in-plane axis through the face centre', () => {
  const face = plane([0, 0, 1], [0, 0, 0], 1);
  const plan = planAssemblyAlignment({
    kind: 'reverse-rotation',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: face,
    movingTransform: transform({ translationMm: [0, 0, 4] }),
    reverseFeature: 2,
  });
  // A half turn about an axis lying in the z=0 plane flips +Z to -Z...
  closeVec(rotateVector([0, 0, 1], plan.transform.rotation), [0, 0, -1], 1e-9);
  // ...and mirrors the instance origin through that plane.
  close(plan.transform.translationMm[2], -4, 1e-9);
});

test('rotating around the face centre keeps the face put and turns by the exact angle', () => {
  const plan = planAssemblyAlignment({
    kind: 'around-face-center',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([0, 0, 1], [0, 0, 0], 1),
    movingTransform: transform({ translationMm: [5, 0, 0] }),
    parameter: 90,
  });
  // A quarter turn about +Z through the origin sends (5,0,0) to (0,5,0).
  closeVec(plan.transform.translationMm, [0, 5, 0], 1e-9);
  closeVec(rotateVector([1, 0, 0], plan.transform.rotation), [0, 1, 0], 1e-9);
  assert.equal(plan.noop, false);

  const still = planAssemblyAlignment({
    kind: 'around-face-center',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([0, 0, 1], [0, 0, 0], 1),
    movingTransform: transform({ translationMm: [5, 0, 0] }),
    parameter: 0,
  });
  assert.equal(still.noop, true);
  assert.ok(ASSEMBLY_ALIGNMENT_EPSILON > 0);
});

test('explosion is view-only, centred, and identity at factor 1', () => {
  const parts = [
    { id: 'a', centerMm: [0, 0, 0] as Vec3 },
    { id: 'b', centerMm: [10, 0, 0] as Vec3 },
  ];
  const unexploded = projectExplosion(parts, 1);
  for (const offset of unexploded) closeVec(offset.offsetMm, [0, 0, 0]);

  const exploded = projectExplosion(parts, 2);
  // The centroid is (5,0,0); each part moves one more centroid-radius outward.
  closeVec(exploded[0].offsetMm, [-5, 0, 0]);
  closeVec(exploded[1].offsetMm, [5, 0, 0]);
  assert.deepEqual(
    exploded.map((offset) => offset.id),
    ['a', 'b'],
  );

  assert.deepEqual(projectExplosion([], 3), []);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => projectExplosion(parts, bad),
      (error: unknown) => error instanceof AssemblyError && error.code === 'invalid-parameter',
    );
  }
});

test('a non-plane first feature and a degenerate normal fail closed', () => {
  assert.throws(
    () =>
      planAssemblyAlignment({
        kind: 'parallel',
        first: edge([0, 0, 0], [1, 0, 0]),
        second: plane([0, 0, 1], [0, 0, 0]),
        movingTransform: transform(),
      }),
    (error: unknown) => error instanceof AssemblyError && error.code === 'unsupported-feature-pair',
  );
  assert.throws(
    () =>
      planAssemblyAlignment({
        kind: 'reverse-rotation',
        first: plane([0, 0, 0], [0, 0, 0]),
        second: plane([0, 0, 1], [0, 0, 0], 1),
        movingTransform: transform(),
        reverseFeature: 1,
      }),
    (error: unknown) => error instanceof AssemblyError && error.code === 'degenerate-axis',
  );
});

test('an alignment composes onto an already-rotated instance', () => {
  // A quarter turn about +Z already applied to the moving instance.
  const quarter: Quaternion = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as unknown as Quaternion;
  const plan = planAssemblyAlignment({
    kind: 'parallel',
    first: plane([0, 0, 1], [0, 0, 0]),
    second: plane([1, 0, 0], [4, 0, 0], 1),
    movingTransform: transform({ rotation: quarter }),
  });
  // The guarantee is world-space: the picked face normal (already world +X)
  // must end up on -Z. Under the composed rotation that means the *local*
  // direction which currently maps to world +X lands on -Z.
  const inverseQuarter: Quaternion = [0, 0, -Math.SQRT1_2, Math.SQRT1_2] as unknown as Quaternion;
  const localOfWorldX = rotateVector([1, 0, 0], inverseQuarter);
  closeVec(rotateVector(localOfWorldX, plan.transform.rotation), [0, 0, -1], 1e-9);
  assert.notDeepEqual(plan.transform.rotation, quarter, 'the delta really composed');
});

console.log(`\nCanonical assembly: ${passed} tests passed.`);
