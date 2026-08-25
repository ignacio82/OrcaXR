/**
 * Tests for XrDeviceWorkspace in XR.
 */
import assert from 'node:assert/strict';
import { renderXrDeviceWorkspace, type XrDeviceContext } from '../XrDeviceWorkspace';
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
  setPanelProperties: (panel, properties) => {
    Object.assign(panel, properties.fillColor === undefined ? {} : { fillColor: String(properties.fillColor) });
    if (typeof properties.opacity === 'number') panel.opacity = properties.opacity;
  },
  setTextProperties: () => {},
  clearChildren: (panel) => {
    panel.children.length = 0;
  },
};

function sampleDeviceContext(overrides: Partial<XrDeviceContext> = {}): XrDeviceContext {
  return {
    printerName: 'Snapmaker U1',
    telemetry: {
      hotendTempC: 215,
      hotendTargetC: 215,
      bedTempC: 60,
      bedTargetC: 60,
      fanPercent: 100,
      state: 'printing',
      currentLayer: 45,
      totalLayers: 120,
    },
    storedFiles: [{ filename: 'test_model.gcode', sizeBytes: 5242880 }],
    ...overrides,
  };
}

test('renders live temperature telemetry and printer status badge', () => {
  const root = new FakePanel({});
  renderXrDeviceWorkspace(adapter, root, sampleDeviceContext());

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('Snapmaker U1'));
  assert.ok(texts.includes('PRINTING'));
  assert.ok(texts.includes('215°C'));
  assert.ok(texts.includes('60°C'));
  assert.ok(texts.includes('45 / 120'));
});

test('pause/emergency stop control buttons invoke callbacks', () => {
  let paused = false;
  let estop = false;
  const root = new FakePanel({});
  renderXrDeviceWorkspace(
    adapter,
    root,
    sampleDeviceContext({
      onPausePrint: () => {
        paused = true;
      },
      onEmergencyStop: () => {
        estop = true;
      },
    }),
  );

  const buttons = root.buttons();
  const pauseBtn = buttons.find((b) => b.texts().some((t) => t.text.includes('Pause')));
  assert.ok(pauseBtn);
  pauseBtn.click();
  assert.equal(paused, true);

  const estopBtn = buttons.find((b) => b.texts().some((t) => t.text.includes('Emergency Stop')));
  assert.ok(estopBtn);
  estopBtn.click();
  assert.equal(estop, true);
});

console.log(`\nXrDeviceWorkspace: ${passed} tests passed.`);
