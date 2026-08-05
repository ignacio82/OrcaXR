import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  SeparateObjectVolumesCommand,
  canonicalStringify,
  captureObjectVolumeSeparationGuard,
  captureVolumeSplitGuard,
  cloneJson,
  cloneProjectState,
  commitPreparedVolumeSplitToObjects,
  emptyFacetAnnotations,
  encodeIndexedMeshAsset,
  entityId,
  prepareVolumeSplitParts,
  type AssetId,
  type AssetPayload,
  type PreparedVolumeSplitPart,
  type SeparatedObjectIdentity,
  type VolumeId,
  type VolumeSplitPartIdentityRequest,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function tetrahedra(suffix: string, disconnected: boolean): AssetPayload {
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>(`import:test:split-objects-${suffix}`),
    positions: disconnected
      ? [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 20, 0, 0, 22, 0, 0, 20, 2, 0, 20, 0, 2]
      : [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2],
    indices: disconnected
      ? [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3, 4, 6, 5, 4, 5, 7, 5, 6, 7, 6, 4, 7]
      : [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
    sourceFilename: `${suffix}.stl`,
    provenance: { source: 'import', uri: `test:${suffix}` },
  });
}

function harness(source: AssetPayload) {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.sourceAssets = [source.descriptor];
  const object = state.plates[0].objects[0];
  object.layerRanges = [];
  const volume = object.volumes[0];
  volume.source = {
    assetId: source.descriptor.id,
    topologyRevision: 0,
    triangleCount: source.descriptor.mesh!.triangleCount,
  };
  volume.annotations = emptyFacetAnnotations(0);
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(source.descriptor, source.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, project, selection, assets, bus };
}

function identities(volumeIds: readonly VolumeId[], instanceCount: number, suffix: string): SeparatedObjectIdentity[] {
  return volumeIds.map((sourceVolumeId, volumeIndex) => ({
    sourceVolumeId,
    objectId: entityId<'object'>(`import:test:split-object-${suffix}-${volumeIndex + 1}`),
    instanceIds: Array.from({ length: instanceCount }, (_, instanceIndex) =>
      entityId<'instance'>(`import:test:split-instance-${suffix}-${volumeIndex + 1}-${instanceIndex + 1}`),
    ),
  }));
}

function preparedParts(source: AssetPayload, suffix: string): PreparedVolumeSplitPart[] {
  const assets = new Map<string, AssetId>();
  return prepareVolumeSplitParts({
    sourceAsset: source,
    sourceTransform: {
      translationMm: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    idsForPart(request: VolumeSplitPartIdentityRequest) {
      let assetId = assets.get(request.geometryDigest);
      if (!assetId) {
        assetId = entityId<'asset'>(`import:test:split-output-asset-${suffix}-${assets.size + 1}`);
        assets.set(request.geometryDigest, assetId);
      }
      return {
        volumeId: entityId<'volume'>(`import:test:split-output-volume-${suffix}-${request.partIndex + 1}`),
        assetId,
      };
    },
  });
}

function capture(h: ReturnType<typeof harness>) {
  return {
    state: canonicalStringify(h.project.getSnapshot().state),
    assets: h.assets.capture(),
    selection: h.selection.getSnapshot(),
    history: h.bus.getHistorySnapshot(),
  };
}

function assertUnchanged(h: ReturnType<typeof harness>, before: ReturnType<typeof capture>): void {
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before.state);
  assert.deepEqual(h.assets.capture(), before.assets);
  assert.deepEqual(h.selection.getSnapshot(), before.selection);
  assert.deepEqual(h.bus.getHistorySnapshot(), before.history);
}

function assertVectorClose(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
}

