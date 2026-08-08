import type { GcodePreviewMode } from '../../slicer/GcodePreviewModel';
import type { GcodePreviewMoveFilterId, GcodePreviewViewPatch } from '../../slicer/GcodePreviewSession';

export interface GcodePreviewPanelLegendEntry {
  readonly id: string;
  readonly label: string;
  readonly code: string;
  readonly accessibleLabel: string;
  readonly color: string;
}

export interface GcodePreviewPanelState {
  readonly active: boolean;
  readonly source?: { readonly kind: 'slice' | 'file'; readonly name: string };
  readonly view?: {
    readonly mode: GcodePreviewMode;
    readonly layerRange: readonly [number, number];
    readonly singleLayer: boolean;
    readonly moveVisibility: Readonly<Record<GcodePreviewMoveFilterId, boolean>>;
  };
  readonly layerBounds?: readonly [number, number];
  readonly modes: readonly { readonly id: GcodePreviewMode; readonly label: string; readonly unit: string | null }[];
  readonly moveFilters: readonly { readonly id: GcodePreviewMoveFilterId; readonly label: string }[];
  readonly legend: readonly GcodePreviewPanelLegendEntry[];
  readonly range?: { readonly min: number; readonly max: number; readonly unit: string; readonly scale: string };
  readonly unsupportedReason?: string;
  readonly limitations: readonly string[];
  readonly layerLabel?: string;
}

