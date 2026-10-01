import { unsavedProjectLabels, type UnsavedProjectDecision } from '../UnsavedProjectDecision';

/** Owned modal decision: cancellation, disposal and Escape preserve the current project. */
export function askUnsavedProjectDecision(projectName: string, signal?: AbortSignal): Promise<UnsavedProjectDecision> {
  if (signal?.aborted) return Promise.resolve('cancel');
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const labels = unsavedProjectLabels(projectName);
    const overlay = document.createElement('div');
    overlay.dataset.unsavedProjectDialog = 'true';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:11000;background:#000b;display:flex;align-items:center;justify-content:center;padding:20px;';
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'unsaved-project-title');
    dialog.setAttribute('aria-describedby', 'unsaved-project-detail');
    dialog.style.cssText =
      'max-width:520px;background:var(--oxr-color-bg-card);color:var(--oxr-color-text);border:1px solid var(--oxr-color-stroke);border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif;';
    const title = document.createElement('h2');
    title.id = 'unsaved-project-title';
    title.textContent = labels.title;
    const detail = document.createElement('p');
    detail.id = 'unsaved-project-detail';
    detail.textContent = labels.detail;
    const note = document.createElement('p');
    note.textContent = labels.handoff;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    let settled = false;
    const finish = (choice: UnsavedProjectDecision) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      previousFocus?.focus();
      resolve(choice);
    };
    const cancel = () => finish('cancel');
    const buttons = labels.choices.map((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.unsavedChoice = choice.id;
      button.textContent = choice.label;
      button.style.cssText = 'min-height:44px;padding:10px 14px;';
      button.onclick = () => finish(choice.id);
      actions.append(button);
      return button;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const index = buttons.findIndex((button) => button === document.activeElement);
        const next =
          index < 0
            ? event.shiftKey
              ? buttons.length - 1
              : 0
            : (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
        buttons[next]?.focus();
      }
    };
    dialog.append(title, detail, note, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKeyDown, true);
    signal?.addEventListener('abort', cancel, { once: true });
    buttons[2]?.focus();
  });
}
