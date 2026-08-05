import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  Bbs3mfProjectSerializer,
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  ReplaceVolumeMeshCommand,
  SelectionStore,
  canonicalStringify,
  cloneJson,
  cloneProjectState,
  contentDigest,
  emptyFacetAnnotations,
  encodeIndexedMeshAsset,
  entityId,
  isTopologyCurrent,
  type AssetId,
  type AssetPayload,
  type MeshTopologyReplacementGuard,
  type ProjectState,
  type ProjectVolume,
} from '../..';
import { ThreeProjectSurface } from '../../surfaces/ThreeProjectSurface';
import { createProjectFixture, type ProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(state?: ProjectState) {
  const fixture = createProjectFixture();
  const project = new ProjectStore(state ?? fixture.state);
  const selection = new SelectionStore();
  selection.set(
    [
      { kind: 'volume', id: fixture.ids.volume },
      { kind: 'instance', id: fixture.ids.instance },
    ],
    { kind: 'volume', id: fixture.ids.volume },
  );
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, project, selection, assets, bus };
}

function guardFor(fixture: ProjectFixture, state: ProjectState): MeshTopologyReplacementGuard {
  const volume = state.plates[0].objects[0].volumes.find((candidate) => candidate.id === fixture.ids.volume)!;
  const descriptor = state.sourceAssets.find((candidate) => candidate.id === volume.source.assetId)!;
  return {
    volumeId: volume.id,
    assetId: volume.source.assetId,
    assetDigest: descriptor.digest,
    topologyRevision: volume.source.topologyRevision,
    triangleCount: volume.source.triangleCount,
  };
}

function replacement(suffix: string, id?: AssetId): AssetPayload {
  return encodeIndexedMeshAsset({
    id: id ?? entityId<'asset'>(`import:test:topology-replacement-${suffix}`),
    positions: [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0],
    indices: [0, 1, 2, 0, 2, 3],
    sourceFilename: `${suffix}.stl`,
    provenance: { source: 'generated', uri: `test:${suffix}` },
  });
}

function annotatedState(fixture: ProjectFixture): ProjectState {
  const state = cloneProjectState(fixture.state);
  const volume = state.plates[0].objects[0].volumes[0];
  volume.transform = {
    translationMm: [3, 4, 5],
    rotation: [0, 0, 0, 1],
    scale: [1.25, 0.75, 2],
  };
  volume.config = { wall_loops: 5, sparse_infill_density: 31 };
  volume.extensionData = { 'test:opaque': { preserve: true } };
  volume.annotations = {
    topologyRevision: 0,
    color: [{ triangles: [0], value: fixture.ids.mixed }],
    support: [{ triangles: [0], value: 'enforce' }],
    seam: [{ triangles: [0], value: 'prefer' }],
    fuzzySkin: [{ triangles: [0], value: true }],
    brim: [{ triangles: [0], value: true }],
  };
  return state;
}

function nonTopologyMetadata(volume: ProjectVolume): object {
  return cloneJson({
    id: volume.id,
    name: volume.name,
    role: volume.role,
    transform: volume.transform,
    config: volume.config,
    ...(volume.filamentId ? { filamentId: volume.filamentId } : {}),
    ...(volume.extensionData ? { extensionData: volume.extensionData } : {}),
  });
}

