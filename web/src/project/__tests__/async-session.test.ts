import assert from 'node:assert/strict';
import {
  AsyncEditorSession,
  AsyncSessionError,
  EditorSession,
  InMemoryAssetRepository,
  MAX_PENDING_SESSION_OPERATIONS,
  MAX_SESSION_TRANSACTION_COMMANDS,
  RenameProjectCommand,
  SetInstanceTransformCommand,
  identityTransform,
  type AsyncSessionErrorCode,
  type ProjectCommand,
} from '..';
import { createProjectFixture } from './fixtures';

function setup() {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: {
      async serialize() {
        throw new Error('Not used');
      },
      async deserialize() {
        throw new Error('Not used');
      },
    },
  });
  const gateway = new AsyncEditorSession(session);
  return { fixture, session, gateway };
}

function rejected(code: AsyncSessionErrorCode) {
  return (error: unknown) => error instanceof AsyncSessionError && error.code === code;
}

function footprint(session: EditorSession) {
  return {
    project: session.project.getSnapshot(),
    assets: session.assets.captureInternal(),
    history: session.commands.getHistorySnapshot(),
    selection: session.selection.getSnapshot(),
  };
}

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('defers mutation, acknowledges committed authority and preserves undo/redo checkpoints', async () => {
  const { session, gateway, fixture } = setup();
  const before = footprint(session);
  const request = gateway.execute(new RenameProjectCommand('Acknowledged'));
  assert.deepEqual(footprint(session), before);
  const result = await request;
  assert.equal(result.requestId, 1);
  assert.equal(result.guard.project.revision, 1);
  assert.equal(result.guard.project.semanticHash, session.project.getSnapshot().hash);
  assert.equal(result.guard.project.assetFingerprint, session.assets.bundleFingerprint());
  assert.deepEqual(result.history.dirtyCategories, ['projectData']);
  assert.equal(session.project.getSnapshot().state.name, 'Acknowledged');
  const undo = await gateway.undo({ guard: result.guard });
  assert.equal(undo.value, true);
  assert.equal(session.project.getSnapshot().state.name, fixture.state.name);
  assert.deepEqual(undo.history.dirtyCategories, []);
  assert.equal((await gateway.redo({ guard: undo.guard })).value, true);
  assert.equal(session.assets.captureInternal(), before.assets);
  assert.equal((await gateway.redo()).value, false);
  session.dispose();
});

await test('orders queries after edits and refuses two mutations based on the same revision', async () => {
  const { session, gateway } = setup();
  const first = gateway.execute(new RenameProjectCommand('First'));
  const second = gateway.execute(new RenameProjectCommand('Stale second'));
  const read = gateway.query();
  await first;
  await assert.rejects(second, rejected('stale'));
  const result = await read;
  assert.equal(result.requestId, 3);
  assert.equal(result.guard.project.revision, 1);
  assert.equal(result.history.undoCount, 1);
  assert.equal(session.project.getSnapshot().state.name, 'First');
  await gateway.execute(new RenameProjectCommand('Retry'), { guard: result.guard });
  session.dispose();
});

await test('rejects revision ABA, asset-only drift and reset without changing existing authority', async () => {
  for (const change of ['aba', 'asset', 'reset'] as const) {
    const { session, gateway, fixture } = setup();
    const request = gateway.execute(new RenameProjectCommand('Late'));
    if (change === 'aba') {
      session.execute(new RenameProjectCommand('Temporary'));
      session.undo();
    } else if (change === 'asset') session.assets.remove(fixture.ids.asset);
    else session.reset(fixture.state, { entries: [fixture.asset] });
    const before = footprint(session);
    await assert.rejects(request, rejected('stale'));
    assert.deepEqual(footprint(session), before);
    assert.equal(session.assets.captureInternal(), before.assets);
    session.dispose();
  }
});

await test('history ownership includes equal-looking replacement and checkpoint changes', async () => {
  const { session, gateway } = setup();
  const initial = session.commands.getHistorySnapshot();
  const request = gateway.undo();
  session.commands.clearHistory();
  assert.deepEqual(session.commands.getHistorySnapshot(), initial);
  await assert.rejects(request, rejected('stale'));
  await gateway.execute(new RenameProjectCommand('Dirty'));
  const second = gateway.undo();
  session.commands.markCheckpoint();
  await assert.rejects(second, rejected('stale'));
  assert.equal((await gateway.query()).history.undoCount, 1);
  session.dispose();
});

