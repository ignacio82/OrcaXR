export interface PrintJobConfirmInput {
  readonly title: string;
  readonly message: string;
  /** What happens to the machine; each line is shown verbatim. */
  readonly consequences: readonly string[];
  readonly confirmLabel: string;
  readonly dismissLabel: string;
}

/**
 * Confirm one irreversible printer command.
 *
 * Focus starts on the dismiss button and Escape dismisses, so no keystroke that
 * merely lands on this dialog can stop a print. The confirmation is a single
 * click rather than a typed phrase: an emergency stop has to stay fast, and
 * friction that delays a real stop is worse than the accidental click it
 * prevents.
 */
export function askPrintJobConfirmation(input: PrintJobConfirmInput): Promise<boolean> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.dataset.printJobConfirm = 'true';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10002;background:#000b;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;box-sizing:border-box;';

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'orcaxr-print-job-confirm-title');
  dialog.setAttribute('aria-describedby', 'orcaxr-print-job-confirm-body');
  dialog.style.cssText =
    'max-width:460px;width:100%;background:var(--oxr-color-bg-card,#161a20);color:var(--oxr-color-text,#fff);' +
    'border:1px solid var(--oxr-color-stroke,#2a3038);border-radius:12px;padding:20px;' +
    'font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;gap:12px;';

  const title = document.createElement('h2');
  title.id = 'orcaxr-print-job-confirm-title';
  title.textContent = input.title;
  title.style.cssText = 'margin:0;font-size:16px;';

  const body = document.createElement('div');
  body.id = 'orcaxr-print-job-confirm-body';
  body.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const message = document.createElement('p');
  message.style.cssText = 'margin:0;';
  message.textContent = input.message;
  body.appendChild(message);
  for (const consequence of input.consequences) {
    const line = document.createElement('p');
    line.dataset.printJobConfirmConsequence = 'true';
    line.textContent = consequence;
    line.style.cssText =
      'margin:0;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,107,107,0.55);' +
      'background:rgba(255,107,107,0.12);';
    body.appendChild(line);
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;';
  const make = (label: string, choice: 'confirm' | 'cancel'): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.printJobConfirmChoice = choice;
    button.textContent = label;
    button.style.cssText =
      'min-height:44px;padding:10px 14px;border-radius:8px;cursor:pointer;color:inherit;' +
      `border:1px solid ${choice === 'confirm' ? 'rgba(255,107,107,0.75)' : 'rgba(255,255,255,0.24)'};` +
      `background:rgba(${choice === 'confirm' ? '255,107,107' : '255,255,255'},${choice === 'confirm' ? 0.16 : 0.06});`;
    button.onclick = () => finish(choice === 'confirm');
    return button;
  };
  const confirmButton = make(input.confirmLabel, 'confirm');
  const dismissButton = make(input.dismissLabel, 'cancel');
  actions.append(confirmButton, dismissButton);

  dialog.append(title, body, actions);
  overlay.appendChild(dialog);

  let settle: (confirmed: boolean) => void = () => {};
  const finish = (confirmed: boolean) => {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    previousFocus?.focus?.();
    settle(confirmed);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [dismissButton, confirmButton];
    const index = stops.findIndex((stop) => stop === document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index + 1) % stops.length;
    event.preventDefault();
    stops[next].focus();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  dismissButton.focus();
  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}
