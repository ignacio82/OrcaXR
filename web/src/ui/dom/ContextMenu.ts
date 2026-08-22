/**
 * One context menu, for every surface that has a right-click (P11.2).
 *
 * P11.2 asks that every surface be generated from one action model with
 * platform-appropriate placement, and the context menu was the placement with
 * no implementation: the scene had none at all, and the Objects tree had a
 * hand-built two-entry menu of panel-local operations. Two menus that answer
 * the same right-click differently is exactly the reachability gap that section
 * exists to close.
 *
 * So this owns the *behaviour* of a context menu and nothing about which
 * actions exist. Callers hand it groups of items; the registry decides what
 * those are. What lives here is the part that is easy to get subtly wrong and
 * tedious to get right twice: clamping to the viewport, roving focus, Escape
 * returning focus where it came from, dismissal on an outside press, and the
 * rule that a disabled item still says why.
 */

import { GROUPS, type Action, type ActionRegistry, type ContextTarget } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';

/**
 * The catalog's own answer to "what can I do with this?" (P11.2).
 *
 * Grouped by the action's group in catalog order, so the same right-click gives
 * the same menu in the scene and in the Objects tree, and a disabled entry
 * carries the registry's own sentence rather than one written here. A hidden
 * action is omitted, because the registry hides an action when it does not
 * apply at all — not when it merely cannot run yet.
 */
export function contextMenuGroups(
  registry: ActionRegistry,
  target: ContextTarget,
  state: Readonly<UiStateShape>,
  invoke: (action: Action) => void,
): ContextMenuGroup[] {
  const byGroup = new Map<string, ContextMenuItem[]>();
  for (const action of registry.forContext(target, 'dom-context')) {
    const availability = registry.availability(action, 'dom-context', state);
    if (availability.state === 'hidden') continue;
    const items = byGroup.get(action.group) ?? [];
    items.push({
      id: action.id,
      label: action.label,
      ...(action.hint ? { hint: action.hint } : {}),
      ...(availability.state === 'disabled' ? { disabled: true, reason: availability.reason } : {}),
      onSelect: () => invoke(action),
    });
    byGroup.set(action.group, items);
  }
  return GROUPS.filter((group) => byGroup.has(group.id)).map((group) => ({
    label: group.label,
    items: byGroup.get(group.id) ?? [],
  }));
}

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Shown when disabled: an item that cannot be chosen still explains itself. */
  readonly reason?: string;
  readonly onSelect: () => void;
}

export interface ContextMenuGroup {
  readonly label: string;
  readonly items: readonly ContextMenuItem[];
}

export interface ContextMenuOpenRequest {
  readonly x: number;
  readonly y: number;
  readonly ariaLabel: string;
  readonly groups: readonly ContextMenuGroup[];
  /** Focused again on Escape or dismissal, so a keyboard never lands nowhere. */
  readonly returnFocus?: HTMLElement;
  /** Written to `data-context-target`, for tests and for styling by target. */
  readonly target?: string;
  /** What the menu acts on, written to `data-context-instance` for diagnostics. */
  readonly instance?: string | null;
}

const MENU_WIDTH = 232;

