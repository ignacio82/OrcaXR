/**
 * CommandPalette — a searchable overlay listing EVERY registry action by name.
 *
 * This is the "no missing button" completeness guarantee: whatever the visible
 * chrome shows, any capability is one Ctrl/⌘-K away. It renders straight from
 * the {@link ActionRegistry}, so new actions appear here for free.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import type { ActionContext } from '../../actions/ActionContext';
import type { UiState } from '../../actions/UiState';
import { domIcon } from '../icons';

export class CommandPalette {
  private overlay!: HTMLElement;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private matches: Action[] = [];
  private sel = 0;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly ui: UiState,
  ) {}

  mount(overlay: HTMLElement, input: HTMLInputElement, list: HTMLElement, trigger?: HTMLElement): void {
    this.overlay = overlay;
    this.input = input;
    this.list = list;

    trigger?.addEventListener('click', () => this.open());

    // Global Ctrl/⌘-K toggles the palette from anywhere.
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (this.isOpen()) this.close();
        else this.open();
      } else if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });

    // Clicking the dimmed backdrop (outside the box) closes.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
  }

  isOpen(): boolean {
    return this.overlay.classList.contains('open');
  }

  open(): void {
    this.overlay.classList.add('open');
    this.input.value = '';
    this.sel = 0;
    this.render();
    this.input.focus();
  }

  close(): void {
    this.overlay.classList.remove('open');
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.sel = Math.min(this.sel + 1, this.matches.length - 1);
      this.paint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel = Math.max(this.sel - 1, 0);
      this.paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runSelected();
    }
  }

  private render(): void {
    const q = this.input.value.trim().toLowerCase();
    const state = this.ui.get();
    this.matches = this.registry
      .forSurface('command-palette')
      .filter((a) => this.registry.availability(a, 'command-palette', state).state !== 'hidden')
      .filter((a) => {
        if (!q) return true;
        return (
          a.label.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.hint ?? '').toLowerCase().includes(q)
        );
      });
    this.sel = 0;
    this.paint();
  }

  private paint(): void {
    const state = this.ui.get();
    this.list.innerHTML = '';
    if (this.matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = 'No matching actions';
      this.list.appendChild(empty);
      return;
    }
    this.matches.forEach((a, i) => {
      const availability = this.registry.availability(a, 'command-palette', state);
      const enabled = availability.state === 'enabled';
      const row = document.createElement('div');
      row.className = `cmd-item${i === this.sel ? ' sel' : ''}${enabled ? '' : ' disabled'}`;
      row.dataset.actionId = a.id;
      const unavailable = a.capability.status === 'unavailable' || a.capability.status === 'blocked';
      const hint = availability.state === 'disabled' ? availability.reason : a.hint;
      row.innerHTML =
        `<span class="glyph">${domIcon(a.icon)}</span>` +
        `<span class="cmd-label">${escapeHtml(a.label)}</span>` +
        (unavailable ? '<span class="soon-badge">UNAVAILABLE</span>' : '') +
        (hint ? `<span class="cmd-hint">${escapeHtml(hint)}</span>` : '');
      row.addEventListener('mouseenter', () => {
        this.sel = i;
        this.paint();
      });
      row.addEventListener('click', () => {
        this.sel = i;
        this.runSelected();
      });
      this.list.appendChild(row);
    });
  }

  private runSelected(): void {
    const a = this.matches[this.sel];
    if (!a) return;
    const availability = this.registry.availability(a, 'command-palette', this.ui.get());
    if (availability.state === 'enabled') this.close();
    void this.registry
      .invoke(a, 'command-palette', this.ctx, this.ui.get())
      .catch((e) => console.error(`[orcaxr] action "${a.id}" failed:`, e));
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