export interface GcodePreviewPanelAdapter {
  getState(): GcodePreviewPanelState;
  subscribe?(listener: () => void): () => void;
  onUpdateView(patch: GcodePreviewViewPatch): void | Promise<void>;
  onOpenGcode?(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

/**
 * Accessible G-code preview controls: view mode, layer window, single-layer
 * mode, move-class filters, and a legend whose entries carry a code and text
 * label so nothing is conveyed by colour alone. Every control reports the
 * projection's own metadata, including why a mode is unsupported.
 */
export class GcodePreviewPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: GcodePreviewPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: GcodePreviewPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.gcodePreviewPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-preview-heading-${this.instanceId}`);
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
    root.replaceChildren();

    const heading = document.createElement('h3');
    heading.id = `orcaxr-preview-heading-${this.instanceId}`;
    heading.textContent = 'G-code preview';
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';
    root.append(heading);

    if (this.adapter.onOpenGcode) {
      const open = document.createElement('button');
      open.type = 'button';
      open.dataset.previewOpenGcode = 'true';
      open.textContent = 'Open G-code file…';
      open.style.cssText = controlStyle(false);
      open.onclick = () => void this.run(() => this.adapter.onOpenGcode?.());
      root.append(open);
    }

    const status = document.createElement('p');
    status.dataset.previewStatus = 'true';
    status.style.cssText = 'margin:0;opacity:0.75;';
    status.textContent = state.active
      ? `Showing ${state.source?.name ?? 'sliced G-code'}${state.layerLabel ? ` — ${state.layerLabel}` : ''}`
      : 'Slice the plate or open a G-code file to inspect toolpaths.';
    root.append(status);
    if (!state.active || !state.view || !state.layerBounds) return;

    root.append(this.renderModes(state));
    root.append(this.renderLayerControls(state));
    root.append(this.renderMoveFilters(state));

    if (state.unsupportedReason) {
      const unsupported = document.createElement('p');
      unsupported.dataset.previewUnsupported = 'true';
      unsupported.setAttribute('role', 'status');
      unsupported.style.cssText = 'margin:0;color:var(--oxr-color-warning,#ffb74d);';
      unsupported.textContent = state.unsupportedReason;
      root.append(unsupported);
    }
    if (state.legend.length > 0) root.append(this.renderLegend(state));
    if (state.range) {
      const range = document.createElement('p');
      range.dataset.previewRange = 'true';
      range.style.cssText = 'margin:0;opacity:0.8;';
      range.textContent = `${format(state.range.min)}–${format(state.range.max)} ${state.range.unit} (${state.range.scale})`;
      root.append(range);
    }
    for (const limitation of state.limitations) {
      const note = document.createElement('p');
      note.dataset.previewLimitation = 'true';
      note.style.cssText = 'margin:0;opacity:0.8;';
      note.textContent = limitation;
      root.append(note);
    }
  }

  private renderModes(state: GcodePreviewPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    wrapper.htmlFor = `orcaxr-preview-mode-${this.instanceId}`;
    const text = document.createElement('span');
    text.textContent = 'View';
    const select = document.createElement('select');
    select.id = wrapper.htmlFor;
    select.dataset.previewMode = 'true';
    select.style.cssText = 'min-height:36px;flex:1 1 auto;border-radius:6px;padding:4px 6px;';
    for (const mode of state.modes) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.unit ? `${mode.label} (${mode.unit})` : mode.label;
      option.selected = state.view?.mode === mode.id;
      select.append(option);
    }
    select.onchange = () => void this.run(() => this.adapter.onUpdateView({ mode: select.value as GcodePreviewMode }));
    wrapper.append(text, select);
    return wrapper;
  }

  private renderLayerControls(state: GcodePreviewPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('div');
    group.dataset.previewLayers = 'true';
    group.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const [minLayer, maxLayer] = state.layerBounds as readonly [number, number];
    const [low, high] = state.view?.layerRange ?? [minLayer, maxLayer];

    group.append(
      this.renderSlider('Top layer', 'preview-layer-high', high, minLayer, maxLayer, (value) =>
        this.adapter.onUpdateView({ layerRange: [Math.min(low, value), value] }),
      ),
    );
    group.append(
      this.renderSlider('Bottom layer', 'preview-layer-low', low, minLayer, maxLayer, (value) =>
        this.adapter.onUpdateView({ layerRange: [value, Math.max(high, value)] }),
      ),
    );

    const single = document.createElement('label');
    single.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.previewSingleLayer = 'true';
    checkbox.checked = state.view?.singleLayer ?? false;
    checkbox.style.cssText = 'width:18px;height:18px;';
    checkbox.onchange = () => void this.run(() => this.adapter.onUpdateView({ singleLayer: checkbox.checked }));
    const label = document.createElement('span');
    label.textContent = 'Single layer';
    single.append(checkbox, label);
    group.append(single);
    return group;
  }

  private renderMoveFilters(state: GcodePreviewPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('fieldset');
    group.dataset.previewMoveFilters = 'true';
    group.style.cssText = 'border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Moves';
    legend.style.cssText = 'padding:0;font-size:12px;opacity:0.8;';
    group.append(legend);
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    for (const filter of state.moveFilters) {
      const wrapper = document.createElement('label');
      wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:32px;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.previewMoveFilter = filter.id;
      checkbox.checked = state.view?.moveVisibility[filter.id] ?? false;
      checkbox.style.cssText = 'width:18px;height:18px;';
      checkbox.onchange = () =>
        void this.run(() => this.adapter.onUpdateView({ moveVisibility: { [filter.id]: checkbox.checked } }));
      const label = document.createElement('span');
      label.textContent = filter.label;
      wrapper.append(checkbox, label);
      list.append(wrapper);
    }
    group.append(list);
    return group;
  }

  private renderLegend(state: GcodePreviewPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const list = document.createElement('ul');
    list.dataset.previewLegend = 'true';
    list.setAttribute('aria-label', 'Preview legend');
    list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;';
    for (const entry of state.legend) {
      const item = document.createElement('li');
      item.dataset.previewLegendEntry = entry.id;
      item.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const swatch = document.createElement('span');
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.cssText = `width:14px;height:14px;border-radius:3px;flex:none;background:${entry.color};`;
      const text = document.createElement('span');
      text.textContent = `${entry.code} · ${entry.label}`;
      item.title = entry.accessibleLabel;
      item.append(swatch, text);
      list.append(item);
    }
    return list;
  }

  private renderSlider(
    label: string,
    id: string,
    value: number,
    min: number,
    max: number,
    apply: (value: number) => void | Promise<void>,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;';
    wrapper.htmlFor = `orcaxr-${id}-${this.instanceId}`;
    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'min-width:92px;';
    const input = document.createElement('input');
    input.id = wrapper.htmlFor;
    input.dataset.previewSlider = id;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    input.setAttribute('aria-valuetext', `Layer ${value} of ${max}`);
    input.style.cssText = 'flex:1 1 auto;min-height:32px;';
    input.onchange = () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        input.value = String(value);
        return;
      }
      void this.run(() => apply(parsed));
    };
    const readout = document.createElement('span');
    readout.textContent = String(value);
    readout.style.cssText = 'min-width:32px;text-align:right;';
    wrapper.append(text, input, readout);
    return wrapper;
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

function controlStyle(selected: boolean): string {
  return (
    'min-height:44px;padding:8px 12px;border-radius:8px;cursor:pointer;color:inherit;' +
    `border:2px solid ${selected ? 'var(--oxr-color-accent,#4fc3f7)' : 'rgba(255,255,255,0.24)'};` +
    `background:rgba(255,255,255,${selected ? 0.12 : 0.06});`
  );
}

function format(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}
