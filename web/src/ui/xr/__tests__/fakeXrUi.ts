/**
 * A headset-free stand-in for the pinned UIBlocks primitives.
 *
 * The immersive shell cannot be opened by a headless browser, so every spatial
 * composite is asserted against this instead: the tree it built, the text in
 * it, and what each pressable node does when it is pressed. It is one module
 * rather than one per test file because a fake that drifts between tests is a
 * fake that stops proving the composites agree with each other.
 */
import * as THREE from 'three';
import type { XrImageProperties, XrPanelProperties, XrTextProperties, XrUiAdapter } from '../XrUiAdapter';

export type FakeNode = FakePanel | FakeText | FakeImage;

export class FakePanel {
  fillColor: string;
  opacity: number;
  props: XrPanelProperties;
  readonly children: FakeNode[] = [];
  constructor(readonly opts: XrPanelProperties) {
    this.props = { ...opts };
    this.fillColor = String(opts.fillColor ?? '');
    this.opacity = typeof opts.opacity === 'number' ? opts.opacity : 1;
  }
  get displayed(): boolean {
    return this.props.display !== 'none';
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
  /** Every text node in the subtree, in layout order. */
  texts(): FakeText[] {
    return this.children.flatMap((c) => (c instanceof FakeText ? [c] : c instanceof FakePanel ? c.texts() : []));
  }
  /** The strings an operator can read on this surface. */
  labels(): string[] {
    return this.texts().map((t) => t.text);
  }
  /** Every pressable node in the subtree. */
  buttons(): FakePanel[] {
    return this.children.flatMap((c) =>
      c instanceof FakePanel ? [...(c.opts.onClick ? [c] : []), ...c.buttons()] : [],
    );
  }
  panels(): FakePanel[] {
    return this.children.flatMap((c) => (c instanceof FakePanel ? [c, ...c.panels()] : []));
  }
  images(): FakeImage[] {
    return this.children.flatMap((c) => (c instanceof FakeImage ? [c] : c instanceof FakePanel ? c.images() : []));
  }
  /** The pressable node whose own subtree reads `label`. */
  findButton(label: string): FakePanel | undefined {
    return this.buttons().find((b) => b.labels().some((text) => text === label));
  }
}

export class FakeText {
  props: XrTextProperties;
  constructor(
    public text: string,
    readonly opts: XrTextProperties,
  ) {
    this.props = { ...opts };
  }
}

export class FakeImage {
  color: string;
  constructor(
    public src: string,
    readonly opts: XrImageProperties,
  ) {
    this.color = String(opts.color ?? '');
  }
}

export function createFakeXrUi(): XrUiAdapter<FakePanel, FakeImage, FakeText> {
  return {
    createPanel: (opts) => new FakePanel(opts),
    createImage: (src, opts) => new FakeImage(src, opts),
    createText: (text, opts) => new FakeText(text, opts),
    appendImage: (panel, image) => {
      panel.children.push(image);
    },
    appendChild: (panel, child) => {
      panel.children.push(child as FakeNode);
    },
    setPanelFill: (panel, fill) => {
      panel.fillColor = String(fill);
      panel.props = { ...panel.props, fillColor: fill };
    },
    setPanelOpacity: (panel, opacity) => {
      panel.opacity = opacity;
      panel.props = { ...panel.props, opacity };
    },
    setImageColor: (image, color) => {
      image.color = String(color);
    },
    setText: (text, value) => {
      text.text = value;
    },
    setPanelProperties: (panel, properties) => {
      panel.props = { ...panel.props, ...properties };
      if (properties.fillColor !== undefined) panel.fillColor = String(properties.fillColor);
      if (typeof properties.opacity === 'number') panel.opacity = properties.opacity;
    },
    setTextProperties: (text, properties) => {
      text.props = { ...text.props, ...properties };
    },
    clearChildren: (panel) => {
      panel.children.length = 0;
    },
  };
}
