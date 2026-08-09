export interface MeasurePickView {
  readonly kind: 'point' | 'edge' | 'circle' | 'plane';
  readonly summary: string;
  readonly diameterMm?: number;
}

export interface MeasurePanelState {
  readonly active: boolean;
  readonly picks: readonly MeasurePickView[];
  readonly distanceMm?: number;
  /** `strict` is the bounded feature; `infinite` is its unbounded line/plane. */
  readonly distanceKind?: 'strict' | 'infinite';
  readonly distanceXyzMm?: readonly [number, number, number];
  readonly angleDeg?: number;
  readonly unsupportedReason?: string;
  readonly hint: string;
}

export interface MeasurePanelAdapter {
  getState(): MeasurePanelState;
  subscribe?(listener: () => void): () => void;
  onActivate(): void | Promise<void>;
  onClear(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

/**
 * Measurement readout. It renders exactly the numbers the canonical
 * measurement produced: a value the engine's algorithm does not cover is shown
 * as a stated reason, never as a rounded stand-in.
 */
export class MeasurePanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: MeasurePanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: MeasurePanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.measurePanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-measure-heading-${this.instanceId}`);
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
    heading.id = `orcaxr-measure-heading-${this.instanceId}`;
    heading.textContent = 'Measure';
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    const activate = this.button('measure-activate', state.active ? 'Measuring' : 'Measure', () =>
      this.adapter.onActivate(),
    );
    activate.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    controls.append(
      activate,
      this.button('measure-clear', 'Clear', () => this.adapter.onClear()),
    );

    const hint = document.createElement('p');
    hint.dataset.measureHint = 'true';
    hint.setAttribute('role', 'status');
    hint.style.cssText = 'margin:0;opacity:0.75;';
    hint.textContent = state.hint;

    const picks = document.createElement('ol');
    picks.dataset.measurePicks = 'true';
    picks.setAttribute('aria-label', 'Picked features');
    picks.style.cssText = 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;';
    for (const pick of state.picks) {
      const item = document.createElement('li');
      item.dataset.measurePickKind = pick.kind;
      item.textContent = pick.summary;
      picks.appendChild(item);
    }

    const children: HTMLElement[] = [heading, controls, hint];
    if (state.picks.length > 0) children.push(picks);

    const readout = document.createElement('dl');
    readout.dataset.measureReadout = 'true';
    readout.style.cssText = 'margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;';
    let rows = 0;
    if (state.distanceMm !== undefined) {
      rows += 1;
      appendRow(
        readout,
        state.distanceKind === 'infinite' ? 'Distance (to line/plane)' : 'Distance',
        `${format(state.distanceMm)} mm`,
        'distance',
      );
    }
    if (state.distanceXyzMm) {
      rows += 1;
      appendRow(readout, 'Δ X / Y / Z', state.distanceXyzMm.map((value) => `${format(value)} mm`).join(' / '), 'xyz');
    }
    if (state.angleDeg !== undefined) {
      rows += 1;
      appendRow(readout, 'Angle', `${format(state.angleDeg)}°`, 'angle');
    }
    for (const pick of state.picks) {
      if (pick.diameterMm === undefined) continue;
      rows += 1;
      appendRow(readout, 'Diameter', `${format(pick.diameterMm)} mm`, 'diameter');
    }
    if (rows > 0) children.push(readout);

    if (state.unsupportedReason) {
      const unsupported = document.createElement('p');
      unsupported.dataset.measureUnsupported = 'true';
      unsupported.setAttribute('role', 'status');
      unsupported.style.cssText = 'margin:0;opacity:0.85;';
      unsupported.textContent = state.unsupportedReason;
      children.push(unsupported);
    }

    root.replaceChildren(...children);
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.measureAction = id;
    button.textContent = label;
    button.style.cssText =
      'min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;' +
      'background:transparent;color:inherit;cursor:pointer;';
    button.addEventListener('click', () => {
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => this.adapter.onError?.(error))
        .finally(() => this.refresh());
    });
    return button;
  }
}

function appendRow(list: HTMLElement, label: string, value: string, key: string): void {
  const document = list.ownerDocument;
  const term = document.createElement('dt');
  term.textContent = label;
  term.style.cssText = 'opacity:0.75;';
  const definition = document.createElement('dd');
  definition.dataset.measureValue = key;
  definition.textContent = value;
  definition.style.cssText = 'margin:0;font-variant-numeric:tabular-nums;';
  list.append(term, definition);
}

/** Three decimals is the pinned readout precision; no value is padded. */
function format(value: number): string {
  return `${Number(value.toFixed(3))}`;
}
