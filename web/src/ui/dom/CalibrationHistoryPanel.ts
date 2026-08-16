/**
 * What this machine has been calibrated for (parity P8.5).
 *
 * Each row leads with the number that was chosen, because that is what someone
 * arrived for, and then with the one thing that decides whether it is usable:
 * the printer, nozzle, and material it was measured on. A record whose
 * conditions no longer hold is shown greyed with the exact mismatch named —
 * never hidden, and never quietly offered as if it applied.
 *
 * Nothing here writes a value into a preset. Applying a result is P8.3's
 * "save to preset" work; this surface's job is to say truthfully whether a
 * past result *could* apply, and to let two runs be compared when it does not.
 */

import type {
  CalibrationApplicability,
  CalibrationComparison,
  CalibrationHistoryIssue,
  CalibrationHistoryOperation,
  CalibrationRecord,
} from '../../project/calibration/history';

export interface CalibrationHistoryMethodOption {
  readonly id: string;
  readonly label: string;
  readonly resultFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly unit: string | null;
    readonly required: boolean;
  }[];
}

export interface CalibrationHistoryPanelPort {
  getRecords(): readonly CalibrationRecord[];
  /** Methods a result may be recorded against, in catalog order. */
  getMethods(): readonly CalibrationHistoryMethodOption[];
  /** Now, so a recorded timestamp is the shell's clock rather than a guess. */
  now(): string;
  /** Whether each record still applies to what is loaded right now. */
  assess(record: CalibrationRecord): CalibrationApplicability;
  getComparison(): CalibrationComparison | undefined;
  getIssues(): readonly CalibrationHistoryIssue[];
  getStatus(): { readonly busy: boolean; readonly message?: string };
  subscribe(listener: () => void): () => void;
  run(operation: CalibrationHistoryOperation): void | Promise<void>;
  confirmDelete(record: CalibrationRecord): Promise<boolean>;
}

export class CalibrationHistoryPanel {
  private root?: HTMLElement;
  private list?: HTMLElement;
  private comparison?: HTMLElement;
  private issueList?: HTMLElement;
  private status?: HTMLElement;
  private entry?: HTMLElement;
  private unsubscribe?: () => void;
  private disposed = false;
  private selected: string[] = [];
  private draftMethod = '';
  private draftOperator = '';
  private draftValues = new Map<string, string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly port: CalibrationHistoryPanelPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.calibrationHistoryPanel = 'true';
    root.setAttribute('aria-label', 'Calibration history');
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const header = doc.createElement('div');
    header.style.cssText = 'display:flex;gap:6px;';
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.dataset.calibrationHistoryRefresh = 'true';
    refresh.textContent = 'Refresh';
    refresh.style.cssText = 'margin:0;flex:1;';
    refresh.addEventListener('click', () => void this.port.run({ kind: 'refresh' }));
    const exportButton = doc.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'action-btn';
    exportButton.dataset.calibrationHistoryExport = 'true';
    exportButton.textContent = 'Export';
    exportButton.style.cssText = 'margin:0;flex:1;';
    exportButton.addEventListener('click', () => void this.port.run({ kind: 'export' }));
    header.append(refresh, exportButton);
    root.appendChild(header);

    const list = doc.createElement('ol');
    list.dataset.calibrationHistoryList = 'true';
    list.style.cssText =
      'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;';
    root.appendChild(list);

    const entry = doc.createElement('div');
    entry.dataset.calibrationHistoryEntry = 'true';
    entry.style.cssText =
      'display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;background:#ffffff0d;';
    root.appendChild(entry);

    const comparison = doc.createElement('div');
    comparison.dataset.calibrationHistoryComparison = 'true';
    comparison.style.cssText = 'display:none;flex-direction:column;gap:2px;font-size:11px;';
    root.appendChild(comparison);

    const issues = doc.createElement('ul');
    issues.dataset.calibrationHistoryIssues = 'true';
    issues.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;';
    root.appendChild(issues);

