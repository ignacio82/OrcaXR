/**
 * XrMenuBar — the flat shell's menu strip and tab strip, in the headset.
 *
 * The immersive shell used to put one unlabelled `Menu` button above the plate,
 * and everything behind it: seven menu sections, every inspector panel, the
 * workspace switch. An operator who knows where `View ▸ Show Overhang` lives on
 * a screen had no way to use that knowledge in a headset, and the only way to
 * find out what the app could do was to open the launcher and read.
 *
 * So this is the same bar, with the same names, in the same order: the seven
 * {@link MENU_SECTIONS} plus `Panels` — {@link XR_PANELS_SECTION_ID}, which the
 * registry has always declared so that no `dom-inspector` action is silently
 * absent from XR, and which had no home to be reached from. Under it are the
 * four workspace tabs the flat shell has, each with the live sub-line the flat
 * shell puts in its tab strip, and the printer's state.
 *
 * Printer status collapses into this bar rather than floating as its own
 * surface: it used to sit above the tool rail, over the operator's left
 * shoulder, which is exactly where a thing you must not miss should not be.
 */
import type { ActionRegistry } from '../../actions/ActionRegistry';
import { MENU_SECTIONS, XR_PANELS_SECTION_ID } from '../../actions/ActionRegistry';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_HIT,
  XR_TYPE,
  createXrField,
  createXrIconButton,
  createXrRow,
  createXrSurfaceBody,
  createXrTextButton,
} from './XrChrome';
import type { XrWorkspaceMode } from './XrLayout';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrMenuBarSection {
  readonly id: string;
  readonly label: string;
}

/**
 * The sections this bar draws, from the registry itself.
 *
 * A section with nothing in it is left out, so the bar never offers a dead end;
 * `Panels` is appended for the same reason the registry declares it — every
 * action the flat shell keeps in its inspector is reachable in the headset, and
 * this is where that promise is kept.
 */
export function xrMenuBarSections(registry: ActionRegistry): XrMenuBarSection[] {
  const menu = registry.forSurface('xr-menu');
  const sections: XrMenuBarSection[] = MENU_SECTIONS.filter((section) =>
    menu.some((action) => String(action.menuSection) === section.id),
  ).map((section) => ({ id: String(section.id), label: section.label }));
  if (registry.forSurface('xr-inspector').length > 0) {
    sections.push({ id: XR_PANELS_SECTION_ID, label: t('ui.xrMenuBar.panels', 'Panels') });
  }
  return sections;
}

export interface XrPrinterStatusSummary {
  readonly label: string;
  readonly detail: string;
  /** A state colour from the shared palette; never the only carrier of state. */
  readonly color: string;
}

export interface XrMenuBarContext {
  readonly sections: readonly XrMenuBarSection[];
  readonly openSectionId: string | null;
  readonly activeMode: XrWorkspaceMode;
  /** The live second line under each tab, exactly as the flat tab strip reads. */
  readonly modeDetail: Readonly<Record<XrWorkspaceMode, string>>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly isDirty: boolean;
  readonly printer: XrPrinterStatusSummary | null;
  onOpenSection(id: string, anchor: unknown): void;
  onOpenPalette(): void;
  onSelectMode(mode: XrWorkspaceMode): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onRecenter(): void;
  onExit(): void;
}

export interface XrMenuBarRender<PanelNode> {
  readonly root: PanelNode;
  /** The section titles, so a popover can be drawn under the one it belongs to. */
  readonly sectionAnchors: ReadonlyMap<string, PanelNode>;
  refresh(ctx: XrMenuBarContext): void;
}

/**
 * The four workspaces, named exactly as the flat tab strip names them.
 *
 * Written out rather than templated because message extraction reads the call
 * sites: an id built from a variable cannot be found by the extractor, so a
 * computed `t()` is a label no translator ever sees.
 */
