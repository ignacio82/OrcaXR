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
import { ArrangeConstraintError, arrangementTransformChanges, planPlateArrangement } from '../arrange';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Axis-aligned box footprint of `size` mm starting at the local origin. */
function boxAsset(id: string, size: number) {
  const [a, b] = [0, size];
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>(id),
    positions: [a, a, a, b, a, a, b, b, a, a, b, a, a, a, b, b, a, b, b, b, b, a, b, b],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ],
    sourceFilename: `${id}.stl`,
  });
}

function translation(x: number, y: number, z = 0): Transform {
  return { translationMm: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function createProject(sizes: readonly { size: number; at: readonly [number, number] }[]) {
  const ids = new UuidIdSource(seededRandom(0x4a12));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-08T00:00:00.000Z' });
  const assets = new InMemoryAssetRepository();
  const instanceIds: InstanceId[] = [];
  sizes.forEach((entry, index) => {
    const asset = boxAsset(`import:test:box-${entry.size}`, entry.size);
    if (!state.sourceAssets.some((descriptor) => descriptor.id === asset.descriptor.id)) {
      state.sourceAssets.push(asset.descriptor);
      assets.put(asset.descriptor, asset.bytes);
    }
    const instanceId = ids.next<'instance'>('instance');
    instanceIds.push(instanceId);
    state.plates[0].objects.push({
      id: ids.next('object'),
      name: `Box ${index + 1}`,
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
      instances: [{ id: instanceId, transform: translation(entry.at[0], entry.at[1]), printable: true }],
      layerRanges: [],
    });
  });
  return { state, assets, instanceIds, plateId: state.plates[0].id };
}

const BED: readonly [number, number] = [200, 200];

test('packs overlapping instances into a deterministic non-overlapping layout', () => {
  const { state, assets, plateId } = createProject([
    { size: 40, at: [10, 10] },
    { size: 30, at: [12, 12] },
    { size: 50, at: [14, 14] },
  ]);
  const first = planPlateArrangement(state, assets, plateId, { bedSizeMm: BED });
  const again = planPlateArrangement(state, assets, plateId, { bedSizeMm: BED });
  assert.deepEqual(first, again, 'the same project always produces the same layout');
  assert.equal(first.unplacedInstanceIds.length, 0);
  assert.equal(first.placements.length, 3);

  const footprints = first.placements.map((placement) => placement.footprint);
  for (let left = 0; left < footprints.length; left += 1) {
    for (let right = left + 1; right < footprints.length; right += 1) {
      const a = footprints[left];
      const b = footprints[right];
      const separated = a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;
      assert.ok(separated, 'arranged footprints never intersect');
    }
  }
  for (const footprint of footprints) {
    assert.ok(footprint.minX >= 2 && footprint.minY >= 2, 'placements respect the bed margin');
    assert.ok(footprint.maxX <= 198 && footprint.maxY <= 198, 'placements stay inside the printable area');
  }
});

test('centres the packed block on an otherwise empty plate', () => {
  const { state, assets, plateId } = createProject([
    { size: 40, at: [0, 0] },
    { size: 40, at: [1, 1] },
  ]);
  const result = planPlateArrangement(state, assets, plateId, { bedSizeMm: BED });
  const block = result.placements.reduce(
    (bounds, placement) => ({
      minX: Math.min(bounds.minX, placement.footprint.minX),
      minY: Math.min(bounds.minY, placement.footprint.minY),
      maxX: Math.max(bounds.maxX, placement.footprint.maxX),
      maxY: Math.max(bounds.maxY, placement.footprint.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  assert.ok(Math.abs((block.minX + block.maxX) / 2 - 100) < 1e-6, 'the packed block is centred in X');
  assert.ok(Math.abs((block.minY + block.maxY) / 2 - 100) < 1e-6, 'the packed block is centred in Y');
});

test('keeps locked instances and exclusion zones clear', () => {
  const { state, assets, plateId, instanceIds } = createProject([
    { size: 40, at: [5, 5] },
    { size: 40, at: [6, 6] },
  ]);
  const locked = instanceIds[0];
  const result = planPlateArrangement(state, assets, plateId, {
    bedSizeMm: BED,
    lockedInstanceIds: [locked],
    exclusions: [{ minX: 0, minY: 0, maxX: 120, maxY: 60 }],
  });
  assert.deepEqual(result.lockedInstanceIds, [locked], 'a locked instance is reported, not moved');
  assert.ok(!result.placements.some((placement) => placement.instanceId === locked));
  for (const placement of result.placements) {
    const region = placement.footprint;
    assert.ok(region.minX >= 120 || region.minY >= 60, 'nothing is placed inside the exclusion zone');
    const lockedRegion = { minX: 5, minY: 5, maxX: 45, maxY: 45 };
    const clear =
      region.maxX <= lockedRegion.minX ||
      lockedRegion.maxX <= region.minX ||
      region.maxY <= lockedRegion.minY ||
      lockedRegion.maxY <= region.minY;
    assert.ok(clear, 'nothing is placed on top of the locked instance');
  }
});

test('reports instances that cannot fit instead of moving them off the bed', () => {
  const { state, assets, plateId } = createProject([
    { size: 90, at: [0, 0] },
    { size: 90, at: [1, 1] },
    { size: 90, at: [2, 2] },
    { size: 90, at: [3, 3] },
    { size: 90, at: [4, 4] },
  ]);
  const result = planPlateArrangement(state, assets, plateId, { bedSizeMm: [200, 200] });
  assert.ok(result.unplacedInstanceIds.length > 0, 'over-full plates report the remainder');
  assert.equal(
    result.placements.length + result.unplacedInstanceIds.length <= 5,
    true,
    'no instance is both placed and reported unplaced',
  );
  for (const placement of result.placements) {
    assert.ok(placement.footprint.maxX <= 198 && placement.footprint.maxY <= 198);
  }
});

test('preserves rotation, scale, and Z, and emits an exact transform batch', () => {
  const { state, assets, plateId, instanceIds } = createProject([{ size: 20, at: [150, 150] }]);
  const instance = state.plates[0].objects[0].instances[0];
  instance.transform = { translationMm: [150, 150, 7], rotation: [0, 0, 0.7071, 0.7071], scale: [1, 2, 1] };
  const result = planPlateArrangement(state, assets, plateId, { bedSizeMm: BED });
  const change = arrangementTransformChanges(result)[0];
  assert.equal(change.instanceId, instanceIds[0]);
  assert.deepEqual(change.transform.rotation, [0, 0, 0.7071, 0.7071], 'orientation is untouched');
  assert.deepEqual(change.transform.scale, [1, 2, 1], 'scale is untouched');
  assert.equal(change.transform.translationMm[2], 7, 'Z placement is untouched');
});

test('rejects invalid beds, spacing, and exclusion rectangles', () => {
  const { state, assets, plateId } = createProject([{ size: 20, at: [0, 0] }]);
  assert.throws(
    () => planPlateArrangement(state, assets, plateId, { bedSizeMm: [0, 200] }),
    (error: unknown) => error instanceof ArrangeConstraintError && error.code === 'invalid-bed',
  );
  assert.throws(
    () => planPlateArrangement(state, assets, plateId, { bedSizeMm: BED, spacingMm: -1 }),
    (error: unknown) => error instanceof ArrangeConstraintError && error.code === 'invalid-spacing',
  );
  assert.throws(
    () =>
      planPlateArrangement(state, assets, plateId, {
        bedSizeMm: BED,
        exclusions: [{ minX: 10, minY: 10, maxX: 5, maxY: 20 }],
      }),
    (error: unknown) => error instanceof ArrangeConstraintError && error.code === 'invalid-exclusion',
  );
  assert.throws(
    () => planPlateArrangement(state, assets, entityId<'plate'>('import:test:missing'), { bedSizeMm: BED }),
    (error: unknown) => error instanceof ArrangeConstraintError && error.code === 'unknown-plate',
  );
});

console.log(`\nCanonical arrangement: ${passed} tests passed.`);
