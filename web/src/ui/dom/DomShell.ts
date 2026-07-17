/**
 * DomShell — renders the desktop UI from the shared {@link ActionRegistry}.
 *
 * Phase 2 (workspace + inspector IA): the tool rail (left), the primary bar,
 * the `Add ▾` / `Tools ▾` header menus, and the Prepare|Paint|Preview mode
 * control all come from the same registry the XR shell uses. Every control
 * subscribes to {@link UiState}, so enabled / active / visible state updates
 * automatically — no scattered `btn.disabled = …`.
 */
import type { Action, ActionRegistry, ActionSurface } from '../../actions/ActionRegistry';
import { MENU_SECTIONS } from '../../actions/ActionRegistry';
import type { ActionContext } from '../../actions/ActionContext';
import type { UiState, WorkspaceMode } from '../../actions/UiState';
import { domIcon } from '../icons';

interface Hosts {
  toolbar: HTMLElement;
  primary: HTMLElement;
  modeControl: HTMLElement;
  /** Container the File/Edit/View/Add/Tools/Calibration/Help menus mount into. */
  menuBar: HTMLElement;
}

interface Bound {
  el: HTMLButtonElement;
  action: Action;
  surface: ActionSurface;
}

const MODES: { id: WorkspaceMode; label: string }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'preview', label: 'Preview' },
];

export class DomShell {
  private bound: Bound[] = [];
  private modeButtons: { id: WorkspaceMode; el: HTMLButtonElement }[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly ui: UiState,
  ) {}

  mount(hosts: Hosts): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bound = [];
    this.modeButtons = [];
    // Tool rail
    hosts.toolbar.innerHTML = '';
    for (const a of this.registry.forSurface('dom-toolbar')) {
      hosts.toolbar.appendChild(this.toolButton(a));
    }

    // Primary bar (keep any existing children, e.g. the hidden file input)
    for (const a of this.registry.forSurface('dom-primary')) {
      hosts.primary.appendChild(this.actionButton(a, a.id === 'slice_active_plate'));
    }

    // Full menu bar — one dropdown per Orca menu section, in bar order. A
    // section with no actions is skipped so the bar stays tidy.
    const menu = this.registry.forSurface('dom-menu');
    hosts.menuBar.innerHTML = '';
    for (const section of MENU_SECTIONS) {
      const items = menu.filter((a) => a.menuSection === section.id);
      if (items.length === 0) continue;
      const host = document.createElement('div');
      host.className = 'menu-host';
      hosts.menuBar.appendChild(host);
      this.buildMenu(host, section.label, items);
    }

    // Mode control
    this.buildModeControl(hosts.modeControl);

    this.unsubscribe = this.ui.subscribe((s) => this.refresh(s));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const { el } of this.bound) el.onclick = null;
    this.bound = [];
    this.modeButtons = [];
  }

  private toolButton(a: Action): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.setAttribute('aria-label', a.hint ?? a.label);
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = domIcon(a.icon);
    const label = document.createElement('span');
    label.textContent = a.label;
    btn.append(icon, label);
    btn.onclick = () => this.run(a, 'dom-toolbar');
    this.bound.push({ el: btn, action: a, surface: 'dom-toolbar' });
    return btn;
  }

  private actionButton(a: Action, primary: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = primary ? 'action-btn primary' : 'action-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.textContent = `${domIcon(a.icon)}  ${a.label}`;
    btn.onclick = () => this.run(a, 'dom-primary');
    this.bound.push({ el: btn, action: a, surface: 'dom-primary' });
    return btn;
  }

  private buildMenu(host: HTMLElement, triggerLabel: string, actions: Action[]): void {
    host.innerHTML = '';
    const trigger = document.createElement('button');
    trigger.className = 'menu-trigger';
    trigger.innerHTML = `${triggerLabel} <span aria-hidden="true">▾</span>`;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    dropdown.setAttribute('role', 'menu');

    for (const a of actions) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.dataset.actionId = a.id;
      item.setAttribute('role', 'menuitem');
      const unavailable = a.capability.status === 'unavailable' || a.capability.status === 'blocked';
      item.title = unavailable ? (a.capability.reason ?? a.label) : (a.hint ?? a.label);
      const badge = unavailable ? '<span class="soon-badge">UNAVAILABLE</span>' : '';
      item.innerHTML = `<span class="glyph">${domIcon(a.icon)}</span><span class="menu-item-label">${a.label}</span>${badge}`;
      item.onclick = () => {
        host.classList.remove('open');
        this.run(a, 'dom-menu');
      };
      this.bound.push({ el: item, action: a, surface: 'dom-menu' });
      dropdown.appendChild(item);
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = host.classList.contains('open');
      // Close any other open menu, then toggle this one.
      document.querySelectorAll('.menu-host.open').forEach((m) => {
        m.classList.remove('open');
        m.querySelector<HTMLButtonElement>('.menu-trigger')?.setAttribute('aria-expanded', 'false');
      });
      host.classList.toggle('open', !wasOpen);
      trigger.setAttribute('aria-expanded', String(!wasOpen));
    };
    // Click-away closes.
    document.addEventListener('click', (e) => {
      if (!host.contains(e.target as Node)) {
        host.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        host.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      }
    });

    host.appendChild(trigger);
    host.appendChild(dropdown);
  }

  private buildModeControl(host: HTMLElement): void {
    host.innerHTML = '';
    for (const m of MODES) {
      const btn = document.createElement('button');
      btn.className = 'seg-btn';
      btn.dataset.mode = m.id;
      btn.setAttribute('aria-pressed', String(m.id === this.ui.get().mode));
      btn.textContent = m.label;
      btn.onclick = () => this.ctx.setMode(m.id);
      this.modeButtons.push({ id: m.id, el: btn });
      host.appendChild(btn);
    }
  }

  private run(a: Action, surface: ActionSurface): void {
    void this.registry
      .invoke(a, surface, this.ctx, this.ui.get())
      .catch((e) => console.error(`[orcaxr] action "${a.id}" failed:`, e));
  }

  private refresh(s: Readonly<ReturnType<UiState['get']>>): void {
    for (const { el, action, surface } of this.bound) {
      const availability = this.registry.availability(action, surface, s);
      el.style.display = availability.state === 'hidden' ? 'none' : '';
      el.disabled = availability.state !== 'enabled';
      el.title = availability.state === 'disabled' ? availability.reason : (action.hint ?? action.label);
      if (action.tool) el.classList.toggle('active', s.activeTool === action.tool);
    }
    for (const { id, el } of this.modeButtons) {
      el.classList.toggle('active', s.mode === id);
      el.setAttribute('aria-pressed', String(s.mode === id));
    }
  }
}
