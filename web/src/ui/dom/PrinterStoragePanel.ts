/**
 * What is on the printer right now (P9.5).
 *
 * The panel exists to answer one question — "is the file I want already up
 * there?" — and then to let someone act on the answer without leaving for
 * Fluidd. It shows folders, files newest first, and for the selected file the
 * facts the printer itself scanned: size, estimated time, filament weight, and
 * the slicer's own thumbnail.
 *
 * Two things it deliberately does not do. It never renders a fact the printer
 * did not report — an unscanned file shows an em dash, not "0 min", because a
 * zero reads as a claim. And it never acts on a row's label: every operation
 * carries the exact path the last listing returned, so a delete cannot land on
 * a neighbouring file if the list changed under it.
 */

import type {
  PrinterDirectoryListing,
  PrinterFileMetadata,
  PrinterStorageOperation,
} from '../../printer/PrinterStorage';
import { formatStorageSize, parentStorageDirectory } from '../../printer/PrinterStorage';

export interface PrinterStoragePanelPort {
  /** Current listing, or undefined before the first browse. */
  getListing(): PrinterDirectoryListing | undefined;
  /** Metadata for the selected file, when it has been read. */
  getMetadata(): PrinterFileMetadata | undefined;
  /** Object URL for the selected file's largest thumbnail, when one exists. */
  getThumbnailUrl(): string | undefined;
  getSelectedPath(): string | undefined;
  getStatus(): { readonly busy: boolean; readonly message?: string };
  subscribe(listener: () => void): () => void;
  select(path: string | undefined): void;
  run(operation: PrinterStorageOperation): void | Promise<void>;
  /** Ask for a new name; the shell owns the prompt so this stays testable. */
  askName(current: string): Promise<string | undefined>;
  /** Confirm a destructive operation; resolves false when it is declined. */
  confirmDelete(path: string): Promise<boolean>;
}

const ROW_STYLE =
  'display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:6px;' +
  'background:transparent;border:1px solid transparent;color:inherit;text-align:left;cursor:pointer;';

export class PrinterStoragePanel {
  private root?: HTMLElement;
  private list?: HTMLElement;
  private breadcrumb?: HTMLElement;
  private detail?: HTMLElement;
  private status?: HTMLElement;
  private readonly buttons = new Map<PrinterStorageOperation['kind'], HTMLButtonElement>();
  private refreshButton?: HTMLButtonElement;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PrinterStoragePanelPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.printerStoragePanel = 'true';
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    root.setAttribute('aria-label', 'Files on the printer');

