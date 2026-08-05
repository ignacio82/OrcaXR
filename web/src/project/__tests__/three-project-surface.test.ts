import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  InMemoryAssetRepository,
  ProjectStore,
  cloneJson,
  cloneProjectState,
  contentDigest,
  encodeIndexedMeshAsset,
  entityId,
  type AssetPayload,
  type ProjectObject,
  type ProjectState,
  type SourceAssetDescriptor,
} from '..';
import {
  ThreeProjectProjectionError,
  ThreeProjectSurface,
  getThreeProjectEntity,
  printerMmToThreePosition,
} from '../surfaces/ThreeProjectSurface';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const MAPPING = { bedSizeMm: [200, 100] as const, worldUnitsPerMm: 0.002 };

test('keeps stable scene identities while projecting canonical transforms and history', () => {
  const fixture = createProjectFixture();
  const assets = repositoryWith(fixture.asset);
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING });
  const store = new ProjectStore(fixture.state);
  const original = store.getSnapshot();
  surface.renderProject(original);

  const group = surface.getInstanceGroup(fixture.ids.instance)!;
  const mesh = surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume)!;
  assert.ok(group instanceof THREE.Group);
  assert.ok(mesh instanceof THREE.Mesh);

  const translated = cloneProjectState(fixture.state);
  translated.plates[0].objects[0].instances[0].transform.translationMm = [10, 20, 30];
  translated.plates[0].objects[0].volumes[0].transform.translationMm = [1, 2, 3];
  const translatedSnapshot = store.replaceState(translated);
  surface.renderProject(translatedSnapshot);
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.strictEqual(surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume), mesh);

  scene.updateMatrixWorld(true);
  const worldOrigin = mesh.getWorldPosition(new THREE.Vector3());
  assertVector(worldOrigin, printerMmToThreePosition([11, 22, 33], MAPPING));
  assert.deepEqual(group.position.toArray(), [10, 20, 30]);
  assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);

  const transformed = cloneProjectState(translated);
  transformed.plates[0].objects[0].instances[0].transform.rotation = [0, 0, 2, 2];
  transformed.plates[0].objects[0].instances[0].transform.scale = [2, 3, 4];
  const transformedSnapshot = store.replaceState(transformed);
  surface.renderProject(transformedSnapshot);
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.deepEqual(group.scale.toArray(), [2, 3, 4]);
  assert.ok(Math.abs(group.quaternion.length() - 1) < 1e-12);

  // A history projection of the original immutable snapshot updates the same
  // viewer objects instead of introducing a second scene-side identity.
  surface.renderProject(original);
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.strictEqual(surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume), mesh);
  assert.deepEqual(group.position.toArray(), [0, 0, 0]);
  surface.assertProjectionCurrent(original);
  assert.throws(() => surface.assertProjectionCurrent(transformedSnapshot), /does not represent/);
  surface.dispose();
});

