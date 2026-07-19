import { getAiSessionSecret, purgeLegacyAiSecretStorage, setAiSessionSecret } from '../../security/AiSessionSecrets';

export class AiConfigDialog {
  private static returnFocus: HTMLElement | null = null;

  static init(): void {
    purgeLegacyAiSecretStorage();
    if (document.getElementById('ai-config-dialog')) return;

    const dialog = document.createElement('div');
    dialog.id = 'ai-config-dialog';
    dialog.style.cssText =
      'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center;';
    dialog.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="ai-config-title" aria-describedby="ai-config-note"
        style="background:var(--oxr-color-bg-card);padding:24px;border-radius:12px;width:min(400px,88vw);border:1px solid var(--oxr-color-stroke);color:#fff;font-family:sans-serif;">
        <h3 id="ai-config-title" style="margin-top:0;">AI Configuration</h3>
        <p id="ai-config-note" style="font-size:13px;color:var(--oxr-color-text-muted);line-height:1.4;">
          Keys stay in memory for this tab only and are cleared when the page closes. They are never saved in browser storage.
        </p>
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <label for="ai-gemini-key" style="display:block;margin-bottom:8px;font-size:14px;color:var(--oxr-color-text-muted);">Gemini API Key</label>
            <input type="password" id="ai-gemini-key" autocomplete="off" spellcheck="false"
              style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--oxr-color-stroke);background:rgba(255,255,255,0.05);color:#fff;font-size:14px;box-sizing:border-box;">
          </div>
        </div>
        <div style="margin-top:24px;display:flex;justify-content:flex-end;gap:12px;">
          <button type="button" id="ai-config-cancel" class="action-btn">Cancel</button>
          <button type="button" id="ai-config-save" class="action-btn primary" style="width:auto;padding:14px 24px;">Use for this tab</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);

    const hide = () => {
      dialog.style.display = 'none';
      const returnFocus = AiConfigDialog.returnFocus;
      AiConfigDialog.returnFocus = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    const geminiInput = document.getElementById('ai-gemini-key') as HTMLInputElement;

    document.getElementById('ai-config-cancel')!.onclick = hide;
    document.getElementById('ai-config-save')!.onclick = () => {
      setAiSessionSecret('gemini', geminiInput.value);
      hide();
    };
    dialog.onclick = (event) => {
      if (event.target === dialog) hide();
    };
    dialog.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        hide();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(
          (element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'),
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
  }

  static show(): void {
    purgeLegacyAiSecretStorage();
    const dialog = document.getElementById('ai-config-dialog');
    if (!dialog) return;
    AiConfigDialog.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const geminiInput = document.getElementById('ai-gemini-key') as HTMLInputElement;
    geminiInput.value = getAiSessionSecret('gemini') ?? '';
    dialog.style.display = 'flex';
    geminiInput.focus();
  }
}
