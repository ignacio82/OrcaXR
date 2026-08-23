/**
 * Tests for XrToolRail in XR.
 */
import assert from 'node:assert/strict';
import { renderXrToolRail, type XrToolRailContext } from '../XrToolRail';
import { buildRegistry } from '../../../actions/catalog';
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

const registry = buildRegistry();

function sampleToolRailContext(overrides: Partial<XrToolRailContext> = {}): XrToolRailContext {
  return {
    activeTool: null,
    filamentSlots: [
      { id: 'fil_1', number: 1, color: '#ff0000', label: 'Slot 1' },
      { id: 'fil_2', number: 2, color: '#0000ff', label: 'Slot 2' },
    ],
    activePaintSlot: 1,
    onRunAction: () => {},
    ...overrides,
  };
}

test('renders transform, surface paint, and mesh tools', () => {
  const root = new FakePanel({});
  const render = renderXrToolRail(adapter, root, registry, sampleToolRailContext());

  assert.ok(render.handles.length >= 10);
  const actionIds = render.handles.map((h) => h.action.id);
  assert.ok(actionIds.includes('tool_move'));
  assert.ok(actionIds.includes('tool_rotate'));
  assert.ok(actionIds.includes('tool_paint'));
  assert.ok(actionIds.includes('tool_measure'));
  assert.ok(actionIds.includes('arrange_all'));
  assert.ok(actionIds.includes('drop_to_bed'));
});

test('renders palette swatches when paint tool is active', () => {
  let selectedSlot = -1;
  const root = new FakePanel({});
  renderXrToolRail(
    adapter,
    root,
    registry,
    sampleToolRailContext({
      activeTool: 'paint',
      onSelectPaintSlot: (slot) => {
        selectedSlot = slot;
      },
    }),
  );

  const buttons = root.buttons();
  const slot2 = buttons.find((b) => b.texts().some((t) => t.text === '2'));
  assert.ok(slot2);
  slot2.click();
  assert.equal(selectedSlot, 2);
});

test('renders measure metrics when measure tool is active with results', () => {
  const root = new FakePanel({});
  renderXrToolRail(
    adapter,
    root,
    registry,
    sampleToolRailContext({
      activeTool: 'measure',
      measureResult: {
        distanceMm: 42.5,
        deltaX: 10,
        deltaY: 20,
        deltaZ: 35.5,
      },
    }),
  );

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.some((t) => t.includes('42.50 mm')));
  assert.ok(texts.some((t) => t.includes('ΔX: 10.0')));
});

console.log(`\nXrToolRail: ${passed} tests passed.`);