test('projects every volume for every repeated instance and retains shared geometry while referenced', () => {
  const fixture = createProjectFixture();
  const secondary = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:three-surface-secondary'),
    positions: [0, 0, 0, 0, 8, 0, 0, 0, 8],
    indices: [0, 1, 2],
  });
  const state = cloneProjectState(fixture.state);
  state.sourceAssets.push(secondary.descriptor);
  const object = state.plates[0].objects[0];
  const secondVolumeId = entityId<'volume'>('import:test:three-surface-volume-2');
  object.volumes.push({
    ...cloneJson(object.volumes[0]),
    id: secondVolumeId,
    name: 'Inset',
    source: { assetId: secondary.descriptor.id, topologyRevision: 0, triangleCount: 1 },
  });
  const secondInstanceId = entityId<'instance'>('import:test:three-surface-instance-2');
  object.instances.push({
    ...cloneJson(object.instances[0]),
    id: secondInstanceId,
    name: 'Repeated copy',
    transform: { ...cloneJson(object.instances[0].transform), translationMm: [30, 0, 0] },
  });

  const assets = repositoryWith(fixture.asset, secondary);
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING });
  const store = new ProjectStore(state);
  surface.renderProject(store.getSnapshot());

  for (const instanceId of [fixture.ids.instance, secondInstanceId]) {
    assert.equal(surface.getInstanceGroup(instanceId)!.children.length, 2);
    assert.ok(surface.getVolumeMesh(instanceId, fixture.ids.volume));
    assert.ok(surface.getVolumeMesh(instanceId, secondVolumeId));
  }
  const bodyGeometry = surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume)!.geometry;
  const insetGeometry = surface.getVolumeMesh(fixture.ids.instance, secondVolumeId)!.geometry;
  assert.strictEqual(surface.getVolumeMesh(secondInstanceId, fixture.ids.volume)!.geometry, bodyGeometry);
  assert.strictEqual(surface.getVolumeMesh(secondInstanceId, secondVolumeId)!.geometry, insetGeometry);

  let bodyDisposals = 0;
  let insetDisposals = 0;
  bodyGeometry.addEventListener('dispose', () => bodyDisposals++);
  insetGeometry.addEventListener('dispose', () => insetDisposals++);
  const oneInstance = cloneProjectState(state);
  oneInstance.plates[0].objects[0].instances.splice(1, 1);
  surface.renderProject(store.replaceState(oneInstance));
  assert.equal(bodyDisposals, 0);
  assert.equal(insetDisposals, 0);

  const empty = cloneProjectState(oneInstance);
  empty.plates[0].objects = [];
  surface.renderProject(store.replaceState(empty));
  assert.equal(bodyDisposals, 1);
  assert.equal(insetDisposals, 1);
  surface.dispose();
});

test('filters inactive plates and projects stable selection references', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const plate2 = entityId<'plate'>('import:test:three-surface-plate-2');
  const object2 = cloneObjectWithIds(state.plates[0].objects[0], 'second');
  state.plates.push({
    id: plate2,
    name: 'Plate 2',
    order: 1,
    printable: true,
    config: {},
    objects: [object2],
  });
  const assets = repositoryWith(fixture.asset);
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING });
  const store = new ProjectStore(state);
  surface.renderProject(store.getSnapshot());

  const firstGroup = surface.getInstanceGroup(fixture.ids.instance)!;
  const secondGroup = surface.getInstanceGroup(object2.instances[0].id)!;
  const secondMesh = surface.getVolumeMesh(object2.instances[0].id, object2.volumes[0].id)!;
  assert.equal(firstGroup.visible, true);
  assert.equal(secondGroup.visible, false);
  assert.deepEqual(getThreeProjectEntity(firstGroup), {
    kind: 'instance',
    plateId: fixture.ids.plate,
    objectId: fixture.ids.object,
    instanceId: fixture.ids.instance,
    printable: true,
    selected: false,
    primary: false,
  });

  surface.renderSelection({
    refs: [
      { kind: 'object', id: fixture.ids.object },
      { kind: 'volume', id: object2.volumes[0].id },
    ],
    primary: { kind: 'volume', id: object2.volumes[0].id },
  });
  assert.equal(getThreeProjectEntity(firstGroup)!.selected, true);
  assert.equal(getThreeProjectEntity(secondGroup)!.selected, false);
  assert.equal(getThreeProjectEntity(secondMesh)!.selected, true);
  assert.equal(getThreeProjectEntity(secondMesh)!.primary, true);

  const switched = cloneProjectState(state);
  switched.activePlateId = plate2;
  surface.renderProject(store.replaceState(switched));
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), firstGroup);
  assert.strictEqual(surface.getInstanceGroup(object2.instances[0].id), secondGroup);
  assert.equal(firstGroup.visible, false);
  assert.equal(secondGroup.visible, true);
  assert.equal(getThreeProjectEntity(secondMesh)!.primary, true);
  surface.dispose();
});

