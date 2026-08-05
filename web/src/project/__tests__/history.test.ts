import assert from 'node:assert/strict';
import {
  AddObjectCommand,
  AddObjectWithAssetCommand,
  AddPlateCommand,
  CommandBus,
  DeletePlateCommand,
  InMemoryAssetRepository,
  ProjectStore,
  RenameProjectCommand,
  SelectionStore,
  SetInstanceTransformCommand,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  identityTransform,
  seededRandom,
  type ProjectCommand,
  type ProjectPlate,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(options: { maxEntries?: number } = {}) {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets }, { maxEntries: options.maxEntries ?? 100 });
  bus.markCheckpoint();
  return { fixture, project, selection, assets, bus };
}

test('applies, undoes and redoes project/plate/object commands with monotonic revisions', () => {
  const { fixture, project, bus } = harness();
  const startRevision = project.getSnapshot().revision;
  bus.execute(new RenameProjectCommand('Renamed'));
  const ids = new UuidIdSource(seededRandom(900));
  const plate: ProjectPlate = {
    id: ids.next('plate'),
    name: 'Plate 2',
    order: 1,
    printable: true,
    config: {},
    objects: [],
  };
  bus.execute(new AddPlateCommand(plate));
  assert.equal(project.getSnapshot().state.activePlateId, plate.id);
  assert.equal(bus.getHistorySnapshot().undoCount, 2);
  assert.ok(bus.undo());
  assert.equal(project.getSnapshot().state.activePlateId, fixture.state.activePlateId);
  assert.ok(bus.undo());
  assert.equal(project.getSnapshot().state.name, fixture.state.name);
  assert.ok(bus.redo());
  assert.equal(project.getSnapshot().state.name, 'Renamed');
  assert.ok(project.getSnapshot().revision > startRevision);
});

test('adds a mesh asset and object atomically with exact undo and redo ownership', () => {
  const fixture = createProjectFixture();
  const initial = cloneProjectState(fixture.state);
  initial.plates[0].objects = [];
  initial.sourceAssets = [];
  const project = new ProjectStore(initial);
  const selection = new SelectionStore();
  selection.set([{ kind: 'plate', id: initial.activePlateId }]);
  const assets = new InMemoryAssetRepository();
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  const stateBefore = canonicalStringify(project.getSnapshot().state);
  const selectionBefore = selection.getSnapshot();

  bus.execute(new AddObjectWithAssetCommand(initial.activePlateId, fixture.object, fixture.asset));
  assert.equal(project.getSnapshot().state.plates[0].objects[0].id, fixture.object.id);
  assert.deepEqual(project.getSnapshot().state.sourceAssets, [fixture.asset.descriptor]);
  assert.deepEqual(assets.get(fixture.asset.descriptor.id), fixture.asset);
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'instance', id: fixture.ids.instance });

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), stateBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(assets.has(fixture.asset.descriptor.id), false);
  assert.equal(bus.redo(), true);
  assert.equal(project.getSnapshot().state.plates[0].objects[0].id, fixture.object.id);
  assert.deepEqual(assets.get(fixture.asset.descriptor.id), fixture.asset);
});

test('rolls back invalid asset/object insertion and requires digest remapping before deduplication', () => {
  const fixture = createProjectFixture();
  const initial = cloneProjectState(fixture.state);
  const object = initial.plates[0].objects.pop()!;
  initial.sourceAssets = [];
  object.volumes[0].source.triangleCount += 1;
  const project = new ProjectStore(initial);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  const bus = new CommandBus({ project, selection, assets });
  const before = canonicalStringify(project.getSnapshot().state);

  assert.throws(
    () => bus.execute(new AddObjectWithAssetCommand(initial.activePlateId, object, fixture.asset)),
    /Invalid project state/,
  );
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.deepEqual(assets.list(), []);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);

  const dedupState = cloneProjectState(fixture.state);
  const validObject = dedupState.plates[0].objects.pop()!;
  const ids = new UuidIdSource(seededRandom(0xadd5));
  const duplicateAsset = {
    descriptor: { ...fixture.asset.descriptor, id: ids.next('asset') },
    bytes: fixture.asset.bytes,
  };
  validObject.volumes[0].source.assetId = duplicateAsset.descriptor.id;
  const dedupProject = new ProjectStore(dedupState);
  const dedupAssets = new InMemoryAssetRepository();
  dedupAssets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const dedupBus = new CommandBus({
    project: dedupProject,
    selection: new SelectionStore(),
    assets: dedupAssets,
  });
  assert.throws(
    () => dedupBus.execute(new AddObjectWithAssetCommand(dedupState.activePlateId, validObject, duplicateAsset)),
    /remap the object/,
  );
  assert.equal(dedupProject.getSnapshot().state.sourceAssets.length, 1);
  assert.equal(dedupProject.getSnapshot().state.plates[0].objects.length, 0);
  assert.equal(dedupAssets.list().length, 1);
});

