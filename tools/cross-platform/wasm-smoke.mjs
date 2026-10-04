// Exercises actual wasm-bindgen output in owned browser workers, without COOP/COEP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser } from '../../web/scripts/preview-harness.mjs';

const root = new URL('../../', import.meta.url);
const corpus = JSON.parse(await readFile(new URL('testdata/cross-platform/canonical-vectors.json', root)));
const schema = JSON.parse(await readFile(new URL('contracts/core-protocol.json', root)));
const workerSource = `
import initialize, { core_info, evaluate } from '/wasm/orcaxr_core.js';
const exports = await initialize({ module_or_path: new URL(self.location.href).searchParams.has('missing')
  ? '/missing.wasm' : '/wasm/orcaxr_core_bg.wasm' });
self.onmessage = ({data}) => {
  const result = JSON.parse(evaluate(JSON.stringify(data)));
  self.postMessage({result, memoryBytes: exports.memory.buffer.byteLength});
};
self.postMessage({ready: JSON.parse(core_info())});
`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'");
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>OrcaXR core boundary tests</title>'); }
    else if (path === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerSource); }
    else if (['/wasm/orcaxr_core.js', '/wasm/orcaxr_core_bg.wasm'].includes(path)) {
      response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(await readFile(new URL(`core/dist${path}`, root)));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({corpus, schema}) => {
    const check = (value, label) => { if (!value) throw new Error(label); };
    const clients = new Set();
    // This test owner explicitly terminates the worker to cancel synchronous
    // leaf computation. Project-session cancellation is a separate later API.
    const start = async ({missing = false, expectedVersion = 1} = {}) => {
      const worker = new Worker(`/worker.mjs${missing ? '?missing' : ''}`, {type: 'module'});
      let closed = false;
      const pending = new Map();
      let rejectReady;
      const close = () => {
        if (closed) return;
        closed = true;
        worker.terminate();
        clients.delete(close);
        for (const {reject} of pending.values()) reject(new Error('Core disposed'));
        pending.clear();
        rejectReady?.(new Error('Core unavailable'));
      };
      clients.add(close);
      const ready = new Promise((resolve, reject) => {
        rejectReady = reject;
        worker.onerror = event => { event.preventDefault(); close(); };
        worker.onmessage = ({data}) => {
          if (data.ready) {
            const expected = {...schema['x-orcaxr'], protocolVersion: expectedVersion};
            delete expected.maxOutputBytes;
            if (!Object.entries(expected).every(([name, value]) => data.ready[name] === value)) { close(); return; }
            resolve();
          } else {
            const id = data.result.requestId;
            const request = pending.get(id);
            if (!request) { close(); return; }
            pending.delete(id);
            request.resolve(data);
          }
        };
      });
      const timeout = setTimeout(close, 15000);
      try { await ready; } catch (error) { close(); throw error; }
      finally { clearTimeout(timeout); rejectReady = undefined; }
      return {
        close,
        evaluate(input, id) {
          if (closed) return Promise.reject(new Error('Core disposed'));
          if (pending.has(id)) return Promise.reject(new Error('Duplicate request'));
          return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject});
            worker.postMessage({protocolVersion: 1, requestId: id, operation: 'canonicalize', input});
          });
        },
      };
    };
    try {
      check(!crossOriginIsolated, 'Test must exercise non-isolated browser WASM');
      const client = await start();
      for (const vector of corpus.vectors) {
        const {result} = await client.evaluate(vector.input, vector.id);
        check(result.type === 'canonicalized', `Wrong result type: ${vector.id}`);
        for (const field of ['canonical', 'semanticHash', 'sha256']) check(result[field] === vector[field], `${vector.id}:${field}`);
      }
      for (const vector of corpus.invalid) {
        const {result} = await client.evaluate(vector.input, vector.id);
        check(result.error.code === vector.code, `Wrong error: ${vector.id}`);
      }
      const large = JSON.stringify('x'.repeat(schema['x-orcaxr'].maxInputBytes - 2));
      let warmBytes, finalBytes;
      for (let iteration = 0; iteration < 40; iteration++) {
        const reply = await client.evaluate(large, `large-${iteration}`);
        check(reply.result.canonical === large, 'Large payload changed');
        if (iteration === 19) warmBytes = reply.memoryBytes;
        if (iteration === 39) finalBytes = reply.memoryBytes;
      }
      check(finalBytes === warmBytes, 'WASM linear memory kept growing after warmup');
      client.close();
      for (let index = 0; index < 10; index++) {
        const repeated = await start();
        const cancelled = repeated.evaluate(large, 'cancel').then(() => false, () => true);
        repeated.close(); repeated.close();
        check(await cancelled, 'Disposal must reject pending work');
        check(await repeated.evaluate('null', 'after-close').then(() => false, () => true), 'Disposed owner accepted work');
      }
      check(await start({expectedVersion: 99}).then(client => {client.close(); return false;}, () => true), 'Mismatched binary accepted');
      check(await start({missing: true}).then(client => {client.close(); return false;}, () => true), 'Missing WASM accepted');
      check(clients.size === 0, 'Worker owners retained');
      return {vectors: corpus.vectors.length, invalid: corpus.invalid.length, largePayloadRepeats: 40,
        wasmLinearMemoryBytes: finalBytes, disposalCycles: 10, crossOriginIsolated};
    } finally { for (const close of clients) close(); }
  }, {corpus, schema});
  assert.equal(result.vectors, corpus.vectors.length);
  const output = new URL('tools/cross-platform/results/', root);
  await mkdir(output, {recursive: true});
  await writeFile(new URL('wasm-smoke.json', output), JSON.stringify({browser: await browser.version(), ...result}, null, 2) + '\n');
  console.log(`Browser WASM: ${JSON.stringify(result)}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
