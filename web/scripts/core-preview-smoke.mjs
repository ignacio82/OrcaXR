import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview({
  headers: {
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'Cross-Origin-Embedder-Policy': 'unsafe-none',
  },
});
let failure = '',
  coreRequests = 0,
  held;
// A fresh non-isolated origin with SW registration unavailable exercises the
// production HTTP loader rather than satisfying failure cases from a cache.
server.middlewares.stack.unshift({
  route: '',
  handle: (req, res, next) => {
    if (req.url === '/sw.js' || req.url === '/coi-serviceworker.js') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!req.url.startsWith('/core/')) return next();
    coreRequests++;
    const kind = req.url.endsWith('.wasm') ? 'wasm' : 'manifest';
    if (failure === `hold-${kind}`) {
      held = res;
      return;
    }
    if (failure === `missing-${kind}`) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (failure === `corrupt-${kind}`) {
      const path = new URL('../dist' + req.url, import.meta.url);
      void readFile(path).then((bytes) => {
        bytes[0] ^= 1;
        res.end(bytes);
      }, next);
      return;
    }
    next();
  },
});
const browser = await launchBrowser();
try {
  const page = await openReadyPage(browser, url, undefined, async (page) => {
    await page.evaluateOnNewDocument(() => {
      const NativeWorker = globalThis.Worker;
      globalThis.__coreWorkers = [];
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          if (!String(url).includes('gcodePreview.worker')) return;
          const record = { terminated: false, adapters: [] };
          globalThis.__coreWorkers.push(record);
          this.addEventListener('message', (event) => {
            if (event.data.type === 'ready') record.adapters.push(event.data.snapshot.adapter);
          });
          const terminate = this.terminate.bind(this);
          this.terminate = () => {
            record.terminated = true;
            terminate();
          };
        }
      };
    });
  });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), false);
  assert.equal(coreRequests, 0, 'startup never fetches or instantiates optional computation');
  assert.equal(await page.evaluate(() => globalThis.__coreWorkers.length), 0);
  const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary());
  for (failure of ['missing-manifest', 'corrupt-manifest', 'missing-wasm', 'corrupt-wasm']) {
    const result = await page.evaluate(async () => {
      const workspace = globalThis.window.workspace;
      return {
        opened: await workspace.openGcodeForPreview(
          'M83\n;LAYER_CHANGE\n;TYPE:Outer wall\nG1 X10 E1 F1200\n',
          'fault.gcode',
        ),
        state: workspace.getPreviewState(),
        workers: globalThis.__coreWorkers,
      };
    });
    assert.equal(result.opened, false, failure);
    assert.match(result.state.unsupportedReason, /shared preview component/i, failure);
    assert.ok(
      result.workers.every((worker) => worker.terminated && worker.adapters.length === 0),
      failure,
    );
    assert.deepEqual(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary()), before);
  }
  failure = 'hold-wasm';
  await page.evaluate(() => {
    globalThis.__coreOpening = globalThis.window.workspace.openGcodeForPreview('M83\nG1 X10 E1 F1200\n', 'held.gcode');
  });
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (held) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 15_000) {
        clearInterval(timer);
        reject(new Error('No pending WASM fetch'));
      }
    }, 20);
  });
  await page.click('[data-view-tab="prepare"]');
  assert.equal(await page.evaluate(() => globalThis.__coreOpening), false);
  assert.equal(await page.evaluate(() => globalThis.__coreWorkers.every((worker) => worker.terminated)), true);
  held.destroy();
  held = undefined;
  failure = '';
  assert.equal(
    await page.evaluate(() =>
      globalThis.window.workspace.openGcodeForPreview(
        'M83\n;LAYER_CHANGE\n;TYPE:Outer wall\nG1 X10 E1 F1200\n',
        'retry.gcode',
      ),
    ),
    true,
    'explicit retry succeeds after the service recovers',
  );
  assert.deepEqual(await page.evaluate(() => globalThis.__coreWorkers.at(-1).adapters), ['rust']);
  console.log(
    'Production core loader: non-isolated CSP, idle startup, corrupt/missing pair refusals, fetch cancellation and explicit retry passed.',
  );
} finally {
  held?.destroy();
  await browser.close();
  await server.close();
}
