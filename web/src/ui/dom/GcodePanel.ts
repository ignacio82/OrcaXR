/**
 * The G-code window (P11.2).
 *
 * Shows a sliced program the way an operator needs to read one before printing
 * it: numbered lines, a search that says how many matched, and a jump to each
 * match.
 *
 * Only the visible rows exist in the DOM. A program is tens of thousands of
 * lines and a real plate reaches hundreds of thousands, so a spacer carries the
 * full scroll height and a window of rows is rendered into it as the operator
 * scrolls. Rendering the whole document instead is the obvious implementation
 * and it locks the tab for seconds on the first file anyone opens.
 *
 * Nothing here truncates. A viewer that quietly showed the first thousand lines
 * would have someone inspect a program that is not the one they will print,
 * which is the failure this whole window exists to prevent.
 */

import type { GcodeDocument } from '../../project/gcode/GcodeDocument';
import { t } from '../../l10n/t';

/** Row height in pixels; the spacer and the window both derive from it. */
const ROW_HEIGHT = 18;
/** Rows kept above and below the viewport so scrolling does not flicker. */
const OVERSCAN = 20;

export interface GcodePanelState {
  /** The program to read, or null when nothing has been sliced. */
  readonly document: GcodeDocument | null;
  /** Shown above the listing; the file this came from. */
  readonly title?: string;
}

export interface GcodePanelAdapter {
  getState(): GcodePanelState;
  subscribe?(listener: () => void): () => void;
  onError?(error: unknown): void;
}

let panelSequence = 0;