function assertRejectedWithoutMutation(
  harnessValue: ReturnType<typeof harness>,
  operation: () => void,
  expected: RegExp,
): void {
  const { project, assets, selection, bus } = harnessValue;
  const stateBefore = canonicalStringify(project.getSnapshot().state);
  const assetsBefore = assets.capture();
  const selectionBefore = selection.getSnapshot();
  const historyBefore = bus.getHistorySnapshot();

  assert.throws(operation, expected);
  assert.equal(canonicalStringify(project.getSnapshot().state), stateBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(bus.getHistorySnapshot(), historyBefore);
}

await test('replaces one topology, resets every facet channel, and owns exact undo/redo assets', () => {
  const fixture = createProjectFixture();
  const state = annotatedState(fixture);
  const { project, assets, selection, bus } = harness(state);
  const nextAsset = replacement('exact');
  const guard = guardFor(fixture, state);
  const command = new ReplaceVolumeMeshCommand(guard, nextAsset);
  const stateBefore = canonicalStringify(project.getSnapshot().state);
  const assetsBefore = assets.capture();
  const selectionBefore = selection.getSnapshot();
  const metadataBefore = nonTopologyMetadata(state.plates[0].objects[0].volumes[0]);

  bus.execute(command);

  const currentSnapshot = project.getSnapshot();
  const currentVolume = currentSnapshot.state.plates[0].objects[0].volumes[0];
  assert.deepEqual(currentVolume.source, {
    assetId: nextAsset.descriptor.id,
    topologyRevision: 1,
    triangleCount: 2,
  });
  assert.deepEqual(currentVolume.annotations, emptyFacetAnnotations(1));
  assert.deepEqual(nonTopologyMetadata(currentVolume), metadataBefore);
  assert.equal(currentSnapshot.state.sourceAssets.length, 1);
  assert.equal(currentSnapshot.state.sourceAssets[0].id, nextAsset.descriptor.id);
  assert.equal(assets.has(fixture.ids.asset), false);
  assert.deepEqual(assets.get(nextAsset.descriptor.id), nextAsset);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(isTopologyCurrent(currentSnapshot.state, { volumeId: guard.volumeId, topologyRevision: 0 }), false);
  assert.equal(isTopologyCurrent(currentSnapshot.state, { volumeId: guard.volumeId, topologyRevision: 1 }), true);
  assert.ok(
    command.estimateBytes() >= fixture.asset.bytes.byteLength + nextAsset.bytes.byteLength,
    'history estimate accounts for both owned mesh payloads',
  );
  assert.deepEqual(bus.getHistorySnapshot(), {
    undoCount: 1,
    redoCount: 0,
    undoLabel: 'Replace mesh topology',
    redoLabel: undefined,
    dirtyCategories: ['projectData'],
  });

  const stateAfter = canonicalStringify(currentSnapshot.state);
  const assetsAfter = assets.capture();
  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), stateBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);

  assert.equal(bus.redo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), stateAfter);
  assert.deepEqual(assets.capture(), assetsAfter);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
});

await test('retains a shared old asset until the final canonical reference is gone', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const original = state.plates[0].objects[0].volumes[0];
  const shared = cloneJson(original);
  shared.id = entityId<'volume'>('import:test:shared-topology-volume');
  shared.name = 'Shared source';
  shared.annotations = emptyFacetAnnotations(0);
  state.plates[0].objects[0].volumes.push(shared);
  const { project, assets, bus } = harness(state);
  const nextAsset = replacement('shared');
  const before = canonicalStringify(project.getSnapshot().state);
  const assetsBefore = assets.capture();

  bus.execute(new ReplaceVolumeMeshCommand(guardFor(fixture, state), nextAsset));

  const current = project.getSnapshot().state;
  assert.equal(current.sourceAssets.length, 2);
  assert.equal(assets.has(fixture.ids.asset), true);
  assert.equal(assets.has(nextAsset.descriptor.id), true);
  assert.equal(current.plates[0].objects[0].volumes[1].source.assetId, fixture.ids.asset);

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.equal(bus.redo(), true);
  assert.equal(assets.has(fixture.ids.asset), true);
  assert.equal(assets.has(nextAsset.descriptor.id), true);
});

await test('rejects missing and stale source guards without state, asset, selection, dirty, or history changes', () => {
  const h = harness();
  const guard = guardFor(h.fixture, h.project.getSnapshot().state);
  const nextAsset = replacement('stale');
  const cases: Array<[MeshTopologyReplacementGuard, RegExp]> = [
    [
      {
        ...guard,
        volumeId: entityId<'volume'>('import:test:missing-topology-volume'),
      },
      /stale topology guard.*missing/i,
    ],
    [
      {
        ...guard,
        assetId: entityId<'asset'>('import:test:stale-topology-asset'),
      },
      /stale topology guard.*mesh asset/i,
    ],
    [{ ...guard, assetDigest: 'fnv1a64:stale' }, /stale topology guard.*digest/i],
    [{ ...guard, topologyRevision: guard.topologyRevision + 1 }, /stale topology guard.*revision/i],
    [{ ...guard, triangleCount: guard.triangleCount + 1 }, /stale topology guard.*triangle/i],
  ];

  for (const [staleGuard, expected] of cases) {
    assertRejectedWithoutMutation(
      h,
      () => h.bus.execute(new ReplaceVolumeMeshCommand(staleGuard, nextAsset)),
      expected,
    );
  }
});

