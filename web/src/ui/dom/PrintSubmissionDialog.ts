import { t } from '../../l10n/t';
import type { PrintStartOption, PrintStartOptionId } from '../../printer/PrintStartOptions';

export interface PrintSubmissionDialogInput {
  readonly filename: string;
  readonly plateName: string;
  readonly byteLength: number;
  readonly endpointLabel: string;
  readonly printerStateLabel: string;
  readonly toolSummary: string;
  /** Reasons the artifact must not be printed as-is; they disable starting. */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  /**
   * What this particular printer offers around the print — levelling its plate,
   * recording a timelapse. Assessed from the machine's own answers, so an
   * unavailable one is shown with the printer's reason rather than hidden.
   */
  readonly startOptions?: readonly PrintStartOption[];
}

export type PrintSubmissionDecision =
  | { readonly choice: 'cancel' }
  | {
      readonly choice: 'upload' | 'upload-and-print';
      readonly overwrite: boolean;
      /** Pre-print options the operator ticked; only ever available ones. */
      readonly startOptions: readonly PrintStartOptionId[];
    };

/**
 * Confirm exactly what is about to be sent, and whether the printer should
 * start it.
 *
 * Uploading and printing are two separate buttons rather than one action with a
 * checkbox, because starting a print moves a real machine: it has to be the
 * thing the operator clicked. A tool-mapping blocker disables starting while
 * still allowing the file to be stored, and replacing an existing file is an
 * explicit opt-in — otherwise the send picks an unused name.
 */
