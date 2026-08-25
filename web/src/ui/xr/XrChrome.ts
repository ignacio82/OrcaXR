/**
 * XrChrome — the surface grammar the redesigned immersive shell is drawn in.
 *
 * Every spatial surface in the redesign is the same three things: a card body,
 * a grab bar the operator picks it up by, and rows or buttons inside it. Those
 * were previously hand-written per panel, which is why the shell drifted — a
 * row in the menu and a row in the sheet were "near enough" the same properties
 * and laid out to wildly different heights. They are one function each here.
 *
 * Two rules the redesign is explicit about are enforced by construction:
 *
 *  - **A control is at least 58 layout px on its short side.** With
 *    {@link XR_PIXEL_SIZE} at one millimetre that is a 58 mm target, above the
 *    ~44 mm floor at which hand tracking starts missing. {@link XR_HIT} names
 *    it so a caller cannot quietly draw a 30 px button.
 *  - **A withheld control states why, in place.** In a headset there is no
 *    hover tooltip to fall back on, so {@link createXrListRow} prints the
 *    reason under the label rather than hiding it behind a hover.
 *
 * Colour, radius and type come from the shared {@link tokens}; nothing here
 * carries a hex literal of its own.
 */
import { xrIcon } from '../icons';
import { tokens } from '../tokens';
import type { XrImageColor, XrPanelFill, XrPanelProperties, XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

/** Hit-target and spacing floors, in layout pixels — i.e. in millimetres. */
export const XR_HIT = Object.freeze({
  /** The redesign's minimum control, short side. */
  target: 58,
  /** A dense control that is still comfortably pressed: rows, chips, tabs. */
  row: 40,
  /** Clear space between two adjacent targets. */
  spacing: 10,
});

/** The type ramp the surfaces are drawn at, in layout pixels. */
export const XR_TYPE = Object.freeze({
  title: 22,
  heading: 17,
  body: 14,
  dense: 13,
  caption: 12,
  micro: 11,
  tag: 10,
});

export interface XrSurfaceStyleOptions {
  /** `chrome` is a cockpit surface; `elevated` is a popover over one. */
  readonly elevation?: 'chrome' | 'elevated';
  readonly padding?: number;
  readonly gap?: number;
  readonly direction?: 'row' | 'column';
  readonly accented?: boolean;
}

/**
 * The body of a spatial surface.
 *
 * `chrome` is the cockpit's own fill; `elevated` is what a popover, a palette
 * or a keypad uses, because those sit *over* chrome and a translucent panel on
 * a translucent panel stops being readable.
 */
export function createXrSurfaceBody<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrSurfaceStyleOptions = {},
): PanelNode {
  return ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: opts.direction ?? 'column',
    alignItems: 'stretch',
    fillColor: opts.elevation === 'elevated' ? C.bgElevated : C.bgChrome,
    cornerRadius: tokens.radius.lg,
    padding: opts.padding ?? tokens.space.md,
    gap: opts.gap ?? tokens.space.sm,
    strokeWidth: 1,
    strokeColor: opts.accented ? C.accent : C.stroke,
  });
}

/** A plain horizontal row; the layout primitive most of these surfaces are. */
export function createXrRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  properties: XrPanelProperties = {},
): PanelNode {
  return ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.space.sm,
    ...properties,
  });
}

/** A column; the other one. */
export function createXrColumn<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  properties: XrPanelProperties = {},
): PanelNode {
  return ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: tokens.space.xs,
    ...properties,
  });
}

/** Whitespace that pushes what follows to the far edge of a row. */
export function createXrSpacer<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
): PanelNode {
  return ui.createPanel({ flexGrow: 1, flexShrink: 1 });
}

/** An uppercase group label. Small, quiet, and never pressable. */
export function createXrHeading<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
): TextNode {
  return ui.createText(label.toUpperCase(), {
    fontSize: XR_TYPE.tag,
    fontWeight: 'bold',
    letterSpacing: 1,
    color: C.textMuted,
    paddingTop: tokens.space.xs,
    paddingBottom: 2,
  });
}

export interface XrGrabBarOptions {
  readonly title?: string;
  /** The one-line instruction the redesign prints beside the handle. */
  readonly hint?: string;
  readonly pinned?: boolean;
  readonly onPin?: () => void;
  readonly onClose?: () => void;
}

