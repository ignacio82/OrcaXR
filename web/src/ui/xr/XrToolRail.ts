/**
 * XrToolRail — spatial Left Tool Rail for model tools, transform gizmos, paint channels,
 * and contextual tool parameters in XR.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import { createXrButton, createXrSectionHeading, createXrStepperRow } from './XrComponents';
import { renderXrActionButton, type XrActionHandle } from './XrShell';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export const PRIMARY_TOOL_IDS = ['tool_move', 'tool_rotate', 'tool_scale', 'tool_lay_on_face', 'tool_cut'] as const;

export const PAINT_TOOL_IDS = [
  'tool_paint',
  'tool_support_paint',
  'tool_seam_paint',
  'tool_fuzzy_skin',
  'tool_smart_paint',
] as const;

export const MESH_TOOL_IDS = [
  'tool_measure',
  'arrange_all',
  'drop_to_bed',
  'tool_brim_ears',
  'simplify_model',
  'delete_models',
] as const;

export interface XrToolRailContext {
  activeTool: string | null;
  filamentSlots?: readonly { id: string; number: number; color: string; label: string }[];
  activePaintSlot?: number;
  measureResult?: { distanceMm: number; deltaX?: number; deltaY?: number; deltaZ?: number; angleDeg?: number } | null;
  brimEarRadiusMm?: number;
  onRunAction(action: Action): void;
  onSelectPaintSlot?(slotNumber: number): void;
  onStepBrimEarRadius?(delta: number): void;
  onClearMeasure?(): void;
}

export interface XrToolRailRender<PanelNode> {
  readonly root: PanelNode;
  readonly handles: readonly XrActionHandle[];
  refresh(ctx: XrToolRailContext): void;
  dispose(): void;
}

export function renderXrToolRail<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  registry: ActionRegistry,
  ctx: XrToolRailContext,
): XrToolRailRender<PanelNode> {
  const container = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    fillColor: '#0d141cE6',
    cornerRadius: tokens.radius.md,
    padding: 10,
    gap: 6,
    strokeWidth: 1,
    strokeColor: '#ffffff14',
    overflow: 'scroll',
  });
  ui.appendChild(root, container);

  const handles: XrActionHandle[] = [];

  const addActionGroup = (title: string, ids: readonly string[]) => {
    const heading = createXrSectionHeading(ui, title);
    ui.appendChild(container, heading);

    const groupRow = ui.createPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    });
    ui.appendChild(container, groupRow);

    for (const id of ids) {
      const action = registry.get(id);
      if (!action) continue;

      const isDanger = id === 'delete_models';
      const handle = renderXrActionButton(action, () => ctx.onRunAction(action), ui as any, {
        size: 52,
        iconSize: 26,
        danger: isDanger,
        enabled: action.capability.status === 'implemented' || action.capability.status === 'partial',
      });

      if (action.tool && action.tool === ctx.activeTool) {
        handle.setSelected(true);
      }

      handles.push(handle);
      ui.appendChild(groupRow, handle.btn as any);
    }
  };

  // Group 1: Transform Tools
  addActionGroup('Transforms', PRIMARY_TOOL_IDS);

  // Group 2: Surface & Paint Tools
  addActionGroup('Surface & Paint', PAINT_TOOL_IDS);

  // Group 3: Mesh & Placement
  addActionGroup('Mesh & Plate', MESH_TOOL_IDS);

  // Contextual Sub-Deck based on active tool
  const subDeck = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    gap: 6,
    paddingTop: 6,
  });
  ui.appendChild(container, subDeck);

  const populateSubDeck = (currentCtx: XrToolRailContext) => {
    // If paint is active: show palette swatches
    if (currentCtx.activeTool === 'paint' && currentCtx.filamentSlots && currentCtx.filamentSlots.length > 0) {
      const heading = createXrSectionHeading(ui, 'Palette Swatches');
      ui.appendChild(subDeck, heading);

      const swatchesRow = ui.createPanel({
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
      });
      ui.appendChild(subDeck, swatchesRow);

      for (const slot of currentCtx.filamentSlots) {
        const isSelected = currentCtx.activePaintSlot === slot.number;
        const swatchBtn = ui.createPanel({
          width: 36,
          height: 36,
          cornerRadius: tokens.radius.sm,
          fillColor: slot.color,
          strokeWidth: isSelected ? 3 : 1,
          strokeColor: isSelected ? '#ffffff' : '#ffffff33',
          justifyContent: 'center',
          alignItems: 'center',
          onClick: () => {
            currentCtx.onSelectPaintSlot?.(slot.number);
          },
        });
        const numText = ui.createText(String(slot.number), {
          fontSize: 12,
          fontWeight: 'bold',
          color: '#000000',
        });
        ui.appendChild(swatchBtn, numText);
        ui.appendChild(swatchesRow, swatchBtn);
      }
    }

    // If Measure is active: show measurements readout
    if (currentCtx.activeTool === 'measure' && currentCtx.measureResult) {
      const heading = createXrSectionHeading(ui, 'Measurement');
      ui.appendChild(subDeck, heading);

      const readoutPanel = ui.createPanel({
        width: '100%',
        padding: 8,
        cornerRadius: tokens.radius.sm,
        fillColor: '#0000004d',
        flexDirection: 'column',
        gap: 4,
      });
      ui.appendChild(subDeck, readoutPanel);

      const distText = ui.createText(`Distance: ${currentCtx.measureResult.distanceMm.toFixed(2)} mm`, {
        fontSize: 13,
        fontWeight: 'bold',
        color: C.accentSoft,
      });
      ui.appendChild(readoutPanel, distText);

      if (currentCtx.measureResult.deltaX !== undefined) {
        const deltaText = ui.createText(
          `ΔX: ${currentCtx.measureResult.deltaX.toFixed(1)}  ΔY: ${currentCtx.measureResult.deltaY?.toFixed(1)}  ΔZ: ${currentCtx.measureResult.deltaZ?.toFixed(1)} mm`,
          { fontSize: 11, color: '#a0aab5' },
        );
        ui.appendChild(readoutPanel, deltaText);
      }

      if (currentCtx.onClearMeasure) {
        const clearBtn = createXrButton(ui, {
          label: 'Clear Measurement',
          fontSize: 11,
          paddingTop: 4,
          paddingBottom: 4,
          onClick: currentCtx.onClearMeasure,
        });
        ui.appendChild(readoutPanel, clearBtn.root);
      }
    }

    // If Brim ears is active: show radius stepper
    if (currentCtx.activeTool === 'brim_ears' && currentCtx.brimEarRadiusMm !== undefined) {
      const heading = createXrSectionHeading(ui, 'Brim Ears');
      ui.appendChild(subDeck, heading);

      const stepper = createXrStepperRow(ui, 'Ear Radius', currentCtx.brimEarRadiusMm.toFixed(1), 'mm', (dir) =>
        currentCtx.onStepBrimEarRadius?.(dir * 0.5),
      );
      ui.appendChild(subDeck, stepper.root);
    }
  };

  populateSubDeck(ctx);

  return {
    root: container,
    handles,
    refresh(nextCtx: XrToolRailContext) {
      for (const h of handles) {
        if (h.action.tool) {
          h.setSelected(h.action.tool === nextCtx.activeTool);
        }
      }
    },
    dispose() {
      for (const h of handles) h.dispose();
    },
  };
}
