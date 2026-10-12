import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../../assets';
import { canonicalStringify } from '../../domain/canonical';
import { entityId, seededRandom, UuidIdSource } from '../../domain/ids';
import { createEmptyProject, emptyFacetAnnotations, identityTransform, type ProjectState } from '../../domain/model';
import { validateProjectState } from '../../domain/validation';
import { CommandBus } from '../../history/commandBus';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { SelectionStore } from '../../selection';
import {
  BRIM_EAR_POINTS_FORMAT_VERSION,
  BRIM_EAR_POINTS_PATH,
  decodeBrimEarPoints,
  encodeBrimEarPoints,
} from '../../serialization/brimEarPoints';
import { ProjectStore } from '../../store';
import {
  AddBrimEarCommand,
  BRIM_EAR_MAX_RADIUS_MM,
  BRIM_EAR_MIN_RADIUS_MM,
  BrimEarError,
  ClearBrimEarsCommand,
  RemoveBrimEarCommand,
} from '../brimEarCommands';
import { BrimEarRefusal, objectBrimEarView, objectModelBaseZ } from '../brimEarExchange';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const ids = new UuidIdSource(seededRandom(0x8e42));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-09T00:00:00.000Z', toolCount: 1 });
  const asset = encodeIndexedMeshAsset({
    id: ids.next('asset'),
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0],
    indices: [0, 1, 2],
    sourceFilename: 'tri.stl',
  });
  const objectId = ids.next('object');
  state.sourceAssets.push(asset.descriptor);
  state.plates[0].objects.push({
    id: objectId,
    name: 'Part',
    config: {},
    volumes: [
      {
        id: ids.next('volume'),
        name: 'Body',
        role: 'model',
        source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 1 },
        transform: identityTransform(),
        config: {},
        annotations: emptyFacetAnnotations(),
      },
    ],
    instances: [{ id: ids.next('instance'), transform: identityTransform(), printable: true }],
    layerRanges: [],
  });
  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection: new SelectionStore(), assets });
  commands.markCheckpoint();
  return { project, commands, objectId, assets };
}

const ears = (h: ReturnType<typeof harness>) => h.project.getSnapshot().state.plates[0].objects[0].brimEars;

test('encodes exactly the pinned brim-ear text', () => {
  assert.equal(BRIM_EAR_POINTS_PATH, 'Metadata/brim_ear_points.txt');
  assert.equal(BRIM_EAR_POINTS_FORMAT_VERSION, 0);

  const text = encodeBrimEarPoints([
    {
      objectId: 1,
      points: [
        { positionMm: [1, 2, 0], headFrontRadiusMm: 5 },
        { positionMm: [-3.5, 4.25, 0], headFrontRadiusMm: 2.5 },
      ],
    },
    { objectId: 2, points: [] },
    { objectId: 3, points: [{ positionMm: [0, 0, 0], headFrontRadiusMm: 1 }] },
  ]);
  assert.equal(
    text,
    'brim_points_format_version=0\n' +
      'object_id=1|1.000000 2.000000 0.000000 5.000000 -3.500000 4.250000 0.000000 2.500000\n' +
      'object_id=3|0.000000 0.000000 0.000000 1.000000\n',
    'six decimals and a space-separated run, exactly as the pinned sprintf writes it',
  );
  assert.equal(encodeBrimEarPoints([{ objectId: 1, points: [] }]), undefined, 'no ears means no file at all');
});

test('round-trips through the pinned decoder', () => {
  const objects = [
    {
      objectId: 1,
      points: [
        { positionMm: [1.5, -2.25, 0] as [number, number, number], headFrontRadiusMm: 4 },
        { positionMm: [7, 8, 0] as [number, number, number], headFrontRadiusMm: 0.5 },
      ],
    },
  ];
  const decoded = decodeBrimEarPoints(encodeBrimEarPoints(objects) as string);
  assert.equal(decoded.version, 0);
  assert.deepEqual(decoded.warnings, []);
  assert.deepEqual(decoded.objects, objects);
});

