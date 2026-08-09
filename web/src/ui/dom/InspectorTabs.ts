/**
 * InspectorTabs — the right inspector's top-level information architecture.
 *
 * The inspector used to be one long scroll of a dozen disclosure sections, so
 * finding the filament list meant scrolling past the settings tree. It is now
 * six tabs — Objects, Settings, Filament, Preview, Printer, Plates — each
 * holding the panels that already existed. Nothing was removed: every host
 * element still mounts the same component, it just lives under a named tab.
 *
 * The tab strip follows the WAI-ARIA tabs pattern (roving tabindex, arrow-key
 * navigation, `aria-selected`, `aria-controls`), and the heading below it names
 * the active tab so a screen-reader user always knows which section is showing.
 *
 * Tabs also follow the workflow: entering the toolpath preview selects Preview,
 * returning to prepare selects Objects, and picking a painting tool selects
 * Filament — the same coupling the stage bar expresses in the header.
 */
import type { UiState, UiStateShape } from '../../actions/UiState';
import { domIcon } from '../icons';

export interface InspectorTabsHosts {
  /** `role="tablist"` container the tab buttons mount into. */
  tabs: HTMLElement;
  /** Heading that names the active tab. */
  title: HTMLElement;
  /** Small monospace readout beside the heading. */
  meta: HTMLElement;
  /** Scrolling region holding one `.insp-panel` per tab. */
  panels: HTMLElement;
}

export type InspectorTabId = 'objects' | 'settings' | 'filament' | 'preview' | 'printer' | 'plates';

interface TabDefinition {
  id: InspectorTabId;
  label: string;
  /** Semantic icon key resolved through `ui/icons.ts`. */
  icon: string;
  title: string;
  /** Short factual readout; only ever derived from UiState. */
  meta(s: Readonly<UiStateShape>): string;
}

const PRINTER_STATE_LABELS: Readonly<Record<UiStateShape['printerJobState'], string>> = {
  disconnected: 'not connected',
  unknown: 'connected',
  standby: 'idle',
  printing: 'printing',
  paused: 'paused',
  complete: 'complete',
  cancelled: 'cancelled',
  error: 'error',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TABS: readonly TabDefinition[] = [
  {
    id: 'objects',
    label: 'Objects',
    icon: 'scene',
    title: 'Objects on plate',
    meta: (s) => plural(s.modelCount, 'object'),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'slice_group',
    title: 'Print settings',
    meta: (s) => plural(s.extruderCount, 'extruder'),
  },
  {
    id: 'filament',
    label: 'Filament',
    icon: 'filament',
    title: 'Filament & paint',
    meta: (s) => plural(s.extruderCount, 'slot'),
  },
  {
    id: 'preview',
    label: 'Preview',
    icon: 'preview',
    title: 'Toolpath preview',
    meta: (s) => (s.isSlicing ? 'slicing…' : s.gcodeReady ? 'G-code ready' : 'not sliced'),
  },
  {
    id: 'printer',
    label: 'Printer',
    icon: 'output',
    title: 'Printer & output',
    meta: (s) => PRINTER_STATE_LABELS[s.printerJobState],
  },
  {
    id: 'plates',
    label: 'Plates',
    icon: 'plate',
    title: 'Plates & calibration',
    meta: (s) => plural(s.plateCount, 'plate'),
  },
];

/** Tools whose configuration lives in the Filament tab. */
const PAINT_TOOLS = new Set(['paint', 'support_paint', 'seam_paint', 'fuzzy_skin', 'smart_paint', 'smart_paint_image']);

export class InspectorTabs {
  private buttons = new Map<InspectorTabId, HTMLButtonElement>();
  private panels = new Map<InspectorTabId, HTMLElement>();
  private active: InspectorTabId = 'objects';
  private unsubscribe: (() => void) | null = null;
  private disposers: Array<() => void> = [];
  private lastMode: UiStateShape['mode'] | null = null;
  private lastTool: string | null = null;

  constructor(
    private readonly hosts: InspectorTabsHosts,
    private readonly ui: UiState,
  ) {}

  mount(): void {
    this.dispose();
    this.hosts.tabs.innerHTML = '';

    for (const tab of TABS) {
      const panel = this.hosts.panels.querySelector<HTMLElement>(`#insp-panel-${tab.id}`);
      if (!panel) continue;
      this.panels.set(tab.id, panel);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'insp-tab';
      btn.id = `insp-tab-${tab.id}`;
      btn.dataset.inspectorTab = tab.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', panel.id);
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = -1;
      btn.title = tab.title;
      const glyph = document.createElement('span');
      glyph.className = 'insp-tab-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = domIcon(tab.icon);
      const label = document.createElement('span');
      label.className = 'insp-tab-label';
      label.textContent = tab.label;
      btn.append(glyph, label);
      btn.onclick = () => this.activate(tab.id);
      this.buttons.set(tab.id, btn);
      this.hosts.tabs.appendChild(btn);
    }

    const onKeydown = (e: KeyboardEvent) => this.onTabKeydown(e);
    this.hosts.tabs.addEventListener('keydown', onKeydown);
    this.disposers.push(() => this.hosts.tabs.removeEventListener('keydown', onKeydown));

    this.activate(this.active, { focus: false });
    this.unsubscribe = this.ui.subscribe((s) => this.syncWithState(s));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    for (const btn of this.buttons.values()) btn.onclick = null;
    this.buttons.clear();
    this.panels.clear();
    this.lastMode = null;
    this.lastTool = null;
  }

  /** The tab currently showing. */
  get activeTab(): InspectorTabId {
    return this.active;
  }

  activate(id: InspectorTabId, options: { focus?: boolean } = {}): void {
    if (!this.panels.has(id)) return;
    this.active = id;
    for (const [tabId, btn] of this.buttons) {
      const selected = tabId === id;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
      if (selected && options.focus) btn.focus();
    }
    for (const [tabId, panel] of this.panels) panel.hidden = tabId !== id;
    const definition = TABS.find((t) => t.id === id);
    if (definition) {
      this.hosts.title.textContent = definition.title;
      this.hosts.meta.textContent = definition.meta(this.ui.get());
    }
    // A tab switch is a new context; start it at the top rather than at the
    // previous tab's scroll offset.
    this.hosts.panels.scrollTop = 0;
  }

  private onTabKeydown(e: KeyboardEvent): void {
    const order = TABS.filter((t) => this.buttons.has(t.id)).map((t) => t.id);
    const current = order.indexOf(this.active);
    if (current < 0) return;
    let next: InspectorTabId | undefined;
    if (e.key === 'ArrowRight') next = order[(current + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(current - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order.at(-1);
    if (!next) return;
    e.preventDefault();
    this.activate(next, { focus: true });
  }

  /**
   * Keep the tab meaningful as the workspace changes. Only *transitions* move
   * the tab, so an explicit choice is never yanked away mid-task.
   */
  private syncWithState(s: Readonly<UiStateShape>): void {
    const definition = TABS.find((t) => t.id === this.active);
    if (definition) this.hosts.meta.textContent = definition.meta(s);

    if (this.lastMode !== null && this.lastMode !== s.mode) {
      this.activate(s.mode === 'preview' ? 'preview' : 'objects');
    }
    this.lastMode = s.mode;

    if (this.lastTool !== null && this.lastTool !== s.activeTool && PAINT_TOOLS.has(s.activeTool)) {
      this.activate('filament');
    }
    this.lastTool = s.activeTool;
  }
}
