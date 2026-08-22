/**
 * What this printer has already printed (P9.6).
 *
 * A history list is only useful if it answers the question someone arrived
 * with, so each row leads with the outcome — completed, cancelled, stopped by a
 * Klipper shutdown — and then the two numbers that make a run comparable: how
 * long it actually printed, and how far that was from the slicer's estimate.
 *
 * Everything absent stays absent. A job the printer never finished shows an em
 * dash where its duration would be, because "0 s" would state that the print
 * took no time rather than that the machine never said.
 */

import type { PrintHistoryJob, PrintHistoryPage, PrintHistoryTotals } from '../../printer/PrinterHistory';
import { t } from '../../l10n/t';
import {
  describeHistoryStatus,
  estimateDelta,
  formatFilamentLength,
  formatHistoryDuration,
  historyPageBounds,
} from '../../printer/PrinterHistory';

export interface PrintHistoryPanelPort {
  getPage(): PrintHistoryPage | undefined;
  getTotals(): PrintHistoryTotals | undefined;
  getStatus(): { readonly busy: boolean; readonly message?: string };
  subscribe(listener: () => void): () => void;
  /** Load one page; `start` is an offset into the printer's own ordering. */
  load(start: number): void | Promise<void>;
}

const STATUS_COLOR: Readonly<Record<string, string>> = Object.freeze({
  completed: 'var(--oxr-ok)',
  cancelled: 'var(--oxr-warn)',
  error: 'var(--oxr-danger)',
  klippy_shutdown: 'var(--oxr-danger)',
  klippy_disconnect: 'var(--oxr-danger)',
  in_progress: 'var(--oxr-accent)',
  interrupted: 'var(--oxr-warn)',
});

export class PrintHistoryPanel {
  private root?: HTMLElement;
  private totalsLine?: HTMLElement;
  private list?: HTMLElement;
  private pager?: HTMLElement;
  private status?: HTMLElement;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PrintHistoryPanelPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.printHistoryPanel = 'true';
    root.setAttribute('aria-label', t('ui.printHistoryPanel.printHistory', 'Print history'));
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const header = doc.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const totals = doc.createElement('div');
    totals.dataset.printHistoryTotals = 'true';
    totals.style.cssText = 'flex:1;font-size:12px;opacity:0.8;';
    header.appendChild(totals);
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.dataset.printHistoryRefresh = 'true';
    refresh.textContent = 'Refresh';
    refresh.style.cssText = 'margin:0;';
    refresh.addEventListener('click', () => void this.port.load(this.port.getPage()?.start ?? 0));
    header.appendChild(refresh);
    root.appendChild(header);

    const list = doc.createElement('ol');
    list.dataset.printHistoryList = 'true';
    list.style.cssText =
      'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:260px;overflow-y:auto;';
    root.appendChild(list);

    const pager = doc.createElement('div');
    pager.dataset.printHistoryPager = 'true';
    pager.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';
    root.appendChild(pager);

    const status = doc.createElement('p');
    status.dataset.printHistoryStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.totalsLine = totals;
    this.list = list;
    this.pager = pager;
    this.status = status;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const page = this.port.getPage();
    const state = this.port.getStatus();
    if (this.status) this.status.textContent = state.message ?? '';
    if (this.totalsLine) this.totalsLine.textContent = describeTotals(this.port.getTotals());

    const list = this.list;
    if (list) {
      list.textContent = '';
      const doc = list.ownerDocument;
      if (!page) {
        const empty = doc.createElement('p');
        empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
        empty.textContent = t(
          'ui.printHistoryPanel.refreshToReadWhatThis',
          'Refresh to read what this printer has printed.',
        );
        list.appendChild(empty);
      } else if (page.jobs.length === 0) {
        const empty = doc.createElement('p');
        empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
        empty.textContent = t('ui.printHistoryPanel.thisPrinterHasNoRecorded', 'This printer has no recorded jobs.');
        list.appendChild(empty);
      } else {
        for (const job of page.jobs) list.appendChild(this.buildRow(doc, job));
      }
    }

