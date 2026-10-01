import assert from 'node:assert/strict';
import { confirmExternalCancellation, readExternalResult, type ExternalJobContext } from '../ExternalSlicerJobs';
import { SlicerClientCancellationError } from '../SlicerClientCancellationError';
import { sha256Bytes } from '../Utf8Sha256';

const originalFetch = globalThis.fetch;
let calls: Request[] = [];
let implementation: (request: Request) => Promise<Response>;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  calls.push(request);
  return implementation(request);
};
const context: ExternalJobContext = {
  endpoint: 'http://127.0.0.1:3000',
  jobId: 'job-1',
  headers: {},
  pollIntervalMs: 1,
  cancellationTimeoutMs: 30,
};
const json = (status: string) =>
  new Response(JSON.stringify({ status }), { headers: { 'content-type': 'application/json' } });
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  calls = [];
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  for (const phase of ['delete', 'body', 'poll', 'delay'] as const) {
    await test(`one deadline bounds a hung ${phase} and aborts its requests`, async () => {
      implementation = async (request) => {
        if (phase === 'delete' || (phase === 'poll' && request.method === 'GET')) return new Promise(() => {});
        if (phase === 'body')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status":'));
                request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
              },
            }),
          );
        return json('cancelling');
      };
      const started = performance.now();
      await assert.rejects(
        confirmExternalCancellation({ ...context, pollIntervalMs: phase === 'delay' ? 5000 : 1 }),
        (error: unknown) =>
          error instanceof SlicerClientCancellationError &&
          error.outcome === 'unconfirmed' &&
          /timed out/.test(error.message),
      );
      assert.ok(performance.now() - started < 500, 'a hung stage must not escape to the outer cleanup deadline');
      assert.equal(calls.filter((request) => request.method === 'DELETE').length, 1);
      assert.equal(
        calls.every((request) => request.signal.aborted),
        true,
      );
    });
  }

  await test('cleanup is independent of the aborted slice signal and polls to confirmed cancellation', async () => {
    const slice = new AbortController();
    slice.abort();
    implementation = async (request) => {
      assert.equal(request.signal.aborted, false);
      return json(request.method === 'DELETE' ? 'cancelling' : 'cancelled');
    };
    await confirmExternalCancellation({ ...context, signal: slice.signal });
    assert.deepEqual(
      calls.map((request) => request.method),
      ['DELETE', 'GET'],
    );
    assert.equal(
      calls.every((request) => request.signal.aborted),
      true,
      'cleanup signals are retired on success too',
    );
  });

  for (const status of ['done', 'error', 'released'] as const) {
    await test(`an already-${status} job is terminal without claiming it was cancelled`, async () => {
      implementation = async () => json(status);
      await assert.rejects(
        confirmExternalCancellation(context),
        (error: unknown) =>
          error instanceof SlicerClientCancellationError &&
          !error.cancellationConfirmed &&
          error.outcome === 'already-terminal' &&
          error.terminalStatus === status,
      );
      assert.equal(calls.length, 1);
    });
  }

  await test('a lost cancellation connection reports an unconfirmed outcome without retry', async () => {
    implementation = async () => {
      throw new Error('connection lost');
    };
    await assert.rejects(
      confirmExternalCancellation(context),
      (error: unknown) => error instanceof SlicerClientCancellationError && error.outcome === 'unconfirmed',
    );
    assert.equal(calls.length, 1);
  });

  const gcode = '; valid UTF-8 G-code\nG28\n';
  const bytes = new TextEncoder().encode(gcode);
  const headers = {
    'x-orcaxr-job-id': 'job-1',
    'x-orcaxr-gcode-sha256': sha256Bytes(bytes).slice(7),
    'x-orcaxr-gcode-bytes': String(bytes.length),
  };
  await test('a result is released only after the entire download and checksum validate', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
      { headers },
    );
    implementation = async () => json('done');
    const pending = readExternalResult(response, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 0);
    stream.enqueue(bytes);
    stream.close();
    assert.equal(await pending, gcode);
    assert.deepEqual(
      calls.map((request) => [request.method, new URL(request.url).pathname]),
      [['DELETE', '/jobs/job-1']],
    );
  });

  for (const patch of [
    { 'x-orcaxr-gcode-sha256': '0'.repeat(64) },
    { 'x-orcaxr-gcode-bytes': '1' },
    { 'x-orcaxr-job-id': 'job-2' },
  ]) {
    await test(`invalid artifact metadata retains the result: ${Object.keys(patch)[0]}`, async () => {
      implementation = async () => {
        throw new Error('must not release');
      };
      await assert.rejects(readExternalResult(new Response(gcode, { headers: { ...headers, ...patch } }), context));
      assert.equal(calls.length, 0);
    });
  }

  await test('LAN hashing validates a synchronous result and ignores encoded Content-Length', async () => {
    const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    implementation = async () => json('done');
    try {
      assert.equal(
        await readExternalResult(
          new Response(gcode, { headers: { ...headers, 'content-length': '3', 'content-encoding': 'gzip' } }),
          { ...context, jobId: undefined },
        ),
        gcode,
      );
      assert.equal(calls[0].method, 'DELETE');
    } finally {
      if (crypto) Object.defineProperty(globalThis, 'crypto', crypto);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  await test('old servers without transfer evidence return their artifact without an early release', async () => {
    assert.equal(await readExternalResult(new Response(gcode), context), gcode);
    assert.equal(calls.length, 0);
  });

  for (const mode of ['unsupported', 'disconnected', 'hung'] as const) {
    await test(`a ${mode} release cannot discard a validated download`, async () => {
      implementation = async () => {
        if (mode === 'unsupported') return new Response('Not supported', { status: 409 });
        if (mode === 'disconnected') throw new Error('connection lost');
        return new Promise(() => {});
      };
      assert.equal(await readExternalResult(new Response(gcode, { headers }), context), gcode);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].signal.aborted, true);
    });
  }

  await test('malformed job IDs cannot redirect cancellation to another route', async () => {
    await assert.rejects(confirmExternalCancellation({ ...context, jobId: '..' }), /invalid job ID/);
    assert.equal(calls.length, 0);
  });
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`\nExternal slicer jobs: ${passed} tests passed.`);
