import type { PrintJobCommand, PrintJobCommandDescriptor } from '../../printer/PrintJobControl';
import { describePrintJobState, formatDuration, type PrintJobSnapshot } from '../../printer/PrintJobStatus';
import { t } from '../../l10n/t';

export interface PrintJobPanelAdapter {
  /** The live snapshot, or null when this session has no printer connection. */
  getSnapshot(): PrintJobSnapshot | null;
  /** What the printer's reported state currently permits. */
  getCommands(): readonly PrintJobCommandDescriptor[];
  subscribe(listener: () => void): () => void;
  onCommand(command: PrintJobCommand): void | Promise<void>;
}

/**
 * Live job readout plus the lifecycle controls for the connected printer.
 *
 * Every field renders exactly what the machine reported: an absent value shows
 * an em dash rather than a zero, because "0 %" and "not reported" mean very
 * different things to someone deciding whether to cancel a print. Controls are
 * enabled from the printer's own state, so a job started at the machine is as
 * controllable as one sent from here.
 */
export class PrintJobPanel {
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private readonly buttons = new Map<PrintJobCommand, HTMLButtonElement>();
  private fields?: HTMLDListElement;
  private headline?: HTMLElement;
  private progressBar?: HTMLElement;
  private progressLabel?: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: PrintJobPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.printJobPanel = 'true';
    root.setAttribute('aria-label', t('ui.printJobPanel.printerJob', 'Printer job'));
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;';

    const headline = document.createElement('p');
    headline.dataset.printJobState = 'unknown';
    headline.setAttribute('role', 'status');
    headline.setAttribute('aria-live', 'polite');
    headline.style.cssText = 'margin:0;font-weight:650;';

    const progress = document.createElement('div');
    progress.style.cssText =
      'height:6px;border-radius:3px;background:rgba(255,255,255,0.12);overflow:hidden;display:none;';
    const bar = document.createElement('div');
    bar.dataset.printJobProgress = 'true';
    bar.style.cssText = 'height:100%;width:0%;background:var(--oxr-color-accent,#4fc3f7);';
    progress.appendChild(bar);

    const progressLabel = document.createElement('p');
    progressLabel.dataset.printJobProgressLabel = 'true';
    progressLabel.style.cssText = 'margin:0;font-size:11px;color:#a0aab5;';

    const fields = document.createElement('dl');
    fields.style.cssText =
      'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:12px;color:#c7ced6;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const command of ['pause', 'resume', 'cancel', 'emergency-stop'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-btn';
      button.dataset.printJobCommand = command;
      button.style.cssText = 'flex:1 1 46%;min-height:36px;';
      button.onclick = () => void this.adapter.onCommand(command);
      this.buttons.set(command, button);
      controls.appendChild(button);
    }

    root.append(headline, progress, progressLabel, fields, controls);
    this.container.replaceChildren(root);
    this.root = root;
    this.headline = headline;
    this.progressBar = bar;
    this.progressLabel = progressLabel;
    this.fields = fields;
    this.unsubscribe = this.adapter.subscribe(() => this.render());
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const button of this.buttons.values()) button.onclick = null;
    this.buttons.clear();
    this.root?.remove();
    this.root = undefined;
  }

  render(): void {
    if (!this.root || !this.headline || !this.fields) return;
    const snapshot = this.adapter.getSnapshot();
    this.headline.textContent = snapshot ? describePrintJobState(snapshot) : 'No printer connected';
    this.headline.dataset.printJobState = snapshot?.state ?? 'disconnected';

    const percent = snapshot?.progress === undefined ? null : Math.round(snapshot.progress * 100);
    if (this.progressBar?.parentElement) {
      this.progressBar.parentElement.style.display = percent === null ? 'none' : 'block';
      this.progressBar.style.width = `${percent ?? 0}%`;
    }
    if (this.progressLabel) {
      this.progressLabel.textContent =
        percent === null
          ? ''
          : `${percent}% · ${formatDuration(snapshot?.printDurationS)} elapsed · ≈${formatDuration(
              snapshot?.estimatedRemainingS,
            )} left`;
    }

    const rows: [string, string][] = [];
    if (snapshot) {
      if (snapshot.filename) rows.push(['File', snapshot.filename]);
      if (snapshot.currentLayer !== undefined) {
        rows.push([
          'Layer',
          snapshot.totalLayers !== undefined
            ? `${snapshot.currentLayer} / ${snapshot.totalLayers}`
            : String(snapshot.currentLayer),
        ]);
      }
      if (snapshot.extruder) rows.push(['Nozzle', temperature(snapshot.extruder)]);
      if (snapshot.bed) rows.push(['Bed', temperature(snapshot.bed)]);
      if (snapshot.klippyState && snapshot.klippyState !== 'ready') rows.push(['Klipper', snapshot.klippyState]);
    }
    this.fields.replaceChildren();
    for (const [label, value] of rows) {
      const term = this.container.ownerDocument.createElement('dt');
      term.textContent = label;
      term.style.cssText = 'opacity:0.7;';
      const detail = this.container.ownerDocument.createElement('dd');
      detail.dataset.printJobField = label.toLowerCase();
      detail.textContent = value;
      detail.style.cssText = 'margin:0;overflow-wrap:anywhere;';
      this.fields.append(term, detail);
    }

    const commands = new Map(this.adapter.getCommands().map((entry) => [entry.command, entry]));
    for (const [command, button] of this.buttons) {
      const descriptor = commands.get(command);
      const allowed = descriptor?.allowed === true && snapshot !== null;
      button.textContent = descriptor?.label ?? command;
      button.disabled = !allowed;
      button.setAttribute('aria-disabled', String(!allowed));
      button.title = allowed ? (descriptor?.label ?? command) : (descriptor?.reason ?? 'Connect to a printer first.');
      button.style.opacity = allowed ? '1' : '0.55';
    }
  }
}

function temperature(reading: { readonly actualC: number; readonly targetC: number }): string {
  const actual = `${reading.actualC.toFixed(1)} °C`;
  return reading.targetC > 0 ? `${actual} → ${reading.targetC.toFixed(0)} °C` : actual;
}