await test('an empty command transaction still publishes a changed manual checkpoint', async () => {
  const { session, gateway } = setup();
  await gateway.execute(new RenameProjectCommand('Save this edit'));
  const before = gateway.captureGuard();
  let notifications = 0;
  session.commands.subscribeHistory((history) => {
    notifications++;
    assert.deepEqual(history.dirtyCategories, []);
  });
  session.transaction('Acknowledge save', () => session.commands.markCheckpoint());
  assert.equal(notifications, 1);
  assert.ok(gateway.captureGuard().historyRevision > before.historyRevision);
  await assert.rejects(gateway.undo({ guard: before }), rejected('stale'));
  assert.deepEqual((await gateway.query()).history.dirtyCategories, []);
  session.dispose();
});

await test('cancellation before dispatch and while queued performs no mutation', async () => {
  const { session, gateway } = setup();
  const before = footprint(session);
  await assert.rejects(gateway.undo({ cancellation: { aborted: true } }), rejected('cancelled'));
  const cancellation = { aborted: false, reason: 'Do not leak this reason' };
  const pending = gateway.execute(new RenameProjectCommand('Cancelled'), { cancellation });
  cancellation.aborted = true;
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(rejected('cancelled')(error));
    assert.doesNotMatch(String(error), /leak/);
    return true;
  });
  assert.deepEqual(footprint(session), before);
  await gateway.execute(new RenameProjectCommand('Still usable'));
  session.dispose();
});

await test('disposal of either owner rejects queued mutations and queries', async () => {
  for (const owner of ['gateway', 'session'] as const) {
    const { session, gateway } = setup();
    const mutation = gateway.execute(new RenameProjectCommand('Disposed'));
    const query = gateway.query();
    const before = footprint(session);
    (owner === 'gateway' ? gateway : session).dispose();
    await assert.rejects(mutation, rejected('disposed'));
    await assert.rejects(query, rejected('disposed'));
    await assert.rejects(gateway.undo(), rejected('disposed'));
    assert.deepEqual(footprint(session), before);
    gateway.dispose();
    session.dispose();
  }
});

await test('an observer cancelling or disposing after commit cannot retract its acknowledgement', async () => {
  const { session, gateway } = setup();
  const cancellation = { aborted: false };
  session.commands.subscribeHistory(() => {
    cancellation.aborted = true;
    gateway.dispose();
    session.dispose();
  });
  const result = await gateway.execute(new RenameProjectCommand('Committed'), { cancellation });
  assert.equal(session.project.getSnapshot().state.name, 'Committed');
  assert.equal(result.history.undoCount, 1);
  assert.equal(result.guard.project.revision, 1);
  await assert.rejects(gateway.query(), rejected('disposed'));
});

await test('rejects a guard from another owner and captures caller-owned guard fields at submission', async () => {
  const { session, gateway } = setup();
  const other = new AsyncEditorSession(session);
  await assert.rejects(gateway.undo({ guard: other.captureGuard() }), rejected('stale'));
  const own = gateway.captureGuard();
  const mutable = { ...own, project: { ...own.project } };
  const pending = gateway.execute(new RenameProjectCommand('Bound guard'), { guard: mutable });
  mutable.project.revision = 900;
  mutable.historyRevision = 900;
  await pending;
  assert.equal(session.project.getSnapshot().state.name, 'Bound guard');
  other.dispose();
  session.dispose();
});

await test('a bounded batch is one undo entry and captures its operation list before dispatch', async () => {
  const { session, gateway, fixture } = setup();
  const commands = [new RenameProjectCommand('One'), new RenameProjectCommand('Two')];
  const pending = gateway.transaction('Rename twice', commands);
  commands.length = 0;
  const result = await pending;
  assert.equal(result.history.undoCount, 1);
  assert.equal(result.history.undoLabel, 'Rename twice');
  assert.equal(session.project.getSnapshot().state.name, 'Two');
  await gateway.undo();
  assert.equal(session.project.getSnapshot().state.name, fixture.state.name);
  await gateway.redo();
  assert.equal(session.project.getSnapshot().state.name, 'Two');
  const before = footprint(session);
  const guard = gateway.captureGuard();
  await gateway.transaction('Empty batch', []);
  assert.deepEqual(footprint(session), before);
  assert.equal(gateway.captureGuard().historyRevision, guard.historyRevision);
  session.dispose();
});

