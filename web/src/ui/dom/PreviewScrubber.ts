/**
 * PreviewScrubber — the layer slider docked to the bottom of the 3D viewport.
 *
 * Scrubbing layers is the one preview control a maker reaches for constantly,
 * and hunting for it inside the inspector breaks the loop of "move the slider,
 * look at the plate". This surface puts it directly under the model.
 *
 * It is a *view* of the same {@link GcodePreviewPanelAdapter} the inspector's
 * G-code preview panel uses — the identical `onUpdateView` seam, the identical
 * projected state. There is no second source of truth, and every readout comes
 * from the projection: when the projection reports no layer bounds, the
 * scrubber hides itself rather than inventing a range.
 */
import type { UiState } from '../../actions/UiState';
import type { GcodePreviewPanelAdapter, GcodePreviewPanelState } from './GcodePreviewPanel';
import { t } from '../../l10n/t';

export class PreviewScrubber {
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private slider?: HTMLInputElement;
  private layerReadout?: HTMLElement;
  private zReadout?: HTMLElement;
  private legend?: HTMLElement;
  private legendSignature = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: GcodePreviewPanelAdapter,
    private readonly ui: UiState,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;

    const root = document.createElement('div');
    root.dataset.previewScrubber = 'true';
    root.className = 'preview-scrubber';

    const layerReadout = document.createElement('span');
    layerReadout.className = 'preview-scrubber-layer';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.step = '1';
    slider.className = 'preview-scrubber-range';
    slider.dataset.previewScrubberRange = 'true';
    slider.setAttribute('aria-label', t('ui.previewScrubber.topVisibleLayer', 'Top visible layer'));
    slider.oninput = () => this.commit(Number(slider.value));

    const zReadout = document.createElement('span');
    zReadout.className = 'preview-scrubber-z';

    const legend = document.createElement('div');
    legend.className = 'preview-scrubber-legend';

    root.append(layerReadout, slider, zReadout, legend);
    this.container.replaceChildren(root);

    this.root = root;
    this.slider = slider;
    this.layerReadout = layerReadout;
    this.zReadout = zReadout;
    this.legend = legend;

    const unsubscribeAdapter = this.adapter.subscribe?.(() => this.refresh());
    // The scrubber belongs to the toolpath, not to the artifact: a finished
    // slice while still preparing must not put a layer slider over the model.
    const unsubscribeUi = this.ui.subscribe(() => this.refresh());
    this.unsubscribe = () => {
      unsubscribeAdapter?.();
      unsubscribeUi();
    };
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
    this.slider = undefined;
    this.layerReadout = undefined;
    this.zReadout = undefined;
    this.legend = undefined;
    this.legendSignature = '';
  }

  refresh(): void {
    if (!this.root) return;
    const state = this.adapter.getState();
    const bounds = state.layerBounds;
    const view = state.view;
    // No projected layer window — or no toolpath on screen — means there is
    // nothing honest to scrub.
    const previewing = this.ui.get().mode === 'preview';
    const usable = previewing && state.active && !!bounds && !!view && bounds[1] > bounds[0];
    this.container.hidden = !usable;
    if (!usable || !bounds || !view) return;

    const [minLayer, maxLayer] = bounds;
    const [low, high] = view.layerRange;
    const slider = this.slider;
    if (slider) {
      slider.min = String(minLayer);
      slider.max = String(maxLayer);
      if (document.activeElement !== slider) slider.value = String(high);
      slider.setAttribute('aria-valuetext', `Layer ${high} of ${maxLayer}`);
    }
    if (this.layerReadout) this.layerReadout.textContent = `L ${high} / ${maxLayer}`;
    if (this.zReadout) {
      // The projection owns the height; only render one when it supplies one.
      this.zReadout.textContent =
        typeof state.layerTopZMm === 'number' ? `Z ${state.layerTopZMm.toFixed(2)} mm` : 'Z —';
    }
    this.renderLegend(state);
    // Keep the low edge reachable through the slider without a second control:
    // dragging always moves the top of the window, never inverts it.
    if (low > high && slider) slider.value = String(low);
  }

  private renderLegend(state: GcodePreviewPanelState): void {
    const legend = this.legend;
    if (!legend) return;
    const signature = state.legend.map((entry) => `${entry.id}:${entry.color}:${entry.label}`).join('|');
    if (signature === this.legendSignature) return;
    this.legendSignature = signature;
    legend.replaceChildren();
    for (const entry of state.legend) {
      const chip = legend.ownerDocument.createElement('span');
      chip.className = 'preview-scrubber-role';
      chip.dataset.previewScrubberRole = entry.id;
      const swatch = legend.ownerDocument.createElement('span');
      swatch.className = 'preview-scrubber-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.background = entry.color;
      const label = legend.ownerDocument.createElement('span');
      // The code keeps the entry readable without relying on colour alone.
      label.textContent = `${entry.code} ${entry.label}`;
      chip.append(swatch, label);
      chip.title = entry.accessibleLabel;
      legend.appendChild(chip);
    }
  }

  private commit(value: number): void {
    if (!Number.isFinite(value)) return;
    const state = this.adapter.getState();
    const low = state.view?.layerRange[0] ?? value;
    void Promise.resolve(this.adapter.onUpdateView({ layerRange: [Math.min(low, value), value] })).catch((error) =>
      this.adapter.onError?.(error),
    );
  }
}
