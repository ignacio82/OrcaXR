import assert from 'node:assert/strict';
import {
  AddObjectCommand,
  EditorSession,
  InMemoryAssetRepository,
  RenameProjectCommand,
  SetInstanceTransformCommand,
  StaleProjectResultError,
  UnhealthyProjectProjectionError,
  UuidIdSource,
  createEmptyProject,
  identityTransform,
  seededRandom,
  type ProjectArchiveSnapshot,
  type ProjectSerializerPort,
  type SerializedProject,
  type SliceAdapterPort,
  type SliceRequest,
  type SliceResult,
  type EditorSurfacePort,
  type CommandHistorySnapshot,
  type ProjectProjectionHealthSnapshot,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class MemorySerializer implements ProjectSerializerPort {
  serializeCalls = 0;

  async serialize(snapshot: ProjectArchiveSnapshot): Promise<SerializedProject> {
    this.serializeCalls += 1;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        state: snapshot.state,
        assets: snapshot.assets.map((asset) => ({
          descriptor: asset.descriptor,
          bytes: Array.from(asset.bytes),
        })),
      }),
    );
    return {
      bytes,
      mediaType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      suggestedFilename: 'fixture.3mf',
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
    };
  }

  async deserialize(bytes: Uint8Array, _cancellation?: unknown) {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
      state: ProjectArchiveSnapshot['state'];
      assets: Array<{
        descriptor: ProjectArchiveSnapshot['assets'][number]['descriptor'];
        bytes: number[];
      }>;
    };
    return {
      state: decoded.state,
      assets: decoded.assets.map((asset) => ({
        descriptor: asset.descriptor,
        bytes: new Uint8Array(asset.bytes),
      })),
      warnings: [],
    };
  }
}

class VerifyingSlicer implements SliceAdapterPort {
  lastRequest?: SliceRequest;
  sliceCalls = 0;

  async slice(request: SliceRequest): Promise<SliceResult> {
    this.sliceCalls += 1;
    this.lastRequest = request;
    const translation = request.state.plates[0]?.objects[0]?.instances[0]?.transform.translationMm[0] ?? -1;
    return {
      sourceRevision: request.sourceRevision,
      sourceHash: request.sourceHash,
      plateId: request.plateId,
      gcode: new Uint8Array([translation]),
      warnings: [],
      statistics: { objectCount: request.state.plates[0]?.objects.length ?? 0 },
    };
  }
}

await test('runs a headless add-transform-serialize-reopen-slice flow through injected ports', async () => {
  const fixture = createProjectFixture({ withObject: false });
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const serializer = new MemorySerializer();
  const slicer = new VerifyingSlicer();
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer,
    slicer,
  });
  session.transaction('Add and position', () => {
    session.execute(new AddObjectCommand(fixture.state.activePlateId, fixture.object));
    session.execute(
      new SetInstanceTransformCommand(fixture.ids.instance, {
        ...identityTransform(),
        translationMm: [42, 7, 0],
      }),
    );
  });
  const saved = await session.save();
  assert.equal(session.commands.isDirty(), false);

  const freshState = createEmptyProject({
    idSource: new UuidIdSource(seededRandom(12345)),
    now: '2026-07-17T00:00:00.000Z',
    toolCount: 1,
  });
  const reopenedSlicer = new VerifyingSlicer();
  const reopened = new EditorSession({
    initialState: freshState,
    serializer,
    slicer: reopenedSlicer,
  });
  await reopened.open(saved.bytes);
  const result = await reopened.slice();
  assert.deepEqual(Array.from(result.gcode), [42]);
  assert.equal(result.statistics.objectCount, 1);
  assert.equal(reopenedSlicer.lastRequest?.assets.length, 1);
  assert.equal(reopened.commands.getHistorySnapshot().undoCount, 0);
  assert.equal(reopened.commands.isDirty(), false);
  const savedAgain = await reopened.save();
  assert.deepEqual(savedAgain.bytes, saved.bytes);
  session.dispose();
  reopened.dispose();
});

await test('rejects a slice that completes after the canonical project revision changes', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  let finish!: (result: SliceResult) => void;
  let request!: SliceRequest;
  const slicer: SliceAdapterPort = {
    slice(next) {
      request = next;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: new MemorySerializer(),
    slicer,
  });
  const pending = session.slice();
  session.execute(new RenameProjectCommand('Newer state'));
  finish({
    sourceRevision: request.sourceRevision,
    sourceHash: request.sourceHash,
    plateId: request.plateId,
    gcode: new Uint8Array(),
    warnings: [],
    statistics: {},
  });
  await assert.rejects(pending, StaleProjectResultError);
  session.dispose();
});

await test('rejects a slice that completes after source asset bytes drift', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  let finish!: (result: SliceResult) => void;
  let request!: SliceRequest;
  const slicer: SliceAdapterPort = {
    slice(next) {
      request = next;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: new MemorySerializer(),
    slicer,
  });
  const pending = session.slice();
  assets.remove(fixture.ids.asset);
  finish({
    sourceRevision: request.sourceRevision,
    sourceHash: request.sourceHash,
    plateId: request.plateId,
    gcode: new Uint8Array(),
    warnings: [],
    statistics: {},
  });
  await assert.rejects(pending, StaleProjectResultError);
  session.dispose();
});

