import assert from 'node:assert/strict';
import {
  EditorSession,
  InMemoryAssetRepository,
  RenameProjectCommand,
  type ProjectArchiveSnapshot,
  type ProjectSerializerPort,
  type SerializedProject,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

function harness(deferred = false) {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  let finish!: () => void;
  let request!: ProjectArchiveSnapshot;
  const serializer: ProjectSerializerPort = {
    async serialize(snapshot) {
      request = snapshot;
      if (deferred)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'application/zip',
        suggestedFilename: 'test.3mf',
        sourceRevision: snapshot.sourceRevision,
        sourceHash: snapshot.sourceHash,
      };
    },
    deserialize: async () => ({
      state: fixture.state,
      assets: [fixture.asset],
      warnings: [],
    }),
  };
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer,
  });
  session.execute(new RenameProjectCommand('Unsaved'));
  return {
    session,
    assets,
    fixture,
    finish: () => finish(),
    request: () => request,
    serializer,
  };
}

await test('snapshot serialization preserves dirty state until explicit guarded checkpoint acknowledgement', async () => {
  const { session, assets, fixture } = harness();
  const saved = await session.serializeSnapshot();
  assert.equal(session.commands.isDirty(), true);
  assert.equal(saved.guard.projectId, fixture.ids.project);
  assert.equal(saved.guard.assetFingerprint, assets.bundleFingerprint());
  assert.equal(saved.guard.revision, saved.serialized.sourceRevision);
  assert.equal(saved.guard.semanticHash, saved.serialized.sourceHash);
  session.acknowledgeSavedCheckpoint(saved.guard);
  assert.equal(session.commands.isDirty(), false);
  session.dispose();
});

await test('an edit during serialization still yields the captured recovery archive but cannot acknowledge newer work', async () => {
  const { session, finish } = harness(true);
  const pending = session.serializeSnapshot();
  const before = session.project.getSnapshot();
  session.execute(new RenameProjectCommand('Newer'));
  finish();
  const saved = await pending;
  assert.equal(saved.guard.semanticHash, before.hash);
  assert.throws(() => session.acknowledgeSavedCheckpoint(saved.guard), /stale/i);
  assert.equal(session.commands.isDirty(), true);
  session.dispose();
});

await test('asset changes and project replacement invalidate an otherwise identical revision/hash guard', async () => {
  const { session, assets, fixture } = harness();
  const saved = await session.serializeSnapshot();
  assets.remove(fixture.ids.asset);
  assert.throws(() => session.acknowledgeSavedCheckpoint(saved.guard), /stale/i);
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  assert.throws(
    () =>
      session.acknowledgeSavedCheckpoint({
        ...saved.guard,
        projectId: 'another-project' as typeof fixture.ids.project,
      }),
    /stale/i,
  );
  assert.equal(session.commands.isDirty(), true);
  session.dispose();
});

await test('a same-content undo cannot acknowledge the wrong revision', async () => {
  const { session } = harness();
  const saved = await session.serializeSnapshot();
  session.execute(new RenameProjectCommand('Transient'));
  session.undo();
  assert.equal(session.project.getSnapshot().hash, saved.guard.semanticHash);
  assert.throws(() => session.acknowledgeSavedCheckpoint(saved.guard), /stale/i);
  session.dispose();
});

await test('legacy explicit save still checks freshness and marks its checkpoint', async () => {
  const { session, finish } = harness(true);
  const pending = session.save();
  session.execute(new RenameProjectCommand('Newer'));
  finish();
  await assert.rejects(pending, /stale/i);
  assert.equal(session.commands.isDirty(), true);
  session.dispose();
  const live = harness();
  await live.session.save();
  assert.equal(live.session.commands.isDirty(), false);
  live.session.dispose();
});

await test('disposal and serializer result mismatch cannot publish a snapshot or checkpoint', async () => {
  const { session, finish } = harness(true);
  const pending = session.serializeSnapshot();
  session.dispose();
  finish();
  await assert.rejects(pending, /disposed/i);
  const next = harness();
  const serialize = next.serializer.serialize;
  next.serializer.serialize = async (snapshot) =>
    ({
      ...(await serialize(snapshot)),
      sourceHash: 'wrong',
    }) satisfies SerializedProject;
  await assert.rejects(next.session.serializeSnapshot(), /stale/i);
  assert.equal(next.session.commands.isDirty(), true);
  next.session.dispose();
});

console.log(`\n${passed} snapshot checkpoint tests passed.`);
