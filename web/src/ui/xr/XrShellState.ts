/**
 * XrShellState — everything the immersive shell remembers that the project does
 * not.
 *
 * Which menu is open, which panels are in the inspector, what has been pinned
 * where, what is typed into the two search fields: none of it belongs in
 * canonical state, and all of it decides what the next frame draws. Keeping it
 * in one observable object rather than as fields on the workspace is what lets
 * the redesign be asserted without a headset — every rule below is a pure
 * function of a press.
 *
 * Two of those rules are the redesign's own and are easy to get wrong:
 *
 *  - **Opening a menu closes the palette, and vice versa.** They are both modal
 *    answers to "where is…", and two of them up at once is two lists competing
 *    for the same pinch.
 *  - **A pinned surface survives recentre; an unpinned one returns to its
 *    anchor.** That is the whole contract that makes grabbing safe: the way
 *    home is always one gesture, and the operator chooses which panels ignore
 *    it.
 */
import type { XrSurfaceId, XrWorkspaceMode } from './XrLayout';
import type { XrPanelId } from './XrPanels';

/** Which transient surface, if any, is currently the operator's focus. */
export type XrOverlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'menu'; readonly sectionId: string }
  | { readonly kind: 'palette' }
  | { readonly kind: 'context' }
  | { readonly kind: 'entry' };

/** What the keypad or keyboard is editing, so a commit knows where to go. */
export type XrEntryTarget =
  | { readonly kind: 'palette-query' }
  | { readonly kind: 'objects-filter' }
  | { readonly kind: 'settings-search' }
  | { readonly kind: 'setting'; readonly fieldId: string };

export interface XrEntrySession {
  readonly target: XrEntryTarget;
  readonly layout: 'keypad' | 'keyboard';
  readonly title: string;
  readonly initial: string;
  readonly unit?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer?: boolean;
}

export class XrShellState {
  private overlaySnapshot: XrOverlay = { kind: 'none' };
  private entrySession: XrEntrySession | null = null;
  private panels: XrPanelId[] = ['objects'];
  private active: XrPanelId | null = 'objects';
  private readonly pinnedIds = new Set<XrSurfaceId>();
  private readonly expanded = new Set<string>();
  private seeded = false;
  private mode: XrWorkspaceMode = 'prepare';
  private objectsFilterText = '';
  private settingsSearchText = '';
  private paletteQueryText = '';

  constructor(private readonly onChange: () => void = () => {}) {}

  get overlay(): XrOverlay {
    return this.overlaySnapshot;
  }
  get entry(): XrEntrySession | null {
    return this.entrySession;
  }
  get openPanels(): readonly XrPanelId[] {
    return this.panels;
  }
  get activePanel(): XrPanelId | null {
    return this.active;
  }
  get workspaceMode(): XrWorkspaceMode {
    return this.mode;
  }
  get objectsFilter(): string {
    return this.objectsFilterText;
  }
  get settingsSearch(): string {
    return this.settingsSearchText;
  }
  get paletteQuery(): string {
    return this.paletteQueryText;
  }
  get expandedKeys(): ReadonlySet<string> {
    return this.expanded;
  }

  isPinned(id: XrSurfaceId): boolean {
    return this.pinnedIds.has(id);
  }

  /** Pinning is per surface and survives everything except being unpinned. */
  togglePinned(id: XrSurfaceId): void {
    if (this.pinnedIds.has(id)) this.pinnedIds.delete(id);
    else this.pinnedIds.add(id);
    this.onChange();
  }

  /** The surfaces a recentre may move: everything the operator has not pinned. */
  movableSurfaces(ids: readonly XrSurfaceId[]): readonly XrSurfaceId[] {
    return ids.filter((id) => !this.pinnedIds.has(id));
  }

  setWorkspaceMode(mode: XrWorkspaceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onChange();
  }

  /** Open a menu section, or close it if it is the one already open. */
  toggleMenu(sectionId: string): void {
    this.overlaySnapshot =
      this.overlaySnapshot.kind === 'menu' && this.overlaySnapshot.sectionId === sectionId
        ? { kind: 'none' }
        : { kind: 'menu', sectionId };
    this.entrySession = null;
    this.onChange();
  }

  openPalette(): void {
    this.overlaySnapshot = { kind: 'palette' };
    this.entrySession = null;
    this.onChange();
  }

  openContextMenu(): void {
    this.overlaySnapshot = { kind: 'context' };
    this.entrySession = null;
    this.onChange();
  }

  closeOverlay(): void {
    if (this.overlaySnapshot.kind === 'none' && this.entrySession === null) return;
    this.overlaySnapshot = { kind: 'none' };
    this.entrySession = null;
    this.onChange();
  }

  /**
   * Start a text or numeric entry.
   *
   * The overlay it came from is deliberately not remembered: the palette is
   * redrawn from the committed query, so returning to it is a fresh open rather
   * than a restored stack. A stack is what produces a headset the operator
   * cannot back out of.
   */
  beginEntry(session: XrEntrySession): void {
    this.entrySession = session;
    this.overlaySnapshot = { kind: 'entry' };
    this.onChange();
  }

  /** Apply an entry to whatever asked for it. Returns what the shell must do. */
  commitEntry(value: string): XrEntryTarget | null {
    const session = this.entrySession;
    if (!session) return null;
    switch (session.target.kind) {
      case 'palette-query':
        this.paletteQueryText = value;
        this.overlaySnapshot = { kind: 'palette' };
        break;
      case 'objects-filter':
        this.objectsFilterText = value;
        this.overlaySnapshot = { kind: 'none' };
        break;
      case 'settings-search':
        this.settingsSearchText = value;
        this.overlaySnapshot = { kind: 'none' };
        break;
      case 'setting':
        this.overlaySnapshot = { kind: 'none' };
        break;
    }
    this.entrySession = null;
    this.onChange();
    return session.target;
  }

  cancelEntry(): void {
    if (!this.entrySession) return;
    const returning = this.entrySession.target.kind === 'palette-query';
    this.entrySession = null;
    this.overlaySnapshot = returning ? { kind: 'palette' } : { kind: 'none' };
    this.onChange();
  }

  /** Open a panel in the inspector and make it the visible one. */
  openPanel(id: XrPanelId): void {
    if (!this.panels.includes(id)) this.panels = [...this.panels, id];
    this.active = id;
    // Opening a panel is the answer to the directory that was open; leaving the
    // directory up would hide the panel it just opened.
    this.overlaySnapshot = { kind: 'none' };
    this.onChange();
  }

  selectPanel(id: XrPanelId): void {
    if (!this.panels.includes(id) || this.active === id) return;
    this.active = id;
    this.onChange();
  }

  closePanel(id: XrPanelId): void {
    const index = this.panels.indexOf(id);
    if (index < 0) return;
    this.panels = this.panels.filter((panel) => panel !== id);
    if (this.active === id) this.active = this.panels[Math.min(index, this.panels.length - 1)] ?? null;
    this.onChange();
  }

  toggleExpanded(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.onChange();
  }

  /**
   * Adopt a projection's default expansion the first time it is seen.
   *
   * Guarded by having-seeded rather than by the set being empty: an operator
   * who collapses every object leaves an empty set, and re-seeding from that
   * would silently open the tree again on the next redraw.
   */
  seedExpanded(keys: Iterable<string>): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const key of keys) this.expanded.add(key);
  }
}
