import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  canonicalStringify,
  cloneProjectState,
  contentDigest,
  decodeIndexedMeshAsset,
  encodeIndexedMeshAsset,
  entityId,
  identityTransform,
  type AssetId,
  type AssetPayload,
  type Transform,
  type VolumeId,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';
import { SplitVolumeToPartsCommand, captureVolumeSplitGuard } from '../splitCommands';
import {
  prepareVolumeSplitParts,
  type VolumeSplitPartIdentityRequest,
  type VolumeSplitPreparationProgress,
} from '../splitPreparation';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function asset(suffix: string, positions: readonly number[], indices: readonly number[]): AssetPayload {
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>(`import:test:split-preparation-source-${suffix}`),
    positions,
    indices,
    sourceFilename: `${suffix}.stl`,
    provenance: { source: 'import', uri: `test:${suffix}` },
  });
}

function identicalTetrahedra(suffix: string): AssetPayload {
  return asset(
    suffix,
    [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 20, 0, 0, 22, 0, 0, 20, 2, 0, 20, 0, 2],
    [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3, 4, 6, 5, 4, 5, 7, 5, 6, 7, 6, 4, 7],
  );
}

function deterministicIds(suffix: string) {
  const assetIds = new Map<string, AssetId>();
  return (request: VolumeSplitPartIdentityRequest) => {
    let assetId = assetIds.get(request.geometryDigest);
    if (!assetId) {
      assetId = entityId<'asset'>(`import:test:split-preparation-output-${suffix}-${assetIds.size + 1}`);
      assetIds.set(request.geometryDigest, assetId);
    }
    return {
      volumeId: entityId<'volume'>(`import:test:split-preparation-volume-${suffix}-${request.partIndex + 1}`),
      assetId,
    };
  };
}

function prepare(sourceAsset: AssetPayload, suffix: string, sourceTransform: Transform = identityTransform()) {
  return prepareVolumeSplitParts({
    sourceAsset,
    sourceTransform,
    idsForPart: deterministicIds(suffix),
  });
}

function signedVolume(payload: AssetPayload): number {
  const mesh = decodeIndexedMeshAsset(payload);
  let volume = 0;
  for (const triangle of mesh.triangles) {
    const first = mesh.vertices[triangle[0]];
    const second = mesh.vertices[triangle[1]];
    const third = mesh.vertices[triangle[2]];
    volume +=
      (first[0] * (second[1] * third[2] - second[2] * third[1]) +
        first[1] * (second[2] * third[0] - second[0] * third[2]) +
        first[2] * (second[0] * third[1] - second[1] * third[0])) /
      6;
  }
  return volume;
}

await test('uses pinned shared-edge connectivity, source component order, and face discovery order', () => {
  const source = asset(
    'vertex-contact',
    [
      0,
      0,
      0, // 0 shared only as a vertex between patches
      2,
      0,
      0, // 1
      0,
      2,
      0, // 2
      0,
      0,
      2, // 3
      -2,
      0,
      0, // 4
      0,
      -2,
      0, // 5
    ],
    [
      0,
      1,
      2, // face 0
      0,
      4,
      5, // face 1: vertex-only contact with face 0
      1,
      0,
      3, // face 2: opposite shared edge with face 0
    ],
  );
  const identityRequests: VolumeSplitPartIdentityRequest[] = [];
  const ids = deterministicIds('vertex-contact');
  const parts = prepareVolumeSplitParts({
    sourceAsset: source,
    sourceTransform: identityTransform(),
    idsForPart(request) {
      identityRequests.push(request);
      return ids(request);
    },
  });

  assert.deepEqual(
    parts.map((part) => part.sourceTriangleIndices),
    [[0, 2], [1]],
  );
  assert.deepEqual(
    identityRequests.map((request) => request.sourceTriangleIndices),
    [[0, 2], [1]],
  );
  assert.deepEqual(
    parts.map((part) => decodeIndexedMeshAsset(part.asset).triangles.length),
    [2, 1],
  );

  const sharedEdgeOnly = asset('shared-edge', [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2], [0, 1, 2, 1, 0, 3]);
  assert.throws(() => prepare(sharedEdgeOnly, 'shared-edge'), /one shared-edge component.*not splittable/i);
});

