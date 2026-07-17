import assert from 'node:assert/strict';
import {
  AddObjectCommand,
  EditorSession,
  InMemoryAssetRepository,
  RenameProjectCommand,
  SetInstanceTransformCommand,
  StaleProjectResultError,
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
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class MemorySerializer implements ProjectSerializerPort {
  async serialize(snapshot: ProjectArchiveSnapshot): Promise<SerializedProject> {
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

  async slice(request: SliceRequest): Promise<SliceResult> {
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

console.log(`\nHeadless editor session: ${passed} tests passed.`);
