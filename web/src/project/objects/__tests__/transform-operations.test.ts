import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../../assets';
import { entityId, seededRandom, UuidIdSource, type InstanceId } from '../../domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
  type ProjectState,
  type Transform,
} from '../../domain/model';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { computeCanonicalInstanceBounds } from '../bounds';
import {
  TransformOperationError,
  centerInstancesOnPlate,
  layInstanceOnFace,
  mirrorInstances,
  quaternionBetween,
  resetInstanceRotations,
  resetInstanceScales,
  rotateVector,
} from '../transformOperations';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A 20 mm cube whose local origin is its minimum corner. */
function cubeAsset(id: string) {
  const [a, b] = [0, 20];
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>(id),
    positions: [a, a, a, b, a, a, b, b, a, a, b, a, a, a, b, b, a, b, b, b, b, a, b, b],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ],
    sourceFilename: 'cube.stl',
  });
}

function createProject(count = 1) {
  const ids = new UuidIdSource(seededRandom(0x51a7));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-08T00:00:00.000Z' });
  const assets = new InMemoryAssetRepository();
  const asset = cubeAsset('import:test:cube');
  state.sourceAssets.push(asset.descriptor);
  assets.put(asset.descriptor, asset.bytes);
  const instanceIds: InstanceId[] = [];
  for (let index = 0; index < count; index += 1) {
    const instanceId = ids.next<'instance'>('instance');
    instanceIds.push(instanceId);
    state.plates[0].objects.push({
      id: ids.next('object'),
      name: `Cube ${index + 1}`,
      config: {},
      volumes: [
        {
          id: ids.next('volume'),
          name: 'Body',
          role: 'model',
          source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 12 },
          transform: identityTransform(),
          config: {},
          annotations: emptyFacetAnnotations(),
        },
      ],
      instances: [
        {
          id: instanceId,
          transform: { translationMm: [index * 40, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          printable: true,
        },
      ],
      layerRanges: [],
    });
  }
  return { state, assets, instanceIds };
}

function applyChange(state: ProjectState, instanceId: InstanceId, transform: Transform): ProjectState {
  const next: ProjectState = structuredClone(state);
  for (const plate of next.plates) {
    for (const object of plate.objects) {
      for (const instance of object.instances) {
        if (instance.id === instanceId) instance.transform = transform;
      }
    }
  }
  return next;
}

test('mirrors on one axis by negating exactly that scale component', () => {
  const { state, instanceIds } = createProject();
  const [change] = mirrorInstances(state, instanceIds, 'x');
  assert.deepEqual(change.transform.scale, [-1, 1, 1]);
  assert.deepEqual(change.transform.rotation, [0, 0, 0, 1], 'mirroring never rotates');
  assert.deepEqual(change.transform.translationMm, [0, 0, 0], 'mirroring never moves the instance');

  const mirrored = applyChange(state, instanceIds[0], change.transform);
  const [back] = mirrorInstances(mirrored, instanceIds, 'x');
  assert.deepEqual(back.transform.scale, [1, 1, 1], 'mirroring twice returns to the original');
  assert.throws(
    () => mirrorInstances(state, instanceIds, 'w' as never),
    (error: unknown) => error instanceof TransformOperationError && error.code === 'invalid-axis',
  );
});

test('resets rotation and scale independently', () => {
  const { state, instanceIds } = createProject();
  const spun = applyChange(state, instanceIds[0], {
    translationMm: [5, 6, 7],
    rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
    scale: [2, 2, 3],
  });
  const [rotationReset] = resetInstanceRotations(spun, instanceIds);
  assert.deepEqual(rotationReset.transform.rotation, [0, 0, 0, 1]);
  assert.deepEqual(rotationReset.transform.scale, [2, 2, 3], 'resetting rotation keeps scale');
  assert.deepEqual(rotationReset.transform.translationMm, [5, 6, 7]);

  const [scaleReset] = resetInstanceScales(spun, instanceIds);
  assert.deepEqual(scaleReset.transform.scale, [1, 1, 1]);
  assert.deepEqual(scaleReset.transform.rotation, spun.plates[0].objects[0].instances[0].transform.rotation);
});

test('centres a multi-instance selection while preserving relative layout', () => {
  const { state, assets, instanceIds } = createProject(2);
  const changes = centerInstancesOnPlate(state, assets, instanceIds, [200, 200]);
  assert.equal(changes.length, 2);
  const deltas = changes.map((change, index) => change.transform.translationMm[0] - index * 40);
  assert.ok(Math.abs(deltas[0] - deltas[1]) < 1e-9, 'every instance moves by the same delta');

  let centred = state;
  for (const change of changes) centred = applyChange(centred, change.instanceId, change.transform);
  const bounds = computeCanonicalInstanceBounds(centred, assets, instanceIds, { volumeRoles: ['model'] });
  assert.ok(Math.abs((bounds.min[0] + bounds.max[0]) / 2 - 100) < 1e-6);
  assert.ok(Math.abs((bounds.min[1] + bounds.max[1]) / 2 - 100) < 1e-6);
  assert.throws(
    () => centerInstancesOnPlate(state, assets, instanceIds, [0, 200]),
    (error: unknown) => error instanceof TransformOperationError && error.code === 'invalid-bed',
  );
});

test('lays a chosen facet on the bed and rests the instance on Z=0', () => {
  const { state, assets, instanceIds } = createProject();
  const lifted = applyChange(state, instanceIds[0], {
    translationMm: [10, 10, 35],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  // Lay the +X face down: it must end up pointing at the bed.
  const [change] = layInstanceOnFace(lifted, assets, { instanceId: instanceIds[0], localNormal: [1, 0, 0] });
  const laid = applyChange(lifted, instanceIds[0], change.transform);
  const normal = rotateVector([1, 0, 0], change.transform.rotation);
  assert.ok(Math.abs(normal[0]) < 1e-6 && Math.abs(normal[1]) < 1e-6, 'the facet normal becomes vertical');
  assert.ok(normal[2] < -0.999, 'the facet normal points down at the bed');
  const bounds = computeCanonicalInstanceBounds(laid, assets, instanceIds, { volumeRoles: ['model'] });
  assert.ok(Math.abs(bounds.min[2]) < 1e-6, 'the laid instance rests on the bed');
  assert.deepEqual(
    change.transform.translationMm.slice(0, 2),
    [10, 10],
    'laying a face never moves the instance in XY',
  );
});

test('handles an already-down facet and rejects a degenerate normal', () => {
  const { state, assets, instanceIds } = createProject();
  const [change] = layInstanceOnFace(state, assets, { instanceId: instanceIds[0], localNormal: [0, 0, -1] });
  assert.deepEqual(change.transform.rotation, [0, 0, 0, 1], 'a face already on the bed needs no rotation');
  assert.throws(
    () => layInstanceOnFace(state, assets, { instanceId: instanceIds[0], localNormal: [0, 0, 0] }),
    (error: unknown) => error instanceof TransformOperationError && error.code === 'invalid-normal',
  );
  assert.throws(
    () =>
      layInstanceOnFace(state, assets, {
        instanceId: entityId<'instance'>('import:test:missing'),
        localNormal: [0, 0, 1],
      }),
    (error: unknown) => error instanceof TransformOperationError && error.code === 'unknown-instance',
  );
});

test('quaternionBetween produces a deterministic 180-degree turn for opposite vectors', () => {
  const flip = quaternionBetween([0, 0, 1], [0, 0, -1]);
  const rotated = rotateVector([0, 0, 1], flip);
  assert.ok(Math.abs(rotated[2] + 1) < 1e-9, 'the vector is fully reversed');
  assert.deepEqual(flip, quaternionBetween([0, 0, 1], [0, 0, -1]), 'the axis choice is deterministic');
});

console.log(`\nCanonical transform operations: ${passed} tests passed.`);
