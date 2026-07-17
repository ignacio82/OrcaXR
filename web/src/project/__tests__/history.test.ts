import assert from 'node:assert/strict';
import {
  AddObjectCommand,
  AddPlateCommand,
  CommandBus,
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
