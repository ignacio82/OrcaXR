import {
  ObjectTreeExpansionState,
  buildObjectTreeView,
  computeFixedVirtualWindow,
  scrollOffsetToRevealRow,
  type ObjectTreeEntityRef,
  type ObjectTreeProjection,
  type ObjectTreeRowKey,
  type ObjectTreeSelectionMode,
  type ObjectTreeSelectionSnapshot,
  type ObjectTreeView,
  type ObjectTreeVisibleRow,
} from '../../project/objects';
import { ContextMenu, type ContextMenuGroup, type ContextMenuItem } from './ContextMenu';
import type { ContextTarget } from '../../actions/ActionRegistry';

type MaybePromise = void | Promise<void>;

export type ObjectsPanelRenameEntity = Extract<ObjectTreeEntityRef, { kind: 'object' | 'volume' }>;

export interface ObjectsPanelSnapshot {
  readonly projection: ObjectTreeProjection;
  readonly selection: ObjectTreeSelectionSnapshot;
}

export interface ObjectsPanelSelectionRequest {
  readonly mode: ObjectTreeSelectionMode;
  readonly rowKey: ObjectTreeRowKey;
  readonly target: ObjectTreeEntityRef;
  /** The prior replace/toggle target when it remains visible. */
  readonly anchor?: ObjectTreeEntityRef;
  /** Exact visible entity range, populated only for range selection. */
  readonly range?: readonly ObjectTreeEntityRef[];
}

export interface ObjectsPanelRenameRequest {
  readonly rowKey: ObjectTreeRowKey;
  readonly entity: ObjectsPanelRenameEntity;
  readonly previousName: string;
  readonly nextName: string;
}

export interface ObjectsPanelRevealRequest {
  readonly rowKey: ObjectTreeRowKey;
  readonly entity: ObjectTreeEntityRef;
}

/**
 * The panel is a projection-only DOM surface. Its adapter owns canonical
 * commands, selection, scene reveal behavior, and change notifications.
 */
export interface ObjectsPanelAdapter {
  getSnapshot(): ObjectsPanelSnapshot;
  subscribe?(listener: () => void): () => void;
  onSelectionRequest(request: ObjectsPanelSelectionRequest): MaybePromise;
  onRenameRequest(request: ObjectsPanelRenameRequest): MaybePromise;
  onRevealRequest(request: ObjectsPanelRevealRequest): MaybePromise;
  /**
   * Catalog actions for a right-clicked node, from the shell that owns the
   * registry. Omitted in tests and in any host without a catalog, which is why
   * the panel's own two entries stand alone rather than assuming a shell.
   */
  listContextActions?(target: ContextTarget): readonly ContextMenuGroup[];
  onError?(error: unknown): void;
}

export interface ObjectsPanelOptions {
  readonly heading?: string;
  readonly treeLabel?: string;
  readonly initialExpandedKeys?: Iterable<ObjectTreeRowKey>;
  readonly rowHeightPx?: number;
  readonly viewportHeightPx?: number;
  readonly overscanRows?: number;
}

interface RenderOptions {
  readonly focusKey?: ObjectTreeRowKey;
  readonly focusRename?: boolean;
  readonly adoptVisibleFocus?: boolean;
}

const DEFAULT_ROW_HEIGHT_PX = 48;
const DEFAULT_VIEWPORT_HEIGHT_PX = 360;
const LONG_PRESS_DELAY_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 12;
let panelSequence = 0;

