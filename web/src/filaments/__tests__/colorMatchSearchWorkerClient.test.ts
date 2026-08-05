import assert from 'node:assert/strict';

import {
  ColorMatchSearchCancelledError,
  ColorMatchSearchDisposedError,
  ColorMatchSearchSupersededError,
  ColorMatchSearchWorkerClient,
  ColorMatchSearchWorkerCrashError,
  ColorMatchSearchWorkerProtocolError,
  ColorMatchSearchWorkerRemoteError,
  ColorMatchSearchWorkerTimeoutError,
  type ColorMatchSearchWorkerLike,
} from '../ColorMatchSearchWorkerClient';
import {
  searchSuppliedPaletteColorMatch,
  type SuppliedPaletteMatchSearchInput,
} from '../../project/filaments/colorMatchSearch';
import {
  COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
  type ColorMatchSearchWorkerRequest,
  type ColorMatchSearchWorkerResponse,
} from '../../project/filaments/colorMatchSearchProtocol';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const INPUT: SuppliedPaletteMatchSearchInput = Object.freeze({
  palette: Object.freeze([
    Object.freeze({ color: '#002185', filamentType: 'PLA' }),
    Object.freeze({ color: '#FCD300', filamentType: 'PLA' }),
  ]),
  targetColor: '#2F8D38',
  minComponentPercent: 1,
});
const RESULT = searchSuppliedPaletteColorMatch(INPUT);