    const header = doc.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const breadcrumb = doc.createElement('div');
    breadcrumb.dataset.printerStorageBreadcrumb = 'true';
    breadcrumb.style.cssText = 'flex:1;font-size:12px;opacity:0.8;overflow-wrap:anywhere;';
    header.appendChild(breadcrumb);
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.dataset.printerStorageRefresh = 'true';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', () => {
      void this.port.run({ kind: 'browse', path: this.port.getListing()?.path ?? '' });
    });
    header.appendChild(refresh);
    root.appendChild(header);

    const list = doc.createElement('div');
    list.dataset.printerStorageList = 'true';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Printer files');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;';
    root.appendChild(list);

    const detail = doc.createElement('div');
    detail.dataset.printerStorageDetail = 'true';
    detail.style.cssText = 'display:flex;gap:10px;align-items:flex-start;font-size:12px;';
    root.appendChild(detail);

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const [kind, label] of [
      ['print', 'Print'],
      ['rename', 'Rename'],
      ['download', 'Download'],
      ['delete', 'Delete'],
    ] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'action-btn';
      button.dataset.printerStorageAction = kind;
      button.textContent = label;
      button.disabled = true;
      button.addEventListener('click', () => void this.runOnSelection(kind));
      this.buttons.set(kind, button);
      actions.appendChild(button);
    }
    root.appendChild(actions);

    const status = doc.createElement('p');
    status.dataset.printerStorageStatus = 'true';
    // Polite: a listing refresh should not interrupt someone reading a row.
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.list = list;
    this.breadcrumb = breadcrumb;
    this.detail = detail;
    this.status = status;
    this.refreshButton = refresh;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private async runOnSelection(kind: 'print' | 'rename' | 'download' | 'delete'): Promise<void> {
    const path = this.port.getSelectedPath();
    if (!path) return;
    if (kind === 'rename') {
      const current = path.split('/').pop() ?? path;
      const nextName = await this.port.askName(current);
      if (!nextName || nextName === current) return;
      await this.port.run({ kind: 'rename', path, nextName });
      return;
    }
    if (kind === 'delete') {
      // Deleting a file on the printer is not undoable from here, and the
      // machine may be the only place it exists.
      if (!(await this.port.confirmDelete(path))) return;
      await this.port.run({ kind: 'delete', path });
      return;
    }
    await this.port.run({ kind, path });
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const listing = this.port.getListing();
    const selected = this.port.getSelectedPath();
    const state = this.port.getStatus();

    if (this.breadcrumb) {
      this.breadcrumb.textContent = listing
        ? `gcodes${listing.path ? `/${listing.path}` : ''}${freeSpaceSuffix(listing)}`
        : 'Not browsed yet';
    }
    if (this.refreshButton) this.refreshButton.disabled = state.busy;
    if (this.status) this.status.textContent = state.message ?? '';

    if (this.list) {
      this.list.textContent = '';
      const doc = this.list.ownerDocument;
      if (!listing) {
        const empty = doc.createElement('p');
        empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
        empty.textContent = 'Connect to a printer and refresh to see the files it holds.';
        this.list.appendChild(empty);
      } else {
        const parent = parentStorageDirectory(listing.path);
        if (parent !== undefined) {
          this.list.appendChild(
            this.buildRow(
              doc,
              '⬆',
              'Up one folder',
              undefined,
              () => void this.port.run({ kind: 'browse', path: parent }),
            ),
          );
        }
        for (const directory of listing.directories) {
          this.list.appendChild(
            this.buildRow(
              doc,
              '🗀',
              directory.name,
              undefined,
              () => void this.port.run({ kind: 'browse', path: directory.path }),
            ),
          );
        }
        for (const file of listing.files) {
          const row = this.buildRow(doc, '🗎', file.name, formatStorageSize(file.sizeBytes), () =>
            this.port.select(file.path),
          );
          row.dataset.printerStorageFile = file.path;
          row.setAttribute('aria-selected', String(file.path === selected));
          if (file.path === selected) {
            row.style.background = '#ffffff1a';
            row.style.borderColor = '#ffb74d66';
          }
          this.list.appendChild(row);
        }
        if (listing.directories.length === 0 && listing.files.length === 0) {
          const empty = doc.createElement('p');
          empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
          empty.textContent = 'This folder is empty.';
          this.list.appendChild(empty);
        }
      }
    }

    this.renderDetail();
    for (const [kind, button] of this.buttons) {
      button.disabled = state.busy || !selected;
      button.title = selected ? `${button.textContent} ${selected}` : 'Select a file on the printer first.';
      if (kind === 'delete') button.style.borderColor = selected ? '#ff8a8066' : '';
    }
  }

  private renderDetail(): void {
    const detail = this.detail;
    if (!detail) return;
    detail.textContent = '';
    const selected = this.port.getSelectedPath();
    if (!selected) return;
    const doc = detail.ownerDocument;
    const thumbnail = this.port.getThumbnailUrl();
    if (thumbnail) {
      const image = doc.createElement('img');
      image.dataset.printerStorageThumbnail = 'true';
      image.src = thumbnail;
      image.alt = `Preview of ${selected}`;
      image.style.cssText = 'width:72px;height:72px;object-fit:contain;background:#0006;border-radius:6px;';
      detail.appendChild(image);
    }
    const facts = doc.createElement('dl');
    facts.dataset.printerStorageFacts = 'true';
    facts.style.cssText = 'margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;';
    const metadata = this.port.getMetadata();
    for (const [label, value] of describeMetadata(selected, metadata)) {
      const term = doc.createElement('dt');
      term.textContent = label;
      term.style.cssText = 'opacity:0.7;';
      const definition = doc.createElement('dd');
      definition.textContent = value;
      definition.style.cssText = 'margin:0;';
      facts.append(term, definition);
    }
    detail.appendChild(facts);
  }

  private buildRow(
    doc: Document,
    glyph: string,
    label: string,
    trailing: string | undefined,
    onActivate: () => void,
  ): HTMLButtonElement {
    const row = doc.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.style.cssText = ROW_STYLE;
    row.addEventListener('click', onActivate);
    const icon = doc.createElement('span');
    icon.textContent = glyph;
    icon.setAttribute('aria-hidden', 'true');
    const text = doc.createElement('span');
    text.textContent = label;
    text.style.cssText = 'flex:1;overflow-wrap:anywhere;';
    row.append(icon, text);
    if (trailing) {
      const size = doc.createElement('span');
      size.textContent = trailing;
      size.style.cssText = 'opacity:0.65;font-size:11px;white-space:nowrap;';
      row.appendChild(size);
    }
    return row;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.buttons.clear();
    this.root?.remove();
    this.root = undefined;
  }
}

/** The rows of the detail list; an unreported fact reads as an em dash. */
export function describeMetadata(
  path: string,
  metadata: PrinterFileMetadata | undefined,
): readonly (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [['File', path]];
  const missing = '—';
  rows.push(['Size', formatStorageSize(metadata?.sizeBytes) ?? missing]);
  rows.push(['Estimated', formatStorageDuration(metadata?.estimatedSeconds) ?? missing]);
  rows.push([
    'Filament',
    metadata?.filamentWeightG === undefined ? missing : `${metadata.filamentWeightG.toFixed(1)} g`,
  ]);
  rows.push(['Sliced by', metadata?.slicer ?? missing]);
  return rows;
}

/** `1 h 12 min`; an unreported estimate stays undefined rather than "0 min". */
export function formatStorageDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

function freeSpaceSuffix(listing: PrinterDirectoryListing): string {
  const free = formatStorageSize(listing.freeBytes);
  return free ? ` — ${free} free` : '';
}
