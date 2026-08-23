import assert from 'node:assert/strict';

import {
  AddPlateCommand,
  CommandBus,
  DuplicatePlateCommand,
  InMemoryAssetRepository,
  MAX_PROJECT_PLATES,
  ProjectStore,
  RenamePlateCommand,
  ReorderPlatesCommand,
  SelectionStore,
  SetPlatePrintableCommand,
  SetPlateWipeTowerCommand,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  seededRandom,
  type DuplicatePlateIds,
  type ProjectPlate,
  type ProjectState,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(plateCount = 3) {
  const fixture = createProjectFixture({ withObject: false });
  const state = cloneProjectState(fixture.state);
  const ids = new UuidIdSource(seededRandom(0x51a7e));
  for (let index = 1; index < plateCount; index += 1) {
    state.plates.push(emptyPlate(ids, index));
  }
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'plate', id: state.activePlateId }]);
  const bus = new CommandBus({ project, selection, assets: new InMemoryAssetRepository() });
  bus.markCheckpoint();
  return { fixture, ids, project, selection, bus };
}

test('renames a stable plate exactly and round-trips undo/redo', () => {
  const { project, bus } = harness();
  const target = project.getSnapshot().state.plates[1];
  const before = canonicalStringify(project.getSnapshot().state);

  bus.execute(new RenamePlateCommand(target.id, 'Material tests'));
  assert.equal(project.getSnapshot().state.plates[1].name, 'Material tests');
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(bus.redo(), true);
  assert.equal(project.getSnapshot().state.plates[1].name, 'Material tests');
});

test('toggles per-plate printable state without changing active plate or selection', () => {
  const { project, selection, bus } = harness();
  const target = project.getSnapshot().state.plates[2];
  const activeBefore = project.getSnapshot().state.activePlateId;
  const selectionBefore = selection.getSnapshot();

  bus.execute(new SetPlatePrintableCommand(target.id, false));
  assert.equal(project.getSnapshot().state.plates[2].printable, false);
  assert.equal(project.getSnapshot().state.activePlateId, activeBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.undo(), true);
  assert.equal(project.getSnapshot().state.plates[2].printable, true);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
});

test('reorders an exact plate-ID permutation as one reversible transaction', () => {
  const { project, selection, bus } = harness();
  const original = [...project.getSnapshot().state.plates]
    .sort((left, right) => left.order - right.order)
    .map((plate) => plate.id);
  const requested = [original[2]!, original[0]!, original[1]!];
  const selectionBefore = selection.getSnapshot();

  const mutableRequest = [...requested];
  const command = new ReorderPlatesCommand(mutableRequest);
  mutableRequest.reverse();
  bus.execute(command);
  assert.deepEqual(
    project.getSnapshot().state.plates.map((plate) => [plate.id, plate.order]),
    requested.map((id, order) => [id, order]),
  );
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.equal(bus.undo(), true);
  assert.deepEqual(
    [...project.getSnapshot().state.plates].sort((left, right) => left.order - right.order).map((plate) => plate.id),
    original,
  );
  assert.equal(bus.redo(), true);
  assert.deepEqual(
    project.getSnapshot().state.plates.map((plate) => plate.id),
    requested,
  );
});

