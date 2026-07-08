/**
 * DomShell — renders the desktop UI from the shared {@link ActionRegistry}.
 *
 * Phase 2 (workspace + inspector IA): the tool rail (left), the primary bar,
 * the `Add ▾` / `Tools ▾` header menus, and the Prepare|Paint|Preview mode
 * control all come from the same registry the XR shell uses. Every control
 * subscribes to {@link UiState}, so enabled / active / visible state updates
 * automatically — no scattered `btn.disabled = …`.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import { ActionRegistry as Reg, MENU_SECTIONS } from '../../actions/ActionRegistry';
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
}

const MODES: { id: WorkspaceMode; label: string }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'preview', label: 'Preview' },
];

export class DomShell {
  private bound: Bound[] = [];
  private modeButtons: { id: WorkspaceMode; el: HTMLButtonElement }[] = [];

  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly ui: UiState,
  ) {}

  mount(hosts: Hosts): void {
    // Tool rail
    hosts.toolbar.innerHTML = '';
    for (const a of this.registry.byDisclosure('toolbar')) {
      hosts.toolbar.appendChild(this.toolButton(a));
    }

    // Primary bar (keep any existing children, e.g. the hidden file input)
    for (const a of this.registry.byDisclosure('primary')) {
      hosts.primary.appendChild(this.actionButton(a, a.id === 'slice_active_plate'));
    }

    // Full menu bar — one dropdown per Orca menu section, in bar order. A
    // section with no actions is skipped so the bar stays tidy.
    const menu = this.registry.byDisclosure('menu');
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

    this.ui.subscribe((s) => this.refresh(s));
  }

  private toolButton(a: Action): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.textContent = a.label;
    btn.onclick = () => this.run(a);
    this.bound.push({ el: btn, action: a });
    return btn;
  }

  private actionButton(a: Action, primary: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = primary ? 'action-btn primary' : 'action-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.textContent = `${domIcon(a.icon)}  ${a.label}`;
    btn.onclick = () => this.run(a);
    this.bound.push({ el: btn, action: a });
    return btn;
  }

  private buildMenu(host: HTMLElement, triggerLabel: string, actions: Action[]): void {
    host.innerHTML = '';
    const trigger = document.createElement('button');
    trigger.className = 'menu-trigger';
    trigger.innerHTML = `${triggerLabel} <span aria-hidden="true">▾</span>`;
    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';

    for (const a of actions) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.dataset.actionId = a.id;
      const soon = Reg.comingSoon(a);
      // Coming-soon parity placeholders carry their reason as the tooltip and a
      // "SOON" badge so the surface reaches parity while staying honest.
      item.title = soon ?? a.hint ?? a.label;
      const badge = soon ? '<span class="soon-badge">SOON</span>' : '';
      item.innerHTML = `<span class="glyph">${domIcon(a.icon)}</span><span class="menu-item-label">${a.label}</span>${badge}`;
      item.onclick = () => {
        host.classList.remove('open');
        this.run(a);
      };
      this.bound.push({ el: item, action: a });
      dropdown.appendChild(item);
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = host.classList.contains('open');
      // Close any other open menu, then toggle this one.
      document.querySelectorAll('.menu-host.open').forEach((m) => m.classList.remove('open'));
      host.classList.toggle('open', !wasOpen);
    };
    // Click-away closes.
    document.addEventListener('click', (e) => {
      if (!host.contains(e.target as Node)) host.classList.remove('open');
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
      btn.textContent = m.label;
      btn.onclick = () => this.ctx.setMode(m.id);
      this.modeButtons.push({ id: m.id, el: btn });
      host.appendChild(btn);
    }
  }

  private run(a: Action): void {
    if (!Reg.enabled(a, this.ui.get())) return;
    void Promise.resolve(a.run(this.ctx)).catch((e) =>
      console.error(`[orcaxr] action "${a.id}" failed:`, e),
    );
  }

  private refresh(s: Readonly<ReturnType<UiState['get']>>): void {
    for (const { el, action } of this.bound) {
      el.style.display = Reg.visible(action, s) ? '' : 'none';
      el.disabled = !Reg.enabled(action, s);
      if (action.tool) el.classList.toggle('active', s.activeTool === action.tool);
    }
    for (const { id, el } of this.modeButtons) {
      el.classList.toggle('active', s.mode === id);
    }
  }
}