await test('a failed batch rolls back state, assets, selection and history with a newer revision', async () => {
  const { session, gateway, fixture } = setup();
  session.selection.set([{ kind: 'instance', id: fixture.ids.instance }]);
  session.execute(new RenameProjectCommand('Retain undo'));
  session.execute(new RenameProjectCommand('Retain redo'));
  session.undo();
  const before = footprint(session);
  const failure = new Error('Synthetic command rejection');
  const bad: ProjectCommand = {
    type: 'failing-fixture',
    label: 'Fixture',
    dirtyCategories: ['projectData'],
    apply(context) {
      context.assets.remove(fixture.ids.asset);
      context.selection.clear();
      throw failure;
    },
    revert() {
      throw new Error('Never retained');
    },
  };
  const pending = gateway.transaction('Rejected batch', [new RenameProjectCommand('Transient'), bad]);
  const read = gateway.query();
  await assert.rejects(pending, (error) => error === failure);
  const after = footprint(session);
  assert.deepEqual(after.project.state, before.project.state);
  assert.equal(after.project.hash, before.project.hash);
  assert.ok(after.project.revision > before.project.revision);
  assert.equal(after.assets, before.assets);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.selection, before.selection);
  const result = await read;
  assert.equal(result.guard.project.revision, after.project.revision);
  await gateway.redo({ guard: result.guard });
  assert.equal(session.project.getSnapshot().state.name, 'Retain redo');
  session.dispose();
});

await test('retains transform coalescing and zero asset payload copies', async () => {
  const { session, gateway, fixture } = setup();
  const assets = session.assets.captureInternal();
  session.assets.list = () => {
    throw new Error('Unexpected asset payload copy');
  };
  session.assets.get = () => {
    throw new Error('Unexpected asset payload read');
  };
  const first = identityTransform();
  first.translationMm = [10, 0, 0];
  const second = identityTransform();
  second.translationMm = [20, 0, 0];
  await gateway.execute(new SetInstanceTransformCommand(fixture.ids.instance, first, 'drag'));
  const result = await gateway.execute(new SetInstanceTransformCommand(fixture.ids.instance, second, 'drag'));
  assert.equal(result.history.undoCount, 1);
  await gateway.undo();
  assert.deepEqual(
    session.project.getSnapshot().state.plates[0].objects[0].instances[0].transform,
    identityTransform(),
  );
  await gateway.redo();
  assert.deepEqual(session.project.getSnapshot().state.plates[0].objects[0].instances[0].transform, second);
  await gateway.query();
  assert.equal(session.assets.captureInternal(), assets);
  session.dispose();
});

await test('bounds pending work and transactions, then releases capacity after all outcomes', async () => {
  const { session, gateway } = setup();
  const pending = Array.from({ length: MAX_PENDING_SESSION_OPERATIONS }, () => gateway.query());
  await assert.rejects(gateway.query(), rejected('busy'));
  await Promise.all(pending);
  await gateway.query();
  const command = new RenameProjectCommand('Too many');
  const before = footprint(session);
  await assert.rejects(
    gateway.transaction('Oversized', Array(MAX_SESSION_TRANSACTION_COMMANDS + 1).fill(command)),
    rejected('invalid-request'),
  );
  await assert.rejects(gateway.transaction(' ', []), rejected('invalid-request'));
  await assert.rejects(gateway.transaction('Sparse', Array(2)), rejected('invalid-request'));
  assert.deepEqual(footprint(session), before);
  const requests = Array.from({ length: MAX_PENDING_SESSION_OPERATIONS }, () => gateway.undo());
  await Promise.all(requests);
  await gateway.query();
  session.dispose();
});

await test('acknowledgements are immutable and do not change when later edits commit', async () => {
  const { session, gateway } = setup();
  const before = await gateway.query();
  assert.ok(Object.isFrozen(before));
  assert.ok(Object.isFrozen(before.guard));
  assert.ok(Object.isFrozen(before.guard.project));
  assert.ok(Object.isFrozen(before.history));
  assert.ok(Object.isFrozen(before.history.dirtyCategories));
  await gateway.execute(new RenameProjectCommand('After snapshot'));
  assert.equal(before.guard.project.revision, 0);
  assert.equal(before.history.undoCount, 0);
  assert.deepEqual(before.history.dirtyCategories, []);
  session.dispose();
});

console.log(`\nAsynchronous editor session: ${passed} tests passed.`);
