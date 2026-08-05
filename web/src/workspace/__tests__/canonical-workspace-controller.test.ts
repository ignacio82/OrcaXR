import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createProjectFixture } from '../../project/__tests__/fixtures';
import { cloneJson, cloneProjectState, projectFingerprint } from '../../project/domain/canonical';
import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import { emptyFacetAnnotations, identityTransform, type ProjectState } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { entityRowKey } from '../../project/objects';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import { getThreeProjectEntity } from '../../project/surfaces/ThreeProjectSurface';
import {
  CanonicalWorkspaceController,
  type CanonicalSemanticObjectEditorSnapshot,
  type CanonicalSlicingConfiguration,
  type CanonicalWorkspaceChange,
} from '../CanonicalWorkspaceController';

const NOW = '2026-07-20T12:00:00.000Z';
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
    const id = `import:controller-test:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    return id;
  }
}

function createController(scene = new THREE.Scene()): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: scene,
    mapping: MAPPING,
    projectName: 'Controller fixture',
    toolCount: 4,
    projectImportParser: new BbsProjectImportParser(),
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
}

async function openFixtureController(mutate?: (state: ProjectState) => void): Promise<{
  readonly controller: CanonicalWorkspaceController;
  readonly fixture: ReturnType<typeof createProjectFixture>;
  readonly importedState: ProjectState;
}> {
  const fixture = createProjectFixture();
  const importedState = cloneProjectState(fixture.state);
  mutate?.(importedState);
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state: importedState,
    assets: [fixture.asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(importedState),
  });
  const controller = createController();
  await controller.openCanonical3mf(archive.bytes);
  return { controller, fixture, importedState };
}

await test('creates one empty canonical owner and immediately projects it', () => {
  const scene = new THREE.Scene();
  const controller = createController(scene);
  const summary = controller.getSummary();

  assert.match(summary.projectId, /^import:controller-test:project-/);
  assert.match(summary.activePlateId, /^import:controller-test:plate-/);
  assert.equal(summary.projectName, 'Controller fixture');
  assert.equal(summary.plates.length, 1);
  assert.deepEqual(summary.plates[0], {
    id: summary.activePlateId,
    name: 'Plate 1',
    order: 0,
    active: true,
    printable: true,
    objectCount: 0,
    instanceCount: 0,
    modelVolumeCount: 0,
  });
  assert.equal(summary.dirty, false);
  assert.equal(summary.projectionHealth.healthy, true);
  assert.equal(summary.sceneProjection.state, 'ready');
  assert.strictEqual(controller.surface.root.parent, scene);

  controller.dispose();
  assert.equal(controller.surface.root.parent, null);
  assert.throws(() => controller.getSummary(), /disposed/);
});

await test('imports store-first meshes, reuses duplicate bytes, and coalesces exact transform history', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(10, 20, 30);
  const first = controller.importBufferGeometry(geometry, { name: 'First cube', sourceFilename: 'cube.stl' });
  const firstGroup = controller.surface.getInstanceGroup(first.instanceId);
  const firstMesh = controller.surface.getVolumeMesh(first.instanceId, first.volumeId);
  assert.ok(firstGroup);
  assert.ok(firstMesh);
  assert.equal(first.reusedAsset, false);
  assert.equal(getThreeProjectEntity(firstGroup)?.instanceId, first.instanceId);

  const second = controller.importBufferGeometry(geometry, { name: 'Second cube', sourceFilename: 'copy.stl' });
  const secondMesh = controller.surface.getVolumeMesh(second.instanceId, second.volumeId);
  assert.ok(secondMesh);
  assert.equal(second.reusedAsset, true);
  assert.equal(second.assetId, first.assetId);
  assert.strictEqual(secondMesh.geometry, firstMesh.geometry);
  assert.equal(controller.getSummary().assetCount, 1);
  assert.equal(controller.getSummary().objectCount, 2);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getInstance(second.instanceId), undefined);
  assert.equal(controller.getSummary().assetCount, 1);
  assert.equal(controller.getSummary().objectCount, 1);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getInstance(second.instanceId)?.instanceId, second.instanceId);
  assert.equal(controller.getSummary().assetCount, 1);
  assert.strictEqual(
    controller.surface.getVolumeMesh(second.instanceId, second.volumeId)?.geometry,
    firstMesh.geometry,
  );

  controller.selectInstance(first.instanceId);
  assert.deepEqual(controller.getSummary().selectedInstanceIds, [first.instanceId]);
  assert.equal(controller.getSummary().primaryInstanceId, first.instanceId);
  assert.equal(getThreeProjectEntity(firstGroup)?.primary, true);

  const historyBeforeDrag = controller.getSummary().history.undoCount;
  controller.setInstanceTransform(first.instanceId, { ...identityTransform(), translationMm: [10, 2, 3] }, 'drag-1');
  controller.setInstanceTransform(first.instanceId, { ...identityTransform(), translationMm: [42, 4, 6] }, 'drag-1');
  assert.equal(controller.getSummary().history.undoCount, historyBeforeDrag + 1);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [42, 4, 6]);
  assert.strictEqual(controller.surface.getInstanceGroup(first.instanceId), firstGroup);
  assert.deepEqual(firstGroup.position.toArray(), [42, 4, 6]);

  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform, identityTransform());
  assert.strictEqual(controller.surface.getInstanceGroup(first.instanceId), firstGroup);
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [42, 4, 6]);
  assert.strictEqual(controller.surface.getInstanceGroup(first.instanceId), firstGroup);

  geometry.dispose();
  controller.dispose();
});

await test('commits a stable multi-instance transform set atomically and coalesces one streamed gesture', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const first = controller.importBufferGeometry(geometry, { name: 'Batch first' });
  const second = controller.importBufferGeometry(geometry, {
    name: 'Batch second',
    transform: { ...identityTransform(), translationMm: [20, 0, 0] },
  });
  controller.setObjectsTreeSelection(
    [
      { kind: 'instance', id: first.instanceId },
      { kind: 'instance', id: second.instanceId },
    ],
    { kind: 'instance', id: first.instanceId },
  );
  const selectionBefore = controller.getObjectsTree().selection;
  const historyBefore = controller.getSummary().history.undoCount;

  controller.setInstanceTransforms(
    [
      {
        instanceId: first.instanceId,
        transform: { ...identityTransform(), translationMm: [5, 2, 0] },
      },
      {
        instanceId: second.instanceId,
        transform: { ...identityTransform(), translationMm: [25, 2, 0] },
      },
    ],
    'multi-drag-1',
  );
  controller.setInstanceTransforms(
    [
      {
        instanceId: second.instanceId,
        transform: { ...identityTransform(), translationMm: [30, 4, 1] },
      },
      {
        instanceId: first.instanceId,
        transform: { ...identityTransform(), translationMm: [10, 4, 1] },
      },
    ],
    'multi-drag-1',
  );

  assert.equal(controller.getSummary().history.undoCount, historyBefore + 1);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [10, 4, 1]);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [30, 4, 1]);
  assert.deepEqual(controller.surface.getInstanceGroup(first.instanceId)?.position.toArray(), [10, 4, 1]);
  assert.deepEqual(controller.surface.getInstanceGroup(second.instanceId)?.position.toArray(), [30, 4, 1]);
  assert.deepEqual(controller.getObjectsTree().selection, selectionBefore);

  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [0, 0, 0]);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [20, 0, 0]);
  assert.deepEqual(controller.getObjectsTree().selection, selectionBefore);
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [30, 4, 1]);

  geometry.dispose();
  controller.dispose();
});

await test('drops each stable instance independently to the bed in one reversible canonical command', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const first = controller.importBufferGeometry(geometry, {
    name: 'Above bed',
    transform: { ...identityTransform(), translationMm: [3, 4, 20] },
  });
  const second = controller.importBufferGeometry(geometry, {
    name: 'Below bed',
    transform: { ...identityTransform(), translationMm: [-2, 8, -12] },
  });
  const historyBefore = controller.getSummary().history.undoCount;

  const result = controller.dropInstancesToBed([first.instanceId, second.instanceId]);

  assert.deepEqual(result.instances, [
    { instanceId: first.instanceId, minZBeforeMm: 15, deltaZMm: -15 },
    { instanceId: second.instanceId, minZBeforeMm: -17, deltaZMm: 17 },
  ]);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [3, 4, 5]);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [-2, 8, 5]);
  assert.deepEqual(controller.surface.getInstanceGroup(first.instanceId)?.position.toArray(), [3, 4, 5]);
  assert.deepEqual(controller.surface.getInstanceGroup(second.instanceId)?.position.toArray(), [-2, 8, 5]);
  assert.equal(controller.getSummary().history.undoCount, historyBefore + 1);

  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getInstance(first.instanceId)?.transform.translationMm, [3, 4, 20]);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [-2, 8, -12]);
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.getInstance(second.instanceId)?.transform.translationMm, [-2, 8, 5]);
  assert.throws(() => controller.dropInstancesToBed([first.instanceId, first.instanceId]), /duplicate instance/i);

  geometry.dispose();
  controller.dispose();
});

await test('exports selected stable instances as a non-mutating canonical binary STL artifact', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(10, 20, 30);
  const imported = controller.importBufferGeometry(geometry, { name: 'Unsafe:/cube.stl' });
  const before = controller.getSummary();

  const exported = controller.exportCanonicalStl([imported.instanceId]);

  assert.equal(exported.mediaType, 'model/stl');
  assert.equal(exported.suggestedFilename, 'Unsafe--cube.stl');
  assert.equal(exported.triangleCount, 12);
  assert.equal(exported.instanceCount, 1);
  assert.equal(exported.bytes.byteLength, 84 + 12 * 50);
  assert.equal(new DataView(exported.bytes.buffer).getUint32(80, true), 12);
  assert.equal(exported.sourceRevision, before.revision);
  assert.equal(exported.sourceHash, before.projectHash);
  assert.deepEqual(controller.getSummary(), before);

  geometry.dispose();
  controller.dispose();
});

await test('exposes the canonical Objects hierarchy and routes object/volume selection and rename', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(10, 12, 14);
  const imported = controller.importBufferGeometry(geometry, { name: 'Tree cube' });
  const objectKey = entityRowKey({ kind: 'object', id: imported.objectId });
  const volumeKey = entityRowKey({ kind: 'volume', id: imported.volumeId });
  const instanceKey = entityRowKey({ kind: 'instance', id: imported.instanceId });
  const initial = controller.getObjectsTree();

  assert.equal(initial.sourceRevision, controller.getSummary().revision);
  assert.equal(initial.sourceHash, controller.getSummary().projectHash);
  assert.equal(initial.projection.rowsByKey.get(objectKey)?.label, 'Tree cube');
  assert.equal(initial.projection.rowsByKey.get(volumeKey)?.label, 'Tree cube');
  assert.ok(initial.projection.rowsByKey.has(instanceKey));
  assert.deepEqual(initial.selection, {
    refs: [{ kind: 'instance', id: imported.instanceId }],
    primary: { kind: 'instance', id: imported.instanceId },
  });
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.selection), true);
  assert.equal(Object.isFrozen(initial.selection.refs), true);

  controller.selectObject(imported.objectId);
  assert.deepEqual(controller.getObjectsTree().selection, {
    refs: [{ kind: 'object', id: imported.objectId }],
    primary: { kind: 'object', id: imported.objectId },
  });
  assert.equal(controller.getSummary().primaryInstanceId, undefined);
  assert.equal(getThreeProjectEntity(controller.surface.getInstanceGroup(imported.instanceId)!)?.primary, true);

  controller.selectVolume(imported.volumeId);
  assert.equal(
    getThreeProjectEntity(controller.surface.getVolumeMesh(imported.instanceId, imported.volumeId)!)?.primary,
    true,
  );
  controller.setObjectSelection(
    [
      { kind: 'object', id: imported.objectId },
      { kind: 'volume', id: imported.volumeId },
    ],
    { kind: 'volume', id: imported.volumeId },
  );
  assert.deepEqual(controller.getObjectsTree().selection, {
    refs: [
      { kind: 'object', id: imported.objectId },
      { kind: 'volume', id: imported.volumeId },
    ],
    primary: { kind: 'volume', id: imported.volumeId },
  });
  assert.equal(getThreeProjectEntity(controller.surface.getInstanceGroup(imported.instanceId)!)?.selected, true);
  assert.equal(
    getThreeProjectEntity(controller.surface.getVolumeMesh(imported.instanceId, imported.volumeId)!)?.primary,
    true,
  );

  const historyBeforeRename = controller.getSummary().history.undoCount;
  controller.renameObject(imported.objectId, ' Renamed assembly ');
  controller.renameVolume(imported.volumeId, 'Renamed part');
  const renamed = controller.getObjectsTree();
  assert.equal(renamed.projection.rowsByKey.get(objectKey)?.label, 'Renamed assembly');
  assert.equal(renamed.projection.rowsByKey.get(volumeKey)?.label, 'Renamed part');
  assert.equal(renamed.projection.rowsByKey.get(objectKey)?.id, initial.projection.rowsByKey.get(objectKey)?.id);
  assert.equal(renamed.projection.rowsByKey.get(volumeKey)?.id, initial.projection.rowsByKey.get(volumeKey)?.id);
  assert.equal(initial.projection.rowsByKey.get(objectKey)?.label, 'Tree cube');
  assert.equal(controller.getSummary().history.undoCount, historyBeforeRename + 2);

  const beforeNoop = controller.getSummary();
  controller.renameObject(imported.objectId, 'Renamed assembly');
  controller.renameVolume(imported.volumeId, ' Renamed part ');
  assert.deepEqual(controller.getSummary(), beforeNoop);
  assert.throws(() => controller.renameObject(imported.objectId, '   '), /cannot be empty/);
  assert.throws(() => controller.renameVolume(imported.volumeId, 'bad\nname'), /control characters/);
  assert.throws(
    () => controller.selectObject(entityId<'object'>('import:controller-test:missing-object')),
    /Unknown object/,
  );
  assert.deepEqual(controller.getSummary(), beforeNoop);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getObjectsTree().projection.rowsByKey.get(volumeKey)?.label, 'Tree cube');
  assert.equal(controller.undo(), true);
  assert.equal(controller.getObjectsTree().projection.rowsByKey.get(objectKey)?.label, 'Tree cube');
  assert.deepEqual(controller.getObjectsTree().selection.primary, {
    kind: 'volume',
    id: imported.volumeId,
  });

  geometry.dispose();
  controller.dispose();
});

await test('selects every Objects-tree entity type and rejects stale or unowned refs atomically', async () => {
  const fixture = createProjectFixture();
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(fixture.state),
  });
  const controller = createController();
  await controller.openCanonical3mf(archive.bytes);

  controller.selectPlate(fixture.ids.plate);
  assert.deepEqual(controller.getObjectsTree().selection.primary, {
    kind: 'plate',
    id: fixture.ids.plate,
  });
  controller.selectLayerRange(fixture.ids.range);
  assert.deepEqual(controller.getObjectsTree().selection.primary, {
    kind: 'layer-range',
    id: fixture.ids.range,
  });
  controller.setObjectsTreeSelection(
    [
      { kind: 'plate', id: fixture.ids.plate },
      { kind: 'object', id: fixture.ids.object },
      { kind: 'volume', id: fixture.ids.volume },
      { kind: 'instance', id: fixture.ids.instance },
      { kind: 'layer-range', id: fixture.ids.range },
    ],
    { kind: 'layer-range', id: fixture.ids.range },
  );
  const selected = controller.getObjectsTree().selection;
  assert.deepEqual(
    selected.refs.map((ref) => ref.kind),
    ['plate', 'object', 'volume', 'instance', 'layer-range'],
  );
  assert.equal(Object.isFrozen(selected.refs), true);
  assert.ok(selected.refs.every(Object.isFrozen));

  const beforeFailure = controller.getObjectsTree().selection;
  assert.throws(
    () => controller.selectLayerRange(entityId<'layer-range'>('import:controller-test:missing-range')),
    /Unknown layer-range/,
  );
  assert.throws(
    () =>
      controller.setObjectsTreeSelection([{ kind: 'object', id: fixture.ids.object }], {
        kind: 'volume',
        id: fixture.ids.volume,
      }),
    /Primary selection must be part of the selection set/,
  );
  assert.deepEqual(controller.getObjectsTree().selection, beforeFailure);

  controller.dispose();
});

await test('duplicates and deletes selected instances or objects through one exact history boundary', () => {
  const controller = createController();
  const geometry = new THREE.BoxGeometry(8, 10, 12);
  const source = controller.importBufferGeometry(geometry, {
    name: 'Lifecycle cube',
    transform: { ...identityTransform(), translationMm: [11, 22, 3] },
  });
  const importedHistory = controller.getSummary().history.undoCount;

  const instanceCopy = controller.duplicateSelectedInstance();
  assert.ok(instanceCopy);
  assert.equal(instanceCopy.sourceInstanceId, source.instanceId);
  assert.equal(instanceCopy.objectId, source.objectId);
  assert.notEqual(instanceCopy.instanceId, source.instanceId);
  assert.deepEqual(instanceCopy.transform, controller.getInstance(source.instanceId)?.transform);
  assert.equal(controller.getSummary().objectCount, 1);
  assert.equal(controller.getSummary().instanceCount, 2);
  assert.equal(controller.getSummary().history.undoCount, importedHistory + 1);
  assert.equal(controller.getSummary().primaryInstanceId, instanceCopy.instanceId);
  assert.equal(Object.isFrozen(instanceCopy), true);
  assert.equal(Object.isFrozen(instanceCopy.transform.translationMm), true);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getInstance(instanceCopy.instanceId), undefined);
  assert.equal(controller.getSummary().primaryInstanceId, source.instanceId);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getInstance(instanceCopy.instanceId)?.instanceId, instanceCopy.instanceId);
  assert.equal(controller.getSummary().primaryInstanceId, instanceCopy.instanceId);

  const deleteCopy = controller.deleteSelectedInstance();
  assert.deepEqual(deleteCopy, {
    scope: 'instance',
    instanceId: instanceCopy.instanceId,
    objectId: source.objectId,
  });
  assert.equal(controller.getSummary().objectCount, 1);
  assert.equal(controller.getSummary().instanceCount, 1);
  assert.equal(controller.getSummary().primaryInstanceId, source.instanceId);
  assert.equal(controller.undo(), true);
  assert.equal(controller.getInstance(instanceCopy.instanceId)?.instanceId, instanceCopy.instanceId);
  assert.equal(controller.getSummary().primaryInstanceId, instanceCopy.instanceId);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getInstance(instanceCopy.instanceId), undefined);
  assert.equal(controller.getSummary().primaryInstanceId, source.instanceId);

  const deleteLast = controller.deleteSelectedInstance();
  assert.deepEqual(deleteLast, {
    scope: 'object',
    instanceId: source.instanceId,
    objectId: source.objectId,
  });
  assert.equal(controller.getSummary().objectCount, 0);
  assert.equal(controller.getSummary().instanceCount, 0);
  assert.equal(controller.getSummary().primaryInstanceId, undefined);
  assert.equal(controller.undo(), true);
  assert.equal(controller.getInstance(source.instanceId)?.instanceId, source.instanceId);
  assert.equal(controller.getSummary().primaryInstanceId, source.instanceId);

  const objectCopy = controller.duplicateSelectedObject();
  assert.ok(objectCopy);
  assert.equal(objectCopy.sourceObjectId, source.objectId);
  assert.notEqual(objectCopy.objectId, source.objectId);
  assert.equal(objectCopy.name, 'Lifecycle cube copy');
  assert.equal(objectCopy.volumeIds.length, 1);
  assert.equal(objectCopy.instanceIds.length, 1);
  assert.equal(objectCopy.layerRangeIds.length, 0);
  assert.equal(objectCopy.primaryInstanceId, objectCopy.instanceIds[0]);
  assert.equal(controller.getSummary().objectCount, 2);
  assert.equal(controller.getSummary().instanceCount, 2);
  assert.equal(controller.getSummary().primaryInstanceId, objectCopy.primaryInstanceId);
  assert.equal(Object.isFrozen(objectCopy), true);
  assert.equal(Object.isFrozen(objectCopy.instanceIds), true);
  assert.equal(controller.undo(), true);
  assert.equal(controller.getInstance(objectCopy.instanceIds[0]), undefined);
  assert.equal(controller.getSummary().primaryInstanceId, source.instanceId);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getInstance(objectCopy.instanceIds[0])?.objectId, objectCopy.objectId);
  assert.equal(controller.getSummary().primaryInstanceId, objectCopy.primaryInstanceId);

  const historyBeforeClear = controller.getSummary().history.undoCount;
  controller.clearSelection();
  assert.deepEqual(controller.getSummary().selectedInstanceIds, []);
  assert.equal(controller.getSummary().primaryInstanceId, undefined);
  assert.equal(controller.getSummary().history.undoCount, historyBeforeClear);
  assert.equal(controller.deleteSelectedInstance(), undefined);
  assert.equal(controller.duplicateSelectedInstance(), undefined);
  assert.equal(controller.duplicateSelectedObject(), undefined);
  assert.equal(controller.getSummary().history.undoCount, historyBeforeClear);

  geometry.dispose();
  controller.dispose();
});

await test('replaces resolved slicing configuration atomically with clones, validation, no-ops, and undo', () => {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    toolCount: 2,
    initialProjectConfig: {
      printable_area: ['0x0', '270x0', '270x270', '0x270'],
      imported_tuning: 'preserve-until-explicit-profile-apply',
    },
    projectImportParser: new BbsProjectImportParser(),
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
  const imported = controller.getSlicingConfiguration();
  assert.deepEqual(imported.config, {
    printable_area: ['0x0', '270x0', '270x270', '0x270'],
    imported_tuning: 'preserve-until-explicit-profile-apply',
  });
  assert.equal(Object.isFrozen(imported), true);
  assert.equal(Object.isFrozen(imported.config), true);
  assert.equal(Object.isFrozen(imported.filaments.physical), true);

  const beforeNoop = controller.getSummary();
  controller.setSlicingConfiguration(imported);
  assert.deepEqual(controller.getSummary(), beforeNoop);

  const physicalA = entityId<'physical-filament'>('import:controller-test:profile-head-a');
  const physicalB = entityId<'physical-filament'>('import:controller-test:profile-head-b');
  const mixedId = entityId<'mixed-filament'>('import:controller-test:profile-mixed-ab');
  const profileConfig = { layer_height: 0.16, sparse_infill_density: 18 };
  const physical = [
    {
      id: physicalA,
      name: 'Head A PLA',
      toolId: 0,
      presetId: 'pla-a',
      presetHash: 'sha256:pla-a',
      material: 'PLA',
      color: '#ff0000',
      config: { nozzle_temperature: 215 },
      enabled: true,
    },
    {
      id: physicalB,
      name: 'Head B PETG',
      toolId: 1,
      presetId: 'petg-b',
      presetHash: 'sha256:petg-b',
      material: 'PETG',
      color: '#0000ff',
      config: { nozzle_temperature: 245 },
      enabled: true,
    },
  ] satisfies CanonicalSlicingConfiguration['filaments']['physical'];
  const configuration: CanonicalSlicingConfiguration = {
    printer: { profileId: 'snapmaker-u1', profileHash: 'sha256:u1-profile', toolCount: 2 },
    config: profileConfig,
    filaments: {
      physical,
      mixed: [
        {
          id: mixedId,
          name: 'A/B cycle',
          displayColor: '#800080',
          components: [
            { filamentId: physicalA, weight: 1 },
            { filamentId: physicalB, weight: 1 },
          ],
          distribution: { mode: 'cycle', cycleLengthMm: 0.4 },
          config: {},
          enabled: true,
        },
      ],
    },
  };
  controller.setSlicingConfiguration(configuration);
  const appliedSummary = controller.getSummary();
  assert.equal(appliedSummary.history.undoCount, beforeNoop.history.undoCount + 1);
  assert.equal(appliedSummary.history.undoLabel, 'Update slicing configuration');
  const applied = controller.getSlicingConfiguration();
  assert.deepEqual(applied.printer, configuration.printer);
  assert.deepEqual(applied.config, configuration.config);
  assert.deepEqual(applied.filaments.physical, configuration.filaments.physical);
  assert.equal(applied.filaments.mixed.length, 2);
  assert.equal(applied.filaments.mixed[0].fullSpectrum?.custom, false);
  assert.equal(applied.filaments.mixed[0].fullSpectrum?.originAuto, true);
  assert.deepEqual(applied.filaments.mixed[1], configuration.filaments.mixed[0]);
  assert.equal(Object.hasOwn(applied.config, 'printable_area'), false, 'render mapping must not infer bed config');
  assert.equal(Object.isFrozen(applied.filaments.mixed[0].components), true);

  profileConfig.layer_height = 0.4;
  physical[0].name = 'Caller mutation';
  assert.equal(controller.getSlicingConfiguration().config.layer_height, 0.16);
  assert.equal(controller.getSlicingConfiguration().filaments.physical[0].name, 'Head A PLA');

  const beforeInvalid = controller.getSummary();
  assert.throws(
    () =>
      controller.setSlicingConfiguration({
        ...applied,
        printer: { ...applied.printer, toolCount: 1 },
      }),
    /Invalid project state/,
  );
  assert.deepEqual(controller.getSummary(), beforeInvalid);

  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getSlicingConfiguration(), imported);
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.getSlicingConfiguration(), applied);
  const historyBeforeRepeatedApply = controller.getSummary().history.undoCount;
  controller.setSlicingConfiguration(applied);
  assert.equal(controller.getSummary().history.undoCount, historyBeforeRepeatedApply);

  controller.dispose();
});

await test('routes plate operations through exact history and leaves failed imports untouched', () => {
  const controller = createController();
  const initial = controller.getSummary();
  const secondPlate = controller.addPlate(undefined, { activate: false });
  assert.equal(controller.getSummary().activePlateId, initial.activePlateId);
  assert.deepEqual(
    controller.getSummary().plates.map((plate) => [plate.id, plate.order]),
    [
      [initial.activePlateId, 0],
      [secondPlate, 1],
    ],
  );

  controller.activatePlate(secondPlate);
  const model = controller.importBufferGeometry(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(5, 0, 0),
      new THREE.Vector3(0, 5, 0),
    ]),
    { name: 'Plate two triangle' },
  );
  assert.equal(model.plateId, secondPlate);
  const beforeDelete = controller.getSummary();
  controller.deletePlate(secondPlate);
  assert.equal(controller.getSummary().plates.length, 1);
  assert.equal(controller.getSummary().activePlateId, initial.activePlateId);
  assert.equal(controller.undo(), true);
  const restored = controller.getSummary();
  assert.equal(restored.activePlateId, beforeDelete.activePlateId);
  assert.deepEqual(restored.plates, beforeDelete.plates);
  assert.equal(controller.getInstance(model.instanceId)?.plateId, secondPlate);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getSummary().plates.length, 1);

  const beforeFailure = controller.getSummary();
  const malformed = new THREE.BufferGeometry();
  malformed.setAttribute('position', new THREE.Float32BufferAttribute([Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  assert.throws(() => controller.importBufferGeometry(malformed), /finite/);
  assert.deepEqual(controller.getSummary(), beforeFailure);
  assert.throws(() => controller.deletePlate(initial.activePlateId), /last plate/);
  assert.deepEqual(controller.getSummary(), beforeFailure);
  controller.dispose();
});

await test('round-trips canonical 3MF with stable IDs and rejects a failed open transactionally', async () => {
  const source = createController();
  const geometry = new THREE.TetrahedronGeometry(12);
  const imported = source.importBufferGeometry(geometry, {
    name: 'Saved tetrahedron',
    transform: { ...identityTransform(), translationMm: [50, 60, 7] },
  });
  const sourceProjectId = source.getSummary().projectId;
  const saved = await source.saveCanonical3mf();
  assert.equal(saved.mediaType, 'model/3mf');
  assert.equal(source.getSummary().dirty, false);

  const reopened = createController();
  const warnings = await reopened.openCanonical3mf(saved.bytes);
  assert.ok(Array.isArray(warnings));
  const summary = reopened.getSummary();
  assert.equal(summary.projectId, sourceProjectId);
  assert.equal(summary.history.undoCount, 0);
  assert.equal(summary.history.redoCount, 0);
  assert.equal(summary.dirty, false);
  assert.equal(summary.projectionHealth.healthy, true);
  assert.deepEqual(reopened.getInstance(imported.instanceId)?.transform.translationMm, [50, 60, 7]);
  assert.ok(reopened.surface.getInstanceGroup(imported.instanceId));

  const beforeFailedOpen = reopened.getSummary();
  await assert.rejects(reopened.openCanonical3mf(new Uint8Array([1, 2, 3, 4])));
  assert.deepEqual(reopened.getSummary(), beforeFailedOpen);

  const savedAgain = await reopened.saveCanonical3mf();
  assert.deepEqual(savedAgain.bytes, saved.bytes);
  geometry.dispose();
  source.dispose();
  reopened.dispose();
});

await test('previews worker-compatible project replacement and commits it as one undoable command', async () => {
  const source = createController();
  source.importBufferGeometry(new THREE.TetrahedronGeometry(6), { name: 'Previewed model' });
  const archive = await source.saveCanonical3mf();

  const target = createController();
  const before = target.getSummary();
  const prepared = await target.prepareCanonical3mfImport(archive.bytes, {
    filename: 'previewed-project.3mf',
    uri: 'file:///previewed-project.3mf',
  });
  assert.deepEqual(target.getSummary(), before, 'preparation must not mutate canonical state');
  assert.equal(prepared.preview.mode, 'replace');
  assert.equal(prepared.preview.counts.objects, 1);
  assert.equal(prepared.preview.blocked, false);

  prepared.confirm({
    confirmed: true,
    acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
  });
  assert.equal(target.getSummary().objectCount, 1);
  assert.equal(target.getSummary().history.undoCount, 1);
  assert.equal(target.getSummary().history.undoLabel, 'Import previewed-project.3mf');
  assert.equal(target.undo(), true);
  assert.equal(target.getSummary().projectId, before.projectId);
  assert.equal(target.getSummary().objectCount, 0);

  source.dispose();
  target.dispose();
});

await test('round-trips a populated second plate only with authoritative project printable area', async () => {
  const missingArea = createController();
  const missingAreaPlate = missingArea.addPlate();
  const missingAreaGeometry = new THREE.TetrahedronGeometry(4);
  missingArea.importBufferGeometry(missingAreaGeometry, { plateId: missingAreaPlate });
  await assert.rejects(missingArea.saveCanonical3mf(), /printable_area/i);
  missingAreaGeometry.dispose();
  missingArea.dispose();

  const source = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    initialProjectConfig: {
      printable_area: ['0x0', '270x0', '270x270', '0x270'],
    },
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
  const firstPlate = source.getSummary().activePlateId;
  const secondPlate = source.addPlate();
  const geometry = new THREE.TetrahedronGeometry(8);
  const imported = source.importBufferGeometry(geometry, {
    plateId: secondPlate,
    name: 'Second plate tetrahedron',
    transform: { ...identityTransform(), translationMm: [25, 35, 4] },
  });
  const configHistory = source.getSummary().history.undoCount;
  source.setProjectConfig({
    printable_area: ['0x0', '270x0', '270x270', '0x270'],
    layer_height: 0.2,
  });
  assert.equal(source.getSummary().history.undoCount, configHistory + 1);
  assert.equal(source.undo(), true);
  assert.equal(source.redo(), true);

  const saved = await source.saveCanonical3mf();
  const reopened = createController();
  await reopened.openCanonical3mf(saved.bytes);
  assert.deepEqual(
    reopened.getSummary().plates.map((plate) => [plate.id, plate.order, plate.objectCount]),
    [
      [firstPlate, 0, 0],
      [secondPlate, 1, 1],
    ],
  );
  assert.equal(reopened.getSummary().activePlateId, secondPlate);
  assert.deepEqual(reopened.getInstance(imported.instanceId)?.transform.translationMm, [25, 35, 4]);
  assert.deepEqual((await reopened.saveCanonical3mf()).bytes, saved.bytes);

  geometry.dispose();
  source.dispose();
  reopened.dispose();
});

await test('publishes one immutable summary per command boundary and releases observers on disposal', async () => {
  const controller = createController();
  const sliceSource = controller.createCanonicalSliceSource();
  const initialSliceSnapshot = sliceSource.capture();
  assert.equal(sliceSource.isCurrent(initialSliceSnapshot), true);
  const changes: CanonicalWorkspaceChange[] = [];
  const unsubscribe = controller.subscribe((change) => changes.push(change));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].sources, ['initial']);
  assert.equal(Object.isFrozen(changes[0].current), true);

  const imported = controller.importBufferGeometry(new THREE.BoxGeometry(4, 4, 4));
  await Promise.resolve();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].sources, ['project', 'selection', 'history']);
  assert.equal(changes[1].previous?.objectCount, 0);
  assert.equal(changes[1].current.objectCount, 1);
  assert.deepEqual(changes[1].current.selectedInstanceIds, [imported.instanceId]);
  assert.equal(Object.isFrozen(changes[1].current.plates), true);

  controller.selectInstance(imported.instanceId);
  await Promise.resolve();
  assert.equal(changes.length, 2, 'an already-selected instance is a notification no-op');
  controller.setInstanceTransform(
    imported.instanceId,
    { ...identityTransform(), translationMm: [1, 2, 3] },
    'subscription-test',
  );
  await Promise.resolve();
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[2].sources, ['project', 'history']);

  controller.surface.dispose();
  controller.addPlate(undefined, { activate: false });
  await Promise.resolve();
  assert.equal(changes.length, 4);
  assert.deepEqual(changes[3].sources, ['projection-health', 'project', 'history']);
  assert.equal(changes[3].current.projectionHealth.healthy, false);
  assert.equal(sliceSource.isCurrent(initialSliceSnapshot), false);
  assert.throws(() => sliceSource.capture(), /Cannot slice/);

  unsubscribe();
  controller.undo();
  await Promise.resolve();
  assert.equal(changes.length, 4);
  controller.dispose();
  assert.equal(sliceSource.isCurrent(initialSliceSnapshot), false);
  await Promise.resolve();
  assert.equal(changes.length, 4);
});

await test('derives a deeply immutable semantic editor snapshot from the primary Objects selection', async () => {
  const { controller, fixture } = await openFixtureController();
  controller.selectPlate(fixture.ids.plate);
  assert.equal(controller.getSemanticObjectEditorSnapshot(), undefined);

  controller.selectInstance(fixture.ids.instance);
  const objectSnapshot = controller.getSemanticObjectEditorSnapshot()!;
  assert.equal(objectSnapshot.objectId, fixture.ids.object);
  assert.equal(objectSnapshot.objectName, fixture.object.name);
  assert.equal('selectedVolume' in objectSnapshot, false);
  assert.equal('selectedLayerRange' in objectSnapshot, false);

  controller.selectVolume(fixture.ids.volume);
  const volumeSnapshot = controller.getSemanticObjectEditorSnapshot()!;
  assert.equal(volumeSnapshot.sourceRevision, controller.getSummary().revision);
  assert.equal(volumeSnapshot.sourceHash, controller.getSummary().projectHash);
  assert.deepEqual(
    volumeSnapshot.selectedVolume?.roleDecisions.map((entry) => entry.role),
    ['model', 'negative-volume', 'parameter-modifier', 'support-blocker', 'support-enforcer'],
  );
  assert.deepEqual(volumeSnapshot.selectedVolume?.roleDecisions[0].decision, { allowed: true, noop: true });
  assert.deepEqual(volumeSnapshot.selectedVolume?.roleDecisions[1].decision, {
    allowed: false,
    code: 'last-model-volume',
    reason: 'The last model part on an object cannot be converted to a non-model role',
  });
  assert.deepEqual(volumeSnapshot.layerRanges, [{ id: fixture.ids.range, minZMm: 0, maxZMm: 5 }]);
  assert.equal(Object.isFrozen(volumeSnapshot), true);
  assert.equal(Object.isFrozen(volumeSnapshot.selectedVolume), true);
  assert.equal(Object.isFrozen(volumeSnapshot.selectedVolume?.roleDecisions), true);
  assert.ok(volumeSnapshot.selectedVolume?.roleDecisions.every(Object.isFrozen));
  assert.ok(volumeSnapshot.selectedVolume?.roleDecisions.every((entry) => Object.isFrozen(entry.decision)));
  assert.equal(Object.isFrozen(volumeSnapshot.layerRanges), true);
  assert.ok(volumeSnapshot.layerRanges.every(Object.isFrozen));

  controller.selectLayerRange(fixture.ids.range);
  const rangeSnapshot = controller.getSemanticObjectEditorSnapshot()!;
  assert.equal(rangeSnapshot.selectedVolume, undefined);
  assert.deepEqual(rangeSnapshot.selectedLayerRange, {
    id: fixture.ids.range,
    mergePrevious: { allowed: false, reason: 'There is no previous height range.' },
    mergeNext: { allowed: false, reason: 'There is no next height range.' },
  });
  assert.equal(Object.isFrozen(rangeSnapshot.selectedLayerRange), true);
  assert.equal(Object.isFrozen(rangeSnapshot.selectedLayerRange?.mergePrevious), true);
  assert.equal(Object.isFrozen(rangeSnapshot.selectedLayerRange?.mergeNext), true);
  assert.equal(volumeSnapshot.selectedVolume?.id, fixture.ids.volume, 'older snapshots must remain caller-owned');
  assert.equal(volumeSnapshot.selectedLayerRange, undefined);

  controller.dispose();
});

await test('projects role decisions and applies guarded conversion with exact undo and redo', async () => {
  const secondModelId = entityId<'volume'>('import:controller-semantic:second-model');
  const { controller, fixture } = await openFixtureController((state) => {
    const object = state.plates[0].objects[0];
    object.volumes[0].annotations = emptyFacetAnnotations(0);
    const secondModel = cloneJson(object.volumes[0]);
    secondModel.id = secondModelId;
    secondModel.name = 'Required model sibling';
    object.volumes.push(secondModel);
  });
  controller.selectVolume(fixture.ids.volume);
  const before = controller.getSemanticObjectEditorSnapshot()!;
  const beforeHash = controller.getSummary().projectHash;
  const beforeSelection = controller.getObjectsTree().selection;
  const blockerDecision = before.selectedVolume?.roleDecisions.find((entry) => entry.role === 'support-blocker');
  assert.deepEqual(blockerDecision?.decision, { allowed: true, noop: false });

  controller.convertSemanticVolumeRole({
    ...semanticGuard(before),
    volumeId: fixture.ids.volume,
    nextRole: 'support-blocker',
  });
  const converted = controller.getSemanticObjectEditorSnapshot()!;
  assert.equal(converted.selectedVolume?.role, 'support-blocker');
  assert.equal(before.selectedVolume?.role, 'model', 'the pre-command snapshot must not be mutated');
  assert.equal(controller.getSummary().history.undoCount, 1);
  assert.deepEqual(controller.getObjectsTree().selection, beforeSelection);
  const convertedHash = controller.getSummary().projectHash;
  assert.notEqual(convertedHash, beforeHash);

  const historyBeforeNoop = controller.getSummary().history;
  controller.convertSemanticVolumeRole({
    ...semanticGuard(converted),
    volumeId: fixture.ids.volume,
    nextRole: 'support-blocker',
  });
  assert.deepEqual(controller.getSummary().history, historyBeforeNoop);
  assert.equal(controller.getSummary().projectHash, convertedHash);

  assert.equal(controller.undo(), true);
  assert.equal(controller.getSummary().projectHash, beforeHash);
  assert.equal(controller.getSemanticObjectEditorSnapshot()?.selectedVolume?.role, 'model');
  assert.deepEqual(controller.getObjectsTree().selection, beforeSelection);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getSummary().projectHash, convertedHash);
  assert.equal(controller.getSemanticObjectEditorSnapshot()?.selectedVolume?.role, 'support-blocker');

  controller.dispose();

  const blocked = await openFixtureController();
  blocked.controller.selectVolume(blocked.fixture.ids.volume);
  const blockedSnapshot = blocked.controller.getSemanticObjectEditorSnapshot()!;
  const blockedBefore = semanticFootprint(blocked.controller);
  assert.throws(
    () =>
      blocked.controller.convertSemanticVolumeRole({
        ...semanticGuard(blockedSnapshot),
        volumeId: blocked.fixture.ids.volume,
        nextRole: 'negative-volume',
      }),
    /last model part/,
  );
  assert.deepEqual(semanticFootprint(blocked.controller), blockedBefore);
  blocked.controller.dispose();
});

await test('runs the guarded add/edit/split/merge/delete height-range lifecycle with exact history', async () => {
  const { controller, fixture } = await openFixtureController();
  controller.selectLayerRange(fixture.ids.range);
  const initial = controller.getSemanticObjectEditorSnapshot()!;
  const initialSelection = controller.getObjectsTree().selection;
  const hashes = [controller.getSummary().projectHash];
  const gapRangeId = controller.createLayerRangeId();

  controller.editSemanticLayerRange({
    ...semanticGuard(initial),
    operation: 'add',
    layerRangeId: gapRangeId,
    minZMm: 7,
    maxZMm: 10,
  });
  const added = controller.getSemanticObjectEditorSnapshot()!;
  hashes.push(controller.getSummary().projectHash);
  assert.deepEqual(added.layerRanges, [
    { id: fixture.ids.range, minZMm: 0, maxZMm: 5 },
    { id: gapRangeId, minZMm: 7, maxZMm: 10 },
  ]);
  assert.equal(added.selectedLayerRange?.id, gapRangeId);
  assert.match(
    added.selectedLayerRange?.mergePrevious.allowed === false ? added.selectedLayerRange.mergePrevious.reason : '',
    /touch without a gap/,
  );

  controller.editSemanticLayerRange({
    ...semanticGuard(added),
    operation: 'edit',
    layerRangeId: gapRangeId,
    minZMm: 5,
    maxZMm: 10,
  });
  const edited = controller.getSemanticObjectEditorSnapshot()!;
  hashes.push(controller.getSummary().projectHash);
  assert.deepEqual(edited.layerRanges, [
    { id: fixture.ids.range, minZMm: 0, maxZMm: 5 },
    { id: gapRangeId, minZMm: 5, maxZMm: 10 },
  ]);
  assert.match(
    edited.selectedLayerRange?.mergePrevious.allowed === false ? edited.selectedLayerRange.mergePrevious.reason : '',
    /different settings/,
  );

  const upperRangeId = controller.createLayerRangeId();
  controller.editSemanticLayerRange({
    ...semanticGuard(edited),
    operation: 'split',
    layerRangeId: gapRangeId,
    splitZMm: 7.5,
    upperRangeId,
  });
  const split = controller.getSemanticObjectEditorSnapshot()!;
  hashes.push(controller.getSummary().projectHash);
  assert.deepEqual(split.layerRanges, [
    { id: fixture.ids.range, minZMm: 0, maxZMm: 5 },
    { id: gapRangeId, minZMm: 5, maxZMm: 7.5 },
    { id: upperRangeId, minZMm: 7.5, maxZMm: 10 },
  ]);
  assert.deepEqual(split.selectedLayerRange?.mergePrevious, {
    allowed: true,
    otherRangeId: gapRangeId,
  });

  controller.editSemanticLayerRange({
    ...semanticGuard(split),
    operation: 'merge',
    firstRangeId: gapRangeId,
    secondRangeId: upperRangeId,
  });
  const merged = controller.getSemanticObjectEditorSnapshot()!;
  hashes.push(controller.getSummary().projectHash);
  assert.deepEqual(merged.layerRanges, [
    { id: fixture.ids.range, minZMm: 0, maxZMm: 5 },
    { id: gapRangeId, minZMm: 5, maxZMm: 10 },
  ]);
  assert.equal(merged.selectedLayerRange?.id, gapRangeId);

  controller.editSemanticLayerRange({
    ...semanticGuard(merged),
    operation: 'delete',
    layerRangeId: gapRangeId,
  });
  const deleted = controller.getSemanticObjectEditorSnapshot()!;
  hashes.push(controller.getSummary().projectHash);
  assert.deepEqual(deleted.layerRanges, [{ id: fixture.ids.range, minZMm: 0, maxZMm: 5 }]);
  assert.equal(deleted.selectedLayerRange?.id, fixture.ids.range);
  assert.equal(controller.getSummary().history.undoCount, 5);
  assert.equal(hashes[5], hashes[0], 'the complete lifecycle must restore the initial project bytes');

  for (let index = 4; index >= 0; index -= 1) {
    assert.equal(controller.undo(), true);
    assert.equal(controller.getSummary().projectHash, hashes[index]);
  }
  assert.deepEqual(controller.getObjectsTree().selection, initialSelection);
  assert.deepEqual(controller.getSemanticObjectEditorSnapshot()?.layerRanges, initial.layerRanges);
  for (let index = 1; index < hashes.length; index += 1) {
    assert.equal(controller.redo(), true);
    assert.equal(controller.getSummary().projectHash, hashes[index]);
  }
  assert.equal(controller.getSemanticObjectEditorSnapshot()?.selectedLayerRange?.id, fixture.ids.range);
  assert.equal(initial.layerRanges.length, 1, 'the original immutable snapshot must remain unchanged');

  controller.dispose();
});

await test('rejects stale guards, hash drift, collisions, and cross-object ownership atomically', async () => {
  const secondIds = {
    object: entityId<'object'>('import:controller-semantic:object-b'),
    volume: entityId<'volume'>('import:controller-semantic:volume-b'),
    instance: entityId<'instance'>('import:controller-semantic:instance-b'),
    range: entityId<'layer-range'>('import:controller-semantic:range-b'),
  };
  const { controller, fixture } = await openFixtureController((state) => {
    const second = cloneJson(state.plates[0].objects[0]);
    second.id = secondIds.object;
    second.name = 'Second semantic object';
    second.volumes[0].id = secondIds.volume;
    second.instances[0].id = secondIds.instance;
    second.layerRanges[0].id = secondIds.range;
    state.plates[0].objects.push(second);
  });

  controller.selectVolume(fixture.ids.volume);
  const volumeSnapshot = controller.getSemanticObjectEditorSnapshot()!;
  let beforeFailure = semanticFootprint(controller);
  assert.throws(
    () =>
      controller.convertSemanticVolumeRole({
        ...semanticGuard(volumeSnapshot),
        volumeId: secondIds.volume,
        nextRole: 'model',
      }),
    /is not owned by object/,
  );
  assert.deepEqual(semanticFootprint(controller), beforeFailure);

  controller.selectLayerRange(fixture.ids.range);
  const rangeSnapshot = controller.getSemanticObjectEditorSnapshot()!;
  beforeFailure = semanticFootprint(controller);
  assert.throws(
    () =>
      controller.editSemanticLayerRange({
        ...semanticGuard(rangeSnapshot),
        operation: 'edit',
        layerRangeId: secondIds.range,
        minZMm: 0,
        maxZMm: 4,
      }),
    /is not owned by object/,
  );
  assert.deepEqual(semanticFootprint(controller), beforeFailure);

  assert.throws(
    () =>
      controller.editSemanticLayerRange({
        ...semanticGuard(rangeSnapshot),
        operation: 'add',
        layerRangeId: secondIds.range,
        minZMm: 7,
        maxZMm: 9,
      }),
    /already exists in the project/,
  );
  assert.deepEqual(semanticFootprint(controller), beforeFailure);

  controller.renameObject(fixture.ids.object, 'Renamed before stale edit');
  const afterRename = semanticFootprint(controller);
  assert.throws(
    () =>
      controller.editSemanticLayerRange({
        ...semanticGuard(rangeSnapshot),
        operation: 'edit',
        layerRangeId: fixture.ids.range,
        minZMm: 0,
        maxZMm: 4,
      }),
    /stale canonical project revision/,
  );
  assert.deepEqual(semanticFootprint(controller), afterRename);

  const current = controller.getSemanticObjectEditorSnapshot()!;
  assert.throws(
    () =>
      controller.editSemanticLayerRange({
        ...semanticGuard(current),
        expectedRevision: current.sourceRevision - 1,
        operation: 'delete',
        layerRangeId: fixture.ids.range,
      }),
    /stale canonical project revision/,
  );
  assert.deepEqual(semanticFootprint(controller), afterRename);
  assert.throws(
    () =>
      controller.editSemanticLayerRange({
        ...semanticGuard(current),
        sourceHash: `${current.sourceHash}:drift`,
        operation: 'delete',
        layerRangeId: fixture.ids.range,
      }),
    /stale canonical project revision/,
  );
  assert.deepEqual(semanticFootprint(controller), afterRename);
  assert.equal(controller.getSummary().history.undoCount, 1, 'rejected requests must not add history');

  assert.equal(controller.undo(), true);
  assert.equal(controller.getSemanticObjectEditorSnapshot()?.objectName, fixture.object.name);
  assert.equal(controller.redo(), true);
  assert.equal(controller.getSemanticObjectEditorSnapshot()?.objectName, 'Renamed before stale edit');
  controller.dispose();
});

function semanticGuard(snapshot: CanonicalSemanticObjectEditorSnapshot) {
  return {
    expectedRevision: snapshot.sourceRevision,
    sourceHash: snapshot.sourceHash,
    objectId: snapshot.objectId,
  };
}

function semanticFootprint(controller: CanonicalWorkspaceController) {
  const summary = controller.getSummary();
  const editor = controller.getSemanticObjectEditorSnapshot();
  return {
    projectHash: summary.projectHash,
    history: summary.history,
    selection: controller.getObjectsTree().selection,
    editor: editor
      ? {
          objectId: editor.objectId,
          objectName: editor.objectName,
          selectedVolume: editor.selectedVolume,
          layerRanges: editor.layerRanges,
          selectedLayerRange: editor.selectedLayerRange,
        }
      : undefined,
  };
}

console.log(`\n${passed} canonical workspace controller tests passed.`);
