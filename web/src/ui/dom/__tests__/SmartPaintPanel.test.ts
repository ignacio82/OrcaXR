import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import type { PaintPalette } from '../../../project/painting/paintPalette';
import { SmartPaintPanel, type SmartPaintPanelState } from '../SmartPaintPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const RED = entityId<'physical-filament'>('import:smart-paint:red');
const BLUE = entityId<'physical-filament'>('import:smart-paint:blue');

const palette: PaintPalette = {
  entries: [
    { kind: 'default', name: 'Inherit', displayColor: '#888888', badge: '' },
    { kind: 'physical', filamentId: RED, name: 'Red', displayColor: '#ff0000', badge: 'T0', engineSlot: 1 },
    { kind: 'physical', filamentId: BLUE, name: 'Blue', displayColor: '#0000ff', badge: 'T1', engineSlot: 2 },
  ],
  physicalCount: 2,
  enabledMixedCount: 0,
} as unknown as PaintPalette;

function baseState(overrides: Partial<SmartPaintPanelState> = {}): SmartPaintPanelState {
  return {
    providerId: 'test-provider',
    channel: 'color',
    palette,
    consent: { geometry: false, image: false },
    prompt: '',
    imageAttached: false,
    busy: false,
    ...overrides,
  };
}

function mount(initial: SmartPaintPanelState) {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  let state = initial;
  const calls: string[] = [];
  const panel = new SmartPaintPanel(host, {
    getState: () => state,
    onSetConsent: (next) => {
      calls.push(`consent:${JSON.stringify(next)}`);
    },
    onSetPrompt: (prompt) => {
      calls.push(`prompt:${prompt}`);
    },
    onRequest: () => {
      calls.push('request');
    },
    onCancel: () => {
      calls.push('cancel');
    },
    onAssignRegion: (id, value) => {
      calls.push(`assign:${id}:${String(value)}`);
    },
    onApply: () => {
      calls.push('apply');
    },
  });
  panel.mount();
  return {
    host,
    calls,
    panel,
    setState(next: SmartPaintPanelState) {
      state = next;
      panel.refresh();
    },
  };
}

function button(host: HTMLElement, id: string): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>(`[data-smart-paint-action="${id}"]`);
  assert.ok(element, `missing ${id} button`);
  return element;
}

await test('asking is blocked until consent and a prompt exist', () => {
  const view = mount(baseState());
  assert.equal(button(view.host, 'smart-paint-request').disabled, true, 'no consent, no prompt');

  view.setState(baseState({ consent: { geometry: true, image: false } }));
  assert.equal(button(view.host, 'smart-paint-request').disabled, true, 'consent alone is not enough');

  view.setState(baseState({ consent: { geometry: true, image: false }, prompt: 'the top face' }));
  assert.equal(button(view.host, 'smart-paint-request').disabled, false);
  button(view.host, 'smart-paint-request').click();
  assert.deepEqual(view.calls, ['request']);
});

await test('consent toggles and the prompt are separate explicit intents', () => {
  const view = mount(baseState());
  const geometry = view.host.querySelector<HTMLInputElement>('[data-smart-paint-consent-key="geometry"]')!;
  const image = view.host.querySelector<HTMLInputElement>('[data-smart-paint-consent-key="image"]')!;
  assert.equal(geometry.checked, false);
  assert.equal(image.checked, false);

  geometry.checked = true;
  geometry.dispatchEvent(new geometry.ownerDocument.defaultView!.Event('change'));
  image.checked = true;
  image.dispatchEvent(new image.ownerDocument.defaultView!.Event('change'));

  const prompt = view.host.querySelector<HTMLTextAreaElement>('[data-smart-paint-prompt]')!;
  prompt.value = 'top and bottom';
  prompt.dispatchEvent(new prompt.ownerDocument.defaultView!.Event('change'));

  assert.deepEqual(view.calls, ['consent:{"geometry":true}', 'consent:{"image":true}', 'prompt:top and bottom']);
});

