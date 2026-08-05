import assert from 'node:assert/strict';

import {
  Bbs3mfProjectSerializer,
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  canonicalStringify,
  cloneJson,
  cloneProjectState,
  contentDigest,
  emptyFacetAnnotations,
  encodeIndexedMeshAsset,
  entityId,
  identityTransform,
  type AssetId,
  type AssetPayload,
  type ProjectObject,
  type VolumeId,
} from '../..';
import { SplitVolumeToPartsCommand, captureVolumeSplitGuard, type PreparedVolumeSplitPart } from '../splitCommands';
import { createProjectFixture } from '../../__tests__/fixtures';

const FACET_EXTENSION_KEY = 'https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function splitHarness(
  options: {
    sharedOldAsset?: boolean;
    facetExtension?: boolean;
    existingPartAsset?: AssetPayload;
  } = {},
) {
  const fixture = createProjectFixture();
  const sourceAsset = disconnectedTetrahedra(fixture.ids.asset);
  const state = cloneProjectState(fixture.state);
  state.sourceAssets = [
    cloneJson(sourceAsset.descriptor),
    ...(options.existingPartAsset ? [cloneJson(options.existingPartAsset.descriptor)] : []),
  ];
  const volume = state.plates[0].objects[0].volumes[0];
  volume.source = {
    assetId: sourceAsset.descriptor.id,
    topologyRevision: 7,
    triangleCount: 8,
  };
  volume.transform = {
    translationMm: [3, 4, 5],
    rotation: [0, 0, 0, 1],
    scale: [1.25, 0.75, 2],
  };
  volume.config = { wall_loops: 5, sparse_infill_density: 31 };
  volume.extensionData = options.facetExtension
    ? {
        'test:opaque': { preserve: ['all', 'parts'] },
        [FACET_EXTENSION_KEY]: [
          {
            triangle: 0,
            attributes: [{ namespace: 'urn:test', name: 'facet-data', value: 'keep' }],
          },
        ],
      }
    : { 'test:opaque': { preserve: ['all', 'parts'] } };
  volume.annotations = {
    topologyRevision: 7,
    color: [{ triangles: [0, 4], value: fixture.ids.mixed }],
    support: [{ triangles: [1, 5], value: 'enforce' }],
    seam: [{ triangles: [2, 6], value: 'avoid' }],
    fuzzySkin: [{ triangles: [3, 7], value: true }],
    brim: [{ triangles: [0, 7], value: true }],
  };

  if (options.sharedOldAsset) {
    const shared = cloneJson(volume);
    shared.id = entityId<'volume'>('import:test:split-shared-source-volume');
    shared.name = 'Shared source';
    shared.annotations = emptyFacetAnnotations(7);
    state.plates[0].objects[0].volumes.push(shared);
  }

  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set(
    [
      { kind: 'volume', id: fixture.ids.volume },
      { kind: 'instance', id: fixture.ids.instance },
    ],
    { kind: 'volume', id: fixture.ids.volume },
  );
  const assets = new InMemoryAssetRepository();
  assets.put(sourceAsset.descriptor, sourceAsset.bytes);
  if (options.existingPartAsset) {
    assets.put(options.existingPartAsset.descriptor, options.existingPartAsset.bytes);
  }
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, sourceAsset, project, selection, assets, bus };
}

function preparedParts(suffix: string): PreparedVolumeSplitPart[] {
  const sharedAsset = singleTetrahedron(entityId<'asset'>(`import:test:split-part-asset-${suffix}`));
  return [
    {
      volumeId: entityId<'volume'>(`import:test:split-part-volume-${suffix}-1`),
      asset: sharedAsset,
      transform: {
        ...identityTransform(),
        translationMm: [3, 4, 5],
      },
      sourceTriangleIndices: [0, 1, 2, 3],
    },
    {
      volumeId: entityId<'volume'>(`import:test:split-part-volume-${suffix}-2`),
      asset: sharedAsset,
      transform: {
        ...identityTransform(),
        translationMm: [23, 4, 5],
      },
      sourceTriangleIndices: [4, 5, 6, 7],
    },
  ];
}

