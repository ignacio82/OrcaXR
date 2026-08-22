import assert from 'node:assert/strict';

import { SlicerClient } from '../SlicerClient.ts';

/**
 * Warming the engine must stay a DOWNLOAD, never an instantiation.
 *
 * `factory()` commits a 256 MB shared heap and preallocates ten Web Workers
 * before it resolves, so instantiating on import put a quarter-gigabyte spike
 * 1.2 s behind every model the operator opened — in the renderer process that
 * was already holding that model. These assertions are what keep the warm-up
 * from drifting back into `load()`.
 */

let passed = 0;
function test(name: string, run: () => Promise<void> | void): Promise<void> {
  return Promise.resolve(run()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

interface FetchCall {
  readonly url: string;
  readonly drained: boolean;
}

/** Stub `fetch` with a two-chunk body so draining is observable. */
function stubFetch(calls: FetchCall[], options: { ok?: boolean; body?: boolean } = {}) {
  return (input: string | URL) => {
    const url = String(input);
    const record = { url, drained: false };
    calls.push(record as FetchCall);
    if (options.ok === false) return Promise.resolve({ ok: false, body: null } as unknown as Response);
    if (options.body === false) return Promise.resolve({ ok: true, body: null } as unknown as Response);
    let remaining = 2;
    const body = {
      getReader: () => ({
        read: () => {
          if (remaining-- > 0) return Promise.resolve({ done: false, value: new Uint8Array(8) });
          (record as { drained: boolean }).drained = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    return Promise.resolve({ ok: true, body } as unknown as Response);
  };
}

const originalFetch = globalThis.fetch;
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
Object.defineProperty(globalThis, 'self', {
  configurable: true,
  value: { location: { origin: 'https://orcaxr.example' } },
});

try {
  await test('prefetch pulls the glue and the wasm, and drains both to cache them', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls) as typeof fetch;

    await new SlicerClient().prefetchEngine();

    assert.deepEqual(
      calls.map((call) => call.url),
      ['https://orcaxr.example/slicer/slic3r.mjs', 'https://orcaxr.example/slicer/slic3r.wasm'],
      'both halves of the engine travel together — Emscripten resolves the wasm beside the glue',
    );
    // Reading to completion is what commits the response to the HTTP cache; a
    // prefetch that abandons the body warms nothing.
    assert.deepEqual(
      calls.map((call) => call.drained),
      [true, true],
    );
  });

  await test('a prefetch never instantiates the module', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls) as typeof fetch;

    const client = new SlicerClient();
    await client.prefetchEngine();

    // `import()`ing the glue is the only route to a module, and it would have
    // had to run for one to exist. Nothing was instantiated, so nothing is
    // slicing and no heap was committed.
    assert.equal(client.isSlicing, false);
    assert.equal(
      (client as unknown as { module: unknown }).module,
      null,
      'prefetch must not leave an instantiated module behind',
    );
    assert.equal(
      (client as unknown as { loading: unknown }).loading,
      null,
      'prefetch must not start an instantiation either',
    );
  });

  await test('an already-loading engine is not fetched a second time', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = stubFetch(calls) as typeof fetch;

    const client = new SlicerClient();
    (client as unknown as { loading: unknown }).loading = Promise.resolve({});
    await client.prefetchEngine();

    assert.deepEqual(calls, [], 'a Slice already in flight owns the bytes; prefetching again is waste');
  });

  await test('an unavailable engine leaves the prefetch quiet rather than failing the import', async () => {
    globalThis.fetch = stubFetch([], { ok: false }) as typeof fetch;
    await new SlicerClient().prefetchEngine();

    // A body-less response (a 304 or an opaque cache hit) is equally harmless.
    globalThis.fetch = stubFetch([], { body: false }) as typeof fetch;
    await new SlicerClient().prefetchEngine();
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
  else delete (globalThis as { self?: unknown }).self;
}

console.log(`\n${passed} engine prefetch tests passed.`);