await test('makes pinned orientation and non-manifold edge pairing deterministic', () => {
  const sameDirection = asset('same-direction', [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2], [0, 1, 2, 0, 1, 3]);
  assert.deepEqual(
    prepare(sameDirection, 'same-direction').map((part) => part.sourceTriangleIndices),
    [[0], [1]],
    'the pinned neighbor builder only accepts the opposite direction of a shared edge',
  );

  const nonManifold = asset(
    'non-manifold-edge',
    [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0, 2],
    [
      0,
      1,
      2, // ascending scan owns the first reverse-oriented face
      1,
      0,
      3,
      1,
      0,
      4,
    ],
  );
  const first = prepare(nonManifold, 'non-manifold');
  const second = prepare(nonManifold, 'non-manifold');
  assert.deepEqual(
    first.map((part) => part.sourceTriangleIndices),
    [[0, 1], [2]],
  );
  assert.deepEqual(second, first, 'the serial tie-break and canonical bytes are repeatable');
});

await test('recenters with pinned local AABB math, preserves TRS, and corrects negative volume winding', () => {
  const source = asset(
    'recenter-negative',
    [10, 20, 30, 12, 20, 30, 10, 24, 30, 10, 20, 36, 100, 0, 0, 101, 0, 0, 100, 1, 0],
    [
      0,
      1,
      2, // deliberately negative tetrahedron winding
      0,
      3,
      1,
      1,
      3,
      2,
      2,
      3,
      0,
      4,
      5,
      6, // separate patch keeps the preparation on the real split path
    ],
  );
  const transform: Transform = {
    translationMm: [5, 6, 7],
    rotation: [0.1, 0.2, 0.3, 0.9],
    scale: [2, -3, 4],
  };
  const [part] = prepare(source, 'recenter-negative', transform);
  const output = decodeIndexedMeshAsset(part.asset);

  assert.deepEqual(part.transform, {
    translationMm: [16, 28, 40],
    rotation: transform.rotation,
    scale: transform.scale,
  });
  assert.deepEqual(output.vertices, [
    [-1, -2, -3],
    [1, -2, -3],
    [-1, 2, -3],
    [-1, -2, 3],
  ]);
  assert.ok(signedVolume(part.asset) > 0, 'TriangleMesh::split flips a negative-volume component');
  assert.deepEqual(part.sourceTriangleIndices, [0, 1, 2, 3]);
});

await test('deduplicates identical recentered bytes through injected digest-aware asset IDs', () => {
  const source = identicalTetrahedra('identical-components');
  const observedDigests: string[] = [];
  const progress: VolumeSplitPreparationProgress[] = [];
  const ids = deterministicIds('identical-components');
  const first = prepareVolumeSplitParts({
    sourceAsset: source,
    sourceTransform: { ...identityTransform(), translationMm: [3, 4, 5] },
    onProgress(update) {
      progress.push(update);
    },
    idsForPart(request) {
      observedDigests.push(request.geometryDigest);
      return ids(request);
    },
  });
  const second = prepare(source, 'identical-components', {
    ...identityTransform(),
    translationMm: [3, 4, 5],
  });

  assert.equal(first.length, 2);
  assert.equal(observedDigests[0], observedDigests[1]);
  assert.equal(first[0].asset.descriptor.id, first[1].asset.descriptor.id);
  assert.deepEqual(first[0].asset, first[1].asset);
  assert.deepEqual(
    first.map((part) => part.transform.translationMm),
    [
      [4, 5, 6],
      [24, 5, 6],
    ],
  );
  assert.deepEqual(second, first);
  assert.deepEqual(progress.at(-1), { stage: 'encode', completed: 10, total: 10 });
  assert.deepEqual(
    [...new Set(progress.map((update) => update.stage))],
    ['decode', 'connectivity', 'components', 'encode'],
  );
});

await test('feeds the guarded canonical command and remains exact across undo and redo', () => {
  const fixture = createProjectFixture();
  const source = identicalTetrahedra('command-integration');
  const state = cloneProjectState(fixture.state);
  state.sourceAssets = [source.descriptor];
  const sourceVolume = state.plates[0].objects[0].volumes[0];
  sourceVolume.source = {
    assetId: source.descriptor.id,
    topologyRevision: 0,
    triangleCount: 8,
  };
  sourceVolume.transform = { ...identityTransform(), translationMm: [3, 4, 5] };

  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'volume', id: sourceVolume.id }], { kind: 'volume', id: sourceVolume.id });
  const assets = new InMemoryAssetRepository();
  assets.put(source.descriptor, source.bytes);
  const bus = new CommandBus({ project, selection, assets });
  const beforeState = canonicalStringify(project.getSnapshot().state);
  const beforeAssets = assets.capture();
  const beforeSelection = selection.getSnapshot();
  const parts = prepare(source, 'command-integration', sourceVolume.transform);

  bus.execute(new SplitVolumeToPartsCommand(captureVolumeSplitGuard(state, sourceVolume.id), parts));
  const afterState = canonicalStringify(project.getSnapshot().state);
  const afterAssets = assets.capture();
  const afterSelection = selection.getSnapshot();
  assert.deepEqual(
    project.getSnapshot().state.plates[0].objects[0].volumes.map((volume) => volume.id),
    parts.map((part) => part.volumeId),
  );
  assert.equal(project.getSnapshot().state.sourceAssets.length, 1);
  assert.equal(project.getSnapshot().state.sourceAssets[0].id, parts[0].asset.descriptor.id);

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), beforeState);
  assert.deepEqual(assets.capture(), beforeAssets);
  assert.deepEqual(selection.getSnapshot(), beforeSelection);
  assert.equal(bus.redo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), afterState);
  assert.deepEqual(assets.capture(), afterAssets);
  assert.deepEqual(selection.getSnapshot(), afterSelection);
});

