import assert from 'node:assert/strict';
import {
  UuidIdSource,
  InMemoryAssetRepository,
  canonicalStringify,
  cloneJson,
  cloneProjectState,
  entityId,
  resolveConfig,
  resolveFilament,
  seededRandom,
  type PhysicalFilamentId,
  validateProjectState,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('creates deterministic stable branded UUIDs and accepts namespaced imported IDs', () => {
  const left = new UuidIdSource(seededRandom(42));
  const right = new UuidIdSource(seededRandom(42));
  assert.equal(left.next('plate'), right.next('plate'));
  assert.doesNotThrow(() => entityId<'object'>('import:bbs:object-17'));
  assert.throws(() => entityId<'object'>('mutable display name'));
});

test('validates the complete canonical fixture', () => {
  assert.deepEqual(validateProjectState(createProjectFixture().state), []);
});

test('keeps source assets immutable and returns defensive byte copies', () => {
  const { asset } = createProjectFixture();
  const repository = new InMemoryAssetRepository();
  repository.put(asset.descriptor, asset.bytes);
  const first = repository.get(asset.descriptor.id)!;
  first.bytes[0] ^= 0xff;
  assert.equal(repository.get(asset.descriptor.id)!.bytes[0], asset.bytes[0]);
  const changed = asset.bytes.slice();
  changed[0] ^= 0xff;
  assert.throws(() => repository.put(asset.descriptor, changed));
  assert.equal(repository.findByDigest(asset.descriptor.digest)?.descriptor.id, asset.descriptor.id);
});

test('resolves project/plate/object/part and layer inheritance without losing local values', () => {
  const { state, object } = createProjectFixture();
  const volume = object.volumes[0];
  const resolved = resolveConfig(state, {
    plateId: state.activePlateId,
    objectId: object.id,
    volumeId: volume.id,
  });
  assert.equal(resolved.effective.layer_height, 0.2);
  assert.equal(resolved.effective.wall_loops, 3);
  assert.deepEqual(resolved.local, { wall_loops: 3 });
  assert.equal(resolved.sourceByKey.wall_loops.kind, 'volume');
  assert.equal(resolveFilament(object, volume).effective, object.filamentId);

  const layer = resolveConfig(state, {
    plateId: state.activePlateId,
    objectId: object.id,
    layerRangeId: object.layerRanges[0].id,
  });
  assert.equal(layer.effective.layer_height, 0.12);
  assert.throws(() =>
    resolveConfig(state, {
      plateId: state.activePlateId,
      objectId: object.id,
      volumeId: volume.id,
      layerRangeId: object.layerRanges[0].id,
    }),
  );
});

test('reports duplicate IDs, dangling references, invalid transforms/ranges/tools and modifier misuse', () => {
  const { state } = createProjectFixture();
  const broken = cloneProjectState(state);
  const object = broken.plates[0].objects[0];
  broken.filaments.physical[1].id = broken.filaments.physical[0].id;
  broken.filaments.physical[1].toolId = 9;
  object.instances[0].transform.scale = [1, 0, 1];
  object.layerRanges[0].maxZMm = 0;
  object.volumes.push({
    ...cloneJson(object.volumes[0]),
    id: new UuidIdSource(seededRandom(88)).next('volume'),
    role: 'negative-volume',
    filamentId: broken.filaments.physical[0].id,
  });
  object.volumes[0].source.assetId = entityId<'asset'>('import:test:missing');
  const codes = new Set(validateProjectState(broken).map((issue) => issue.code));
  for (const expected of [
    'duplicate-id',
    'tool-out-of-range',
    'non-invertible-transform',
    'invalid-layer-range',
    'incompatible-modifier-filament',
    'dangling-asset',
  ]) {
    assert.ok(codes.has(expected), `expected ${expected}`);
  }
});

test('rejects dangling and cyclic mixed-filament components', () => {
  const dangling = cloneProjectState(createProjectFixture().state);
  dangling.filaments.mixed[0].components[0].filamentId = entityId<'physical-filament'>('import:test:missing-filament');
  assert.ok(validateProjectState(dangling).some((issue) => issue.code === 'dangling-mixed-component'));

  const cyclic = cloneProjectState(createProjectFixture().state);
  cyclic.filaments.mixed[0].components[0].filamentId = cyclic.filaments.mixed[0].id as unknown as PhysicalFilamentId;
  const cyclicCodes = new Set(validateProjectState(cyclic).map((issue) => issue.code));
  assert.ok(cyclicCodes.has('nested-mixed-component'));
  assert.ok(cyclicCodes.has('cyclic-mixed-filament'));
});

test('rejects FullSpectrum fields outside the pinned engine domain', () => {
  const broken = cloneProjectState(createProjectFixture().state);
  const mixed = broken.filaments.mixed[0];
  mixed.fullSpectrum = {
    schemaVersion: 1,
    upstreamStableId: '18446744073709551616',
    uiMode: 7 as 0,
    componentAId: mixed.components[0].filamentId,
    componentBId: mixed.components[1].filamentId,
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 2,
    localZMaxSublayers: 2,
    gradientEnabled: true,
    gradientStart: 0.51,
    gradientEnd: 0.49,
    componentASurfaceOffsetMm: 2.001,
    componentBSurfaceOffsetMm: -2.001,
    deleted: false,
    custom: true,
    originAuto: false,
  };
  const codes = new Set(validateProjectState(broken).map((issue) => issue.code));
  assert.ok(codes.has('invalid-fullspectrum-stable-id'));
  assert.ok(codes.has('invalid-fullspectrum-ui-mode'));
  assert.ok(codes.has('invalid-fullspectrum-gradient'));
  assert.ok(codes.has('invalid-fullspectrum-offset'));
});

test('rejects stale topology annotations and out-of-range facets', () => {
  const broken = cloneProjectState(createProjectFixture().state);
  const volume = broken.plates[0].objects[0].volumes[0];
  volume.source.topologyRevision = 2;
  volume.annotations.color[0].triangles = [4];
  const codes = new Set(validateProjectState(broken).map((issue) => issue.code));
  assert.ok(codes.has('stale-annotation-topology'));
  assert.ok(codes.has('facet-index-out-of-range'));
});

test('rejects sparse facet values that cannot round-trip through their BBS channels', () => {
  const broken = cloneProjectState(createProjectFixture().state);
  const annotations = broken.plates[0].objects[0].volumes[0].annotations;
  (annotations.fuzzySkin as unknown as Array<{ value: boolean; triangles: number[] }>).push({
    value: false,
    triangles: [0],
  });
  assert.ok(validateProjectState(broken).some((issue) => issue.code === 'invalid-facet-value'));
});

test('rejects runtime values that cannot round-trip through canonical JSON', () => {
  const broken = cloneProjectState(createProjectFixture().state);
  (broken.config as Record<string, unknown>).invalid = undefined;
  assert.ok(validateProjectState(broken).some((issue) => issue.code === 'non-serializable-state'));
});

test('canonical serialization is deterministic across key insertion order and generated graphs', () => {
  const fixture = createProjectFixture().state;
  const reordered = cloneProjectState(fixture);
  reordered.config = { sparse_infill_density: 15, layer_height: 0.24 };
  assert.equal(canonicalStringify(reordered), canonicalStringify(fixture));

  for (let seed = 1; seed <= 64; seed += 1) {
    const state = cloneProjectState(fixture);
    const random = seededRandom(seed);
    state.plates[0].objects[0].instances[0].transform.translationMm = [random() * 300, random() * 300, random() * 300];
    assert.deepEqual(validateProjectState(state), []);
    const roundTrip = JSON.parse(canonicalStringify(state)) as typeof state;
    assert.equal(canonicalStringify(roundTrip), canonicalStringify(state));
  }
});

console.log(`\nProject domain: ${passed} tests passed.`);