await test('promotes unchanged model volumes with config inheritance and exact world placement', () => {
  const source = tetrahedra('multi-volume', false);
  const h = harness(source);
  const state = cloneProjectState(h.project.getSnapshot().state);
  const object = state.plates[0].objects[0];
  const first = object.volumes[0];
  first.name = 'First';
  first.source.triangleCount = 4;
  first.transform.translationMm = [1, 2, 3];
  first.config = { wall_loops: 4, top_shell_layers: 2 };
  first.annotations = {
    ...emptyFacetAnnotations(0),
    color: [{ value: h.fixture.ids.mixed, triangles: [2] }],
  };
  const second = cloneJson(object.volumes[0]);
  second.id = entityId<'volume'>('import:test:split-objects-second-volume');
  second.name = 'Second';
  second.transform.translationMm = [-1, 0, 0];
  second.config = { sparse_infill_density: 33 };
  second.filamentId = h.fixture.ids.physical1;
  second.annotations = emptyFacetAnnotations(0);
  object.volumes.push(second);
  object.instances[0].transform = {
    translationMm: [10, 20, 30],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    scale: [2, 3, 4],
  };
  h.project.replaceState(state, { reason: 'test-setup', dirtyCategories: [] });
  h.selection.set(
    [
      { kind: 'object', id: object.id },
      { kind: 'instance', id: object.instances[0].id },
      { kind: 'volume', id: first.id },
    ],
    { kind: 'object', id: object.id },
  );
  h.bus.markCheckpoint();
  const before = capture(h);
  const generatedIds = identities(
    object.volumes.map((volume) => volume.id),
    1,
    'multi',
  );

  h.bus.execute(
    new SeparateObjectVolumesCommand(
      captureObjectVolumeSeparationGuard(h.project.getSnapshot().state, object.id),
      generatedIds,
    ),
  );

  const current = h.project.getSnapshot().state;
  assert.equal(current.plates[0].objects.length, 2);
  const [firstObject, secondObject] = current.plates[0].objects;
  assert.deepEqual(
    current.plates[0].objects.map((candidate) => candidate.id),
    generatedIds.map((identity) => identity.objectId),
  );
  assert.deepEqual(firstObject.config, {
    layer_height: 0.2,
    wall_loops: 4,
    top_shell_layers: 2,
  });
  assert.deepEqual(secondObject.config, {
    layer_height: 0.2,
    wall_loops: 2,
    sparse_infill_density: 33,
  });
  assert.equal(firstObject.filamentId, h.fixture.ids.physical0);
  assert.equal(secondObject.filamentId, h.fixture.ids.physical1);
  assert.deepEqual(firstObject.volumes[0].config, {});
  assert.equal(firstObject.volumes[0].filamentId, undefined);
  assert.deepEqual(firstObject.volumes[0].transform.translationMm, [0, 0, 0]);
  assert.deepEqual(secondObject.volumes[0].transform.translationMm, [0, 0, 0]);
  assertVectorClose(firstObject.instances[0].transform.translationMm, [4, 22, 42]);
  assertVectorClose(secondObject.instances[0].transform.translationMm, [10, 18, 30]);
  assert.deepEqual(firstObject.volumes[0].annotations, first.annotations);
  assert.equal(current.sourceAssets.length, 1);
  assert.deepEqual(h.assets.get(source.descriptor.id), source);
  assert.deepEqual(h.selection.getSnapshot(), {
    refs: [
      { kind: 'object', id: generatedIds[0].objectId },
      { kind: 'object', id: generatedIds[1].objectId },
      { kind: 'instance', id: generatedIds[0].instanceIds[0] },
      { kind: 'instance', id: generatedIds[1].instanceIds[0] },
      { kind: 'volume', id: first.id },
    ],
    primary: { kind: 'object', id: generatedIds[0].objectId },
  });

  const after = capture(h);
  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before.state);
  assert.deepEqual(h.assets.capture(), before.assets);
  assert.deepEqual(h.selection.getSnapshot(), before.selection);
  assert.equal(h.bus.redo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), after.state);
  assert.deepEqual(h.assets.capture(), after.assets);
  assert.deepEqual(h.selection.getSnapshot(), after.selection);
});

await test('commits a single-volume component split and promotion as one exact transaction', () => {
  const source = tetrahedra('single-volume', true);
  const h = harness(source);
  const state = cloneProjectState(h.project.getSnapshot().state);
  const object = state.plates[0].objects[0];
  const volume = object.volumes[0];
  volume.transform.translationMm = [1, 2, 3];
  volume.config = { wall_loops: 5 };
  h.project.replaceState(state, { reason: 'test-setup', dirtyCategories: [] });
  h.selection.set(
    [
      { kind: 'object', id: object.id },
      { kind: 'instance', id: object.instances[0].id },
    ],
    { kind: 'instance', id: object.instances[0].id },
  );
  h.bus.markCheckpoint();
  const before = capture(h);
  const parts = preparedParts(source, 'single');
  const generatedIds = identities(
    parts.map((part) => part.volumeId),
    1,
    'single',
  );

  commitPreparedVolumeSplitToObjects(
    h.bus,
    captureVolumeSplitGuard(h.project.getSnapshot().state, volume.id),
    parts,
    generatedIds,
  );

  const current = h.project.getSnapshot().state;
  assert.equal(current.plates[0].objects.length, 2);
  assert.deepEqual(
    current.plates[0].objects.map((candidate) => candidate.name),
    ['Body_1', 'Body_2'],
  );
  assert.deepEqual(
    current.plates[0].objects.map((candidate) => candidate.volumes[0].id),
    parts.map((part) => part.volumeId),
  );
  assert.deepEqual(
    current.plates[0].objects.map((candidate) => candidate.volumes[0].transform.translationMm),
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  );
  assert.deepEqual(
    current.plates[0].objects.map((candidate) => candidate.instances[0].transform.translationMm),
    parts.map((part) => part.transform.translationMm),
  );
  assert.equal(current.sourceAssets.length, 1, 'identical component bytes remain deduplicated');
  assert.equal(h.assets.has(source.descriptor.id), false);
  assert.equal(h.bus.getHistorySnapshot().undoCount, 1);
  assert.equal(h.bus.getHistorySnapshot().undoLabel, 'Split to objects');

  const after = capture(h);
  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before.state);
  assert.deepEqual(h.assets.capture(), before.assets);
  assert.deepEqual(h.selection.getSnapshot(), before.selection);
  assert.equal(h.bus.redo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), after.state);
  assert.deepEqual(h.assets.capture(), after.assets);
  assert.deepEqual(h.selection.getSnapshot(), after.selection);
});