test('suppresses exact plate no-ops and rejects malformed permutations atomically', () => {
  const { project, bus } = harness();
  const state = project.getSnapshot().state;
  const order = [...state.plates].sort((left, right) => left.order - right.order).map((plate) => plate.id);
  const before = canonicalStringify(state);

  bus.execute(new RenamePlateCommand(state.plates[0].id, state.plates[0].name));
  bus.execute(new SetPlatePrintableCommand(state.plates[0].id, state.plates[0].printable));
  bus.execute(new ReorderPlatesCommand(order));
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.throws(() => new ReorderPlatesCommand([order[0]!, order[0]!, order[2]!]), /duplicate IDs/);
  assert.throws(() => bus.execute(new ReorderPlatesCommand(order.slice(0, 2))), /every project plate/);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('duplicates a complete plate graph and scoped metadata as one exact undo/redo entry', () => {
  const { fixture, sourcePlateId, project, selection, assets, bus } = duplicateHarness();
  const before = canonicalStringify(project.getSnapshot().state);
  const beforeState = project.getSnapshot().state;
  const sourceBefore = canonicalStringify(beforeState.plates.find((plate) => plate.id === sourcePlateId));
  const sourceScopeBefore = canonicalStringify(plateScope(beforeState, sourcePlateId));
  const sourceAssetsBefore = canonicalStringify(beforeState.sourceAssets);
  const repositoryBefore = assets.capture();
  const activeBefore = beforeState.activePlateId;
  const selectionBefore = selection.getSnapshot();
  const ids = duplicatePlateIds(beforeState, sourcePlateId, 0xd001, true);
  const command = new DuplicatePlateCommand(sourcePlateId, ids, { name: 'Production copy' });

  bus.execute(command);
  const duplicatedState = project.getSnapshot().state;
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.deepEqual(
    duplicatedState.plates.map((plate) => [plate.id, plate.order]),
    [
      [beforeState.plates[0].id, 0],
      [sourcePlateId, 1],
      [ids.plateId, 2],
      [beforeState.plates[2].id, 3],
    ],
  );
  const source = duplicatedState.plates[1];
  const duplicate = duplicatedState.plates[2];
  assert.equal(duplicate.id, ids.plateId);
  assert.equal(duplicate.name, 'Production copy');
  assert.equal(duplicate.objects[0].id, ids.objects[0].objectId);
  assert.deepEqual(
    duplicate.objects[0].volumes.map((volume) => volume.id),
    ids.objects[0].volumeIds,
  );
  assert.deepEqual(
    duplicate.objects[0].instances.map((instance) => instance.id),
    ids.objects[0].instanceIds,
  );
  assert.deepEqual(
    duplicate.objects[0].layerRanges.map((range) => range.id),
    ids.objects[0].layerRangeIds,
  );
  assert.equal(duplicate.objects[0].volumes[0].source.assetId, source.objects[0].volumes[0].source.assetId);
  assert.deepEqual(duplicate.config, source.config);
  assert.deepEqual(duplicate.wipeTower, source.wipeTower);
  assert.deepEqual(duplicate.extensionData, source.extensionData);
  assert.equal(canonicalStringify(source), sourceBefore, 'source plate must remain byte-identical');
  assert.equal(canonicalStringify(plateScope(duplicatedState, sourcePlateId)), sourceScopeBefore);
  assert.equal(canonicalStringify(duplicatedState.sourceAssets), sourceAssetsBefore);
  assert.deepEqual(assets.capture(), repositoryBefore);
  assert.equal(duplicatedState.activePlateId, ids.plateId);
  assert.deepEqual(selection.getSnapshot(), {
    refs: [{ kind: 'plate', id: ids.plateId }],
    primary: { kind: 'plate', id: ids.plateId },
  });

  const sourceGcodeIndex = duplicatedState.customGcode.findIndex((entry) => entry.plateId === sourcePlateId);
  assert.deepEqual(duplicatedState.customGcode.slice(sourceGcodeIndex, sourceGcodeIndex + 2), [
    beforeState.customGcode.find((entry) => entry.plateId === sourcePlateId),
    {
      ...beforeState.customGcode.find((entry) => entry.plateId === sourcePlateId),
      id: ids.customGcodeIds![0],
      plateId: ids.plateId,
    },
  ]);
  const sourceThumbnailIndex = duplicatedState.thumbnails.findIndex((thumbnail) => thumbnail.plateId === sourcePlateId);
  assert.deepEqual(duplicatedState.thumbnails.slice(sourceThumbnailIndex, sourceThumbnailIndex + 2), [
    beforeState.thumbnails.find((thumbnail) => thumbnail.plateId === sourcePlateId),
    {
      ...beforeState.thumbnails.find((thumbnail) => thumbnail.plateId === sourcePlateId),
      id: ids.thumbnailIds![0],
      plateId: ids.plateId,
    },
  ]);
  assert.equal(duplicatedState.thumbnails[sourceThumbnailIndex + 1].assetId, fixture.ids.asset);
  const duplicated = canonicalStringify(duplicatedState);
  const duplicateSelection = selection.getSnapshot();

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(project.getSnapshot().state.activePlateId, activeBefore);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.deepEqual(assets.capture(), repositoryBefore);
  assert.deepEqual(plateScope(project.getSnapshot().state, sourcePlateId), plateScope(beforeState, sourcePlateId));
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(bus.getHistorySnapshot().redoCount, 1);

  assert.equal(bus.redo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), duplicated);
  assert.deepEqual(selection.getSnapshot(), duplicateSelection);
  assert.deepEqual(assets.capture(), repositoryBefore);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.equal(bus.getHistorySnapshot().redoCount, 0);
});

test('supports intentionally omitting per-plate metadata clones', () => {
  const { sourcePlateId, project, bus } = duplicateHarness();
  const before = project.getSnapshot().state;
  const customGcodeBefore = canonicalStringify(before.customGcode);
  const thumbnailsBefore = canonicalStringify(before.thumbnails);
  const ids = duplicatePlateIds(before, sourcePlateId, 0xd002, false);

  bus.execute(new DuplicatePlateCommand(sourcePlateId, ids));
  const after = project.getSnapshot().state;
  assert.equal(canonicalStringify(after.customGcode), customGcodeBefore);
  assert.equal(canonicalStringify(after.thumbnails), thumbnailsBefore);
  assert.equal(after.plates.find((plate) => plate.id === ids.plateId)?.name, 'Source plate copy');
});

test('rejects unstable, colliding, internally duplicated, and malformed duplicate plans atomically', () => {
  const cases: readonly {
    readonly label: string;
    readonly pattern: RegExp;
    readonly command: (harness: ReturnType<typeof duplicateHarness>, ids: DuplicatePlateIds) => DuplicatePlateCommand;
  }[] = [
    {
      label: 'existing canonical ID',
      pattern: /already exists in the project/,
      command: ({ fixture, sourcePlateId }, ids) =>
        new DuplicatePlateCommand(sourcePlateId, {
          ...ids,
          plateId: fixture.ids.asset as unknown as typeof ids.plateId,
        }),
    },
    {
      label: 'internally repeated ID',
      pattern: /duplicated within the plate duplicate/,
      command: ({ sourcePlateId }, ids) =>
        new DuplicatePlateCommand(sourcePlateId, {
          ...ids,
          objects: ids.objects.map((object, index) =>
            index === 0 ? { ...object, objectId: ids.plateId as unknown as typeof object.objectId } : object,
          ),
        }),
    },
    {
      label: 'unstable ID',
      pattern: /is not stable/,
      command: ({ sourcePlateId }, ids) =>
        new DuplicatePlateCommand(sourcePlateId, { ...ids, plateId: 'plain-id' as typeof ids.plateId }),
    },
    {
      label: 'missing object mapping',
      pattern: /object mappings.*requires 1/,
      command: ({ sourcePlateId }, ids) => new DuplicatePlateCommand(sourcePlateId, { ...ids, objects: [] }),
    },
    {
      label: 'wrong volume topology',
      pattern: /0 volume IDs.*requires 1/,
      command: ({ sourcePlateId }, ids) =>
        new DuplicatePlateCommand(sourcePlateId, {
          ...ids,
          objects: ids.objects.map((object) => ({ ...object, volumeIds: [] })),
        }),
    },
    {
      label: 'incomplete custom G-code IDs',
      pattern: /0 custom G-code IDs.*requires 1/,
      command: ({ sourcePlateId }, ids) => new DuplicatePlateCommand(sourcePlateId, { ...ids, customGcodeIds: [] }),
    },
    {
      label: 'incomplete thumbnail IDs',
      pattern: /0 thumbnail IDs.*requires 1/,
      command: ({ sourcePlateId }, ids) => new DuplicatePlateCommand(sourcePlateId, { ...ids, thumbnailIds: [] }),
    },
    {
      label: 'unknown source',
      pattern: /Unknown plate/,
      command: ({ ids: source, sourcePlateId }, ids) => {
        void sourcePlateId;
        return new DuplicatePlateCommand(source.next('plate'), ids);
      },
    },
  ];

  for (const candidate of cases) {
    const current = duplicateHarness();
    const state = current.project.getSnapshot().state;
    const ids = duplicatePlateIds(state, current.sourcePlateId, 0xd100, true);
    const before = canonicalStringify(state);
    const selectionBefore = current.selection.getSnapshot();
    const assetsBefore = current.assets.capture();
    assert.throws(() => current.bus.execute(candidate.command(current, ids)), candidate.pattern, candidate.label);
    assert.equal(canonicalStringify(current.project.getSnapshot().state), before, candidate.label);
    assert.deepEqual(current.selection.getSnapshot(), selectionBefore, candidate.label);
    assert.deepEqual(current.assets.capture(), assetsBefore, candidate.label);
    assert.equal(current.bus.getHistorySnapshot().undoCount, 0, candidate.label);
  }

  const malformed = duplicateHarness({ sourceName: '   ' });
  const malformedState = malformed.project.getSnapshot().state;
  const malformedIds = duplicatePlateIds(malformedState, malformed.sourcePlateId, 0xd200, true);
  const malformedBefore = canonicalStringify(malformedState);
  assert.throws(
    () => malformed.bus.execute(new DuplicatePlateCommand(malformed.sourcePlateId, malformedIds)),
    /empty name.*cannot be duplicated/,
  );
  assert.equal(canonicalStringify(malformed.project.getSnapshot().state), malformedBefore);
  assert.equal(malformed.bus.getHistorySnapshot().undoCount, 0);
  assert.throws(
    () => new DuplicatePlateCommand(malformed.sourcePlateId, malformedIds, { name: '   ' }),
    /name cannot be empty/,
  );
});

test('enforces the pinned 36-plate ceiling below presentation surfaces', () => {
  const { project, ids, bus } = harness(MAX_PROJECT_PLATES);
  const before = canonicalStringify(project.getSnapshot().state);
  const overflow = emptyPlate(ids, MAX_PROJECT_PLATES);

  assert.throws(() => bus.execute(new AddPlateCommand(overflow)), /more than 36 plates/);
  assert.throws(
    () =>
      bus.execute(
        new DuplicatePlateCommand(project.getSnapshot().state.activePlateId, {
          plateId: ids.next('plate'),
          objects: [],
        }),
      ),
    /more than 36 plates/,
  );
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('SetPlateWipeTowerCommand updates, reverts, and detects no-ops', () => {
  const { project, bus } = harness(1);
  const plateId = project.getSnapshot().state.activePlateId;
  const initial = project.getSnapshot().state.plates[0].wipeTower;
  assert.equal(initial, undefined);

  // Set wipe tower
  const targetTower = {
    enabled: true,
    positionMm: [180, 40] as const,
    rotationDeg: 0,
  };
  const command = new SetPlateWipeTowerCommand(plateId, targetTower);
  assert.equal(
    command.isNoop({ project, assets: new InMemoryAssetRepository(), selection: new SelectionStore() }),
    false,
  );
  bus.execute(command);

  assert.deepEqual(project.getSnapshot().state.plates[0].wipeTower, targetTower);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  // No-op detection
  const sameCommand = new SetPlateWipeTowerCommand(plateId, targetTower);
  assert.equal(
    sameCommand.isNoop({ project, assets: new InMemoryAssetRepository(), selection: new SelectionStore() }),
    true,
  );
  bus.execute(sameCommand);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  // Undo restores undefined
  bus.undo();
  assert.equal(project.getSnapshot().state.plates[0].wipeTower, undefined);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(bus.getHistorySnapshot().redoCount, 1);

  // Redo restores targetTower
  bus.redo();
  assert.deepEqual(project.getSnapshot().state.plates[0].wipeTower, targetTower);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  // Clear wipe tower
  bus.execute(new SetPlateWipeTowerCommand(plateId, undefined));
  assert.equal(project.getSnapshot().state.plates[0].wipeTower, undefined);
  assert.equal(bus.getHistorySnapshot().undoCount, 2);

  // Undo restores targetTower
  bus.undo();
  assert.deepEqual(project.getSnapshot().state.plates[0].wipeTower, targetTower);
});

function duplicateHarness(options: { sourceName?: string } = {}) {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const ids = new UuidIdSource(seededRandom(0xd00d));
  const source = state.plates[0];
  const leading = emptyPlate(ids, 0);
  const trailing = emptyPlate(ids, 2);
  source.name = options.sourceName ?? 'Source plate';
  source.order = 1;
  source.config = { ...source.config, print_sequence: 'by-object' };
  source.wipeTower = {
    enabled: true,
    positionMm: [170, 25],
    rotationDeg: 15,
    filamentId: fixture.ids.physical0,
  };
  source.extensionData = { vendor_plate: { safe_zone: [2, 3, 4] } };
  source.objects[0].extensionData = { object_private: 'retained' };
  source.objects[0].volumes[0].extensionData = { volume_private: true };
  source.objects[0].instances[0].extensionData = { instance_private: 7 };
  state.plates = [leading, source, trailing];
  state.activePlateId = leading.id;
  state.customGcode = [
    {
      id: ids.next('custom-gcode'),
      scope: 'project',
      trigger: 'tool-change',
      code: 'M117 project',
    },
    {
      id: ids.next('custom-gcode'),
      scope: 'plate',
      plateId: source.id,
      trigger: 'before-plate',
      code: 'M117 source',
    },
    {
      id: ids.next('custom-gcode'),
      scope: 'plate',
      plateId: trailing.id,
      trigger: 'after-plate',
      code: 'M117 trailing',
    },
  ];
  state.thumbnails = [
    {
      id: ids.next('thumbnail'),
      assetId: fixture.ids.asset,
      width: 24,
      height: 24,
    },
    {
      id: ids.next('thumbnail'),
      assetId: fixture.ids.asset,
      plateId: source.id,
      width: 64,
      height: 64,
    },
    {
      id: ids.next('thumbnail'),
      assetId: fixture.ids.asset,
      plateId: trailing.id,
      width: 32,
      height: 32,
    },
  ];
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, sourcePlateId: source.id, ids, project, selection, assets, bus };
}

function duplicatePlateIds(
  state: ProjectState,
  sourcePlateId: ProjectState['activePlateId'],
  seed: number,
  includeScopedMetadata: boolean,
): DuplicatePlateIds {
  const source = state.plates.find((plate) => plate.id === sourcePlateId)!;
  const ids = new UuidIdSource(seededRandom(seed));
  return {
    plateId: ids.next('plate'),
    objects: source.objects.map((object) => ({
      objectId: ids.next('object'),
      volumeIds: object.volumes.map(() => ids.next('volume')),
      instanceIds: object.instances.map(() => ids.next('instance')),
      layerRangeIds: object.layerRanges.map(() => ids.next('layer-range')),
    })),
    ...(includeScopedMetadata
      ? {
          customGcodeIds: state.customGcode
            .filter((entry) => entry.scope === 'plate' && entry.plateId === sourcePlateId)
            .map(() => ids.next('custom-gcode')),
          thumbnailIds: state.thumbnails
            .filter((thumbnail) => thumbnail.plateId === sourcePlateId)
            .map(() => ids.next('thumbnail')),
        }
      : {}),
  };
}

function plateScope(state: ProjectState, plateId: ProjectState['activePlateId']) {
  return {
    customGcode: state.customGcode.filter((entry) => entry.scope === 'plate' && entry.plateId === plateId),
    thumbnails: state.thumbnails.filter((thumbnail) => thumbnail.plateId === plateId),
  };
}

function emptyPlate(ids: UuidIdSource, order: number): ProjectPlate {
  return {
    id: ids.next('plate'),
    name: `Plate ${order + 1}`,
    order,
    printable: true,
    config: {},
    objects: [],
  };
}

console.log(`\nPlate lifecycle commands: ${passed} tests passed.`);
