import assert from 'node:assert/strict';

import { createProjectFixture } from './fixtures';
import { projectFingerprint } from '../domain/canonical';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { WorkerProjectSerializer } from '../serialization/WorkerProjectSerializer';
import {
  PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
  type SerializeWorkerRequest,
  type SerializeWorkerResponse,
} from '../serialization/ProjectSerializerProtocol';
import type { ProjectArchiveSnapshot } from '../ports';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function snapshot(): ProjectArchiveSnapshot {
  const fixture = createProjectFixture();
  return {
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(fixture.state),
  };
}

/** A worker double that runs the real serializer, so the protocol is exercised. */
class FakeWorker {
  onmessage: ((event: MessageEvent<SerializeWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly transfers: unknown[][] = [];
  private readonly serializer = new Bbs3mfProjectSerializer();

  postMessage(request: SerializeWorkerRequest, transfer?: unknown[]): void {
    this.transfers.push(transfer ?? []);
    void (async () => {
      let response: SerializeWorkerResponse;
      try {
        const serialized = await this.serializer.serialize({
          state: request.snapshot.state,
          assets: request.snapshot.assets.map((asset) => ({ descriptor: asset.descriptor, bytes: asset.bytes })),
          sourceRevision: request.snapshot.sourceRevision,
          sourceHash: request.snapshot.sourceHash,
        });
        response = {
          protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          type: 'serialized',
          result: {
            bytes: serialized.bytes,
            mediaType: serialized.mediaType,
            suggestedFilename: serialized.suggestedFilename,
            sourceRevision: serialized.sourceRevision,
            sourceHash: serialized.sourceHash,
            warnings: serialized.warnings ?? [],
          },
        };
      } catch (error) {
        response = {
          protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          type: 'error',
          error: { name: 'Error', message: (error as Error).message },
        };
      }
      this.onmessage?.({ data: response } as MessageEvent<SerializeWorkerResponse>);
    })();
  }

  terminate(): void {
    this.terminated = true;
  }
}

await test('a worker archive is byte-identical to the one built in place', async () => {
  const worker = new FakeWorker();
  const serializer = new WorkerProjectSerializer({ createWorker: () => worker as unknown as Worker });
  const onWorker = await serializer.serialize(snapshot());
  const inPlace = await new Bbs3mfProjectSerializer().serialize(snapshot());
  assert.deepEqual(Array.from(onWorker.bytes), Array.from(inPlace.bytes), 'the archive must not depend on the thread');
  assert.equal(onWorker.sourceHash, inPlace.sourceHash);
  assert.equal(onWorker.suggestedFilename, inPlace.suggestedFilename);
  serializer.dispose();
});

await test('asset bytes are handed over rather than copied twice', async () => {
  const worker = new FakeWorker();
  const serializer = new WorkerProjectSerializer({ createWorker: () => worker as unknown as Worker });
  const source = snapshot();
  const before = Array.from(source.assets[0].bytes);
  await serializer.serialize(source);
  assert.equal(worker.transfers[0]?.length, source.assets.length, 'each asset buffer is transferred, not cloned');
  assert.deepEqual(
    Array.from(source.assets[0].bytes),
    before,
    'the caller keeps its own asset bytes: what is transferred is a copy',
  );
  serializer.dispose();
});

await test('a host with no worker still produces the archive', async () => {
  const serializer = new WorkerProjectSerializer({
    createWorker: () => {
      throw new Error('workers unavailable');
    },
  });
  const result = await serializer.serialize(snapshot());
  const inPlace = await new Bbs3mfProjectSerializer().serialize(snapshot());
  assert.deepEqual(Array.from(result.bytes), Array.from(inPlace.bytes));
  serializer.dispose();
});

await test('a worker failure is reported to the caller and the worker is recycled', async () => {
  const worker = new FakeWorker();
  const serializer = new WorkerProjectSerializer({ createWorker: () => worker as unknown as Worker });
  const pending = serializer.serialize(snapshot());
  worker.onerror?.();
  await assert.rejects(pending, /Project serializer worker failed/);
  assert.equal(worker.terminated, true, 'a failed worker is not left behind to receive the next request');
  serializer.dispose();
});

await test('disposal rejects work in flight instead of leaving it pending forever', async () => {
  const worker = new FakeWorker();
  const serializer = new WorkerProjectSerializer({ createWorker: () => worker as unknown as Worker });
  worker.postMessage = () => {};
  const pending = serializer.serialize(snapshot());
  serializer.dispose();
  await assert.rejects(pending, /disposed/);
});

console.log(`\nWorker project serializer: ${passed} tests passed.`);
