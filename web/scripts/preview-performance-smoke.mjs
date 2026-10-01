import assert from 'node:assert/strict';
import { launchBrowser, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__previewWorkers = [];
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes('gcodePreview.worker')) return;
        const record = { terminated: false, windows: [] };
        globalThis.__previewWorkers.push(record);
        this.addEventListener('message', (event) => {
          if (event.data.type === 'ready')
            record.windows.push({
              count: event.data.snapshot.model.columns.count,
              offset: event.data.snapshot.model.recordOffset,
            });
        });
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          record.terminated = true;
          terminate();
        };
      }
    };
  });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  const evidence = await page.evaluate(async () => {
    const workspace = globalThis.window.workspace;
    const before = workspace.getCanonicalSummary();
    const source =
      'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2 F1200\n;TYPE:Outer wall\n' + 'G1 X1 E0.02\nG1 X2 E0.02\n'.repeat(150_000);
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 10);
    const start = performance.now();
    const opened = await workspace.openGcodeForPreview(source, 'generated-300k.gcode');
    const durationMs = performance.now() - start;
    clearInterval(timer);
    return {
      before,
      after: workspace.getCanonicalSummary(),
      opened,
      heartbeats,
      durationMs,
      state: workspace.getPreviewState(),
    };
  });
  assert.equal(evidence.opened, true);
  assert.deepEqual(evidence.after, evidence.before, 'preview does not edit canonical state');
  assert.ok(evidence.heartbeats > 2, 'main-thread timers continue while the actual worker indexes');
  assert.equal(evidence.state.window.firstRecord, 0);
  assert.equal(evidence.state.window.lastRecord, 239_999);
  assert.equal(evidence.state.window.totalRecords, 300_002);
  assert.match(evidence.state.limitations[0], /fully indexed/);
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-gcode-preview-panel]')?.closest('details')?.setAttribute('open', '');
    globalThis.window.__orcaUi.update({ mode: 'preview' });
    globalThis.document.querySelector('[data-gcode-preview-panel] [data-preview-window-step="1"]').click();
  });
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().window.firstRecord === 240_000);
  let state = await page.evaluate(() => globalThis.window.workspace.getPreviewState());
  assert.equal(state.window.lastRecord, 300_001);
  assert.equal(state.window.hasNext, false);
  assert.equal(state.window.hasPrevious, true);
  await page.evaluate(() =>
    globalThis.document.querySelector('[data-preview-scrubber] [data-preview-window-step="-1"]').click(),
  );
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().window.firstRecord === 0);
  await page.evaluate(async () => {
    const ctx = globalThis.window.__orcaCtx;
    await ctx.registry.invoke('preview_configure', 'xr-inspector', ctx, ctx.ui.get(), {
      previewView: { windowStep: 1 },
    });
  });
  state = await page.evaluate(() => globalThis.window.workspace.getPreviewState());
  assert.equal(state.window.firstRecord, 240_000, 'XR registry path reaches the same bounded window');
  const replacement = await page.evaluate(async () => {
    const workspace = globalThis.window.workspace;
    const large =
      'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2 F1200\n;TYPE:Outer wall\n' + 'G1 X1 E0.02\nG1 X2 E0.02\n'.repeat(500_000);
    const first = workspace.openGcodeForPreview(large, 'obsolete.gcode');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = workspace.openGcodeForPreview(
      'M83\n;LAYER_CHANGE\n;TYPE:Outer wall\nG1 X10 E1 F1200\n',
      'replacement.gcode',
    );
    return {
      outcomes: await Promise.all([first, second]),
      state: workspace.getPreviewState(),
      workers: globalThis.__previewWorkers,
    };
  });
  assert.deepEqual(replacement.outcomes, [false, true]);
  assert.equal(replacement.state.source.name, 'replacement.gcode');
  assert.equal(replacement.workers.filter((worker) => !worker.terminated).length, 1);
  assert.ok(replacement.workers.length >= 3, 'replacement cancels an actual running worker');
  assert.ok(replacement.workers.flatMap((worker) => worker.windows).every((window) => window.count <= 240_000));
  await page.evaluate(() =>
    globalThis.window.dispatchEvent(new globalThis.PageTransitionEvent('pagehide', { persisted: false })),
  );
  assert.equal(await page.evaluate(() => globalThis.__previewWorkers.filter((worker) => !worker.terminated).length), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      fixture: '300002-record-single-layer',
      heartbeatCount: evidence.heartbeats,
      openMs: +evidence.durationMs.toFixed(2),
      maximumRetainedRecords: 240_000,
    }),
  );
  console.log(
    'Production preview worker: bounded DOM/XR paging, unchanged canonical state, responsive indexing, source cancellation and disposal passed.',
  );
} finally {
  await browser.close();
  await server.close();
}
