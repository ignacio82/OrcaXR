/**
 * WorkspaceViews — the four tabs the official application is organised around:
 * Prepare, Preview, Device, Project.
 *
 * This replaces the six-tab inspector. The difference is not cosmetic: a tab
 * here selects a *workspace*, not a panel. Prepare and Preview share the
 * parameter sidebar and differ in what the 3D view is showing; Device and
 * Project are full pages that take the whole work area, exactly as upstream's
 * do, and the scene keeps its state underneath them.
 *
 * The tab strip follows the WAI-ARIA tabs pattern (roving tabindex, arrow-key
 * navigation, `aria-selected`, `aria-controls`).
 *
 * Preview is a real mode, not a panel: entering it runs the same
 * `toggle_preview` action the menu and the keyboard run, and the tab follows
 * `UiState.mode` back when the workspace opens or closes the toolpath preview
 * by itself. That is what keeps the header from reading "Prepare" over a
 * visible toolpath.
 */
import type { UiState, UiStateShape } from '../../actions/UiState';
import { applyIcon } from '../icons';
import { t } from '../../l10n/t';

export type WorkspaceViewId = 'prepare' | 'preview' | 'device' | 'project';

export interface WorkspaceViewHosts {
  /** `role="tablist"` container the tab buttons mount into. */
  tabs: HTMLElement;
  /** The parameter sidebar, hidden while a full page is up. */
  sidebar: HTMLElement;
  /** Floating model toolbar, hidden while a full page is up. */
  toolbar: HTMLElement;
  /** Plate strip over the build plate, hidden while a full page is up. */
  plateBar: HTMLElement;
  /** Full-window Device page. */
  devicePage: HTMLElement;
  /** Full-window Project page. */
  projectPage: HTMLElement;
  /** The sidebar's Preview card, which only belongs to the Preview view. */
  previewCard: HTMLElement;
}

interface ViewDefinition {
  id: WorkspaceViewId;
  /**
   * Resolved at render time, and with both arguments written out: the message
   * extractor reads this file's AST, so a computed id or a computed source
   * would take the label out of the catalogue entirely (P10.4).
   */
  label(): string;
  /** Semantic icon key resolved through `ui/icons.ts`. */
  icon: string;
  /** Element the tab controls, for `aria-controls`. */
  controls(hosts: WorkspaceViewHosts): HTMLElement;
}

const VIEWS: readonly ViewDefinition[] = [
  {
    id: 'prepare',
    label: () => t('ui.workspaceViews.prepare', 'Prepare'),
    icon: 'scene',
    controls: (h) => h.sidebar,
  },
  {
    id: 'preview',
    label: () => t('ui.workspaceViews.preview', 'Preview'),
    icon: 'preview',
    controls: (h) => h.previewCard,
  },
  {
    id: 'device',
    label: () => t('ui.workspaceViews.device', 'Device'),
    icon: 'output',
    controls: (h) => h.devicePage,
  },
  {
    id: 'project',
    label: () => t('ui.workspaceViews.project', 'Project'),
    icon: 'file',
    controls: (h) => h.projectPage,
  },
];

/** Views that keep the 3D workspace and its chrome on screen. */
const SCENE_VIEWS = new Set<WorkspaceViewId>(['prepare', 'preview']);

export class WorkspaceViews {
  private buttons = new Map<WorkspaceViewId, HTMLButtonElement>();
  private active: WorkspaceViewId = 'prepare';
  private unsubscribe: (() => void) | null = null;
  private disposers: Array<() => void> = [];
  private lastMode: UiStateShape['mode'] | null = null;

  constructor(
    private readonly hosts: WorkspaceViewHosts,
    private readonly ui: UiState,
    /** Runs a registry action; the only way this class changes the workspace. */
    private readonly invoke: (actionId: string) => void,
  ) {}

  mount(): void {
    this.dispose();
    this.hosts.tabs.innerHTML = '';

    for (const view of VIEWS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'view-tab';
      btn.id = `view-tab-${view.id}`;
      btn.dataset.viewTab = view.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', view.controls(this.hosts).id);
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = -1;
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      applyIcon(glyph, view.icon);
      const label = document.createElement('span');
      label.textContent = view.label();
      btn.append(glyph, label);
      btn.onclick = () => this.activate(view.id);
      this.buttons.set(view.id, btn);
      this.hosts.tabs.appendChild(btn);
    }

    const onKeydown = (e: KeyboardEvent) => this.onTabKeydown(e);
    this.hosts.tabs.addEventListener('keydown', onKeydown);
    this.disposers.push(() => this.hosts.tabs.removeEventListener('keydown', onKeydown));

    this.apply({ focus: false });
    this.unsubscribe = this.ui.subscribe((s) => this.syncWithState(s));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    for (const btn of this.buttons.values()) btn.onclick = null;
    this.buttons.clear();
    this.lastMode = null;
  }

  /** The view currently showing. */
  get activeView(): WorkspaceViewId {
    return this.active;
  }

  /**
   * Show `id`.
   *
   * Prepare and Preview are the two halves of one mode, so moving between them
   * runs `toggle_preview` rather than only repainting the chrome. Moving to a
   * page leaves the mode alone: coming back from Device lands the operator
   * exactly where they left, toolpath and all.
   */
  activate(id: WorkspaceViewId, options: { focus?: boolean } = {}): void {
    if (!this.buttons.has(id)) return;
    const state = this.ui.get();
    this.active = id;
    this.apply(options);
    if (id === 'preview' && state.mode !== 'preview') this.invoke('toggle_preview');
    if (id === 'prepare' && state.mode === 'preview') this.invoke('toggle_preview');
  }

  private apply(options: { focus?: boolean } = {}): void {
    const scene = SCENE_VIEWS.has(this.active);
    for (const [viewId, btn] of this.buttons) {
      const selected = viewId === this.active;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
      if (selected && options.focus) btn.focus();
    }
    this.hosts.devicePage.hidden = this.active !== 'device';
    this.hosts.projectPage.hidden = this.active !== 'project';
    // A page covers the viewport, so the chrome that belongs to the 3D view
    // goes with it rather than floating over a page it cannot act on.
    this.hosts.sidebar.hidden = !scene;
    this.hosts.toolbar.hidden = !scene;
    this.hosts.plateBar.hidden = !scene;
    this.hosts.previewCard.hidden = this.active !== 'preview';
  }

  private onTabKeydown(e: KeyboardEvent): void {
    const order = VIEWS.filter((v) => this.buttons.has(v.id)).map((v) => v.id);
    const current = order.indexOf(this.active);
    if (current < 0) return;
    let next: WorkspaceViewId | undefined;
    if (e.key === 'ArrowRight') next = order[(current + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(current - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order.at(-1);
    if (!next) return;
    e.preventDefault();
    this.activate(next, { focus: true });
  }

  /**
   * Follow the workspace. The preview opens itself after a slice, so the tab
   * has to move with it; only a *transition* moves it, which is what keeps a
   * deliberate visit to Device from being yanked away by a finishing slice.
   */
  private syncWithState(s: Readonly<UiStateShape>): void {
    if (this.lastMode !== null && this.lastMode !== s.mode) {
      const target: WorkspaceViewId = s.mode === 'preview' ? 'preview' : 'prepare';
      if (this.active !== target && SCENE_VIEWS.has(this.active)) {
        this.active = target;
        this.apply();
      }
    }
    this.lastMode = s.mode;
  }
}