test('deletes a plate with scoped metadata and restores the exact project on undo', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const ids = new UuidIdSource(seededRandom(0xd31e7e));
  const secondPlate: ProjectPlate = {
    id: ids.next('plate'),
    name: 'Plate 2',
    order: 1,
    printable: true,
    config: {},
    objects: [],
  };
  state.plates.push(secondPlate);
  state.customGcode.push({
    id: ids.next('custom-gcode'),
    scope: 'plate',
    plateId: fixture.ids.plate,
    trigger: 'before-plate',
    code: 'M117 first plate',
  });
  state.thumbnails.push({
    id: ids.next('thumbnail'),
    assetId: fixture.ids.asset,
    plateId: fixture.ids.plate,
    width: 64,
    height: 64,
  });
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  const before = canonicalStringify(project.getSnapshot().state);
  const selectionBefore = selection.getSnapshot();

  bus.execute(new DeletePlateCommand(fixture.ids.plate));
  assert.deepEqual(
    project.getSnapshot().state.plates.map((plate) => [plate.id, plate.order]),
    [[secondPlate.id, 0]],
  );
  assert.equal(project.getSnapshot().state.activePlateId, secondPlate.id);
  assert.deepEqual(project.getSnapshot().state.customGcode, []);
  assert.deepEqual(project.getSnapshot().state.thumbnails, []);
  assert.deepEqual(selection.getSnapshot(), {
    refs: [{ kind: 'plate', id: secondPlate.id }],
    primary: { kind: 'plate', id: secondPlate.id },
  });
  assert.equal(assets.has(fixture.ids.asset), true);

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(assets.has(fixture.ids.asset), true);
  assert.equal(bus.redo(), true);
  assert.equal(project.getSnapshot().state.plates.length, 1);
});

