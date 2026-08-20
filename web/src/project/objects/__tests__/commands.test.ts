import assert from 'node:assert/strict';
import {
  CommandBus,
  ConvertInstanceToIndependentObjectCommand,
  CreateInstanceCommand,
  DeleteInstanceCommand,
  DeleteObjectCommand,
  DuplicateObjectCommand,
  InMemoryAssetRepository,
  MoveObjectToPlateCommand,
  ProjectStore,
  RenameInstanceCommand,
  RenameObjectCommand,
  RenameVolumeCommand,
  SelectionStore,
  SetInstancePrintableCommand,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  createInstancesAtTransforms,
  entityId,
  identityTransform,
  seededRandom,
  type IndependentObjectIds,
  type IndependentSingleInstanceObjectIds,
  type InstanceId,
  type ProjectPlate,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(withSecondPlate = false) {
  const fixture = createProjectFixture();
  const initial = cloneProjectState(fixture.state);
  let secondPlate: ProjectPlate | undefined;
  if (withSecondPlate) {
    const ids = new UuidIdSource(seededRandom(0x2200));
    secondPlate = {
      id: ids.next('plate'),
      name: 'Plate 2',
      order: 1,
      printable: true,
      config: {},
      objects: [],
    };
    initial.plates.push(secondPlate);
  }
  const project = new ProjectStore(initial);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, initial, secondPlate, project, selection, assets, bus };
}

function duplicateIds(seed = 0x2201): IndependentObjectIds {
  const ids = new UuidIdSource(seededRandom(seed));
  return {
    objectId: ids.next('object'),
    volumeIds: [ids.next('volume')],
    instanceIds: [ids.next('instance')],
    layerRangeIds: [ids.next('layer-range')],
  };
}

function projectBytes(project: ProjectStore): string {
  return canonicalStringify(project.getSnapshot().state);
}

test('renames objects/volumes/instances and toggles printable state with exact undo and real no-ops', () => {
  const { fixture, project, selection, bus } = harness();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const original = projectBytes(project);
  const selectionBefore = selection.getSnapshot();

  bus.execute(new RenameObjectCommand(fixture.ids.object, fixture.object.name));
  bus.execute(new RenameVolumeCommand(fixture.ids.volume, fixture.object.volumes[0].name));
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(project.getSnapshot().revision, 0);

  bus.execute(new RenameObjectCommand(fixture.ids.object, 'Renamed object'));
  bus.execute(new RenameVolumeCommand(fixture.ids.volume, ' Renamed part '));
  bus.execute(new RenameInstanceCommand(fixture.ids.instance, 'Copy A'));
  bus.execute(new SetInstancePrintableCommand(fixture.ids.instance, false));
  const object = project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.name, 'Renamed object');
  assert.equal(object.volumes[0].name, 'Renamed part');
  assert.equal(object.instances[0].name, 'Copy A');
  assert.equal(object.instances[0].printable, false);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);

  assert.equal(bus.undo(), true);
  assert.equal(bus.undo(), true);
  assert.equal(bus.undo(), true);
  assert.equal(bus.undo(), true);
  assert.equal(projectBytes(project), original);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
});

