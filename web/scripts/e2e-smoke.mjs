import assert from 'node:assert/strict';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  const pageErrors = [];
  const policyErrors = [];
  const page = await openReadyPage(browser, url, { width: 1280, height: 720 }, (readyPage) => {
    readyPage.on('pageerror', (error) => pageErrors.push(error.message));
    readyPage.on('console', (message) => {
      if (/Content Security Policy|Refused to (?:load|connect|execute)/i.test(message.text())) {
        policyErrors.push(message.text());
      }
    });
  });

  assert.match(await page.title(), /OrcaXR/i);
  assert.equal(await page.$eval('[data-action-id="slice_active_plate"]', (node) => node.disabled), true);
  assert.match(await page.$eval('[data-action-id="slice_active_plate"]', (node) => node.title), /load|model/i);
  assert.equal(await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled), true);
  assert.match(await page.$eval('[data-action-id="edit_undo"]', (node) => node.title), /history is not implemented/i);

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page.waitForSelector('#command-palette.open');
  assert.equal(
    await page.$eval('#cmd-list [data-action-id="edit_undo"]', (node) => node.classList.contains('disabled')),
    true,
  );

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));
  const overflow = await page.evaluate(
    () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `mobile shell overflows horizontally by ${overflow}px`);

  assert.deepStrictEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('\n')}`);
  assert.deepStrictEqual(policyErrors, [], `CSP violations: ${policyErrors.join('\n')}`);
  console.log('Production E2E smoke passed (desktop capability guard, command palette, mobile viewport).');
} finally {
  await browser.close();
  await server.close();
}
