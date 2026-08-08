/**
 * Typed boundary around the exact XRBlocks 0.17.0 UIBlocks primitives used by
 * OrcaXR composites. Presentation code receives this small adapter instead of
 * guessing constructor options or mutating reactive properties directly.
 */
import {
  UIImage,
  UIPanel,
  type UIImageProperties,
  type UIPanelProperties,
} from 'xrblocks/addons/uiblocks/src/index.js';

export type XrImageProperties = UIImageProperties;
export type XrPanelProperties = UIPanelProperties;
export type XrPanelFill = Parameters<UIPanel['setFillColor']>[0];
export type XrImageColor = Parameters<UIImage['setColor']>[0];

/** Mockable operations required by OrcaXR's composed action buttons. */
export interface XrUiAdapter<PanelNode, ImageNode> {
  createPanel(properties: XrPanelProperties): PanelNode;
  createImage(src: string, properties: XrImageProperties): ImageNode;
  appendImage(panel: PanelNode, image: ImageNode): void;
  setPanelFill(panel: PanelNode, fill: XrPanelFill): void;
  setPanelOpacity(panel: PanelNode, opacity: number): void;
  setImageColor(image: ImageNode, color: XrImageColor): void;
}

/** Production adapter. Every mutation goes through a pinned signal-aware API. */
export const xrBlocksUiAdapter: XrUiAdapter<UIPanel, UIImage> = Object.freeze({
  createPanel: (properties: XrPanelProperties) => new UIPanel(properties),
  createImage: (src: string, properties: XrImageProperties) => new UIImage(src, properties),
  appendImage: (panel: UIPanel, image: UIImage) => {
    panel.add(image);
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
});
