/**
 * XrImmersiveShell — the redesigned immersive shell, assembled.
 *
 * Every spatial surface in `XrLayout` is drawn from here, and every press goes
 * back out through one narrow {@link XrShellHost}: the registry, the canonical
 * projections, and the handful of callbacks a headset needs. The workspace owns
 * cards, poses and the scene; this owns *what is on them*, which is why the
 * whole shell can be built, pressed and asserted in a test with no headset, no
 * canvas and no WebXR session.
 *
 * The shape is deliberate. The old shell interleaved 1,200 lines of panel
 * construction with the workspace's scene code, so the only way to know whether
 * a control was wired to the thing it claimed to change was to put a headset
 * on. Nothing here touches three.js, `xb.core`, or a `UICard`.
 */
import type { Action, ActionRegistry, ActionSurface, ContextTarget } from '../../actions/ActionRegistry';
import { XR_PANELS_SECTION_ID, MENU_SECTIONS } from '../../actions/ActionRegistry';
import { INITIAL_UI_STATE, type UiStateShape } from '../../actions/UiState';
import type { ObjectTreeEntityRef, ObjectTreeProjection, ObjectTreeSelectionSnapshot } from '../../project/objects';
import type { ScopedStepperRow, ScopedStepperView } from '../../settings/editor/scopedStepper';
import type { GcodePreviewViewPatch } from '../../slicer/GcodePreviewSession';
import type { GcodePreviewPanelState } from '../dom/GcodePreviewPanel';
import { t } from '../../l10n/t';
import { renderXrCommandPalette } from './XrCommandPalette';
import { renderXrContextMenu } from './XrContextMenu';
import { renderXrDesk, type XrDeskContext, type XrDeskPlate, type XrDeskRender } from './XrDesk';
import { renderXrKeyboard, renderXrKeypad } from './XrKeypad';
import { XR_PINNABLE, type XrSurfaceId, type XrWorkspaceMode } from './XrLayout';
import {
  renderXrMenuBar,
  xrMenuBarSections,
  type XrMenuBarContext,
  type XrMenuBarRender,
  type XrPrinterStatusSummary,
} from './XrMenuBar';
import { renderXrMenuPopover } from './XrMenuPopover';
import { renderXrObjectsPanel } from './XrObjectsPanel';
import { renderXrPanelHost } from './XrPanelHost';
import { xrGroupPanelId, xrInspectorPanels, xrPanelGroup, type XrPanelDescriptor, type XrPanelId } from './XrPanels';
import { renderXrSettingsPanel } from './XrSettingsPanel';
import { XrShellState, type XrEntrySession } from './XrShellState';
import {
  renderXrToolRail,
  type XrRailStepper,
  type XrRailSwatch,
  type XrToolRailContext,
  type XrToolRailRender,
} from './XrToolRail';
import { createXrListRow, XR_TYPE } from './XrChrome';
import { tokens } from '../tokens';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

/** One spatial card, as far as this module is concerned. */
export interface XrCardHandle<PanelNode> {
  /** The panel this surface's content is appended to. */
  readonly content: PanelNode;
  show(): void;
  hide(): void;
  /** Detach everything previously drawn into `content`. */
  reset(): void;
  /**
   * Re-place the card. `anchor` is whatever the host recognises as a thing to
   * open beside — a menu title's panel, a pinch point — and `null` means the
   * surface's own place in the layout.
   */
  place(anchor: unknown): void;
}

export interface XrObjectsSnapshot {
  readonly projection: ObjectTreeProjection;
  readonly selection: ObjectTreeSelectionSnapshot;
  readonly defaultExpandedKeys: readonly string[];
}

/** Everything the shell asks of the workspace, and nothing else. */
export interface XrShellHost {
  readonly registry: ActionRegistry;
  /** `null` before the composition root injects an action context. */
  actionState(): Readonly<UiStateShape> | null;
  invoke(action: Action, surface: ActionSurface): void;