await test('fails closed on lossy metadata, modifiers, stale guards, IDs, and tiny components', () => {
  const source = tetrahedra('rejections', true);
  const h = harness(source);
  const state = cloneProjectState(h.project.getSnapshot().state);
  const object = state.plates[0].objects[0];
  const second = cloneJson(object.volumes[0]);
  second.id = entityId<'volume'>('import:test:split-objects-rejection-volume');
  second.annotations = emptyFacetAnnotations(0);
  object.volumes.push(second);
  object.layerRanges = [
    {
      id: h.fixture.ids.range,
      minZMm: 0,
      maxZMm: 1,
      config: {},
    },
  ];
  h.project.replaceState(state, { reason: 'test-setup', dirtyCategories: [] });
  h.bus.markCheckpoint();
  const original = capture(h);
  const validIds = identities(
    object.volumes.map((volume) => volume.id),
    1,
    'reject',
  );
  const guard = captureObjectVolumeSeparationGuard(h.project.getSnapshot().state, object.id);

  assert.throws(() => h.bus.execute(new SeparateObjectVolumesCommand(guard, validIds)), /layer-range distribution/i);
  assertUnchanged(h, original);

  const noRanges = cloneProjectState(h.project.getSnapshot().state);
  noRanges.plates[0].objects[0].layerRanges = [];
  noRanges.plates[0].objects[0].volumes[1].role = 'support-blocker';
  h.project.replaceState(noRanges, { reason: 'test-setup', dirtyCategories: [] });
  h.bus.markCheckpoint();
  const modifier = capture(h);
  assert.throws(
    () =>
      h.bus.execute(
        new SeparateObjectVolumesCommand(
          captureObjectVolumeSeparationGuard(h.project.getSnapshot().state, object.id),
          validIds,
        ),
      ),
    /discard modifier or negative volumes/i,
  );
  assertUnchanged(h, modifier);

  const clean = cloneProjectState(h.project.getSnapshot().state);
  clean.plates[0].objects[0].volumes[1].role = 'model';
  h.project.replaceState(clean, { reason: 'test-setup', dirtyCategories: [] });
  h.bus.markCheckpoint();
  const collisions = capture(h);
  assert.throws(
    () =>
      h.bus.execute(
        new SeparateObjectVolumesCommand(captureObjectVolumeSeparationGuard(h.project.getSnapshot().state, object.id), [
          { ...validIds[0], objectId: object.id },
          validIds[1],
        ]),
      ),
    /not fresh and stable/i,
  );
  assertUnchanged(h, collisions);
  assert.throws(
    () =>
      h.bus.execute(
        new SeparateObjectVolumesCommand(
          {
            ...captureObjectVolumeSeparationGuard(h.project.getSnapshot().state, object.id),
            objectFingerprint: 'stale',
          },
          validIds,
        ),
      ),
    /source .* stale/i,
  );
  assertUnchanged(h, collisions);

  const singleSource = tetrahedra('tiny-component', true);
  const single = harness(singleSource);
  const parts = preparedParts(singleSource, 'tiny');
  const tiny = [
    { ...parts[0], sourceTriangleIndices: [0, 1] },
    { ...parts[1], sourceTriangleIndices: [2, 3, 4, 5, 6, 7] },
  ];
  const singleBefore = capture(single);
  assert.throws(
    () =>
      commitPreparedVolumeSplitToObjects(
        single.bus,
        captureVolumeSplitGuard(
          single.project.getSnapshot().state,
          single.project.getSnapshot().state.plates[0].objects[0].volumes[0].id,
        ),
        tiny,
        identities(
          tiny.map((part) => part.volumeId),
          1,
          'tiny',
        ),
      ),
    /fewer than three facets/i,
  );
  assertUnchanged(single, singleBefore);
});

console.log(`\nSplit-to-objects commands: ${passed} tests passed.`);
