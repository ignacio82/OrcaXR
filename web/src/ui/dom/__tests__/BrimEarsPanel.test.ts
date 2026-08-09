import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { BrimEarsPanel, type BrimEarsPanelState } from '../BrimEarsPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mount(initial: BrimEarsPanelState) {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  let state = initial;
  const calls: string[] = [];
  const panel = new BrimEarsPanel(host, {
    getState: () => state,
    onActivate: () => {
      calls.push('activate');
    },
    onSetRadius: (radius) => {
      calls.push(`radius:${radius}`);
    },
    onRemove: (index) => {
      calls.push(`remove:${index}`);
    },
    onClear: () => {
      calls.push('clear');
    },
  });
  panel.mount();
  return {
    host,
    calls,
    setState: (next: BrimEarsPanelState) => {
      state = next;
      panel.refresh();
    },
  };
}

const base: BrimEarsPanelState = {
  active: false,
  radiusMm: 5,
  minRadiusMm: 0.1,
  maxRadiusMm: 20,
  ears: [],
  hint: 'Select one model part to place brim ears on it.',
};

const button = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-brim-ears-action="${id}"]`);

await test('without a single selected part the radius is locked and clearing is disabled', () => {
  const view = mount(base);
  assert.equal(view.host.querySelector<HTMLInputElement>('[data-brim-ears-radius]')?.disabled, true);
  assert.equal(button(view.host, 'brim-ears-clear')?.disabled, true, 'nothing to clear');
  assert.equal(button(view.host, 'brim-ears-activate')?.getAttribute('aria-pressed'), 'false');
  assert.equal(view.host.querySelector('[data-brim-ears]'), null, 'no list until an ear exists');
  assert.match(view.host.querySelector<HTMLElement>('[data-brim-ears-hint]')?.textContent ?? '', /Select one model/);
});

await test('an active tool with a part in scope accepts a radius and reports pressed state', async () => {
  const view = mount({ ...base, active: true, objectId: 'object:1', hint: 'Click the model to place an ear.' });
  assert.equal(button(view.host, 'brim-ears-activate')?.getAttribute('aria-pressed'), 'true');
  const radius = view.host.querySelector<HTMLInputElement>('[data-brim-ears-radius]')!;
  assert.equal(radius.disabled, false);
  assert.equal(radius.min, '0.1');
  assert.equal(radius.max, '20');

  radius.value = '2.5';
  radius.dispatchEvent(new radius.ownerDocument.defaultView!.Event('change'));
  button(view.host, 'brim-ears-activate')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['radius:2.5', 'activate']);
});

await test('each placed ear lists its position and diameter and can be removed', async () => {
  const view = mount({
    ...base,
    active: true,
    objectId: 'object:1',
    ears: [
      { positionMm: [1, 2, 0], headFrontRadiusMm: 5 },
      { positionMm: [-3.456, 4, 0], headFrontRadiusMm: 2.5 },
    ],
    hint: 'Click the model to place an ear.',
  });
  const items = view.host.querySelectorAll<HTMLElement>('[data-brim-ear-index]');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent ?? '', /1, 2, 0 mm · ⌀10 mm/);
  assert.match(items[1].textContent ?? '', /-3.46, 4, 0 mm · ⌀5 mm/, 'coordinates round for display only');

  assert.equal(button(view.host, 'brim-ears-clear')?.disabled, false);
  button(view.host, 'brim-ear-remove-1')!.click();
  button(view.host, 'brim-ears-clear')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['remove:1', 'clear']);
});

console.log(`\nBrim ears panel: ${passed} tests passed.`);
