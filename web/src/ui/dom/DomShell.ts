/**
 * DomShell — renders the flat workspace chrome from the shared
 * {@link ActionRegistry}.
 *
 * Everything the menu bar, model toolbar, sidebar footer and calibration grid
 * show comes from the same registry the XR shell renders, so presentation
 * reachability cannot drift silently. Every control subscribes to
 * {@link UiState}, so enabled / active / visible state updates automatically —
 * no scattered `btn.disabled = …`.
 *
 * The chrome is arranged as the official Snapmaker Orca application arranges
 * it, and each surface here is one of that application's own:
 *
 *  - the menu bar (`dom-menu`): one trigger per upstream section, each opening
 *    its own dropdown, in the strip along the top of the window;
 *  - the quick actions beside it — save, undo, redo — which upstream also
 *    keeps as bare icons next to the menus;
 *  - the model toolbar (`dom-toolbar`), floating over the top edge of the 3D
 *    view rather than docked as a rail;
 *  - `Slice plate` and `Print` at the inline end of the tab strip, which are
 *    presentation of the same two registry actions the rest of the app uses
 *    and never a second slice path;
 *  - the sidebar footer's primary bar (`dom-primary`);
 *  - the Project page's calibration grid, a second presentation of the
 *    Calibration menu section.
 *
 * The four workspace tabs (Prepare / Preview / Device / Project) are *not*
 * here: they own view state rather than actions, and they live in
 * {@link WorkspaceViews}.
 */
import type { Action, ActionRegistry, ActionSurface } from '../../actions/ActionRegistry';
import { MENU_SECTIONS } from '../../actions/ActionRegistry';
import type { ActionContext } from '../../actions/ActionContext';
import { ariaShortcutValue } from '../../actions/ShortcutCatalog';
import type { UiState, UiStateShape } from '../../actions/UiState';
import { applyIcon } from '../icons';
import { t } from '../../l10n/t';

interface Hosts {
  /** Floating model-tool strip over the viewport. */
  toolbar: HTMLElement;
  primary: HTMLElement;
  /** Save / undo / redo, in the menu strip. */
  quickActions: HTMLElement;
  /** `Slice plate` and `Print`, at the end of the tab strip. */
  printActions: HTMLElement;
  /** Container the File/Edit/View/Add/Tools/Calibration/Help menus mount into. */
  menuBar: HTMLElement;
  /** The `☰` button that reveals {@link Hosts.menuBar} on a narrow window. */
  menuButton: HTMLButtonElement;
  /** Grid on the Project page that mirrors the Calibration menu section. */
  calibration: HTMLElement;
}

interface Bound {
  el: HTMLButtonElement;
  action: Action;
  surface: ActionSurface;
}

/**
 * The first binding of an `aria-keyshortcuts` list, spelled the way a menu
 * spells it. Presentation only — matching still runs off the catalog.
 */
function shortcutHint(shortcuts: string): string {
  const [first = ''] = shortcuts.split(' ');
  return first
    .split('+')
    .map((part) => (part === 'Control' ? 'Ctrl' : part === 'Meta' ? '⌘' : part === 'Shift' ? '⇧' : part))
    .join('+');
}

/** Registry actions the menu strip keeps as bare icons, in upstream's order. */
const QUICK_ACTIONS: readonly string[] = ['file_save_project', 'edit_undo', 'edit_redo'];

/**
 * The two buttons at the end of the tab strip. `primary` is the filled one;
 * both invoke a registry action and report its availability, so a disabled
 * `Print` says why rather than pretending.
 */
const PRINT_ACTIONS: readonly { id: string; surface: ActionSurface }[] = [
  { id: 'slice_active_plate', surface: 'dom-primary' },
  { id: 'send_to_printer', surface: 'dom-inspector' },
];

