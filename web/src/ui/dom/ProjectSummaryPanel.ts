/**
 * ProjectSummaryPanel — what the Project page says about the project itself.
 *
 * Upstream's Project tab leads with the project rather than with the plates in
 * it: what is on the bed, whether there is unsaved work, and what was open
 * before. This is that card. It reads canonical state and the recent-projects
 * store and renders nothing it was not given — a recent entry with no
 * thumbnail gets no thumbnail, not a placeholder pretending to be one.
 *
 * It invokes nothing itself: opening and saving are registry actions, handed in
 * as callbacks by the composition root, so the Project page cannot become a
 * second file-handling path.
 */
import type { RecentProjectEntry } from '../../project/persistence/recentProjects';
import { t } from '../../l10n/t';

export interface ProjectSummarySnapshot {
  /** Instances on the active plate. */
  readonly modelCount: number;
  readonly plateCount: number;
  /** Canonical unsaved-change flag, not a guess from the edit count. */
  readonly dirty: boolean;
  readonly recent: readonly RecentProjectEntry[];
}

export interface ProjectSummaryPort {
  read(): ProjectSummarySnapshot;
  subscribe(listener: () => void): () => void;
  /** Registry-routed. */
  openProject(): void;
  /** Registry-routed. */
  saveProject(): void;
}

const MAX_RECENT_ROWS = 6;

export class ProjectSummaryPanel {
  private root?: HTMLElement;
  private facts?: HTMLElement;
  private recentList?: HTMLElement;
  private unsubscribe?: () => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: ProjectSummaryPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;

    const root = doc.createElement('div');
    root.dataset.projectSummaryPanel = 'true';
    root.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const heading = doc.createElement('h2');
    heading.textContent = t('ui.projectSummaryPanel.project', 'Project');
    heading.style.cssText = 'margin:0;font-size:14px;font-weight:700;';
    root.appendChild(heading);

    const facts = doc.createElement('dl');
    facts.dataset.projectSummaryFacts = 'true';
    facts.style.cssText =
      'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:12.5px;align-items:baseline;';
    root.appendChild(facts);

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'action-btn';
    open.dataset.projectSummaryOpen = 'true';
    open.style.cssText = 'width:auto;';
    open.textContent = t('ui.projectSummaryPanel.openProject', 'Open project…');
    open.addEventListener('click', () => this.port.openProject());
    const save = doc.createElement('button');
    save.type = 'button';
    save.className = 'action-btn';
    save.dataset.projectSummarySave = 'true';
    save.style.cssText = 'width:auto;';
    save.textContent = t('ui.projectSummaryPanel.saveProject', 'Save project');
    save.addEventListener('click', () => this.port.saveProject());
    actions.append(open, save);
    root.appendChild(actions);

    const recentHeading = doc.createElement('h3');
    recentHeading.className = 'insp-kicker';
    recentHeading.textContent = t('ui.projectSummaryPanel.recentProjects', 'Recent projects');
    recentHeading.style.cssText = 'margin:6px 0 0;';
    root.appendChild(recentHeading);

    const recentList = doc.createElement('ul');
    recentList.dataset.projectSummaryRecent = 'true';
    recentList.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;';
    root.appendChild(recentList);

    this.container.replaceChildren(root);
    this.root = root;
    this.facts = facts;
    this.recentList = recentList;

    this.unsubscribe = this.port.subscribe(() => this.refresh());
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }

  private refresh(): void {
    if (!this.facts || !this.recentList) return;
    const snapshot = this.port.read();
    const doc = this.facts.ownerDocument;

    const rows: readonly (readonly [string, string])[] = [
      [t('ui.projectSummaryPanel.onThisPlate', 'On this plate'), String(snapshot.modelCount)],
      [t('ui.projectSummaryPanel.plates', 'Plates'), String(snapshot.plateCount)],
      [
        t('ui.projectSummaryPanel.unsavedChanges', 'Unsaved changes'),
        snapshot.dirty ? t('ui.projectSummaryPanel.yes', 'Yes') : t('ui.projectSummaryPanel.no', 'No'),
      ],
    ];
    this.facts.replaceChildren();
    for (const [term, value] of rows) {
      const dt = doc.createElement('dt');
      dt.textContent = term;
      dt.style.cssText = 'color:var(--oxr-text-muted);';
      const dd = doc.createElement('dd');
      dd.textContent = value;
      dd.style.cssText = 'margin:0;font-weight:600;';
      this.facts.append(dt, dd);
    }

    this.recentList.replaceChildren();
    const recent = snapshot.recent.slice(0, MAX_RECENT_ROWS);
    if (recent.length === 0) {
      const empty = doc.createElement('li');
      empty.textContent = t('ui.projectSummaryPanel.nothingOpenedOnThisDevice', 'Nothing opened on this device yet.');
      empty.style.cssText = 'color:var(--oxr-text-muted);font-size:12px;';
      this.recentList.appendChild(empty);
      return;
    }
    for (const entry of recent) {
      const item = doc.createElement('li');
      item.dataset.recentProjectId = entry.id;
      item.style.cssText =
        'display:flex;align-items:center;gap:9px;padding:6px;border:1px solid var(--oxr-stroke);' +
        'border-radius:var(--radius-md);background:var(--oxr-bg-sunken);';
      if (entry.thumbnailDataUrl) {
        const thumb = doc.createElement('img');
        thumb.src = entry.thumbnailDataUrl;
        thumb.alt = '';
        thumb.style.cssText =
          'width:34px;height:34px;flex:0 0 34px;object-fit:cover;border-radius:var(--radius-sm);' +
          'border:1px solid var(--oxr-stroke);';
        item.appendChild(thumb);
      }
      const text = doc.createElement('div');
      text.style.cssText = 'display:flex;flex-direction:column;min-width:0;';
      const name = doc.createElement('span');
      name.textContent = entry.name;
      name.style.cssText =
        'font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const meta = doc.createElement('span');
      meta.textContent = describeEntry(entry);
      meta.style.cssText = 'font-size:11px;color:var(--oxr-text-muted);';
      text.append(name, meta);
      item.appendChild(text);
      this.recentList.appendChild(item);
    }
  }
}

/**
 * The facts an entry actually carries, and only those: counts are optional in
 * the store, so an entry that never recorded them says nothing about them
 * rather than reporting zero.
 */
function describeEntry(entry: RecentProjectEntry): string {
  const parts: string[] = [];
  const opened = new Date(entry.openedAt);
  if (!Number.isNaN(opened.getTime())) parts.push(opened.toLocaleString());
  // One message per count, with the plural rule inside it: a `count === 1`
  // branch here would be wrong in every language whose plurals are not English's.
  if (entry.modelCount !== undefined) {
    parts.push(
      t('ui.projectSummaryPanel.modelCount', '{count, plural, one {# model} other {# models}}', {
        count: entry.modelCount,
      }),
    );
  }
  if (entry.plateCount !== undefined) {
    parts.push(
      t('ui.projectSummaryPanel.plateCount', '{count, plural, one {# plate} other {# plates}}', {
        count: entry.plateCount,
      }),
    );
  }
  return parts.join(' · ');
}
