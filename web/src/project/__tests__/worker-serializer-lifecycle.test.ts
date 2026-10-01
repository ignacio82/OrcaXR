import assert from 'node:assert/strict';
import { WorkerProjectSerializer } from '../serialization/WorkerProjectSerializer';
import { createProjectFixture } from './fixtures';
import { projectFingerprint } from '../domain/canonical';
import type { ProjectArchiveSnapshot, ProjectSerializerPort } from '../ports';

const fixture = createProjectFixture();
const snapshot: ProjectArchiveSnapshot = {
  state: fixture.state,
  assets: [fixture.asset],
  sourceRevision: 0,
  sourceHash: projectFingerprint(fixture.state),
};
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`  ✓ ${name}`);
  passed++;
}
class HungWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}
function fallback() {
  let calls = 0;
  const port: ProjectSerializerPort = {
    async serialize(source) {
      calls++;
      return {
        bytes: new Uint8Array([1]),
        suggestedFilename: 'test.3mf',
        mediaType: 'application/zip',
        sourceRevision: source.sourceRevision,
        sourceHash: source.sourceHash,
      };
    },
    deserialize: async () => ({
      state: fixture.state,
      assets: [fixture.asset],
      warnings: [],
    }),
  };
  return { port, calls: () => calls };
}
async function boundedRejection(pending: Promise<unknown>, pattern: RegExp) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('test settlement deadline exceeded')), 250);
        }),
      ]),
      pattern,
    );
  } finally {
    clearTimeout(timer);
  }
}

await test('recovery never uses a main-thread fallback and does not repeatedly construct a failed worker', async () => {
  const { port, calls } = fallback();
  let attempts = 0;
  const serializer = new WorkerProjectSerializer({
    fallback: port,
    createWorker: () => {
      attempts++;
      throw new Error('Unavailable');
    },
  });
  await assert.rejects(serializer.serialize(snapshot, undefined, { purpose: 'recovery' }), /worker.*unavailable/i);
  await assert.rejects(serializer.serialize(snapshot, undefined, { purpose: 'recovery' }), /worker.*unavailable/i);
  assert.equal(attempts, 1);
  assert.equal(calls(), 0);
  await serializer.serialize(snapshot, undefined, { purpose: 'manual' });
  assert.equal(calls(), 1);
  serializer.dispose();
});

await test('cancellation settles a hung request and terminates its owned worker', async () => {
  const worker = new HungWorker();
  const serializer = new WorkerProjectSerializer({
    createWorker: () => worker as unknown as Worker,
  });
  const token = { aborted: false };
  const pending = serializer.serialize(snapshot, token);
  token.aborted = true;
  await boundedRejection(pending, /cancelled/i);
  assert.equal(worker.terminated, true);
  serializer.dispose();
});

await test('a malformed response rejects all outstanding requests instead of hanging them', async () => {
  const worker = new HungWorker();
  const serializer = new WorkerProjectSerializer({
    createWorker: () => worker as unknown as Worker,
  });
  const a = serializer.serialize(snapshot);
  const b = serializer.serialize(snapshot);
  const settled = Promise.all([boundedRejection(a, /invalid.*response/i), boundedRejection(b, /invalid.*response/i)]);
  worker.onmessage?.({ data: { protocolVersion: 99 } } as MessageEvent);
  await settled;
  assert.equal(worker.terminated, true);
  serializer.dispose();
});

await test('timeouts settle and recycle a worker that sends no response', async () => {
  const worker = new HungWorker();
  const serializer = new WorkerProjectSerializer({
    createWorker: () => worker as unknown as Worker,
    timeoutMs: 10,
  });
  await boundedRejection(serializer.serialize(snapshot), /timed out/i);
  assert.equal(worker.terminated, true);
  serializer.dispose();
});

await test('disposed serializers cannot start a worker or a fallback', async () => {
  const { port, calls } = fallback();
  const serializer = new WorkerProjectSerializer({ fallback: port });
  serializer.dispose();
  await assert.rejects(serializer.serialize(snapshot), /disposed/i);
  await assert.rejects(serializer.deserialize(new Uint8Array()), /disposed/i);
  assert.equal(calls(), 0);
});

await test('disposal settles an asynchronous manual fallback and ignores its late result', async () => {
  const { port } = fallback();
  port.serialize = () => new Promise(() => {});
  const serializer = new WorkerProjectSerializer({
    fallback: port,
    createWorker: () => {
      throw new Error('Unavailable');
    },
  });
  const pending = serializer.serialize(snapshot, undefined, {
    purpose: 'manual',
  });
  serializer.dispose();
  await boundedRejection(pending, /disposed/i);
});

await test('explicit manual export can fall back after an asynchronous worker load failure', async () => {
  const worker = new HungWorker();
  const { port, calls } = fallback();
  const serializer = new WorkerProjectSerializer({ createWorker: () => worker as unknown as Worker, fallback: port });
  const pending = serializer.serialize(snapshot, undefined, { purpose: 'manual' });
  worker.onerror?.();
  await pending;
  assert.equal(calls(), 1);
  assert.equal(worker.terminated, true);
  serializer.dispose();
});

console.log(`\n${passed} worker lifecycle tests passed.`);
