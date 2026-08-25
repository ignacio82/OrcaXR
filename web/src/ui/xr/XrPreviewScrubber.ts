/**
 * XrPreviewScrubber — reading a toolpath in the headset.
 *
 * Docked at the plate's near edge during Preview, which is where a machine puts
 * its own controls and where the operator is already looking. It is a second
 * view of the exact `GcodePreviewPanelAdapter` state the flat shell's panel and
 * scrubber render, and it draws nothing the projection did not supply — a
 * toolpath is never coloured or filtered here.
 *
 * Three things the old spatial scrubber left behind are restored, and each was
 * a real loss:
 *
 *  - **The whole legend.** It drew the first six roles, so `bridge`,
 *    `overhang`, `wipe tower` and `travel` were simply absent from a headset —
 *    and a legend that silently truncates teaches an operator that the colours
 *    they cannot find do not exist.
 *  - **The move filters.** `moveVisibility` is part of the view the projection
 *    exposes, and there was no way to reach it.
 *  - **A view mode you can see.** One cycling button whose label was the mode
 *    it was *currently* in gives no idea what the next press will do; the modes
 *    are listed.
 */
import type { GcodePreviewMode } from '../../slicer/GcodePreviewModel';
import type { GcodePreviewViewPatch } from '../../slicer/GcodePreviewSession';
import type { GcodePreviewPanelState } from '../dom/GcodePreviewPanel';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import { XR_TYPE, createXrGrabBar, createXrRow, createXrSurfaceBody, createXrTextButton } from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrPreviewScrubberHandlers {
  onUpdateView(patch: GcodePreviewViewPatch): void;
  onAuthorEvent?(type: 'pause' | 'custom', topZMm: number): void;
  onTogglePin?(): void;
}

export interface XrPreviewScrubberRender<PanelNode, TextNode> {
  readonly root: PanelNode;
  readonly layerText: TextNode;
  readonly zText: TextNode;
  refresh(state: GcodePreviewPanelState): void;
  dispose(): void;
}