  workspaceMode(): XrWorkspaceMode;
  setWorkspaceMode(mode: XrWorkspaceMode): void;
  modeDetail(): Readonly<Record<XrWorkspaceMode, string>>;
  printerStatus(): XrPrinterStatusSummary | null;
  recenter(): void;
  exitSession(): void;

  plates(): readonly XrDeskPlate[];
  selectPlate(plateId: string): void;
  statusLine(): string;
  progress(): number | null;

  objects(): XrObjectsSnapshot | null;
  selectObject(entity: ObjectTreeEntityRef, rowKey: string): void;
  /** Actions offered for whatever is selected, already gated by the registry. */
  selectionActions(): readonly { readonly id: string; readonly label: string; readonly enabled: boolean }[];

  settingsView(): ScopedStepperView | null;
  cycleSettingsTarget(direction: 1 | -1): void;
  stepSetting(fieldId: string, direction: 1 | -1): void;
  setSettingValue(fieldId: string, raw: string): void;

  contextTarget(): ContextTarget;
  contextLabel(): string;

  previewState(): GcodePreviewPanelState | null;
  updatePreview(patch: GcodePreviewViewPatch): void;
  authorLayerEvent(type: 'pause' | 'custom', topZMm: number): void;

  activeTool(): string | null;
  /** The canonical filament palette, when a paint tool owns the rail. */
  paintSwatches(): readonly XrRailSwatch[];
  selectPaintSwatch(id: string): void;
  /** The active tool's own bounded numbers. */
  toolSteppers(): readonly XrRailStepper[];
  stepToolSetting(id: string, direction: 1 | -1): void;
  /** Where a transient surface should open; `null` uses the layout's own spot. */
  pinchAnchor(): unknown;
}

type Surfaces<PanelNode> = Readonly<Record<XrSurfaceId, XrCardHandle<PanelNode>>>;

export class XrImmersiveShell<PanelNode, ImageNode, TextNode> {
  readonly state: XrShellState;
  private drawing = false;
  private pendingDraw = false;
  /** The section title a popover is currently hanging from. */
  private menuAnchor: unknown = null;
  private deskLoadButton: PanelNode | null = null;
  private menuBar: XrMenuBarRender<PanelNode> | null = null;
  private toolRail: XrToolRailRender<PanelNode> | null = null;
  private desk: XrDeskRender<PanelNode> | null = null;
  private previewScrubber: {
    refresh(state: GcodePreviewPanelState): void;
  } | null = null;
  /** Whether the scrubber is already placed, so a redraw does not re-place it. */
  private scrubberUp = false;

  constructor(
    private readonly ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
    private readonly surfaces: Surfaces<PanelNode>,
    private readonly host: XrShellHost,
    private readonly renderScrubber: (
      content: PanelNode,
      state: GcodePreviewPanelState,
      pinned: boolean,
      handlers: {
        onUpdateView(patch: GcodePreviewViewPatch): void;
        onAuthorEvent(type: 'pause' | 'custom', topZMm: number): void;
        onTogglePin(): void;
      },
    ) => { refresh(state: GcodePreviewPanelState): void },
  ) {
    this.state = new XrShellState(() => this.draw());
  }

  /** The node `load_model_from_path` drew, which the ray probe watches. */
  get loadButton(): PanelNode | null {
    return this.deskLoadButton;
  }

  /** Surfaces a recentre may move, given what the operator has pinned. */
  movableSurfaces(): readonly XrSurfaceId[] {
    return this.state.movableSurfaces(XR_PINNABLE);
  }

