import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  MeshBooleanCommand,
  ProjectStore,
  SelectionStore,
  assetBundleFingerprint,
  canonicalStringify,
  cloneProjectState,
  encodeIndexedMeshAsset,
  entityId,
  type AssetPayload,
  type MeshBooleanGuard,
  type ProjectState,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A zigzag strip of `triangles` facets; `size` keeps digests distinct. */
function strip(id: string, size: number, triangles = 4): AssetPayload {
  const positions: number[] = [];
  for (let vertex = 0; vertex < triangles + 2; vertex += 1) positions.push(vertex * size, (vertex % 2) * size, 0);
  const indices: number[] = [];
  for (let triangle = 0; triangle < triangles; triangle += 1) indices.push(triangle, triangle + 1, triangle + 2);
  return encodeIndexedMeshAsset({ id: entityId<'asset'>(id), positions, indices });
}

/**
 * The target object owns the fixture asset; a second object owns two more
 * assets declared after it, so apply removes three descriptors in sequence.
 */
function harness(triangles = 4) {
  const fixture = createProjectFixture();
  const state: ProjectState = cloneProjectState(fixture.state);
  const first = strip('import:test:boolean-other-a', 10, triangles);
  const second = strip('import:test:boolean-other-b', 12, triangles);
  const template = state.plates[0].objects[0];
  state.sourceAssets.push(first.descriptor, second.descriptor);
  state.plates[0].objects.push({
    id: entityId<'object'>('import:test:boolean-other'),
    name: 'Other',
    config: {},
    volumes: [first, second].map((asset, index) => ({
      ...template.volumes[0],
      id: entityId<'volume'>(`import:test:boolean-other-volume-${index}`),
      source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: triangles },
      annotations: { ...template.volumes[0].annotations, color: [] },
    })),
    instances: [{ ...template.instances[0], id: entityId<'instance'>('import:test:boolean-other-instance') }],
    layerRanges: [],
  });
  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  for (const payload of [fixture.asset, first, second]) assets.put(payload.descriptor, payload.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  const volume = template.volumes[0];
  const guard: MeshBooleanGuard = {
    targetInstanceId: fixture.ids.instance,
    targetVolumeId: volume.id,
    targetAssetId: volume.source.assetId,
    targetAssetDigest: fixture.asset.descriptor.digest,
    targetTopologyRevision: volume.source.topologyRevision,
    targetTriangleCount: volume.source.triangleCount,
    otherInstanceId: entityId<'instance'>('import:test:boolean-other-instance'),
  };
  return { project, assets, bus, guard, removed: [fixture.asset, first, second] };
}

test('undo restores the declared asset order and repository exactly', () => {
  const h = harness();
  const before = canonicalStringify(h.project.getSnapshot().state);
  const bundle = assetBundleFingerprint(h.assets.list());
  h.bus.execute(new MeshBooleanCommand(h.guard, strip('import:test:boolean-result', 20), 'UNION'));
  assert.deepEqual(
    h.project.getSnapshot().state.sourceAssets.map((asset) => asset.id),
    ['import:test:boolean-result'],
  );
  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before);
  assert.equal(assetBundleFingerprint(h.assets.list()), bundle);
  assert.equal(h.bus.redo(), true);
  assert.equal(h.bus.undo(), true);
  assert.equal(canonicalStringify(h.project.getSnapshot().state), before);
});

test('a boolean of an instance with itself is refused', () => {
  const h = harness();
  assert.throws(
    () =>
      new MeshBooleanCommand(
        { ...h.guard, otherInstanceId: h.guard.targetInstanceId },
        strip('import:test:boolean-self', 20),
        'A_NOT_B',
      ),
    /A mesh boolean needs two different instances/,
  );
});

test('history charges payloads by byte length, never by stringified bytes', () => {
  const h = harness(5000);
  const result = strip('import:test:boolean-charged', 20, 5000);
  const command = new MeshBooleanCommand(h.guard, result, 'INTERSECTION');
  h.bus.execute(command);
  const payloads = [result, ...h.removed].reduce(
    (total, payload) => total + canonicalStringify(payload.descriptor).length + payload.bytes.byteLength,
    0,
  );
  const estimate = command.estimateBytes();
  assert.ok(estimate > payloads, 'retained records are charged too');
  // Retained records are a few kilobytes; a stringified typed array would
  // cost several characters per payload byte.
  assert.ok(estimate - payloads < 16_384, `estimate ${estimate} stringified payload bytes`);
});

console.log(`\nMesh boolean commands: ${passed} tests passed.`);
