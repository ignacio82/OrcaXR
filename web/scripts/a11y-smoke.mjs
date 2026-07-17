import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  const page = await openReadyPage(browser, url, { width: 1280, height: 720 }, (readyPage) =>
    readyPage.setBypassCSP(true),
  );
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () =>
    globalThis.axe.run(globalThis.document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    }),
  );
  const releaseBlocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  assert.deepStrictEqual(
    releaseBlocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    [],
  );
  console.log(`Accessibility smoke passed (${result.passes.length} axe rules passed).`);
} finally {
  await browser.close();
  await server.close();
}
