import assert from 'node:assert/strict';
import {
  AddMixedFilamentCommand,
  CommandBus,
  DisableMixedFilamentCommand,
  DuplicateMixedFilamentCommand,
  EditMixedFilamentCommand,
  EnableMixedFilamentCommand,
  InMemoryAssetRepository,
  MixedFilamentInUseError,
  ProjectStore,
  RemoveMixedFilamentCommand,
  RenameMixedFilamentCommand,
  SelectionStore,
  SetMixedFilamentComponentsCommand,
  SetMixedFilamentDistributionCommand,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  findFilamentDependentPaths,
  isStableEntityId,
  seededRandom,
  type MixedFilament,
  type MixedFilamentId,
  type PhysicalFilamentId,
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

function mixedId(seed: number): MixedFilamentId {
  return new UuidIdSource(seededRandom(seed)).next('mixed-filament');
}

function physicalId(seed: number): PhysicalFilamentId {
  return new UuidIdSource(seededRandom(seed)).next('physical-filament');
}

function recipe(
  id: MixedFilamentId,
  componentIds: readonly [
    MixedFilament['components'][number]['filamentId'],
    MixedFilament['components'][number]['filamentId'],
  ],
  name = 'New virtual filament',
): MixedFilament {
  return {
    id,
    name,
    displayColor: '#663399',
    components: componentIds.map((filamentId) => ({ filamentId, weight: 1 })),
    distribution: { mode: 'ratio' },
    config: {},
    enabled: true,
  };
}

test('adds an injected stable-ID recipe in deterministic order with byte-exact history', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const id = mixedId(0x3201);
  const added = recipe(id, [fixture.ids.physical1, fixture.ids.physical0]);
  selection.set([{ kind: 'object', id: fixture.ids.object }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  bus.execute(new AddMixedFilamentCommand(added));
  const state = project.getSnapshot().state;
  assert.equal(isStableEntityId(id), true);
  assert.deepEqual(
    state.filaments.mixed.map((filament) => filament.id),
    [fixture.ids.mixed, id],
  );
  assert.deepEqual(state.filaments.mixed[1], added);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
  assert.deepEqual(bus.getHistorySnapshot().dirtyCategories, ['projectData']);
  const after = bytes(project);

  assert.equal(bus.undo(), true);
  assert.equal(bytes(project), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.redo(), true);
  assert.equal(bytes(project), after);
  assert.deepEqual(assets.capture(), assetsBefore);
});

test('edits names, fields, component weights/order, and every distribution without normalization', () => {
  const { fixture, project, selection, assets, bus } = harness();
  selection.set([{ kind: 'filament', id: fixture.ids.mixed }]);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  const snapshots = [bytes(project)];

  bus.execute(new RenameMixedFilamentCommand(fixture.ids.mixed, ' Purple mix '));
  assert.equal(bus.getHistorySnapshot().undoCount, 0, 'trimmed identical rename is a true no-op');
  assert.equal(project.getSnapshot().revision, 0);

  const execute = (command: Parameters<CommandBus['execute']>[0]) => {
    bus.execute(command);
    snapshots.push(bytes(project));
  };
  execute(new RenameMixedFilamentCommand(fixture.ids.mixed, 'Sunset blend'));
  execute(
    new EditMixedFilamentCommand(fixture.ids.mixed, {
      displayColor: '#f08040',
      config: { ratio_bias: 0.125, exact_user_value: '3/7' },
    }),
  );
  execute(
    new SetMixedFilamentComponentsCommand(fixture.ids.mixed, [
      { filamentId: fixture.ids.physical1, weight: 7 },
      { filamentId: fixture.ids.physical0, weight: 3 },
    ]),
  );
  assert.deepEqual(project.getSnapshot().state.filaments.mixed[0].components, [
    { filamentId: fixture.ids.physical1, weight: 7 },
    { filamentId: fixture.ids.physical0, weight: 3 },
  ]);

  execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'cycle', cycleLengthMm: 12.75 }));
  assert.deepEqual(project.getSnapshot().state.filaments.mixed[0].distribution, {
    mode: 'cycle',
    cycleLengthMm: 12.75,
  });
  execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'match', targetColor: '#123456' }));
  assert.deepEqual(project.getSnapshot().state.filaments.mixed[0].distribution, {
    mode: 'match',
    targetColor: '#123456',
  });
  execute(
    new SetMixedFilamentDistributionCommand(fixture.ids.mixed, {
      mode: 'gradient',
      startZMm: 0,
      endZMm: 42.5,
      startWeights: [0.8125, 0.1875],
      endWeights: [0.125, 0.875],
    }),
  );
  assert.deepEqual(project.getSnapshot().state.filaments.mixed[0].distribution, {
    mode: 'gradient',
    startZMm: 0,
    endZMm: 42.5,
    startWeights: [0.8125, 0.1875],
    endWeights: [0.125, 0.875],
  });
  execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'ratio' }));

  const historyCount = snapshots.length - 1;
  assert.equal(bus.getHistorySnapshot().undoCount, historyCount);
  const revision = project.getSnapshot().revision;
  bus.execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'ratio' }));
  assert.equal(project.getSnapshot().revision, revision);
  assert.equal(bus.getHistorySnapshot().undoCount, historyCount);

  for (let index = snapshots.length - 2; index >= 0; index -= 1) {
    assert.equal(bus.undo(), true);
    assert.equal(bytes(project), snapshots[index]);
    assert.deepEqual(selection.getSnapshot(), selectionBefore);
  }
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.equal(bus.redo(), true);
    assert.equal(bytes(project), snapshots[index]);
    assert.deepEqual(selection.getSnapshot(), selectionBefore);
  }
  assert.deepEqual(assets.capture(), assetsBefore);
});

