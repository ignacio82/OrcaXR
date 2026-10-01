import assert from 'node:assert/strict';
import { startMoonrakerSimulator } from './moonraker-simulator.mjs';
import { launchBrowser, startPreview } from './preview-harness.mjs';
const { server, url } = await startPreview();
const browser = await launchBrowser();
const printerA = await startMoonrakerSimulator({ gcodeResponses: { M105: 'lifecycle-printer-A' } });
const printerB = await startMoonrakerSimulator({ gcodeResponses: { M105: 'lifecycle-printer-B' } });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 30_000 });
  for (const [printer, response] of [
    [printerA, 'lifecycle-printer-A'],
    [printerB, 'lifecycle-printer-B'],
  ]) {
    await page.evaluate(async (endpoint) => {
      const host = globalThis.document.getElementById('printer-host');
      host.value = endpoint;
      host.dispatchEvent(new Event('input', { bubbles: true }));
      const ctx = globalThis.window.__orcaCtx;
      await ctx.registry.invoke('printer_console_send', 'dom-inspector', ctx, ctx.ui.get(), {
        printerConsole: { kind: 'send', script: 'M105' },
      });
    }, printer.url);
    await page.waitForFunction(
      (response) => globalThis.document.getElementById('printer-console-host').textContent.includes(response),
      { timeout: 5000 },
      response,
    );
    assert.deepEqual(printer.commands, ['gcode:M105']);
    console.log(`Console notifications received from ${response}.`);
  }
  await page.evaluate(() => {
    globalThis.window.dispatchEvent(new globalThis.PageTransitionEvent('pagehide', { persisted: true }));
    globalThis.window.dispatchEvent(new globalThis.PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.click('[data-view-tab="project"]');
  assert.equal(
    await page.$eval('#page-project', (node) => node.hidden),
    false,
    'back-forward cache restoration must preserve the workspace tab controls',
  );
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  assert.equal(await page.$eval('#command-palette', (node) => node.classList.contains('open')), true);
  await page.evaluate(() =>
    globalThis.window.dispatchEvent(new globalThis.PageTransitionEvent('pagehide', { persisted: false })),
  );
  assert.equal(await page.$eval('#command-palette', (node) => node.classList.contains('open')), false);
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  assert.equal(await page.$eval('#command-palette', (node) => node.classList.contains('open')), false);
  assert.deepEqual(errors, []);
  console.log(
    'Surface lifecycle browser: cached-page event contract preserves controls; permanent departure releases them.',
  );
} finally {
  await browser.close();
  await printerA.close();
  await printerB.close();
  await server.close();
}
