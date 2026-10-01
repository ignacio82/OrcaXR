import assert from 'node:assert/strict';
import { launchBrowser, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
const errors = [];
let activePage;
async function ready(context, configure) {
  const page = await context.newPage();
  activePage = page;
  await page.setViewport({ width: 1280, height: 900 });
  await page.setBypassServiceWorker(true);
  page.on('pageerror', (error) => errors.push(error.message));
  await configure?.(page);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  await page.waitForSelector('[data-recovery-panel]');
  return page;
}
async function invoke(page, id, invocation = {}) {
  await page.evaluate(
    (id, invocation) => {
      const ctx = globalThis.window.__orcaCtx;
      globalThis.window.__persistenceAction = ctx.registry.invoke(
        id,
        ctx.registry.get(id).disclosure === 'menu' ? 'dom-menu' : 'dom-inspector',
        ctx,
        ctx.ui.get(),
        invocation,
      );
    },
    id,
    invocation,
  );
}
async function settled(page) {
  return page.evaluate(() => globalThis.window.__persistenceAction);
}
async function rows(page) {
  return page.$$eval('[data-recovery-action="recover"]', (buttons) =>
    buttons.map((button) => ({ id: button.dataset.recoveryId, disabled: button.disabled })),
  );
}
async function selectProject(page) {
  await invoke(page, 'file_recover_project');
  await settled(page);
  await page.waitForFunction(() => !globalThis.document.querySelector('#page-project').hidden);
}
try {
  const context = await browser.createBrowserContext();
  let page = await ready(context);
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().dirty),
    false,
    'initial catalog defaults are not authored edits',
  );
  await page.evaluate(() => globalThis.window.workspace.loadModelFromUrl('/models/cube_20mm.stl'));
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().objectCount === 1);
  const original = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary());
  assert.equal(original.dirty, true);
  await page.waitForSelector('[data-recovery-action="recover"]', { timeout: 20_000 });
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().dirty),
    true,
    'autosave must preserve dirty state',
  );
  const firstId = (await rows(page))[0].id;
  await page.close(); // Losing a tab must leave its committed recovery archive available.
  page = await ready(context);
  assert.equal(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().objectCount), 0);
  await selectProject(page);
  assert.ok((await rows(page)).some((row) => row.id === firstId));
  await page.click(`[data-recovery-action="recover"][data-recovery-id='${firstId}']`);
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().objectCount === 1);
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().dirty),
    true,
    'recovery remains dirty until manual save',
  );
  await page.waitForFunction(
    (oldId) =>
      [...globalThis.document.querySelectorAll('[data-recovery-action="recover"]')].some(
        (button) => button.dataset.recoveryId !== oldId,
      ),
    { timeout: 20_000 },
    firstId,
  );
  const recoveredRows = await rows(page);
  assert.equal(recoveredRows.length, 2, 'new tab owns a separate lineage');
  await invoke(page, 'file_new_project');
  await page.waitForSelector('[data-unsaved-choice="cancel"]');
  await page.click('[data-unsaved-choice="cancel"]');
  await settled(page);
  assert.equal(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().objectCount), 1);
  await invoke(page, 'file_new_project');
  await page.waitForSelector('[data-unsaved-choice="discard"]');
  await page.click('[data-unsaved-choice="discard"]');
  await settled(page);
  assert.equal(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().objectCount), 0);
  assert.deepEqual(
    (await rows(page)).map((row) => row.id),
    [firstId],
    'discard removes only this editing session',
  );
  await selectProject(page);
  await page.click('[data-recovery-action="recover"]');
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().objectCount === 1);
  await page.evaluate(() => {
    globalThis.window.__downloads = [];
    globalThis.window.workspace.onDownloadFile = (name, data) => {
      globalThis.window.__downloads.push({ name, size: data.byteLength });
    };
  });
  await invoke(page, 'file_new_project');
  await page.waitForSelector('[data-unsaved-choice="save"]');
  await page.click('[data-unsaved-choice="save"]');
  await settled(page);
  assert.equal(await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().objectCount), 0);
  assert.equal(await page.evaluate(() => globalThis.window.__downloads.length), 1);
  assert.ok(await page.evaluate(() => globalThis.window.__downloads[0].size > 100));
  await selectProject(page);
  await page.click(`[data-recovery-action="download"][data-recovery-id='${firstId}']`);
  await page.waitForFunction(() => globalThis.window.__downloads.length === 2);
  await page.click(`[data-recovery-action="discard"][data-recovery-id='${firstId}']`);
  await page.waitForFunction(
    (id) =>
      ![...globalThis.document.querySelectorAll('[data-recovery-id]')].some(
        (button) => button.dataset.recoveryId === id,
      ),
    {},
    firstId,
  );
  await context.close();
  console.log(
    'Persistence browser: crash recovery, exact import, dirty retention, Save/Discard/Cancel and session ownership passed.',
  );

  const unavailableContext = await browser.createBrowserContext();
  const unavailable = await ready(unavailableContext, (page) =>
    page.evaluateOnNewDocument(() => {
      const OriginalWorker = globalThis.Worker;
      globalThis.__serializerAttempts = 0;
      globalThis.Worker = class extends OriginalWorker {
        constructor(url, options) {
          if (String(url).includes('projectArchive.worker')) {
            globalThis.__serializerAttempts++;
            throw new Error('Fixture worker unavailable');
          }
          super(url, options);
        }
      };
    }),
  );
  await unavailable.evaluate(() => globalThis.window.workspace.loadModelFromUrl('/models/cube_20mm.stl'));
  await unavailable.waitForFunction(
    () => /worker is unavailable/i.test(globalThis.document.querySelector('[data-recovery-panel]').textContent),
    { timeout: 20_000 },
  );
  assert.equal(await unavailable.evaluate(() => globalThis.__serializerAttempts), 1);
  await unavailable.evaluate(() => {
    globalThis.window.__downloads = 0;
    globalThis.window.workspace.onDownloadFile = () => {
      globalThis.window.__downloads++;
    };
  });
  await invoke(unavailable, 'file_save_project');
  await settled(unavailable);
  assert.equal(await unavailable.evaluate(() => globalThis.window.__downloads), 1);
  assert.equal(await unavailable.evaluate(() => globalThis.window.workspace.getCanonicalSummary().dirty), false);
  await unavailableContext.close();
  assert.deepEqual(errors, []);
  console.log(
    'Persistence browser: failed worker reports unavailable recovery; explicit manual fallback remains usable.',
  );
} catch (error) {
  if (activePage && !activePage.isClosed())
    console.error(
      await activePage.evaluate(() => ({
        status: globalThis.document.querySelector('#status-text')?.textContent,
        recovery: globalThis.document.querySelector('[data-recovery-panel]')?.textContent,
        dialogs: [...globalThis.document.querySelectorAll('[role="dialog"]')].map((node) => node.textContent),
        summary: globalThis.window.workspace?.getCanonicalSummary(),
      })),
    );
  throw error;
} finally {
  await browser.close();
  await server.close();
}