export interface XrGrabBar<PanelNode> {
  readonly root: PanelNode;
  setTitle(title: string): void;
  setPinned(pinned: boolean): void;
}

/**
 * The bar a grabbable surface is picked up by.
 *
 * The handle is drawn rather than implied: a panel that can be moved has to
 * look like it, or the operator never discovers that it can. The pin is beside
 * it because pinning is the answer to the question grabbing creates — "will
 * this still be here after I recenter?".
 */
export function createXrGrabBar<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrGrabBarOptions = {},
): XrGrabBar<PanelNode> {
  const root = createXrRow(ui, {
    height: 30,
    flexShrink: 0,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    gap: tokens.space.sm,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surfaceDisabled,
  });

  ui.appendChild(root, ui.createPanel({ width: 34, height: 4, cornerRadius: 2, fillColor: C.strokeStrong }));

  const title = ui.createText(opts.title ?? '', {
    fontSize: XR_TYPE.caption,
    fontWeight: 'bold',
    color: C.text,
    flexShrink: 1,
  });
  ui.appendChild(root, title);

  if (opts.hint) {
    ui.appendChild(
      root,
      ui.createText(opts.hint, { fontSize: XR_TYPE.micro, color: C.textMuted, flexGrow: 1, flexShrink: 1 }),
    );
  } else {
    ui.appendChild(root, createXrSpacer(ui));
  }

  let pinButton: PanelNode | undefined;
  if (opts.onPin) {
    pinButton = createXrIconButton(ui, {
      icon: 'magnet',
      size: 24,
      iconSize: 14,
      selected: opts.pinned === true,
      onClick: opts.onPin,
    }).root;
    ui.appendChild(root, pinButton);
  }
  if (opts.onClose) {
    ui.appendChild(root, createXrIconButton(ui, { icon: 'close', size: 24, iconSize: 14, onClick: opts.onClose }).root);
  }

  return {
    root,
    setTitle(next) {
      ui.setText(title, next);
    },
    setPinned(pinned) {
      if (!pinButton) return;
      ui.setPanelFill(pinButton, pinned ? C.accent : C.surface);
    },
  };
}

export interface XrPressableOptions {
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly danger?: boolean;
  readonly primary?: boolean;
  readonly onClick?: () => void;
}

interface Pressable<PanelNode> {
  readonly root: PanelNode;
  setEnabled(enabled: boolean): void;
  setSelected(selected: boolean): void;
}

/**
 * Wire one panel's rest/hover/selected/disabled fills.
 *
 * Everything pressable in this shell shares these four states, and getting
 * them from one place is what keeps a menu row and a rail button reading as
 * the same control rather than two designs.
 */
function makePressable<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrPressableOptions,
  build: (handlers: Pick<XrPanelProperties, 'onClick' | 'onHoverEnter' | 'onHoverExit'>) => PanelNode,
  tint?: (state: { enabled: boolean; selected: boolean }) => void,
): Pressable<PanelNode> {
  let enabled = opts.enabled !== false;
  let selected = opts.selected === true;
  let hovered = false;

  const restFill = (): XrPanelFill => {
    if (!enabled) return C.surfaceDisabled;
    if (selected) return opts.primary ? C.accent : opts.danger ? C.dangerSurface : C.surfaceActive;
    if (opts.primary) return C.accentSoft;
    if (opts.danger) return C.dangerSurface;
    return C.surface;
  };
  const apply = () => {
    ui.setPanelFill(
      root,
      !enabled ? C.surfaceDisabled : hovered ? (opts.primary ? C.accent : C.surfaceHover) : restFill(),
    );
    ui.setPanelOpacity(root, enabled ? 1 : 0.45);
    tint?.({ enabled, selected });
  };

  const root: PanelNode = build({
    onClick: () => {
      if (!enabled) return;
      opts.onClick?.();
    },
    onHoverEnter: () => {
      if (!enabled) return;
      hovered = true;
      apply();
    },
    onHoverExit: () => {
      hovered = false;
      apply();
    },
  });

  return {
    root,
    setEnabled(next) {
      enabled = next;
      apply();
    },
    setSelected(next) {
      selected = next;
      apply();
    },
  };
}

export interface XrIconButtonOptions extends XrPressableOptions {
  readonly icon: string;
  readonly size?: number;
  readonly iconSize?: number;
  readonly label?: string;
}

export type XrIconButton<PanelNode> = Pressable<PanelNode>;

