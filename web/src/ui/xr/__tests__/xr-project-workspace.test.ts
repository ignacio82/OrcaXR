/**
 * Tests for XrProjectWorkspace in XR.
 */
import assert from 'node:assert/strict';
import { renderXrProjectWorkspace, type XrProjectContext } from '../XrProjectWorkspace';
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

function sampleProjectContext(overrides: Partial<XrProjectContext> = {}): XrProjectContext {
  return {
    projectName: 'MultiMaterial_Vase.3mf',
    plateCount: 2,
    modelCount: 3,
    isDirty: true,
    recentProjects: [
      { name: 'Desk_Organizer.3mf', modelCount: 4, modifiedDate: 'Yesterday' },
      { name: 'Headphone_Stand.3mf', modelCount: 1, modifiedDate: '3 days ago' },
    ],
    ...overrides,
  };
}

test('renders project metadata and recent projects list', () => {
  const root = new FakePanel({});
  renderXrProjectWorkspace(adapter, root, sampleProjectContext());

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('MultiMaterial_Vase.3mf'));
  assert.ok(texts.includes('2 Plate(s) · 3 Model(s)'));
  assert.ok(texts.includes('UNSAVED CHANGES'));
  assert.ok(texts.includes('Desk_Organizer.3mf'));
});

test('renders calibration workflow cards and invokes selection callback', () => {
  let selectedWorkflow: string | null = null;
  const root = new FakePanel({});
  renderXrProjectWorkspace(
    adapter,
    root,
    sampleProjectContext({
      onSelectCalibrationWorkflow: (id) => {
        selectedWorkflow = id;
      },
    }),
  );

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('Temperature Tower'));
  assert.ok(texts.includes('Flow Rate (YOLO)'));
  assert.ok(texts.includes('Pressure Advance'));

  // Find and click the Temperature Tower card in all buttons
  const buttons = root.buttons();
  const tempCard = buttons.find((b) => b.texts().some((t) => t.text === 'Temperature Tower'));
  assert.ok(tempCard);
  tempCard.click();
  assert.equal(selectedWorkflow, 'calib_temperature');
});

console.log(`\nXrProjectWorkspace: ${passed} tests passed.`);
