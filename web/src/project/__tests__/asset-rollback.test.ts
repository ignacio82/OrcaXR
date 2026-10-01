import assert from 'node:assert/strict';
import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  RenameProjectCommand,
  SelectionStore,
  SetInstanceTransformCommand,
  canonicalStringify,
  contentDigest,
  identityTransform,
  type ProjectCommand,
} from '..';
import { assetBundleFingerprint, type AssetRepositoryInternalSnapshot } from '../assets';
import { SetProjectSettingsOverridesCommand } from '../settingsOverrides';
import { ImportProjectCommand } from '../import/ImportProjectCommand';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness(byteLength = 1024 * 1024) {
  const fixture = createProjectFixture();
  const bytes = new Uint8Array(byteLength);
  bytes.set(fixture.asset.bytes);
  fixture.asset.bytes = bytes;
  fixture.asset.descriptor.byteLength = byteLength;
  fixture.asset.descriptor.digest = contentDigest(bytes);
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, bytes);
  const bus = new CommandBus({ project, selection, assets });
  return { fixture, project, selection, assets, bus };
}

function copiedBytes(run: () => void): number {
  const original = Uint8Array.prototype.slice;
  let copied = 0;
  Uint8Array.prototype.slice = function (start?: number, end?: number) {
    const result = original.call(this, start, end);
    copied += result.byteLength;
    return result;
  };
  try {
    run();
    return copied;
  } finally {
    Uint8Array.prototype.slice = original;
  }
}

test('transform, selection and settings edits and their undo/redo copy no mesh bytes', () => {
  const { fixture, project, selection, assets, bus } = harness();
  const record = assets.peek(fixture.ids.asset);
  const original = project.getSnapshot().hash;
  const copied = copiedBytes(() => {
    bus.execute(
      new SetInstanceTransformCommand(fixture.ids.instance, {
        ...identityTransform(),
        translationMm: [5, 4, 3],
      }),
    );
    selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
    const guard = project.getSnapshot();
    bus.execute(
      new SetProjectSettingsOverridesCommand(
        { sourceRevision: guard.revision, sourceHash: guard.hash },
        {
          inheritedConfig: guard.state.config,
          overrides: { layer_height: 0.16 },
        },
      ),
    );
    const edited = project.getSnapshot().hash;
    assert.ok(bus.undo());
    assert.ok(bus.undo());
    assert.equal(project.getSnapshot().hash, original);
    assert.ok(bus.redo());
    assert.ok(bus.redo());
    assert.equal(project.getSnapshot().hash, edited);
  });
  assert.equal(copied, 0, `Ordinary edits copied ${copied} mesh bytes`);
  assert.equal(assets.peek(fixture.ids.asset), record);
});

test('failed commands and transactions restore exact asset records, project and selection', () => {
  const { fixture, project, selection, assets, bus } = harness();
  selection.set([{ kind: 'object', id: fixture.ids.object }]);
  const record = assets.peek(fixture.ids.asset);
  const before = project.getSnapshot();
  const beforeSelection = selection.getSnapshot();
  const fingerprint = assets.bundleFingerprint();
  const fail: ProjectCommand = {
    type: 'fault',
    label: 'Fault',
    dirtyCategories: ['projectData'],
    apply(context) {
      context.assets.remove(fixture.ids.asset);
      context.selection.clear();
      throw new Error('injected failure');
    },
    revert() {},
  };
  assert.equal(
    copiedBytes(() => {
      assert.throws(() => bus.execute(fail), /injected failure/);
      assert.throws(
        () =>
          bus.transaction('Fail transaction', () => {
            bus.execute(new RenameProjectCommand('Transient'));
            bus.execute(fail);
          }),
        /injected failure/,
      );
    }),
    0,
  );
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.equal(assets.bundleFingerprint(), fingerprint);
  assert.equal(project.getSnapshot().hash, before.hash);
  assert.equal(canonicalStringify(project.getSnapshot().state), canonicalStringify(before.state));
  assert.deepEqual(selection.getSnapshot(), beforeSelection);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(bus.isDirty(), false);
});

test('failed undo and redo restore the exact repository version without copying bytes', () => {
  const { fixture, project, assets, bus } = harness();
  let failApply = false;
  let failRevert = false;
  const rename = new RenameProjectCommand('Edited');
  bus.execute({
    type: 'fault-history',
    label: 'History fault',
    dirtyCategories: ['projectData'],
    apply(context) {
      if (failApply) {
        context.assets.remove(fixture.ids.asset);
        throw new Error('redo fault');
      }
      rename.apply(context);
    },
    revert(context) {
      if (failRevert) {
        context.assets.remove(fixture.ids.asset);
        throw new Error('undo fault');
      }
      rename.revert(context);
    },
  });
  const record = assets.peek(fixture.ids.asset);
  const edited = project.getSnapshot().hash;
  failRevert = true;
  assert.equal(
    copiedBytes(() => assert.throws(() => bus.undo(), /undo fault/)),
    0,
  );
  assert.equal(project.getSnapshot().hash, edited);
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  failRevert = false;
  bus.undo();
  const undone = project.getSnapshot().hash;
  failApply = true;
  assert.equal(
    copiedBytes(() => assert.throws(() => bus.redo(), /redo fault/)),
    0,
  );
  assert.equal(project.getSnapshot().hash, undone);
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.equal(bus.getHistorySnapshot().redoCount, 1);
});

