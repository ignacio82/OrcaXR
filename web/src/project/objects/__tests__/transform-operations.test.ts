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
  scaleInstancesToFitPrintVolume,
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

test('scale to build volume fills the volume, centres it, and sits it on the bed', () => {
  const { state, assets, instanceIds } = createProject();
  const volume = { x: 200, y: 200, z: 250 };
  const changes = scaleInstancesToFitPrintVolume(state, assets, instanceIds, volume);
  assert.equal(changes.length, 1);

  const scaled = applyChange(state, instanceIds[0], changes[0].transform);
  const bounds = computeCanonicalInstanceBounds(scaled, assets, instanceIds, { volumeRoles: ['model'] });
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];

  // The 20 mm cube grows until its limiting axis fills the volume. Upstream
  // adds a hundredth of a millimetre on each side before dividing, so the
  // result lands just inside rather than exactly on the wall.
  assert.ok(size[0] < volume.x && size[0] > volume.x - 0.5, `x filled to ${size[0]}`);
  assert.ok(size[1] < volume.y && size[1] > volume.y - 0.5, `y filled to ${size[1]}`);
  assert.ok(size[2] <= volume.z, `z stayed inside at ${size[2]}`);
  assert.ok(Math.abs(size[0] - size[1]) < 1e-6 && Math.abs(size[1] - size[2]) < 1e-6, 'the scale stayed uniform');

  assert.ok(Math.abs(bounds.min[2]) < 1e-6, `the result sits on the bed, not at ${bounds.min[2]}`);
  assert.ok(Math.abs((bounds.min[0] + bounds.max[0]) / 2 - volume.x / 2) < 1e-6, 'centred in X');
  assert.ok(Math.abs((bounds.min[1] + bounds.max[1]) / 2 - volume.y / 2) < 1e-6, 'centred in Y');
});

test('a short machine limits the factor, and the model still fits', () => {
  const { state, assets, instanceIds } = createProject();
  // The reason the build height is read from the profile rather than assumed: a
  // factor computed against a taller machine scales a model into the gantry.
  const volume = { x: 300, y: 300, z: 60 };
  const [change] = scaleInstancesToFitPrintVolume(state, assets, instanceIds, volume);
  const scaled = applyChange(state, instanceIds[0], change.transform);
  const bounds = computeCanonicalInstanceBounds(scaled, assets, instanceIds, { volumeRoles: ['model'] });
  assert.ok(bounds.max[2] <= volume.z, `height ${bounds.max[2]} exceeds the ${volume.z} mm ceiling`);
  assert.ok(bounds.max[2] > volume.z - 0.5, 'and it is the axis that limited the factor');
  assert.ok(bounds.max[0] - bounds.min[0] < volume.x, 'so the footprint is well inside the bed');
});

test('several models keep their layout, and scale about the selection', () => {
  const { state, assets, instanceIds } = createProject(3);
  const before = computeCanonicalInstanceBounds(state, assets, instanceIds, { volumeRoles: ['model'] });
  const volume = { x: 200, y: 200, z: 250 };
  const changes = scaleInstancesToFitPrintVolume(state, assets, instanceIds, volume);
  assert.equal(changes.length, 3);

  let scaled = state;
  for (const change of changes) scaled = applyChange(scaled, change.instanceId, change.transform);
  const after = computeCanonicalInstanceBounds(scaled, assets, instanceIds, { volumeRoles: ['model'] });

  const factor = changes[0].transform.scale[0];
  const widthBefore = before.max[0] - before.min[0];
  const widthAfter = after.max[0] - after.min[0];
  assert.ok(Math.abs(widthAfter - widthBefore * factor) < 1e-6, 'the whole selection scaled by one factor');
  assert.ok(widthAfter < volume.x + 1e-6, 'and the row still fits the bed');
  for (const change of changes) {
    assert.deepEqual(change.transform.scale, changes[0].transform.scale, 'every instance took the same factor');
  }
  // Relative spacing is preserved, which is what "about the selection" means:
  // the gap between neighbours grew by exactly the same factor.
  const gapBefore = 40;
  const gapAfter = changes[1].transform.translationMm[0] - changes[0].transform.translationMm[0];
  assert.ok(Math.abs(gapAfter - gapBefore * factor) < 1e-6, `spacing became ${gapAfter}`);
});

test('an exact fit produces no changes, and a bad volume is refused', () => {
  const { state, assets, instanceIds } = createProject();
  // 20 mm cube plus upstream's 0.02 mm tolerance: the factor is exactly 1.
  const exact = scaleInstancesToFitPrintVolume(state, assets, instanceIds, { x: 20.02, y: 20.02, z: 20.02 });
  assert.deepEqual(exact, [], 'an undo entry that restores the same project teaches people undo is unreliable');

  for (const volume of [
    { x: 0, y: 200, z: 200 },
    { x: 200, y: -1, z: 200 },
    { x: 200, y: 200, z: Number.NaN },
  ]) {
    assert.throws(
      () => scaleInstancesToFitPrintVolume(state, assets, instanceIds, volume),
      (error: unknown) => error instanceof TransformOperationError && error.code === 'invalid-bed',
      `${JSON.stringify(volume)} should be refused`,
    );
  }
  assert.throws(
    () => scaleInstancesToFitPrintVolume(state, assets, [], { x: 200, y: 200, z: 200 }),
    (error: unknown) => error instanceof TransformOperationError && error.code === 'empty-selection',
  );
});

console.log(`\nCanonical transform operations: ${passed} tests passed.`);
