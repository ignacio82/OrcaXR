/**
 * Traces for the Simplify panel (P5.3.5).
 *
 * What matters here is that the panel cannot offer a way to lose work: apply
 * and cancel exist only while something is previewing, preview asks for the
 * mode that is actually selected, and the readout reports the counts rather
 * than an encouraging summary of them.
 */

import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { SimplifyPanel, type SimplifyPanelState } from '../SimplifyPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const base: SimplifyPanelState = {
  hasSelection: false,
  previewing: false,
  useCount: true,
  decimateRatio: 50,
  maxError: 1,
  parts: 0,
  beforeTriangles: 0,
  afterTriangles: 0,
  stoppedOnError: false,
};

function mount(initial: SimplifyPanelState): {
  host: HTMLElement;
  calls: string[];
  setState: (next: SimplifyPanelState) => void;
} {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const host = dom.window.document.getElementById('host') as unknown as HTMLElement;
  let state = initial;
  const calls: string[] = [];
  const panel = new SimplifyPanel(host, {
    getState: () => state,
    onPreview: (configuration) => {
      calls.push(
        `preview:${configuration.useCount ? 'count' : 'error'}:${configuration.decimateRatio}:${configuration.maxError}`,
      );
    },
    onApply: () => {
      calls.push('apply');
    },
    onCancel: () => {
      calls.push('cancel');
    },
  });
  panel.mount();
  return {
    host,
    calls,
    setState: (next) => {
      state = next;
      panel.refresh();
    },
  };
}

const button = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-simplify-action="${id}"]`);
const field = (host: HTMLElement, id: string) => host.querySelector<HTMLInputElement>(`[data-simplify-field="${id}"]`);

await test('apply and cancel are inert until something is being previewed', () => {
  const view = mount({ ...base, hasSelection: true });
  assert.equal(button(view.host, 'simplify-preview')?.disabled, false);
  assert.equal(button(view.host, 'simplify-apply')?.disabled, true, 'nothing to apply yet');
  assert.equal(button(view.host, 'simplify-cancel')?.disabled, true, 'and nothing to restore');

  view.setState({ ...base, hasSelection: true, previewing: true, parts: 1, beforeTriangles: 100, afterTriangles: 40 });
  assert.equal(button(view.host, 'simplify-apply')?.disabled, false);
  assert.equal(button(view.host, 'simplify-cancel')?.disabled, false);
  assert.equal(button(view.host, 'simplify-preview')?.disabled, true, 'and a second preview cannot stack on the first');
});

await test('preview cannot be started without a selection', () => {
  const view = mount(base);
  assert.equal(button(view.host, 'simplify-preview')?.disabled, true);
  assert.match(view.host.textContent ?? '', /Select a model/);
});

await test('the mode switch decides which limit preview is asked for', async () => {
  const view = mount({ ...base, hasSelection: true });
  // Count mode is the default, and the error field is inert rather than gone —
  // a control that vanishes reads as unsupported.
  assert.equal(field(view.host, 'simplify-ratio')?.disabled, false);
  assert.equal(field(view.host, 'simplify-error')?.disabled, true);
  button(view.host, 'simplify-preview')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['preview:count:50:1']);

  const errorMode = view.host.querySelector<HTMLInputElement>('[data-simplify-mode="error"]')!;
  errorMode.checked = true;
  errorMode.dispatchEvent(new (errorMode.ownerDocument.defaultView as Window & typeof globalThis).Event('change'));
  assert.equal(field(view.host, 'simplify-ratio')?.disabled, true, 'now the ratio is the inert one');
  assert.equal(field(view.host, 'simplify-error')?.disabled, false);
  button(view.host, 'simplify-preview')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['preview:count:50:1', 'preview:error:50:1']);
});

await test('the readout reports the counts, not a verdict on them', () => {
  const view = mount({
    ...base,
    hasSelection: true,
    previewing: true,
    parts: 2,
    beforeTriangles: 1000,
    afterTriangles: 400,
  });
  const status = view.host.querySelector('[data-simplify-status]');
  assert.ok(status);
  assert.match(status.textContent ?? '', /1000 → 400/);
  assert.match(status.textContent ?? '', /60% removed/);
  assert.match(status.textContent ?? '', /2 part\(s\)/);
});

await test('an error-limited run says it stopped short rather than implying it hit the target', () => {
  const view = mount({
    ...base,
    hasSelection: true,
    previewing: true,
    parts: 1,
    beforeTriangles: 1000,
    afterTriangles: 950,
    stoppedOnError: true,
  });
  assert.match(view.host.querySelector('[data-simplify-status]')?.textContent ?? '', /Stopped at the error limit/);
});

await test('apply and cancel each report once', async () => {
  const view = mount({
    ...base,
    hasSelection: true,
    previewing: true,
    parts: 1,
    beforeTriangles: 10,
    afterTriangles: 4,
  });
  button(view.host, 'simplify-apply')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.setState({ ...base, hasSelection: true, previewing: true, parts: 1, beforeTriangles: 10, afterTriangles: 4 });
  button(view.host, 'simplify-cancel')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['apply', 'cancel']);
});

console.log(`\nSimplify panel: ${passed} tests passed.`);