/** A square icon control: recenter, undo, close, pin. */
export function createXrIconButton<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrIconButtonOptions,
): XrIconButton<PanelNode> {
  const size = opts.size ?? XR_HIT.row;
  let icon: ImageNode | undefined = undefined;
  const control = makePressable(
    ui,
    opts,
    (handlers) =>
      ui.createPanel({
        width: size,
        height: size,
        flexShrink: 0,
        cornerRadius: tokens.radius.sm,
        justifyContent: 'center',
        alignItems: 'center',
        fillColor: opts.enabled === false ? C.surfaceDisabled : C.surface,
        strokeWidth: 1,
        strokeColor: opts.danger ? C.dangerSurface : C.stroke,
        ...handlers,
      }),
    ({ enabled, selected }) => {
      if (icon) ui.setImageColor(icon, iconTint(opts, enabled, selected));
    },
  );
  icon = ui.createImage(xrIcon(opts.icon), {
    width: opts.iconSize ?? Math.round(size * 0.45),
    height: opts.iconSize ?? Math.round(size * 0.45),
    color: iconTint(opts, opts.enabled !== false, opts.selected === true),
  });
  ui.appendImage(control.root, icon);
  control.setSelected(opts.selected === true);
  control.setEnabled(opts.enabled !== false);
  return control;
}

function iconTint(opts: XrPressableOptions, enabled: boolean, selected: boolean): XrImageColor {
  if (!enabled) return C.textMuted;
  if (opts.primary) return C.onAccent;
  if (opts.danger) return C.danger;
  return selected ? C.text : C.text;
}

export interface XrTextButtonOptions extends XrPressableOptions {
  readonly label: string;
  readonly icon?: string;
  readonly iconSize?: number;
  readonly fontSize?: number;
  readonly height?: number;
  readonly flexGrow?: number;
  readonly flexShrink?: number;
  readonly paddingX?: number;
}

export interface XrTextButton<PanelNode, TextNode> extends Pressable<PanelNode> {
  setLabel(label: string): void;
  readonly labelNode: TextNode;
}

/** A labelled control: a menu title, a workspace tab, a desk verb. */
export function createXrTextButton<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrTextButtonOptions,
): XrTextButton<PanelNode, TextNode> {
  let icon: ImageNode | undefined = undefined;
  let label: TextNode | undefined = undefined;
  const control = makePressable(
    ui,
    opts,
    (handlers) =>
      ui.createPanel({
        height: opts.height ?? XR_HIT.row,
        flexShrink: opts.flexShrink ?? 0,
        flexGrow: opts.flexGrow,
        paddingLeft: opts.paddingX ?? tokens.space.md,
        paddingRight: opts.paddingX ?? tokens.space.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.space.xs,
        cornerRadius: tokens.radius.sm,
        fillColor: C.surface,
        strokeWidth: 1,
        strokeColor: opts.danger ? C.dangerSurface : C.stroke,
        ...handlers,
      }),
    ({ enabled, selected }) => {
      const tint = iconTint(opts, enabled, selected);
      if (icon) ui.setImageColor(icon, tint);
      if (label) ui.setTextProperties(label, { color: tint });
    },
  );
  if (opts.icon) {
    icon = ui.createImage(xrIcon(opts.icon), {
      width: opts.iconSize ?? 18,
      height: opts.iconSize ?? 18,
      flexShrink: 0,
      color: iconTint(opts, opts.enabled !== false, opts.selected === true),
    });
    ui.appendImage(control.root, icon);
  }
  label = ui.createText(opts.label, {
    fontSize: opts.fontSize ?? XR_TYPE.body,
    fontWeight: opts.primary ? 'bold' : 'medium',
    color: iconTint(opts, opts.enabled !== false, opts.selected === true),
    flexShrink: 1,
  });
  ui.appendChild(control.root, label);
  control.setSelected(opts.selected === true);
  control.setEnabled(opts.enabled !== false);
  const labelNode = label as TextNode;
  return { ...control, labelNode, setLabel: (next) => ui.setText(labelNode, next) };
}

export interface XrListRowOptions extends XrPressableOptions {
  readonly label: string;
  readonly icon?: string;
  /** Right-aligned secondary text: a shortcut, a value, a count. */
  readonly trailing?: string;
  /** A short uppercase tag at the far end: the palette's group, `UNAVAILABLE`. */
  readonly tag?: string;
  /**
   * Why this row cannot run, printed under the label.
   *
   * Not a tooltip. There is no pointer to rest in a headset, so a reason that
   * is only revealed on hover is a reason nobody reads.
   */
  readonly reason?: string;
  readonly hint?: string;
  readonly indent?: number;
  readonly fontSize?: number;
}

