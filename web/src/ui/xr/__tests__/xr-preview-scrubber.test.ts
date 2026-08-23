/**
 * Tests for XrPreviewScrubber spatial layer scrubber in XR.
 */
import assert from 'node:assert/strict';
import { renderXrPreviewScrubber } from '../XrPreviewScrubber';
import type { GcodePreviewViewPatch } from '../../../slicer/GcodePreviewSession';
import type { GcodePreviewPanelState } from '../../dom/GcodePreviewPanel';
import type { XrImageProperties, XrPanelProperties, XrTextProperties, XrUiAdapter } from '../XrUiAdapter';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakePanel {
  fillColor: string;
  opacity: number;
  readonly children: (FakePanel | FakeText | FakeImage)[] = [];
  constructor(readonly opts: XrPanelProperties) {
    this.fillColor = String(opts.fillColor ?? '');
    this.opacity = typeof opts.opacity === 'number' ? opts.opacity : 1;
  }
  click(): void {
    this.opts.onClick?.();
  }
  texts(): FakeText[] {
    return this.children.flatMap((c) => (c instanceof FakeText ? [c] : c instanceof FakePanel ? c.texts() : []));
  }
  buttons(): FakePanel[] {
    return this.children.flatMap((c) =>
      c instanceof FakePanel ? [...(c.opts.onClick ? [c] : []), ...c.buttons()] : [],
    );
  }
}

class FakeText {
  constructor(
    public text: string,
    readonly opts: XrTextProperties,
  ) {}
}

class FakeImage {
  constructor(
    public src: string,
    readonly opts: XrImageProperties,
  ) {}
}

const adapter: XrUiAdapter<FakePanel, FakeImage, FakeText> = {
  createPanel: (opts) => new FakePanel(opts),
  createImage: (src, opts) => new FakeImage(src, opts),
  createText: (text, opts) => new FakeText(text, opts),
  appendImage: (panel, image) => panel.children.push(image),
  appendChild: (panel, child) => panel.children.push(child as any),
  setPanelFill: (panel, fill) => {
    panel.fillColor = String(fill);
  },
  setPanelOpacity: (panel, opacity) => {
    panel.opacity = opacity;
  },
  setImageColor: () => {},
  setText: (text, value) => {
    text.text = value;
  },
};

function sampleState(): GcodePreviewPanelState {
  return {
    active: true,
    layerBounds: [1, 100],
    view: {
      mode: 'FeatureType',
      layerRange: [1, 50],
      singleLayer: false,
      moveVisibility: {
        extrude: true,
        travel: true,
        wipe: true,
        retract: true,
        unretract: true,
      },
    },
    layerTopZMm: 10.0,
    modes: [
      { id: 'FeatureType', label: 'Feature', unit: null },
      { id: 'Tool', label: 'Filament', unit: null },
      { id: 'Feedrate', label: 'Speed', unit: 'mm/s' },
    ],
    moveFilters: [],
    legend: [
      { id: 'outer_wall', label: 'Outer Wall', code: 'OW', accessibleLabel: 'Outer wall', color: '#ff0000' },
      { id: 'inner_wall', label: 'Inner Wall', code: 'IW', accessibleLabel: 'Inner wall', color: '#00ff00' },
    ],
    ticks: [],
    limitations: [],
  };
}

test('renders layer and Z height readouts', () => {
  const root = new FakePanel({});
  const render = renderXrPreviewScrubber(adapter, root, sampleState(), {
    onUpdateView: () => {},
  });
  assert.equal(render.layerText.text, 'Layer 50 / 100');
  assert.equal(render.zText.text, 'Z 10.00 mm');
});

test('stepping layer calls onUpdateView with new layerRange', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = new FakePanel({});
  renderXrPreviewScrubber(adapter, root, sampleState(), {
    onUpdateView: (patch) => patches.push(patch),
  });

  const buttons = root.buttons();
  // Find step up button (+1)
  const plusOne = buttons.find((b) => b.texts().some((t) => t.text === '+1'));
  assert.ok(plusOne);
  plusOne.click();

  assert.deepEqual(patches, [{ layerRange: [1, 51] }]);
});

test('single layer mode toggle updates view patch', () => {
  const patches: GcodePreviewViewPatch[] = [];
  const root = new FakePanel({});
  renderXrPreviewScrubber(adapter, root, sampleState(), {
    onUpdateView: (patch) => patches.push(patch),
  });

  const buttons = root.buttons();
  const toggleBtn = buttons.find((b) => b.texts().some((t) => t.text.includes('Single Layer')));
  assert.ok(toggleBtn);
  toggleBtn.click();

  assert.deepEqual(patches, [{ singleLayer: true, layerRange: [50, 50] }]);
});

console.log(`\nXrPreviewScrubber: ${passed} tests passed.`);