/** Accessible, virtualized DOM counterpart for the canonical Objects tree. */
export class ObjectsPanel {
  private readonly instanceId = ++panelSequence;
  private readonly rowHeightPx: number;
  private readonly viewportHeightPx: number;
  private readonly overscanRows: number;
  private root?: HTMLElement;
  private searchInput?: HTMLInputElement;
  private resultStatus?: HTMLElement;
  private tree?: HTMLElement;
  private snapshot?: ObjectsPanelSnapshot;
  private expansion?: ObjectTreeExpansionState;
  private view?: ObjectTreeView;
  private focusedKey?: ObjectTreeRowKey;
  private anchorKey?: ObjectTreeRowKey;
  private renamingKey?: ObjectTreeRowKey;
  private readonly contextMenu: ContextMenu;
  private longPressTimer?: number;
  private longPressWindow?: Window;
  private longPressPointerId?: number;
  private longPressStart?: Readonly<{ x: number; y: number }>;
  private suppressClickKey?: ObjectTreeRowKey;
  private filterQuery = '';
  private unsubscribe?: () => void;
  private rendering = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: ObjectsPanelAdapter,
    private readonly options: ObjectsPanelOptions = {},
  ) {
    this.rowHeightPx = positiveFinite(options.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX, 'rowHeightPx');
    this.viewportHeightPx = positiveFinite(options.viewportHeightPx ?? DEFAULT_VIEWPORT_HEIGHT_PX, 'viewportHeightPx');
    this.overscanRows = nonNegativeInteger(options.overscanRows ?? 5, 'overscanRows');
    // Same component the scene's right-click uses; only the dataset hook and the
    // first group differ.
    this.contextMenu = new ContextMenu(container, { datasetKey: 'objectsContextMenu' });
  }

  mount(): void {
    if (this.root) return;
    this.buildShell();
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    const snapshot = this.adapter.getSnapshot();
    this.snapshot = snapshot;
    if (!this.expansion) {
      this.expansion = new ObjectTreeExpansionState(
        this.options.initialExpandedKeys ?? snapshot.projection.defaultExpandedKeys,
      );
    } else {
      this.expansion.reconcile(snapshot.projection);
    }
    if (this.focusedKey && !snapshot.projection.rowsByKey.has(this.focusedKey)) this.focusedKey = undefined;
    if (this.anchorKey && !snapshot.projection.rowsByKey.has(this.anchorKey)) this.anchorKey = undefined;
    if (this.renamingKey && !snapshot.projection.rowsByKey.has(this.renamingKey)) this.renamingKey = undefined;
    this.renderRows();
  }

  dispose(): void {
    this.cancelLongPress();
    this.closeContextMenu();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
    this.searchInput = undefined;
    this.resultStatus = undefined;
    this.tree = undefined;
    this.snapshot = undefined;
    this.view = undefined;
  }

  private buildShell(): void {
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.objectsPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-objects-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-height:0;flex-direction:column;gap:8px;color:var(--oxr-color-text,#fff);' +
      'font:13px/1.35 system-ui,sans-serif;';

    const heading = document.createElement('h2');
    heading.id = `orcaxr-objects-heading-${this.instanceId}`;
    heading.textContent = this.options.heading ?? 'Objects';
    heading.style.cssText = 'margin:0;font-size:16px;line-height:1.3;';
    root.appendChild(heading);

    const searchLabel = document.createElement('label');
    searchLabel.htmlFor = `orcaxr-objects-search-${this.instanceId}`;
    searchLabel.textContent = 'Search objects';
    searchLabel.style.cssText = 'font-size:12px;color:var(--oxr-color-text-muted,#a0aab5);';
    root.appendChild(searchLabel);

    const search = document.createElement('input');
    search.id = searchLabel.htmlFor;
    search.type = 'search';
    search.dataset.objectsSearch = 'true';
    search.placeholder = 'Name, type, setting, or filament';
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('aria-controls', `orcaxr-objects-tree-${this.instanceId}`);
    search.style.cssText =
      'box-sizing:border-box;width:100%;border:1px solid var(--oxr-color-stroke,#ffffff2b);' +
      'border-radius:7px;background:var(--oxr-color-bg-sunken,#0006);color:inherit;padding:7px 9px;';
    search.addEventListener('input', () => {
      this.filterQuery = search.value;
      this.renamingKey = undefined;
      this.renderRows();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || search.value.length === 0) return;
      event.preventDefault();
      search.value = '';
      this.filterQuery = '';
      this.renderRows();
    });
    root.appendChild(search);

    const status = document.createElement('div');
    status.id = `orcaxr-objects-status-${this.instanceId}`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'min-height:1.35em;font-size:12px;color:var(--oxr-color-text-muted,#a0aab5);';
    root.appendChild(status);

    const tree = document.createElement('div');
    tree.id = `orcaxr-objects-tree-${this.instanceId}`;
    tree.dataset.objectsTree = 'true';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', this.options.treeLabel ?? 'Project objects');
    tree.setAttribute('aria-multiselectable', 'true');
    tree.setAttribute('aria-describedby', status.id);
    tree.style.cssText =
      `position:relative;box-sizing:border-box;height:${this.viewportHeightPx}px;min-height:80px;overflow:auto;` +
      'border:1px solid var(--oxr-color-stroke,#ffffff1f);border-radius:8px;' +
      'background:var(--oxr-color-bg-sunken,#0003);outline:none;';
    tree.addEventListener('scroll', () => {
      if (!this.rendering) this.renderRows({ adoptVisibleFocus: true });
    });
    root.appendChild(tree);

    this.container.replaceChildren(root);
    this.root = root;
    this.searchInput = search;
    this.resultStatus = status;
    this.tree = tree;
  }

  private renderRows(options: RenderOptions = {}): void {
    const snapshot = this.snapshot;
    const expansion = this.expansion;
    const tree = this.tree;
    const status = this.resultStatus;
    if (!snapshot || !expansion || !tree || !status) return;
    this.cancelLongPress();
    this.closeContextMenu();

    this.rendering = true;
    try {
      const activeElement = tree.ownerDocument.activeElement;
      const hadTreeItemFocus =
        activeElement instanceof tree.ownerDocument.defaultView!.HTMLElement &&
        tree.contains(activeElement) &&
        activeElement.getAttribute('role') === 'treeitem';

      if (options.focusKey) this.focusedKey = options.focusKey;
      let view = this.buildView(snapshot, expansion);
      this.focusedKey = view.focusKey;

      if (options.focusKey) {
        const focusIndex = view.indexByKey.get(options.focusKey);
        if (focusIndex !== undefined) {
          tree.scrollTop = scrollOffsetToRevealRow(
            focusIndex,
            tree.scrollTop,
            this.measuredViewportHeight(tree),
            this.rowHeightPx,
            view.rows.length,
          );
        }
      }

      let virtualWindow = this.virtualWindow(view, tree);
      const focusIndex = view.focusKey ? view.indexByKey.get(view.focusKey) : undefined;
      if (
        options.adoptVisibleFocus &&
        focusIndex !== undefined &&
        (focusIndex < virtualWindow.startIndex || focusIndex >= virtualWindow.endIndex)
      ) {
        this.focusedKey = view.rows[virtualWindow.startIndex]?.key;
        view = this.buildView(snapshot, expansion);
        virtualWindow = this.virtualWindow(view, tree);
      } else if (
        focusIndex !== undefined &&
        (focusIndex < virtualWindow.startIndex || focusIndex >= virtualWindow.endIndex)
      ) {
        tree.scrollTop = scrollOffsetToRevealRow(
          focusIndex,
          tree.scrollTop,
          this.measuredViewportHeight(tree),
          this.rowHeightPx,
          view.rows.length,
        );
        virtualWindow = this.virtualWindow(view, tree);
      }

      this.view = view;
      status.textContent = view.filterActive
        ? view.rows.length === 0
          ? 'No matching objects'
          : `${view.rows.length} matching tree row${view.rows.length === 1 ? '' : 's'}`
        : `${view.rows.length} visible tree row${view.rows.length === 1 ? '' : 's'}`;

      const fragment = tree.ownerDocument.createDocumentFragment();
      if (virtualWindow.offsetTopPx > 0) fragment.appendChild(this.createSpacer(virtualWindow.offsetTopPx));
      for (const row of view.rows.slice(virtualWindow.startIndex, virtualWindow.endIndex)) {
        fragment.appendChild(this.createRow(row, view));
      }
      if (virtualWindow.offsetBottomPx > 0) fragment.appendChild(this.createSpacer(virtualWindow.offsetBottomPx));
      tree.replaceChildren(fragment);
      tree.tabIndex = view.rows.length === 0 ? 0 : -1;

      if (options.focusRename && this.renamingKey) {
        const renameInput = this.findRowElement(this.renamingKey)?.querySelector<HTMLInputElement>(
          '[data-objects-rename-input]',
        );
        renameInput?.focus({ preventScroll: true });
        renameInput?.select();
      } else if (options.focusKey || (options.adoptVisibleFocus && hadTreeItemFocus)) {
        const key = options.focusKey ?? this.focusedKey;
        if (key) this.findRowElement(key)?.focus({ preventScroll: true });
      }
    } finally {
      this.rendering = false;
    }
  }

  private buildView(snapshot: ObjectsPanelSnapshot, expansion: ObjectTreeExpansionState): ObjectTreeView {
    return buildObjectTreeView(snapshot.projection, {
      expandedKeys: expansion.snapshot(),
      filterQuery: this.filterQuery,
      selection: snapshot.selection,
      focusedKey: this.focusedKey,
    });
  }

  private virtualWindow(view: ObjectTreeView, tree: HTMLElement) {
    return computeFixedVirtualWindow({
      rowCount: view.rows.length,
      scrollOffsetPx: tree.scrollTop,
      viewportHeightPx: this.measuredViewportHeight(tree),
      rowHeightPx: this.rowHeightPx,
      overscanRows: this.overscanRows,
    });
  }

  private measuredViewportHeight(tree: HTMLElement): number {
    return tree.clientHeight > 0 ? tree.clientHeight : this.viewportHeightPx;
  }

  private createSpacer(heightPx: number): HTMLElement {
    const spacer = this.container.ownerDocument.createElement('div');
    spacer.setAttribute('role', 'presentation');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = `${heightPx}px`;
    return spacer;
  }

  private createRow(row: ObjectTreeVisibleRow, view: ObjectTreeView): HTMLElement {
    const document = this.container.ownerDocument;
    const item = document.createElement('div');
    item.id = row.id;
    item.dataset.objectsRowKey = row.key;
    item.dataset.objectsRowKind = row.kind;
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', String(row.accessibility.level));
    item.setAttribute('aria-posinset', String(row.accessibility.positionInSet));
    item.setAttribute('aria-setsize', String(row.accessibility.setSize));
    item.setAttribute('aria-selected', String(row.accessibility.selected));
    item.setAttribute('aria-disabled', String(row.accessibility.disabled));
    if (row.accessibility.expanded !== undefined) {
      item.setAttribute('aria-expanded', String(row.accessibility.expanded));
    }
    item.tabIndex = row.accessibility.tabIndex;
    item.style.cssText =
      `box-sizing:border-box;height:${this.rowHeightPx}px;display:flex;align-items:center;gap:5px;` +
      `padding:3px 5px 3px ${6 + (row.accessibility.level - 1) * 17}px;overflow:hidden;` +
      `background:${row.accessibility.selected ? 'var(--oxr-color-selection,#2463a955)' : 'transparent'};` +
      `opacity:${row.accessibility.disabled ? '0.68' : '1'};outline-offset:-2px;`;

    item.addEventListener('focus', (event) => {
      if (event.target !== item) return;
      this.setRovingFocus(row.key);
    });
    item.addEventListener('click', (event) => {
      if (this.suppressClickKey === row.key) {
        event.preventDefault();
        event.stopPropagation();
        this.suppressClickKey = undefined;
        return;
      }
      item.focus({ preventScroll: true });
      this.emitSelection(row, selectionMode(event), view);
    });
    item.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.beginRename(row);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.contextMenu.isOpen() && this.suppressClickKey === row.key) return;
      this.setRovingFocus(row.key);
      this.openContextMenu(row, item, event.clientX, event.clientY);
    });
    item.addEventListener('pointerdown', (event) => this.beginLongPress(event, row, item));
    item.addEventListener('pointermove', (event) => this.moveLongPress(event));
    item.addEventListener('pointerup', (event) => this.endLongPress(event, row.key));
    item.addEventListener('pointercancel', (event) => this.endLongPress(event, row.key));
    item.addEventListener('keydown', (event) => this.onRowKeyDown(event, row, view));

    if (row.accessibility.expanded !== undefined) {
      const disclosure = document.createElement('button');
      disclosure.type = 'button';
      disclosure.tabIndex = -1;
      disclosure.dataset.objectsAction = 'disclosure';
      disclosure.textContent = row.accessibility.expanded ? '▾' : '▸';
      disclosure.setAttribute('aria-label', `${row.accessibility.expanded ? 'Collapse' : 'Expand'} ${row.label}`);
      disclosure.setAttribute('aria-expanded', String(row.accessibility.expanded));
      disclosure.disabled = view.filterActive;
      disclosure.title = view.filterActive ? 'Clear search to change expansion' : '';
      disclosure.style.cssText =
        'width:40px;height:40px;flex:0 0 40px;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;';
      disclosure.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (view.filterActive) return;
        this.expansion?.toggle(row.key);
        this.renderRows({ focusKey: row.key });
      });
      item.appendChild(disclosure);
    } else {
      const indent = document.createElement('span');
      indent.setAttribute('aria-hidden', 'true');
      indent.style.cssText = 'width:40px;flex:0 0 40px;';
      item.appendChild(indent);
    }

    if (this.renamingKey === row.key && isRenameable(row)) {
      item.appendChild(this.createRenameEditor(row));
    } else {
      const label = document.createElement('span');
      label.dataset.objectsRowLabel = 'true';
      label.textContent = row.label;
      label.title = row.description ? `${row.label} — ${row.description}` : row.label;
      label.style.cssText =
        `min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
        `font-weight:${row.kind === 'plate' || row.kind === 'object' ? '650' : '450'};`;
      item.appendChild(label);
      this.appendIndicators(item, row);
      this.appendRowActions(item, row);
    }
    return item;
  }

  private createRenameEditor(row: ObjectTreeVisibleRow): HTMLElement {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    form.dataset.objectsRenameForm = 'true';
    form.style.cssText = 'min-width:0;flex:1;display:flex;align-items:center;gap:4px;';
    form.addEventListener('click', (event) => event.stopPropagation());
    form.addEventListener('dblclick', (event) => event.stopPropagation());
    form.addEventListener('keydown', (event) => event.stopPropagation());

    const input = document.createElement('input');
    input.type = 'text';
    input.value = row.label;
    input.dataset.objectsRenameInput = 'true';
    input.setAttribute('aria-label', `New name for ${row.label}`);
    input.style.cssText =
      'box-sizing:border-box;min-width:80px;flex:1;border:1px solid var(--oxr-color-accent,#ffb74d);' +
      'border-radius:5px;background:var(--oxr-color-bg-sunken,#0008);color:inherit;padding:4px 6px;';
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.cancelRename(row.key);
    });
    form.appendChild(input);

    const save = this.smallActionButton('Save', 'Save name');
    save.type = 'submit';
    form.appendChild(save);
    const cancel = this.smallActionButton('Cancel', 'Cancel rename');
    cancel.addEventListener('click', () => this.cancelRename(row.key));
    form.appendChild(cancel);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextName = input.value.trim();
      if (!nextName) {
        input.setCustomValidity('Name cannot be empty');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      this.renamingKey = undefined;
      if (nextName !== row.label && row.entity && isRenameEntity(row.entity)) {
        this.invokeAdapter(() =>
          this.adapter.onRenameRequest({
            rowKey: row.key,
            entity: cloneEntity(row.entity as ObjectsPanelRenameEntity),
            previousName: row.label,
            nextName,
          }),
        );
      }
      this.renderRows({ focusKey: row.key });
    });
    return form;
  }

  private smallActionButton(text: string, label: string): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.style.cssText =
      'min-width:44px;height:40px;border:1px solid var(--oxr-color-stroke,#ffffff2b);border-radius:5px;' +
      'background:var(--oxr-color-surface,#ffffff14);color:inherit;padding:2px 6px;font-size:11px;';
    return button;
  }

  private appendIndicators(item: HTMLElement, row: ObjectTreeVisibleRow): void {
    const labels: string[] = [];
    if (row.indicators.printable === false) labels.push('Not printable');
    if (row.indicators.sinking) labels.push('Sinking');
    if (row.indicators.volumeRole) labels.push(row.indicators.volumeRole);
    if (row.indicators.filament) {
      const suffix = row.indicators.filament.mixed ? 'mixed' : row.indicators.filament.inherited ? 'inherited' : '';
      labels.push(`${row.indicators.filament.name}${suffix ? ` (${suffix})` : ''}`);
    }
    if (row.indicators.paint?.colorFacetCount) {
      labels.push(`${row.indicators.paint.colorFacetCount} color-painted facets`);
    }
    if (row.indicators.paint?.supportFacetCount) {
      labels.push(`${row.indicators.paint.supportFacetCount} support-painted facets`);
    }
    if (row.indicators.settingsCount) labels.push(`${row.indicators.settingsCount} custom settings`);
    if (labels.length === 0) return;
    const indicator = this.container.ownerDocument.createElement('span');
    indicator.dataset.objectsIndicators = 'true';
    indicator.textContent = labels.join(' · ');
    indicator.title = labels.join(', ');
    indicator.style.cssText =
      'max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'color:var(--oxr-color-text-muted,#a0aab5);font-size:11px;';
    item.appendChild(indicator);
  }

  private appendRowActions(item: HTMLElement, row: ObjectTreeVisibleRow): void {
    if (!row.entity) return;
    const reveal = this.smallActionButton('Reveal', `Reveal ${row.label} in the scene`);
    reveal.tabIndex = -1;
    reveal.dataset.objectsAction = 'reveal';
    reveal.setAttribute('aria-keyshortcuts', 'R');
    reveal.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setRovingFocus(row.key);
      this.emitReveal(row);
    });
    item.appendChild(reveal);

    if (!isRenameable(row)) return;
    const rename = this.smallActionButton('Rename', `Rename ${row.label}`);
    rename.tabIndex = -1;
    rename.dataset.objectsAction = 'rename';
    rename.setAttribute('aria-keyshortcuts', 'F2');
    rename.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.beginRename(row);
    });
    item.appendChild(rename);
  }

  private onRowKeyDown(event: KeyboardEvent, row: ObjectTreeVisibleRow, view: ObjectTreeView): void {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      const bounds = target.getBoundingClientRect();
      this.openContextMenu(row, target, bounds.left + 24, bounds.top + 24);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusByIndex((view.indexByKey.get(row.key) ?? 0) + 1, view);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.focusByIndex((view.indexByKey.get(row.key) ?? 0) - 1, view);
        return;
      case 'Home':
        event.preventDefault();
        this.focusByIndex(0, view);
        return;
      case 'End':
        event.preventDefault();
        this.focusByIndex(view.rows.length - 1, view);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (row.accessibility.expanded === false && !view.filterActive) {
          this.expansion?.setExpanded(row.key, true);
          this.renderRows({ focusKey: row.key });
        } else {
          const index = view.indexByKey.get(row.key);
          const child =
            index === undefined ? undefined : view.rows.slice(index + 1).find((item) => item.parentKey === row.key);
          if (child) this.focusRow(child.key);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.accessibility.expanded && !view.filterActive) {
          this.expansion?.setExpanded(row.key, false);
          this.renderRows({ focusKey: row.key });
        } else if (row.parentKey && view.rowsByKey.has(row.parentKey)) {
          this.focusRow(row.parentKey);
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.emitSelection(row, selectionMode(event), view);
        return;
      case 'F2':
        event.preventDefault();
        this.beginRename(row);
        return;
      case 'r':
      case 'R':
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.emitReveal(row);
    }
  }

  private focusByIndex(index: number, view: ObjectTreeView): void {
    if (view.rows.length === 0) return;
    const bounded = Math.max(0, Math.min(index, view.rows.length - 1));
    this.focusRow(view.rows[bounded].key);
  }

  private focusRow(key: ObjectTreeRowKey): void {
    this.focusedKey = key;
    const view = this.view;
    const tree = this.tree;
    const index = view?.indexByKey.get(key);
    if (!view || !tree || index === undefined) return;
    const nextOffset = scrollOffsetToRevealRow(
      index,
      tree.scrollTop,
      this.measuredViewportHeight(tree),
      this.rowHeightPx,
      view.rows.length,
    );
    if (nextOffset !== tree.scrollTop || !this.findRowElement(key)) {
      tree.scrollTop = nextOffset;
      this.renderRows({ focusKey: key });
      return;
    }
    this.setRovingFocus(key);
    this.findRowElement(key)?.focus({ preventScroll: true });
  }

  private setRovingFocus(key: ObjectTreeRowKey): void {
    this.focusedKey = key;
    for (const element of this.tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []) {
      element.tabIndex = element.dataset.objectsRowKey === key ? 0 : -1;
    }
  }

  private emitSelection(row: ObjectTreeVisibleRow, mode: ObjectTreeSelectionMode, view: ObjectTreeView): void {
    if (!row.entity) return;
    const anchorRow = this.anchorKey ? view.rowsByKey.get(this.anchorKey) : undefined;
    let range: ObjectTreeEntityRef[] | undefined;
    if (mode === 'range') {
      const anchorIndex = this.anchorKey ? view.indexByKey.get(this.anchorKey) : undefined;
      const targetIndex = view.indexByKey.get(row.key);
      if (anchorIndex === undefined || targetIndex === undefined) {
        range = [cloneEntity(row.entity)];
      } else {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        range = deduplicateEntities(
          view.rows
            .slice(start, end + 1)
            .flatMap((candidate) => (candidate.entity ? [cloneEntity(candidate.entity)] : [])),
        );
      }
    } else {
      this.anchorKey = row.key;
    }
    const request: ObjectsPanelSelectionRequest = {
      mode,
      rowKey: row.key,
      target: cloneEntity(row.entity),
      ...(anchorRow?.entity ? { anchor: cloneEntity(anchorRow.entity) } : {}),
      ...(range ? { range } : {}),
    };
    this.invokeAdapter(() => this.adapter.onSelectionRequest(request));
  }

  private beginRename(row: ObjectTreeVisibleRow): void {
    if (!isRenameable(row)) return;
    this.focusedKey = row.key;
    this.renamingKey = row.key;
    this.renderRows({ focusKey: row.key, focusRename: true });
  }

  private cancelRename(rowKey: ObjectTreeRowKey): void {
    this.renamingKey = undefined;
    this.renderRows({ focusKey: rowKey });
  }

  private emitReveal(row: ObjectTreeVisibleRow): void {
    if (!row.entity) return;
    this.invokeAdapter(() =>
      this.adapter.onRevealRequest({
        rowKey: row.key,
        entity: cloneEntity(row.entity!),
      }),
    );
  }

  /**
   * The row's own operations, then the catalog's (P11.2).
   *
   * Reveal and Rename are panel operations — they exist nowhere in the action
   * catalog because they act on this tree, not on the project. Everything below
   * them is the same set the scene's right-click offers for the same kind of
   * node, supplied by the shell that owns the registry, so the two menus cannot
   * drift apart into two ideas of what an object can do.
   */
  private openContextMenu(
    row: ObjectTreeVisibleRow,
    returnFocus: HTMLElement,
    requestedX: number,
    requestedY: number,
  ): void {
    if (!row.entity) return;
    this.closeContextMenu();
    const local: ContextMenuItem[] = [
      {
        id: 'objects_reveal_row',
        label: 'Reveal in scene',
        onSelect: () => this.emitReveal(row),
      },
    ];
    if (isRenameable(row)) {
      local.push({ id: 'objects_rename_row', label: 'Rename', onSelect: () => this.beginRename(row) });
    }
    const target = contextTargetForRow(row);
    const groups: ContextMenuGroup[] = [
      { label: '', items: local },
      ...(target ? (this.adapter.listContextActions?.(target) ?? []) : []),
    ];
    this.contextMenu.open({
      x: requestedX,
      y: requestedY,
      ariaLabel: `Actions for ${row.label}`,
      groups,
      returnFocus,
      ...(target ? { target } : {}),
    });
  }

  private beginLongPress(event: PointerEvent, row: ObjectTreeVisibleRow, item: HTMLElement): void {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || !row.entity) return;
    this.cancelLongPress();
    const view = item.ownerDocument.defaultView;
    if (!view) return;
    this.longPressWindow = view;
    this.longPressPointerId = event.pointerId;
    this.longPressStart = Object.freeze({ x: event.clientX, y: event.clientY });
    this.longPressTimer = view.setTimeout(() => {
      this.longPressTimer = undefined;
      this.suppressClickKey = row.key;
      this.setRovingFocus(row.key);
      this.openContextMenu(row, item, event.clientX, event.clientY);
    }, LONG_PRESS_DELAY_MS);
  }

  private moveLongPress(event: PointerEvent): void {
    if (event.pointerId !== this.longPressPointerId || !this.longPressStart) return;
    if (
      Math.hypot(event.clientX - this.longPressStart.x, event.clientY - this.longPressStart.y) >
      LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      this.cancelLongPress();
    }
  }

  private endLongPress(event: PointerEvent, rowKey: ObjectTreeRowKey): void {
    if (event.pointerId !== this.longPressPointerId) return;
    const view = this.longPressWindow;
    this.cancelLongPress();
    if (this.suppressClickKey !== rowKey) return;
    view?.setTimeout(() => {
      if (this.suppressClickKey === rowKey) this.suppressClickKey = undefined;
    }, 0);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== undefined) this.longPressWindow?.clearTimeout(this.longPressTimer);
    this.longPressTimer = undefined;
    this.longPressWindow = undefined;
    this.longPressPointerId = undefined;
    this.longPressStart = undefined;
  }

  private closeContextMenu(): void {
    this.contextMenu.close();
  }

  private invokeAdapter(invoke: () => MaybePromise): void {
    try {
      const result = invoke();
      if (result instanceof Promise) void result.catch((error: unknown) => this.reportError(error));
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.adapter.onError) this.adapter.onError(error);
    else console.error('[orcaxr] Objects panel callback failed:', error);
  }

  private findRowElement(key: ObjectTreeRowKey): HTMLElement | undefined {
    return [...(this.tree?.querySelectorAll<HTMLElement>('[data-objects-row-key]') ?? [])].find(
      (element) => element.dataset.objectsRowKey === key,
    );
  }
}

function selectionMode(event: Pick<MouseEvent | KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) {
  if (event.shiftKey) return 'range' as const;
  if (event.ctrlKey || event.metaKey) return 'toggle' as const;
  return 'replace' as const;
}

function isRenameEntity(entity: ObjectTreeEntityRef): entity is ObjectsPanelRenameEntity {
  return entity.kind === 'object' || entity.kind === 'volume';
}

function isRenameable(row: ObjectTreeVisibleRow): boolean {
  return Boolean(row.entity && isRenameEntity(row.entity) && row.indicators.editable);
}

function cloneEntity<T extends ObjectTreeEntityRef>(entity: T): T {
  return { ...entity };
}

function deduplicateEntities(entities: readonly ObjectTreeEntityRef[]): ObjectTreeEntityRef[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = `${entity.kind}:${entity.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Which context menu a tree row belongs to (P11.2).
 *
 * An instance is how a person points at an object, so it carries the object
 * menu. A part and a height range carry none: every catalog action on them
 * needs a payload this menu cannot supply, and a row that could only report
 * "pick one first" is worse than no row.
 */
function contextTargetForRow(row: ObjectTreeVisibleRow): ContextTarget | undefined {
  if (row.kind === 'plate') return 'plate';
  return row.kind === 'object' || row.kind === 'instance' ? 'object' : undefined;
}