export type XrListRow<PanelNode> = Pressable<PanelNode>;

/**
 * One row of any list this shell draws: a menu item, a palette result, a
 * context-menu entry, a node in the Objects tree.
 *
 * Every list goes through here. A second hand-written row — same properties,
 * near enough — once laid out to 35,000 px tall and painted as a featureless
 * slab, so "near enough" is not something that can be eyeballed against a
 * flexbox engine.
 */
export function createXrListRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrListRowOptions,
): XrListRow<PanelNode> {
  let icon: ImageNode | undefined = undefined;
  let label: TextNode | undefined = undefined;
  const control = makePressable(
    ui,
    opts,
    (handlers) =>
      ui.createPanel({
        width: '100%',
        minHeight: XR_HIT.row,
        flexShrink: 0,
        marginLeft: opts.indent ?? 0,
        paddingLeft: tokens.space.md,
        paddingRight: tokens.space.md,
        paddingTop: tokens.space.xs,
        paddingBottom: tokens.space.xs,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 2,
        cornerRadius: tokens.radius.sm,
        fillColor: C.surface,
        ...handlers,
      }),
    ({ enabled }) => {
      const tint = enabled ? C.text : C.textMuted;
      if (icon) ui.setImageColor(icon, !enabled ? C.textMuted : opts.danger ? C.danger : tint);
      if (label) ui.setTextProperties(label, { color: !enabled ? C.textMuted : opts.danger ? C.danger : tint });
    },
  );

  const line = createXrRow(ui, { gap: tokens.space.sm });
  ui.appendChild(control.root, line);
  if (opts.icon) {
    icon = ui.createImage(xrIcon(opts.icon), { width: 20, height: 20, flexShrink: 0, color: C.text });
    ui.appendImage(line, icon);
  }
  label = ui.createText(opts.label, {
    fontSize: opts.fontSize ?? XR_TYPE.body,
    color: C.text,
    flexGrow: 1,
    flexShrink: 1,
  });
  ui.appendChild(line, label);
  if (opts.trailing) {
    ui.appendChild(line, ui.createText(opts.trailing, { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 }));
  }
  if (opts.tag) {
    ui.appendChild(line, createXrTag(ui, opts.tag));
  }
  const secondary = opts.reason ?? opts.hint;
  if (secondary) {
    ui.appendChild(
      control.root,
      ui.createText(secondary, {
        fontSize: XR_TYPE.micro,
        color: opts.reason ? C.warn : C.textMuted,
        marginLeft: opts.icon ? 28 : 0,
        flexShrink: 1,
      }),
    );
  }
  control.setSelected(opts.selected === true);
  control.setEnabled(opts.enabled !== false);
  return control;
}

/** A small uppercase pill: a group name, a state, a count. */
export function createXrTag<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
  color: string = C.textMuted,
): PanelNode {
  const tag = ui.createPanel({
    flexShrink: 0,
    paddingLeft: tokens.space.xs,
    paddingRight: tokens.space.xs,
    paddingTop: 3,
    paddingBottom: 3,
    cornerRadius: 6,
    fillColor: C.surface,
    justifyContent: 'center',
    alignItems: 'center',
  });
  ui.appendChild(
    tag,
    ui.createText(label.toUpperCase(), { fontSize: XR_TYPE.tag, fontWeight: 'bold', letterSpacing: 0.6, color }),
  );
  return tag;
}

/** A coloured dot beside a label: a filament slot, a printer state, a role. */
export function createXrSwatchChip<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
  color: string,
  onClick?: () => void,
): PanelNode {
  const chip = ui.createPanel({
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    paddingTop: 5,
    paddingBottom: 5,
    cornerRadius: 6,
    fillColor: C.surface,
    onClick,
  });
  ui.appendChild(chip, ui.createPanel({ width: 8, height: 8, cornerRadius: 4, fillColor: color }));
  ui.appendChild(chip, ui.createText(label, { fontSize: XR_TYPE.micro, color: C.text }));
  return chip;
}

export interface XrFieldOptions {
  readonly value: string;
  readonly placeholder?: string;
  readonly icon?: string;
  readonly trailing?: string;
  readonly accented?: boolean;
  readonly onClick?: () => void;
}

