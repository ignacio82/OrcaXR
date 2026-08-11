import assert from 'node:assert/strict';
import {
  AddLayerRangeCommand,
  Bbs3mfProjectSerializer,
  CommandBus,
  ConvertVolumeRoleCommand,
  DeleteLayerRangeCommand,
  EditLayerRangeBoundsCommand,
  InMemoryAssetRepository,
  MergeLayerRangesCommand,
  ORCAXR_EXTENSION_PATH,
  ProjectStore,
  SelectionStore,
  SplitLayerRangeCommand,
  VolumeRoleConversionError,
  canonicalStringify,
  cloneJson,
  cloneProjectState,
  emptyFacetAnnotations,
  entityId,
  inspectVolumeRoleConversion,
  projectFingerprint,
  readSafeZip,
  validateProjectState,
  writeDeterministicZip,
  type ConfigMap,
  type LayerRange,
  type LayerRangeBoundsPatch,
  type LayerRangeId,
  type ProjectState,
  type ProjectVolume,
  type VolumeId,
  type VolumeRole,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(mutate?: (state: ProjectState) => void) {
  const fixture = createProjectFixture();
  const initial = cloneProjectState(fixture.state);
  mutate?.(initial);
  const project = new ProjectStore(initial);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, initial, project, selection, assets, bus };
}

function projectBytes(project: ProjectStore): string {
  return canonicalStringify(project.getSnapshot().state);
}

function volumeFrom(template: ProjectVolume, id: VolumeId, role: VolumeRole, name: string = role): ProjectVolume {
  const volume = cloneJson(template);
  volume.id = id;
  volume.name = name;
  volume.role = role;
  volume.config = { role_marker: role };
  volume.annotations = emptyFacetAnnotations(template.source.topologyRevision);
  delete volume.filamentId;
  return volume;
}

function range(
  id: LayerRangeId,
  minZMm: number,
  maxZMm: number,
  config: ConfigMap = { layer_height: 0.16 },
): LayerRange {
  return { id, minZMm, maxZMm, config: cloneJson(config) };
}

await test('converts all supported volume roles in stable engine order with exact undo and redo', () => {
  const ids = {
    converted: entityId<'volume'>('import:test:semantic-converted'),
    negative: entityId<'volume'>('import:test:semantic-negative'),
    modifier: entityId<'volume'>('import:test:semantic-modifier'),
    blocker: entityId<'volume'>('import:test:semantic-blocker'),
    enforcer: entityId<'volume'>('import:test:semantic-enforcer'),
  };
  const { fixture, project, selection, bus } = harness((state) => {
    const object = state.plates[0].objects[0];
    const model = object.volumes[0];
    model.annotations = emptyFacetAnnotations(0);
    object.volumes = [
      volumeFrom(model, ids.enforcer, 'support-enforcer'),
      model,
      volumeFrom(model, ids.converted, 'model', 'Convertible'),
      volumeFrom(model, ids.negative, 'negative-volume'),
      volumeFrom(model, ids.modifier, 'parameter-modifier'),
      volumeFrom(model, ids.blocker, 'support-blocker'),
    ];
  });
  selection.set([{ kind: 'volume', id: ids.converted }]);
  const before = projectBytes(project);
  const beforeSelection = selection.getSnapshot();

  bus.execute(new ConvertVolumeRoleCommand(ids.converted, 'support-blocker'));
  const object = project.getSnapshot().state.plates[0].objects[0];
  assert.deepEqual(
    object.volumes.map((volume) => volume.role),
    ['model', 'negative-volume', 'parameter-modifier', 'support-blocker', 'support-blocker', 'support-enforcer'],
  );
  assert.deepEqual(
    object.volumes.map((volume) => volume.id),
    [fixture.ids.volume, ids.negative, ids.modifier, ids.converted, ids.blocker, ids.enforcer],
  );
  const converted = object.volumes.find((volume) => volume.id === ids.converted)!;
  assert.equal(converted.config.role_marker, 'model');
  assert.deepEqual(selection.getSnapshot(), beforeSelection);
  const after = projectBytes(project);
  const revisionAfter = project.getSnapshot().revision;

  bus.execute(new ConvertVolumeRoleCommand(ids.converted, 'support-blocker'));
  assert.equal(project.getSnapshot().revision, revisionAfter);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);

  assert.equal(bus.undo(), true);
  assert.equal(projectBytes(project), before);
  assert.deepEqual(selection.getSnapshot(), beforeSelection);
  assert.equal(bus.redo(), true);
  assert.equal(projectBytes(project), after);
  assert.deepEqual(selection.getSnapshot(), beforeSelection);
});