export function askPrintSubmission(input: PrintSubmissionDialogInput): Promise<PrintSubmissionDecision> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.dataset.printSubmissionDialog = 'true';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;background:#000b;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;box-sizing:border-box;';

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'orcaxr-print-send-title');
  dialog.setAttribute('aria-describedby', 'orcaxr-print-send-body');
  dialog.style.cssText =
    'max-width:560px;width:100%;background:var(--oxr-color-bg-card);color:var(--oxr-color-text);' +
    'border:1px solid var(--oxr-color-stroke);border-radius:12px;padding:20px;' +
    'font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;gap:14px;' +
    'max-height:90vh;overflow:auto;';

  const title = document.createElement('h2');
  title.id = 'orcaxr-print-send-title';
  title.textContent = t('ui.printSubmissionDialog.sendToPrinter', 'Send to printer');
  title.style.cssText = 'margin:0;font-size:16px;';

  const body = document.createElement('div');
  body.id = 'orcaxr-print-send-body';
  body.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const facts: [string, string][] = [
    ['Printer', `${input.endpointLabel} — ${input.printerStateLabel}`],
    ['Plate', input.plateName],
    ['File', `${input.filename} (${formatBytes(input.byteLength)})`],
    ['Filaments', input.toolSummary],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement('p');
    row.style.cssText = 'margin:0;display:flex;gap:10px;';
    const term = document.createElement('span');
    term.textContent = label;
    term.style.cssText = 'opacity:0.7;min-width:70px;';
    const detail = document.createElement('span');
    detail.textContent = value;
    row.append(term, detail);
    body.append(row);
  }

  const notices = document.createElement('div');
  notices.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  for (const message of input.blockers) notices.append(notice(message, true));
  for (const message of input.warnings) notices.append(notice(message, false));

  // What the machine can do around this print. Unavailable entries stay on
  // screen, disabled, carrying the printer's own reason: "this printer has no
  // timelapse component" is a useful thing to learn, and hiding it would leave
  // an operator wondering where an option they know from the desktop went.
  const optionInputs = new Map<PrintStartOptionId, HTMLInputElement>();
  const optionsBox = document.createElement('fieldset');
  optionsBox.dataset.printSubmissionOptions = 'true';
  optionsBox.style.cssText =
    'margin:0;padding:10px 12px;border:1px solid var(--oxr-stroke);border-radius:8px;' +
    'display:flex;flex-direction:column;gap:8px;';
  if ((input.startOptions?.length ?? 0) > 0) {
    const legend = document.createElement('legend');
    legend.textContent = t('ui.printSubmissionDialog.beforePrinting', 'Before printing');
    legend.style.cssText = 'padding:0 4px;opacity:0.7;font-size:12px;';
    optionsBox.append(legend);
    for (const option of input.startOptions ?? []) {
      const row = document.createElement('label');
      row.dataset.printSubmissionOption = option.id;
      row.style.cssText =
        `display:flex;gap:8px;align-items:flex-start;cursor:${option.available ? 'pointer' : 'not-allowed'};` +
        `opacity:${option.available ? '1' : '0.55'};`;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = option.available && option.defaultEnabled;
      box.disabled = !option.available;
      box.dataset.printSubmissionOptionInput = option.id;
      box.style.cssText = 'margin-top:3px;';
      const text = document.createElement('span');
      const label = document.createElement('span');
      label.textContent = option.label;
      const why = document.createElement('span');
      // Available: what it will do. Unavailable: why it cannot.
      why.textContent = option.available ? option.detail : option.reason;
      why.style.cssText = 'display:block;opacity:0.7;font-size:12px;';
      text.append(label, why);
      row.append(box, text);
      row.title = option.reason;
      optionsBox.append(row);
      optionInputs.set(option.id, box);
    }
  }
  const chosenOptions = (): readonly PrintStartOptionId[] =>
    [...optionInputs].filter(([, box]) => box.checked && !box.disabled).map(([id]) => id);

  const overwriteLabel = document.createElement('label');
  overwriteLabel.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;';
  const overwrite = document.createElement('input');
  overwrite.type = 'checkbox';
  overwrite.id = 'orcaxr-print-send-overwrite';
  overwrite.dataset.printSubmissionOverwrite = 'true';
  const overwriteText = document.createElement('span');
  overwriteText.textContent = t(
    'ui.printSubmissionDialog.replaceAStoredFileWith',
    'Replace a stored file with the same name',
  );
  overwriteLabel.append(overwrite, overwriteText);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;';

  const buttons: HTMLButtonElement[] = [];
  const make = (
    label: string,
    choice: 'upload' | 'upload-and-print' | 'cancel',
    primary: boolean,
    hint: string,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.printSubmissionChoice = choice;
    button.textContent = label;
    button.title = hint;
    button.style.cssText =
      'min-height:44px;padding:10px 14px;border-radius:8px;cursor:pointer;color:inherit;' +
      `border:1px solid ${primary ? 'var(--oxr-color-accent,var(--oxr-accent))' : 'var(--oxr-stroke)'};` +
      `background:${primary ? 'var(--oxr-surface-hover)' : 'var(--oxr-surface)'};`;
    button.onclick = () =>
      finish(
        choice === 'cancel' ? { choice } : { choice, overwrite: overwrite.checked, startOptions: chosenOptions() },
      );
    buttons.push(button);
    return button;
  };

  const startButton = make(
    'Upload and start print',
    'upload-and-print',
    true,
    'Store the file and immediately start printing it',
  );
  if (input.blockers.length > 0) {
    startButton.disabled = true;
    startButton.style.opacity = '0.5';
    startButton.style.cursor = 'not-allowed';
    startButton.title = t(
      'ui.printSubmissionDialog.resolveTheFilamentMappingProblems',
      'Resolve the filament mapping problems above before starting this print',
    );
  }
  actions.append(
    startButton,
    make('Upload only', 'upload', input.blockers.length > 0, 'Store the file without starting a print'),
    make('Cancel', 'cancel', false, 'Send nothing'),
  );

  dialog.append(title, body, notices);
  if ((input.startOptions?.length ?? 0) > 0) dialog.append(optionsBox);
  dialog.append(overwriteLabel, actions);
  overlay.append(dialog);

  let settle: (decision: PrintSubmissionDecision) => void = () => {};
  const finish = (decision: PrintSubmissionDecision) => {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    previousFocus?.focus?.();
    settle(decision);
  };
  const focusable = (): HTMLElement[] => [overwrite, ...buttons.filter((button) => !button.disabled)];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish({ choice: 'cancel' });
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = focusable();
    if (stops.length === 0) return;
    const index = stops.findIndex((stop) => stop === document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index + 1) % stops.length;
    event.preventDefault();
    stops[next].focus();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  // Focus the least destructive enabled action, never "start printing".
  (buttons.find((button) => button.dataset.printSubmissionChoice === 'upload') ?? buttons[0])?.focus();
  return new Promise<PrintSubmissionDecision>((resolve) => {
    settle = resolve;
  });
}

function notice(message: string, blocking: boolean): HTMLElement {
  const element = document.createElement('p');
  element.dataset.printSubmissionNotice = blocking ? 'blocker' : 'warning';
  element.textContent = message;
  element.style.cssText =
    'margin:0;padding:8px 10px;border-radius:8px;' +
    `border:1px solid ${blocking ? 'rgba(255,107,107,0.55)' : 'rgba(255,193,87,0.45)'};` +
    `background:rgba(${blocking ? '255,107,107' : '255,193,87'},0.12);`;
  return element;
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(0)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}
