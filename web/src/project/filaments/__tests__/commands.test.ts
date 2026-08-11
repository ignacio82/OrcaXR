import assert from 'node:assert/strict';
import {
  CommandBus,
  DisableFilamentCommand,
  InMemoryAssetRepository,
  ProjectStore,
  RemapFilamentsCommand,
  SelectionStore,
  SetFilamentAssignmentsCommand,
  SetLayerRangeFilamentCommand,
  SetObjectFilamentCommand,
  SetVolumeFilamentCommand,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  seededRandom,
  type FilamentAssignmentChange,
  type PhysicalFilament,
  type ProjectState,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(state?: ProjectState) {
  const fixture = createProjectFixture();
  const project = new ProjectStore(state ?? fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, project, selection, assets, bus };
}

function bytes(project: ProjectStore): string {
  return canonicalStringify(project.getSnapshot().state);
}

test('assigns and clears stable filament IDs at object, volume, and layer-range scopes', () => {
  const { fixture, project, selection, bus } = harness();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();

  bus.execute(new SetObjectFilamentCommand(fixture.ids.object, fixture.ids.physical0));
  assert.equal(bus.getHistorySnapshot().undoCount, 0, 'an identical stable-ID assignment is a real no-op');
  assert.equal(project.getSnapshot().revision, 0);

  bus.execute(new SetObjectFilamentCommand(fixture.ids.object, fixture.ids.physical1));
  bus.execute(new SetVolumeFilamentCommand(fixture.ids.object, fixture.ids.volume, fixture.ids.mixed));
  bus.execute(new SetLayerRangeFilamentCommand(fixture.ids.object, fixture.ids.range, fixture.ids.physical1));
  let object = project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.filamentId, fixture.ids.physical1);
  assert.equal(object.volumes[0].filamentId, fixture.ids.mixed);
  assert.equal(object.layerRanges[0].filamentId, fixture.ids.physical1);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);

  bus.execute(new SetVolumeFilamentCommand(fixture.ids.object, fixture.ids.volume, null));
  bus.execute(new SetLayerRangeFilamentCommand(fixture.ids.object, fixture.ids.range, null));
  object = project.getSnapshot().state.plates[0].objects[0];
  assert.equal(object.volumes[0].filamentId, undefined);
  assert.equal(object.layerRanges[0].filamentId, undefined);

  for (let index = 0; index < 5; index += 1) assert.equal(bus.undo(), true);
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
});

