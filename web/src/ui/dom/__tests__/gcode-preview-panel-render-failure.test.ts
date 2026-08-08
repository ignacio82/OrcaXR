import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { GcodePreviewPanel, type GcodePreviewPanelState } from '../GcodePreviewPanel';
import type { GcodePreviewViewPatch } from '../../../slicer/GcodePreviewSession';

const require = createRequire(import.meta.url);
const JSDOM = (
  require('jsdom') as {
    JSDOM: new (html: string) => { readonly window: Window & typeof globalThis };
  }
).JSDOM;

const modes: GcodePreviewPanelState['modes'] = [
  { id: 'FeatureType', label: 'Line Type', unit: null },
  { id: 'Feedrate', label: 'Speed', unit: 'mm/s' },
];
const moveFilters: GcodePreviewPanelState['moveFilters'] = [
  { id: 'extrude', label: 'Extrusions' },
  { id: 'travel', label: 'Travel' },
];
const closedState: GcodePreviewPanelState = {
  active: false,
  modes,
  moveFilters,
  legend: [],
  limitations: [],
  ticks: [],
};

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('inactive failed sessions retain actionable controls and dispatch a retry patch', () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>');
  const container = dom.window.document.querySelector('main');
  assert.ok(container instanceof dom.window.HTMLElement);
  const patches: GcodePreviewViewPatch[] = [];
  const state: GcodePreviewPanelState = {
    ...closedState,
    source: { kind: 'file', name: 'too-large.gcode' },
    view: {
      mode: 'FeatureType',
      layerRange: [1, 8],
      singleLayer: false,
      moveVisibility: {
        extrude: true,
        travel: false,
        wipe: false,
        retract: false,
        unretract: false,
      },
    },
    layerBounds: [1, 12],
    unsupportedReason:
      'Preview unavailable: this G-code exceeds the safe renderer segment limit. Show fewer layers or move classes and try again.',
  };
  const panel = new GcodePreviewPanel(container, {
    getState: () => state,
    onUpdateView: (patch) => {
      patches.push(patch);
    },
  });
  panel.mount();

  assert.match(container.querySelector('[data-preview-status]')?.textContent ?? '', /adjust the controls below/i);
  assert.match(container.querySelector('[data-preview-unsupported]')?.textContent ?? '', /segment limit/i);
  const mode = container.querySelector<HTMLSelectElement>('[data-preview-mode]');
  assert.ok(mode);
  assert.ok(container.querySelector('[data-preview-slider="preview-layer-high"]'));
  assert.ok(container.querySelector('[data-preview-slider="preview-layer-low"]'));
  assert.ok(container.querySelector('[data-preview-move-filter="extrude"]'));

  mode.value = 'Feedrate';
  mode.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(patches, [{ mode: 'Feedrate' }]);
  panel.dispose();
  dom.window.close();
});

test('inactive state without a retained session renders no preview controls', () => {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>');
  const container = dom.window.document.querySelector('main');
  assert.ok(container instanceof dom.window.HTMLElement);
  const panel = new GcodePreviewPanel(container, {
    getState: () => closedState,
    onUpdateView: () => {
      throw new Error('A closed preview cannot dispatch a view update');
    },
  });
  panel.mount();

  assert.match(container.querySelector('[data-preview-status]')?.textContent ?? '', /slice the plate or open/i);
  assert.equal(container.querySelector('[data-preview-mode]'), null);
  assert.equal(container.querySelector('[data-preview-slider]'), null);
  assert.equal(container.querySelector('[data-preview-move-filter]'), null);
  panel.dispose();
  dom.window.close();
});

console.log(`\n${passed} G-code preview-panel render-failure tests passed.`);
