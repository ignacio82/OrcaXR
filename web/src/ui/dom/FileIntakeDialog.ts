export type ThreeMfIntakeChoice = 'project' | 'geometry' | 'cancel';

/**
 * Ask how a 3MF should be loaded, matching upstream's "open as project versus
 * import geometry" decision. The dialog is keyboard-operable, traps focus, and
 * restores it, because it interrupts a drag or picker gesture.
 */
export function askThreeMfIntake(filename: string): Promise<ThreeMfIntakeChoice> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.dataset.fileIntakeDialog = 'true';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;background:#000b;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;box-sizing:border-box;';

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'orcaxr-file-intake-title');
  dialog.setAttribute('aria-describedby', 'orcaxr-file-intake-body');
  dialog.style.cssText =
    'max-width:520px;width:100%;background:var(--oxr-color-bg-card);color:var(--oxr-color-text);' +
    'border:1px solid var(--oxr-color-stroke);border-radius:12px;padding:20px;' +
    'font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;gap:14px;';

  const title = document.createElement('h2');
  title.id = 'orcaxr-file-intake-title';
  title.textContent = `Load ${filename}`;
  title.style.cssText = 'margin:0;font-size:16px;';

  const body = document.createElement('p');
  body.id = 'orcaxr-file-intake-body';
  body.style.cssText = 'margin:0;opacity:0.85;';
  body.textContent =
    'A 3MF can replace the open project with everything it contains — plates, settings, filaments, ' +
    'and paint — or contribute only its models to the project you already have.';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;';

  const buttons: HTMLButtonElement[] = [];
  const make = (label: string, value: ThreeMfIntakeChoice, primary: boolean, hint: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fileIntakeChoice = value;
    button.textContent = label;
    button.title = hint;
    button.style.cssText =
      'min-height:44px;padding:10px 14px;border-radius:8px;cursor:pointer;color:inherit;' +
      `border:1px solid ${primary ? 'var(--oxr-color-accent,var(--oxr-accent))' : 'var(--oxr-stroke)'};` +
      `background:${primary ? 'var(--oxr-surface-hover)' : 'var(--oxr-surface)'};`;
    button.onclick = () => finish(value);
    buttons.push(button);
    return button;
  };

  actions.append(
    make('Open as project', 'project', true, 'Replace the open project with this 3MF'),
    make('Import geometry only', 'geometry', false, 'Add only this file’s models to the current project'),
    make('Cancel', 'cancel', false, 'Leave the project unchanged'),
  );

  dialog.append(title, body, actions);
  overlay.append(dialog);

  let settle: (choice: ThreeMfIntakeChoice) => void = () => {};
  const finish = (choice: ThreeMfIntakeChoice) => {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    previousFocus?.focus?.();
    settle(choice);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish('cancel');
      return;
    }
    if (event.key !== 'Tab' || buttons.length === 0) return;
    const active = document.activeElement;
    const index = buttons.findIndex((button) => button === active);
    const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  buttons[0]?.focus();
  return new Promise<ThreeMfIntakeChoice>((resolve) => {
    settle = resolve;
  });
}
