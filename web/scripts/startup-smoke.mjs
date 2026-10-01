import assert from 'node:assert/strict';
import { launchBrowser, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  // Failure of the health UI itself happens before any editable workspace exists.
  const bootstrapContext = await browser.createBrowserContext();
  const bootstrapPage = await bootstrapContext.newPage();
  await bootstrapPage.setBypassServiceWorker(true);
  await bootstrapPage.setRequestInterception(true);
  let blockBootstrap = true;
  const bootstrapErrors = [];
  bootstrapPage.on('pageerror', (error) => bootstrapErrors.push(error.message));
  bootstrapPage.on('request', (request) => {
    if (blockBootstrap && /\/ApplicationInitialization-[^/]+\.js/.test(request.url()))
      void request.respond({ status: 503, contentType: 'text/plain', body: 'Fixture unavailable' });
    else void request.continue();
  });
  await bootstrapPage.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await bootstrapPage.waitForSelector('[data-startup-reload]', { timeout: 30_000 });
  assert.equal(await bootstrapPage.evaluate(() => globalThis.window.workspace === undefined), true);
  blockBootstrap = false;
  await Promise.all([
    bootstrapPage.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60_000 }),
    bootstrapPage.click('[data-startup-reload]'),
  ]);
  await bootstrapPage.waitForSelector('#app-boot.ready', { timeout: 30_000 });
  assert.deepEqual(bootstrapErrors, []);
  await bootstrapContext.close();
  console.log('Startup recovery passed: bootstrap module failure before workspace creation.');
  for (const feature of ['settings', 'profiles', 'measure-panel', 'xr']) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    let failing = true;
    let requests = 0;
    page.on('request', (request) => {
      const matches =
        feature === 'settings'
          ? request.url().includes('engine-options.schema')
          : feature === 'profiles'
            ? request.url().includes('/profiles/catalog.json')
            : feature === 'xr'
              ? /\/immersive-[^/]+\.js/.test(request.url())
              : /\/MeasurePanel-[^/]+\.js/.test(request.url());
      if (matches) requests++;
      if (matches && failing)
        void request.respond({ status: 503, contentType: 'text/plain', body: 'Fixture unavailable' });
      else void request.continue();
    });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
    const optional = feature === 'measure-panel' || feature === 'xr';
    if (feature === 'xr') {
      await page.waitForSelector('#app-boot.ready', { timeout: 30_000 });
      assert.equal(await page.evaluate(() => globalThis.window.workspace.loadImmersiveShell()), null);
    }
    const phase = optional ? 'degraded' : 'failed';
    try {
      await page.waitForSelector(`#app-boot[data-boot-state="${phase}"] [data-startup-recovery="${feature}"]`, {
        timeout: 30_000,
      });
      await page.waitForFunction(
        () => globalThis.window.__orcaUi.get().initialization.features.find((f) => f.id === 'shell')?.phase === 'ready',
      );
      const snapshot = await page.evaluate(() => globalThis.window.__orcaUi.get().initialization);
      for (const idle of ['ai', 'camera', 'printer', ...(feature === 'xr' ? [] : ['xr'])])
        assert.equal(snapshot.features.find((f) => f.id === idle).phase, 'idle');
      assert.equal(await page.$eval('#app-boot', (node) => node.classList.contains('ready')), false);
      await page.evaluate(() => globalThis.window.workspace.loadModelFromUrl('/models/cube_20mm.stl'));
      await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().objectCount === 1);
      assert.equal(
        await page.$eval('#action-panel [data-action-id="slice_active_plate"]', (node) => node.disabled),
        !optional,
      );
      for (const surface of ['dom-inspector', 'xr-inspector']) {
        const state = await page.evaluate((surface) => {
          const ctx = globalThis.window.__orcaCtx;
          return ctx.registry.availability('printer_emergency_stop', surface, ctx.ui.get()).state;
        }, surface);
        assert.equal(state, 'enabled', 'startup failure must not hide emergency stop');
      }
      failing = false;
      if (optional) {
        const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary());
        await page.click(`[data-startup-recovery="${feature}"]`);
        await page.waitForSelector('[data-unsaved-choice="cancel"]');
        await page.click('[data-unsaved-choice="cancel"]');
        assert.deepEqual(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary()), before);
        await page.evaluate(() => {
          globalThis.window.__newProject = globalThis.window.workspace.newProject();
        });
        await page.waitForSelector('[data-unsaved-choice="discard"]');
        await page.click('[data-unsaved-choice="discard"]');
        await page.evaluate(() => globalThis.window.__newProject);
        assert.equal(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().dirty), false);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60_000 }),
          page.click(`[data-startup-recovery="${feature}"]`),
        ]);
      } else {
        const before = requests;
        await page.evaluate((feature) => {
          const button = globalThis.document.querySelector(`[data-startup-recovery="${feature}"]`);
          button.click();
          button.click();
        }, feature);
        await page.waitForSelector('#app-boot.ready', { timeout: 30_000 });
        assert.equal(requests, before + 1, 'repeated retry gestures share one required-data request');
      }
      await page.waitForSelector('#app-boot.ready', { timeout: 30_000 });
      assert.equal(
        await page.$$eval('[data-scoped-settings-panel]', (nodes) => nodes.length),
        1,
        'retry must not duplicate the settings surface',
      );
      assert.deepEqual(errors, [], 'lazy failure must be handled without unhandled rejections');
      console.log(`Startup recovery passed: ${feature}, truthful health, guarded controls, idempotent recovery.`);
    } catch (error) {
      const status = await page.evaluate(() => ({
        boot: globalThis.document.querySelector('#app-boot')?.textContent,
        health: globalThis.window.__orcaUi?.get().initialization,
      }));
      throw new Error(`${feature}: ${error.message}; ${JSON.stringify({ errors, ...status })}`, { cause: error });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
