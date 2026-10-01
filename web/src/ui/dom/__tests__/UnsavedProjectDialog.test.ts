import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { askUnsavedProjectDecision } from '../UnsavedProjectDialog';

const dom = new JSDOM('<button id="before">Before</button>');
Object.assign(globalThis, { document: dom.window.document, HTMLElement: dom.window.HTMLElement });
const before = document.getElementById('before')!;
before.focus();
for (const choice of ['save', 'discard', 'cancel'] as const) {
  const pending = askUnsavedProjectDecision('<script>Example</script>');
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true');
  assert.equal((document.activeElement as HTMLElement).dataset.unsavedChoice, 'cancel');
  (document.querySelector(`[data-unsaved-choice="${choice}"]`) as HTMLButtonElement).click();
  assert.equal(await pending, choice);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, before);
}
const escape = askUnsavedProjectDecision('Example');
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(await escape, 'cancel');
const scope = new AbortController();
const cancelled = askUnsavedProjectDecision('Example', scope.signal);
scope.abort();
assert.equal(await cancelled, 'cancel');
assert.equal(document.querySelector('[role="dialog"]'), null);
assert.equal(await askUnsavedProjectDecision('Example', scope.signal), 'cancel');
dom.window.close();
console.log('Unsaved project dialog choices, safe text, focus restoration and disposal passed.');
