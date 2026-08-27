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

test('the headset offers the same pre-print options the flat dialog offers', () => {
  const root = new FakePanel({});
  const toggled: string[] = [];
  renderXrPrintSubmissionDialog(
    adapter,
    root,
    samplePrintContext({
      startOptions: [
        {
          id: 'bed-leveling',
          label: 'Calibrate the build plate first',
          detail: 'Runs BED_MESH_CALIBRATE',
          available: true,
          enabled: false,
        },
        {
          id: 'timelapse',
          label: 'Record a timelapse',
          detail: 'This Moonraker has no timelapse component installed.',
          available: false,
          enabled: false,
        },
      ],
      onToggleStartOption: (id) => toggled.push(id),
    }),
  );

  const texts = root.texts().map((entry) => entry.text);
  assert.ok(texts.includes('Calibrate the build plate first'), 'an available option is offered');
  assert.ok(
    texts.some((text) => text.includes('no timelapse component')),
    "an unavailable option stays on screen with the printer's own reason",
  );

  // Pressing an available row toggles it; the unavailable one is not pressable,
  // so a machine can never be asked for something it said it cannot do.
  const rows = root.buttons().filter((button) => button.texts().some((t) => /plate first|timelapse/.test(t.text)));
  assert.equal(rows.length, 1, 'only the available option is pressable');
  rows[0].click();
  assert.deepEqual(toggled, ['bed-leveling']);
});

test('a fact the send never learned is reported as unknown, not invented', () => {
  const root = new FakePanel({});
  renderXrPrintSubmissionDialog(
    adapter,
    root,
    // A context carrying only what a send confirmation actually knows.
    {
      printerName: 'Snapmaker U1',
      availablePrinters: ['Snapmaker U1'],
      plateName: 'Plate 1',
      toolSlots: [],
      toolSummaryText: '2 tools (T0, T1)',
      readyToPrint: true,
    },
  );

  const texts = root.texts().map((entry) => entry.text);
  assert.ok(texts.includes('2 tools (T0, T1)'), 'the mapping the confirmation computed is shown, not a sketch of one');
  assert.equal(texts.filter((text) => text === 'not reported').length, 2, 'an unknown duration and weight each say so');
  for (const invented of ['1h 15m', '35.0 g', 'Extruder T1', 'Smooth PEI']) {
    assert.ok(!texts.some((text) => text.includes(invented)), `${invented} must not be conjured`);
  }
  assert.ok(
    !texts.some((text) => /Nozzle:|Bed:/.test(text)),
    'a nozzle and bed nobody reported are left out of the header entirely',
  );
});

console.log(`\nXrPrintSubmissionDialog: ${passed} tests passed.`);
