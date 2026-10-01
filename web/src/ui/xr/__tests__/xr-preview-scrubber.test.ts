/**
 * Reading a toolpath in the headset.
 *
 * The scrubber is a second view of the exact `GcodePreviewPanelAdapter` state
 * the flat shell renders, so what is asserted here is that it draws *all* of
 * it — the redesign's complaint was a legend truncated at six roles and a set
 * of move filters with no control at all — and that it never invents anything
 * the projection did not supply.
 */
import assert from 'node:assert/strict';
import type { GcodePreviewPanelState } from '../../dom/GcodePreviewPanel';
import type { GcodePreviewViewPatch } from '../../../slicer/GcodePreviewSession';
import { XrImmersiveShell } from '../XrImmersiveShell';
import { renderXrPreviewScrubber } from '../XrPreviewScrubber';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();
const host = () => new FakePanel({});

const LEGEND = [
  'Outer wall',
  'Inner wall',
  'Sparse infill',
  'Solid infill',
  'Top surface',
  'Bridge',
  'Support',
  'Travel',
];

function state(overrides: Partial<GcodePreviewPanelState> = {}): GcodePreviewPanelState {
  return {
    active: true,
    view: {
      mode: 'feature',
      layerRange: [1, 148],
      singleLayer: false,
      moveVisibility: { extrude: true, travel: false } as never,
    },
    layerBounds: [1, 302],
    layerTopZMm: 29.6,
    modes: [
      { id: 'feature', label: 'Feature type', unit: null },
      { id: 'speed', label: 'Speed', unit: 'mm/s' },
    ],
    moveFilters: [
      { id: 'extrude' as never, label: 'Extrusions' },
      { id: 'travel' as never, label: 'Travel' },
    ],
    legend: LEGEND.map((label, index) => ({ code: String(index), label, color: '#ffffff' })) as never,
    limitations: [],
    ticks: [],
    ...overrides,
  } as GcodePreviewPanelState;
}

test('the layer readout and the Z height come from the projection', () => {
  const root = host();
  const render = renderXrPreviewScrubber(ui, root, state(), { onUpdateView: () => {} });
  assert.equal((render.layerText as { text: string }).text, 'Layer 148 / 302');
  assert.equal((render.zText as { text: string }).text, 'Z 29.60 mm');
});

test('the whole legend is drawn, not the first six roles', () => {
  const root = host();
  renderXrPreviewScrubber(ui, root, state(), { onUpdateView: () => {} });
  const labels = root.labels();
  for (const role of LEGEND) assert.ok(labels.includes(role), `${role} is missing from the legend`);
});

test('every view mode is named, so a press is not a guess', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = host();
  renderXrPreviewScrubber(ui, root, state(), { onUpdateView: (patch) => patches.push(patch) });
  const labels = root.labels();
  assert.ok(labels.includes('Feature type'));
  assert.ok(labels.includes('Speed'));
  root
    .buttons()
    .find((button) => button.labels().includes('Speed'))
    ?.click();
  assert.deepEqual(patches, [{ mode: 'speed' }]);
});

test('the move filters are reachable and toggle the value the projection holds', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = host();
  renderXrPreviewScrubber(ui, root, state(), { onUpdateView: (patch) => patches.push(patch) });
  root
    .buttons()
    .find((button) => button.labels().includes('Travel'))
    ?.click();
  assert.deepEqual(patches, [{ moveVisibility: { travel: true } }]);
});

test('stepping stays inside the layer bounds', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = host();
  renderXrPreviewScrubber(ui, root, state({ view: { ...state().view!, layerRange: [1, 300] } }), {
    onUpdateView: (patch) => patches.push(patch),
  });
  root
    .buttons()
    .find((button) => button.labels().includes('+10'))
    ?.click();
  assert.deepEqual(patches, [{ layerRange: [1, 302] }], 'a jump past the top clamps to the top');
});

test('single layer scrubs one layer rather than a window', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = host();
  const render = renderXrPreviewScrubber(ui, root, state(), { onUpdateView: (patch) => patches.push(patch) });
  root
    .buttons()
    .find((button) => button.labels().includes('Single layer'))
    ?.click();
  assert.deepEqual(patches, [{ singleLayer: true, layerRange: [148, 148] }]);
  render.refresh(state({ view: { ...state().view!, singleLayer: true, layerRange: [148, 148] } }));
  root
    .buttons()
    .find((button) => button.labels().includes('-1'))
    ?.click();
  assert.deepEqual(patches.at(-1), { layerRange: [147, 147] });
});

