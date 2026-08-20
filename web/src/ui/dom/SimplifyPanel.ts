import { t } from '../../l10n/t';
/**
 * The pinned Simplify gizmo's controls (P5.3.5).
 *
 * Decimation is the one edit whose result cannot be inspected afterwards —
 * what it removed is gone — so the pinned gizmo previews before it applies, and
 * so does this. The panel drives a preview, reports the counts it produced, and
 * offers exactly two ways out: keep it, or put the model back.
 *
 * Both pinned modes are here rather than one. `use_count` asks for a share of
 * the triangles and is what an operator reaches for when the target is a file
 * size; the quadric error limit asks how much shape may be lost and is what
 * they reach for when the target is fidelity. Exposing only the first, as the
 * one-shot action did, quietly decides which of those questions they were
 * allowed to ask.
 */

export interface SimplifyPanelState {
  readonly hasSelection: boolean;
  readonly previewing: boolean;
  /** Pinned `use_count`: drive by triangle count rather than quadric error. */
  readonly useCount: boolean;
  readonly decimateRatio: number;
  readonly maxError: number;
  readonly parts: number;
  readonly beforeTriangles: number;
  readonly afterTriangles: number;
  /** The run stopped because the next collapse would exceed `maxError`. */
  readonly stoppedOnError: boolean;
}

export interface SimplifyPanelAdapter {
  getState(): SimplifyPanelState;
  subscribe?(listener: () => void): () => void;
  onPreview(configuration: {
    readonly useCount: boolean;
    readonly decimateRatio: number;
    readonly maxError: number;
  }): void | Promise<void>;
  onApply(): void | Promise<void>;
  onCancel(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

export class SimplifyPanel {
  private readonly instanceId = (panelSequence += 1);
  private unsubscribe: (() => void) | null = null;
  private useCount: boolean | null = null;
  private ratio: number | null = null;
  private error: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SimplifyPanelAdapter,
  ) {}

  mount(): void {
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh()) ?? null;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.replaceChildren();
  }

  refresh(): void {
    const state = this.adapter.getState();
    // Locally held while previewing, so a re-render triggered by the preview
    // itself cannot snap the fields back and lose what was typed.
    const useCount = this.useCount ?? state.useCount;
    const ratio = this.ratio ?? state.decimateRatio;
    const error = this.error ?? state.maxError;

    const doc = this.container.ownerDocument;
    const root = this.container;

    const heading = doc.createElement('h3');
    heading.textContent = 'Simplify';
    heading.style.cssText = 'margin:0;font-size:0.95rem;';

    const mode = doc.createElement('fieldset');
    mode.style.cssText = 'border:0;margin:0;padding:0;display:flex;gap:12px;align-items:center;';
    const legend = doc.createElement('legend');
    legend.textContent = t('ui.simplifyPanel.decimateBy', 'Decimate by');
    legend.style.cssText = 'padding:0;opacity:0.75;';
    mode.appendChild(legend);
    for (const option of [
      { id: 'count', label: 'Triangle count', on: useCount },
      { id: 'error', label: 'Shape error', on: !useCount },
    ]) {
      const label = doc.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = `orcaxr-simplify-mode-${this.instanceId}`;
      radio.dataset.simplifyMode = option.id;
      radio.checked = option.on;
      radio.disabled = state.previewing;
      radio.addEventListener('change', () => {
        this.useCount = option.id === 'count';
        this.refresh();
      });
      label.append(radio, doc.createTextNode(option.label));
      mode.appendChild(label);
    }

    const ratioField = this.number('simplify-ratio', 'Remove (%)', ratio, 0, 100, 1, state.previewing, (value) => {
      this.ratio = value;
    });
    const errorField = this.number('simplify-error', 'Max error', error, 0, 100, 0.01, state.previewing, (value) => {
      this.error = value;
    });
    // The inactive mode's field is disabled rather than hidden: a control that
    // vanishes reads as unsupported, and both of these are supported.
    ratioField.input.disabled = state.previewing || !useCount;
    errorField.input.disabled = state.previewing || useCount;

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const preview = this.button('simplify-preview', 'Preview', () =>
      this.adapter.onPreview({ useCount, decimateRatio: ratio, maxError: error }),
    );
    preview.disabled = !state.hasSelection || state.previewing;
    const apply = this.button('simplify-apply', 'Apply', async () => {
      await this.adapter.onApply();
      this.clearLocalEdits();
    });
    apply.disabled = !state.previewing;
    const cancel = this.button('simplify-cancel', 'Cancel', async () => {
      await this.adapter.onCancel();
      this.clearLocalEdits();
    });
    cancel.disabled = !state.previewing;
    controls.append(preview, apply, cancel);

    const status = doc.createElement('p');
    status.dataset.simplifyStatus = 'true';
    status.setAttribute('role', 'status');
    status.style.cssText = 'margin:0;opacity:0.75;';
    if (!state.hasSelection)
      status.textContent = t('ui.simplifyPanel.selectAModelToSimplify', 'Select a model to simplify.');
    else if (!state.previewing)
      status.textContent = t(
        'ui.simplifyPanel.previewShowsTheResultOn',
        'Preview shows the result on the model; nothing is changed until you apply.',
      );
    else {
      const removed = state.beforeTriangles - state.afterTriangles;
      const share = state.beforeTriangles > 0 ? Math.round((removed / state.beforeTriangles) * 100) : 0;
      status.textContent =
        `Previewing ${state.parts} part(s): ${state.beforeTriangles} → ${state.afterTriangles} triangles ` +
        `(${share}% removed).` +
        (state.stoppedOnError ? ' Stopped at the error limit before reaching the target.' : '');
    }

    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    root.replaceChildren(heading, mode, ratioField.label, errorField.label, controls, status);
  }

  private clearLocalEdits(): void {
    this.useCount = null;
    this.ratio = null;
    this.error = null;
    this.refresh();
  }

  private number(
    id: string,
    text: string,
    value: number,
    min: number,
    max: number,
    step: number,
    disabled: boolean,
    onChange: (value: number) => void,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const doc = this.container.ownerDocument;
    const input = doc.createElement('input');
    input.type = 'number';
    input.id = `orcaxr-${id}-${this.instanceId}`;
    input.dataset.simplifyField = id;
    input.min = `${min}`;
    input.max = `${max}`;
    input.step = `${step}`;
    input.value = `${value}`;
    input.disabled = disabled;
    input.style.cssText =
      'width:90px;padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) onChange(next);
    });
    const label = doc.createElement('label');
    label.htmlFor = input.id;
    label.textContent = text;
    label.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:0.75;';
    label.appendChild(input);
    return { label, input };
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.simplifyAction = id;
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