function singleTetrahedron(id: AssetId): AssetPayload {
  return encodeIndexedMeshAsset({
    id,
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2],
    indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
    sourceFilename: 'split-part.stl',
    provenance: { source: 'generated', uri: 'test:split-to-parts' },
  });
}

function openTetrahedron(id: AssetId): AssetPayload {
  return encodeIndexedMeshAsset({
    id,
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2],
    indices: [0, 2, 1, 0, 1, 3, 1, 2, 3],
    sourceFilename: 'lossy-split-part.stl',
    provenance: { source: 'generated', uri: 'test:lossy-split' },
  });
}

function disconnectedTetrahedra(id: AssetId): AssetPayload {
  return encodeIndexedMeshAsset({
    id,
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 20, 0, 0, 22, 0, 0, 20, 2, 0, 20, 0, 2],
    indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3, 4, 6, 5, 4, 5, 7, 5, 6, 7, 6, 4, 7],
    sourceFilename: 'two-tetrahedra.stl',
    provenance: { source: 'import', uri: 'test:two-tetrahedra' },
  });
}

function objectMetadata(object: ProjectObject): object {
  return cloneJson({
    id: object.id,
    name: object.name,
    config: object.config,
    filamentId: object.filamentId,
    instances: object.instances,
    layerRanges: object.layerRanges,
    extensionData: object.extensionData,
  });
}

function assertRejectedWithoutMutation(
  h: ReturnType<typeof splitHarness>,
  operation: () => void,
  expected: RegExp,
): void {
  const stateBefore = canonicalStringify(h.project.getSnapshot().state);
  const assetsBefore = h.assets.capture();
  const selectionBefore = h.selection.getSnapshot();
  const historyBefore = h.bus.getHistorySnapshot();
  assert.throws(operation, expected);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), stateBefore);
  assert.deepEqual(h.assets.capture(), assetsBefore);
  assert.deepEqual(h.selection.getSnapshot(), selectionBefore);
  assert.deepEqual(h.bus.getHistorySnapshot(), historyBefore);
}

await test('commits a lossless staged split with fresh IDs, reset facets, and exact undo/redo', () => {
  const h = splitHarness();
  const parts = preparedParts('exact');
  const guard = captureVolumeSplitGuard(h.project.getSnapshot().state, h.fixture.ids.volume);
  const command = new SplitVolumeToPartsCommand(guard, parts);
  const stateBefore = canonicalStringify(h.project.getSnapshot().state);
  const assetsBefore = h.assets.capture();
  const selectionBefore = h.selection.getSnapshot();
  const sourceObject = h.project.getSnapshot().state.plates[0].objects[0];
  const objectMetadataBefore = objectMetadata(sourceObject);
  const sourceVolume = cloneJson(sourceObject.volumes[0]);

  h.bus.execute(command);

  const current = h.project.getSnapshot().state;
  const object = current.plates[0].objects[0];
  assert.deepEqual(objectMetadata(object), objectMetadataBefore);
  assert.equal(object.volumes.length, 2);
  assert.deepEqual(
    object.volumes.map((volume) => volume.id),
    parts.map((part) => part.volumeId),
  );
  assert.deepEqual(
    object.volumes.map((volume) => volume.name),
    [`${sourceVolume.name}_1`, `${sourceVolume.name}_2`],
  );
  for (const [index, volume] of object.volumes.entries()) {
    assert.equal(volume.role, sourceVolume.role);
    assert.deepEqual(volume.config, sourceVolume.config);
    assert.equal(volume.filamentId, sourceVolume.filamentId);
    assert.deepEqual(volume.extensionData, sourceVolume.extensionData);
    assert.deepEqual(volume.transform, parts[index].transform);
    assert.deepEqual(volume.annotations, emptyFacetAnnotations(0));
    assert.deepEqual(volume.source, {
      assetId: parts[index].asset.descriptor.id,
      topologyRevision: 0,
      triangleCount: 4,
    });
  }
  assert.equal(current.sourceAssets.length, 1, 'shared component bytes are declared once');
  assert.equal(current.sourceAssets[0].id, parts[0].asset.descriptor.id);
  assert.equal(h.assets.has(h.sourceAsset.descriptor.id), false);
  assert.deepEqual(h.assets.get(parts[0].asset.descriptor.id), parts[0].asset);
  assert.deepEqual(h.selection.getSnapshot(), {
    refs: [
      { kind: 'volume', id: parts[0].volumeId },
      { kind: 'volume', id: parts[1].volumeId },
      { kind: 'instance', id: h.fixture.ids.instance },
    ],
    primary: { kind: 'volume', id: parts[0].volumeId },
  });
  assert.ok(command.estimateBytes() >= h.sourceAsset.bytes.byteLength + parts[0].asset.bytes.byteLength);
  assert.equal(h.bus.getHistorySnapshot().undoCount, 1);

  const stateAfter = canonicalStringify(current);
  const assetsAfter = h.assets.capture();
  const selectionAfter = h.selection.getSnapshot();
  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), stateBefore);
  assert.deepEqual(h.assets.capture(), assetsBefore);
  assert.deepEqual(h.selection.getSnapshot(), selectionBefore);

  assert.equal(h.bus.redo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), stateAfter);
  assert.deepEqual(h.assets.capture(), assetsAfter);
  assert.deepEqual(h.selection.getSnapshot(), selectionAfter);
});