export interface XrField<PanelNode, TextNode> {
  readonly root: PanelNode;
  readonly valueNode: TextNode;
  setValue(value: string): void;
}

/**
 * A field that opens something rather than accepting a keystroke.
 *
 * There is no focus and no caret in this shell; a "text field" is a control
 * that opens the keypad. Drawing it as a field anyway is what makes it
 * recognisable — the operator knows what a search box looks like.
 */
export function createXrField<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  opts: XrFieldOptions,
): XrField<PanelNode, TextNode> {
  const root = createXrRow(ui, {
    minHeight: XR_HIT.row,
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: tokens.space.md,
    paddingRight: tokens.space.md,
    cornerRadius: tokens.radius.sm,
    fillColor: C.bgSunken,
    strokeWidth: 1,
    strokeColor: opts.accented ? C.accent : C.stroke,
    onClick: opts.onClick,
  });
  if (opts.icon) {
    ui.appendImage(
      root,
      ui.createImage(xrIcon(opts.icon), { width: 18, height: 18, flexShrink: 0, color: C.textMuted }),
    );
  }
  const shown = opts.value || opts.placeholder || '';
  const valueNode = ui.createText(shown, {
    fontSize: XR_TYPE.body,
    color: opts.value ? C.text : C.textMuted,
    flexGrow: 1,
    flexShrink: 1,
  });
  ui.appendChild(root, valueNode);
  if (opts.trailing) {
    ui.appendChild(root, ui.createText(opts.trailing, { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 }));
  }
  return {
    root,
    valueNode,
    setValue(value: string) {
      ui.setText(valueNode, value || opts.placeholder || '');
      ui.setTextProperties(valueNode, { color: value ? C.text : C.textMuted });
    },
  };
}

export interface XrSegmentedItem {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
}

export interface XrSegmented<PanelNode> {
  readonly root: PanelNode;
  setActive(id: string): void;
}

/** A row of mutually exclusive choices: the settings panel's three scopes. */
export function createXrSegmented<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  items: readonly XrSegmentedItem[],
  activeId: string,
  onSelect: (id: string) => void,
): XrSegmented<PanelNode> {
  const root = createXrRow(ui, { gap: tokens.space.xs, flexShrink: 0 });
  const buttons = new Map<string, XrTextButton<PanelNode, TextNode>>();
  for (const item of items) {
    const button = createXrTextButton(ui, {
      label: item.label,
      fontSize: XR_TYPE.dense,
      flexGrow: 1,
      enabled: item.enabled !== false,
      selected: item.id === activeId,
      onClick: () => onSelect(item.id),
    });
    buttons.set(item.id, button);
    ui.appendChild(root, button.root);
  }
  return {
    root,
    setActive(id: string) {
      for (const [key, button] of buttons) button.setSelected(key === id);
    },
  };
}

export interface XrProgressBar<PanelNode> {
  readonly root: PanelNode;
  /** `null` hides the bar; a fraction in `[0, 1]` fills it. */
  setProgress(fraction: number | null): void;
}

/** A thin determinate bar. Slice progress lives on the desk, not over the plate. */
export function createXrProgressBar<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  height = 5,
): XrProgressBar<PanelNode> {
  const root = ui.createPanel({
    width: '100%',
    height,
    flexGrow: 1,
    flexShrink: 1,
    cornerRadius: Math.round(height / 2),
    fillColor: C.stroke,
    flexDirection: 'row',
    alignItems: 'center',
  });
  const fill = ui.createPanel({ width: '0%', height, cornerRadius: Math.round(height / 2), fillColor: C.accent });
  ui.appendChild(root, fill);
  return {
    root,
    setProgress(fraction) {
      const clamped = fraction === null ? 0 : Math.min(1, Math.max(0, fraction));
      ui.setPanelProperties(root, { display: fraction === null ? 'none' : 'flex' });
      ui.setPanelProperties(fill, { width: `${Math.round(clamped * 100)}%` });
    },
  };
}

/** Take a node out of the layout, or put it back. `visible` is not enough:
 *  a hidden uikit node still occupies its box and the list keeps its gap. */
export function setXrDisplayed<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  panel: PanelNode,
  displayed: boolean,
): void {
  ui.setPanelProperties(panel, { display: displayed ? 'flex' : 'none' });
}
