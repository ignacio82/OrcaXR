import assert from 'node:assert/strict';

import {
  BbsProjectImportWorkerClient,
  BbsProjectImportWorkerTimeoutError,
  type BbsImportWorkerLike,
} from '../BbsProjectImportWorkerClient';
import {
  BBS_IMPORT_WORKER_PROTOCOL_VERSION,
  type BbsImportWorkerRequest,
  type BbsImportWorkerResponse,
} from '../../project/import/BbsProjectImportProtocol';
import { createEmptyProject } from '../../project/domain/model';
import { UuidIdSource, seededRandom } from '../../project/domain/ids';
import { projectFingerprint } from '../../project/domain/canonical';
import { ImportCancellationController } from '../../project/import/types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeWorker implements BbsImportWorkerLike {
  onmessage: ((event: MessageEvent<BbsImportWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted?: BbsImportWorkerRequest;
  terminated = false;

  constructor(private readonly respond?: (request: BbsImportWorkerRequest) => BbsImportWorkerResponse) {}

  postMessage(message: BbsImportWorkerRequest): void {
    this.posted = message;
    if (this.respond) queueMicrotask(() => this.onmessage?.({ data: this.respond!(message) } as MessageEvent));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function parseRequest(cancellation?: ImportCancellationController['token']) {
  const state = createEmptyProject({
    idSource: new UuidIdSource(seededRandom(0xb85)),
    now: '2026-07-20T12:00:00.000Z',
  });
  return {
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
    source: { filename: 'worker.3mf' },
    mode: 'replace' as const,
    base: {
      state,
      assets: [],
      sourceRevision: 0,
      sourceHash: projectFingerprint(state),
    },
    cancellation,
  };
}

await test('uses a versioned short-lived worker and returns its parsed proposal', async () => {
  const state = parseRequest().base.state;
  const worker = new FakeWorker((message) => ({
    protocolVersion: BBS_IMPORT_WORKER_PROTOCOL_VERSION,
    requestId: message.requestId,
    type: 'parsed',
    result: { state, assets: [], importedAssetIds: [] },
  }));
  const client = new BbsProjectImportWorkerClient({
    createWorker: () => worker,
    createRequestId: () => 'request-1',
    timeoutMs: 1_000,
  });

  const result = await client.parse(parseRequest());
  assert.equal(result.state.id, state.id);
  assert.equal(worker.posted?.protocolVersion, BBS_IMPORT_WORKER_PROTOCOL_VERSION);
  assert.equal(worker.posted?.requestId, 'request-1');
  assert.equal(worker.posted?.request.mode, 'replace');
  assert.equal('base' in (worker.posted?.request ?? {}), false);
  assert.equal(worker.terminated, true);
});

await test('rejects merge mode before allocating or cloning a worker request', async () => {
  let allocations = 0;
  const client = new BbsProjectImportWorkerClient({
    createWorker: () => {
      allocations += 1;
      return new FakeWorker();
    },
  });
  await assert.rejects(client.parse({ ...parseRequest(), mode: 'merge' }), /replace mode/);
  assert.equal(allocations, 0);
});

await test('terminates promptly when a mutable cancellation token aborts', async () => {
  const worker = new FakeWorker();
  const cancellation = new ImportCancellationController();
  const client = new BbsProjectImportWorkerClient({
    createWorker: () => worker,
    createRequestId: () => 'request-cancel',
    timeoutMs: 1_000,
  });
  const pending = client.parse(parseRequest(cancellation.token));
  cancellation.cancel('user cancelled import');
  await assert.rejects(pending, /user cancelled import/);
  assert.equal(worker.terminated, true);
});

await test('rejects mismatched protocol responses and bounded timeouts', async () => {
  const mismatch = new FakeWorker((message) => ({
    protocolVersion: BBS_IMPORT_WORKER_PROTOCOL_VERSION,
    requestId: `${message.requestId}-other`,
    type: 'error',
    error: { name: 'Error', message: 'wrong job' },
  }));
  const mismatchedClient = new BbsProjectImportWorkerClient({
    createWorker: () => mismatch,
    createRequestId: () => 'request-mismatch',
    timeoutMs: 1_000,
  });
  await assert.rejects(mismatchedClient.parse(parseRequest()), /mismatched protocol/);
  assert.equal(mismatch.terminated, true);

  const stalled = new FakeWorker();
  const timeoutClient = new BbsProjectImportWorkerClient({
    createWorker: () => stalled,
    createRequestId: () => 'request-timeout',
    timeoutMs: 5,
  });
  await assert.rejects(timeoutClient.parse(parseRequest()), BbsProjectImportWorkerTimeoutError);
  assert.equal(stalled.terminated, true);
});

await test('validates request identity before allocating a worker', async () => {
  let allocations = 0;
  const client = new BbsProjectImportWorkerClient({
    createWorker: () => {
      allocations += 1;
      return new FakeWorker();
    },
    createRequestId: () => 'unsafe request id',
  });
  assert.throws(() => client.parse(parseRequest()), /request ID/);
  assert.equal(allocations, 0);
});

console.log(`\nBBS project import worker client: ${passed} tests passed.`);
