/**
 * Tests for XrComponents spatial UI primitives.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createXrButton,
  createXrStepperRow,
  createXrTabBar,
  createXrSectionHeading,
  createXrChip,
} from '../XrComponents';
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
  hoverEnter(): void {
    this.opts.onHoverEnter?.(new THREE.Object3D());
  }
  hoverExit(): void {
    this.opts.onHoverExit?.(new THREE.Object3D());
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

test('createXrButton triggers click callback when enabled', () => {
  let clicked = false;
  const btn = createXrButton(adapter, {
    label: 'Test Button',
    onClick: () => {
      clicked = true;
    },
  });
  btn.root.click();
  assert.equal(clicked, true);
});

test('createXrButton does not trigger click when disabled', () => {
  let clicked = false;
  const btn = createXrButton(adapter, {
    label: 'Disabled Button',
    enabled: false,
    onClick: () => {
      clicked = true;
    },
  });
  btn.root.click();
  assert.equal(clicked, false);
});

test('createXrStepperRow triggers step callbacks with delta', () => {
  const steps: number[] = [];
  const stepper = createXrStepperRow(adapter, 'Layer Height', '0.20', 'mm', (dir) => {
    steps.push(dir);
  });
  const buttons = stepper.root.buttons();
  assert.equal(buttons.length, 2);
  buttons[0].click(); // decrement
  buttons[1].click(); // increment
  assert.deepEqual(steps, [-1, 1]);
});

test('createXrTabBar switches active tab on click', () => {
  let selectedTab = 'prepare';
  const tabs = [
    { id: 'prepare', label: 'Prepare' },
    { id: 'preview', label: 'Preview' },
  ];
  const bar = createXrTabBar(adapter, tabs, 'prepare', (id) => {
    selectedTab = id;
  });
  const buttons = bar.root.buttons();
  assert.equal(buttons.length, 2);
  buttons[1].click();
  assert.equal(selectedTab, 'preview');
});

test('createXrSectionHeading creates heading text', () => {
  const heading = createXrSectionHeading(adapter, 'Settings');
  const texts = heading.texts();
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'SETTINGS');
});

test('createXrChip renders label with dot indicator', () => {
  const chip = createXrChip(adapter, 'PLA', '#ff0000');
  const texts = chip.texts();
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'PLA');
});

console.log(`\nXrComponents: ${passed} tests passed.`);