await test('retains a source asset still referenced by another canonical volume', () => {
  const h = splitHarness({ sharedOldAsset: true });
  const parts = preparedParts('retained');
  const before = canonicalStringify(h.project.getSnapshot().state);
  const assetsBefore = h.assets.capture();
  h.bus.execute(
    new SplitVolumeToPartsCommand(captureVolumeSplitGuard(h.project.getSnapshot().state, h.fixture.ids.volume), parts),
  );

  const current = h.project.getSnapshot().state;
  assert.equal(current.sourceAssets.length, 2);
  assert.equal(h.assets.has(h.sourceAsset.descriptor.id), true);
  assert.equal(h.assets.has(parts[0].asset.descriptor.id), true);
  assert.equal(current.plates[0].objects[0].volumes[2].source.assetId, h.sourceAsset.descriptor.id);

  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before);
  assert.deepEqual(h.assets.capture(), assetsBefore);
  assert.equal(h.bus.redo(), true);
  assert.equal(h.assets.has(h.sourceAsset.descriptor.id), true);
});

await test('reuses an exact existing immutable component asset without taking ownership', () => {
  const parts = preparedParts('borrowed');
  const h = splitHarness({ existingPartAsset: parts[0].asset });
  const stateBefore = canonicalStringify(h.project.getSnapshot().state);
  const assetsBefore = h.assets.capture();
  h.bus.execute(
    new SplitVolumeToPartsCommand(captureVolumeSplitGuard(h.project.getSnapshot().state, h.fixture.ids.volume), parts),
  );

  assert.equal(h.project.getSnapshot().state.sourceAssets.length, 1);
  assert.equal(h.project.getSnapshot().state.sourceAssets[0].id, parts[0].asset.descriptor.id);
  assert.deepEqual(h.assets.get(parts[0].asset.descriptor.id), parts[0].asset);

  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), stateBefore);
  assert.deepEqual(h.assets.capture(), assetsBefore);
  assert.equal(h.bus.redo(), true);
  assert.deepEqual(h.assets.get(parts[0].asset.descriptor.id), parts[0].asset);
});

