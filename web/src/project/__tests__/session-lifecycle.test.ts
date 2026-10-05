import assert from 'node:assert/strict';
import {
  EditorSession,
  InMemoryAssetRepository,
  RenameProjectCommand,
  StaleProjectResultError,
  cloneProjectState,
  type CancellationToken,
  type ProjectSerializerPort,
  type SliceAdapterPort,
  type SliceRequest,
  type SliceResult,
} from '..';
import { createProjectFixture } from './fixtures';

type Parsed = Awaited<ReturnType<ProjectSerializerPort['deserialize']>>;

function setup(slicer?: SliceAdapterPort) {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const requests: Array<{
    cancellation?: CancellationToken;
    resolve: (parsed: Parsed) => void;
    reject: (error: Error) => void;
  }> = [];
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    slicer,
    serializer: {
      async serialize() {
        throw new Error('This test only deserializes');
      },
      deserialize(_bytes, cancellation) {
        return new Promise((resolve, reject) => requests.push({ cancellation, resolve, reject }));
      },
    },
  });
  session.selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  session.execute(new RenameProjectCommand('Keep this edit'));
  session.execute(new RenameProjectCommand('Keep this redo'));
  session.undo();
  const imported = (name = 'Imported project'): Parsed => ({
    state: { ...cloneProjectState(fixture.state), name },
    assets: [fixture.asset],
    warnings: ['Synthetic import warning'],
  });
  return { session, requests, imported, fixture };
}

function footprint(session: EditorSession) {
  return {
    project: session.project.getSnapshot(),
    assets: session.assets.captureInternal(),
    selection: session.selection.getSnapshot(),
    history: session.commands.getHistorySnapshot(),
  };
}

function assertUnchanged(session: EditorSession, before: ReturnType<typeof footprint>) {
  const after = footprint(session);
  assert.deepEqual(after, before);
  assert.equal(after.assets, before.assets, 'a rejected operation must retain the existing immutable asset version');
}

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('a pre-cancelled open never starts the serializer', async () => {
  const { session, requests, imported } = setup();
  const before = footprint(session);
  const pending = session.open(new Uint8Array(), { aborted: true, reason: 'Open cancelled by test' });
  requests[0]?.resolve(imported());
  await assert.rejects(pending, /cancelled/);
  assert.equal(requests.length, 0);
  assertUnchanged(session, before);
  session.dispose();
});

await test('a serializer ignoring cancellation cannot commit a late archive', async () => {
  const { session, requests, imported } = setup();
  const cancellation = { aborted: false, reason: 'Open cancelled by test' };
  const before = footprint(session);
  const pending = session.open(new Uint8Array(), cancellation);
  cancellation.aborted = true;
  assert.equal(requests[0]!.cancellation?.aborted, true);
  requests[0]!.resolve(imported());
  await assert.rejects(pending, /cancelled/);
  assertUnchanged(session, before);
  session.dispose();
});

await test('an edit followed by undo still makes an earlier archive completion stale', async () => {
  const { session, requests, imported } = setup();
  const pending = session.open(new Uint8Array());
  const original = session.project.getSnapshot();
  session.execute(new RenameProjectCommand('Temporary edit'));
  session.undo();
  assert.equal(session.project.getSnapshot().hash, original.hash);
  assert.ok(session.project.getSnapshot().revision > original.revision);
  const before = footprint(session);
  assert.equal(requests[0]!.cancellation?.aborted, true);
  requests[0]!.resolve(imported());
  await assert.rejects(pending, StaleProjectResultError);
  assertUnchanged(session, before);
  session.dispose();
});

await test('asset-only drift invalidates a pending open without copying the live payload', async () => {
  const { session, requests, imported, fixture } = setup();
  const list = session.assets.list.bind(session.assets);
  let copies = 0;
  session.assets.list = () => {
    copies++;
    return list();
  };
  const pending = session.open(new Uint8Array());
  session.assets.remove(fixture.ids.asset);
  const before = footprint(session);
  requests[0]!.resolve(imported());
  await assert.rejects(pending, StaleProjectResultError);
  assert.equal(copies, 0);
  assertUnchanged(session, before);
  session.dispose();
});

await test('reset and disposal invalidate pending reads and notify their cancellation token', async () => {
  for (const operation of ['reset', 'dispose'] as const) {
    const { session, requests, imported, fixture } = setup();
    const pending = session.open(new Uint8Array());
    if (operation === 'reset') {
      session.reset({ ...cloneProjectState(fixture.state), name: 'New reset root' }, { entries: [fixture.asset] });
    } else session.dispose();
    const before = footprint(session);
    assert.equal(requests[0]!.cancellation?.aborted, true);
    requests[0]!.resolve(imported());
    await assert.rejects(pending, operation === 'reset' ? StaleProjectResultError : /disposed/);
    assertUnchanged(session, before);
    session.dispose();
  }
});