await test('rejects serializer output whose revision/hash guard does not match its request', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const honest = new MemorySerializer();
  const dishonest: ProjectSerializerPort = {
    async serialize(snapshot) {
      const result = await honest.serialize(snapshot);
      return { ...result, sourceRevision: result.sourceRevision + 1 };
    },
    deserialize: (bytes, cancellation) => honest.deserialize(bytes, cancellation),
  };
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: dishonest,
    slicer: new VerifyingSlicer(),
  });
  await assert.rejects(session.save(), StaleProjectResultError);
  assert.equal(session.commands.isDirty(), false);
  session.dispose();
});

await test('relays direct command-bus history changes once and permits slicer-free composition', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: new MemorySerializer(),
  });
  const history: CommandHistorySnapshot[] = [];
  const surface: EditorSurfacePort = {
    renderProject() {},
    renderSelection() {},
    renderHistory(snapshot) {
      history.push(snapshot);
    },
  };
  session.attachSurface(surface);
  assert.equal(history.length, 1);

  session.commands.execute(new RenameProjectCommand('Direct command'));
  assert.equal(history.length, 2);
  assert.equal(history.at(-1)?.undoCount, 1);
  assert.deepEqual(history.at(-1)?.dirtyCategories, ['projectData']);

  session.commands.transaction('Direct transaction', () => {
    session.commands.execute(new RenameProjectCommand('Transaction one'));
    session.commands.execute(new RenameProjectCommand('Transaction two'));
  });
  assert.equal(history.length, 3);
  assert.equal(history.at(-1)?.undoCount, 2);
  assert.equal(session.commands.undo(), true);
  assert.equal(history.length, 4);
  assert.equal(history.at(-1)?.redoCount, 1);
  assert.equal(session.commands.redo(), true);
  assert.equal(history.length, 5);

  session.commands.markCheckpoint();
  assert.equal(history.length, 6);
  assert.deepEqual(history.at(-1)?.dirtyCategories, []);
  session.commands.clearHistory();
  assert.equal(history.length, 7);
  assert.equal(history.at(-1)?.undoCount, 0);

  await session.save();
  await assert.rejects(session.slice(), /CanonicalSliceJobCoordinator/);
  session.dispose();
});

await test('observes failed project projections and blocks save and slice until a later render succeeds', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const serializer = new MemorySerializer();
  const slicer = new VerifyingSlicer();
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer,
    slicer,
  });
  let shouldFail = false;
  const surface: EditorSurfacePort = {
    projectionLabel: 'Primary project view',
    renderProject() {
      if (shouldFail) throw new Error(`Renderer\nfailed ${'x'.repeat(300)}`);
    },
    renderSelection() {},
  };
  session.attachSurface(surface);
  const transitions: Array<{
    current: ProjectProjectionHealthSnapshot;
    previous: ProjectProjectionHealthSnapshot;
  }> = [];
  session.subscribeProjectionHealth((current, previous) => {
    transitions.push({ current, previous });
  });

  shouldFail = true;
  session.execute(new RenameProjectCommand('Committed despite projection failure'));
  assert.equal(session.project.getSnapshot().state.name, 'Committed despite projection failure');
  const failedHealth = session.getProjectionHealthSnapshot();
  assert.equal(failedHealth.healthy, false);
  assert.equal(failedHealth.projectFailures.length, 1);
  assert.equal(failedHealth.projectFailures[0]?.surfaceLabel, 'Primary project view');
  assert.equal(failedHealth.projectFailures[0]?.projectRevision, session.project.getSnapshot().revision);
  assert.match(failedHealth.projectFailures[0]?.message ?? '', /^Error: Renderer failed/);
  assert.ok((failedHealth.projectFailures[0]?.message.length ?? 0) <= 160);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.previous.healthy, true);
  assert.equal(transitions[0]?.current.healthy, false);

  await assert.rejects(session.save(), (error: unknown) => {
    assert.ok(error instanceof UnhealthyProjectProjectionError);
    assert.equal(error.operation, 'save');
    assert.equal(error.health.projectFailures.length, 1);
    assert.ok(error.message.length <= 120);
    return true;
  });
  await assert.rejects(session.slice(), (error: unknown) => {
    assert.ok(error instanceof UnhealthyProjectProjectionError);
    assert.equal(error.operation, 'slice');
    return true;
  });
  assert.equal(serializer.serializeCalls, 0);
  assert.equal(slicer.sliceCalls, 0);

  shouldFail = false;
  session.execute(new RenameProjectCommand('Recovered projection'));
  assert.equal(session.getProjectionHealthSnapshot().healthy, true);
  assert.equal(transitions.length, 2);
  assert.equal(transitions[1]?.previous.healthy, false);
  assert.equal(transitions[1]?.current.healthy, true);

  await session.save();
  await session.slice();
  assert.equal(serializer.serializeCalls, 1);
  assert.equal(slicer.sliceCalls, 1);
  session.dispose();
});

await test('clears a surface projection failure when that surface detaches', async () => {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const serializer = new MemorySerializer();
  const slicer = new VerifyingSlicer();
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer,
    slicer,
  });
  let disposeCalls = 0;
  const detach = session.attachSurface({
    projectionLabel: 'Broken view',
    renderProject() {
      throw new Error('No GPU context');
    },
    renderSelection() {},
    dispose() {
      disposeCalls += 1;
    },
  });
  assert.equal(session.getProjectionHealthSnapshot().healthy, false);

  detach();
  detach();
  assert.equal(session.getProjectionHealthSnapshot().healthy, true);
  assert.equal(disposeCalls, 1);
  await session.save();
  await session.slice();
  assert.equal(serializer.serializeCalls, 1);
  assert.equal(slicer.sliceCalls, 1);
  session.dispose();
});

console.log(`\nHeadless editor session: ${passed} tests passed.`);