test('replaces geometry by AssetId plus digest without replacing stable viewers', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const repeatedId = entityId<'instance'>('import:test:three-surface-replacement-copy');
  state.plates[0].objects[0].instances.push({
    ...cloneJson(state.plates[0].objects[0].instances[0]),
    id: repeatedId,
  });
  const assets = repositoryWith(fixture.asset);
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING });
  const store = new ProjectStore(state);
  surface.renderProject(store.getSnapshot());

  const firstMesh = surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume)!;
  const repeatedMesh = surface.getVolumeMesh(repeatedId, fixture.ids.volume)!;
  const oldGeometry = firstMesh.geometry;
  let oldDisposals = 0;
  oldGeometry.addEventListener('dispose', () => oldDisposals++);

  const replacement = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: [0, 0, 0, 20, 0, 0, 0, 20, 0],
    indices: [0, 1, 2],
  });
  assets.remove(fixture.ids.asset);
  assets.put(replacement.descriptor, replacement.bytes);
  const replacedState = cloneProjectState(state);
  replacedState.sourceAssets[0] = replacement.descriptor;
  const replaced = store.replaceState(replacedState);
  surface.renderProject(replaced);

  assert.strictEqual(surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume), firstMesh);
  assert.strictEqual(surface.getVolumeMesh(repeatedId, fixture.ids.volume), repeatedMesh);
  assert.notStrictEqual(firstMesh.geometry, oldGeometry);
  assert.strictEqual(repeatedMesh.geometry, firstMesh.geometry);
  assert.equal(oldDisposals, 1);
  const replacementGeometry = firstMesh.geometry;
  surface.renderProject(replaced);
  assert.strictEqual(firstMesh.geometry, replacementGeometry);
  surface.dispose();
});

test('fails closed on cache collisions, missing bytes, and malformed assets without changing the good scene', () => {
  const fixture = createProjectFixture();
  const declared = withDeclaredDigest(fixture.asset, 'sha256:test-declared-digest');
  const assets = repositoryWith(declared);
  const failures: string[] = [];
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({
    parent: scene,
    assets,
    mapping: MAPPING,
    onProjectionError: (failure) => failures.push(failure.code),
  });
  const initialState = cloneProjectState(fixture.state);
  initialState.sourceAssets[0] = declared.descriptor;
  const store = new ProjectStore(initialState);
  const good = store.getSnapshot();
  surface.renderProject(good);
  const group = surface.getInstanceGroup(fixture.ids.instance)!;
  const mesh = surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume)!;
  const goodGeometry = mesh.geometry;

  const collidingBytes = declared.bytes.slice();
  new DataView(collidingBytes.buffer).setFloat32(0, 42, true);
  assets.remove(declared.descriptor.id);
  assets.put(declared.descriptor, collidingBytes);
  assert.throws(
    () => surface.renderProject(good),
    (error: unknown) => error instanceof ThreeProjectProjectionError && error.code === 'asset-cache-collision',
  );
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.strictEqual(mesh.geometry, goodGeometry);
  assets.remove(declared.descriptor.id);
  assets.put(declared.descriptor, declared.bytes);

  const missing = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:three-surface-missing'),
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  });
  const staged = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:three-surface-staged'),
    positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
  });
  assets.put(staged.descriptor, staged.bytes);
  const missingState = addVolume(addVolume(initialState, staged.descriptor, 'staged'), missing.descriptor, 'missing');
  const missingSnapshot = store.replaceState(missingState);
  const originalDispose = THREE.BufferGeometry.prototype.dispose;
  let planLocalDisposals = 0;
  THREE.BufferGeometry.prototype.dispose = function disposePlanLocalGeometry(): void {
    planLocalDisposals += 1;
    originalDispose.call(this);
  };
  try {
    assert.throws(
      () => surface.renderProject(missingSnapshot),
      (error: unknown) => error instanceof ThreeProjectProjectionError && error.code === 'missing-asset',
    );
  } finally {
    THREE.BufferGeometry.prototype.dispose = originalDispose;
  }
  assert.equal(planLocalDisposals, 1, 'a geometry staged before the later missing asset was released');
  assert.throws(() => surface.assertProjectionCurrent(missingSnapshot), ThreeProjectProjectionError);
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.equal(group.children.length, 1);

  const malformed = malformedFiniteMesh('import:test:three-surface-malformed');
  assets.put(malformed.descriptor, malformed.bytes);
  const malformedState = addVolume(initialState, malformed.descriptor, 'malformed');
  const malformedSnapshot = store.replaceState(malformedState);
  assert.throws(
    () => surface.renderProject(malformedSnapshot),
    (error: unknown) => error instanceof ThreeProjectProjectionError && error.code === 'invalid-mesh',
  );
  assert.strictEqual(surface.getInstanceGroup(fixture.ids.instance), group);
  assert.equal(group.children.length, 1);
  assert.deepEqual(failures, ['asset-cache-collision', 'missing-asset', 'invalid-mesh']);

  assets.remove(declared.descriptor.id);
  assets.put(declared.descriptor, declared.bytes);
  surface.renderProject(good);
  assert.deepEqual(surface.getProjectionStatus(), {
    state: 'ready',
    sourceRevision: good.revision,
    sourceHash: good.hash,
  });
  surface.dispose();
});

