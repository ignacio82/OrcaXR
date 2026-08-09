import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { MeasurePanel, type MeasurePanelState } from '../MeasurePanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mount(initial: MeasurePanelState) {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  let state = initial;
  const calls: string[] = [];
  const panel = new MeasurePanel(host, {
    getState: () => state,
    onActivate: () => {
      calls.push('activate');
    },
    onClear: () => {
      calls.push('clear');
    },
  });
  panel.mount();
  return {
    host,
    calls,
    setState(next: MeasurePanelState) {
      state = next;
      panel.refresh();
    },
  };
}

const value = (host: HTMLElement, key: string): string | null =>
  host.querySelector<HTMLElement>(`[data-measure-value="${key}"]`)?.textContent ?? null;

await test('an idle panel states what to do and offers no numbers', async () => {
  const view = mount({ active: false, picks: [], hint: 'Choose the Measure tool, then click two features.' });
  assert.equal(view.host.querySelector<HTMLElement>('[data-measure-hint]')?.getAttribute('role'), 'status');
  assert.equal(view.host.querySelector('[data-measure-readout]'), null, 'no readout before two picks');
  assert.equal(
    view.host
      .querySelector<HTMLButtonElement>('[data-measure-action="measure-activate"]')
      ?.getAttribute('aria-pressed'),
    'false',
  );

  view.host.querySelector<HTMLButtonElement>('[data-measure-action="measure-activate"]')!.click();
  view.host.querySelector<HTMLButtonElement>('[data-measure-action="measure-clear"]')!.click();
  // Both handlers dispatch through a promise chain, so let them settle first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['activate', 'clear']);
});

await test('an active tool reports pressed state and lists each pick', () => {
  const view = mount({
    active: true,
    picks: [
      { kind: 'plane', summary: 'plane facing (0, 0, 1)' },
      { kind: 'circle', summary: 'circle ⌀8 mm', diameterMm: 8 },
    ],
    distanceMm: 12.5,
    distanceKind: 'infinite',
    hint: 'Click another feature to start a new measurement.',
  });
  assert.equal(
    view.host
      .querySelector<HTMLButtonElement>('[data-measure-action="measure-activate"]')
      ?.getAttribute('aria-pressed'),
    'true',
  );
  const picks = view.host.querySelectorAll<HTMLElement>('[data-measure-pick-kind]');
  assert.equal(picks.length, 2);
  assert.equal(picks[0].dataset.measurePickKind, 'plane');
  assert.equal(picks[1].textContent, 'circle ⌀8 mm');
  assert.equal(value(view.host, 'distance'), '12.5 mm');
  assert.equal(value(view.host, 'diameter'), '8 mm');
  assert.match(
    view.host.querySelector<HTMLElement>('[data-measure-readout] dt')?.textContent ?? '',
    /to line\/plane/,
    'an unbounded distance says so rather than passing as the bounded one',
  );
});

await test('distance components and angle render only when the measurement has them', () => {
  const view = mount({
    active: true,
    picks: [
      { kind: 'point', summary: 'point (0, 0, 0) mm' },
      { kind: 'point', summary: 'point (3, 4, 12) mm' },
    ],
    distanceMm: 13,
    distanceKind: 'strict',
    distanceXyzMm: [3, 4, 12],
    hint: 'Click another feature to start a new measurement.',
  });
  assert.equal(value(view.host, 'distance'), '13 mm');
  assert.equal(value(view.host, 'xyz'), '3 mm / 4 mm / 12 mm');
  assert.equal(value(view.host, 'angle'), null, 'two points have no angle');

  view.setState({
    active: true,
    picks: [
      { kind: 'plane', summary: 'plane facing (0, 0, 1)' },
      { kind: 'plane', summary: 'plane facing (1, 0, 0)' },
    ],
    angleDeg: 90,
    hint: 'Click another feature to start a new measurement.',
  });
  assert.equal(value(view.host, 'angle'), '90°');
  assert.equal(value(view.host, 'distance'), null, 'crossing planes have no distance');
});

await test('an unsupported pair states the reason instead of showing a number', () => {
  const view = mount({
    active: true,
    picks: [
      { kind: 'circle', summary: 'circle ⌀10 mm', diameterMm: 10 },
      { kind: 'circle', summary: 'circle ⌀6 mm', diameterMm: 6 },
    ],
    unsupportedReason: 'Two circles in non-parallel planes need the engine’s polynomial solver.',
    hint: 'Click another feature to start a new measurement.',
  });
  const notice = view.host.querySelector<HTMLElement>('[data-measure-unsupported]');
  assert.ok(notice, 'the reason is announced');
  assert.equal(notice?.getAttribute('role'), 'status');
  assert.equal(value(view.host, 'distance'), null, 'no distance is invented for an unsupported pair');
  // The diameters the picks really carry are still reported.
  assert.equal(value(view.host, 'diameter'), '10 mm');
});

console.log(`\nMeasure panel: ${passed} tests passed.`);
