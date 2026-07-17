import assert from 'node:assert/strict';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
let page;
try {
  page = await openReadyPage(browser, url);
  await page.evaluate(() => globalThis.navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  assert.equal(
    await page.evaluate(() => Boolean(globalThis.navigator.serviceWorker.controller)),
    true,
    'production page must be controlled by its service worker',
  );

  // Prime the NetworkFirst engine route, then prove that its cached fallback
  // and the precached shell/icon inventory remain usable without a network.
  const engineStatus = await page.evaluate(async () => (await globalThis.fetch('slicer/slic3r.mjs')).status);
  assert.equal(engineStatus, 200);

  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  const offline = await page.evaluate(async () => {
    const [icon, engine] = await Promise.all([
      globalThis.fetch('icons/material/open_with.svg'),
      globalThis.fetch('slicer/slic3r.mjs'),
    ]);
    return { icon: icon.status, engine: engine.status };
  });
  assert.deepEqual(offline, { icon: 200, engine: 200 });
  console.log('Offline smoke passed (app reload, XR icon, NetworkFirst slicer fallback).');
} finally {
  if (page) await page.setOfflineMode(false).catch(() => {});
  await browser.close();
  await server.close();
}