export class ContextMenu {
  private menu?: HTMLElement;
  private dismiss?: (event: Event) => void;
  private returnFocus?: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: { readonly datasetKey?: string } = {},
  ) {}

  isOpen(): boolean {
    return this.menu !== undefined;
  }

  open(request: ContextMenuOpenRequest): void {
    this.close();
    const groups = request.groups.filter((group) => group.items.length > 0);
    // An empty menu is not a menu. Opening one would swallow the right-click
    // and leave the operator with a blank rectangle to dismiss.
    if (groups.length === 0) return;

    const document = this.host.ownerDocument;
    const view = document.defaultView;
    const menu = document.createElement('div');
    menu.dataset[this.options.datasetKey ?? 'contextMenu'] = 'true';
    if (request.target) menu.dataset.contextTarget = request.target;
    if (request.instance) menu.dataset.contextInstance = request.instance;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', request.ariaLabel);
    const viewportWidth = view?.innerWidth ?? 1024;
    const viewportHeight = view?.innerHeight ?? 768;
    const x = Math.max(8, Math.min(request.x, viewportWidth - MENU_WIDTH - 8));
    const y = Math.max(8, Math.min(request.y, viewportHeight - 120));
    // direction:physical — `x` is a pointer's viewport coordinate, so the menu
    // opens where the click was in any writing direction; mirroring it to
    // `inset-inline-start` would put the menu on the far side of the screen
    // from the thing it was opened on.
    menu.style.cssText =
      `position:fixed;z-index:1000;left:${x}px;top:${y}px;width:${MENU_WIDTH}px;padding:5px;` +
      // A long menu scrolls inside itself rather than running off the bottom of
      // the window, which is where a fourteen-entry object menu would end up.
      `max-height:${Math.max(160, viewportHeight - y - 16)}px;overflow-y:auto;` +
      'display:flex;flex-direction:column;gap:2px;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:8px;background:var(--oxr-color-bg-card,var(--oxr-bg-elevated));box-shadow:0 8px 24px #0008;';

    for (const [index, group] of groups.entries()) {
      if (group.label) {
        const heading = document.createElement('p');
        heading.dataset.contextGroup = group.label;
        heading.setAttribute('aria-hidden', 'true');
        heading.textContent = group.label;
        heading.style.cssText =
          `margin:${index === 0 ? '2px' : '8px'} 0 2px;padding:0 8px;font-size:10px;letter-spacing:0.06em;` +
          'text-transform:uppercase;opacity:0.6;';
        menu.appendChild(heading);
      }
      for (const item of group.items) {
        menu.appendChild(this.buildItem(item, group.label));
      }
    }

    menu.addEventListener('keydown', (event) => this.onKeyDown(event as KeyboardEvent, menu));
    this.dismiss = (event: Event) => {
      if (!menu.contains(event.target as Node)) this.close();
    };
    document.addEventListener('pointerdown', this.dismiss, true);
    document.addEventListener('focusin', this.dismiss, true);
    this.host.appendChild(menu);
    this.menu = menu;
    this.returnFocus = request.returnFocus;
    this.items(menu)[0]?.focus();
  }

  close(): void {
    if (!this.menu) return;
    const document = this.host.ownerDocument;
    if (this.dismiss) {
      document.removeEventListener('pointerdown', this.dismiss, true);
      document.removeEventListener('focusin', this.dismiss, true);
    }
    this.dismiss = undefined;
    this.menu.remove();
    this.menu = undefined;
    this.returnFocus = undefined;
  }

  dispose(): void {
    this.close();
  }

  private buildItem(item: ContextMenuItem, groupLabel: string): HTMLElement {
    const document = this.host.ownerDocument;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.contextItem = item.id;
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    // Untrusted only in the sense that it is data: a label is inserted as text
    // so a catalog entry can never become markup.
    button.textContent = item.label;
    const explanation = item.disabled ? (item.reason ?? 'Unavailable here.') : (item.hint ?? '');
    if (explanation) {
      button.title = explanation;
      // The tooltip is not reachable without a pointer, so the same sentence is
      // the accessible name's description.
      button.setAttribute('aria-description', explanation);
    }
    button.setAttribute('aria-label', `${item.label}${groupLabel ? ` (${groupLabel})` : ''}`);
    if (item.disabled) button.setAttribute('aria-disabled', 'true');
    button.disabled = Boolean(item.disabled);
    button.style.cssText =
      'width:100%;min-height:36px;padding:6px 8px;text-align: start;border:0;border-radius:6px;' +
      `background:transparent;color:inherit;font:inherit;cursor:${item.disabled ? 'default' : 'pointer'};` +
      `opacity:${item.disabled ? '0.5' : '1'};`;
    button.addEventListener('pointerenter', () => {
      if (!item.disabled) button.style.background = 'var(--oxr-color-surface,var(--oxr-surface))';
    });
    button.addEventListener('pointerleave', () => {
      button.style.background = 'transparent';
    });
    button.addEventListener('click', () => {
      if (item.disabled) return;
      // Closed first: an action that opens a dialog or a file picker must not
      // find a menu still floating over it.
      const returnFocus = this.returnFocus;
      this.close();
      returnFocus?.focus({ preventScroll: true });
      item.onSelect();
    });
    return button;
  }

  private items(menu: HTMLElement): HTMLElement[] {
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  }

  private onKeyDown(event: KeyboardEvent, menu: HTMLElement): void {
    const items = this.items(menu);
    const index = Math.max(0, items.indexOf(menu.ownerDocument.activeElement as HTMLElement));
    if (event.key === 'Escape') {
      event.preventDefault();
      const returnFocus = this.returnFocus;
      this.close();
      returnFocus?.focus({ preventScroll: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    }
  }
}
