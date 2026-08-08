import assert from 'node:assert/strict';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
let page;
try {
  page = await openReadyPage(browser, url);
  page.on('pageerror', (err) => console.error('[offline-smoke pageerror]', err.message));
  page.on('requestfailed', (req) =>
    console.error('[offline-smoke requestfailed]', req.url(), req.failure()?.errorText),
  );
  await page.evaluate(() => globalThis.navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  assert.equal(
    await page.evaluate(() => Boolean(globalThis.navigator.serviceWorker.controller)),
    true,
    'production page must be controlled by its service worker',
  );

  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-settings-schema-status]')?.textContent?.includes('foundation-partial'),
    { timeout: 60_000 },
  );
  const schemaAsset = await page.evaluate(() =>
    globalThis.performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/assets\/engine-options\.schema-[^/]+\.json$/.test(name)),
  );
  assert.ok(schemaAsset, 'the generated settings schema asset must load before the offline transition');
  assert.equal(
    await page.evaluate(async (url) => (await (await globalThis.fetch(url)).json()).schemaVersion, schemaAsset),
    2,
    'the online shell must prime settings schema v2',
  );

  // Prime the NetworkFirst engine route, then prove that its cached fallback
  // and the precached shell/icon inventory remain usable without a network.
  const engineStatus = await page.evaluate(async () => (await globalThis.fetch('slicer/slic3r.mjs')).status);
  assert.equal(engineStatus, 200);

  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  const offline = await page.evaluate(async (schemaUrl) => {
    const [icon, engine, schema] = await Promise.all([
      globalThis.fetch('icons/material/open_with.svg'),
      globalThis.fetch('slicer/slic3r.mjs'),
      globalThis.fetch(schemaUrl),
    ]);
    return {
      icon: icon.status,
      engine: engine.status,
      schema: schema.status,
      schemaVersion: (await schema.json()).schemaVersion,
    };
  }, schemaAsset);
  assert.deepEqual(offline, { icon: 200, engine: 200, schema: 200, schemaVersion: 2 });
  console.log('Offline smoke passed (app reload, settings schema v2, XR icon, NetworkFirst slicer fallback).');
} finally {
  if (page) await page.setOfflineMode(false).catch(() => {});
  await browser.close();
  await server.close();
}
