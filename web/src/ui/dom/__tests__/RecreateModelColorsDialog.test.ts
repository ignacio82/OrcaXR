import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom has no bundled declaration file in this suite setup
import { JSDOM } from 'jsdom';

import type { RecreateModelColorsPlan } from '../../../project/filaments/recreateModelColors';
import { askRecreateModelColors } from '../RecreateModelColorsDialog';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mockPlan(): RecreateModelColorsPlan {
  return {
    matches: [
      {
        source: {
          color: '#FF0000',
          sourceFilamentIds: ['phys-1' as any],
          sourceMaterialName: 'Red Part',
          sampleNames: ['Body'],
          usageCount: 1,
        },
        destination: {
          kind: 'physical',
          filamentId: 'phys-1' as any,
          displayColor: '#FF0000',
          name: 'Snapmaker Red (T1)',
          deltaE2000: 0.0,
        },
      },
      {
        source: {
          color: '#FF8000',
          sourceFilamentIds: [],
          sourceMaterialName: 'Orange Cover',
          sampleNames: ['Cover'],
          usageCount: 2,
        },
        destination: {
          kind: 'new-mixed',
          displayColor: '#FF7D00',
          name: 'Blend: 50% Red + 50% Yellow',
          deltaE2000: 1.2,
        },
      },
    ],
    availablePhysicalCount: 2,
    canGenerateFullSpectrum: true,
    averageDeltaE2000: 0.6,
    maxDeltaE2000: 1.2,
    sourceRevision: 1,
    sourceHash: 'test-hash',
  };
}

await test('renders model colors and confirms on apply', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;

  const plan = mockPlan();
  const promise = askRecreateModelColors(plan);

  const overlay = document.querySelector('[data-recreate-model-colors-dialog="true"]');
  assert.ok(overlay, 'Dialog overlay should be mounted');

  const title = document.getElementById('orcaxr-recreate-colors-title');
  assert.equal(title?.textContent, 'Recreate Model Colors (Full-Spectrum)');

  // Click apply button
  const buttons = Array.from(document.querySelectorAll('button'));
  const applyBtn = buttons.find((b) => b.textContent?.includes('Apply'));
  assert.ok(applyBtn, 'Apply button should exist');
  applyBtn.click();

  const result = await promise;
  assert.equal(result.confirmed, true);
  assert.equal(document.querySelector('[data-recreate-model-colors-dialog="true"]'), null);
});

await test('cancels on Escape key or Cancel button', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;

  const plan = mockPlan();
  const promise = askRecreateModelColors(plan);

  const buttons = Array.from(document.querySelectorAll('button'));
  const cancelBtn = buttons.find((b) => b.textContent?.includes('Cancel'));
  assert.ok(cancelBtn, 'Cancel button should exist');
  cancelBtn.click();

  const result = await promise;
  assert.equal(result.confirmed, false);
});

console.log(`Recreate model colors dialog tests: ${passed} tests passed.`);
