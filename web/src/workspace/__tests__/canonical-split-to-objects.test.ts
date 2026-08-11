import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createProjectFixture } from '../../project/__tests__/fixtures';
import { cloneJson, cloneProjectState, projectFingerprint } from '../../project/domain/canonical';
import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { encodeIndexedMeshAsset } from '../../project/meshCodec';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import {
  CanonicalSplitToObjectsTriangleLimitError,
  CanonicalWorkspaceController,
  StaleCanonicalSplitToObjectsError,
} from '../CanonicalWorkspaceController';

const NOW = '2026-08-01T12:00:00.000Z';
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    return `import:split-controller:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

function controller(splitToObjectsSynchronousTriangleLimit?: number): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectImportParser: new BbsProjectImportParser(),
    ...(splitToObjectsSynchronousTriangleLimit === undefined ? {} : { splitToObjectsSynchronousTriangleLimit }),
  });
}

function indexedTetrahedra(componentCount: 1 | 2, includeTinyTriangle = false): THREE.BufferGeometry {
  const positions = [
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    2,
    ...(componentCount === 2 ? [10, 0, 0, 12, 0, 0, 10, 2, 0, 10, 0, 2] : []),
    ...(includeTinyTriangle ? [20, 0, 0, 21, 0, 0, 20, 1, 0] : []),
  ];
  const tetrahedron = (offset: number): number[] => [
    offset,
    offset + 1,
    offset + 2,
    offset,
    offset + 3,
    offset + 1,
    offset + 1,
    offset + 3,
    offset + 2,
    offset + 2,
    offset + 3,
    offset,
  ];
  const indices = [
    ...tetrahedron(0),
    ...(componentCount === 2 ? tetrahedron(4) : []),
    ...(includeTinyTriangle ? [componentCount * 4, componentCount * 4 + 1, componentCount * 4 + 2] : []),
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

function canonicalSnapshot(workspace: CanonicalWorkspaceController): string {
  const snapshot = workspace.createCanonicalSliceSource().capture();
  return JSON.stringify({
    state: snapshot.state,
    assets: snapshot.assets.map((asset) => ({ descriptor: asset.descriptor, bytes: Array.from(asset.bytes) })),
    selection: workspace.getObjectsTree().selection,
  });
}

await test('splits connected bodies through one guarded transaction with exact undo and redo', () => {
  const workspace = controller();
  const geometry = indexedTetrahedra(2);
  const source = workspace.importBufferGeometry(geometry, {
    name: 'Two bodies',
    transform: { ...identityTransform(), translationMm: [3, 4, 5] },
  });
  const historyBefore = workspace.getSummary().history.undoCount;
  const confirmation = workspace.getSplitToObjectsConfirmation();

  assert.equal(Object.isFrozen(confirmation), true);
  assert.equal(confirmation.strategy, 'connected-components');
  assert.equal(confirmation.objectName, 'Two bodies');
  assert.equal(confirmation.triangleCount, 8);
  assert.deepEqual(confirmation.affectedInstanceIds, [source.instanceId]);

  const result = workspace.splitSelectedToObjects(confirmation.guard);
  const split = workspace.createCanonicalSliceSource().capture();
  assert.equal(result.strategy, 'connected-components');
  assert.equal(result.objectIds.length, 2);
  assert.equal(result.instanceIds.length, 2);
  assert.equal(result.volumeIds.length, 2);
  assert.equal(result.assetIds.length, 1, 'identical recentered bodies reuse one immutable asset');
  assert.equal(split.state.plates[0].objects.length, 2);
  assert.ok(
    split.state.plates[0].objects.every((object) => object.volumes.length === 1 && object.instances.length === 1),
  );
  assert.equal(split.state.sourceAssets.length, 1);
  assert.equal(workspace.getSummary().history.undoCount, historyBefore + 1);
  assert.deepEqual(workspace.getObjectsTree().selection, {
    refs: result.instanceIds.map((id) => ({ kind: 'instance' as const, id })),
    primary: { kind: 'instance', id: result.instanceIds[0] },
  });

  assert.equal(workspace.undo(), true);
  assert.ok(workspace.getInstance(source.instanceId));
  assert.equal(workspace.getSummary().objectCount, 1);
  assert.equal(workspace.getSummary().assetCount, 1);
  assert.deepEqual(workspace.getObjectsTree().selection.primary, { kind: 'instance', id: source.instanceId });
  assert.equal(workspace.redo(), true);
  assert.equal(workspace.getInstance(source.instanceId), undefined);
  assert.deepEqual(workspace.getObjectsTree().selection.primary, {
    kind: 'instance',
    id: result.instanceIds[0],
  });

  geometry.dispose();
  workspace.dispose();
});

await test('promotes existing model volumes while preserving volume identity, annotations, assets, and exact undo', async () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const object = state.plates[0].objects[0];
  const geometry = indexedTetrahedra(1);
  const asset = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: geometry.getAttribute('position').array,
    indices: geometry.getIndex()!.array,
    sourceFilename: 'tetrahedron.stl',
    provenance: { source: 'import', uri: 'fixture:tetrahedron' },
  });
  state.sourceAssets = [asset.descriptor];
  object.layerRanges = [];
  delete object.extensionData;
  const first = object.volumes[0];
  first.source.triangleCount = asset.descriptor.mesh!.triangleCount;
  first.config = { line_width: '0.42' };
  const second = cloneJson(first);
  second.id = entityId<'volume'>('import:split-controller:second-volume');
  second.name = 'Second body';
  second.transform.translationMm = [12, 0, 0];
  second.config = { line_width: '0.68' };
  object.volumes.push(second);
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state,
    assets: [asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(state),
  });
  const workspace = controller();
  await workspace.openCanonical3mf(archive.bytes);
  workspace.selectInstance(fixture.ids.instance);
  const before = canonicalSnapshot(workspace);
  const historyBefore = workspace.getSummary().history.undoCount;
  const confirmation = workspace.getSplitToObjectsConfirmation();
  assert.equal(confirmation.strategy, 'existing-volumes');
  assert.equal(confirmation.volumeCount, 2);

  const result = workspace.splitSelectedToObjects(confirmation.guard);
  const split = workspace.createCanonicalSliceSource().capture();
  assert.equal(result.strategy, 'existing-volumes');
  assert.deepEqual(result.volumeIds, [first.id, second.id]);
  assert.deepEqual(result.assetIds, []);
  assert.equal(split.state.plates[0].objects.length, 2);
  assert.equal(split.state.sourceAssets.length, 1);
  assert.deepEqual(
    split.state.plates[0].objects.map((candidate) => candidate.config.line_width),
    ['0.42', '0.68'],
  );
  assert.deepEqual(
    split.state.plates[0].objects.map((candidate) => candidate.volumes[0].annotations),
    [first.annotations, second.annotations],
  );
  assert.equal(workspace.getSummary().history.undoCount, historyBefore + 1);

  assert.equal(workspace.undo(), true);
  assert.equal(canonicalSnapshot(workspace), before);
  assert.equal(workspace.getSummary().history.redoCount, 1);
  assert.equal(workspace.redo(), true);
  assert.deepEqual(
    workspace
      .createCanonicalSliceSource()
      .capture()
      .state.plates[0].objects.map((candidate) => candidate.id),
    result.objectIds,
  );
  geometry.dispose();
  workspace.dispose();
});

await test('rejects connected-component splitting when paint exists only in refined leaves', async () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const geometry = indexedTetrahedra(1);
  const asset = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: geometry.getAttribute('position').array,
    indices: geometry.getIndex()!.array,
    sourceFilename: 'refined-tetrahedron.stl',
  });
  state.sourceAssets = [asset.descriptor];
  const object = state.plates[0].objects[0];
  object.layerRanges = [];
  const volume = object.volumes[0];
  volume.source.triangleCount = 4;
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 2,
      triangleCount: 4,
      splits: [
        {
          triangle: 0,
          node: {
            kind: 'split',
            splitSides: 1,
            specialSide: 0,
            children: [
              { kind: 'leaf', state: { kind: 'assigned', value: fixture.ids.physical0 } },
              { kind: 'leaf', state: { kind: 'assigned', value: fixture.ids.physical1 } },
            ],
          },
        },
      ],
    },
  };
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state,
    assets: [asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(state),
  });
  const workspace = controller();
  await workspace.openCanonical3mf(archive.bytes);
  workspace.selectInstance(fixture.ids.instance);
  const before = canonicalSnapshot(workspace);

  assert.throws(() => workspace.getSplitToObjectsConfirmation(), /painted facet annotations/);
  assert.equal(canonicalSnapshot(workspace), before);
  assert.equal(workspace.getSummary().history.undoCount, 0);

  geometry.dispose();
  workspace.dispose();
});

await test('rejects stale, unselected, oversized, connected, and lossy requests without canonical mutation', () => {
  const staleWorkspace = controller();
  const staleGeometry = indexedTetrahedra(2);
  const staleSource = staleWorkspace.importBufferGeometry(staleGeometry, { name: 'Stale split' });
  const stale = staleWorkspace.getSplitToObjectsConfirmation();
  staleWorkspace.setInstanceTransform(staleSource.instanceId, {
    ...identityTransform(),
    translationMm: [1, 0, 0],
  });
  const afterTransform = canonicalSnapshot(staleWorkspace);
  assert.throws(() => staleWorkspace.splitSelectedToObjects(stale.guard), StaleCanonicalSplitToObjectsError);
  assert.equal(canonicalSnapshot(staleWorkspace), afterTransform);
  staleWorkspace.clearSelection();
  assert.throws(() => staleWorkspace.getSplitToObjectsConfirmation(), /primary selected model instance/);
  staleGeometry.dispose();
  staleWorkspace.dispose();

  const cappedWorkspace = controller(7);
  const cappedGeometry = indexedTetrahedra(2);
  cappedWorkspace.importBufferGeometry(cappedGeometry, { name: 'Over cap' });
  assert.throws(() => cappedWorkspace.getSplitToObjectsConfirmation(), CanonicalSplitToObjectsTriangleLimitError);
  cappedGeometry.dispose();
  cappedWorkspace.dispose();

  const connectedWorkspace = controller();
  const connectedGeometry = indexedTetrahedra(1);
  connectedWorkspace.importBufferGeometry(connectedGeometry, { name: 'One body' });
  const connectedGuard = connectedWorkspace.getSplitToObjectsConfirmation().guard;
  const connectedBefore = canonicalSnapshot(connectedWorkspace);
  assert.throws(() => connectedWorkspace.splitSelectedToObjects(connectedGuard), /one shared-edge component/i);
  assert.equal(canonicalSnapshot(connectedWorkspace), connectedBefore);
  connectedGeometry.dispose();
  connectedWorkspace.dispose();

  const lossyWorkspace = controller();
  const lossyGeometry = indexedTetrahedra(1, true);
  lossyWorkspace.importBufferGeometry(lossyGeometry, { name: 'Tiny component' });
  const lossyGuard = lossyWorkspace.getSplitToObjectsConfirmation().guard;
  const lossyBefore = canonicalSnapshot(lossyWorkspace);
  assert.throws(() => lossyWorkspace.splitSelectedToObjects(lossyGuard), /fewer than three facets/i);
  assert.equal(canonicalSnapshot(lossyWorkspace), lossyBefore);
  lossyGeometry.dispose();
  lossyWorkspace.dispose();
});

console.log(`\n${passed} canonical split-to-objects tests passed.`);
