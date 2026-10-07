import assert from 'node:assert/strict';
import { InMemoryAssetRepository, contentDigest, type AssetRepositorySelection } from '../assets';
import { cloneJson } from '../domain/canonical';
import { entityId } from '../domain/ids';
import { CommandBus } from '../history/commandBus';
import { PasteObjectCommand, objectAssetIds } from '../objects/commands';
import { ProjectStore } from '../store';
import { SelectionStore } from '../selection';
import { createProjectFixture } from './fixtures';

const limits = { maxAssets: 4, maxBytes: 16 * 1024 * 1024 };
const ids = {
  objectId: entityId<'object'>('import:clipboard:object'),
  volumeIds: [entityId<'volume'>('import:clipboard:volume')],
  instanceIds: [entityId<'instance'>('import:clipboard:instance')],
  layerRangeIds: [entityId<'layer-range'>('import:clipboard:range')],
};
function setup() {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const captured = assets.captureSelection([fixture.ids.asset], limits);
  const record = assets.peek(fixture.ids.asset);
  const state = cloneJson(fixture.state);
  state.plates[0].objects = [];
  state.sourceAssets = [];
  assets.remove(fixture.ids.asset);
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  const bus = new CommandBus({ project, selection, assets });
  return { fixture, assets, captured, record, project, selection, bus };
}
let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ✓ ${name}`);
}
test('asset capture has immutable descriptors, bounded selected bytes and no public byte view', () => {
  const { assets, fixture, captured, record } = setup();
  assert.equal(captured.byteLength, fixture.asset.bytes.byteLength);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.descriptors));
  assert.ok(Object.isFrozen(captured.descriptors[0].mesh?.positions));
  assert.deepEqual(Object.keys(captured).sort(), ['byteLength', 'descriptors']);
  assets.mergeSelection(captured);
  assert.equal(assets.peek(fixture.ids.asset), record);
  const version = assets.captureInternal();
  assets.mergeSelection(captured);
  assert.equal(assets.captureInternal(), version);
});
test('missing, duplicate and over-budget captures refuse without changing the repository', () => {
  const { assets, fixture, captured } = setup();
  assets.mergeSelection(captured);
  const before = assets.captureInternal();
  assert.throws(() => assets.captureSelection([fixture.ids.asset], { ...limits, maxAssets: 0 }));
  assert.throws(() =>
    assets.captureSelection([fixture.ids.asset], { ...limits, maxBytes: fixture.asset.bytes.byteLength - 1 }),
  );
  assert.throws(() => assets.captureSelection([fixture.ids.asset, fixture.ids.asset], limits), /Duplicate/);
  assert.throws(() => assets.captureSelection([entityId<'asset'>('import:missing:asset')], limits), /Missing/);
  for (const value of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => assets.captureSelection([], { ...limits, maxBytes: value }));
    assert.throws(() => assets.captureSelection([], { ...limits, maxAssets: value }));
  }
  assert.equal(assets.captureInternal(), before);
});
test('forged and foreign capabilities are refused before insertion', () => {
  const { assets, captured } = setup();
  const foreign = new InMemoryAssetRepository();
  const before = assets.captureInternal();
  assert.throws(() => assets.mergeSelection({} as AssetRepositorySelection), /Invalid or foreign/);
  assert.throws(() => foreign.mergeSelection(captured), /Invalid or foreign/);
  assert.throws(() => foreign.inspectSelection(captured), /Invalid or foreign/);
  assert.equal(assets.captureInternal(), before);
});
test('a conflict in a later record cannot insert an earlier missing record', () => {
  const { assets, captured, fixture } = setup();
  assets.mergeSelection(captured);
  const second = { ...fixture.asset.descriptor, id: entityId<'asset'>('import:clipboard:asset-2') };
  assets.put(second, fixture.asset.bytes);
  const pair = assets.captureSelection([fixture.ids.asset, second.id], limits);
  assets.remove(fixture.ids.asset);
  assets.remove(second.id);
  assets.put({ ...second, sourceFilename: 'conflict.stl' }, fixture.asset.bytes);
  const before = assets.captureInternal();
  assert.throws(() => assets.mergeSelection(pair), /cannot be replaced/);
  assert.equal(assets.captureInternal(), before);
  assert.equal(assets.has(fixture.ids.asset), false);
});
test('paste restores bytes and declarations in one publication and exact undo/redo', () => {
  const { fixture, assets, captured, record, project, bus, selection } = setup();
  const before = project.getSnapshot().hash;
  const observations: [number, boolean][] = [];
  project.subscribe(({ current }) =>
    observations.push([current.state.sourceAssets.length, assets.has(fixture.ids.asset)]),
  );
  bus.execute(new PasteObjectCommand(fixture.object, ids, {}, captured));
  const after = project.getSnapshot().hash;
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.deepEqual(observations, [[1, true]]);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.equal(bus.getHistorySnapshot().undoLabel, 'Paste model');
  assert.equal(selection.getSnapshot().primary?.kind, 'instance');
  assert.ok(bus.undo());
  assert.equal(project.getSnapshot().hash, before);
  assert.equal(assets.has(fixture.ids.asset), false);
  assert.deepEqual(observations, [
    [1, true],
    [0, false],
  ]);
  assert.ok(bus.redo());
  assert.equal(project.getSnapshot().hash, after);
  assert.equal(assets.peek(fixture.ids.asset), record);
});
test('graph rejection after restoring assets rolls back content, records, selection and history', () => {
  const { fixture, assets, captured, project, selection, bus } = setup();
  fixture.object.filamentId = entityId<'physical-filament'>('import:missing:filament');
  const before = project.getSnapshot().hash;
  const version = assets.captureInternal();
  assert.throws(() => bus.execute(new PasteObjectCommand(fixture.object, ids, {}, captured)));
  assert.equal(project.getSnapshot().hash, before);
  assert.equal(assets.captureInternal(), version);
  assert.equal(selection.getSnapshot().refs.length, 0);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});
test('same-ID descriptor conflict and incomplete dependency captures cannot change live assets', () => {
  const { fixture, assets, captured, project, bus } = setup();
  const before = project.getSnapshot().hash;
  assets.put({ ...fixture.asset.descriptor, sourceFilename: 'conflict.stl' }, fixture.asset.bytes);
  const version = assets.captureInternal();
  assert.throws(() => bus.execute(new PasteObjectCommand(fixture.object, ids, {}, captured)), /consistently/);
  assert.equal(assets.captureInternal(), version);
  assert.equal(project.getSnapshot().hash, before);
  assets.remove(fixture.ids.asset);
  const empty = assets.captureSelection([], limits);
  assert.throws(() => bus.execute(new PasteObjectCommand(fixture.object, ids, {}, empty)), /dependencies/);
  assert.equal(assets.has(fixture.ids.asset), false);
});
test('an undo failure restores asset identity and keeps the command retryable', () => {
  const { fixture, assets, captured, record, project, bus } = setup();
  bus.execute(new PasteObjectCommand(fixture.object, ids, {}, captured));
  const after = project.getSnapshot().hash;
  const original = project.replaceState.bind(project);
  let fail = true;
  project.replaceState = (...args) => {
    if (fail) {
      fail = false;
      throw new Error('Injected publication failure');
    }
    return original(...args);
  };
  assert.throws(() => bus.undo(), /Injected/);
  assert.equal(project.getSnapshot().hash, after);
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.ok(bus.undo());
  assert.equal(assets.has(fixture.ids.asset), false);
});
test('editable SVG drawings travel with the selected mesh and are released on undo', () => {
  const { fixture, assets, captured, project, bus } = setup();
  const drawingId = entityId<'asset'>('import:clipboard:drawing');
  const bytes = new TextEncoder().encode('<svg/>');
  assets.mergeSelection(captured);
  assets.put(
    {
      id: drawingId,
      kind: 'extension',
      mediaType: 'image/svg+xml',
      byteLength: bytes.length,
      digest: contentDigest(bytes),
    },
    bytes,
  );
  fixture.object.volumes[0].embossSvg = {
    drawingAssetId: drawingId,
    pathIn3mf: 'Metadata/svg/source.svg',
    depthMm: 1,
    useSurface: false,
    widthMm: 10,
  };
  const dependencies = objectAssetIds(fixture.object);
  assert.deepEqual(dependencies, [fixture.ids.asset, drawingId]);
  const both = assets.captureSelection(dependencies, limits);
  for (const id of dependencies) assets.remove(id);
  bus.execute(new PasteObjectCommand(fixture.object, ids, {}, both));
  assert.equal(project.getSnapshot().state.sourceAssets.length, 2);
  assert.deepEqual(assets.get(drawingId)?.bytes, bytes);
  assert.ok(bus.undo());
  assert.equal(assets.list().length, 0);
  assert.ok(bus.redo());
  assert.equal(project.getSnapshot().state.plates[0].objects[0].volumes[0].embossSvg?.drawingAssetId, drawingId);
});
test('redo refuses changed asset ownership without losing its history entry', () => {
  const { fixture, assets, captured, project, bus } = setup();
  bus.execute(new PasteObjectCommand(fixture.object, ids, {}, captured));
  assert.ok(bus.undo());
  assets.put({ ...fixture.asset.descriptor, sourceFilename: 'collision.stl' }, fixture.asset.bytes);
  const version = assets.captureInternal();
  const hash = project.getSnapshot().hash;
  assert.throws(() => bus.redo(), /consistently/);
  assert.equal(project.getSnapshot().hash, hash);
  assert.equal(assets.captureInternal(), version);
  assert.equal(bus.getHistorySnapshot().redoCount, 1);
  assets.remove(fixture.ids.asset);
  assert.ok(bus.redo());
});
test('an 8 MiB capture and twenty paste/undo/redo cycles copy no mesh payloads', () => {
  const { fixture, assets, project, bus } = setup();
  const bytes = new Uint8Array(8 * 1024 * 1024);
  bytes.set(fixture.asset.bytes);
  const descriptor = { ...fixture.asset.descriptor, byteLength: bytes.length, digest: contentDigest(bytes) };
  assets.put(descriptor, bytes);
  const record = assets.peek(descriptor.id);
  const original = Uint8Array.prototype.slice;
  let copied = 0;
  Uint8Array.prototype.slice = function (start, end) {
    const value = original.call(this, start, end);
    copied += value.byteLength;
    return value;
  };
  try {
    const captured = assets.captureSelection([descriptor.id], limits);
    assets.remove(descriptor.id);
    const command = new PasteObjectCommand(fixture.object, ids, {}, captured);
    assert.equal(command.estimateBytes(), bytes.length + JSON.stringify(captured.descriptors).length + 1);
    const before = project.getSnapshot().hash;
    bus.execute(command);
    for (let i = 0; i < 20; i++) {
      assert.ok(bus.undo());
      assert.equal(project.getSnapshot().hash, before);
      assert.ok(bus.redo());
      assert.equal(assets.peek(descriptor.id), record);
    }
    assert.equal(copied, 0);
    assert.equal(assets.get(descriptor.id)?.bytes.length, bytes.length);
    assert.equal(copied, bytes.length, 'public reads remain independent mutable copies');
  } finally {
    Uint8Array.prototype.slice = original;
  }
});
console.log(`\nClipboard asset ownership: ${passed} cases passed.`);