test('duplicates an independent object graph without copying or deleting immutable assets', () => {
  const { fixture, project, assets, selection, bus } = harness();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const before = projectBytes(project);
  const assetsBefore = assets.capture();
  const selectionBefore = selection.getSnapshot();
  const ids = duplicateIds();

  bus.execute(new DuplicateObjectCommand(fixture.ids.object, ids, { name: 'Independent copy' }));
  const objects = project.getSnapshot().state.plates[0].objects;
  assert.equal(objects.length, 2);
  assert.equal(objects[1].name, 'Independent copy');
  assert.equal(objects[1].id, ids.objectId);
  assert.equal(objects[1].volumes[0].id, ids.volumeIds[0]);
  assert.equal(objects[1].instances[0].id, ids.instanceIds[0]);
  assert.equal(objects[1].layerRanges[0].id, ids.layerRangeIds[0]);
  assert.equal(objects[1].volumes[0].source.assetId, objects[0].volumes[0].source.assetId);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.deepEqual(selection.getSnapshot(), {
    refs: [{ kind: 'instance', id: ids.instanceIds[0] }],
    primary: { kind: 'instance', id: ids.instanceIds[0] },
  });
  const duplicated = projectBytes(project);

  bus.undo();
  assert.equal(projectBytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  bus.redo();
  assert.equal(projectBytes(project), duplicated);
  assert.deepEqual(assets.capture(), assetsBefore);

  bus.undo();
  const collision = duplicateIds(0x2202);
  collision.objectId = fixture.ids.asset as unknown as typeof collision.objectId;
  assert.throws(
    () => bus.execute(new DuplicateObjectCommand(fixture.ids.object, collision)),
    /already exists in the project/,
  );
  assert.equal(projectBytes(project), before);
});

test('deletes objects with selection fallback while preserving source asset descriptors and bytes', () => {
  const { fixture, project, selection, assets, bus } = harness();
  selection.set([{ kind: 'volume', id: fixture.ids.volume }]);
  const before = projectBytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  bus.execute(new DeleteObjectCommand(fixture.ids.object));
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 0);
  assert.equal(project.getSnapshot().state.sourceAssets.length, 1);
  assert.ok(assets.has(fixture.ids.asset));
  assert.deepEqual(selection.getSnapshot(), {
    refs: [{ kind: 'plate', id: fixture.ids.plate }],
    primary: { kind: 'plate', id: fixture.ids.plate },
  });
  assert.deepEqual(assets.capture(), assetsBefore);

  bus.undo();
  assert.equal(projectBytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  bus.redo();
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 0);
});

test('creates and fills shared instances as one transaction and deletes with neighbor selection', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const ids = new UuidIdSource(seededRandom(0x2203));
  const first = ids.next('instance');
  const second = ids.next('instance');
  const before = projectBytes(project);
  const assetsBefore = assets.capture();

  createInstancesAtTransforms(bus, fixture.ids.object, [
    {
      id: first,
      name: 'Filled 1',
      transform: { ...identityTransform(), translationMm: [20, 0, 0] },
    },
    {
      id: second,
      name: 'Filled 2',
      transform: { ...identityTransform(), translationMm: [40, 0, 0] },
      printable: false,
    },
  ]);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  const object = project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.instances.length, 3);
  assert.deepEqual(
    object.instances.map((instance) => instance.transform.translationMm),
    [
      [0, 0, 0],
      [20, 0, 0],
      [40, 0, 0],
    ],
  );
  assert.equal(object.instances[2].printable, false);
  assert.deepEqual(assets.capture(), assetsBefore);
  bus.undo();
  assert.equal(projectBytes(project), before);

  bus.execute(
    new CreateInstanceCommand(fixture.ids.object, {
      id: first,
      name: 'Second instance',
      transform: { ...identityTransform(), translationMm: [15, 0, 0] },
      printable: true,
    }),
  );
  selection.set([{ kind: 'instance', id: first }]);
  bus.clearHistory();
  const twoInstanceBytes = projectBytes(project);
  const selectedSecond = selection.getSnapshot();
  bus.execute(new DeleteInstanceCommand(first));
  assert.equal(project.getSnapshot().state.plates[0].objects[0].instances.length, 1);
  assert.equal(selection.getSnapshot().primary?.kind, 'instance');
  assert.equal((selection.getSnapshot().primary as { id: InstanceId }).id, fixture.ids.instance);
  bus.undo();
  assert.equal(projectBytes(project), twoInstanceBytes);
  assert.deepEqual(selection.getSnapshot(), selectedSecond);
  assert.deepEqual(assets.capture(), assetsBefore);
});