test('an unsupported projection says so instead of drawing an empty row', () => {
  const root = host();
  renderXrPreviewScrubber(ui, root, state({ unsupportedReason: 'This artifact carries no per-layer durations.' }), {
    onUpdateView: () => {},
    onAuthorEvent: () => {},
  });
  assert.ok(root.labels().includes('This artifact carries no per-layer durations.'));
  assert.ok(!root.labels().includes('Pause at this layer'), 'an event cannot be authored onto what is not there');
});

test('a layer event is authored at the Z the projection reported', () => {
  const authored: [string, number][] = [];
  const root = host();
  renderXrPreviewScrubber(ui, root, state(), {
    onUpdateView: () => {},
    onAuthorEvent: (type, z) => authored.push([type, z]),
  });
  root
    .buttons()
    .find((button) => button.labels().includes('Pause at this layer'))
    ?.click();
  assert.deepEqual(authored, [['pause', 29.6]]);
});

test('a grab bar appears only where the surface can actually be pinned', () => {
  const withPin = host();
  renderXrPreviewScrubber(ui, withPin, state(), { onUpdateView: () => {}, onTogglePin: () => {} }, { pinned: true });
  assert.ok(withPin.labels().includes('Toolpath'));
  const withoutPin = host();
  renderXrPreviewScrubber(ui, withoutPin, state(), { onUpdateView: () => {} });
  assert.ok(!withoutPin.labels().includes('Toolpath'));
});

test('bounded move windows are reachable and disabled while loading or at an edge', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = host();
  const first = state({
    window: { firstRecord: 0, lastRecord: 31, totalRecords: 90, hasPrevious: false, hasNext: true },
  });
  const render = renderXrPreviewScrubber(ui, root, first, { onUpdateView: (patch) => patches.push(patch) });
  const previous = root.buttons().find((button) => button.labels().includes('Previous moves'))!;
  const next = root.buttons().find((button) => button.labels().includes('Next moves'))!;
  previous.click();
  next.click();
  assert.deepEqual(patches, [{ windowStep: 1 }]);
  render.refresh({ ...first, loading: true });
  next.click();
  assert.equal(patches.length, 1);
  render.refresh({
    ...first,
    window: { firstRecord: 64, lastRecord: 89, totalRecords: 90, hasPrevious: true, hasNext: false },
  });
  next.click();
  previous.click();
  assert.deepEqual(patches.at(-1), { windowStep: -1 });
});

test('an empty or unsupported window keeps XR narrowing and paging controls reachable', () => {
  const root = host();
  let visible = false;
  let mode = 'preview';
  let current = state({
    active: false,
    unsupportedReason: 'No drawable moves in this window.',
    window: { firstRecord: 0, lastRecord: 31, totalRecords: 90, hasPrevious: false, hasNext: true },
  });
  const patches: GcodePreviewViewPatch[] = [];
  const shell = new XrImmersiveShell(
    ui,
    {
      scrubber: {
        content: root,
        show: () => {
          visible = true;
        },
        hide: () => {
          visible = false;
        },
        reset: () => ui.clearChildren(root),
        place: () => {},
      },
    } as never,
    {
      previewState: () => current,
      workspaceMode: () => mode,
      updatePreview: (patch: GcodePreviewViewPatch) => patches.push(patch),
    } as never,
    (content, next, _pinned, handlers) => renderXrPreviewScrubber(ui, content, next, handlers),
  );
  shell.refreshPreview();
  assert.equal(visible, true, 'a retained session must keep its recovery controls');
  root
    .buttons()
    .find((button) => button.labels().includes('Next moves'))!
    .click();
  assert.deepEqual(patches, [{ windowStep: 1 }]);
  mode = 'prepare';
  shell.refreshPreview();
  assert.equal(visible, false);
  mode = 'preview';
  current = { ...current, view: undefined };
  shell.refreshPreview();
  assert.equal(visible, false, 'closing the preview removes the retained controls');
});

console.log(`\nXR preview scrubber: ${passed} tests passed.`);