await test('starting a newer open supersedes the older read regardless of completion order', async () => {
  for (const olderFinishesFirst of [true, false]) {
    const { session, requests, imported } = setup();
    const older = session.open(new Uint8Array());
    const newer = session.open(new Uint8Array());
    assert.equal(requests[0]!.cancellation?.aborted, true);
    assert.equal(requests[1]!.cancellation?.aborted, false);
    if (olderFinishesFirst) {
      const before = footprint(session);
      requests[0]!.resolve(imported('Older request'));
      await assert.rejects(older, StaleProjectResultError);
      assertUnchanged(session, before);
      assert.equal(requests[1]!.cancellation?.aborted, false, 'old settlement cannot cancel the new request');
    }
    requests[1]!.resolve(imported('Newer request'));
    assert.deepEqual(await newer, ['Synthetic import warning']);
    const committed = footprint(session);
    if (!olderFinishesFirst) {
      requests[0]!.resolve(imported('Older request'));
      await assert.rejects(older, StaleProjectResultError);
      assertUnchanged(session, committed);
    }
    assert.equal(committed.project.state.name, 'Newer request');
    assert.deepEqual(committed.history.dirtyCategories, []);
    assert.equal(committed.history.undoCount, 0);
    assert.equal(committed.history.redoCount, 0);
    assert.deepEqual(committed.selection, { refs: [] });
    session.dispose();
  }
});

await test('a failed newer request does not allow a superseded read to replace the project', async () => {
  const { session, requests, imported } = setup();
  const before = footprint(session);
  const older = session.open(new Uint8Array());
  const newer = session.open(new Uint8Array());
  requests[1]!.reject(new Error('Invalid archive'));
  await assert.rejects(newer, /Invalid archive/);
  requests[0]!.resolve(imported());
  await assert.rejects(older, StaleProjectResultError);
  assertUnchanged(session, before);
  session.dispose();
});

await test('invalid imported assets preserve state and a subsequent valid open still succeeds', async () => {
  const { session, requests, imported } = setup();
  const before = footprint(session);
  const invalid = session.open(new Uint8Array());
  requests[0]!.resolve({ ...imported(), assets: [] });
  await assert.rejects(invalid, /missing source asset/);
  assertUnchanged(session, before);
  const retry = session.open(new Uint8Array());
  requests[1]!.resolve(imported());
  await retry;
  assert.equal(session.project.getSnapshot().state.name, 'Imported project');
  session.dispose();
});

await test('cooperative serializer rejection keeps the authoritative stale classification', async () => {
  const { session, requests } = setup();
  const pending = session.open(new Uint8Array());
  session.execute(new RenameProjectCommand('Edit during open'));
  const before = footprint(session);
  requests[0]!.reject(new Error('Serializer stopped because its cancellation token changed'));
  await assert.rejects(pending, StaleProjectResultError);
  assertUnchanged(session, before);
  session.dispose();
});

await test('a pre-cancelled slice starts no adapter work or asset copies', async () => {
  let calls = 0;
  const { session } = setup({
    async slice() {
      calls++;
      throw new Error('Adapter must not start');
    },
  });
  const before = footprint(session);
  const list = session.assets.list.bind(session.assets);
  let copies = 0;
  session.assets.list = () => {
    copies++;
    return list();
  };
  await assert.rejects(session.slice(undefined, { aborted: true, reason: 'Slice cancelled by test' }), /cancelled/);
  assert.equal(calls, 0);
  assert.equal(copies, 0);
  assertUnchanged(session, before);
  session.dispose();
});

await test('a slice adapter ignoring cancellation cannot return a cancelled result', async () => {
  let finish!: (result: SliceResult) => void;
  let request!: SliceRequest;
  const { session } = setup({
    slice(next) {
      request = next;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const before = footprint(session);
  const cancellation = { aborted: false, reason: 'Slice cancelled by test' };
  const pending = session.slice(undefined, cancellation);
  cancellation.aborted = true;
  finish({
    sourceRevision: request.sourceRevision,
    sourceHash: request.sourceHash,
    plateId: request.plateId,
    gcode: new Uint8Array([1]),
    warnings: [],
    statistics: {},
  });
  await assert.rejects(pending, /cancelled/);
  assertUnchanged(session, before);
  session.dispose();
});

console.log(`\nEditor session lifecycle: ${passed} tests passed.`);
