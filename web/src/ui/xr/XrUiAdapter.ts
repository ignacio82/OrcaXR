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
  /**
   * Any other reactive panel property — stroke, corner radius, `display`.
   *
   * The redesign's surfaces restyle far more than a fill: a menu row turns its
   * stroke amber when it is the open section, a pinned panel changes its grab
   * bar, and a row that does not match a search is taken out of the layout with
   * `display: 'none'` rather than merely hidden, because a hidden uikit node
   * still occupies its box. One typed method covers all of it instead of a new
   * adapter member per property.
   */
  setPanelProperties(panel: PanelNode, properties: XrPanelProperties): void;
  setTextProperties(text: TextNode, properties: XrTextProperties): void;
  /** Detach every child, for a list that is rebuilt rather than retyped. */
  clearChildren(panel: PanelNode): void;
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
  setPanelProperties: (panel: UIPanel, properties: XrPanelProperties) => {
    panel.setProperties(properties);
  },
  setTextProperties: (text: UIText, properties: XrTextProperties) => {
    text.setProperties(properties);
  },
  clearChildren: (panel: UIPanel) => {
    for (const child of [...panel.children]) {
      try {
        panel.remove(child);
      } catch {
        /* already detached by a parent teardown */
      }
    }
  },
});
