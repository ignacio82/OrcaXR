export interface SvgPanelState {
  readonly active: boolean;
  /** Absent when the selection does not resolve to exactly one part. */
  readonly objectId?: string;
  /** Present when the selected part is itself an SVG part a change re-cuts. */
  readonly volumeId?: string;
  /** Absent until the operator picks a drawing. */
  readonly fileName?: string;
  readonly depthMm: number;
  /** Undefined keeps the drawing's own physical size. */
  readonly widthMm?: number;
  /** What the drawing contains that cannot become solid geometry. */
  readonly unsupported: readonly { readonly element: string; readonly detail: string }[];
  readonly hint: string;
}

export interface SvgPanelAdapter {
  getState(): SvgPanelState;
  subscribe?(listener: () => void): () => void;
  onActivate(): void | Promise<void>;
  onLoadDrawing(name: string, source: string): void | Promise<void>;
  onConfigure(patch: { depthMm?: number; widthMm?: number }): void | Promise<void>;
  onApply(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

/**
 * SVG part surface.
 *
 * The drawing is a file the operator picks — nothing is fetched under the app
 * CSP. Whatever the drawing contains that cannot become a solid is listed in
 * the panel rather than quietly missing from the cut part.
 */
export class SvgPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: SvgPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SvgPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.svgPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-svg-heading-${this.instanceId}`);
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
    heading.id = `orcaxr-svg-heading-${this.instanceId}`;
    heading.textContent = 'SVG part';
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';
    const activate = this.button('svg-activate', state.active ? 'Cutting' : 'SVG part', () =>
      this.adapter.onActivate(),
    );
    activate.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    const apply = this.button('svg-apply', state.volumeId ? 'Update part' : 'Add part', () => this.adapter.onApply());
    apply.disabled = !state.fileName || (!state.objectId && !state.volumeId);
    controls.append(activate, apply);

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.svg,image/svg+xml';
    file.id = `orcaxr-svg-file-${this.instanceId}`;
    file.dataset.svgFile = 'true';
    file.style.cssText = 'max-width:100%;font:inherit;color:inherit;';
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      void this.run(async () => {
        await this.adapter.onLoadDrawing(chosen.name, await chosen.text());
      });
    });
    const fileLabel = this.field(file, state.fileName ? `Drawing — ${state.fileName}` : 'Drawing (.svg)', file.id);

    const numbers = document.createElement('div');
    numbers.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    numbers.append(
      this.numberField('depth', 'Depth (mm)', state.depthMm, (value) => this.adapter.onConfigure({ depthMm: value })),
      this.numberField('width', 'Width (mm, 0 keeps size)', state.widthMm ?? 0, (value) =>
        this.adapter.onConfigure({ widthMm: value }),
      ),
    );

    const hint = document.createElement('p');
    hint.dataset.svgHint = 'true';
    hint.setAttribute('role', 'status');
    hint.style.cssText = 'margin:0;opacity:0.75;';
    hint.textContent = state.hint;

    const children: HTMLElement[] = [heading, controls, fileLabel, numbers, hint];

    if (state.unsupported.length > 0) {
      // Named, not silently dropped: the part will not look like the drawing,
      // and the operator is entitled to know exactly why before cutting it.
      const list = document.createElement('ul');
      list.dataset.svgUnsupported = 'true';
      list.setAttribute('aria-label', 'Parts of this drawing that cannot be cut');
      list.style.cssText =
        'margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:4px;opacity:0.85;';
      for (const entry of state.unsupported) {
        const item = document.createElement('li');
        item.textContent = entry.detail;
        list.appendChild(item);
      }
      children.push(list);
    }

    root.replaceChildren(...children);
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
    commit: (value: number) => void | Promise<void>,
  ): HTMLLabelElement {
    const input = this.container.ownerDocument.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.id = `orcaxr-svg-${key}-${this.instanceId}`;
    input.dataset.svgField = key;
    input.value = `${Number(value.toFixed(3))}`;
    input.style.cssText =
      'width:120px;padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    input.addEventListener('change', () => {
      void this.run(() => commit(Number(input.value)));
    });
    return this.field(input, label, input.id);
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.svgAction = id;
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