await test('explains and atomically rejects lossy or engine-invalid role conversions', () => {
  const lastModelHarness = harness();
  const { fixture } = lastModelHarness;
  const before = projectBytes(lastModelHarness.project);
  assert.deepEqual(
    inspectVolumeRoleConversion(lastModelHarness.project.getSnapshot().state, fixture.ids.volume, 'negative-volume'),
    {
      allowed: false,
      code: 'last-model-volume',
      reason: 'The last model part on an object cannot be converted to a non-model role',
    },
  );
  assert.throws(
    () => lastModelHarness.bus.execute(new ConvertVolumeRoleCommand(fixture.ids.volume, 'negative-volume')),
    (error) => error instanceof VolumeRoleConversionError && error.code === 'last-model-volume',
  );
  assert.equal(projectBytes(lastModelHarness.project), before);
  assert.equal(lastModelHarness.bus.getHistorySnapshot().undoCount, 0);

  const secondModelId = entityId<'volume'>('import:test:semantic-second-model');
  const paintedHarness = harness((state) => {
    const object = state.plates[0].objects[0];
    object.volumes[0].annotations.color = [];
    object.volumes[0].annotations.refinement = {
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
                { kind: 'leaf', state: { kind: 'assigned', value: state.filaments.physical[0].id } },
                { kind: 'leaf', state: { kind: 'assigned', value: state.filaments.physical[1].id } },
              ],
            },
          },
        ],
      },
    };
    object.volumes.push(volumeFrom(object.volumes[0], secondModelId, 'model'));
    object.volumes[1].annotations = emptyFacetAnnotations(0);
  });
  const paintedBefore = projectBytes(paintedHarness.project);
  assert.throws(
    () =>
      paintedHarness.bus.execute(new ConvertVolumeRoleCommand(paintedHarness.fixture.ids.volume, 'parameter-modifier')),
    (error) => error instanceof VolumeRoleConversionError && error.code === 'facet-annotations',
  );
  assert.equal(projectBytes(paintedHarness.project), paintedBefore);

  const assignedHarness = harness((state) => {
    const object = state.plates[0].objects[0];
    object.volumes[0].annotations = emptyFacetAnnotations(0);
    object.volumes[0].filamentId = state.filaments.physical[1].id;
    object.volumes.push(volumeFrom(object.volumes[0], secondModelId, 'model'));
  });
  assert.throws(
    () =>
      assignedHarness.bus.execute(new ConvertVolumeRoleCommand(assignedHarness.fixture.ids.volume, 'support-enforcer')),
    (error) => error instanceof VolumeRoleConversionError && error.code === 'filament-assignment',
  );
  assignedHarness.bus.execute(new ConvertVolumeRoleCommand(assignedHarness.fixture.ids.volume, 'parameter-modifier'));
  const modifier = assignedHarness.project
    .getSnapshot()
    .state.plates[0].objects[0].volumes.find((volume) => volume.id === assignedHarness.fixture.ids.volume)!;
  assert.equal(modifier.filamentId, assignedHarness.fixture.ids.physical1);

  const unsupported = inspectVolumeRoleConversion(
    assignedHarness.project.getSnapshot().state,
    assignedHarness.fixture.ids.volume,
    'auxiliary-volume',
  );
  assert.equal(unsupported.allowed, false);
  if (!unsupported.allowed) assert.equal(unsupported.code, 'unsupported-role');
  assert.throws(
    () => new ConvertVolumeRoleCommand(assignedHarness.fixture.ids.volume, 'auxiliary-volume' as VolumeRole),
    (error) => error instanceof VolumeRoleConversionError && error.code === 'unsupported-role',
  );

  const invalidState = cloneProjectState(assignedHarness.project.getSnapshot().state);
  invalidState.plates[0].objects[0].volumes[0].role = 'auxiliary-volume' as VolumeRole;
  assert.ok(validateProjectState(invalidState).some((issue) => issue.code === 'unsupported-volume-role'));
  assert.throws(() => new ProjectStore(invalidState), /Invalid project state/);
});

