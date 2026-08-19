/**
 * The G-code console and the printer's own macros (P9.6).
 *
 * The transcript is the point of the panel: what was sent, what came back, and
 * which lines the printer reported as errors. Everything the printer says is
 * inserted as text — never as markup — because a printer host is untrusted
 * content, and a machine reporting a crafted string must not be able to reach
 * into the page.
 *
 * The send button carries the assessment with it. A command that only reports
 * sends immediately; anything that moves, heats, or halts states what it will
 * do first, so nobody discovers what `M84` means by watching the gantry drop.
 */

import type {
  GcodeCommandAssessment,
  PrinterConsoleEntry,
  PrinterConsoleOperation,
  PrinterMacro,
} from '../../printer/PrinterConsole';

export interface PrinterConsolePanelPort {
  getEntries(): readonly PrinterConsoleEntry[];
  getMacros(): readonly PrinterMacro[];
  getRecentCommands(): readonly string[];
  /** What the current draft would do, given what the machine is doing now. */
  assess(script: string): GcodeCommandAssessment;
  getStatus(): { readonly busy: boolean; readonly message?: string };
  subscribe(listener: () => void): () => void;
  run(operation: PrinterConsoleOperation): void | Promise<void>;
  /** Collect a macro's parameters; resolves undefined when abandoned. */
  askParameters(macro: PrinterMacro): Promise<Record<string, string> | undefined>;
}

const LEVEL_LABEL: Readonly<Record<GcodeCommandAssessment['level'], string>> = Object.freeze({
  safe: 'Reports only',
  caution: 'Moves or heats the printer',
  dangerous: 'Can damage the printer or lose the print',
});

const LEVEL_COLOR: Readonly<Record<GcodeCommandAssessment['level'], string>> = Object.freeze({
  safe: '#8bc34a',
  caution: '#ffb74d',
  dangerous: '#ff8a80',
});

const ENTRY_COLOR: Readonly<Record<PrinterConsoleEntry['kind'], string>> = Object.freeze({
  sent: '#dfe4ea',
  received: '#9aa4af',
  error: '#ff8a80',
});

export class PrinterConsolePanel {
  private root?: HTMLElement;
  private transcript?: HTMLElement;
  private input?: HTMLInputElement;
  private sendButton?: HTMLButtonElement;
  private assessmentLine?: HTMLElement;
  private macroList?: HTMLElement;
  private status?: HTMLElement;
  private historyIndex = -1;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PrinterConsolePanelPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.printerConsolePanel = 'true';
    root.setAttribute('aria-label', 'Printer G-code console');
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const transcript = doc.createElement('div');
    transcript.dataset.printerConsoleTranscript = 'true';
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    transcript.setAttribute('aria-label', 'Console transcript');
    transcript.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto;' +
      'font-family:ui-monospace,monospace;font-size:11px;background:#0006;border-radius:6px;padding:8px;';
    root.appendChild(transcript);

