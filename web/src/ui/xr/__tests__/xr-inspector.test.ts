/**
 * Tests for XrInspector 5-tab spatial parameter sidebar.
 */
import assert from 'node:assert/strict';
import { renderXrInspector, type XrInspectorContext } from '../XrInspector';
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

function sampleContext(overrides: Partial<XrInspectorContext> = {}): XrInspectorContext {
  return {
    activeTab: 'profiles',
    profiles: [
      { kind: 'machine', label: 'Printer', value: 'Snapmaker U1 (0.4 nozzle)', icon: 'printer' },
      { kind: 'process', label: 'Process', value: '0.20mm Standard', icon: 'tune' },
      { kind: 'filament', label: 'Filament', value: 'Generic PLA', icon: 'filament' },
    ],
    plateTypes: ['Smooth PEI', 'Textured PEI'],
    activePlateType: 'Smooth PEI',
    filamentSlots: [
      { id: 'fil_1', slotNumber: 1, color: '#ff0000', name: 'Snapmaker PLA Red', type: 'PLA' },
      { id: 'fil_2', slotNumber: 2, color: '#0000ff', name: 'Generic PLA Blue', type: 'PLA' },
    ],
    objects: [
      { id: 'obj_1', name: 'Benchy', selected: true, printable: true, volumeCount: 1, assignedFilamentNumber: 1 },
      { id: 'obj_2', name: 'Cube', selected: false, printable: true, volumeCount: 1 },
    ],
    scopedStepperView: null,
    onSelectTab: () => {},
    onCycleProfilePart: () => {},
    ...overrides,
  };
}

test('renders profile cards under Profiles tab', () => {
  let cycledPart: string | null = null;
  const root = new FakePanel({});
  renderXrInspector(
    adapter,
    root,
    sampleContext({
      activeTab: 'profiles',
      onCycleProfilePart: (kind) => {
        cycledPart = kind;
      },
    }),
  );

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('Snapmaker U1 (0.4 nozzle)'));
  assert.ok(texts.includes('0.20mm Standard'));
  assert.ok(texts.includes('Generic PLA'));

  const buttons = root.buttons();
  const editMachine = buttons.find((b) => b.texts().some((t) => t.text === 'Change'));
  if (editMachine) {
    editMachine.click();
    assert.equal(cycledPart, 'machine');
  }
});

test('renders filament slots under Filament tab', () => {
  let assignedSlot: number | null = -1;
  const root = new FakePanel({});
  renderXrInspector(
    adapter,
    root,
    sampleContext({
      activeTab: 'filament',
      onAssignFilamentToSelection: (slot) => {
        assignedSlot = slot;
      },
    }),
  );

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.some((t) => t.includes('Snapmaker PLA Red')));
  assert.ok(texts.some((t) => t.includes('Generic PLA Blue')));

  const buttons = root.buttons();
  const assignT1 = buttons.find((b) => b.texts().some((t) => t.text === 'T1'));
  assert.ok(assignT1);
  assignT1.click();
  assert.equal(assignedSlot, 1);
});

test('renders object hierarchy tree under Objects tab', () => {
  let selectedObj: string | null = null;
  const root = new FakePanel({});
  renderXrInspector(
    adapter,
    root,
    sampleContext({
      activeTab: 'objects',
      onSelectObject: (id) => {
        selectedObj = id;
      },
    }),
  );

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('Benchy'));
  assert.ok(texts.includes('Cube'));

  const buttons = root.buttons();
  const benchyBtn = buttons.find((b) => b.texts().some((t) => t.text === 'Benchy'));
  if (benchyBtn) {
    benchyBtn.click();
    assert.equal(selectedObj, 'obj_1');
  }
});

console.log(`\nXrInspector: ${passed} tests passed.`);