test('rejects deleting the final plate without changing history or selection', () => {
  const { fixture, project, selection, bus } = harness();
  selection.set([{ kind: 'plate', id: fixture.ids.plate }]);
  const before = canonicalStringify(project.getSnapshot().state);
  const selectionBefore = selection.getSnapshot();
  assert.throws(() => bus.execute(new DeletePlateCommand(fixture.ids.plate)), /last plate/);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('coalesces one instance drag into a single reversible history entry', () => {
  const { fixture, project, bus } = harness();
  const instanceId = fixture.ids.instance;
  for (const x of [10, 20, 30]) {
    bus.execute(
      new SetInstanceTransformCommand(
        instanceId,
        {
          ...identityTransform(),
          translationMm: [x, 0, 0],
        },
        'pointer-7',
      ),
    );
  }
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.deepEqual(project.getSnapshot().state.plates[0].objects[0].instances[0].transform.translationMm, [30, 0, 0]);
  bus.undo();
  assert.deepEqual(project.getSnapshot().state.plates[0].objects[0].instances[0].transform.translationMm, [0, 0, 0]);
  bus.redo();
  assert.deepEqual(project.getSnapshot().state.plates[0].objects[0].instances[0].transform.translationMm, [30, 0, 0]);
});

test('tracks saved checkpoints and bounded history independently of monotonic revisions', () => {
  const { bus, project } = harness({ maxEntries: 2 });
  const checkpointBytes = canonicalStringify(project.getSnapshot().state);
  bus.execute(new RenameProjectCommand('One'));
  assert.deepEqual(bus.dirtyCategories(), ['projectData']);
  bus.undo();
  assert.deepEqual(bus.dirtyCategories(), []);
  assert.equal(canonicalStringify(project.getSnapshot().state), checkpointBytes);
  bus.redo();
  bus.markCheckpoint();
  assert.equal(bus.isDirty(), false);
  bus.execute(new RenameProjectCommand('Two'));
  bus.execute(new RenameProjectCommand('Three'));
  bus.execute(new RenameProjectCommand('Four'));
  assert.equal(bus.getHistorySnapshot().undoCount, 2);
  assert.equal(bus.isDirty('projectData'), true);
});

test('commits a multi-command transaction as one atomic history entry', () => {
  const { fixture, bus, project } = harness();
  const empty = createProjectFixture({ withObject: false });
  project.replaceState(empty.state, { reason: 'test-reset', dirtyCategories: [] });
  bus.clearHistory();
  bus.transaction('Add and place object', () => {
    bus.execute(new AddObjectCommand(empty.state.activePlateId, fixture.object));
    bus.execute(
      new SetInstanceTransformCommand(fixture.ids.instance, {
        ...identityTransform(),
        translationMm: [42, 8, 1],
      }),
    );
  });
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.deepEqual(project.getSnapshot().state.plates[0].objects[0].instances[0].transform.translationMm, [42, 8, 1]);
  bus.undo();
  assert.equal(project.getSnapshot().state.plates[0].objects.length, 0);
});

test('rejects promise-returning transactions and rolls back their synchronous mutations', () => {
  const { fixture, project, bus } = harness();
  const before = canonicalStringify(project.getSnapshot().state);
  const asyncOperation = () => {
    bus.execute(new RenameProjectCommand('Must roll back'));
    return Promise.resolve('not a transaction result');
  };

  assert.throws(
    () => bus.transaction('Unsafe asynchronous transaction', asyncOperation as unknown as () => never),
    /must be synchronous/,
  );
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(bus.isDirty(), false);
  assert.equal(project.getSnapshot().state.plates[0].objects[0].id, fixture.ids.object);
});

test('rolls back project, assets, selection, dirty state and history on transaction failure', () => {
  const { fixture, project, assets, selection, bus } = harness();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const stateBefore = cloneProjectState(project.getSnapshot().state);
  const assetBefore = assets.get(fixture.ids.asset);
  const selectionBefore = selection.getSnapshot();
  const historyBefore = bus.getHistorySnapshot();
  const fail: ProjectCommand = {
    type: 'failing-asset-command',
    label: 'Fail after touching every store',
    dirtyCategories: ['presets', 'printerDevice'],
    apply(context) {
      context.assets.remove(fixture.ids.asset);
      context.selection.clear();
      throw new Error('intentional failure');
    },
    revert() {},
  };
  assert.throws(() =>
    bus.transaction('Broken import', () => {
      bus.execute(new RenameProjectCommand('Should roll back'));
      bus.execute(fail);
    }),
  );
  assert.deepEqual(project.getSnapshot().state, stateBefore);
  assert.deepEqual(assets.get(fixture.ids.asset), assetBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(bus.getHistorySnapshot(), historyBefore);
});

test('rolls back a command when post-apply history accounting fails', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const before = cloneProjectState(project.getSnapshot().state);
  const failingEstimate: ProjectCommand = {
    type: 'bad-estimate',
    label: 'Bad estimate',
    dirtyCategories: ['presets'],
    apply(context) {
      const next = cloneProjectState(context.project.getSnapshot().state);
      next.name = 'Must not survive';
      context.project.replaceState(next);
    },
    revert() {},
    estimateBytes() {
      throw new Error('estimate failed');
    },
  };
  assert.throws(() => bus.execute(failingEstimate));
  assert.deepEqual(project.getSnapshot().state, before);
  assert.deepEqual(bus.dirtyCategories(), []);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.ok(assets.has(fixture.ids.asset));
  assert.deepEqual(selection.getSnapshot(), { refs: [] });
});

test('keeps preset and printer/device dirty categories independent', () => {
  const { fixture, bus } = harness();
  const deviceCommand: ProjectCommand = {
    type: 'select-device-target',
    label: 'Select device target',
    dirtyCategories: ['printerDevice'],
    apply(context) {
      context.selection.set([{ kind: 'plate', id: fixture.ids.plate }]);
    },
    revert(context) {
      context.selection.clear();
    },
  };
  bus.execute(deviceCommand);
  assert.deepEqual(bus.dirtyCategories(), ['printerDevice']);
  bus.undo();
  assert.deepEqual(bus.dirtyCategories(), []);
});

test('deduplicates, toggles, restores and prunes stable entity selections', () => {
  const { fixture, project, selection } = harness();
  const ref = { kind: 'instance' as const, id: fixture.ids.instance };
  selection.set([ref, ref]);
  assert.equal(selection.getSnapshot().refs.length, 1);
  selection.toggle({ kind: 'object', id: fixture.ids.object });
  assert.equal(selection.getSnapshot().refs.length, 2);
  const saved = selection.getSnapshot();
  selection.clear();
  selection.restore(saved);
  assert.deepEqual(selection.getSnapshot(), saved);
  const withoutObject = cloneProjectState(project.getSnapshot().state);
  withoutObject.plates[0].objects = [];
  selection.prune(withoutObject);
  assert.deepEqual(selection.getSnapshot(), { refs: [] });
});

console.log(`\nProject history: ${passed} tests passed.`);
