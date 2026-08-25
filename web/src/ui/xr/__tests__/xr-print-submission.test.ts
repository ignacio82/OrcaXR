/**
 * Tests for XrPrintSubmissionDialog in XR.
 */
import assert from 'node:assert/strict';
import { renderXrPrintSubmissionDialog, type XrPrintSubmissionContext } from '../XrPrintSubmissionDialog';
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

function samplePrintContext(overrides: Partial<XrPrintSubmissionContext> = {}): XrPrintSubmissionContext {
  return {
    printerName: 'Snapmaker U1',
    availablePrinters: ['Snapmaker U1', 'Elegoo Centauri Carbon'],
    plateName: 'Plate 1',
    nozzleMm: 0.4,
    bedType: 'Smooth PEI',
    estimatedDurationFormatted: '1h 24m',
    estimatedWeightGrams: 45.2,
    estimatedCostFormatted: '$1.35',
    toolSlots: [
      {
        toolNumber: 1,
        toolName: 'Snapmaker PLA Red',
        toolColor: '#ff0000',
        toolType: 'PLA',
        mappedPrinterSlot: 1,
      },
      {
        toolNumber: 2,
        toolName: 'Generic PLA Blue',
        toolColor: '#0000ff',
        toolType: 'PLA',
        mappedPrinterSlot: 2,
      },
    ],
    readyToPrint: true,
    ...overrides,
  };
}

test('renders target printer, slot mappings, and print estimates', () => {
  const root = new FakePanel({});
  renderXrPrintSubmissionDialog(adapter, root, samplePrintContext());

  const texts = root.texts().map((t) => t.text);
  assert.ok(texts.includes('Print Submission'));
  assert.ok(texts.includes('Snapmaker U1'));
  assert.ok(texts.includes('1h 24m'));
  assert.ok(texts.includes('45.2 g'));
  assert.ok(texts.includes('$1.35'));
  assert.ok(texts.some((t) => t.includes('Tool 1: PLA')));
  assert.ok(texts.some((t) => t.includes('Tool 2: PLA')));
});

test('send & print triggers action callback', () => {
  let sentAndPrinted = false;
  const root = new FakePanel({});
  renderXrPrintSubmissionDialog(
    adapter,
    root,
    samplePrintContext({
      onSendAndPrint: () => {
        sentAndPrinted = true;
      },
    }),
  );

  const buttons = root.buttons();
  const sendBtn = buttons.find((b) => b.texts().some((t) => t.text === 'Send & Print'));
  assert.ok(sendBtn);
  sendBtn.click();
  assert.equal(sentAndPrinted, true);
});

test('cycle slot mapping invokes callback with tool number', () => {
  let cycledTool: number | null = null;
  const root = new FakePanel({});
  renderXrPrintSubmissionDialog(
    adapter,
    root,
    samplePrintContext({
      onCycleSlotMapping: (toolNum) => {
        cycledTool = toolNum;
      },
    }),
  );

  const buttons = root.buttons();
  const mappingBtn = buttons.find((b) => b.texts().some((t) => t.text.includes('→ Printer Slot 1')));
  assert.ok(mappingBtn);
  mappingBtn.click();
  assert.equal(cycledTool, 1);
});

console.log(`\nXrPrintSubmissionDialog: ${passed} tests passed.`);