await test('rejects malformed, empty, duplicate, and colliding replacement assets atomically', () => {
  const h = harness();
  const guard = guardFor(h.fixture, h.project.getSnapshot().state);

  const malformedSource = replacement('malformed');
  const malformedBytes = malformedSource.bytes.slice(0, -1);
  const malformed: AssetPayload = {
    descriptor: {
      ...cloneJson(malformedSource.descriptor),
      byteLength: malformedBytes.byteLength,
      digest: contentDigest(malformedBytes),
    },
    bytes: malformedBytes,
  };
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new ReplaceVolumeMeshCommand(guard, malformed)),
    /outside the payload/i,
  );

  const empty = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:empty-topology-asset'),
    positions: [],
  });
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new ReplaceVolumeMeshCommand(guard, empty)),
    /at least one vertex and one triangle/i,
  );

  const currentIdCollision = replacement('current-id', h.fixture.ids.asset);
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new ReplaceVolumeMeshCommand(guard, currentIdCollision)),
    /collides with the current mesh asset/i,
  );

  const duplicateDigest = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:duplicate-topology-digest'),
    positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  });
  assert.equal(duplicateDigest.descriptor.digest, h.fixture.asset.descriptor.digest);
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new ReplaceVolumeMeshCommand(guard, duplicateDigest)),
    /digest already exists/i,
  );

  const globalIdCollision = replacement('global-id', h.fixture.ids.object as unknown as AssetId);
  assertRejectedWithoutMutation(
    h,
    () => h.bus.execute(new ReplaceVolumeMeshCommand(guard, globalIdCollision)),
    /invalid project state/i,
  );
  assert.equal(h.assets.has(globalIdCollision.descriptor.id), false);
});

await test('refreshes the stable Three projection and restores it through topology undo', () => {
  const h = harness();
  const nextAsset = replacement('projection');
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({
    parent: scene,
    assets: h.assets,
    mapping: { bedSizeMm: [200, 100], worldUnitsPerMm: 0.002 },
  });
  surface.renderProject(h.project.getSnapshot());
  const mesh = surface.getVolumeMesh(h.fixture.ids.instance, h.fixture.ids.volume)!;
  const originalGeometry = mesh.geometry;

  h.bus.execute(new ReplaceVolumeMeshCommand(guardFor(h.fixture, h.project.getSnapshot().state), nextAsset));
  const replacedSnapshot = h.project.getSnapshot();
  surface.renderProject(replacedSnapshot);
  assert.strictEqual(surface.getVolumeMesh(h.fixture.ids.instance, h.fixture.ids.volume), mesh);
  assert.notStrictEqual(mesh.geometry, originalGeometry);
  assert.equal(mesh.geometry.getIndex()!.count / 3, 2);
  surface.assertProjectionCurrent(replacedSnapshot);

  assert.equal(h.bus.undo(), true);
  const restoredSnapshot = h.project.getSnapshot();
  surface.renderProject(restoredSnapshot);
  assert.strictEqual(surface.getVolumeMesh(h.fixture.ids.instance, h.fixture.ids.volume), mesh);
  assert.equal(mesh.geometry.getIndex()!.count / 3, 1);
  surface.assertProjectionCurrent(restoredSnapshot);
  surface.dispose();
});

await test('saves and reopens the replacement asset and bumped topology exactly', async () => {
  const h = harness();
  const nextAsset = replacement('save-reopen');
  h.bus.execute(new ReplaceVolumeMeshCommand(guardFor(h.fixture, h.project.getSnapshot().state), nextAsset));
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
  assert.equal(reopened.state.plates[0].objects[0].volumes[0].source.topologyRevision, 1);
  assert.equal(reopened.state.plates[0].objects[0].volumes[0].source.triangleCount, 2);
  assert.equal(reopened.state.sourceAssets[0].id, nextAsset.descriptor.id);
});

console.log(`\nTopology replacement commands: ${passed} tests passed.`);
