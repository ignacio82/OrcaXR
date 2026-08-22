import { t } from '../../l10n/t';
export interface BrimEarView {
  readonly positionMm: readonly [number, number, number];
  readonly headFrontRadiusMm: number;
}

export interface BrimEarsPanelState {
  readonly active: boolean;
  /** Absent when the selection does not resolve to exactly one part. */
  readonly objectId?: string;
  readonly radiusMm: number;
  readonly minRadiusMm: number;
  readonly maxRadiusMm: number;
  readonly ears: readonly BrimEarView[];
  /** Indices into `ears` that reach nothing and will hold nothing down. */
  readonly stranded: readonly number[];
  readonly hint: string;
  /** Present only when `stranded` is non-empty. */
  readonly warning?: string;
}

export interface BrimEarsPanelAdapter {
  getState(): BrimEarsPanelState;
  subscribe?(listener: () => void): () => void;
  onActivate(): void | Promise<void>;
  onSetRadius(radiusMm: number): void | Promise<void>;
  onRemove(index: number): void | Promise<void>;
  /** Place ears on every corner that would peel, as one undoable entry. */
  onAutoPlace(): void | Promise<void>;
  onClear(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

/**
 * Brim-ear placement surface. Ears are placed by clicking the model, so this
 * panel owns only the radius, the placed list, and removal — every one of which
 * is a canonical undoable command.
 */
export class BrimEarsPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: BrimEarsPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: BrimEarsPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.brimEarsPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-brim-ears-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text);' +
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
    heading.id = `orcaxr-brim-ears-heading-${this.instanceId}`;
    heading.textContent = t('ui.brimEarsPanel.brimEars', 'Brim ears');
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';
    const activate = this.button('brim-ears-activate', state.active ? 'Placing' : 'Place ears', () =>
      this.adapter.onActivate(),
    );
    activate.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    const auto = this.button('brim-ears-auto', 'Place on corners', () => this.adapter.onAutoPlace());
    auto.disabled = state.objectId === undefined;
    auto.title = t(
      'ui.brimEarsPanel.findTheFirstLayerCorners',
      'Find the first-layer corners that would lift and put an ear on each',
    );
    const clear = this.button('brim-ears-clear', 'Clear all', () => this.adapter.onClear());
    clear.disabled = state.ears.length === 0;
    controls.append(activate, auto, clear);

    const radius = document.createElement('input');
    radius.type = 'number';
    radius.step = '0.1';
    radius.min = `${state.minRadiusMm}`;
    radius.max = `${state.maxRadiusMm}`;
    radius.id = `orcaxr-brim-ears-radius-${this.instanceId}`;
    radius.dataset.brimEarsRadius = 'true';
    radius.value = `${state.radiusMm}`;
    radius.disabled = !state.objectId;
    radius.style.cssText =
      'width:90px;padding:6px;border-radius:6px;border:1px solid var(--oxr-stroke);' +
      'background:var(--oxr-color-surface);color:inherit;font:inherit;';
    radius.addEventListener('change', () => {
      void this.run(() => this.adapter.onSetRadius(Number(radius.value)));
    });
    const radiusLabel = document.createElement('label');
    radiusLabel.htmlFor = radius.id;
    radiusLabel.textContent = t('ui.brimEarsPanel.earRadiusMm', 'Ear radius (mm)');
    radiusLabel.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:0.75;';
    radiusLabel.appendChild(radius);

    const hint = document.createElement('p');
    hint.dataset.brimEarsHint = 'true';
    hint.setAttribute('role', 'status');
    hint.style.cssText = 'margin:0;opacity:0.75;';
    hint.textContent = state.hint;

    const children: HTMLElement[] = [heading, controls, radiusLabel, hint];

    if (state.warning) {
      // An alert rather than a status: a stranded ear is silent everywhere else
      // — it slices clean and prints an island — so this is the only place the
      // operator can learn it before the print does.
      const warning = document.createElement('p');
      warning.dataset.brimEarsWarning = 'true';
      warning.setAttribute('role', 'alert');
      warning.style.cssText = 'margin:0;color:var(--oxr-color-danger);';
      warning.textContent = state.warning;
      children.push(warning);
    }

    if (state.ears.length > 0) {
      const list = document.createElement('ol');
      list.dataset.brimEars = 'true';
      list.setAttribute('aria-label', t('ui.brimEarsPanel.placedBrimEars', 'Placed brim ears'));
      list.style.cssText = 'margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:4px;';
      for (const [index, ear] of state.ears.entries()) {
        const item = document.createElement('li');
        item.dataset.brimEarIndex = `${index}`;
        item.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const stranded = state.stranded.includes(index);
        if (stranded) item.dataset.brimEarStranded = 'true';
        const label = document.createElement('span');
        // The colour matches the red disc on the model, so the list entry and
        // the thing it names are recognisably the same ear.
        if (stranded) label.style.cssText = 'color:var(--oxr-color-danger);';
        label.textContent =
          `${ear.positionMm.map(format).join(', ')} mm · ⌀${format(ear.headFrontRadiusMm * 2)} mm` +
          (stranded ? ' · does not reach the part' : '');
        const remove = this.button(`brim-ear-remove-${index}`, 'Remove', () => this.adapter.onRemove(index));
        remove.style.cssText += 'min-height:28px;padding:2px 8px;';
        item.append(label, remove);
        list.appendChild(item);
      }
      children.push(list);
    }

    root.replaceChildren(...children);
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.brimEarsAction = id;
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

function format(value: number): string {
  return `${Number(value.toFixed(2))}`;
}
