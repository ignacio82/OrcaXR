import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { launchBrowser } from './preview-harness.mjs';

execFileSync('npm', ['run', 'build'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, ORCAXR_DEPLOY: '1' },
  stdio: 'pipe',
});
const root = new URL('../../docs/slicer/', import.meta.url).pathname;
let revision = 0;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith('/slicer/')) {
      res.writeHead(404).end();
      return;
    }
    const file = resolve(root, path.slice('/slicer/'.length) || 'index.html');
    if (!file.startsWith(resolve(root) + sep)) {
      res.writeHead(404).end();
      return;
    }
    let bytes = await readFile(file);
    if (file.endsWith('/coi-serviceworker.js'))
      bytes = Buffer.concat([bytes, Buffer.from(`\n// Fixture update ${revision}\n`)]);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(bytes);
  })().catch(() => res.writeHead(404).end());
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/slicer/`;
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForFunction(
    () => globalThis.crossOriginIsolated && globalThis.document.querySelector('#app-boot.ready'),
    { timeout: 60_000 },
  );
  await page.evaluate(() => globalThis.navigator.serviceWorker.ready);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  assert.equal(
    await page.evaluate(() =>
      globalThis.window.workspace.openGcodeForPreview(
        'M83\n;LAYER_CHANGE\n;TYPE:Outer wall\nG1 X10 E1 F1200\n',
        'static-offline.gcode',
      ),
    ),
    true,
    'the static host supports its first Rust preview offline under /slicer/',
  );
  await page.setOfflineMode(false);
  await page.evaluate(() => globalThis.window.workspace.loadModelFromUrl('/slicer/models/cube_20mm.stl'));
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().dirty);
  const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary());
  revision++;
  await page.evaluate(async () => {
    await (await globalThis.navigator.serviceWorker.getRegistration()).update();
  });
  await page.waitForFunction(async () => Boolean((await globalThis.navigator.serviceWorker.getRegistration()).waiting));
  // The real update flow must ask before activating, and Cancel must retain
  // both the waiting worker and the exact dirty project.
  await page.evaluate(() => {
    globalThis.__staticUpdate = globalThis.window.workspace.onRequestApplicationUpdate();
  });
  await page.waitForSelector('[data-unsaved-choice="cancel"]');
  await page.click('[data-unsaved-choice="cancel"]');
  await page.evaluate(() => globalThis.__staticUpdate);
  assert.deepEqual(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary()), before);
  assert.equal(
    await page.evaluate(async () => Boolean((await globalThis.navigator.serviceWorker.getRegistration()).waiting)),
    true,
  );
  await page.evaluate(() => {
    void globalThis.window.workspace.onRequestApplicationUpdate();
  });
  await page.waitForSelector('[data-unsaved-choice="discard"]');
  const navigated = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.click('[data-unsaved-choice="discard"]');
  await navigated;
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  assert.equal(
    await page.evaluate(async () => Boolean((await globalThis.navigator.serviceWorker.getRegistration()).waiting)),
    false,
  );
  console.log(
    'Static /slicer/ host: isolated offline first preview and waiting update Save/Discard/Cancel guard passed (Cancel and Discard exercised).',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