await test('adds, edits, and deletes sorted non-overlapping ranges with real no-ops and exact history', () => {
  const gapId = entityId<'layer-range'>('import:test:layer-gap');
  const touchingId = entityId<'layer-range'>('import:test:layer-touching');
  const overlapId = entityId<'layer-range'>('import:test:layer-overlap');
  const { fixture, project, selection, bus } = harness();
  selection.set([{ kind: 'layer-range', id: fixture.ids.range }]);
  const original = projectBytes(project);
  const originalSelection = selection.getSnapshot();

  bus.execute(new AddLayerRangeCommand(fixture.ids.object, range(gapId, 7, 10)));
  assert.deepEqual(
    project.getSnapshot().state.plates[0].objects[0].layerRanges.map((entry) => [entry.minZMm, entry.maxZMm]),
    [
      [0, 5],
      [7, 10],
    ],
  );
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: gapId });
  const afterGap = projectBytes(project);
  bus.undo();
  assert.equal(projectBytes(project), original);
  assert.deepEqual(selection.getSnapshot(), originalSelection);
  bus.redo();
  assert.equal(projectBytes(project), afterGap);

  bus.execute(new AddLayerRangeCommand(fixture.ids.object, range(touchingId, 5, 7)));
  const historyBeforeNoop = bus.getHistorySnapshot().undoCount;
  const revisionBeforeNoop = project.getSnapshot().revision;
  bus.execute(new EditLayerRangeBoundsCommand(fixture.ids.object, touchingId, { minZMm: 5, maxZMm: 7 }));
  assert.equal(bus.getHistorySnapshot().undoCount, historyBeforeNoop);
  assert.equal(project.getSnapshot().revision, revisionBeforeNoop);

  const beforeRejected = projectBytes(project);
  assert.throws(() => bus.execute(new AddLayerRangeCommand(fixture.ids.object, range(overlapId, 4.5, 6))), /overlaps/);
  assert.throws(
    () => bus.execute(new EditLayerRangeBoundsCommand(fixture.ids.object, touchingId, { minZMm: 4.5 })),
    /overlaps/,
  );
  assert.equal(projectBytes(project), beforeRejected);
  assert.equal(bus.getHistorySnapshot().undoCount, historyBeforeNoop);

  bus.execute(new EditLayerRangeBoundsCommand(fixture.ids.object, gapId, { minZMm: 8 }));
  assert.deepEqual(
    project.getSnapshot().state.plates[0].objects[0].layerRanges.map((entry) => [entry.minZMm, entry.maxZMm]),
    [
      [0, 5],
      [5, 7],
      [8, 10],
    ],
  );
  selection.set([{ kind: 'layer-range', id: touchingId }]);
  bus.execute(new DeleteLayerRangeCommand(fixture.ids.object, touchingId));
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: gapId });
  const deleted = projectBytes(project);
  bus.undo();
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: touchingId });
  bus.redo();
  assert.equal(projectBytes(project), deleted);
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: gapId });
});

await test('splits and losslessly merges touching equal ranges while retaining stable identity', () => {
  const upperId = entityId<'layer-range'>('import:test:layer-split-upper');
  const invalidId = entityId<'layer-range'>('import:test:layer-split-invalid');
  const { fixture, project, selection, bus } = harness((state) => {
    state.plates[0].objects[0].layerRanges[0].filamentId = state.filaments.physical[1].id;
  });
  selection.set([{ kind: 'layer-range', id: fixture.ids.range }]);
  const original = projectBytes(project);
  const originalSelection = selection.getSnapshot();

  bus.execute(new SplitLayerRangeCommand(fixture.ids.object, fixture.ids.range, 2.5, upperId));
  const ranges = project.getSnapshot().state.plates[0].objects[0].layerRanges;
  assert.deepEqual(
    ranges.map((entry) => [entry.id, entry.minZMm, entry.maxZMm]),
    [
      [fixture.ids.range, 0, 2.5],
      [upperId, 2.5, 5],
    ],
  );
  assert.deepEqual(ranges[0].config, ranges[1].config);
  assert.equal(ranges[1].filamentId, fixture.ids.physical1);
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: upperId });
  const split = projectBytes(project);

  assert.throws(
    () => bus.execute(new SplitLayerRangeCommand(fixture.ids.object, upperId, 5, invalidId)),
    /strictly inside/,
  );
  assert.throws(
    () =>
      bus.execute(
        new SplitLayerRangeCommand(fixture.ids.object, upperId, 3, fixture.ids.volume as unknown as LayerRangeId),
      ),
    /already exists/,
  );
  assert.equal(projectBytes(project), split);

  bus.execute(new MergeLayerRangesCommand(fixture.ids.object, upperId, fixture.ids.range));
  const mergedRanges = project.getSnapshot().state.plates[0].objects[0].layerRanges;
  assert.deepEqual(
    mergedRanges.map((entry) => [entry.id, entry.minZMm, entry.maxZMm]),
    [[fixture.ids.range, 0, 5]],
  );
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: fixture.ids.range });
  const merged = projectBytes(project);

  bus.undo();
  assert.equal(projectBytes(project), split);
  assert.deepEqual(selection.getSnapshot().primary, { kind: 'layer-range', id: upperId });
  bus.redo();
  assert.equal(projectBytes(project), merged);
  bus.undo();
  bus.undo();
  assert.equal(projectBytes(project), original);
  assert.deepEqual(selection.getSnapshot(), originalSelection);
  bus.redo();
  bus.redo();
  assert.equal(projectBytes(project), merged);
});

