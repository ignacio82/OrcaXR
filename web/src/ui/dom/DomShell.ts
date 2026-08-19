/**
 * DomShell — renders the flat workspace chrome from the shared
 * {@link ActionRegistry}.
 *
 * Everything the header, tool rail, inspector footer and calibration grid show
 * comes from the same registry the XR shell renders, so presentation
 * reachability cannot drift silently. Every control subscribes to
 * {@link UiState}, so enabled / active / visible state updates automatically —
 * no scattered `btn.disabled = …`.
 *
 * Surfaces owned here:
 *  - the tool rail (`dom-toolbar`),
 *  - the inspector's primary action bar (`dom-primary`),
 *  - the mega menu: one column per Orca menu section (`dom-menu`),
 *  - the Prepare → Slice → Preview → Send stage bar, which drives the same
 *    slice / preview / send actions the rest of the app uses,
 *  - the Plates tab's calibration grid, a second presentation of the
 *    Calibration menu section.
 */
import type { Action, ActionRegistry, ActionSurface } from '../../actions/ActionRegistry';
import { MENU_SECTIONS } from '../../actions/ActionRegistry';
import type { ActionContext } from '../../actions/ActionContext';
import { ariaShortcutValue } from '../../actions/ShortcutCatalog';
import type { UiState, UiStateShape } from '../../actions/UiState';
import { domIcon } from '../icons';

interface Hosts {
  toolbar: HTMLElement;
  primary: HTMLElement;
  /** Prepare → Slice → Preview → Send stepper in the header. */
  stageBar: HTMLElement;
  /** Container the File/Edit/View/Add/Tools/Calibration/Help columns mount into. */
  menuBar: HTMLElement;
  /** The `☰ Menu` button that opens {@link Hosts.menuBar}. */
  menuButton: HTMLButtonElement;
  /** Grid in the Plates tab that mirrors the Calibration menu section. */
  calibration: HTMLElement;
}

interface Bound {
  el: HTMLButtonElement;
  action: Action;
  surface: ActionSurface;
}

/**
 * One step of the print workflow. `actionId` is the registry entry the step
 * runs and whose availability it reports — a step is never a decoration that
 * pretends to work.
 */
interface Stage {
  id: string;
  label: string;
  /** Registry action this step invokes, or null when it only restores a mode. */
  actionId: string | null;
  surface: ActionSurface;
}

const STAGES: readonly Stage[] = [
  { id: 'prepare', label: 'Prepare', actionId: null, surface: 'dom-primary' },
  { id: 'slice', label: 'Slice', actionId: 'slice_active_plate', surface: 'dom-primary' },
  { id: 'preview', label: 'Preview', actionId: 'toggle_preview', surface: 'dom-primary' },
  { id: 'send', label: 'Send', actionId: 'send_to_printer', surface: 'dom-inspector' },
];

