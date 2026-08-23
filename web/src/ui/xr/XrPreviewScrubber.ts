/**
 * XrPreviewScrubber — spatial G-code layer scrubber and move simulation deck in XR.
 *
 * Placed in front of the build plate during G-code inspection preview mode.
 * Provides interactive layer slider with fine single-layer steppers, Z height
 * readout, single-layer view toggle, line type legend pills, feature color
 * mode selector, move simulation, and layer event authoring triggers.
 */
import type { GcodePreviewMode } from '../../slicer/GcodePreviewModel';
import type { GcodePreviewViewPatch } from '../../slicer/GcodePreviewSession';
import type { GcodePreviewPanelState } from '../dom/GcodePreviewPanel';
import { createXrButton, createXrChip } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export interface XrPreviewScrubberHandlers {
  onUpdateView(patch: GcodePreviewViewPatch): void;
  onAuthorEvent?(type: 'pause' | 'custom', topZMm: number): void;
}

export interface XrPreviewScrubberRender<PanelNode, TextNode> {
  readonly root: PanelNode;
  readonly layerText: TextNode;
  readonly zText: TextNode;
  readonly legendContainer: PanelNode;
  refresh(state: GcodePreviewPanelState): void;
  dispose(): void;
}

export function renderXrPreviewScrubber<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  state: GcodePreviewPanelState,
  handlers: XrPreviewScrubberHandlers,
): XrPreviewScrubberRender<PanelNode, TextNode> {
  // Clear any existing children
  const bounds = state.layerBounds ?? [1, 1];
  const currentLayer = state.view?.layerRange[1] ?? bounds[1];
  const maxLayer = bounds[1];
  const topZ = typeof state.layerTopZMm === 'number' ? `Z ${state.layerTopZMm.toFixed(2)} mm` : 'Z —';

  const container = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    gap: 8,
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fillColor: '#0d141cF2',
    cornerRadius: tokens.radius.md,
    strokeWidth: 1,
    strokeColor: '#ffffff1a',
  });
  ui.appendChild(root, container);

  // Top Row: Layer Readout, Z height, and View Mode selector
  const headerRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  });
  ui.appendChild(container, headerRow);

  const layerText = ui.createText(`Layer ${currentLayer} / ${maxLayer}`, {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(headerRow, layerText);

  const zText = ui.createText(topZ, {
    fontSize: 14,
    fontWeight: 'medium',
    color: C.accentSoft,
  });
  ui.appendChild(headerRow, zText);

  // Mode cycle button
  const currentMode = state.view?.mode ?? 'feature';
  const modeLabel = state.modes.find((m) => m.id === currentMode)?.label ?? 'Feature';
  const modeBtn = createXrButton(ui, {
    label: `Mode: ${modeLabel}`,
    fontSize: 12,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 4,
    onClick: () => {
      const modeList = state.modes.map((m) => m.id);
      if (modeList.length === 0) return;
      const idx = (modeList as readonly string[]).indexOf(currentMode);
      const nextMode = modeList[(idx + 1) % modeList.length];
      handlers.onUpdateView({ mode: nextMode as GcodePreviewMode });
    },
  });
  ui.appendChild(headerRow, modeBtn.root);

  // Middle Row: Scrubber Stepper Controls (-10, -1, slider representation, +1, +10)
  const scrubberRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  });
  ui.appendChild(container, scrubberRow);

  const stepLayer = (delta: number) => {
    const next = Math.max(bounds[0], Math.min(bounds[1], currentLayer + delta));
    const low = state.view?.singleLayer ? next : (state.view?.layerRange[0] ?? bounds[0]);
    handlers.onUpdateView({ layerRange: [low, next] });
  };

  const jumpDown10 = createXrButton(ui, {
    label: '−10',
    fontSize: 12,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: () => stepLayer(-10),
  });
  ui.appendChild(scrubberRow, jumpDown10.root);

  const stepDown = createXrButton(ui, {
    label: '−1',
    fontSize: 13,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: () => stepLayer(-1),
  });
  ui.appendChild(scrubberRow, stepDown.root);

  // Layer track visual bar
  const progressRatio = maxLayer > bounds[0] ? (currentLayer - bounds[0]) / (maxLayer - bounds[0]) : 1;
  const track = ui.createPanel({
    flexGrow: 1,
    height: 10,
    cornerRadius: 5,
    fillColor: '#ffffff1a',
    flexDirection: 'row',
    alignItems: 'center',
  });
  const fill = ui.createPanel({
    width: `${Math.round(progressRatio * 100)}%` as any,
    height: '100%',
    cornerRadius: 5,
    fillColor: C.accent,
  });
  ui.appendChild(track, fill);
  ui.appendChild(scrubberRow, track);

  const stepUp = createXrButton(ui, {
    label: '+1',
    fontSize: 13,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: () => stepLayer(1),
  });
  ui.appendChild(scrubberRow, stepUp.root);

  const jumpUp10 = createXrButton(ui, {
    label: '+10',
    fontSize: 12,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: () => stepLayer(10),
  });
  ui.appendChild(scrubberRow, jumpUp10.root);

  // Single layer toggle button
  const isSingleLayer = state.view?.singleLayer ?? false;
  const singleLayerBtn = createXrButton(ui, {
    label: isSingleLayer ? 'Single Layer: ON' : 'Single Layer: OFF',
    fontSize: 11,
    selected: isSingleLayer,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 4,
    onClick: () => {
      const nextSingle = !isSingleLayer;
      const low = nextSingle ? currentLayer : bounds[0];
      handlers.onUpdateView({ singleLayer: nextSingle, layerRange: [low, currentLayer] });
    },
  });
  ui.appendChild(scrubberRow, singleLayerBtn.root);

  // Bottom Row: Line Type Legend Chips & Layer Event Authoring
  const bottomRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  });
  ui.appendChild(container, bottomRow);

  const legendContainer = ui.createPanel({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    flexGrow: 1,
  });
  ui.appendChild(bottomRow, legendContainer);

  for (const item of state.legend.slice(0, 6)) {
    const chip = createXrChip(ui, `${item.code} ${item.label}`, item.color);
    ui.appendChild(legendContainer, chip);
  }

  // Quick Layer Event trigger at this layer
  if (handlers.onAuthorEvent && typeof state.layerTopZMm === 'number') {
    const topZVal = state.layerTopZMm;
    const pauseBtn = createXrButton(ui, {
      label: `+ Pause at L${currentLayer}`,
      fontSize: 11,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: () => {
        handlers.onAuthorEvent?.('pause', topZVal);
      },
    });
    ui.appendChild(bottomRow, pauseBtn.root);
  }

  return {
    root: container,
    layerText,
    zText,
    legendContainer,
    refresh(nextState: GcodePreviewPanelState) {
      const nextBounds = nextState.layerBounds ?? [1, 1];
      const cur = nextState.view?.layerRange[1] ?? nextBounds[1];
      ui.setText(layerText, `Layer ${cur} / ${nextBounds[1]}`);
      const nextZ = typeof nextState.layerTopZMm === 'number' ? `Z ${nextState.layerTopZMm.toFixed(2)} mm` : 'Z —';
      ui.setText(zText, nextZ);
      const ratio = nextBounds[1] > nextBounds[0] ? (cur - nextBounds[0]) / (nextBounds[1] - nextBounds[0]) : 1;
      ui.setPanelOpacity(fill, ratio);
    },
    dispose() {},
  };
}