test('rejects last-instance deletion and rolls back a colliding fill transaction atomically', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const before = projectBytes(project);
  const assetsBefore = assets.capture();
  const selectionBefore = selection.getSnapshot();
  assert.throws(() => bus.execute(new DeleteInstanceCommand(fixture.ids.instance)), /last instance/);
  assert.equal(projectBytes(project), before);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);

  const ids = new UuidIdSource(seededRandom(0x2204));
  assert.throws(() =>
    createInstancesAtTransforms(bus, fixture.ids.object, [
      { id: ids.next('instance'), transform: identityTransform() },
      { id: fixture.ids.asset as unknown as InstanceId, transform: identityTransform() },
    ]),
  );
  assert.equal(projectBytes(project), before);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('moves across plates, omits same-plate no-ops, and preserves state/selection through undo and redo', () => {
  const { fixture, secondPlate, project, selection, assets, bus } = harness(true);
  const destination = secondPlate!;
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const before = projectBytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  const revisionBefore = project.getSnapshot().revision;

  bus.execute(new MoveObjectToPlateCommand(fixture.ids.object, fixture.ids.plate));
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(project.getSnapshot().revision, revisionBefore);
  assert.equal(projectBytes(project), before);

  bus.execute(new MoveObjectToPlateCommand(fixture.ids.object, destination.id));
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 0);
  assert.equal(project.getSnapshot().state.plates[1].objects[0].id, fixture.ids.object);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  const moved = projectBytes(project);

  bus.undo();
  assert.equal(projectBytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.redo();
  assert.equal(projectBytes(project), moved);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.undo();
  assert.equal(projectBytes(project), before);

  const missing = entityId<'plate'>('import:test:missing-plate');
  assert.throws(() => bus.execute(new MoveObjectToPlateCommand(fixture.ids.object, missing)), /missing/);
  assert.equal(projectBytes(project), before);
});

test('converts an instance into an independent object and preserves state through undo and redo', () => {
  const { fixture, project, selection, bus } = harness();
  const ids = new UuidIdSource(seededRandom(0x2205));
  const secondInstanceId = ids.next('instance');
  // First add a second instance to the object
  bus.execute(
    new CreateInstanceCommand(fixture.ids.object, {
      id: secondInstanceId,
      name: 'Instance 2',
      transform: identityTransform(),
      printable: true,
    }),
  );
  assert.equal(project.getSnapshot().state.plates[0].objects[0].instances.length, 2);
  const beforeConversion = projectBytes(project);

  const convertIds: IndependentSingleInstanceObjectIds = {
    objectId: ids.next('object'),
    volumeIds: [ids.next('volume')],
    instanceId: ids.next('instance'),
    layerRangeIds: [ids.next('layer-range')],
  };

  bus.execute(new ConvertInstanceToIndependentObjectCommand(secondInstanceId, convertIds, 'Promoted Object'));
  const stateAfter = project.getSnapshot().state;
  const plate = stateAfter.plates[0];
  assert.equal(plate.objects.length, 2);
  assert.equal(plate.objects[0].instances.length, 1);
  assert.equal(plate.objects[1].id, convertIds.objectId);
  assert.equal(plate.objects[1].name, 'Promoted Object');
  assert.equal(plate.objects[1].instances.length, 1);
  assert.equal(plate.objects[1].instances[0].id, convertIds.instanceId);
  assert.deepEqual(selection.getSnapshot().refs, [{ kind: 'instance', id: convertIds.instanceId }]);

  // Converting sole instance should throw
  assert.throws(
    () => bus.execute(new ConvertInstanceToIndependentObjectCommand(convertIds.instanceId, convertIds)),
    /sole instance/i,
  );

  // Undo restores original 2-instance object
  bus.undo();
  assert.equal(projectBytes(project), beforeConversion);
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 1);
  assert.equal(project.getSnapshot().state.plates[0].objects[0].instances.length, 2);

  // Redo re-promotes
  bus.redo();
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 2);
});

console.log(`\nObject lifecycle commands: ${passed} tests passed.`);
