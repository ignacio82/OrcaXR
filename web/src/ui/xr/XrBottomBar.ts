/**
 * XrBottomBar — spatial primary action desk tilted up like a control desk below the build plate in XR.
 *
 * Hosts the primary Load / Slice / Preview / Download / Print actions, the quick plate switcher strip,
 * and the live status line + progress bar.
 */
import type { ActionRegistry } from '../../actions/ActionRegistry';
import { createXrButton } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export interface XrBottomBarPlateItem {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly modelCount: number;
}

export interface XrBottomBarContext {
  readonly statusText: string;
  readonly progressRatio?: number; // 0..1
  readonly plates: readonly XrBottomBarPlateItem[];
  readonly activePlateId?: string;
  onRunAction(actionId: string): void;
  onSelectPlate?(plateId: string): void;
  onAddPlate?(): void;
  onArrangePlate?(): void;
}

export interface XrBottomBarRender<PanelNode, TextNode> {
  readonly root: PanelNode;
  readonly statusLabel: TextNode;
  readonly progressFill: PanelNode;
  refresh(ctx: XrBottomBarContext): void;
  dispose(): void;
}

const PRIMARY_ACTION_IDS = [
  { id: 'load_model_from_path', label: 'Load', icon: 'load', primary: false },
  { id: 'slice_active_plate', label: 'Slice', icon: 'slice', primary: true },
  { id: 'toggle_preview', label: 'Preview', icon: 'preview', primary: false },
  { id: 'save_gcode_to_downloads', label: 'Download', icon: 'download', primary: false },
  { id: 'send_to_printer', label: 'Print', icon: 'output', primary: false },
] as const;

export function renderXrBottomBar<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  registry: ActionRegistry,
  ctx: XrBottomBarContext,
): XrBottomBarRender<PanelNode, TextNode> {
  const container = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 8,
    fillColor: '#0d141cE6',
    cornerRadius: tokens.radius.md,
    padding: 12,
    strokeWidth: 1,
    strokeColor: '#ffffff14',
  });
  ui.appendChild(root, container);

  // Top Row: Primary action buttons
  const btnRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  });
  ui.appendChild(container, btnRow);

  for (const item of PRIMARY_ACTION_IDS) {
    const action = registry.get(item.id);
    const label = action?.label ?? item.label;
    const icon = action?.icon ?? item.icon;

    const btn = createXrButton(ui, {
      label,
      icon,
      iconSize: 18,
      fontSize: 13,
      primary: item.primary,
      flexGrow: 1,
      flexShrink: 1,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 10,
      paddingBottom: 10,
      onClick: () => ctx.onRunAction(item.id),
    });
    ui.appendChild(btnRow, btn.root);
  }

  // Middle Row: Quick Plate Switcher Strip
  if (ctx.plates.length > 0) {
    const plateStrip = ui.createPanel({
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingTop: 2,
    });
    ui.appendChild(container, plateStrip);

    for (const plate of ctx.plates) {
      const isSelected = plate.active || plate.id === ctx.activePlateId;
      const plateBtn = createXrButton(ui, {
        label: plate.name,
        badge: plate.modelCount > 0 ? `${plate.modelCount}` : undefined,
        fontSize: 11,
        selected: isSelected,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        onClick: () => ctx.onSelectPlate?.(plate.id),
      });
      ui.appendChild(plateStrip, plateBtn.root);
    }

    if (ctx.onAddPlate) {
      const addPlateBtn = createXrButton(ui, {
        label: '+ Plate',
        fontSize: 11,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        onClick: ctx.onAddPlate,
      });
      ui.appendChild(plateStrip, addPlateBtn.root);
    }

    if (ctx.onArrangePlate) {
      const arrangeBtn = createXrButton(ui, {
        label: 'Arrange',
        icon: 'arrange',
        iconSize: 14,
        fontSize: 11,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        onClick: ctx.onArrangePlate,
      });
      ui.appendChild(plateStrip, arrangeBtn.root);
    }
  }

  // Bottom Row: Status Text & Progress Bar
  const statusCol = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    gap: 4,
    paddingLeft: 4,
    paddingRight: 4,
  });
  ui.appendChild(container, statusCol);

  const statusLabel = ui.createText(ctx.statusText || 'Ready', {
    fontSize: 13,
    color: '#a0aab5',
  });
  ui.appendChild(statusCol, statusLabel);

  const progressTrack = ui.createPanel({
    width: '100%',
    height: 4,
    cornerRadius: 2,
    fillColor: '#ffffff1a',
  });
  const progressRatio = ctx.progressRatio ?? 0;
  const progressFill = ui.createPanel({
    width: `${Math.round(progressRatio * 100)}%`,
    height: 4,
    cornerRadius: 2,
    fillColor: C.accent,
  });
  ui.appendChild(progressTrack, progressFill);
  ui.appendChild(statusCol, progressTrack);

  return {
    root: container,
    statusLabel,
    progressFill,
    refresh(nextCtx: XrBottomBarContext) {
      ui.setText(statusLabel, nextCtx.statusText || 'Ready');
      const ratio = nextCtx.progressRatio ?? 0;
      ui.setPanelOpacity(progressFill, ratio > 0 ? 1 : 0);
    },
    dispose() {},
  };
}