test('malformed lines are reported, not silently dropped', () => {
  const decoded = decodeBrimEarPoints(
    [
      'brim_points_format_version=0',
      'object_id=1|0.000000 0.000000 0.000000 1.000000',
      'no-pipe-here',
      'objectid1|0 0 0 1',
      'object_id=0|0 0 0 1',
      'object_id=1|9 9 9 9',
      'object_id=4|0 0 0 1 5 5',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    decoded.objects.map((entry) => entry.objectId),
    [1, 4],
  );
  const joined = decoded.warnings.join(' | ');
  assert.match(joined, /Error while reading object data/);
  assert.match(joined, /Error while reading object id/);
  assert.match(joined, /Found invalid object id/);
  assert.match(joined, /duplicated brim ear points for object 1/);
  assert.match(joined, /trailing brim-ear value/);
  // The complete point on the trailing-values line still survives.
  assert.deepEqual(decoded.objects[1].points, [{ positionMm: [0, 0, 0], headFrontRadiusMm: 1 }]);
});

test('a future format version is reported rather than guessed at', () => {
  const decoded = decodeBrimEarPoints('brim_points_format_version=7\nobject_id=1|0 0 0 1\n');
  assert.equal(decoded.version, 7);
  assert.deepEqual(decoded.objects, []);
  assert.match(decoded.warnings.join(' '), /Unsupported brim_points_format_version 7/);
});

test('placing, removing, and clearing ears each undo exactly', () => {
  const h = harness();
  const before = canonicalStringify(h.project.getSnapshot().state as never);

  h.commands.execute(new AddBrimEarCommand(h.objectId, { positionMm: [1, 1, 0], headFrontRadiusMm: 5 }));
  h.commands.execute(new AddBrimEarCommand(h.objectId, { positionMm: [2, 2, 0], headFrontRadiusMm: 3 }));
  assert.equal(ears(h)?.length, 2);
  assert.deepEqual(validateProjectState(h.project.getSnapshot().state), []);

  h.commands.execute(new RemoveBrimEarCommand(h.objectId, 0));
  assert.deepEqual(ears(h), [{ positionMm: [2, 2, 0], headFrontRadiusMm: 3 }]);
  assert.equal(h.commands.undo(), true);
  assert.deepEqual(
    ears(h),
    [
      { positionMm: [1, 1, 0], headFrontRadiusMm: 5 },
      { positionMm: [2, 2, 0], headFrontRadiusMm: 3 },
    ],
    'a removed ear comes back at its original index',
  );

  h.commands.execute(new ClearBrimEarsCommand(h.objectId));
  assert.equal(ears(h), undefined, 'clearing removes the field entirely');
  assert.equal(h.commands.undo(), true);
  assert.equal(ears(h)?.length, 2);

  while (h.commands.undo());
  assert.equal(
    canonicalStringify(h.project.getSnapshot().state as never),
    before,
    'unwinding every command restores the exact project',
  );
});

test('impossible ears and unknown targets fail closed', () => {
  const h = harness();
  for (const radius of [0, -1, BRIM_EAR_MIN_RADIUS_MM / 2, BRIM_EAR_MAX_RADIUS_MM + 1, Number.NaN]) {
    assert.throws(
      () => new AddBrimEarCommand(h.objectId, { positionMm: [0, 0, 0], headFrontRadiusMm: radius }),
      (error: unknown) => error instanceof BrimEarError && error.code === 'invalid-point',
      `radius ${radius} must be refused`,
    );
  }
  assert.throws(
    () => new AddBrimEarCommand(h.objectId, { positionMm: [0, Number.POSITIVE_INFINITY, 0], headFrontRadiusMm: 1 }),
    (error: unknown) => error instanceof BrimEarError && error.code === 'invalid-point',
  );
  assert.throws(
    () => new RemoveBrimEarCommand(h.objectId, -1),
    (error: unknown) => error instanceof BrimEarError && error.code === 'unknown-ear',
  );
  assert.throws(
    () => h.commands.execute(new RemoveBrimEarCommand(h.objectId, 3)),
    (error: unknown) => error instanceof BrimEarError && error.code === 'unknown-ear',
  );
});

test('an out-of-range ear is caught by canonical validation too', () => {
  const h = harness();
  h.commands.execute(new AddBrimEarCommand(h.objectId, { positionMm: [1, 1, 0], headFrontRadiusMm: 5 }));
  const state = h.project.getSnapshot().state;
  const mutated = JSON.parse(JSON.stringify(state)) as ProjectState;
  mutated.plates[0].objects[0].brimEars = [{ positionMm: [0, 0, 0], headFrontRadiusMm: 0 }];
  const issues = validateProjectState(mutated);
  assert.equal(
    issues.some((issue) => issue.code === 'invalid-brim-ear'),
    true,
  );
});

test('an object’s view lists its ears, the stranded ones and the base an ear sits on', () => {
  const h = harness();
  const view = () => objectBrimEarView(h.project.getSnapshot().state, h.assets, h.objectId);
  assert.deepEqual(view(), { ears: [], stranded: [], baseZMm: 0 });
  h.commands.execute(new AddBrimEarCommand(h.objectId, { positionMm: [1, 1, 0], headFrontRadiusMm: 2 }));
  h.commands.execute(new AddBrimEarCommand(h.objectId, { positionMm: [90, 90, 0], headFrontRadiusMm: 2 }));
  // A flat part has no first layer to reach, so nothing is called stranded.
  assert.deepEqual(view(), {
    ears: [
      { positionMm: [1, 1, 0], headFrontRadiusMm: 2 },
      { positionMm: [90, 90, 0], headFrontRadiusMm: 2 },
    ],
    stranded: [],
    baseZMm: 0,
  });
  // A part with height: the far ear reaches nothing.
  const state = structuredClone(h.project.getSnapshot().state);
  const cube = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:asset:brim-view-cube'),
    positions: [0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 10, 2, 0, 0, 12, 10, 0, 12, 10, 10, 12, 0, 10, 12],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  });
  h.assets.put(cube.descriptor, cube.bytes);
  state.sourceAssets.push(cube.descriptor);
  state.plates[0].objects[0].volumes[0].source = {
    assetId: cube.descriptor.id,
    topologyRevision: 0,
    triangleCount: 12,
  };
  assert.deepEqual(objectBrimEarView(state, h.assets, h.objectId).stranded, [1]);
  assert.equal(objectBrimEarView(state, h.assets, h.objectId).baseZMm, 2);
  // Unreadable geometry still lists the ears, with none stranded and no base.
  assert.deepEqual(objectBrimEarView(state, new InMemoryAssetRepository(), h.objectId), {
    ears: state.plates[0].objects[0].brimEars,
    stranded: [],
  });
  assert.throws(
    () => objectBrimEarView(state, h.assets, entityId<'object'>('import:object:missing')),
    (error: unknown) => error instanceof BrimEarRefusal && error.code === 'unknownObject',
  );
  assert.equal(objectModelBaseZ(undefined), undefined);
  assert.equal(objectModelBaseZ({ positions: [], indices: [] }), undefined);
  assert.equal(objectModelBaseZ({ positions: [0, 0, 3, 1, 1, -1.5, 2, 2, 4], indices: [0, 1, 2] }), -1.5);
});

console.log(`\nCanonical brim ears: ${passed} tests passed.`);
