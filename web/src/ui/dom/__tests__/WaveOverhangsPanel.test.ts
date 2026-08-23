import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import {
  WaveOverhangsPanel,
  DEFAULT_WAVE_OVERHANGS_SETTINGS,
  type WaveOverhangsPanelState,
  type WaveOverhangsSettings,
} from '../WaveOverhangsPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mount(initialState: WaveOverhangsPanelState) {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  let state = initialState;
  const updates: Partial<WaveOverhangsSettings>[] = [];
  let resetCalled = false;

  const panel = new WaveOverhangsPanel(host, {
    getState: () => state,
    onUpdate: (patch) => {
      updates.push(patch);
    },
    onReset: () => {
      resetCalled = true;
    },
  });

  panel.mount();

  return {
    host,
    updates,
    getResetCalled: () => resetCalled,
    setState: (next: WaveOverhangsPanelState) => {
      state = next;
      panel.refresh();
    },
    dispose: () => panel.dispose(),
  };
}

const baseState: WaveOverhangsPanelState = {
  settings: DEFAULT_WAVE_OVERHANGS_SETTINGS,
  hasOverrides: false,
};

await test('initial disabled state renders with toggle unchecked and dimmed body', () => {
  const view = mount(baseState);
  const enableChk = view.host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
  assert.equal(enableChk.checked, false);
  const body = view.host.querySelector<HTMLElement>('[data-wave-body]')!;
  assert.match(body.style.opacity, /0.5/);
  assert.equal(view.host.querySelector('[data-wave-action="reset"]'), null, 'no reset button when no overrides');
  view.dispose();
});

await test('toggling enable checkbox calls onUpdate with enabled true', () => {
  const view = mount(baseState);
  const enableChk = view.host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
  enableChk.checked = true;
  enableChk.dispatchEvent(new enableChk.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.updates, [{ enabled: true }]);
  view.dispose();
});

await test('enabled state displays algorithm options, default guidance, and presets', () => {
  const view = mount({
    settings: { ...DEFAULT_WAVE_OVERHANGS_SETTINGS, enabled: true, algorithm: 'andersons' },
    hasOverrides: true,
  });

  const algoSelect = view.host.querySelector<HTMLSelectElement>('[data-wave-algorithm]')!;
  assert.equal(algoSelect.value, 'andersons');

  const guide = view.host.querySelector<HTMLElement>('[data-wave-algorithm-guide]')!;
  assert.match(guide.textContent ?? '', /Janis A\. Andersons/);
  assert.match(guide.textContent ?? '', /concentric/i);

  const resetBtn = view.host.querySelector<HTMLButtonElement>('[data-wave-action="reset"]');
  assert.ok(resetBtn, 'reset button shown when hasOverrides is true');
  resetBtn!.click();
  assert.equal(view.getResetCalled(), true);
  view.dispose();
});

await test('switching algorithm to kaiser updates guidance to lateral seed-curve offsetting', () => {
  const view = mount({
    settings: { ...DEFAULT_WAVE_OVERHANGS_SETTINGS, enabled: true, algorithm: 'kaiser' },
    hasOverrides: true,
  });

  const guide = view.host.querySelector<HTMLElement>('[data-wave-algorithm-guide]')!;
  assert.match(guide.textContent ?? '', /Kaiser Lateral Seed-Curve/);
  assert.match(guide.textContent ?? '', /LaSO/);

  // Kaiser reveals ring overlap control in advanced settings
  assert.ok(view.host.querySelector('[data-wave-ring-overlap]'));
  view.dispose();
});

await test('quick tuning presets apply targeted configuration batches', () => {
  const view = mount({
    settings: { ...DEFAULT_WAVE_OVERHANGS_SETTINGS, enabled: true },
    hasOverrides: false,
  });

  const presetButtons = view.host.querySelectorAll<HTMLButtonElement>('.btn-preset');
  assert.equal(presetButtons.length, 3);

  // Click Balanced
  presetButtons[0]!.click();
  assert.deepEqual(view.updates[view.updates.length - 1], {
    algorithm: 'andersons',
    printSpeedMmS: 35,
    fanSpeedPercent: 90,
    floorUseHilbert: true,
    floorLayers: 3,
    supportRemainingAreas: true,
  });

  // Click Organic / Smooth
  presetButtons[2]!.click();
  assert.deepEqual(view.updates[view.updates.length - 1], {
    algorithm: 'kaiser',
    printSpeedMmS: 30,
    fanSpeedPercent: 100,
    ringOverlap: 0.4,
    floorUseHilbert: true,
    floorLayers: 3,
    supportRemainingAreas: true,
  });
  view.dispose();
});

await test('anti-warping Hilbert floor controls dispatch updates', () => {
  const view = mount({
    settings: { ...DEFAULT_WAVE_OVERHANGS_SETTINGS, enabled: true, floorUseHilbert: true },
    hasOverrides: true,
  });

  const hilbertChk = view.host.querySelector<HTMLInputElement>('[data-wave-hilbert]')!;
  hilbertChk.checked = false;
  hilbertChk.dispatchEvent(new hilbertChk.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.updates[view.updates.length - 1], { floorUseHilbert: false });

  const floorLayers = view.host.querySelector<HTMLInputElement>('[data-wave-floor-layers]')!;
  floorLayers.value = '4';
  floorLayers.dispatchEvent(new floorLayers.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.updates[view.updates.length - 1], { floorLayers: 4 });
  view.dispose();
});

await test('speed and support subtraction inputs dispatch updates', () => {
  const view = mount({
    settings: { ...DEFAULT_WAVE_OVERHANGS_SETTINGS, enabled: true },
    hasOverrides: false,
  });

  const speedInput = view.host.querySelector<HTMLInputElement>('[data-wave-print-speed]')!;
  speedInput.value = '42';
  speedInput.dispatchEvent(new speedInput.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.updates[view.updates.length - 1], { printSpeedMmS: 42 });

  const supportChk = view.host.querySelector<HTMLInputElement>('[data-wave-support-subtract]')!;
  supportChk.checked = false;
  supportChk.dispatchEvent(new supportChk.ownerDocument.defaultView!.Event('change'));
  assert.deepEqual(view.updates[view.updates.length - 1], { supportRemainingAreas: false });
  view.dispose();
});

console.log(`WaveOverhangsPanel: ${passed} tests passed.`);