    const status = doc.createElement('p');
    status.dataset.calibrationHistoryStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.list = list;
    this.entry = entry;
    this.comparison = comparison;
    this.issueList = issues;
    this.status = status;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const state = this.port.getStatus();
    if (this.status) this.status.textContent = state.message ?? '';
    this.renderList(state.busy);
    this.renderEntry(state.busy);
    this.renderComparison();
    this.renderIssues();
  }

  private renderList(busy: boolean): void {
    const host = this.list;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    const records = this.port.getRecords();
    // Drop selections that no longer exist, so a delete cannot leave a compare
    // pointing at a record that is gone.
    this.selected = this.selected.filter((id) => records.some((record) => record.id === id));
    if (records.length === 0) {
      const empty = doc.createElement('p');
      empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
      empty.textContent = 'No calibration results recorded on this device yet.';
      host.appendChild(empty);
      return;
    }
    for (const record of records) host.appendChild(this.buildRow(doc, record, busy));
  }

  private buildRow(doc: Document, record: CalibrationRecord, busy: boolean): HTMLLIElement {
    const applicability = this.port.assess(record);
    const row = doc.createElement('li');
    row.dataset.calibrationHistoryRecord = record.id;
    row.dataset.calibrationHistoryApplicable = applicability.applicable ? 'true' : 'false';
    row.style.cssText =
      'display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;background:#ffffff0d;' +
      (applicability.applicable ? '' : 'opacity:0.72;');

    const head = doc.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
    const select = doc.createElement('input');
    select.type = 'checkbox';
    select.dataset.calibrationHistorySelect = record.id;
    select.checked = this.selected.includes(record.id);
    select.setAttribute('aria-label', `Compare ${record.method.label}`);
    select.addEventListener('change', () => {
      this.selected = select.checked
        ? [...this.selected.filter((id) => id !== record.id), record.id].slice(-2)
        : this.selected.filter((id) => id !== record.id);
      if (this.selected.length === 2) {
        void this.port.run({ kind: 'compare', leftId: this.selected[0], rightId: this.selected[1] });
      }
      this.render();
    });
    const title = doc.createElement('span');
    title.style.cssText = 'flex:1;font-size:12px;overflow-wrap:anywhere;';
    title.textContent = record.method.label;
    const chosen = doc.createElement('span');
    chosen.dataset.calibrationHistoryChosen = 'true';
    chosen.style.cssText = 'font-size:12px;font-weight:650;white-space:nowrap;';
    chosen.textContent = describeChosen(record);
    head.append(select, title, chosen);
    row.appendChild(head);

    const facts = doc.createElement('span');
    facts.dataset.calibrationHistoryConditions = 'true';
    facts.style.cssText = 'font-size:11px;opacity:0.75;overflow-wrap:anywhere;';
    facts.textContent = describeConditions(record);
    row.appendChild(facts);

    if (!applicability.applicable) {
      const reason = doc.createElement('span');
      reason.dataset.calibrationHistoryMismatch = 'true';
      reason.style.cssText = 'font-size:11px;color:#ffb74d;overflow-wrap:anywhere;';
      reason.textContent =
        applicability.issues.find((issue) => issue.severity === 'error')?.message ??
        'This run produced no chosen result.';
      row.appendChild(reason);
    }

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
    const rerun = doc.createElement('button');
    rerun.type = 'button';
    rerun.className = 'action-btn';
    rerun.dataset.calibrationHistoryRerun = record.id;
    rerun.textContent = 'Re-run';
    rerun.style.cssText = 'margin:0;padding:3px 8px;font-size:11px;';
    rerun.disabled = busy;
    rerun.addEventListener('click', () => void this.port.run({ kind: 'rerun', recordId: record.id }));
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'action-btn';
    remove.dataset.calibrationHistoryDelete = record.id;
    remove.textContent = 'Delete';
    remove.style.cssText = 'margin:0;padding:3px 8px;font-size:11px;';
    remove.disabled = busy;
    remove.addEventListener('click', () => {
      void (async () => {
        if (!(await this.port.confirmDelete(record))) return;
        await this.port.run({ kind: 'delete', recordId: record.id });
      })();
    });
    controls.append(rerun, remove);
    row.appendChild(controls);
    return row;
  }

  /**
   * Entering a measurement. The fields come from the method itself, so a method
   * that reports two numbers asks for two, and a required one is marked as
   * required rather than silently defaulted.
   */
  private renderEntry(busy: boolean): void {
    const host = this.entry;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    const methods = this.port.getMethods();
    if (methods.length === 0) return;
    if (!methods.some((method) => method.id === this.draftMethod)) this.draftMethod = methods[0].id;
    const method = methods.find((candidate) => candidate.id === this.draftMethod)!;

    const select = doc.createElement('select');
    select.dataset.calibrationHistoryEntryMethod = 'true';
    select.style.cssText = FIELD_STYLE;
    for (const option of methods) {
      const item = doc.createElement('option');
      item.value = option.id;
      item.textContent = option.label;
      item.selected = option.id === this.draftMethod;
      select.appendChild(item);
    }
    select.addEventListener('change', () => {
      this.draftMethod = select.value;
      this.draftValues.clear();
      this.render();
    });
    host.appendChild(labelled(doc, 'Record a result for', select));

    for (const field of method.resultFields) {
      const input = doc.createElement('input');
      input.type = 'text';
      input.dataset.calibrationHistoryEntryValue = field.key;
      input.value = this.draftValues.get(field.key) ?? '';
      input.placeholder = field.required ? 'required' : 'optional';
      input.style.cssText = FIELD_STYLE;
      input.addEventListener('input', () => this.draftValues.set(field.key, input.value));
      host.appendChild(labelled(doc, field.unit ? `${field.label} (${field.unit})` : field.label, input));
    }

    const operator = doc.createElement('input');
    operator.type = 'text';
    operator.dataset.calibrationHistoryEntryOperator = 'true';
    operator.value = this.draftOperator;
    operator.placeholder = 'who measured it';
    operator.style.cssText = FIELD_STYLE;
    operator.addEventListener('input', () => {
      this.draftOperator = operator.value;
    });
    host.appendChild(labelled(doc, 'Measured by', operator));

    const submit = doc.createElement('button');
    submit.type = 'button';
    submit.className = 'action-btn';
    submit.dataset.calibrationHistorySubmit = 'true';
    submit.textContent = 'Record result';
    submit.style.cssText = 'margin:0;';
    submit.disabled = busy;
    submit.addEventListener('click', () => {
      const measurements = method.resultFields
        .map((field) => ({ field, text: (this.draftValues.get(field.key) ?? '').trim() }))
        .filter((candidate) => candidate.text.length > 0)
        .map((candidate) => ({
          key: candidate.field.key,
          // A numeric-looking entry is stored as a number so deltas are real
          // deltas; anything else stays exactly as it was typed.
          value: numericOrText(candidate.text),
          unit: candidate.field.unit,
        }));
      const required = method.resultFields.find((field) => field.required);
      void this.port.run({
        kind: 'record',
        definitionId: method.id,
        entry: {
          operator: this.draftOperator.trim(),
          recordedAt: this.port.now(),
          measurements,
          ...(required && measurements.some((entry) => entry.key === required.key) ? { chosenKey: required.key } : {}),
          projectHash: 'project',
        },
      });
    });
    host.appendChild(submit);
  }

  private renderComparison(): void {
    const host = this.comparison;
    if (!host) return;
    host.textContent = '';
    const comparison = this.port.getComparison();
    if (!comparison) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'flex';
    const doc = host.ownerDocument;
    for (const caveat of comparison.caveats) {
      const line = doc.createElement('span');
      line.dataset.calibrationHistoryCaveat = 'true';
      line.style.cssText = 'color:#ffb74d;';
      line.textContent = caveat;
      host.appendChild(line);
    }
    for (const difference of comparison.measurementDifferences) {
      const line = doc.createElement('span');
      line.dataset.calibrationHistoryDelta = difference.key;
      line.style.cssText = 'opacity:0.85;';
      line.textContent =
        difference.delta === null
          ? `${difference.key}: ${String(difference.left ?? '—')} → ${String(difference.right ?? '—')}`
          : `${difference.key}: ${String(difference.left)} → ${String(difference.right)} (${
              difference.delta > 0 ? '+' : ''
            }${roundDelta(difference.delta)})`;
      host.appendChild(line);
    }
    if (comparison.measurementDifferences.length === 0) {
      const line = doc.createElement('span');
      line.dataset.calibrationHistoryDelta = 'none';
      line.style.cssText = 'opacity:0.85;';
      line.textContent = 'Both runs measured the same values.';
      host.appendChild(line);
    }
  }

  private renderIssues(): void {
    const host = this.issueList;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    for (const issue of this.port.getIssues()) {
      const row = doc.createElement('li');
      row.dataset.calibrationHistoryIssue = issue.code;
      row.textContent = issue.message;
      row.style.cssText = `font-size:11px;color:${issue.severity === 'error' ? '#ff8a80' : '#ffb74d'};`;
      host.appendChild(row);
    }
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

const FIELD_STYLE =
  'display:block;width:100%;padding:6px 8px;border-radius:6px;background:var(--oxr-color-bg);' +
  'color:var(--oxr-color-text);border:1px solid var(--oxr-color-stroke-strong);font-size:12px;';

function labelled(doc: Document, text: string, control: HTMLElement): HTMLElement {
  const wrap = doc.createElement('label');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;opacity:0.8;';
  const caption = doc.createElement('span');
  caption.textContent = text;
  wrap.append(caption, control);
  return wrap;
}

/** A number when the text is exactly one, and the text itself otherwise. */
export function numericOrText(text: string): number | string {
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) && String(parsed) === text.trim() ? parsed : text.trim();
}

/** The number someone came for, or an honest absence. */
export function describeChosen(record: CalibrationRecord): string {
  if (!record.chosen) return '—';
  return record.chosen.unit ? `${record.chosen.value} ${record.chosen.unit}` : String(record.chosen.value);
}

/** The conditions that decide whether the number above is usable. */
export function describeConditions(record: CalibrationRecord): string {
  const nozzle = Number.isFinite(record.conditions.nozzleDiameterMm)
    ? `${record.conditions.nozzleDiameterMm} mm`
    : 'unknown nozzle';
  return [
    record.conditions.printerModel,
    nozzle,
    record.conditions.filamentMaterial,
    new Date(record.recordedAt).toLocaleDateString(),
    record.operator,
  ].join(' · ');
}

function roundDelta(delta: number): string {
  const rounded = Math.abs(delta) >= 1 ? delta.toFixed(2) : delta.toPrecision(2);
  return String(Number.parseFloat(rounded));
}