const MODE_LABELS: Readonly<Record<XrWorkspaceMode, () => string>> = {
  prepare: () => t('ui.xrMenuBar.mode.prepare', 'Prepare'),
  preview: () => t('ui.xrMenuBar.mode.preview', 'Preview'),
  device: () => t('ui.xrMenuBar.mode.device', 'Device'),
  project: () => t('ui.xrMenuBar.mode.project', 'Project'),
};

export function renderXrMenuBar<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrMenuBarContext,
): XrMenuBarRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { padding: tokens.space.sm, gap: 6, accented: true });
  ui.appendChild(root, body);

  // ---- Row one: the menu strip -------------------------------------------
  const menuRow = createXrRow(ui, { gap: 6, flexShrink: 0 });
  ui.appendChild(body, menuRow);

  const titles = createXrRow(ui, { gap: 2, flexShrink: 0, width: 'auto' });
  ui.appendChild(menuRow, titles);

  const sectionAnchors = new Map<string, PanelNode>();
  const sectionButtons = new Map<string, ReturnType<typeof createXrTextButton<PanelNode, ImageNode, TextNode>>>();
  for (const section of ctx.sections) {
    const button = createXrTextButton(ui, {
      label: section.label,
      fontSize: XR_TYPE.body,
      height: 38,
      paddingX: 10,
      selected: section.id === ctx.openSectionId,
      onClick: () => ctx.onOpenSection(section.id, sectionAnchors.get(section.id)),
    });
    // A menu title is chrome, not a raised control: the strip reads as one bar
    // with eight words on it until one of them is open.
    ui.setPanelProperties(button.root, { strokeWidth: 0, fillColor: '#00000000' });
    sectionAnchors.set(section.id, button.root);
    sectionButtons.set(section.id, button);
    ui.appendChild(titles, button.root);
  }

  const palette = createXrField(ui, {
    value: '',
    placeholder: t('ui.xrMenuBar.searchCommands', 'Search commands'),
    icon: 'search',
    trailing: '⌘K',
    onClick: () => ctx.onOpenPalette(),
  });
  ui.setPanelProperties(palette.root, { minWidth: 120, height: 38, minHeight: 38 });
  ui.appendChild(menuRow, palette.root);

  const quick = createXrRow(ui, { gap: 4, flexShrink: 0, width: 'auto' });
  ui.appendChild(menuRow, quick);
  const saveButton = createXrIconButton(ui, {
    icon: 'save',
    size: 38,
    iconSize: 18,
    primary: ctx.isDirty,
    onClick: () => ctx.onSave(),
  });
  const undoButton = createXrIconButton(ui, {
    icon: 'undo',
    size: 38,
    iconSize: 18,
    enabled: ctx.canUndo,
    onClick: () => ctx.onUndo(),
  });
  const redoButton = createXrIconButton(ui, {
    icon: 'redo',
    size: 38,
    iconSize: 18,
    enabled: ctx.canRedo,
    onClick: () => ctx.onRedo(),
  });
  // Recenter is always one pinch away because room-scale operators regularly
  // change where they are standing relative to the workspace, and a bar they
  // cannot see is a bar they cannot recentre from.
  const recenterButton = createXrIconButton(ui, {
    icon: 'view_default',
    size: 38,
    iconSize: 18,
    onClick: () => ctx.onRecenter(),
  });
  for (const control of [saveButton, undoButton, redoButton, recenterButton]) ui.appendChild(quick, control.root);

  const exit = createXrTextButton(ui, {
    label: t('ui.xrMenuBar.exitXr', 'Exit XR'),
    icon: 'logout',
    iconSize: 16,
    fontSize: XR_TYPE.dense,
    height: 38,
    paddingX: 10,
    danger: true,
    onClick: () => ctx.onExit(),
  });
  ui.appendChild(menuRow, exit.root);

  // ---- Row two: the tab strip and the printer ----------------------------
  const tabRow = createXrRow(ui, { gap: 6, flexShrink: 0 });
  ui.appendChild(body, tabRow);

  const track = createXrRow(ui, {
    gap: 6,
    padding: 4,
    cornerRadius: tokens.radius.md,
    fillColor: C.bgSunken,
    flexGrow: 1,
    flexShrink: 1,
  });
  ui.appendChild(tabRow, track);

  const tabs = new Map<XrWorkspaceMode, { root: PanelNode; label: TextNode; detail: TextNode }>();
  for (const mode of Object.keys(MODE_LABELS) as XrWorkspaceMode[]) {
    const tab = ui.createPanel({
      flexGrow: 1,
      flexShrink: 1,
      height: XR_HIT.row,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 1,
      cornerRadius: tokens.radius.sm,
      fillColor: '#00000000',
      strokeWidth: 1,
      strokeColor: '#00000000',
      onClick: () => ctx.onSelectMode(mode),
    });
    const label = ui.createText(MODE_LABELS[mode](), {
      fontSize: XR_TYPE.body,
      fontWeight: 'bold',
      color: C.text,
    });
    const detail = ui.createText(ctx.modeDetail[mode], { fontSize: XR_TYPE.micro, color: C.textMuted });
    ui.appendChild(tab, label);
    ui.appendChild(tab, detail);
    ui.appendChild(track, tab);
    tabs.set(mode, { root: tab, label, detail });
  }

  const printer = createXrRow(ui, {
    width: 'auto',
    flexShrink: 0,
    gap: 6,
    height: XR_HIT.row,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
    strokeWidth: 1,
    strokeColor: C.stroke,
  });
  const printerDot = ui.createPanel({ width: 8, height: 8, cornerRadius: 4, fillColor: C.textMuted, flexShrink: 0 });
  const printerLabel = ui.createText('', { fontSize: XR_TYPE.dense, color: C.text, flexShrink: 0 });
  const printerDetail = ui.createText('', { fontSize: XR_TYPE.caption, color: C.textMuted, flexShrink: 1 });
  ui.appendChild(printer, printerDot);
  ui.appendChild(printer, printerLabel);
  ui.appendChild(printer, printerDetail);
  ui.appendChild(tabRow, printer);

  const apply = (next: XrMenuBarContext): void => {
    for (const [id, button] of sectionButtons) {
      const open = id === next.openSectionId;
      button.setSelected(open);
      ui.setPanelProperties(button.root, {
        strokeWidth: 0,
        fillColor: open ? C.warnSurface : '#00000000',
      });
      ui.setTextProperties(button.labelNode, { color: open ? C.accentSoft : C.text });
    }
    saveButton.setEnabled(true);
    ui.setPanelFill(saveButton.root, next.isDirty ? C.accentSoft : C.surface);
    undoButton.setEnabled(next.canUndo);
    redoButton.setEnabled(next.canRedo);
    for (const [mode, tab] of tabs) {
      const active = mode === next.activeMode;
      ui.setPanelProperties(tab.root, {
        fillColor: active ? C.warnSurface : '#00000000',
        strokeColor: active ? C.accent : '#00000000',
      });
      ui.setTextProperties(tab.label, { color: active ? C.text : C.textMuted });
      ui.setTextProperties(tab.detail, { color: active ? C.accentSoft : C.textMuted });
      ui.setText(tab.detail, next.modeDetail[mode]);
    }
    // No printer is a fact, not an absence: the chip says so rather than
    // vanishing and leaving the operator to wonder whether it failed to load.
    const status = next.printer;
    ui.setPanelFill(printerDot, status ? status.color : C.textMuted);
    ui.setText(printerLabel, status ? status.label : t('ui.xrMenuBar.noPrinter', 'No printer'));
    ui.setText(printerDetail, status ? status.detail : t('ui.xrMenuBar.notConnected', 'not connected'));
  };
  apply(ctx);

  return { root: body, sectionAnchors, refresh: apply };
}