  /**
   * Redraw everything.
   *
   * Whole surfaces are rebuilt rather than diffed. A spatial panel is a few
   * dozen nodes and a redraw happens on a press or a canonical change, never
   * per frame; the alternative — a hand-written diff per panel — is what let
   * the old shell get out of step with the state it was drawn from.
   */
  draw(): void {
    if (this.drawing) {
      this.pendingDraw = true;
      return;
    }
    this.drawing = true;
    try {
      do {
        this.pendingDraw = false;
        this.drawMenuBar();
        this.drawToolRail();
        this.drawInspector();
        this.drawDesk();
        this.drawScrubber();
        this.drawOverlays();
      } while (this.pendingDraw);
    } finally {
      this.drawing = false;
    }
  }

  /**
   * Reveal the cockpit. Opt-in surfaces stay closed.
   *
   * `draw()` has already decided whether the scrubber belongs up, so only the
   * four surfaces that are always there are shown here; opening menus or a
   * palette on entry would bury the plate under panels nobody asked for.
   */
  show(): void {
    this.draw();
    for (const id of ['menubar', 'tools', 'inspector', 'desk'] as const) this.surfaces[id].show();
  }

  hide(): void {
    for (const id of Object.keys(this.surfaces) as XrSurfaceId[]) this.surfaces[id].hide();
    // A surface that is down is not placed, so the next session places it
    // again rather than leaving it wherever the last one ended.
    this.scrubberUp = false;
  }

  /** Long-pinch on a model or the bed. */
  openContextMenu(): void {
    this.state.openContextMenu();
  }

  private uiState(): Readonly<UiStateShape> | null {
    return this.host.actionState();
  }

  // ---- Cockpit -----------------------------------------------------------

  private drawMenuBar(): void {
    const card = this.surfaces.menubar;
    card.reset();
    this.menuBar = renderXrMenuBar(this.ui, card.content, this.menuBarContext());
  }

  private menuBarContext(): XrMenuBarContext {
    const overlay = this.state.overlay;
    return {
      sections: xrMenuBarSections(this.host.registry),
      openSectionId: overlay.kind === 'menu' ? overlay.sectionId : null,
      activeMode: this.host.workspaceMode(),
      modeDetail: this.host.modeDetail(),
      canUndo: this.uiState()?.canUndo === true,
      canRedo: this.uiState()?.canRedo === true,
      isDirty: this.uiState()?.dirty === true,
      printer: this.host.printerStatus(),
      onOpenSection: (id, anchor) => {
        this.menuAnchor = anchor;
        this.state.toggleMenu(id);
      },
      onOpenPalette: () => this.state.openPalette(),
      onSelectMode: (mode) => this.host.setWorkspaceMode(mode),
      onSave: () => this.run('file_save_project', 'xr-menu'),
      onUndo: () => this.run('edit_undo', 'xr-menu'),
      onRedo: () => this.run('edit_redo', 'xr-menu'),
      onRecenter: () => this.host.recenter(),
      onExit: () => this.host.exitSession(),
    };
  }

  private drawToolRail(): void {
    const card = this.surfaces.tools;
    card.reset();
    const state = this.uiState();
    if (!state) return;
    this.toolRail = renderXrToolRail(this.ui, card.content, this.toolRailContext(state));
  }

  private toolRailContext(state: Readonly<UiStateShape>): XrToolRailContext {
    return {
      registry: this.host.registry,
      state,
      activeTool: this.host.activeTool(),
      swatches: this.host.paintSwatches(),
      steppers: this.host.toolSteppers(),
      onRun: (action) => this.host.invoke(action, 'xr-toolbar'),
      onSelectSwatch: (id) => this.host.selectPaintSwatch(id),
      onStep: (id, direction) => this.host.stepToolSetting(id, direction),
    };
  }

