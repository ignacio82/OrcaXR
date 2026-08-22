import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { renderProfileSelectionStatus } from '../ProfileSelectionStatus';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function statusElement(): HTMLElement {
  const dom = new JSDOM('<!doctype html><html><body><p id="status"></p></body></html>');
  return dom.window.document.querySelector<HTMLElement>('#status')!;
}

test('renders substitutions as visible non-blocking status', () => {
  const target = statusElement();
  renderProfileSelectionStatus(target, {
    feedback: {
      applied: true,
      severity: 'warning',
      messages: ['Filament slot 2: ABS is unavailable; substituted PETG.'],
    },
  });
  assert.equal(target.dataset.profileSelectionState, 'substituted');
  assert.equal(target.getAttribute('role'), 'status');
  assert.match(target.textContent ?? '', /substituted PETG/);
  // The tone is a token, not a literal: what matters is that a substitution
  // reads as a warning rather than as an error or as ordinary body text.
  assert.equal(target.style.color, 'var(--oxr-warn)');
});

test('renders failed reconciliation as an alert without hiding its reason', () => {
  const target = statusElement();
  renderProfileSelectionStatus(target, {
    feedback: {
      applied: false,
      severity: 'error',
      messages: ['No compatible process preset is available for Printer B.'],
    },
  });
  assert.equal(target.dataset.profileSelectionState, 'unavailable');
  assert.equal(target.getAttribute('role'), 'alert');
  assert.match(target.textContent ?? '', /No compatible process/);
});

test('surfaces catalog omissions and deduplicates repeated reasons', () => {
  const target = statusElement();
  renderProfileSelectionStatus(target, {
    unavailableReasons: [
      'Printer C has no compatible filament.',
      'Printer C has no compatible filament.',
      'Printer D has no compatible process.',
    ],
  });
  assert.equal(target.dataset.profileSelectionState, 'catalog-limited');
  assert.match(target.textContent ?? '', /^2 preset combinations are unavailable/);
  assert.match(target.title, /Printer D has no compatible process/);
});

console.log(`\n${passed} profile selection status tests passed.`);