await test('rejects ambiguous range merges and settings bypasses without changing canonical bytes', () => {
  const upperId = entityId<'layer-range'>('import:test:layer-conflict-upper');
  const { fixture, project, bus } = harness((state) => {
    state.plates[0].objects[0].layerRanges.push(range(upperId, 5, 8, { layer_height: 0.2 }));
  });
  const before = projectBytes(project);
  assert.throws(
    () => bus.execute(new MergeLayerRangesCommand(fixture.ids.object, fixture.ids.range, upperId)),
    /different settings/,
  );
  assert.equal(projectBytes(project), before);
  assert.throws(
    () =>
      new EditLayerRangeBoundsCommand(fixture.ids.object, fixture.ids.range, {
        config: {},
      } as unknown as LayerRangeBoundsPatch),
    /does not support fields: config/,
  );
  assert.throws(
    () =>
      bus.execute(
        new EditLayerRangeBoundsCommand(fixture.ids.object, fixture.ids.range, {
          minZMm: null,
        } as unknown as LayerRangeBoundsPatch),
      ),
    /finite bounds/,
  );
  assert.equal(projectBytes(project), before);

  const gapId = entityId<'layer-range'>('import:test:layer-merge-gap');
  const gapHarness = harness((state) => {
    state.plates[0].objects[0].layerRanges.push(
      range(gapId, 6, 8, cloneJson(state.plates[0].objects[0].layerRanges[0].config)),
    );
  });
  const gapBefore = projectBytes(gapHarness.project);
  assert.throws(
    () =>
      gapHarness.bus.execute(
        new MergeLayerRangesCommand(gapHarness.fixture.ids.object, gapHarness.fixture.ids.range, gapId),
      ),
    /touch without a gap/,
  );
  assert.equal(projectBytes(gapHarness.project), gapBefore);
});

await test('projects every role and non-overlapping range through standard BBS 3MF metadata', async () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const object = state.plates[0].objects[0];
  const model = object.volumes[0];
  model.annotations = emptyFacetAnnotations(0);
  object.volumes = [
    model,
    volumeFrom(model, entityId<'volume'>('import:test:roundtrip-negative'), 'negative-volume'),
    volumeFrom(model, entityId<'volume'>('import:test:roundtrip-modifier'), 'parameter-modifier'),
    volumeFrom(model, entityId<'volume'>('import:test:roundtrip-blocker'), 'support-blocker'),
    volumeFrom(model, entityId<'volume'>('import:test:roundtrip-enforcer'), 'support-enforcer'),
  ];
  object.layerRanges.push(
    range(entityId<'layer-range'>('import:test:roundtrip-range'), 5, 9, { layer_height: 0.18, wall_loops: 4 }),
  );
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state,
    assets: [fixture.asset],
    sourceRevision: 1,
    sourceHash: projectFingerprint(state),
  });
  const standardOnly = readSafeZip(saved.bytes);
  standardOnly.delete(ORCAXR_EXTENSION_PATH);
  const reopened = await serializer.deserialize(writeDeterministicZip(standardOnly));
  const reopenedObject = reopened.state.plates[0].objects[0];
  assert.deepEqual(
    reopenedObject.volumes.map((volume) => volume.role),
    ['model', 'negative-volume', 'parameter-modifier', 'support-blocker', 'support-enforcer'],
  );
  assert.deepEqual(
    reopenedObject.layerRanges.map((entry) => [entry.minZMm, entry.maxZMm, entry.config]),
    [
      [0, 5, { layer_height: 0.12 }],
      [5, 9, { layer_height: 0.18, wall_loops: 4 }],
    ],
  );
});

console.log(`\nSemantic volume/layer-range commands: ${passed} tests passed.`);