  private drawInspector(): void {
    const card = this.surfaces.inspector;
    card.reset();
    const catalogue = new Map(xrInspectorPanels(this.host.registry).map((panel) => [panel.id, panel]));
    const open: XrPanelDescriptor[] = [];
    for (const id of this.state.openPanels) {
      const panel = catalogue.get(id);
      if (panel) open.push(panel);
    }
    renderXrPanelHost(this.ui, card.content, {
      openPanels: open,
      activePanelId: this.state.activePanel,
      pinned: this.state.isPinned('inspector'),
      onSelectPanel: (id) => this.state.selectPanel(id),
      onClosePanel: (id) => this.state.closePanel(id),
      onOpenDirectory: () => this.state.toggleMenu(XR_PANELS_SECTION_ID),
      onTogglePin: () => this.state.togglePinned('inspector'),
      renderBody: (body, id) => this.drawPanelBody(body, id),
    });
  }

  private drawPanelBody(body: PanelNode, id: XrPanelId | null): void {
    if (id === 'objects') return this.drawObjects(body);
    if (id === 'settings') return this.drawSettings(body);
    const group = id === null ? undefined : xrPanelGroup(id);
    if (group === undefined) return;
    const state = this.uiState();
    const actions = this.host.registry.forSurface('xr-inspector').filter((action) => action.group === group);
    if (actions.length === 0) {
      this.ui.appendChild(
        body,
        this.ui.createText(t('ui.xrImmersiveShell.emptyPanel', 'Nothing here yet.'), {
          fontSize: XR_TYPE.dense,
          color: C.textMuted,
        }),
      );
      return;
    }
    for (const action of actions) {
      const availability = state
        ? this.host.registry.availability(action, 'xr-inspector', state)
        : ({ state: 'disabled', reason: t('ui.xrImmersiveShell.starting', 'Workspace is still starting.') } as const);
      if (availability.state === 'hidden') continue;
      const row = createXrListRow(this.ui, {
        label: action.label,
        icon: action.icon,
        fontSize: XR_TYPE.dense,
        ...(availability.state === 'disabled'
          ? { reason: availability.reason }
          : action.hint
            ? { hint: action.hint }
            : {}),
        enabled: availability.state === 'enabled',
        onClick: () => this.host.invoke(action, 'xr-inspector'),
      });
      this.ui.appendChild(body, row.root);
    }
  }

  private drawObjects(body: PanelNode): void {
    const snapshot = this.host.objects();
    if (!snapshot) {
      this.ui.appendChild(
        body,
        this.ui.createText(t('ui.xrImmersiveShell.noProject', 'No project open.'), {
          fontSize: XR_TYPE.dense,
          color: C.textMuted,
        }),
      );
      return;
    }
    this.state.seedExpanded(snapshot.defaultExpandedKeys);
    renderXrObjectsPanel(this.ui, body, {
      projection: snapshot.projection,
      selection: snapshot.selection,
      expandedKeys: this.state.expandedKeys,
      filterQuery: this.state.objectsFilter,
      selectionActions: this.host.selectionActions(),
      onToggleExpanded: (key) => this.state.toggleExpanded(key),
      onSelect: (entity, key) => this.host.selectObject(entity, key),
      onEditFilter: () =>
        this.state.beginEntry({
          target: { kind: 'objects-filter' },
          layout: 'keyboard',
          title: t('ui.xrImmersiveShell.filterObjects', 'Filter objects'),
          initial: this.state.objectsFilter,
        }),
      onRunSelectionAction: (actionId) => this.run(actionId, 'xr-inspector'),
    });
  }

  private drawSettings(body: PanelNode): void {
    renderXrSettingsPanel(this.ui, body, {
      view: this.host.settingsView(),
      search: this.state.settingsSearch,
      onCycleTarget: (direction) => this.host.cycleSettingsTarget(direction),
      onEditSearch: () =>
        this.state.beginEntry({
          target: { kind: 'settings-search' },
          layout: 'keyboard',
          title: t('ui.xrImmersiveShell.searchSettings', 'Search settings'),
          initial: this.state.settingsSearch,
        }),
      onStep: (fieldId, direction) => this.host.stepSetting(fieldId, direction),
      onSetValue: (fieldId, raw) => this.host.setSettingValue(fieldId, raw),
      onEditValue: (row) => this.state.beginEntry(entryForSetting(row)),
    });
  }

