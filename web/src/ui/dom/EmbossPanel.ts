import { t } from '../../l10n/t';
export interface EmbossPanelState {
  readonly active: boolean;
  /** Absent when the selection does not resolve to exactly one part. */
  readonly objectId?: string;
  /** Present when the selected part is itself embossed text an edit re-cuts. */
  readonly volumeId?: string;
  /** Absent until the operator picks a font file. */
  readonly fontName?: string;
  readonly text: string;
  readonly sizeMm: number;
  readonly depthMm: number;
  readonly charGapMm: number;
  readonly lineGapMm: number;
  readonly horizontal: 'left' | 'center' | 'right';
  readonly vertical: 'top' | 'center' | 'bottom';
  readonly hint: string;
}

export interface EmbossPanelAdapter {
  getState(): EmbossPanelState;
  subscribe?(listener: () => void): () => void;
  onActivate(): void | Promise<void>;
  onLoadFont(name: string, bytes: Uint8Array): void | Promise<void>;
  onConfigure(patch: {
    text?: string;
    sizeMm?: number;
    depthMm?: number;
    charGapMm?: number;
    lineGapMm?: number;
    horizontal?: 'left' | 'center' | 'right';
    vertical?: 'top' | 'center' | 'bottom';
  }): void | Promise<void>;
  onApply(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

/**
 * Text embossing surface.
 *
 * The font is a file the operator picks, because a browser cannot enumerate
 * the fonts installed on the machine and the app CSP forbids fetching one.
 * That is stated in the panel rather than hidden behind an empty font list.
 */
export class EmbossPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: EmbossPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: EmbossPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.embossPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-emboss-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text,#fff);' +
      'font:13px/1.4 system-ui,sans-serif;';
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    this.state = this.adapter.getState();
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }

  private render(): void {
    const root = this.root;
    const state = this.state;
    if (!root || !state) return;
    const document = root.ownerDocument;

    const heading = document.createElement('h3');
    heading.id = `orcaxr-emboss-heading-${this.instanceId}`;
    heading.textContent = t('ui.embossPanel.embossText', 'Emboss text');
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';
    const activate = this.button('emboss-activate', state.active ? 'Embossing' : 'Emboss', () =>
      this.adapter.onActivate(),
    );
    activate.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    const apply = this.button('emboss-apply', state.volumeId ? 'Update text' : 'Add text', () =>
      this.adapter.onApply(),
    );
    apply.disabled = !state.fontName || (!state.objectId && !state.volumeId);
    controls.append(activate, apply);

    const font = document.createElement('input');
    font.type = 'file';
    font.accept = '.ttf,.ttc,font/ttf,font/collection';
    font.id = `orcaxr-emboss-font-${this.instanceId}`;
    font.dataset.embossFont = 'true';
    font.style.cssText = 'max-width:100%;font:inherit;color:inherit;';
    font.addEventListener('change', () => {
      const file = font.files?.[0];
      if (!file) return;
      void this.run(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.adapter.onLoadFont(file.name, bytes);
      });
    });
    const fontLabel = this.field(
      font,
      state.fontName ? `Font — ${state.fontName}` : 'Font (.ttf)',
      `orcaxr-emboss-font-${this.instanceId}`,
    );

    const text = document.createElement('textarea');
    text.id = `orcaxr-emboss-text-${this.instanceId}`;
    text.dataset.embossText = 'true';
    text.rows = 2;
    text.value = state.text;
    text.style.cssText =
      'width:100%;box-sizing:border-box;padding:6px;border-radius:6px;resize:vertical;' +
      'border:1px solid var(--oxr-color-border,#30363d);background:var(--oxr-color-surface,#0d1117);' +
      'color:inherit;font:inherit;';
    text.addEventListener('change', () => {
      void this.run(() => this.adapter.onConfigure({ text: text.value }));
    });
    const textLabel = this.field(text, 'Text', text.id);

    const numbers = document.createElement('div');
    numbers.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    numbers.append(
      this.numberField('size', 'Size (mm)', state.sizeMm, 0.1, (value) => this.adapter.onConfigure({ sizeMm: value })),
      this.numberField('depth', 'Depth (mm)', state.depthMm, 0.1, (value) =>
        this.adapter.onConfigure({ depthMm: value }),
      ),
      this.numberField('char-gap', 'Letter gap (mm)', state.charGapMm, 0.1, (value) =>
        this.adapter.onConfigure({ charGapMm: value }),
      ),
      this.numberField('line-gap', 'Line gap (mm)', state.lineGapMm, 0.1, (value) =>
        this.adapter.onConfigure({ lineGapMm: value }),
      ),
    );

    const alignment = document.createElement('div');
    alignment.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    alignment.append(
      this.selectField('horizontal', 'Horizontal', state.horizontal, ['left', 'center', 'right'], (value) =>
        this.adapter.onConfigure({ horizontal: value as 'left' | 'center' | 'right' }),
      ),
      this.selectField('vertical', 'Vertical', state.vertical, ['top', 'center', 'bottom'], (value) =>
        this.adapter.onConfigure({ vertical: value as 'top' | 'center' | 'bottom' }),
      ),
    );

    const hint = document.createElement('p');
    hint.dataset.embossHint = 'true';
    hint.setAttribute('role', 'status');
    hint.style.cssText = 'margin:0;opacity:0.75;';
    hint.textContent = state.hint;

    root.replaceChildren(heading, controls, fontLabel, textLabel, numbers, alignment, hint);
  }

  private field(control: HTMLElement, label: string, htmlFor: string): HTMLLabelElement {
    const element = this.container.ownerDocument.createElement('label');
    element.htmlFor = htmlFor;
    element.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0;opacity:0.85;';
    const caption = this.container.ownerDocument.createElement('span');
    caption.textContent = label;
    element.append(caption, control);
    return element;
  }

  private numberField(
    key: string,
    label: string,
    value: number,
    step: number,
    commit: (value: number) => void | Promise<void>,
  ): HTMLLabelElement {
    const input = this.container.ownerDocument.createElement('input');
    input.type = 'number';
    input.step = `${step}`;
    input.min = '0';
    input.id = `orcaxr-emboss-${key}-${this.instanceId}`;
    input.dataset.embossField = key;
    input.value = `${Number(value.toFixed(3))}`;
    input.style.cssText =
      'width:96px;padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    input.addEventListener('change', () => {
      void this.run(() => commit(Number(input.value)));
    });
    return this.field(input, label, input.id);
  }

  private selectField(
    key: string,
    label: string,
    value: string,
    options: readonly string[],
    commit: (value: string) => void | Promise<void>,
  ): HTMLLabelElement {
    const select = this.container.ownerDocument.createElement('select');
    select.id = `orcaxr-emboss-${key}-${this.instanceId}`;
    select.dataset.embossField = key;
    select.style.cssText =
      'padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    for (const option of options) {
      const element = this.container.ownerDocument.createElement('option');
      element.value = option;
      element.textContent = option;
      element.selected = option === value;
      select.appendChild(element);
    }
    select.addEventListener('change', () => {
      void this.run(() => commit(select.value));
    });
    return this.field(select, label, select.id);
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.embossAction = id;
    button.textContent = label;
    button.style.cssText =
      'min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;' +
      'background:transparent;color:inherit;cursor:pointer;';
    button.addEventListener('click', () => void this.run(run));
    return button;
  }

  private async run(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.adapter.onError?.(error);
    } finally {
      this.refresh();
    }
  }
}