test('opaque snapshots retain independent branches and reject forged or foreign handles', () => {
  const { fixture, assets } = harness(36);
  const first = assets.captureInternal();
  const record = assets.peek(fixture.ids.asset)!;
  const firstFingerprint = assets.bundleFingerprint();
  assert.equal(assets.captureInternal(), first);
  assert.deepEqual(Object.keys(first), []);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(record.descriptor.mesh));
  assets.remove(fixture.ids.asset);
  const empty = assets.captureInternal();
  const emptyFingerprint = assets.bundleFingerprint();
  assert.notEqual(firstFingerprint, emptyFingerprint);
  assets.restoreInternal(first);
  assert.equal(assets.peek(fixture.ids.asset), record);
  assert.equal(assets.bundleFingerprint(), firstFingerprint);
  assert.equal(assets.bundleFingerprint(), assetBundleFingerprint(assets.list()));
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  assets.remove('absent' as typeof fixture.ids.asset);
  assert.equal(assets.captureInternal(), first);
  assets.restoreInternal(empty);
  assert.equal(assets.has(fixture.ids.asset), false);
  assert.equal(assets.bundleFingerprint(), emptyFingerprint);
  assert.throws(() => assets.restoreInternal({} as AssetRepositoryInternalSnapshot), /Invalid or foreign/);
  assert.throws(() => assets.restoreInternal(new InMemoryAssetRepository().captureInternal()), /Invalid or foreign/);
  assert.equal(assets.captureInternal(), empty);
});

test('public mutable reads and serialized imports remain isolated and fully validated', () => {
  const { fixture, assets } = harness(36);
  const record = assets.peek(fixture.ids.asset)!;
  const snapshot = assets.captureInternal();
  const fingerprint = assets.bundleFingerprint();
  for (const copy of [
    assets.get(fixture.ids.asset)!,
    assets.list()[0],
    assets.findByDigest(record.descriptor.digest)!,
    assets.capture().entries[0],
  ]) {
    copy.bytes.fill(99);
    copy.descriptor.sourceFilename = 'changed';
  }
  assert.equal(assets.bundleFingerprint(), fingerprint);
  assert.deepEqual(record.bytes, fixture.asset.bytes);
  const bundle = assets.capture();
  assets.restore(bundle);
  bundle.entries[0].bytes.fill(88);
  assert.deepEqual(assets.peek(fixture.ids.asset)?.bytes, record.bytes);
  assets.restoreInternal(snapshot);
  const invalid = assets.capture();
  invalid.entries[0].bytes[0] ^= 255;
  assert.throws(() => assets.restore(invalid), /invalid digest/);
  assert.throws(() => assets.restore({ entries: [fixture.asset, fixture.asset] }), /duplicate ID/);
  assert.throws(
    () =>
      assets.restore({
        entries: [{ ...fixture.asset, bytes: new Uint8Array() }],
      }),
    /invalid byte length/,
  );
  assert.equal(assets.captureInternal(), snapshot);
});

test('import undo and redo reuse previously validated repository versions', () => {
  const { fixture, project, assets, bus } = harness();
  const original = assets.peek(fixture.ids.asset);
  const before = project.getSnapshot().hash;
  const next = createProjectFixture();
  next.state.name = 'Imported';
  const command = new ImportProjectCommand(next.state, [next.asset], 'Import');
  bus.execute(command);
  const imported = assets.peek(next.ids.asset);
  const after = project.getSnapshot().hash;
  assert.notEqual(imported, original);
  assert.equal(
    copiedBytes(() => {
      bus.undo();
      assert.equal(assets.peek(fixture.ids.asset), original);
      assert.equal(project.getSnapshot().hash, before);
      bus.redo();
      assert.equal(assets.peek(next.ids.asset), imported);
      assert.equal(project.getSnapshot().hash, after);
    }),
    0,
  );
});

test('initial and restored bundle fingerprints avoid payload copies and preserve the canonical contract', () => {
  const { assets } = harness();
  const expected = assetBundleFingerprint(assets.list());
  const snapshot = assets.captureInternal();
  assert.equal(
    copiedBytes(() => {
      assert.equal(assets.bundleFingerprint(), expected);
      assert.equal(assets.bundleFingerprint(), expected);
      assets.restoreInternal(snapshot);
      assert.equal(assets.bundleFingerprint(), expected);
    }),
    0,
  );
});

console.log(`\n${passed} asset rollback tests passed.`);
