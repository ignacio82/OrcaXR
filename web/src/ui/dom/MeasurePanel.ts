import { t } from '../../l10n/t';
export interface MeasurePickView {
  readonly kind: 'point' | 'edge' | 'circle' | 'plane';
  readonly summary: string;
  readonly diameterMm?: number;
}

/** Pinned alignments the current pick pair allows. */
export interface MeasureAssemblyView {
  readonly canSetToParallel: boolean;
  readonly canSetToCenterCoincidence: boolean;
  readonly canRotateAroundFaceCenter: boolean;
  readonly hasParallelDistance: boolean;
  readonly parallelDistanceMm: number;
  /** False when both picks sit on the same model, so nothing can move. */
  readonly movable: boolean;
  readonly hint: string;
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
  /** Present once two features are picked; absent hides the alignment controls. */
  readonly assembly?: MeasureAssemblyView;
}

export interface MeasurePanelAdapter {
  getState(): MeasurePanelState;
  subscribe?(listener: () => void): () => void;
  onActivate(): void | Promise<void>;
  onClear(): void | Promise<void>;
  onAlign?(kind: string, parameter?: number): void | Promise<void>;
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
    picks.setAttribute('aria-label', t('ui.measurePanel.pickedFeatures', 'Picked features'));
    picks.style.cssText = 'margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:2px;';
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

    if (state.assembly) children.push(this.renderAssembly(state.assembly));

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

  private renderAssembly(assembly: MeasureAssemblyView): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('fieldset');
    group.dataset.measureAssembly = 'true';
    group.style.cssText = 'margin:0;padding:8px;border:1px solid var(--oxr-color-border,#30363d);border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Align';
    legend.style.cssText = 'padding:0 4px;font-weight:600;';

    const hint = document.createElement('p');
    hint.dataset.measureAssemblyHint = 'true';
    hint.setAttribute('role', 'status');
    hint.style.cssText = 'margin:6px 0 0;opacity:0.75;';
    hint.textContent = assembly.hint;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
    const align = (id: string, label: string, enabled: boolean, parameter?: () => number | undefined): void => {
      const button = this.button(id, label, () => this.adapter.onAlign?.(id.replace('align-', ''), parameter?.()));
      button.disabled = !enabled || !assembly.movable;
      row.appendChild(button);
    };
    align('align-parallel', 'Parallel', assembly.canSetToParallel);
    align('align-center-coincidence', 'Centre coincidence', assembly.canSetToCenterCoincidence);
    align('align-reverse-rotation', 'Flip over', true);

    const distance = document.createElement('input');
    distance.type = 'number';
    distance.step = '0.1';
    distance.id = `orcaxr-measure-gap-${this.instanceId}`;
    distance.dataset.measureAssemblyDistance = 'true';
    distance.value = `${Number(assembly.parallelDistanceMm.toFixed(3))}`;
    distance.disabled = !assembly.hasParallelDistance || !assembly.movable;
    distance.style.cssText =
      'width:90px;padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    const distanceLabel = document.createElement('label');
    distanceLabel.htmlFor = distance.id;
    distanceLabel.textContent = t('ui.measurePanel.gapMm', 'Gap (mm)');
    distanceLabel.style.cssText = 'opacity:0.75;display:flex;align-items:center;gap:6px;margin-top:6px;';
    distanceLabel.appendChild(distance);
    align('align-parallel-distance', 'Set gap', assembly.hasParallelDistance, () => Number(distance.value));

    group.append(legend, hint, row, distanceLabel);
    return group;
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