export class DomShell {
  private bound: Bound[] = [];
  private stageButtons: { stage: Stage; el: HTMLButtonElement; index: number }[] = [];
  private unsubscribe: (() => void) | null = null;
  private eventDisposers: Array<() => void> = [];
  /**
   * Nodes this shell added to a host it does not own outright (P10.4.4).
   *
   * The primary bar holds a hidden file input the shell did not create, so
   * mount appends rather than clearing. That was fine while mount ran once;
   * remounting on a language change made it append a second set of buttons.
   * Tracking what was added is what lets a remount replace its own work.
   */
  private appended: Element[] = [];
  private menuBar: HTMLElement | null = null;
  private menuButton: HTMLButtonElement | null = null;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly ui: UiState,
  ) {}

  mount(hosts: Hosts): void {
    this.dispose();
    this.menuBar = hosts.menuBar;
    this.menuButton = hosts.menuButton;

    // Tool rail
    hosts.toolbar.innerHTML = '';
    for (const a of this.registry.forSurface('dom-toolbar')) {
      hosts.toolbar.appendChild(this.toolButton(a));
    }

    // Primary bar. Existing children are kept — the hidden file input the Load
    // action depends on lives here — so only what a previous mount added is
    // removed, which is what makes a language change repaint rather than
    // duplicate.
    for (const a of this.registry.forSurface('dom-primary')) {
      const button = this.actionButton(a, a.id === 'slice_active_plate');
      hosts.primary.appendChild(button);
      this.appended.push(button);
    }

    // Mega menu — one column per Orca menu section, in bar order. A section
    // with no actions is skipped so the panel stays tidy.
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
    this.bindMenuButton(hosts.menuButton, hosts.menuBar);

    // The calibration grid is a second presentation of the same menu entries,
    // shown where a maker looks for them: next to the plates they print on.
    this.buildCalibrationGrid(
      hosts.calibration,
      menu.filter((a) => a.menuSection === 'calibration'),
    );

    this.buildStageBar(hosts.stageBar);

    this.unsubscribe = this.ui.subscribe((s) => this.refresh(s));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const node of this.appended.splice(0)) node.remove();
    for (const dispose of this.eventDisposers.splice(0).reverse()) dispose();
    for (const { el } of this.bound) el.onclick = null;
    this.bound = [];
    this.stageButtons = [];
    this.menuBar = null;
    this.menuButton = null;
  }

  private toolButton(a: Action): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.setAttribute('aria-label', a.hint ?? a.label);
    const shortcuts = ariaShortcutValue(a.shortcuts);
    if (shortcuts) btn.setAttribute('aria-keyshortcuts', shortcuts);
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = domIcon(a.icon);
    const label = document.createElement('span');
    // The rail collapses to icons only; the label class is what CSS hides, so
    // the accessible name above still describes the button when it does.
    label.className = 'tool-label';
    label.textContent = a.label;
    btn.append(icon, label);
    btn.onclick = () => this.run(a, 'dom-toolbar');
    this.bound.push({ el: btn, action: a, surface: 'dom-toolbar' });
    return btn;
  }

  private actionButton(a: Action, primary: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'action-btn primary' : 'action-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    const shortcuts = ariaShortcutValue(a.shortcuts);
    if (shortcuts) btn.setAttribute('aria-keyshortcuts', shortcuts);
    // Glyph over label: four actions have to share the inspector footer, and a
    // stacked button keeps every one of them legible instead of truncated.
    const glyph = document.createElement('span');
    glyph.className = 'action-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = domIcon(a.icon);
    const label = document.createElement('span');
    label.className = 'action-label';
    label.textContent = a.label;
    btn.append(glyph, label);
    btn.onclick = () => this.run(a, 'dom-primary');
    this.bound.push({ el: btn, action: a, surface: 'dom-primary' });
    return btn;
  }

  // ---- Mega menu ----------------------------------------------------------

  private isMenuOpen(): boolean {
    return this.menuBar?.classList.contains('open') ?? false;
  }

  private setMenuOpen(open: boolean): void {
    this.menuBar?.classList.toggle('open', open);
    this.menuButton?.setAttribute('aria-expanded', String(open));
  }

  private bindMenuButton(button: HTMLButtonElement, panel: HTMLElement): void {
    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      this.setMenuOpen(!this.isMenuOpen());
    };
    button.addEventListener('click', onClick);
    this.eventDisposers.push(() => button.removeEventListener('click', onClick));

    // Click-away and Escape both close the panel, and Escape returns focus to
    // the control that opened it.
    const onDocumentClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.contains(target) && !button.contains(target)) this.setMenuOpen(false);
    };
    document.addEventListener('click', onDocumentClick);
    this.eventDisposers.push(() => document.removeEventListener('click', onDocumentClick));

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.isMenuOpen()) return;
      this.setMenuOpen(false);
      button.focus();
    };
    panel.addEventListener('keydown', onKeydown);
    button.addEventListener('keydown', onKeydown);
    this.eventDisposers.push(() => {
      panel.removeEventListener('keydown', onKeydown);
      button.removeEventListener('keydown', onKeydown);
    });
  }

  private buildMenu(host: HTMLElement, triggerLabel: string, actions: Action[]): void {
    host.innerHTML = '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'menu-trigger';
    trigger.textContent = triggerLabel;
    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    dropdown.setAttribute('role', 'menu');
    dropdown.setAttribute('aria-label', triggerLabel);
    const dropdownId = `oxr-menu-${triggerLabel.toLowerCase()}`;
    dropdown.id = dropdownId;
    trigger.setAttribute('aria-controls', dropdownId);

    for (const a of actions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item';
      item.dataset.actionId = a.id;
      item.setAttribute('role', 'menuitem');
      const shortcuts = ariaShortcutValue(a.shortcuts);
      if (shortcuts) item.setAttribute('aria-keyshortcuts', shortcuts);
      const unavailable = a.capability.status === 'unavailable' || a.capability.status === 'blocked';
      item.title = unavailable ? (a.capability.reason ?? a.label) : (a.hint ?? a.label);
      const badge = unavailable ? '<span class="soon-badge">UNAVAILABLE</span>' : '';
      item.innerHTML = `<span class="glyph">${domIcon(a.icon)}</span><span class="menu-item-label">${a.label}</span>${badge}`;
      item.onclick = () => {
        this.setMenuOpen(false);
        this.run(a, 'dom-menu');
      };
      this.bound.push({ el: item, action: a, surface: 'dom-menu' });
      dropdown.appendChild(item);
    }

    // Every column lives inside one popover, so the section header opens that
    // popover rather than a dropdown of its own. Clicking a header when the
    // panel is already open is a no-op the pointer user never notices, and it
    // keeps a keyboard/automation entry point per section.
    trigger.onclick = (e) => {
      e.stopPropagation();
      this.setMenuOpen(true);
    };

    const enabledItems = () =>
      [...dropdown.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((item) => !item.disabled);
    const onTriggerKeydown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.setMenuOpen(true);
        enabledItems()[0]?.focus();
      }
    };
    trigger.addEventListener('keydown', onTriggerKeydown);
    this.eventDisposers.push(() => trigger.removeEventListener('keydown', onTriggerKeydown));

    const onMenuKeydown = (e: KeyboardEvent) => {
      const items = enabledItems();
      const current = items.indexOf(e.target as HTMLButtonElement);
      if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault();
        items[(current + 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'ArrowUp' && items.length > 0) {
        e.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items.at(-1)?.focus();
      }
    };
    dropdown.addEventListener('keydown', onMenuKeydown);
    this.eventDisposers.push(() => dropdown.removeEventListener('keydown', onMenuKeydown));

    host.appendChild(trigger);
    host.appendChild(dropdown);
  }

  private buildCalibrationGrid(host: HTMLElement, actions: readonly Action[]): void {
    host.innerHTML = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calibration-card';
      btn.dataset.actionId = a.id;
      btn.dataset.calibrationCard = 'true';
      btn.title = a.hint ?? a.label;
      btn.innerHTML =
        `<span class="calibration-name">${domIcon(a.icon)} ${a.label}</span>` +
        (a.hint ? `<span class="calibration-hint">${a.hint}</span>` : '');
      btn.onclick = () => this.run(a, 'dom-menu');
      this.bound.push({ el: btn, action: a, surface: 'dom-menu' });
      host.appendChild(btn);
    }
  }

  // ---- Stage bar ----------------------------------------------------------

  private buildStageBar(host: HTMLElement): void {
    host.innerHTML = '';
    STAGES.forEach((stage, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stage-btn';
      btn.dataset.stage = stage.id;
      const n = document.createElement('span');
      n.className = 'stage-n';
      n.setAttribute('aria-hidden', 'true');
      n.textContent = String(index + 1);
      const label = document.createElement('span');
      label.textContent = stage.label;
      btn.append(n, label);
      btn.onclick = () => this.runStage(stage);
      this.stageButtons.push({ stage, el: btn, index });
      host.appendChild(btn);
    });
  }

  private runStage(stage: Stage): void {
    const state = this.ui.get();
    if (stage.id === 'prepare') {
      // Prepare is the base surface: leaving the preview is the only work.
      if (state.mode !== 'preview') return;
      this.runById('toggle_preview', 'dom-primary');
      return;
    }
    if (stage.id === 'preview' && state.mode === 'preview') return;
    if (stage.actionId) this.runById(stage.actionId, stage.surface);
  }

  private stageIndexFor(s: Readonly<UiStateShape>): number {
    if (s.isSlicing) return 1;
    return s.mode === 'preview' ? 2 : 0;
  }

  // ---- Shared plumbing ----------------------------------------------------

  private runById(id: string, surface: ActionSurface): void {
    const action = this.registry.get(id);
    if (!action) {
      this.ctx.reportCapabilityUnavailable(id, `The "${id}" action is not registered.`);
      return;
    }
    this.run(action, surface);
  }

  private run(a: Action, surface: ActionSurface): void {
    void this.registry
      .invoke(a, surface, this.ctx, this.ui.get())
      .catch((e) => console.error(`[orcaxr] action "${a.id}" failed:`, e));
  }

  private refresh(s: Readonly<UiStateShape>): void {
    for (const { el, action, surface } of this.bound) {
      const availability = this.registry.availability(action, surface, s);
      el.style.display = availability.state === 'hidden' ? 'none' : '';
      el.disabled = availability.state !== 'enabled';
      el.title = availability.state === 'disabled' ? availability.reason : (action.hint ?? action.label);
      if (action.tool) el.classList.toggle('active', s.activeTool === action.tool);
    }

    const current = this.stageIndexFor(s);
    for (const { stage, el, index } of this.stageButtons) {
      const active = index === current;
      // A step is "done" once the workflow has moved past it. Slice also
      // reports done while sitting in Prepare with a fresh artifact in hand.
      const done = index < current || (stage.id === 'slice' && s.gcodeReady && !s.isSlicing);
      el.classList.toggle('active', active);
      el.classList.toggle('done', !active && done);
      el.setAttribute('aria-current', active ? 'step' : 'false');
      const marker = el.querySelector<HTMLElement>('.stage-n');
      if (marker) marker.textContent = !active && done ? '✓' : String(index + 1);

      if (stage.actionId) {
        const availability = this.registry.availability(stage.actionId, stage.surface, s);
        const alreadyThere = stage.id === 'preview' && s.mode === 'preview';
        el.disabled = !alreadyThere && availability.state !== 'enabled';
        el.title =
          availability.state === 'disabled' && !alreadyThere ? availability.reason : `${stage.label} the active plate`;
      } else {
        el.disabled = false;
        el.title = 'Return to the prepare view';
      }
    }
  }
}