test('duplicates beside the source and rejects colliding injected IDs atomically', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const duplicateId = mixedId(0x3202);
  selection.set([{ kind: 'filament', id: fixture.ids.mixed }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  bus.execute(new DuplicateMixedFilamentCommand(fixture.ids.mixed, duplicateId, 'Purple alternate'));
  const filaments = project.getSnapshot().state.filaments.mixed;
  assert.deepEqual(
    filaments.map((filament) => filament.id),
    [fixture.ids.mixed, duplicateId],
  );
  assert.deepEqual(filaments[1], { ...filaments[0], id: duplicateId, name: 'Purple alternate' });
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  const duplicatedBytes = bytes(project);

  assert.throws(
    () =>
      bus.execute(
        new DuplicateMixedFilamentCommand(fixture.ids.mixed, fixture.ids.asset as unknown as MixedFilamentId),
      ),
    /already exists in the project/,
  );
  assert.equal(bytes(project), duplicatedBytes);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);

  bus.undo();
  assert.equal(bytes(project), before);
  bus.redo();
  assert.equal(bytes(project), duplicatedBytes);
});

test('rejects missing/disabled components, cycles, bad weights, and invalid mode bounds atomically', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const disabledId = physicalId(0x3200);
  state.printer.toolCount = 3;
  state.filaments.physical.push({
    id: disabledId,
    name: 'Disabled head',
    toolId: 2,
    material: 'PLA',
    color: '#808080',
    config: {},
    enabled: false,
  });
  const { project, selection, assets, bus } = harness(state);
  selection.set([{ kind: 'volume', id: fixture.ids.volume }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  const unknown = physicalId(0x3203);

  const failures: Array<readonly [() => void, RegExp]> = [
    [
      () => bus.execute(new AddMixedFilamentCommand(recipe(mixedId(0x3204), [fixture.ids.physical0, disabledId]))),
      /component .* is disabled/,
    ],
    [
      () => bus.execute(new AddMixedFilamentCommand(recipe(mixedId(0x3205), [fixture.ids.physical0, unknown]))),
      /Unknown mixed filament component/,
    ],
    [
      () =>
        bus.execute(
          new SetMixedFilamentComponentsCommand(fixture.ids.mixed, [
            { filamentId: fixture.ids.physical0, weight: 1 },
            { filamentId: fixture.ids.mixed as unknown as PhysicalFilamentId, weight: 1 },
          ]),
        ),
      /Unknown mixed filament component/,
    ],
    [
      () =>
        bus.execute(
          new SetMixedFilamentComponentsCommand(fixture.ids.mixed, [
            { filamentId: fixture.ids.physical0, weight: -1 },
            { filamentId: fixture.ids.physical1, weight: 2 },
          ]),
        ),
      /Invalid project state/,
    ],
    [
      () =>
        bus.execute(
          new SetMixedFilamentComponentsCommand(fixture.ids.mixed, [
            { filamentId: fixture.ids.physical0, weight: 1 },
            { filamentId: fixture.ids.physical0, weight: 2 },
          ]),
        ),
      /duplicated/,
    ],
    [
      () =>
        bus.execute(
          new SetMixedFilamentDistributionCommand(fixture.ids.mixed, {
            mode: 'gradient',
            startZMm: 8,
            endZMm: 4,
            startWeights: [1],
            endWeights: [0, 0],
          }),
        ),
      /gradient range/,
    ],
    [
      () =>
        bus.execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'match', targetColor: ' ' })),
      /target color cannot be empty/,
    ],
    [
      () =>
        bus.execute(new SetMixedFilamentDistributionCommand(fixture.ids.mixed, { mode: 'cycle', cycleLengthMm: 0 })),
      /cycle length must be greater than zero/,
    ],
  ];

  for (const [run, expected] of failures) {
    assert.throws(run, expected);
    assert.equal(bytes(project), before);
    assert.deepEqual(selection.getSnapshot(), selectionBefore);
    assert.deepEqual(assets.capture(), assetsBefore);
    assert.equal(bus.getHistorySnapshot().undoCount, 0);
    assert.deepEqual(bus.getHistorySnapshot().dirtyCategories, []);
  }
});

