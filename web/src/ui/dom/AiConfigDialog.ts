export class AiConfigDialog {
    static init() {
        const dialog = document.createElement('div');
        dialog.id = 'ai-config-dialog';
        dialog.style.display = 'none';
        dialog.style.position = 'fixed';
        dialog.style.inset = '0';
        dialog.style.backgroundColor = 'rgba(0,0,0,0.6)';
        dialog.style.zIndex = '100';
        dialog.style.alignItems = 'center';
        dialog.style.justifyContent = 'center';
        dialog.innerHTML = `
            <div style="background:var(--oxr-color-bg-card); padding:24px; border-radius:12px; width:400px; border:1px solid var(--oxr-color-stroke); color:#fff; font-family:sans-serif;">
                <h3 style="margin-top:0;">AI Configuration</h3>
                <div style="display:flex; flex-direction:column; gap:16px;">
                    <div>
                        <label style="display:block; margin-bottom:8px; font-size:14px; color:var(--oxr-color-text-muted);">Gemini API Key</label>
                        <input type="password" id="ai-gemini-key" style="width:100%; padding:10px; border-radius:6px; border:1px solid var(--oxr-color-stroke); background:rgba(255,255,255,0.05); color:#fff; font-size:14px; box-sizing:border-box;">
                    </div>
                    <div>
                        <label style="display:block; margin-bottom:8px; font-size:14px; color:var(--oxr-color-text-muted);">OpenAI API Key</label>
                        <input type="password" id="ai-openai-key" style="width:100%; padding:10px; border-radius:6px; border:1px solid var(--oxr-color-stroke); background:rgba(255,255,255,0.05); color:#fff; font-size:14px; box-sizing:border-box;">
                    </div>
                </div>
                <div style="margin-top:24px; display:flex; justify-content:flex-end; gap:12px;">
                    <button id="ai-config-cancel" class="action-btn">Cancel</button>
                    <button id="ai-config-save" class="action-btn primary" style="width:auto; padding:14px 24px;">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const geminiInput = document.getElementById('ai-gemini-key') as HTMLInputElement;
        const openaiInput = document.getElementById('ai-openai-key') as HTMLInputElement;

        document.getElementById('ai-config-cancel')!.onclick = () => {
            dialog.style.display = 'none';
        };

        document.getElementById('ai-config-save')!.onclick = () => {
            localStorage.setItem('orca_gemini_key', geminiInput.value);
            localStorage.setItem('orca_openai_key', openaiInput.value);
            // Apply to xrblocks if needed
            if ((window as any).xb && (window as any).xb.config) {
                if (!(window as any).xb.config.ai) (window as any).xb.config.ai = {};
                if (!(window as any).xb.config.ai.gemini) (window as any).xb.config.ai.gemini = {};
                if (!(window as any).xb.config.ai.openai) (window as any).xb.config.ai.openai = {};
                (window as any).xb.config.ai.gemini.apiKey = geminiInput.value;
                (window as any).xb.config.ai.openai.apiKey = openaiInput.value;
            }
            dialog.style.display = 'none';
        };
    }

    static show() {
        const dialog = document.getElementById('ai-config-dialog');
        if (dialog) {
            const geminiInput = document.getElementById('ai-gemini-key') as HTMLInputElement;
            const openaiInput = document.getElementById('ai-openai-key') as HTMLInputElement;
            geminiInput.value = localStorage.getItem('orca_gemini_key') || '';
            openaiInput.value = localStorage.getItem('orca_openai_key') || '';
            dialog.style.display = 'flex';
        }
    }
}
