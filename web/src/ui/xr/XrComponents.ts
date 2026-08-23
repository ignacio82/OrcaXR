/**
 * XrComponents — reusable spatial UI widgets and helpers for OrcaXR's immersive shell.
 *
 * Implements standard UIBlocks composite primitives (cards, buttons, steppers,
 * tab bars, chips, and section dividers) backed by the mockable {@link XrUiAdapter}
 * and design {@link tokens}.
 */
import { xrIcon } from '../icons';
import { tokens } from '../tokens';
import type { XrImageColor, XrPanelFill, XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrButtonControl<PanelNode, ImageNode, TextNode> {
  readonly root: PanelNode;
  readonly iconNode?: ImageNode;
  readonly textNode?: TextNode;
  readonly badgeNode?: TextNode;
  setEnabled(enabled: boolean): void;
  setSelected(selected: boolean): void;
  setBusy(busy: boolean): void;
  setText(text: string): void;
  setBadge(badge: string | null): void;
  dispose(): void;
  readonly disposed: boolean;
}

export interface XrButtonOptions {
  label?: string;
  icon?: string;
  iconSize?: number;
  width?: any;
  height?: any;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fontSize?: number;
  badge?: string;
  danger?: boolean;
  primary?: boolean;
  enabled?: boolean;
  selected?: boolean;
  flexGrow?: number;
  flexShrink?: number;
  justifyContent?: 'center' | 'flex-start' | 'space-between' | 'flex-end';
  onClick?: () => void;
  onHoverEnter?: () => void;
  onHoverExit?: () => void;
}

/** Render a high-contrast, accessible spatial button. */
export function createXrButton<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrButtonOptions,
): XrButtonControl<PanelNode, ImageNode, TextNode> {
  let enabled = opts.enabled !== false;
  let selected = opts.selected === true;
  let busy = false;
  let hovered = false;
  let disposed = false;

  const defaultFill: XrPanelFill = opts.primary ? C.accentSoft : opts.danger ? C.dangerSurface : C.surface;
  const strokeColor = opts.danger ? C.dangerSurface : opts.primary ? C.accentSoft : C.stroke;

  const root = ui.createPanel({
    width: opts.width ?? 'auto',
    height: opts.height ?? 'auto',
    paddingLeft: opts.paddingLeft ?? 12,
    paddingRight: opts.paddingRight ?? 12,
    paddingTop: opts.paddingTop ?? 8,
    paddingBottom: opts.paddingBottom ?? 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: opts.justifyContent ?? 'center',
    gap: 8,
    cornerRadius: tokens.radius.sm,
    fillColor: enabled ? defaultFill : C.surfaceDisabled,
    opacity: enabled ? 1 : 0.45,
    strokeWidth: 1,
    strokeColor,
    flexGrow: opts.flexGrow,
    flexShrink: opts.flexShrink,
    onClick: () => {
      if (!enabled || busy || disposed) return;
      opts.onClick?.();
    },
    onHoverEnter: () => {
      if (!enabled || busy || disposed) return;
      hovered = true;
      applyVisuals();
      opts.onHoverEnter?.();
    },
    onHoverExit: () => {
      hovered = false;
      applyVisuals();
      opts.onHoverExit?.();
    },
  });

  let iconNode: ImageNode | undefined;
  if (opts.icon) {
    const iconSize = opts.iconSize ?? 20;
    iconNode = ui.createImage(xrIcon(opts.icon), {
      width: iconSize,
      height: iconSize,
      color: opts.primary ? '#000000' : opts.danger ? C.danger : '#ffffff',
    });
    ui.appendImage(root, iconNode);
  }

  let textNode: TextNode | undefined;
  if (opts.label) {
    textNode = ui.createText(opts.label, {
      fontSize: opts.fontSize ?? 14,
      fontWeight: opts.primary ? 'bold' : 'medium',
      color: opts.primary ? '#000000' : '#ffffff',
    });
    ui.appendChild(root, textNode);
  }

  let badgeNode: TextNode | undefined;
  if (opts.badge) {
    badgeNode = ui.createText(opts.badge, {
      fontSize: 11,
      fontWeight: 'bold',
      color: C.accentSoft,
    });
    ui.appendChild(root, badgeNode);
  }

  function applyVisuals(): void {
    const interactive = enabled && !busy && !disposed;
    ui.setPanelOpacity(root, interactive ? 1 : 0.45);
    const fill: XrPanelFill = !interactive
      ? C.surfaceDisabled
      : hovered
        ? opts.primary
          ? C.accent
          : opts.danger
            ? '#ff52524d'
            : C.surfaceHover
        : selected
          ? C.surfaceActive
          : opts.primary
            ? C.accentSoft
            : opts.danger
              ? C.dangerSurface
              : C.surface;
    ui.setPanelFill(root, fill);

    const textColor: XrImageColor = !interactive
      ? '#8a94a0'
      : opts.primary
        ? '#000000'
        : selected
          ? '#ffffff'
          : opts.danger
            ? C.danger
            : '#eef2f6';
    if (iconNode) ui.setImageColor(iconNode, textColor);
  }

  return {
    root,
    iconNode,
    textNode,
    badgeNode,
    setEnabled(next) {
      enabled = next;
      applyVisuals();
    },
    setSelected(next) {
      selected = next;
      applyVisuals();
    },
    setBusy(next) {
      busy = next;
      applyVisuals();
    },
    setText(text) {
      if (textNode) ui.setText(textNode, text);
    },
    setBadge(badge) {
      if (badgeNode) ui.setText(badgeNode, badge ?? '');
    },
    dispose() {
      disposed = true;
      applyVisuals();
    },
    get disposed() {
      return disposed;
    },
  };
}