  private drawDesk(): void {
    const card = this.surfaces.desk;
    card.reset();
    const state = this.uiState();
    if (!state) return;
    const desk = renderXrDesk(this.ui, card.content, this.deskContext(state));
    this.desk = desk;
    this.deskLoadButton = desk.loadButton;
  }

  private deskContext(state: Readonly<UiStateShape>): XrDeskContext {
    return {
      registry: this.host.registry,
      state,
      plates: this.host.plates(),
      status: this.host.statusLine(),
      progress: this.host.progress(),
      onRun: (action) => this.host.invoke(action, 'xr-primary'),
      onSelectPlate: (plateId) => this.host.selectPlate(plateId),
      onAddPlate: () => this.run('add_plate', 'xr-primary'),
      // Renaming, reordering and un-printing a plate are `scene` inspector
      // actions, so "Manage…" opens the panel that holds them rather than a
      // menu that happens to be nearby.
      onManagePlates: () => this.state.openPanel(xrGroupPanelId('scene')),
    };
  }

  private drawScrubber(): void {
    const card = this.surfaces.scrubber;
    const preview = this.host.previewState();
    if (!preview || !preview.active || this.host.workspaceMode() !== 'preview') {
      this.previewScrubber = null;
      this.scrubberUp = false;
      card.hide();
      return;
    }
    card.reset();
    this.previewScrubber = this.renderScrubber(card.content, preview, this.state.isPinned('scrubber'), {
      onUpdateView: (patch) => this.host.updatePreview(patch),
      onAuthorEvent: (type, topZMm) => this.host.authorLayerEvent(type, topZMm),
      onTogglePin: () => this.state.togglePinned('scrubber'),
    });
    // Placed only as it arrives. A grabbable surface that re-placed itself on
    // every redraw would snap back out of the operator's hands the moment they
    // scrubbed a layer with it.
    if (!this.scrubberUp) card.place(null);
    this.scrubberUp = true;
    card.show();
  }

  /**
   * Repaint what changes often without rebuilding anything.
   *
   * A status line, a slice percentage, an undo becoming available, a printer
   * reporting in — all of them arrive many times a second and none of them
   * changes the *shape* of a surface. They are written into the nodes that are
   * already there; a rebuild is reserved for a press that changes what exists.
   */
  refreshState(): void {
    const state = this.uiState();
    this.menuBar?.refresh(this.menuBarContext());
    if (state) {
      this.toolRail?.refresh(this.toolRailContext(state));
      this.desk?.refresh(this.deskContext(state));
    }
  }

  /** Repaint only the scrubber, for the many small preview updates. */
  refreshPreview(): void {
    const preview = this.host.previewState();
    if (this.previewScrubber && preview && preview.active) this.previewScrubber.refresh(preview);
    else this.drawScrubber();
  }

  // ---- Transient surfaces -------------------------------------------------