export class GcodePanel {
  private readonly instanceId = (panelSequence += 1);
  private unsubscribe: (() => void) | null = null;
  private query = '';
  private matches: readonly number[] = [];
  private truncated = false;
  private matchIndex = 0;
  private scroller: HTMLElement | null = null;
  private rows: HTMLElement | null = null;
  private spacer: HTMLElement | null = null;
  private status: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: GcodePanelAdapter,
  ) {}

  mount(): void {
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh()) ?? null;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.replaceChildren();
  }

  refresh(): void {
    const state = this.adapter.getState();
    const doc = this.container.ownerDocument;
    this.container.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-height:0;';

    if (!state.document) {
      const empty = doc.createElement('p');
      empty.dataset.gcodeEmpty = 'true';
      empty.setAttribute('role', 'status');
      empty.style.cssText = 'margin:0;opacity:0.75;';
      empty.textContent = t('ui.gcodePanel.sliceAProjectToRead', 'Slice a project to read its G-code here.');
      this.container.replaceChildren(empty);
      return;
    }

    const heading = doc.createElement('h3');
    heading.textContent = state.title ?? 'G-code';
    heading.style.cssText = 'margin:0;font-size:0.95rem;';

    const searchId = `orcaxr-gcode-search-${this.instanceId}`;
    const search = doc.createElement('input');
    search.type = 'search';
    search.id = searchId;
    search.dataset.gcodeSearch = 'true';
    search.value = this.query;
    search.placeholder = t('ui.gcodePanel.findACommand', 'Find a command');
    search.style.cssText =
      'flex:1 1 160px;padding:6px;border-radius:6px;border:1px solid var(--oxr-stroke);' +
      'background:var(--oxr-color-surface);color:inherit;font:inherit;';
    search.addEventListener('input', () => this.runSearch(search.value, state.document!));

    const label = doc.createElement('label');
    label.htmlFor = searchId;
    label.textContent = 'Find';
    label.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:0.75;';
    label.appendChild(search);

    const next = doc.createElement('button');
    next.type = 'button';
    next.dataset.gcodeAction = 'next-match';
    next.textContent = t('ui.gcodePanel.nextMatch', 'Next match');
    next.style.cssText =
      'min-height:32px;padding:4px 10px;border-radius:6px;border:1px solid currentColor;' +
      'background:transparent;color:inherit;cursor:pointer;';
    next.disabled = this.matches.length === 0;
    next.addEventListener('click', () => this.jumpToNextMatch());

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
    controls.append(label, next);

    this.status = doc.createElement('p');
    this.status.dataset.gcodeStatus = 'true';
    this.status.setAttribute('role', 'status');
    this.status.style.cssText = 'margin:0;opacity:0.75;font-size:0.85rem;';

    this.rows = doc.createElement('div');
    this.rows.dataset.gcodeRows = 'true';
    this.rows.style.cssText =
      'position:absolute;inset-inline:0;top:0;font-family:ui-monospace,monospace;font-size:12px;';

    this.spacer = doc.createElement('div');
    this.spacer.style.cssText = `position:relative;height:${state.document.lineCount * ROW_HEIGHT}px;`;
    this.spacer.appendChild(this.rows);

    this.scroller = doc.createElement('div');
    this.scroller.dataset.gcodeScroller = 'true';
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'region');
    this.scroller.setAttribute('aria-label', t('ui.gcodePanel.gCodeListing', 'G-code listing'));
    this.scroller.style.cssText =
      'overflow:auto;max-height:340px;min-height:120px;border-radius:6px;' +
      'border:1px solid var(--oxr-stroke);background:var(--oxr-color-surface);';
    this.scroller.appendChild(this.spacer);
    this.scroller.addEventListener('scroll', () => this.renderWindow(state.document!));

    this.container.replaceChildren(heading, controls, this.status, this.scroller);
    this.renderWindow(state.document);
    this.writeStatus(state.document);
  }

  private runSearch(query: string, document: GcodeDocument): void {
    this.query = query;
    const result = document.search(query);
    this.matches = result.lineNumbers;
    this.truncated = result.truncated;
    this.matchIndex = 0;
    this.writeStatus(document);
    this.renderWindow(document);
  }

  private jumpToNextMatch(): void {
    if (this.matches.length === 0 || !this.scroller) return;
    const line = this.matches[this.matchIndex % this.matches.length];
    this.matchIndex += 1;
    // Placed a little above the top edge so the match has context around it
    // rather than sitting against the frame.
    this.scroller.scrollTop = Math.max(0, (line - 3) * ROW_HEIGHT);
  }

  private writeStatus(document: GcodeDocument): void {
    if (!this.status) return;
    const size = `${document.lineCount.toLocaleString()} lines`;
    if (this.query.trim().length === 0) {
      this.status.textContent = size;
      return;
    }
    // "at least" when the search stopped early: a bare count would be read as
    // the total, and an operator would stop looking.
    const count = this.truncated
      ? `at least ${this.matches.length} lines match`
      : `${this.matches.length} line${this.matches.length === 1 ? '' : 's'} match`;
    this.status.textContent = `${size} · ${count} “${this.query.trim()}”`;
  }

  /** Render only what is on screen, positioned at its true offset. */
  private renderWindow(document: GcodeDocument): void {
    if (!this.scroller || !this.rows) return;
    const first = Math.max(1, Math.floor(this.scroller.scrollTop / ROW_HEIGHT) + 1 - OVERSCAN);
    const visible = Math.ceil(this.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const lines = document.window(first, Math.max(visible, 1));
    const matches = new Set(this.matches);
    const owner = this.container.ownerDocument;

    const fragment = owner.createDocumentFragment();
    for (const line of lines) {
      const row = owner.createElement('div');
      row.dataset.gcodeLine = `${line.number}`;
      row.style.cssText = `display:flex;gap:10px;height:${ROW_HEIGHT}px;line-height:${ROW_HEIGHT}px;white-space:pre;`;
      if (matches.has(line.number)) row.style.cssText += 'background:var(--oxr-color-accent-soft,#ffc10733);';
      const number = owner.createElement('span');
      number.style.cssText = 'opacity:0.5;min-width:5ch;text-align: end;user-select:none;';
      number.textContent = `${line.number}`;
      const text = owner.createElement('span');
      // Inserted as text, never as markup: a program is untrusted input and may
      // carry anything in a comment.
      text.textContent = line.text;
      row.append(number, text);
      fragment.appendChild(row);
    }
    // The window is positioned at its true offset inside the full-height
    // spacer, so the scrollbar reflects the whole program rather than the
    // handful of rows that happen to exist.
    const offset = ((lines[0]?.number ?? 1) - 1) * ROW_HEIGHT;
    this.rows.style.transform = `translateY(${offset}px)`;
    this.rows.replaceChildren(fragment);
  }
}