export function renderXrPreviewScrubber<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  state: GcodePreviewPanelState,
  handlers: XrPreviewScrubberHandlers,
  options: { readonly pinned?: boolean } = {},
): XrPreviewScrubberRender<PanelNode, TextNode> {
  const body = createXrSurfaceBody(ui, { padding: tokens.space.sm, gap: 6 });
  ui.appendChild(root, body);

  let current = state;
  const bounds = (s: GcodePreviewPanelState): readonly [number, number] => s.layerBounds ?? [1, 1];
  const layerOf = (s: GcodePreviewPanelState): number => s.view?.layerRange[1] ?? bounds(s)[1];

  if (handlers.onTogglePin) {
    const grab = createXrGrabBar(ui, {
      title: t('ui.xrPreviewScrubber.title', 'Toolpath'),
      hint: t('ui.xrPreviewScrubber.hint', 'Drag to place, pin to keep it there'),
      pinned: options.pinned === true,
      onPin: handlers.onTogglePin,
    });
    ui.appendChild(body, grab.root);
  }

  // ---- Where we are ------------------------------------------------------
  const header = createXrRow(ui, { gap: tokens.space.sm, flexShrink: 0 });
  const layerText = ui.createText('', { fontSize: XR_TYPE.heading, fontWeight: 'bold', color: C.text, flexShrink: 0 });
  const zText = ui.createText('', { fontSize: XR_TYPE.body, color: C.accentSoft, flexShrink: 0 });
  ui.appendChild(header, layerText);
  ui.appendChild(header, zText);
  ui.appendChild(header, ui.createPanel({ flexGrow: 1, flexShrink: 1 }));

  // Every mode the projection offers, named. The one in use is selected.
  const modeRow = createXrRow(ui, { width: 'auto', gap: 4, flexShrink: 0 });
  const modeButtons = new Map<
    GcodePreviewMode,
    ReturnType<typeof createXrTextButton<PanelNode, ImageNode, TextNode>>
  >();
  for (const mode of state.modes) {
    const button = createXrTextButton(ui, {
      label: mode.label,
      fontSize: XR_TYPE.caption,
      height: 30,
      paddingX: 8,
      onClick: () => handlers.onUpdateView({ mode: mode.id }),
    });
    modeButtons.set(mode.id, button);
    ui.appendChild(modeRow, button.root);
  }
  ui.appendChild(header, modeRow);

  const singleLayer = createXrTextButton(ui, {
    label: t('ui.xrPreviewScrubber.singleLayer', 'Single layer'),
    fontSize: XR_TYPE.caption,
    height: 30,
    paddingX: 8,
    onClick: () => {
      const next = !(current.view?.singleLayer ?? false);
      const layer = layerOf(current);
      handlers.onUpdateView({ singleLayer: next, layerRange: [next ? layer : bounds(current)[0], layer] });
    },
  });
  ui.appendChild(header, singleLayer.root);
  ui.appendChild(body, header);

  // ---- The scrub ---------------------------------------------------------
  const step = (delta: number): void => {
    const [low, high] = bounds(current);
    const next = Math.max(low, Math.min(high, layerOf(current) + delta));
    const from = current.view?.singleLayer ? next : (current.view?.layerRange[0] ?? low);
    handlers.onUpdateView({ layerRange: [from, next] });
  };

  const scrub = createXrRow(ui, { gap: 5, flexShrink: 0 });
  for (const delta of [-10, -1]) {
    ui.appendChild(
      scrub,
      createXrTextButton(ui, {
        label: String(delta),
        fontSize: XR_TYPE.caption,
        height: 36,
        paddingX: 8,
        onClick: () => step(delta),
      }).root,
    );
  }
  const track = ui.createPanel({
    flexGrow: 1,
    flexShrink: 1,
    height: 14,
    cornerRadius: 7,
    fillColor: C.stroke,
    flexDirection: 'row',
    alignItems: 'center',
  });
  const fill = ui.createPanel({ width: '0%', height: 14, cornerRadius: 7, fillColor: C.accent });
  ui.appendChild(track, fill);
  ui.appendChild(scrub, track);
  for (const delta of [1, 10]) {
    ui.appendChild(
      scrub,
      createXrTextButton(ui, {
        label: `+${delta}`,
        fontSize: XR_TYPE.caption,
        height: 36,
        paddingX: 8,
        onClick: () => step(delta),
      }).root,
    );
  }
  ui.appendChild(body, scrub);

  // ---- What is drawn -----------------------------------------------------
  const filters = createXrRow(ui, { gap: 4, flexWrap: 'wrap', flexShrink: 0 });
  const filterButtons = new Map<string, ReturnType<typeof createXrTextButton<PanelNode, ImageNode, TextNode>>>();
  for (const filter of state.moveFilters) {
    const button = createXrTextButton(ui, {
      label: filter.label,
      fontSize: XR_TYPE.micro,
      height: 28,
      paddingX: 8,
      onClick: () => {
        const visibility = current.view?.moveVisibility;
        if (!visibility) return;
        handlers.onUpdateView({ moveVisibility: { [filter.id]: !visibility[filter.id] } });
      },
    });
    filterButtons.set(filter.id, button);
    ui.appendChild(filters, button.root);
  }
  ui.appendChild(body, filters);

  // ---- The legend, whole -------------------------------------------------
  const legendRow = createXrRow(ui, { gap: 4, flexWrap: 'wrap', flexShrink: 0 });
  ui.appendChild(body, legendRow);

  const eventRow = createXrRow(ui, { gap: 5, flexShrink: 0 });
  ui.appendChild(body, eventRow);

  const drawLegend = (next: GcodePreviewPanelState): void => {
    ui.clearChildren(legendRow);
    for (const item of next.legend) {
      const chip = createXrRow(ui, {
        width: 'auto',
        flexShrink: 0,
        gap: 5,
        paddingLeft: 7,
        paddingRight: 7,
        paddingTop: 4,
        paddingBottom: 4,
        cornerRadius: 6,
        fillColor: C.surface,
      });
      ui.appendChild(chip, ui.createPanel({ width: 8, height: 8, cornerRadius: 4, fillColor: item.color }));
      ui.appendChild(chip, ui.createText(item.label, { fontSize: XR_TYPE.micro, color: C.text }));
      ui.appendChild(legendRow, chip);
    }
  };

  const drawEvents = (next: GcodePreviewPanelState): void => {
    ui.clearChildren(eventRow);
    // The projection may report that it cannot supply something. That is a
    // fact worth printing rather than an empty row worth explaining away.
    if (next.unsupportedReason) {
      ui.appendChild(
        eventRow,
        ui.createText(next.unsupportedReason, { fontSize: XR_TYPE.micro, color: C.warn, flexShrink: 1 }),
      );
      return;
    }
    const topZ = next.layerTopZMm;
    if (handlers.onAuthorEvent && typeof topZ === 'number') {
      ui.appendChild(
        eventRow,
        createXrTextButton(ui, {
          label: t('ui.xrPreviewScrubber.addPause', 'Pause at this layer'),
          fontSize: XR_TYPE.micro,
          height: 28,
          paddingX: 8,
          onClick: () => handlers.onAuthorEvent?.('pause', topZ),
        }).root,
      );
    }
    for (const tick of next.ticks.slice(0, 4)) {
      ui.appendChild(
        eventRow,
        ui.createText(`${tick.label} L${tick.layer}`, {
          fontSize: XR_TYPE.micro,
          color: C.textMuted,
          flexShrink: 0,
        }),
      );
    }
  };

  const apply = (next: GcodePreviewPanelState): void => {
    current = next;
    const [low, high] = bounds(next);
    const layer = layerOf(next);
    ui.setText(
      layerText,
      t('ui.xrPreviewScrubber.layer', 'Layer {current} / {total}')
        .replace('{current}', String(layer))
        .replace('{total}', String(high)),
    );
    ui.setText(zText, typeof next.layerTopZMm === 'number' ? `Z ${next.layerTopZMm.toFixed(2)} mm` : 'Z —');
    const ratio = high > low ? (layer - low) / (high - low) : 1;
    ui.setPanelProperties(fill, { width: `${Math.round(ratio * 100)}%` });
    singleLayer.setSelected(next.view?.singleLayer === true);
    for (const [id, button] of modeButtons) button.setSelected(next.view?.mode === id);
    for (const [id, button] of filterButtons) {
      button.setSelected(next.view?.moveVisibility?.[id as never] === true);
    }
    drawLegend(next);
    drawEvents(next);
  };
  apply(state);

  return { root: body, layerText, zText, refresh: apply, dispose: () => {} };
}