await test('exposes deterministic progress and aborts before identity allocation', () => {
  const source = asset('cancellation', [0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0], [0, 1, 2, 3, 4, 5]);
  const controller = new AbortController();
  const progress: VolumeSplitPreparationProgress[] = [];
  let identityCalls = 0;
  assert.throws(
    () =>
      prepareVolumeSplitParts({
        sourceAsset: source,
        sourceTransform: identityTransform(),
        signal: controller.signal,
        onProgress(update) {
          progress.push(update);
          if (update.stage === 'connectivity' && update.completed === 1) controller.abort();
        },
        idsForPart() {
          identityCalls += 1;
          return {
            volumeId: entityId<'volume'>('import:test:cancelled-volume'),
            assetId: entityId<'asset'>('import:test:cancelled-asset'),
          };
        },
      }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(identityCalls, 0);
  assert.deepEqual(progress.slice(0, 4), [
    { stage: 'decode', completed: 0, total: 1 },
    { stage: 'decode', completed: 1, total: 1 },
    { stage: 'connectivity', completed: 0, total: 4 },
    { stage: 'connectivity', completed: 1, total: 4 },
  ]);
});

await test('fails closed on malformed topology, transforms, and injected ID conflicts', () => {
  const repeatedVertex = asset('repeated-index', [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 2]);
  assert.throws(() => prepare(repeatedVertex, 'repeated-index'), /triangle 0 repeats a vertex index/i);

  const invalidIndex = asset('invalid-index', [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
  const invalidBytes = invalidIndex.bytes.slice();
  const indices = invalidIndex.descriptor.mesh!.indices!;
  new DataView(invalidBytes.buffer).setUint32(indices.byteOffset, 99, true);
  const invalidPayload: AssetPayload = {
    descriptor: {
      ...invalidIndex.descriptor,
      digest: contentDigest(invalidBytes),
    },
    bytes: invalidBytes,
  };
  assert.throws(() => prepare(invalidPayload, 'invalid-index'), /index is outside the vertex buffer/i);

  const twoComponents = asset(
    'identity-conflicts',
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0],
    [0, 1, 2, 3, 4, 5],
  );
  assert.throws(
    () =>
      prepareVolumeSplitParts({
        sourceAsset: twoComponents,
        sourceTransform: { ...identityTransform(), translationMm: [Number.NaN, 0, 0] },
        idsForPart: deterministicIds('nan-transform'),
      }),
    /transform must be finite/i,
  );
  assert.throws(
    () =>
      prepareVolumeSplitParts({
        sourceAsset: twoComponents,
        sourceTransform: identityTransform(),
        idsForPart: () => ({
          volumeId: entityId<'volume'>('import:test:duplicate-volume'),
          assetId: entityId<'asset'>('import:test:duplicate-asset'),
        }),
      }),
    /volume ID .* is duplicated/i,
  );
  assert.throws(
    () =>
      prepareVolumeSplitParts({
        sourceAsset: twoComponents,
        sourceTransform: identityTransform(),
        idsForPart: (request) => ({
          volumeId: entityId<'volume'>(`import:test:digest-conflict-volume-${request.partIndex}`),
          assetId: entityId<'asset'>(`import:test:digest-conflict-asset-${request.partIndex}`),
        }),
      }),
    /identical split geometry .* resolved to both/i,
  );
  assert.throws(
    () =>
      prepareVolumeSplitParts({
        sourceAsset: twoComponents,
        sourceTransform: identityTransform(),
        idsForPart: (request) => {
          const reused = entityId<'asset'>('import:test:cross-kind-reuse');
          return {
            volumeId:
              request.partIndex === 0
                ? (reused as unknown as VolumeId)
                : entityId<'volume'>('import:test:cross-kind-volume'),
            assetId: reused,
          };
        },
      }),
    /reused by a prepared split volume and asset/i,
  );
});

console.log(`\nSplit preparation: ${passed} tests passed.`);