  private drawOverlays(): void {
    const overlay = this.state.overlay;
    for (const id of ['menu', 'palette', 'context', 'keypad', 'keyboard'] as const) {
      if (id !== overlayCard(overlay.kind, this.state.entry?.layout)) this.surfaces[id].hide();
    }

    if (overlay.kind === 'menu') {
      const card = this.surfaces.menu;
      const state = this.uiState();
      card.reset();
      renderXrMenuPopover(this.ui, card.content, {
        registry: this.host.registry,
        state: state ?? INITIAL_UI_STATE,
        sectionId: overlay.sectionId,
        title: sectionTitle(overlay.sectionId),
        openPanelIds: new Set(this.state.openPanels),
        onRun: (action, surface) => {
          this.state.closeOverlay();
          this.host.invoke(action, surface);
        },
        onOpenPanel: (id) => this.state.openPanel(id),
      });
      card.place(this.menuAnchor);
      card.show();
      return;
    }

    if (overlay.kind === 'palette') {
      const card = this.surfaces.palette;
      const state = this.uiState();
      card.reset();
      renderXrCommandPalette(this.ui, card.content, {
        registry: this.host.registry,
        state: state ?? INITIAL_UI_STATE,
        query: this.state.paletteQuery,
        onEditQuery: () =>
          this.state.beginEntry({
            target: { kind: 'palette-query' },
            layout: 'keyboard',
            title: t('ui.xrImmersiveShell.searchCommands', 'Search commands'),
            initial: this.state.paletteQuery,
          }),
        onRun: (action) => {
          this.state.closeOverlay();
          this.host.invoke(action, 'command-palette');
        },
        onClose: () => this.state.closeOverlay(),
      });
      card.place(null);
      card.show();
      return;
    }

    if (overlay.kind === 'context') {
      const card = this.surfaces.context;
      const state = this.uiState();
      card.reset();
      renderXrContextMenu(this.ui, card.content, {
        registry: this.host.registry,
        state: state ?? INITIAL_UI_STATE,
        target: this.host.contextTarget(),
        targetLabel: this.host.contextLabel(),
        onRun: (action) => {
          this.state.closeOverlay();
          this.host.invoke(action, 'xr-context');
        },
        onClose: () => this.state.closeOverlay(),
      });
      card.place(this.host.pinchAnchor());
      card.show();
      return;
    }

    const session = this.state.entry;
    if (overlay.kind === 'entry' && session) {
      const card = this.surfaces[session.layout];
      card.reset();
      const handlers = {
        onCommit: (value: string) => this.commitEntry(value),
        onCancel: () => this.state.cancelEntry(),
      };
      const request = {
        title: session.title,
        initial: session.initial,
        ...(session.unit === undefined ? {} : { unit: session.unit }),
        ...(session.minimum === undefined ? {} : { minimum: session.minimum }),
        ...(session.maximum === undefined ? {} : { maximum: session.maximum }),
        ...(session.integer === undefined ? {} : { integer: session.integer }),
      };
      if (session.layout === 'keypad') renderXrKeypad(this.ui, card.content, request, handlers);
      else renderXrKeyboard(this.ui, card.content, request, handlers);
      card.place(this.host.pinchAnchor());
      card.show();
    }
  }

  private commitEntry(value: string): void {
    const session = this.state.entry;
    const target = this.state.commitEntry(value);
    if (target?.kind === 'setting' && session) this.host.setSettingValue(target.fieldId, value);
  }

  private run(actionId: string, surface: ActionSurface): void {
    const action = this.host.registry.get(actionId);
    if (action) this.host.invoke(action, surface);
  }
}

/** Which card a given overlay draws into. */
function overlayCard(kind: string, layout: 'keypad' | 'keyboard' | undefined): XrSurfaceId | null {
  if (kind === 'menu') return 'menu';
  if (kind === 'palette') return 'palette';
  if (kind === 'context') return 'context';
  if (kind === 'entry') return layout ?? 'keypad';
  return null;
}

function sectionTitle(sectionId: string): string {
  if (sectionId === XR_PANELS_SECTION_ID) return t('ui.xrImmersiveShell.panels', 'Panels');
  return MENU_SECTIONS.find((section) => String(section.id) === sectionId)?.label ?? sectionId;
}

/** The entry a settings row asks for, given what kind of value it holds. */
export function entryForSetting(row: ScopedStepperRow): XrEntrySession {
  return {
    target: { kind: 'setting', fieldId: row.fieldId },
    layout: row.kind === 'numeric' ? 'keypad' : 'keyboard',
    title: row.label,
    initial: row.value,
    ...(row.unit ? { unit: row.unit } : {}),
    ...(row.minimum === undefined ? {} : { minimum: row.minimum }),
    ...(row.maximum === undefined ? {} : { maximum: row.maximum }),
    integer: row.integer,
  };
}