test('commits heterogeneous assignment batches as one byte-reversible history entry', () => {
  const { fixture, project, selection, assets, bus } = harness();
  selection.set([{ kind: 'volume', id: fixture.ids.volume }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  const assignments: FilamentAssignmentChange[] = [
    { target: { kind: 'object', objectId: fixture.ids.object }, filamentId: fixture.ids.physical1 },
    {
      target: { kind: 'volume', objectId: fixture.ids.object, volumeId: fixture.ids.volume },
      filamentId: fixture.ids.mixed,
    },
    {
      target: { kind: 'layer-range', objectId: fixture.ids.object, layerRangeId: fixture.ids.range },
      filamentId: fixture.ids.physical1,
    },
  ];

  bus.execute(new SetFilamentAssignmentsCommand(assignments));
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  const assigned = bytes(project);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  bus.execute(new SetFilamentAssignmentsCommand(assignments));
  assert.equal(bus.getHistorySnapshot().undoCount, 1, 'an identical batch is omitted from history');

  bus.undo();
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.redo();
  assert.equal(bytes(project), assigned);
  assert.deepEqual(assets.capture(), assetsBefore);

  assert.throws(
    () => new SetFilamentAssignmentsCommand([assignments[0], assignments[0]]),
    /duplicate filament assignment targets/,
  );
});

test('rejects disabled destinations and child scopes owned by another object atomically', () => {
  const fixture = createProjectFixture();
  const disabled = cloneProjectState(fixture.state);
  disabled.filaments.physical[1].enabled = false;
  const { project, selection, assets, bus } = harness(disabled);
  selection.set([{ kind: 'object', id: fixture.ids.object }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  assert.throws(() => bus.execute(new SetObjectFilamentCommand(fixture.ids.object, fixture.ids.physical1)), /disabled/);
  const unrelatedObject = new UuidIdSource(seededRandom(0x4510)).next('object');
  assert.throws(
    () => bus.execute(new SetVolumeFilamentCommand(unrelatedObject, fixture.ids.volume, fixture.ids.physical0)),
    /not owned/,
  );
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('remaps many source IDs across every reference and coalesces mixed gradient components', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const ids = new UuidIdSource(seededRandom(0x4511));
  const physical2: PhysicalFilament = {
    id: ids.next('physical-filament'),
    name: 'Head 3 PLA',
    toolId: 2,
    material: 'PLA',
    color: '#00ff00',
    config: {},
    enabled: true,
  };
  const destination: PhysicalFilament = {
    id: ids.next('physical-filament'),
    name: 'Head 4 PLA',
    toolId: 3,
    material: 'PLA',
    color: '#ffff00',
    config: {},
    enabled: true,
  };
  state.printer.toolCount = 4;
  state.filaments.physical.push(physical2, destination);
  const object = state.plates[0].objects[0];
  state.sourceAssets[0].mesh!.triangleCount = 3;
  object.volumes[0].source.triangleCount = 3;
  object.filamentId = fixture.ids.physical0;
  object.volumes[0].filamentId = fixture.ids.physical1;
  object.volumes[0].annotations.color = [
    { triangles: [2, 0], value: fixture.ids.physical0 },
    { triangles: [1], value: fixture.ids.physical1 },
  ];
  object.layerRanges[0].filamentId = fixture.ids.physical1;
  state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [10, 20],
    rotationDeg: 0,
    filamentId: fixture.ids.physical0,
  };
  state.filaments.mixed[0].components = [
    { filamentId: fixture.ids.physical0, weight: 1 },
    { filamentId: fixture.ids.physical1, weight: 1 },
    { filamentId: physical2.id, weight: 1 },
  ];
  state.filaments.mixed[0].distribution = {
    mode: 'gradient',
    startZMm: 0,
    endZMm: 10,
    startWeights: [0.2, 0.3, 0.5],
    endWeights: [0.4, 0.2, 0.4],
  };

  const { project, selection, assets, bus } = harness(state);
  selection.set([{ kind: 'filament', id: fixture.ids.physical0 }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  bus.execute(new RemapFilamentsCommand([fixture.ids.physical0, fixture.ids.physical1], destination.id));

  const remapped = project.getSnapshot().state;
  const remappedObject = remapped.plates[0].objects[0];
  assert.equal(remappedObject.filamentId, destination.id);
  assert.equal(remappedObject.volumes[0].filamentId, destination.id);
  assert.equal(remappedObject.layerRanges[0].filamentId, destination.id);
  assert.deepEqual(remappedObject.volumes[0].annotations.color, [{ value: destination.id, triangles: [0, 1, 2] }]);
  assert.equal(remapped.plates[0].wipeTower?.filamentId, destination.id);
  assert.deepEqual(remapped.filaments.mixed[0].components, [
    { filamentId: destination.id, weight: 2 },
    { filamentId: physical2.id, weight: 1 },
  ]);
  assert.deepEqual(remapped.filaments.mixed[0].distribution, {
    mode: 'gradient',
    startZMm: 0,
    endZMm: 10,
    startWeights: [0.5, 0.5],
    endWeights: [0.6000000000000001, 0.4],
  });
  assert.ok(remapped.filaments.physical.some((filament) => filament.id === fixture.ids.physical0));
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  const after = bytes(project);

  bus.undo();
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.redo();
  assert.equal(bytes(project), after);
  assert.deepEqual(assets.capture(), assetsBefore);
});

test('many-to-one remap collapses refined color leaves and remains byte-exact through undo and redo', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const destination: PhysicalFilament = {
    id: new UuidIdSource(seededRandom(0x4513)).next('physical-filament'),
    name: 'Merged head',
    toolId: 2,
    material: 'PLA',
    color: '#00ff00',
    config: {},
    enabled: true,
  };
  state.printer.toolCount = 3;
  state.filaments.physical.push(destination);
  state.filaments.mixed = [];
  const annotations = state.plates[0].objects[0].volumes[0].annotations;
  annotations.color = [];
  annotations.refinement = {
    color: {
      version: 2,
      triangleCount: 1,
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
  const { project, bus } = harness(state);
  const before = bytes(project);

  bus.execute(new RemapFilamentsCommand([fixture.ids.physical0, fixture.ids.physical1], destination.id));
  const remapped = project.getSnapshot().state.plates[0].objects[0].volumes[0].annotations;
  assert.deepEqual(remapped.color, [{ value: destination.id, triangles: [0] }]);
  assert.equal(remapped.refinement, undefined);
  const after = bytes(project);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  assert.equal(bus.undo(), true);
  assert.equal(bytes(project), before);
  assert.equal(bus.redo(), true);
  assert.equal(bytes(project), after);
});

test('rejects self/cyclic remaps and omits an unused-source remap without dirtying history', () => {
  const fixture = createProjectFixture();
  assert.throws(
    () => new RemapFilamentsCommand([fixture.ids.physical0], fixture.ids.physical0),
    /map a source to itself/,
  );
  const { project, selection, assets, bus } = harness();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  assert.throws(
    () => bus.execute(new RemapFilamentsCommand([fixture.ids.physical0], fixture.ids.mixed)),
    /recipe components can only be remapped to a physical filament/,
  );
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);

  const unusedState = cloneProjectState(fixture.state);
  const unused: PhysicalFilament = {
    id: new UuidIdSource(seededRandom(0x4512)).next('physical-filament'),
    name: 'Unused',
    toolId: 2,
    material: 'PLA',
    color: '#888888',
    config: {},
    enabled: true,
  };
  unusedState.printer.toolCount = 3;
  unusedState.filaments.physical.push(unused);
  const unusedHarness = harness(unusedState);
  const revision = unusedHarness.project.getSnapshot().revision;
  unusedHarness.bus.execute(new RemapFilamentsCommand([unused.id], fixture.ids.physical1));
  assert.equal(unusedHarness.bus.getHistorySnapshot().undoCount, 0);
  assert.equal(unusedHarness.project.getSnapshot().revision, revision);
});

test('disables referenced filaments as reversible tombstones instead of deleting definitions', () => {
  const { fixture, project, selection, assets, bus } = harness();
  selection.set([{ kind: 'filament', id: fixture.ids.physical0 }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  bus.execute(new DisableFilamentCommand(fixture.ids.physical0, 'user-removed-slot'));
  const state = project.getSnapshot().state;
  const filament = state.filaments.physical.find((candidate) => candidate.id === fixture.ids.physical0)!;
  assert.equal(filament.enabled, false);
  assert.equal(state.plates[0].objects[0].filamentId, fixture.ids.physical0);
  assert.equal(state.filaments.physical.length, 2);
  assert.deepEqual(filament.extensionData?.orcaxrFilamentLifecycle, {
    state: 'disabled',
    reason: 'user-removed-slot',
    semantics: 'tombstone-preserve-references',
  });
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  const disabledBytes = bytes(project);

  bus.undo();
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.redo();
  assert.equal(bytes(project), disabledBytes);
  assert.deepEqual(assets.capture(), assetsBefore);
});

console.log(`\nFilament commands: ${passed} tests passed.`);