test('disposes each shared GPU resource once and preserves caller-owned materials', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const repeatedId = entityId<'instance'>('import:test:three-surface-cleanup-copy');
  state.plates[0].objects[0].instances.push({
    ...cloneJson(state.plates[0].objects[0].instances[0]),
    id: repeatedId,
  });
  const assets = repositoryWith(fixture.asset);
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  let materialDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++);
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING, material });
  surface.renderProject(new ProjectStore(state).getSnapshot());
  const geometry = surface.getVolumeMesh(fixture.ids.instance, fixture.ids.volume)!.geometry;
  assert.strictEqual(surface.getVolumeMesh(repeatedId, fixture.ids.volume)!.geometry, geometry);
  let geometryDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);

  surface.dispose();
  surface.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 0);
  assert.equal(surface.root.parent, null);
  assert.equal(surface.root.children.length, 0);
  assert.deepEqual(surface.getProjectionStatus(), { state: 'disposed' });
  material.dispose();
});

function repositoryWith(...payloads: AssetPayload[]): InMemoryAssetRepository {
  const repository = new InMemoryAssetRepository();
  for (const payload of payloads) repository.put(payload.descriptor, payload.bytes);
  return repository;
}

function cloneObjectWithIds(source: ProjectObject, suffix: string): ProjectObject {
  const object = cloneJson(source);
  object.id = entityId<'object'>(`import:test:three-surface-object-${suffix}`);
  object.volumes[0].id = entityId<'volume'>(`import:test:three-surface-volume-${suffix}`);
  object.instances[0].id = entityId<'instance'>(`import:test:three-surface-instance-${suffix}`);
  object.layerRanges[0].id = entityId<'layer-range'>(`import:test:three-surface-range-${suffix}`);
  return object;
}

function addVolume(state: ProjectState, descriptor: SourceAssetDescriptor, suffix: string): ProjectState {
  const next = cloneProjectState(state);
  next.sourceAssets.push(descriptor);
  const template = next.plates[0].objects[0].volumes[0];
  next.plates[0].objects[0].volumes.push({
    ...cloneJson(template),
    id: entityId<'volume'>(`import:test:three-surface-volume-${suffix}`),
    source: { assetId: descriptor.id, topologyRevision: 0, triangleCount: descriptor.mesh!.triangleCount },
  });
  return next;
}

function withDeclaredDigest(payload: AssetPayload, digest: string): AssetPayload {
  return {
    descriptor: { ...cloneJson(payload.descriptor), digest },
    bytes: payload.bytes.slice(),
  };
}

function malformedFiniteMesh(id: string): AssetPayload {
  const valid = encodeIndexedMeshAsset({
    id: entityId<'asset'>(id),
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  });
  const bytes = valid.bytes.slice();
  new DataView(bytes.buffer).setFloat32(0, Number.NaN, true);
  return {
    descriptor: { ...cloneJson(valid.descriptor), digest: contentDigest(bytes) },
    bytes,
  };
}

function assertVector(actual: THREE.Vector3, expected: readonly [number, number, number]): void {
  expected.forEach((value, index) => {
    assert.ok(Math.abs(actual.getComponent(index) - value) < 1e-9, `${actual.toArray()} != ${expected}`);
  });
}

console.log(`\nCanonical Three project surface: ${passed} tests passed.`);