test('disables and re-enables referenced recipes as reversible tombstones', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.filaments.mixed[0].extensionData = { preserved: { source: 'fixture' } };
  const { project, selection, assets, bus } = harness(state);
  selection.set([{ kind: 'filament', id: fixture.ids.mixed }]);
  const before = bytes(project);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();

  bus.execute(new DisableMixedFilamentCommand(fixture.ids.mixed, 'dependency-review'));
  let mixed = project.getSnapshot().state.filaments.mixed[0];
  assert.equal(mixed.enabled, false);
  assert.equal(
    project.getSnapshot().state.plates[0].objects[0].volumes[0].annotations.color[0].value,
    fixture.ids.mixed,
  );
  assert.deepEqual(mixed.extensionData, {
    preserved: { source: 'fixture' },
    orcaxrFilamentLifecycle: {
      state: 'disabled',
      reason: 'dependency-review',
      semantics: 'tombstone-preserve-references',
    },
  });
  const disabled = bytes(project);
  const revision = project.getSnapshot().revision;
  bus.execute(new DisableMixedFilamentCommand(fixture.ids.mixed, 'dependency-review'));
  assert.equal(project.getSnapshot().revision, revision);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  bus.execute(new EnableMixedFilamentCommand(fixture.ids.mixed));
  mixed = project.getSnapshot().state.filaments.mixed[0];
  assert.equal(mixed.enabled, true);
  assert.deepEqual(mixed.extensionData, { preserved: { source: 'fixture' } });
  const enabled = bytes(project);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);

  bus.undo();
  assert.equal(bytes(project), disabled);
  bus.undo();
  assert.equal(bytes(project), before);
  bus.redo();
  assert.equal(bytes(project), disabled);
  bus.redo();
  assert.equal(bytes(project), enabled);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
});

test('reports every dependent path and preserves the tombstone when removal is unsafe', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const object = state.plates[0].objects[0];
  object.filamentId = fixture.ids.mixed;
  object.volumes[0].filamentId = fixture.ids.mixed;
  object.layerRanges[0].filamentId = fixture.ids.mixed;
  state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [10, 20],
    rotationDeg: 0,
    filamentId: fixture.ids.mixed,
  };
  const { project, selection, assets, bus } = harness(state);
  selection.set([{ kind: 'filament', id: fixture.ids.mixed }]);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  bus.execute(new DisableMixedFilamentCommand(fixture.ids.mixed, 'pending-safe-removal'));
  const tombstone = bytes(project);
  const historyBefore = bus.getHistorySnapshot();
  const expected = [
    'plates[0].objects[0].filamentId',
    'plates[0].objects[0].layerRanges[0].filamentId',
    'plates[0].objects[0].volumes[0].annotations.color[0].value',
    'plates[0].objects[0].volumes[0].filamentId',
    'plates[0].wipeTower.filamentId',
  ].sort();
  assert.deepEqual(findFilamentDependentPaths(project.getSnapshot().state, fixture.ids.mixed), expected);

  assert.throws(
    () => bus.execute(new RemoveMixedFilamentCommand(fixture.ids.mixed)),
    (error: unknown) => {
      assert.ok(error instanceof MixedFilamentInUseError);
      assert.equal(error.filamentId, fixture.ids.mixed);
      assert.deepEqual(error.dependentPaths, expected);
      assert.match(error.message, /still referenced by/);
      return true;
    },
  );
  assert.equal(bytes(project), tombstone);
  assert.equal(project.getSnapshot().state.filaments.mixed[0].enabled, false);
  assert.deepEqual(bus.getHistorySnapshot(), historyBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), assetsBefore);
});

test('removes only an unreferenced recipe, repairs selection, and restores it exactly on undo', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations.color[0].value = fixture.ids.physical0;
  const { project, selection, assets, bus } = harness(state);
  selection.set([{ kind: 'filament', id: fixture.ids.mixed }]);
  const selectionBefore = selection.getSnapshot();
  const assetsBefore = assets.capture();
  assert.deepEqual(findFilamentDependentPaths(project.getSnapshot().state, fixture.ids.mixed), []);

  bus.execute(new DisableMixedFilamentCommand(fixture.ids.mixed, 'delete-request'));
  const tombstone = bytes(project);
  bus.execute(new RemoveMixedFilamentCommand(fixture.ids.mixed));
  assert.equal(
    project.getSnapshot().state.filaments.mixed.some((entry) => entry.id === fixture.ids.mixed),
    false,
  );
  assert.deepEqual(selection.getSnapshot(), { refs: [] });
  assert.deepEqual(assets.capture(), assetsBefore);
  const removed = bytes(project);

  bus.undo();
  assert.equal(bytes(project), tombstone);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  bus.redo();
  assert.equal(bytes(project), removed);
  assert.deepEqual(selection.getSnapshot(), { refs: [] });
  assert.deepEqual(assets.capture(), assetsBefore);
});

console.log(`\nMixed-filament commands: ${passed} tests passed.`);