    const form = doc.createElement('form');
    form.style.cssText = 'display:flex;gap:6px;';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    const input = doc.createElement('input');
    input.type = 'text';
    input.dataset.printerConsoleInput = 'true';
    input.setAttribute('aria-label', 'G-code command');
    input.placeholder = 'e.g. M115';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.cssText =
      'flex:1;min-width:0;font-family:ui-monospace,monospace;padding:6px 8px;border-radius:6px;' +
      'border:1px solid #ffffff26;background:#00000040;color:inherit;';
    input.addEventListener('input', () => {
      this.historyIndex = -1;
      this.renderAssessment();
    });
    // Up and down walk the sent history, the way every console does.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const history = this.port.getRecentCommands();
      if (history.length === 0) return;
      event.preventDefault();
      this.historyIndex =
        event.key === 'ArrowUp'
          ? Math.min(this.historyIndex + 1, history.length - 1)
          : Math.max(this.historyIndex - 1, -1);
      input.value = this.historyIndex === -1 ? '' : history[this.historyIndex];
      this.renderAssessment();
    });
    form.appendChild(input);

    const send = doc.createElement('button');
    send.type = 'submit';
    send.className = 'action-btn';
    send.dataset.printerConsoleSend = 'true';
    send.textContent = 'Send';
    send.style.cssText = 'margin:0;';
    form.appendChild(send);
    root.appendChild(form);

    const assessment = doc.createElement('p');
    assessment.dataset.printerConsoleAssessment = 'true';
    assessment.style.cssText = 'margin:0;font-size:11px;min-height:1em;';
    root.appendChild(assessment);

    const macroHeader = doc.createElement('div');
    macroHeader.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const macroTitle = doc.createElement('span');
    macroTitle.className = 'insp-kicker';
    macroTitle.textContent = 'Macros';
    macroHeader.appendChild(macroTitle);
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.dataset.printerConsoleRefreshMacros = 'true';
    refresh.textContent = 'Refresh';
    refresh.style.cssText = 'margin:0;margin-inline-start:auto;';
    refresh.addEventListener('click', () => void this.port.run({ kind: 'refresh-macros' }));
    macroHeader.appendChild(refresh);
    root.appendChild(macroHeader);

    const macros = doc.createElement('div');
    macros.dataset.printerConsoleMacros = 'true';
    macros.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    root.appendChild(macros);

    const status = doc.createElement('p');
    status.dataset.printerConsoleStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.transcript = transcript;
    this.input = input;
    this.sendButton = send;
    this.assessmentLine = assessment;
    this.macroList = macros;
    this.status = status;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private async send(): Promise<void> {
    const input = this.input;
    if (!input) return;
    const script = input.value.trim();
    if (!script) return;
    await this.port.run({ kind: 'send', script });
    input.value = '';
    this.historyIndex = -1;
    this.renderAssessment();
  }

  private async runMacro(macro: PrinterMacro): Promise<void> {
    // A macro with no parameters runs as typed; one with parameters asks first,
    // because a required value left empty would run the macro's own fallback
    // without anybody choosing it.
    const values = macro.parameters.length === 0 ? {} : await this.port.askParameters(macro);
    if (!values) return;
    await this.port.run({ kind: 'macro', name: macro.name, values });
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const state = this.port.getStatus();
    if (this.status) this.status.textContent = state.message ?? '';
    if (this.sendButton) this.sendButton.disabled = state.busy;

    const transcript = this.transcript;
    if (transcript) {
      transcript.textContent = '';
      const doc = transcript.ownerDocument;
      const entries = this.port.getEntries();
      if (entries.length === 0) {
        const empty = doc.createElement('p');
        empty.style.cssText = 'margin:0;opacity:0.6;';
        empty.textContent = 'Nothing sent yet.';
        transcript.appendChild(empty);
      }
      for (const entry of entries) {
        const line = doc.createElement('div');
        line.dataset.printerConsoleEntry = entry.kind;
        line.style.cssText = `color:${ENTRY_COLOR[entry.kind]};white-space:pre-wrap;overflow-wrap:anywhere;`;
        // textContent, never innerHTML: this string came from the printer.
        line.textContent = `${entry.kind === 'sent' ? '>' : entry.kind === 'error' ? '!!' : '<'} ${entry.text}`;
        transcript.appendChild(line);
      }
      transcript.scrollTop = transcript.scrollHeight;
    }

    const macroList = this.macroList;
    if (macroList) {
      macroList.textContent = '';
      const doc = macroList.ownerDocument;
      const macros = this.port.getMacros();
      if (macros.length === 0) {
        const empty = doc.createElement('p');
        empty.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
        empty.textContent = 'Refresh to read the macros this printer defines.';
        macroList.appendChild(empty);
      }
      for (const macro of macros) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'action-btn';
        button.dataset.printerConsoleMacro = macro.name;
        button.textContent = macro.name;
        button.disabled = state.busy;
        button.style.cssText = `margin:0;border-color:${LEVEL_COLOR[macro.level]}66;`;
        const parameters = macro.parameters.map((p) => (p.required ? p.name : `${p.name}=${p.defaultValue ?? ''}`));
        button.title = [
          macro.description,
          parameters.length ? `Parameters: ${parameters.join(', ')}` : '',
          ...macro.reasons,
        ]
          .filter(Boolean)
          .join('\n');
        button.addEventListener('click', () => void this.runMacro(macro));
        macroList.appendChild(button);
      }
    }

    this.renderAssessment();
  }

  private renderAssessment(): void {
    const line = this.assessmentLine;
    if (!line || !this.input) return;
    const script = this.input.value.trim();
    if (!script) {
      line.textContent = '';
      delete line.dataset.printerConsoleLevel;
      return;
    }
    const assessment = this.port.assess(script);
    line.dataset.printerConsoleLevel = assessment.level;
    line.style.color = LEVEL_COLOR[assessment.level];
    line.textContent = `${assessment.command}: ${LEVEL_LABEL[assessment.level]}${
      assessment.reasons.length ? ` — ${assessment.reasons.join(' ')}` : ''
    }`;
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