    const pager = this.pager;
    if (pager) {
      pager.textContent = '';
      if (!page) return;
      const doc = pager.ownerDocument;
      const bounds = historyPageBounds(page);
      const previous = doc.createElement('button');
      previous.type = 'button';
      previous.className = 'action-btn';
      previous.dataset.printHistoryPrevious = 'true';
      previous.textContent = 'Newer';
      previous.style.cssText = 'margin:0;';
      previous.disabled = state.busy || !bounds.hasPrevious;
      previous.addEventListener('click', () => void this.port.load(bounds.previousStart));
      const next = doc.createElement('button');
      next.type = 'button';
      next.className = 'action-btn';
      next.dataset.printHistoryNext = 'true';
      next.textContent = 'Older';
      next.style.cssText = 'margin:0;';
      next.disabled = state.busy || !bounds.hasNext;
      next.addEventListener('click', () => void this.port.load(bounds.nextStart));
      const label = doc.createElement('span');
      label.dataset.printHistoryPageLabel = 'true';
      label.style.cssText = 'flex:1;text-align:center;opacity:0.75;';
      label.textContent = `Page ${bounds.pageIndex + 1} of ${bounds.pageCount} — ${page.total} job${
        page.total === 1 ? '' : 's'
      }`;
      pager.append(previous, label, next);
    }
  }

  private buildRow(doc: Document, job: PrintHistoryJob): HTMLLIElement {
    const row = doc.createElement('li');
    row.dataset.printHistoryJob = job.id;
    row.style.cssText =
      'display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;background:var(--oxr-surface);';

    const head = doc.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
    const name = doc.createElement('span');
    name.textContent = job.filename;
    name.style.cssText = 'flex:1;font-size:12px;overflow-wrap:anywhere;';
    const outcome = doc.createElement('span');
    outcome.dataset.printHistoryStatusLabel = job.status;
    outcome.textContent = describeHistoryStatus(job);
    outcome.style.cssText = `font-size:11px;white-space:nowrap;color:${STATUS_COLOR[job.status] ?? 'var(--oxr-text-muted)'};`;
    head.append(name, outcome);
    row.appendChild(head);

    const facts = doc.createElement('span');
    facts.dataset.printHistoryFacts = 'true';
    facts.style.cssText = 'font-size:11px;opacity:0.75;';
    facts.textContent = describeJob(job);
    row.appendChild(facts);
    // The file is gone from the printer, so "print it again" is not on offer.
    if (!job.fileExists) {
      const missing = doc.createElement('span');
      missing.dataset.printHistoryMissing = 'true';
      missing.textContent = t('ui.printHistoryPanel.noLongerOnThePrinter', 'No longer on the printer');
      missing.style.cssText = 'font-size:11px;color:var(--oxr-warn);';
      row.appendChild(missing);
    }
    return row;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }
}

/** One line of facts per job; anything unreported is an em dash. */
export function describeJob(job: PrintHistoryJob): string {
  const missing = '—';
  const parts = [`Printed ${formatHistoryDuration(job.printSeconds) ?? missing}`];
  const delta = estimateDelta(job);
  if (delta !== undefined) {
    const rounded = Math.round(delta);
    parts.push(rounded === 0 ? 'exactly as estimated' : `${rounded > 0 ? '+' : ''}${rounded}% vs estimate`);
  }
  parts.push(`${formatFilamentLength(job.filamentUsedMm) ?? missing} filament`);
  if (job.startedAtMs !== undefined) parts.push(new Date(job.startedAtMs).toLocaleString());
  return parts.join(' · ');
}

export function describeTotals(totals: PrintHistoryTotals | undefined): string {
  if (!totals) return 'Totals not read yet';
  const parts: string[] = [];
  if (totals.jobs !== undefined) parts.push(`${totals.jobs} job${totals.jobs === 1 ? '' : 's'}`);
  const printed = formatHistoryDuration(totals.printSeconds);
  if (printed) parts.push(`${printed} printing`);
  const filament = formatFilamentLength(totals.filamentUsedMm);
  if (filament) parts.push(`${filament} filament`);
  const longest = formatHistoryDuration(totals.longestPrintSeconds);
  if (longest) parts.push(`longest ${longest}`);
  return parts.length > 0 ? parts.join(' · ') : 'The printer reported no totals';
}