export class DomShell {
  private bound: Bound[] = [];
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
  private menuHosts: HTMLElement[] = [];
  private sliceButton: HTMLButtonElement | null = null;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly ui: UiState,
  ) {}

  mount(hosts: Hosts): void {
    this.dispose();
    this.menuBar = hosts.menuBar;
    this.menuButton = hosts.menuButton;

    // Model toolbar. A hairline goes in wherever the action group changes, the
    // way upstream's toolbar separates move/rotate/scale from the mesh
    // operations from the painting tools — twenty undifferentiated icons is a
    // strip nobody can aim at.
    hosts.toolbar.innerHTML = '';
    let previousGroup: string | null = null;
    for (const a of this.registry.forSurface('dom-toolbar')) {
      if (previousGroup !== null && a.group !== previousGroup) {
        const separator = document.createElement('span');
        separator.className = 'tool-sep';
        separator.setAttribute('aria-hidden', 'true');
        hosts.toolbar.appendChild(separator);
      }
      previousGroup = a.group;
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

    // Menu bar — one dropdown per upstream section, in bar order. A section
    // with no actions is skipped so the bar stays tidy.
    const menu = this.registry.forSurface('dom-menu');
    hosts.menuBar.innerHTML = '';
    this.menuHosts = [];
    for (const section of MENU_SECTIONS) {
      const items = menu.filter((a) => a.menuSection === section.id);
      if (items.length === 0) continue;
      const host = document.createElement('div');
      host.className = 'menu-host';
      hosts.menuBar.appendChild(host);
      this.menuHosts.push(host);
      this.buildMenu(host, section.label, items);
    }
    this.bindMenuButton(hosts.menuButton, hosts.menuBar);

    this.buildQuickActions(hosts.quickActions);
    this.buildPrintActions(hosts.printActions);

    // The calibration grid is a second presentation of the same menu entries,
    // shown where a maker looks for them: next to the plates they print on.
    this.buildCalibrationGrid(
      hosts.calibration,
      menu.filter((a) => a.menuSection === 'calibration'),
    );

    this.unsubscribe = this.ui.subscribe((s) => this.refresh(s));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const node of this.appended.splice(0)) node.remove();
    for (const dispose of this.eventDisposers.splice(0).reverse()) dispose();
    for (const { el } of this.bound) el.onclick = null;
    this.bound = [];
    this.menuBar = null;
    this.menuButton = null;
    this.menuHosts = [];
    this.sliceButton = null;
  }

  private toolButton(a: Action): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn';
    btn.dataset.actionId = a.id;
    btn.title = a.hint ?? a.label;
    btn.setAttribute('aria-label', a.label);
    const shortcuts = ariaShortcutValue(a.shortcuts);
    if (shortcuts) btn.setAttribute('aria-keyshortcuts', shortcuts);
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    applyIcon(icon, a.icon);
    const label = document.createElement('span');
    // A toolbar is icons; the label is the accessible name and the tooltip, and
    // CSS hides it visually except on the phone layout where a bare 32px icon
    // is not enough to act on.
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
    // Glyph over label: four actions have to share the sidebar footer, and a
    // stacked button keeps every one of them legible instead of truncated.
    const glyph = document.createElement('span');
    glyph.className = 'action-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    applyIcon(glyph, a.icon);
    const label = document.createElement('span');
    label.className = 'action-label';
    label.textContent = a.label;
    btn.append(glyph, label);
    btn.onclick = () => this.run(a, 'dom-primary');
    this.bound.push({ el: btn, action: a, surface: 'dom-primary' });
    return btn;
  }

  // ---- Menu strip ---------------------------------------------------------

  private buildQuickActions(host: HTMLElement): void {
    host.innerHTML = '';
    for (const id of QUICK_ACTIONS) {
      const a = this.registry.get(id);
      if (!a) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'strip-btn';
      btn.dataset.actionId = a.id;
      btn.title = a.hint ?? a.label;
      btn.setAttribute('aria-label', a.label);
      const shortcuts = ariaShortcutValue(a.shortcuts);
      if (shortcuts) btn.setAttribute('aria-keyshortcuts', shortcuts);
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      applyIcon(icon, a.icon);
      btn.append(icon);
      btn.onclick = () => this.run(a, 'dom-menu');
      this.bound.push({ el: btn, action: a, surface: 'dom-menu' });
      host.appendChild(btn);
    }
  }

  private buildPrintActions(host: HTMLElement): void {
    host.innerHTML = '';
    this.sliceButton = null;
    for (const { id, surface } of PRINT_ACTIONS) {
      const a = this.registry.get(id);
      if (!a) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'print-btn';
      btn.dataset.actionId = a.id;
      btn.dataset.printAction = a.id;
      const shortcuts = ariaShortcutValue(a.shortcuts);
      if (shortcuts) btn.setAttribute('aria-keyshortcuts', shortcuts);
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      applyIcon(icon, a.icon);
      const label = document.createElement('span');
      label.textContent = a.label;
      btn.append(icon, label);
      btn.onclick = () => this.run(a, surface);
      this.bound.push({ el: btn, action: a, surface });
      if (id === 'slice_active_plate') this.sliceButton = btn;
      host.appendChild(btn);
    }
  }

  // ---- Menus --------------------------------------------------------------

  /** True while the bar itself is revealed (the narrow-window hamburger). */
  private isMenuOpen(): boolean {
    return this.menuBar?.classList.contains('open') ?? false;
  }

  private setMenuOpen(open: boolean): void {
    this.menuBar?.classList.toggle('open', open);
    this.menuButton?.setAttribute('aria-expanded', String(open));
    if (!open) this.closeAllSections();
  }

  /** Open exactly one section's dropdown, or none. */
  private openSection(host: HTMLElement | null): void {
    for (const other of this.menuHosts) {
      const open = other === host;
      other.classList.toggle('open', open);
      other.querySelector('.menu-trigger')?.setAttribute('aria-expanded', String(open));
    }
  }

  private closeAllSections(): void {
    this.openSection(null);
  }

  private bindMenuButton(button: HTMLButtonElement, panel: HTMLElement): void {
    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      this.setMenuOpen(!this.isMenuOpen());
    };
    button.addEventListener('click', onClick);
    this.eventDisposers.push(() => button.removeEventListener('click', onClick));

    // Click-away and Escape both close whatever is open, and Escape returns
    // focus to the control that opened it.
    const onDocumentClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.contains(target) || button.contains(target)) return;
      this.closeAllSections();
      this.setMenuOpen(false);
    };
    document.addEventListener('click', onDocumentClick);
    this.eventDisposers.push(() => document.removeEventListener('click', onDocumentClick));

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const hadSection = this.menuHosts.some((host) => host.classList.contains('open'));
      if (!hadSection && !this.isMenuOpen()) return;
      this.closeAllSections();
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
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
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
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.setAttribute('aria-hidden', 'true');
      applyIcon(glyph, a.icon);
      const label = document.createElement('span');
      label.className = 'menu-item-label';
      label.textContent = a.label;
      item.append(glyph, label);
      if (unavailable) {
        const badge = document.createElement('span');
        badge.className = 'soon-badge';
        badge.textContent = t('ui.domShell.unavailable', 'Unavailable');
        item.append(badge);
      } else if (shortcuts) {
        const hint = document.createElement('span');
        hint.className = 'shortcut';
        hint.setAttribute('aria-hidden', 'true');
        hint.textContent = shortcutHint(shortcuts);
        item.append(hint);
      }
      item.onclick = () => {
        this.closeAllSections();
        this.setMenuOpen(false);
        this.run(a, 'dom-menu');
      };
      this.bound.push({ el: item, action: a, surface: 'dom-menu' });
      dropdown.appendChild(item);
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      this.openSection(host.classList.contains('open') ? null : host);
    };
    // Once a menu is open, moving across the bar switches to that section —
    // the behaviour every desktop menu bar has, and the reason a menu bar is
    // faster to browse than a panel of columns.
    const onEnter = () => {
      if (this.menuHosts.some((other) => other.classList.contains('open'))) this.openSection(host);
    };
    trigger.addEventListener('mouseenter', onEnter);
    this.eventDisposers.push(() => trigger.removeEventListener('mouseenter', onEnter));

    const enabledItems = () =>
      [...dropdown.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((item) => !item.disabled);
    const onTriggerKeydown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openSection(host);
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
      const name = document.createElement('span');
      name.className = 'calibration-name';
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      applyIcon(glyph, a.icon);
      name.append(glyph, document.createTextNode(` ${a.label}`));
      btn.append(name);
      if (a.hint) {
        const hint = document.createElement('span');
        hint.className = 'calibration-hint';
        hint.textContent = a.hint;
        btn.append(hint);
      }
      btn.onclick = () => this.run(a, 'dom-menu');
      this.bound.push({ el: btn, action: a, surface: 'dom-menu' });
      host.appendChild(btn);
    }
  }

  // ---- Shared plumbing ----------------------------------------------------

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
    // The slice button is the one control that reports work in progress, the
    // same way upstream's does: it stays put and pulses rather than moving.
    this.sliceButton?.classList.toggle('busy', s.isSlicing);
  }
}