await test('fails closed on stale state, lossy partitions, collisions, malformed meshes, and opaque facet metadata', () => {
  const h = splitHarness();
  const guard = captureVolumeSplitGuard(h.project.getSnapshot().state, h.fixture.ids.volume);
  const valid = preparedParts('failures');

  assertRejectedWithoutMutation(
    h,
    () =>
      h.bus.execute(
        new SplitVolumeToPartsCommand({ ...guard, volumeFingerprint: `${guard.volumeFingerprint} stale` }, valid),
      ),
    /stale volume split.*metadata or transform/i,
  );

  const duplicateTriangle = preparedParts('duplicate-triangle');
  duplicateTriangle[1] = {
    ...duplicateTriangle[1],
    sourceTriangleIndices: [4, 5, 6, 6],
  };
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, duplicateTriangle)),
    /triangle 6 appears in multiple parts/i,
  );

  const lossyAsset = openTetrahedron(entityId<'asset'>('import:test:lossy-split-part-asset'));
  const lossy: PreparedVolumeSplitPart[] = [
    {
      volumeId: entityId<'volume'>('import:test:lossy-split-volume-1'),
      asset: lossyAsset,
      transform: identityTransform(),
      sourceTriangleIndices: [0, 1, 2],
    },
    {
      volumeId: entityId<'volume'>('import:test:lossy-split-volume-2'),
      asset: lossyAsset,
      transform: identityTransform(),
      sourceTriangleIndices: [4, 5, 6],
    },
  ];
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, lossy)),
    /maps 6 of 8 source triangles.*lossy splits are not representable/i,
  );

  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, [valid[0]])),
    /at least two prepared components/i,
  );

  const collidingVolume = preparedParts('colliding-volume');
  collidingVolume[0] = {
    ...collidingVolume[0],
    volumeId: h.fixture.ids.object as unknown as VolumeId,
  };
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, collidingVolume)),
    /already exists in the project/i,
  );

  const sourceAssetCollision = preparedParts('source-asset-collision');
  sourceAssetCollision[0] = {
    ...sourceAssetCollision[0],
    asset: singleTetrahedron(h.sourceAsset.descriptor.id),
  };
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, sourceAssetCollision)),
    /collides with the source asset/i,
  );

  const malformed = preparedParts('malformed');
  const truncated = malformed[0].asset.bytes.slice(0, -1);
  const malformedAsset: AssetPayload = {
    descriptor: {
      ...cloneJson(malformed[0].asset.descriptor),
      digest: contentDigest(truncated),
      byteLength: truncated.byteLength,
    },
    bytes: truncated,
  };
  malformed[0] = { ...malformed[0], asset: malformedAsset };
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new SplitVolumeToPartsCommand(guard, malformed)),
    /outside the payload/i,
  );

  const opaque = splitHarness({ facetExtension: true });
  const opaqueGuard = captureVolumeSplitGuard(opaque.project.getSnapshot().state, opaque.fixture.ids.volume);
  assertRejectedWithoutMutation(
    opaque,
    () => opaque.bus.execute(new SplitVolumeToPartsCommand(opaqueGuard, preparedParts('opaque-facet'))),
    /cannot preserve opaque triangle-indexed 3MF extension metadata/i,
  );
});

await test('round-trips the split graph and shared component asset through canonical 3MF', async () => {
  const h = splitHarness();
  const parts = preparedParts('save-reopen');
  h.bus.execute(
    new SplitVolumeToPartsCommand(captureVolumeSplitGuard(h.project.getSnapshot().state, h.fixture.ids.volume), parts),
  );
  const snapshot = h.project.getSnapshot();
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state: snapshot.state,
    assets: h.assets.list(),
    sourceRevision: snapshot.revision,
    sourceHash: snapshot.hash,
  });
  const reopened = await serializer.deserialize(saved.bytes);
  assert.equal(canonicalStringify(reopened.state), canonicalStringify(snapshot.state));
  assert.deepEqual(reopened.assets, h.assets.list());
  assert.equal(reopened.state.plates[0].objects[0].volumes.length, 2);
  assert.equal(reopened.state.sourceAssets.length, 1);
});

console.log(`\nSplit-to-parts command: ${passed} tests passed.`);