export interface XrStepperControl<PanelNode, TextNode> {
  readonly root: PanelNode;
  readonly valueNode: TextNode;
  setValue(val: string): void;
  setEnabled(enabled: boolean): void;
}

/** Render a single numeric stepper row (`-` [Value] `+`). */
export function createXrStepperRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
  initialValue: string,
  unit: string,
  onStep: (direction: 1 | -1) => void,
): XrStepperControl<PanelNode, TextNode> {
  const root = ui.createPanel({
    width: '100%',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surfaceDisabled,
  });

  const labelNode = ui.createText(label, {
    fontSize: 14,
    color: '#c7ced6',
    flexGrow: 1,
    flexShrink: 1,
  });
  ui.appendChild(root, labelNode);

  const decBtn = createXrButton(ui, {
    label: '−',
    fontSize: 16,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 4,
    paddingBottom: 4,
    onClick: () => onStep(-1),
  });
  ui.appendChild(root, decBtn.root);

  const unitSuffix = unit ? ` ${unit}` : '';
  const valueNode = ui.createText(`${initialValue}${unitSuffix}`, {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#eef2f6',
    flexShrink: 0,
  });
  ui.appendChild(root, valueNode);

  const incBtn = createXrButton(ui, {
    label: '+',
    fontSize: 16,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 4,
    paddingBottom: 4,
    onClick: () => onStep(1),
  });
  ui.appendChild(root, incBtn.root);

  return {
    root,
    valueNode,
    setValue(val: string) {
      ui.setText(valueNode, `${val}${unitSuffix}`);
    },
    setEnabled(enabled: boolean) {
      decBtn.setEnabled(enabled);
      incBtn.setEnabled(enabled);
    },
  };
}

export interface XrTabItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
}

export interface XrTabBarControl<PanelNode> {
  readonly root: PanelNode;
  setActiveTab(tabId: string): void;
}

/** Render a horizontal tab strip with active tab styling. */
export function createXrTabBar<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  tabs: readonly XrTabItem[],
  activeTabId: string,
  onSelectTab: (tabId: string) => void,
): XrTabBarControl<PanelNode> {
  const root = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 4,
    cornerRadius: tokens.radius.sm,
    fillColor: '#0000004d',
  });

  const buttons = new Map<string, XrButtonControl<PanelNode, ImageNode, TextNode>>();

  for (const tab of tabs) {
    const isSelected = tab.id === activeTabId;
    const btn = createXrButton(ui, {
      label: tab.label,
      icon: tab.icon,
      iconSize: 16,
      fontSize: 13,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 6,
      paddingBottom: 6,
      selected: isSelected,
      badge: tab.badge,
      flexGrow: 1,
      onClick: () => {
        onSelectTab(tab.id);
      },
    });
    buttons.set(tab.id, btn);
    ui.appendChild(root, btn.root);
  }

  return {
    root,
    setActiveTab(tabId: string) {
      for (const [id, btn] of buttons) {
        btn.setSelected(id === tabId);
      }
    },
  };
}

/** Render a section divider with uppercase title. */
export function createXrSectionHeading<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  title: string,
): PanelNode {
  const root = ui.createPanel({
    width: '100%',
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'column',
    gap: 4,
  });
  const text = ui.createText(title.toUpperCase(), {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#8a94a0',
  });
  ui.appendChild(root, text);
  return root;
}

/** Render a pill/chip badge. */
export function createXrChip<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
  color?: string,
  onPress?: () => void,
): PanelNode {
  const chip = ui.createPanel({
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 4,
    cornerRadius: 6,
    fillColor: color ? `${color}26` : C.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    onClick: onPress,
  });

  if (color) {
    const dot = ui.createPanel({
      width: 8,
      height: 8,
      cornerRadius: 4,
      fillColor: color,
    });
    ui.appendChild(chip, dot);
  }

  const text = ui.createText(label, {
    fontSize: 12,
    fontWeight: 'bold',
    color: color ?? '#ffffff',
  });
  ui.appendChild(chip, text);
  return chip;
}
