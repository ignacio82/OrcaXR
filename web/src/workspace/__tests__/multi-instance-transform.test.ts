import assert from 'node:assert/strict';

import { entityId, identityTransform, type InstanceId, type Transform } from '../../project';
import { projectMultiInstancePrimaryTransform, projectMultiInstanceTransform } from '../multiInstanceTransform';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const FIRST = entityId<'instance'>('import:multi-transform:first');
const SECOND = entityId<'instance'>('import:multi-transform:second');
const THIRD = entityId<'instance'>('import:multi-transform:third');

function transform(
  translationMm: readonly [number, number, number],
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
  scale: readonly [number, number, number] = [1, 1, 1],
): Transform {
  return { translationMm: [...translationMm], rotation: [...rotation], scale: [...scale] };
}

function byId(changes: ReturnType<typeof projectMultiInstanceTransform>, instanceId: InstanceId): Transform {
  const change = changes.find((candidate) => candidate.instanceId === instanceId);
  if (!change) throw new Error(`Missing projected instance ${instanceId}`);
  return change.transform;
}

function close(actual: readonly number[], expected: readonly number[], tolerance = 1e-10): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${value} != ${expected[index]}`),
  );
}

test('moves exactly the captured stable-ID selection by the primary delta', () => {
  const result = projectMultiInstancePrimaryTransform(
    [
      { instanceId: FIRST, transform: transform([10, 20, 0]) },
      { instanceId: SECOND, transform: transform([40, 50, 2]) },
    ],
    FIRST,
    transform([15, 17, 4]),
    'move',
  );
  assert.deepEqual(byId(result, FIRST), transform([15, 17, 4]));
  assert.deepEqual(byId(result, SECOND), transform([45, 47, 6]));
  assert.equal(
    result.some((change) => change.instanceId === THIRD),
    false,
  );
});

test('rotates placements and orientations around the primary pivot without cumulative drift', () => {
  const quarterTurn: readonly [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const result = projectMultiInstancePrimaryTransform(
    [
      { instanceId: FIRST, transform: transform([10, 10, 0]) },
      { instanceId: SECOND, transform: transform([20, 10, 0]) },
    ],
    FIRST,
    transform([10, 10, 0], quarterTurn),
    'rotate',
  );
  close(byId(result, SECOND).translationMm, [10, 20, 0]);
  close(byId(result, SECOND).rotation, quarterTurn);
  assert.deepEqual(byId(result, FIRST), transform([10, 10, 0], quarterTurn));
});

test('applies non-uniform scale in the initial primary local axes', () => {
  const quarterTurn: readonly [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const result = projectMultiInstancePrimaryTransform(
    [
      { instanceId: FIRST, transform: transform([10, 10, 0], quarterTurn) },
      { instanceId: SECOND, transform: transform([10, 20, 0]) },
    ],
    FIRST,
    transform([10, 10, 0], quarterTurn, [2, 1, 1]),
    'scale',
  );
  close(byId(result, SECOND).translationMm, [10, 30, 0]);
  close(byId(result, SECOND).scale, [2, 1, 1]);
  assert.deepEqual(byId(result, FIRST), transform([10, 10, 0], quarterTurn, [2, 1, 1]));
});

test('rotates every instance around an independent selection-bounds pivot', () => {
  const quarterTurn: readonly [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const result = projectMultiInstanceTransform(
    [
      { instanceId: FIRST, transform: transform([10, 10, 0]) },
      { instanceId: SECOND, transform: transform([20, 10, 0]) },
    ],
    transform([15, 10, 0]),
    transform([15, 10, 0], quarterTurn),
    'rotate',
  );
  close(byId(result, FIRST).translationMm, [15, 5, 0]);
  close(byId(result, SECOND).translationMm, [15, 15, 0]);
  close(byId(result, FIRST).rotation, quarterTurn);
  close(byId(result, SECOND).rotation, quarterTurn);
});

test('rejects empty, duplicate, and missing-primary gesture origins', () => {
  assert.throws(
    () => projectMultiInstanceTransform([], identityTransform(), identityTransform(), 'move'),
    /at least one origin/i,
  );
  assert.throws(
    () =>
      projectMultiInstanceTransform(
        [
          { instanceId: FIRST, transform: identityTransform() },
          { instanceId: FIRST, transform: identityTransform() },
        ],
        identityTransform(),
        identityTransform(),
        'move',
      ),
    /duplicate instance/i,
  );
  assert.throws(
    () =>
      projectMultiInstancePrimaryTransform(
        [{ instanceId: SECOND, transform: identityTransform() }],
        FIRST,
        identityTransform(),
        'move',
      ),
    /missing primary instance/i,
  );
});

console.log(`\nMulti-instance transform projection: ${passed} tests passed.`);
