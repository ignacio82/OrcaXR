/**
 * Typed boundary around the exact XRBlocks 0.17.0 UIBlocks primitives used by
 * OrcaXR composites. Presentation code receives this small adapter instead of
 * guessing constructor options or mutating reactive properties directly.
 */
import {
  UIImage,
  UIPanel,
  UIText,
  type UIImageProperties,
  type UIPanelProperties,
  type UITextProperties,
} from 'xrblocks/addons/uiblocks/src/index.js';

export type XrImageProperties = UIImageProperties;
export type XrPanelProperties = UIPanelProperties;
export type XrTextProperties = UITextProperties;
export type XrPanelFill = Parameters<UIPanel['setFillColor']>[0];
export type XrImageColor = Parameters<UIImage['setColor']>[0];

/**
 * Mockable operations required by OrcaXR's composed action buttons.
 *
 * `TextNode` is defaulted so the button renderer, which draws no text, is
 * unaffected. Composites that do draw text — the scoped-settings rows — name it
 * and get the same benefit the buttons already had: they can be asserted
 * without a headset, a canvas, or a browser.
 */
export interface XrUiAdapter<PanelNode, ImageNode, TextNode = unknown> {
  createPanel(properties: XrPanelProperties): PanelNode;
  createImage(src: string, properties: XrImageProperties): ImageNode;
  createText(text: string, properties: XrTextProperties): TextNode;
  appendImage(panel: PanelNode, image: ImageNode): void;
  /** Append a panel or a text node; the tree a spatial layout is made of. */
  appendChild(panel: PanelNode, child: PanelNode | TextNode): void;
  setPanelFill(panel: PanelNode, fill: XrPanelFill): void;
  setPanelOpacity(panel: PanelNode, opacity: number): void;
  setImageColor(image: ImageNode, color: XrImageColor): void;
  setText(text: TextNode, value: string): void;
}

/** Production adapter. Every mutation goes through a pinned signal-aware API. */
export const xrBlocksUiAdapter: XrUiAdapter<UIPanel, UIImage, UIText> = Object.freeze({
  createPanel: (properties: XrPanelProperties) => new UIPanel(properties),
  createImage: (src: string, properties: XrImageProperties) => new UIImage(src, properties),
  createText: (text: string, properties: XrTextProperties) => new UIText(text, properties),
  appendImage: (panel: UIPanel, image: UIImage) => {
    panel.add(image);
  },
  appendChild: (panel: UIPanel, child: UIPanel | UIText) => {
    panel.add(child);
  },
  setPanelFill: (panel: UIPanel, fill: XrPanelFill) => {
    panel.setFillColor(fill);
  },
  setPanelOpacity: (panel: UIPanel, opacity: number) => {
    panel.setProperties({ opacity });
  },
  setImageColor: (image: UIImage, color: XrImageColor) => {
    image.setColor(color);
  },
  setText: (text: UIText, value: string) => {
    text.setText(value);
  },
});