class FakeWorker implements ColorMatchSearchWorkerLike {
  onmessage: ((event: MessageEvent<ColorMatchSearchWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: ColorMatchSearchWorkerRequest | null = null;
  terminateCalls = 0;

  postMessage(message: ColorMatchSearchWorkerRequest): void {
    this.posted = message;
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(response: ColorMatchSearchWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<ColorMatchSearchWorkerResponse>);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function successResponse(worker: FakeWorker): ColorMatchSearchWorkerResponse {
  assert.ok(worker.posted);
  return {
    protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
    requestId: worker.posted.requestId,
    type: 'result',
    result: RESULT,
  };
}

await test('posts a versioned request ID and resolves the dedicated worker result', async () => {
  const worker = new FakeWorker();
  const client = new ColorMatchSearchWorkerClient({
    createWorker: () => worker,
    createRequestId: () => 'match-1',
    timeoutMs: 1_000,
  });
  const pending = client.search(INPUT);
  assert.deepEqual(worker.posted, {
    protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
    requestId: 'match-1',
    type: 'search',
    input: INPUT,
  });
  worker.emit(successResponse(worker));
  assert.equal(await pending, RESULT);
  assert.equal(worker.terminateCalls, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(client.cancel(), false);
});

await test('hard-stops and rejects a stale search when a newer request wins', async () => {
  const workers: FakeWorker[] = [];
  let sequence = 0;
  const client = new ColorMatchSearchWorkerClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    createRequestId: () => `latest-${++sequence}`,
    timeoutMs: 1_000,
  });

  const first = client.search(INPUT);
  const firstRejected = assert.rejects(
    first,
    (error: unknown) =>
      error instanceof ColorMatchSearchSupersededError &&
      error.supersededRequestId === 'latest-1' &&
      error.replacementRequestId === 'latest-2',
  );
  const second = client.search({ ...INPUT, targetColor: '#123456' });
  await firstRejected;
  assert.equal(workers[0].terminateCalls, 1);
  assert.equal(workers[0].onmessage, null);

  // A terminated worker's late response cannot settle the active request.
  workers[0].emit(successResponse(workers[0]));
  workers[1].emit(successResponse(workers[1]));
  assert.equal(await second, RESULT);
  assert.equal(workers[1].terminateCalls, 1);
});

await test('supports explicit cancellation and AbortSignal cancellation', async () => {
  const explicitWorker = new FakeWorker();
  const explicitClient = new ColorMatchSearchWorkerClient({
    createWorker: () => explicitWorker,
    createRequestId: () => 'cancel-explicit',
    timeoutMs: 1_000,
  });
  const explicit = explicitClient.search(INPUT);
  assert.equal(explicitClient.cancel('target changed'), true);
  await assert.rejects(
    explicit,
    (error: unknown) =>
      error instanceof ColorMatchSearchCancelledError &&
      !(error instanceof ColorMatchSearchSupersededError) &&
      /target changed/.test(error.message),
  );
  assert.equal(explicitWorker.terminateCalls, 1);
  assert.equal(explicitClient.cancel(), false);

  const abortWorker = new FakeWorker();
  const abortController = new AbortController();
  const abortClient = new ColorMatchSearchWorkerClient({
    createWorker: () => abortWorker,
    createRequestId: () => 'cancel-signal',
    timeoutMs: 1_000,
  });
  const aborted = abortClient.search(INPUT, { signal: abortController.signal });
  abortController.abort('dialog closed');
  await assert.rejects(
    aborted,
    (error: unknown) => error instanceof ColorMatchSearchCancelledError && /dialog closed/.test(error.message),
  );
  assert.equal(abortWorker.terminateCalls, 1);

  let allocations = 0;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort('already closed');
  const preAbortedClient = new ColorMatchSearchWorkerClient({
    createWorker: () => {
      allocations += 1;
      return new FakeWorker();
    },
  });
  await assert.rejects(
    preAbortedClient.search(INPUT, { signal: alreadyAborted.signal }),
    ColorMatchSearchCancelledError,
  );
  assert.equal(allocations, 0);
});

await test('uses typed protocol, remote, and crash errors and always terminates', async () => {
  const mismatchWorker = new FakeWorker();
  const mismatchClient = new ColorMatchSearchWorkerClient({
    createWorker: () => mismatchWorker,
    createRequestId: () => 'mismatch',
    timeoutMs: 1_000,
  });
  const mismatched = mismatchClient.search(INPUT);
  mismatchWorker.emit({
    ...successResponse(mismatchWorker),
    requestId: 'some-other-request',
  });
  await assert.rejects(mismatched, ColorMatchSearchWorkerProtocolError);
  assert.equal(mismatchWorker.terminateCalls, 1);

  const remoteWorker = new FakeWorker();
  const remoteClient = new ColorMatchSearchWorkerClient({
    createWorker: () => remoteWorker,
    createRequestId: () => 'remote',
    timeoutMs: 1_000,
  });
  const remote = remoteClient.search(INPUT);
  remoteWorker.emit({
    protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
    requestId: 'remote',
    type: 'error',
    error: { name: 'RangeError', message: 'bad\npalette' },
  });
  await assert.rejects(
    remote,
    (error: unknown) =>
      error instanceof ColorMatchSearchWorkerRemoteError &&
      error.remoteName === 'RangeError' &&
      error.message === 'bad palette',
  );
  assert.equal(remoteWorker.terminateCalls, 1);

  const crashWorker = new FakeWorker();
  const crashClient = new ColorMatchSearchWorkerClient({
    createWorker: () => crashWorker,
    createRequestId: () => 'crash',
    timeoutMs: 1_000,
  });
  const crashed = crashClient.search(INPUT);
  crashWorker.crash('out of memory');
  await assert.rejects(crashed, ColorMatchSearchWorkerCrashError);
  assert.equal(crashWorker.terminateCalls, 1);
});

await test('times out stalled work with a hard worker stop', async () => {
  const worker = new FakeWorker();
  const client = new ColorMatchSearchWorkerClient({
    createWorker: () => worker,
    createRequestId: () => 'timeout',
    timeoutMs: 5,
  });
  await assert.rejects(client.search(INPUT), ColorMatchSearchWorkerTimeoutError);
  assert.equal(worker.terminateCalls, 1);
});

await test('dispose rejects active and future work without allocating another worker', async () => {
  const workers: FakeWorker[] = [];
  const client = new ColorMatchSearchWorkerClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    createRequestId: () => `dispose-${workers.length + 1}`,
    timeoutMs: 1_000,
  });
  const pending = client.search(INPUT);
  client.dispose();
  client.dispose();
  await assert.rejects(pending, ColorMatchSearchDisposedError);
  assert.equal(workers[0].terminateCalls, 1);
  await assert.rejects(client.search(INPUT), ColorMatchSearchDisposedError);
  assert.equal(workers.length, 1);
});

await test('validates request identity before superseding or allocating work', async () => {
  let allocations = 0;
  const client = new ColorMatchSearchWorkerClient({
    createWorker: () => {
      allocations += 1;
      return new FakeWorker();
    },
    createRequestId: () => 'unsafe request id',
  });
  assert.throws(() => client.search(INPUT), ColorMatchSearchWorkerProtocolError);
  assert.equal(allocations, 0);
});

console.log(`\nColor Match search worker client: ${passed} tests passed.`);