await test('the preview reports exact coverage and confidence and gates apply on a destination', () => {
  const view = mount(
    baseState({
      consent: { geometry: true, image: false },
      prompt: 'top',
      preview: {
        channel: 'color',
        coverage: 0.25,
        confidence: 0.9,
        unassignedFacetCount: 9,
        assignable: false,
        regions: [
          { id: 'ai-region-1', label: 'Top face', confidence: 0.9, coverage: 0.25, facetCount: 3, value: null },
        ],
      },
    }),
  );

  const summary = view.host.querySelector<HTMLElement>('[data-smart-paint-summary]')!;
  assert.match(summary.textContent ?? '', /1 proposed region/);
  assert.match(summary.textContent ?? '', /25% of the surface/);
  assert.match(summary.textContent ?? '', /mean confidence 90%/);
  assert.match(summary.textContent ?? '', /9 facets untouched/);

  const facts = view.host.querySelector<HTMLElement>('[data-smart-paint-region-facts]')!;
  assert.match(facts.textContent ?? '', /3 facets · 25% of the surface · confidence 90%/);

  assert.equal(button(view.host, 'smart-paint-apply').disabled, true);
  assert.ok(view.host.querySelector('[data-smart-paint-apply-hint]'), 'the reason apply is blocked is stated');

  const select = view.host.querySelector<HTMLSelectElement>('[data-smart-paint-region-destination="ai-region-1"]')!;
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['', String(RED), String(BLUE)],
    'only stable filament identities are offered',
  );
  select.value = String(BLUE);
  select.dispatchEvent(new select.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.calls, [`assign:ai-region-1:${BLUE}`]);
});

await test('an assigned mask can be applied or discarded, and both are explicit', () => {
  const view = mount(
    baseState({
      consent: { geometry: true, image: false },
      prompt: 'top',
      preview: {
        channel: 'support',
        coverage: 0.5,
        confidence: 0.8,
        unassignedFacetCount: 6,
        assignable: true,
        regions: [
          { id: 'ai-region-1', label: 'Overhangs', confidence: 0.8, coverage: 0.5, facetCount: 6, value: 'enforce' },
        ],
      },
    }),
  );

  const select = view.host.querySelector<HTMLSelectElement>('[data-smart-paint-region-destination="ai-region-1"]')!;
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['', 'enforce', 'block'],
    'a non-colour channel offers its own assigned states',
  );
  assert.equal(select.value, 'enforce');

  assert.equal(button(view.host, 'smart-paint-apply').disabled, false);
  button(view.host, 'smart-paint-apply').click();
  button(view.host, 'smart-paint-discard').click();
  assert.deepEqual(view.calls, ['apply', 'cancel']);
});

await test('unavailability, busy state, and errors are announced rather than hidden', () => {
  const view = mount(baseState({ unavailableReason: 'Select one model part to use Smart Paint.' }));
  const notice = view.host.querySelector<HTMLElement>('[data-smart-paint-unavailable]')!;
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(button(view.host, 'smart-paint-request').disabled, true);

  view.setState(baseState({ consent: { geometry: true, image: false }, prompt: 'top', busy: true }));
  const busy = view.host.querySelector<HTMLElement>('[data-smart-paint-busy]')!;
  assert.equal(busy.getAttribute('role'), 'status');
  assert.match(busy.textContent ?? '', /Nothing has changed in the project/);
  assert.equal(button(view.host, 'smart-paint-request').disabled, true, 'no second request while one is open');
  assert.equal(button(view.host, 'smart-paint-cancel').disabled, false);

  view.setState(baseState({ error: 'The assistant request failed.' }));
  const error = view.host.querySelector<HTMLElement>('[data-smart-paint-error]')!;
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, 'The assistant request failed.');
});

console.log(`\nSmart Paint panel: ${passed} tests passed.`);
