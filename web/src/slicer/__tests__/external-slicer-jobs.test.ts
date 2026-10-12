import assert from 'node:assert/strict';
import {
  confirmExternalCancellation,
  pollExternalJob,
  readCancelReply,
  readExternalResult,
  readJobPoll,
  readSubmission,
  type ExternalJobContext,
} from '../ExternalSlicerJobs';
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

  await test('a failed job without its reason does not read as "undefined" or nothing', async () => {
    for (const error of [undefined, 42, '', ' \n']) {
      const step = readJobPoll(0, { status: 200, body: JSON.stringify({ status: 'error', error }) });
      assert.equal(step.kind, 'failed');
      if (step.kind === 'failed') assert.equal(step.error.message, 'External Slicer Failed: no reason was given');
    }
  });

  await test('a refusal with a blank body reads as its HTTP status', async () => {
    for (const body of ['', '  \n']) {
      const submission = readSubmission({ status: 413, body }, false);
      assert.equal(submission.kind, 'failed');
      if (submission.kind === 'failed') assert.equal(submission.error.message, 'External Slicer Failed: HTTP 413');
      await assert.rejects(readExternalResult(new Response(body, { status: 503 }), context), {
        message: 'External Slicer Failed: HTTP 503',
      });
    }
    const named = readSubmission({ status: 400, body: 'Missing project file.' }, false);
    if (named.kind === 'failed') assert.equal(named.error.message, 'External Slicer Failed: Missing project file.');
  });

  await test('progress is always a number and a sentence', async () => {
    for (const [percent, message, expected] of [
      ['50', 7, { percent: 0, message: 'Slicing externally...' }],
      [null, { text: 'x' }, { percent: 0, message: 'Slicing externally...' }],
      [10, ' ', { percent: 10, message: 'Slicing externally...' }],
      [42.5, 'Generating supports', { percent: 42.5, message: 'Generating supports' }],
    ] as const) {
      const step = readJobPoll(3, { status: 200, body: JSON.stringify({ status: 'running', percent, message }) });
      assert.deepEqual(step, { kind: 'wait', failures: 0, progress: expected });
    }
  });

  await test('replies that are not JSON objects read the same in every engine', async () => {
    for (const body of ['null', 'not json']) {
      const poll = readJobPoll(4, { status: 200, body });
      assert.equal(poll.kind, 'failed');
      if (poll.kind === 'failed')
        assert.equal(
          poll.error.message,
          `External slicer stopped responding: ${body === 'null' ? 'Unknown job state.' : 'The server returned an unreadable reply.'}`,
        );
      const cancel = readCancelReply({ status: 200, body });
      assert.equal(cancel.kind, 'failed');
      if (cancel.kind === 'failed')
        assert.equal(
          cancel.error.message,
          `Could not confirm external slice cancellation: ${body === 'null' ? 'The server returned an unknown job state.' : 'The server returned an unreadable reply.'}`,
        );
    }
    for (const body of ['null', 'not json']) {
      const submission = readSubmission({ status: 202, body }, false);
      assert.equal(submission.kind, 'failed');
      if (submission.kind === 'failed')
        assert.equal(submission.error.message, 'External slicer returned an invalid async job ID.');
    }
  });

  await test('an artifact that is not UTF-8 reads the same in every engine and is retained', async () => {
    implementation = async () => {
      throw new Error('must not release');
    };
    const invalid = new Uint8Array([0x47, 0x32, 0x38, 0xff, 0x0a]);
    await assert.rejects(
      readExternalResult(
        new Response(invalid, {
          headers: {
            'x-orcaxr-job-id': 'job-1',
            'x-orcaxr-gcode-sha256': sha256Bytes(invalid).slice(7),
            'x-orcaxr-gcode-bytes': String(invalid.length),
          },
        }),
        context,
      ),
      { message: 'External slicer returned an artifact that is not valid UTF-8 text.' },
    );
    assert.equal(calls.length, 0);
  });

  await test('malformed job IDs cannot redirect cancellation to another route', async () => {
    await assert.rejects(confirmExternalCancellation({ ...context, jobId: '..' }), /invalid job ID/);
    assert.equal(calls.length, 0);
  });

  // The server keeps a finished result until it is released or expires: a
  // transfer that fails is fetched again, never sliced again. The client used
  // to say "retained for retry" and then never fetched it.
  const sliced = new TextEncoder().encode('; sliced\nG28\n');
  const identity = {
    'x-orcaxr-job-id': 'job-1',
    'x-orcaxr-gcode-sha256': sha256Bytes(sliced).slice(7),
    'x-orcaxr-gcode-bytes': String(sliced.length),
  };
  const artifact = (bytes: Uint8Array = sliced) => new Response(bytes.slice(), { headers: identity });
  const cut = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(sliced.subarray(0, 4));
          controller.error(new TypeError('network error'));
        },
      }),
      { headers: identity },
    );
  const route = (request: Request) => `${request.method} ${new URL(request.url).pathname}`;

  await test('a download cut off is fetched again from the result the server keeps, then released', async () => {
    let downloads = 0;
    implementation = async (request) => {
      if (request.url.endsWith('/gcode')) return ++downloads === 1 ? cut() : artifact();
      return json('done');
    };
    assert.equal(await pollExternalJob(context), '; sliced\nG28\n');
    assert.deepEqual(calls.map(route), [
      'GET /jobs/job-1',
      'GET /jobs/job-1/gcode',
      'GET /jobs/job-1/gcode',
      'DELETE /jobs/job-1',
    ]);
  });

  await test('a download that does not match its checksum is fetched again, with the same checks', async () => {
    let downloads = 0;
    const damaged = sliced.slice();
    damaged[0] ^= 1;
    implementation = async (request) => {
      if (request.url.endsWith('/gcode')) return ++downloads < 3 ? artifact(damaged) : artifact();
      return json('done');
    };
    assert.equal(await pollExternalJob(context), '; sliced\nG28\n');
    assert.equal(downloads, 3);
    assert.equal(calls.filter((request) => request.method === 'DELETE').length, 1);
  });

  await test('a download that keeps failing ends as its transfer did, after three attempts, unreleased', async () => {
    implementation = async (request) => (request.url.endsWith('/gcode') ? cut() : json('done'));
    await assert.rejects(pollExternalJob(context), (error: unknown) => error instanceof TypeError);
    assert.equal(calls.filter((request) => request.url.endsWith('/gcode')).length, 3);
    assert.equal(calls.filter((request) => request.method === 'DELETE').length, 0);
  });

  await test('a refusal is the server’s answer and is never fetched again', async () => {
    implementation = async (request) =>
      request.url.endsWith('/gcode') ? new Response('{"error":"expired"}', { status: 410 }) : json('done');
    await assert.rejects(pollExternalJob(context), { message: 'External Slicer Failed: {"error":"expired"}' });
    assert.equal(calls.filter((request) => request.url.endsWith('/gcode')).length, 1);
  });

  await test('a cancel while a download is fetched again ends as already done, not cancelled', async () => {
    const slice = new AbortController();
    implementation = async (request) => {
      if (request.url.endsWith('/gcode')) {
        slice.abort(new Error('Cancelled by user'));
        return cut();
      }
      return json('done');
    };
    await assert.rejects(
      pollExternalJob({ ...context, signal: slice.signal }),
      (error: unknown) => error instanceof SlicerClientCancellationError && error.outcome === 'already-terminal',
    );
    assert.equal(calls.filter((request) => request.url.endsWith('/gcode')).length, 1);
  });

  await test('a job ID no URL can carry fails at once, not as unanswered polls', async () => {
    implementation = async () => json('running');
    const started = performance.now();
    await assert.rejects(pollExternalJob({ ...context, jobId: 'a/b', pollIntervalMs: 1000 }), {
      message: 'The external slicer returned an invalid job ID.',
    });
    assert.equal(calls.length, 0);
    assert.ok(performance.now() - started < 500);
  });
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`\nExternal slicer jobs: ${passed} tests passed.`);
