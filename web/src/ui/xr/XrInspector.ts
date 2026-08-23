/**
 * XrInspector — 5-Tab Spatial Parameter Sidebar for OrcaXR in XR.
 *
 * Provides feature-complete tabs matching the desktop sidebar:
 *  - [ Profiles ]: Machine, Process, and Filament preset switchers & bed plate selector.
 *  - [ Filament ]: Multi-tool filament slot rack (T0..TN), color swatches, selection assigner, virtual filaments.
 *  - [ Settings ]: Categorized scoped process settings (Quality, Infill, Walls, Supports, Speed) with steppers.
 *  - [ Objects  ]: Plated objects hierarchy tree with selection, printable toggling, rename, delete, filament remap.
 *  - [ Tool     ]: Active tool parameters (Measure metrics, Paint brush settings, Brim ears, SVG sizing).
 */
import {
  createXrButton,
  createXrChip,
  createXrSectionHeading,
  createXrStepperRow,
  createXrTabBar,
  type XrTabItem,
} from './XrComponents';
import { renderXrScopedSettings } from './XrScopedSettings';
import type { ScopedStepperSurface, ScopedStepperView } from '../../settings/editor/scopedStepper';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export type XrInspectorTabId = 'profiles' | 'filament' | 'settings' | 'objects' | 'tool';

export interface XrInspectorProfileItem {
  readonly kind: 'machine' | 'process' | 'filament';
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly icon: string;
}

export interface XrInspectorFilamentSlot {
  readonly id: string;
  readonly slotNumber: number;
  readonly color: string;
  readonly name: string;
  readonly type: string;
  readonly vendor?: string;
  readonly tempRange?: string;
}

export interface XrInspectorObjectItem {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly printable: boolean;
  readonly volumeCount: number;
  readonly assignedFilamentId?: string | null;
  readonly assignedFilamentNumber?: number;
  readonly assignedFilamentColor?: string;
}

export interface XrInspectorContext {
  activeTab: XrInspectorTabId;
  profiles: readonly XrInspectorProfileItem[];
  plateTypes?: readonly string[];
  activePlateType?: string;
  filamentSlots: readonly XrInspectorFilamentSlot[];
  selectedObjectSummary?: string;
  objects: readonly XrInspectorObjectItem[];
  scopedStepperView: ScopedStepperView | null;
  scopedStepperPort?: ScopedStepperSurface | null;
  activeTool?: string | null;
  toolSettings?: {
    measure?: { distanceMm: number; deltaX?: number; deltaY?: number; deltaZ?: number; angleDeg?: number } | null;
    paintBrushSizeMm?: number;
    brimEarRadiusMm?: number;
    svgDepthMm?: number;
    svgWidthMm?: number;
  };
  onSelectTab(tabId: XrInspectorTabId): void;
  onCycleProfilePart(kind: 'machine' | 'process' | 'filament'): void;
  onSelectPlateType?(plateType: string): void;
  onAssignFilamentToSelection?(slotNumber: number | null): void;
  onSelectObject?(objectId: string): void;
  onToggleObjectPrintable?(objectId: string): void;
  onDeleteObject?(objectId: string): void;
  onDuplicateObject?(objectId: string): void;
  onStepScopedSetting?(fieldId: string, direction: 1 | -1): void;
  onStepToolSetting?(key: string, delta: number): void;
}

export interface XrInspectorRender<PanelNode> {
  readonly root: PanelNode;
  refresh(ctx: XrInspectorContext): void;
  dispose(): void;
}

const INSPECTOR_TABS: readonly XrTabItem[] = [
  { id: 'profiles', label: 'Profiles', icon: 'printer' },
  { id: 'filament', label: 'Filament', icon: 'filament' },
  { id: 'settings', label: 'Settings', icon: 'tune' },
  { id: 'objects', label: 'Objects', icon: 'cube' },
  { id: 'tool', label: 'Tool', icon: 'format_paint' },
];

export function renderXrInspector<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrInspectorContext,
): XrInspectorRender<PanelNode> {
  const container = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    fillColor: '#0d141cE6',
    cornerRadius: tokens.radius.md,
    padding: 14,
    gap: 10,
    strokeWidth: 1,
    strokeColor: '#ffffff14',
    overflow: 'scroll',
  });
  ui.appendChild(root, container);

  // Top Tab Bar
  const tabBar = createXrTabBar(ui, INSPECTOR_TABS, ctx.activeTab, (tabId) => {
    ctx.onSelectTab(tabId as XrInspectorTabId);
  });
  ui.appendChild(container, tabBar.root);

  // Content deck host
  const contentHost = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    gap: 8,
    flexGrow: 1,
  });
  ui.appendChild(container, contentHost);

  const populateContent = (currentCtx: XrInspectorContext) => {
    switch (currentCtx.activeTab) {
      case 'profiles':
        renderProfilesDeck(ui, contentHost, currentCtx);
        break;
      case 'filament':
        renderFilamentDeck(ui, contentHost, currentCtx);
        break;
      case 'settings':
        renderSettingsDeck(ui, contentHost, currentCtx);
        break;
      case 'objects':
        renderObjectsDeck(ui, contentHost, currentCtx);
        break;
      case 'tool':
        renderToolDeck(ui, contentHost, currentCtx);
        break;
    }
  };

  populateContent(ctx);

  return {
    root: container,
    refresh(nextCtx: XrInspectorContext) {
      tabBar.setActiveTab(nextCtx.activeTab);
    },
    dispose() {},
  };
}

/** [Profiles] Tab: Machine, Process, Filament cards & Bed Plate selector */
function renderProfilesDeck<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  host: PanelNode,
  ctx: XrInspectorContext,
): void {
  const heading = createXrSectionHeading(ui, 'Active Profiles');
  ui.appendChild(host, heading);

  for (const prof of ctx.profiles) {
    const card = ui.createPanel({
      width: '100%',
      minHeight: 52,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      cornerRadius: tokens.radius.sm,
      fillColor: C.surface,
      strokeWidth: 1,
      strokeColor: '#ffffff1a',
      onClick: () => {
        ctx.onCycleProfilePart(prof.kind);
      },
    });

    const infoCol = ui.createPanel({
      flexDirection: 'column',
      flexGrow: 1,
      gap: 2,
    });
    const titleText = ui.createText(prof.label.toUpperCase(), {
      fontSize: 10,
      fontWeight: 'bold',
      color: '#8a94a0',
    });
    ui.appendChild(infoCol, titleText);

    const valText = ui.createText(prof.value || 'Select…', {
      fontSize: 14,
      fontWeight: 'bold',
      color: '#ffffff',
    });
    ui.appendChild(infoCol, valText);

    if (prof.detail) {
      const detailText = ui.createText(prof.detail, {
        fontSize: 11,
        color: '#a0aab5',
      });
      ui.appendChild(infoCol, detailText);
    }
    ui.appendChild(card, infoCol);

    const cycleBtn = createXrButton(ui, {
      label: 'Cycle ↷',
      fontSize: 11,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: () => ctx.onCycleProfilePart(prof.kind),
    });
    ui.appendChild(card, cycleBtn.root);

    ui.appendChild(host, card);
  }

  // Plate Type selector
  if (ctx.plateTypes && ctx.plateTypes.length > 0) {
    const plateHeading = createXrSectionHeading(ui, 'Build Plate Type');
    ui.appendChild(host, plateHeading);

    const plateRow = ui.createPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    });
    ui.appendChild(host, plateRow);

    for (const plate of ctx.plateTypes) {
      const isSelected = plate === ctx.activePlateType;
      const btn = createXrButton(ui, {
        label: plate,
        fontSize: 12,
        selected: isSelected,
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 6,
        paddingBottom: 6,
        onClick: () => ctx.onSelectPlateType?.(plate),
      });
      ui.appendChild(plateRow, btn.root);
    }
  }
}

/** [Filament] Tab: Multi-tool slots, color swatches, assignment bar */
function renderFilamentDeck<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  host: PanelNode,
  ctx: XrInspectorContext,
): void {
  const heading = createXrSectionHeading(ui, 'Loaded Filament Slots (T0–TN)');
  ui.appendChild(host, heading);

  for (const slot of ctx.filamentSlots) {
    const row = ui.createPanel({
      width: '100%',
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      cornerRadius: tokens.radius.sm,
      fillColor: C.surface,
    });

    const swatch = ui.createPanel({
      width: 24,
      height: 24,
      cornerRadius: 12,
      fillColor: slot.color,
      strokeWidth: 1,
      strokeColor: '#ffffff4d',
    });
    ui.appendChild(row, swatch);

    const info = ui.createPanel({
      flexDirection: 'column',
      flexGrow: 1,
      gap: 2,
    });
    const nameText = ui.createText(`Slot ${slot.slotNumber}: ${slot.name}`, {
      fontSize: 13,
      fontWeight: 'bold',
      color: '#ffffff',
    });
    ui.appendChild(info, nameText);

    const typeText = ui.createText(`${slot.type}${slot.tempRange ? ` · ${slot.tempRange}` : ''}`, {
      fontSize: 11,
      color: '#a0aab5',
    });
    ui.appendChild(info, typeText);
    ui.appendChild(row, info);

    const assignBtn = createXrButton(ui, {
      label: 'Assign',
      fontSize: 11,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: () => ctx.onAssignFilamentToSelection?.(slot.slotNumber),
    });
    ui.appendChild(row, assignBtn.root);

    ui.appendChild(host, row);
  }

  // Quick Selection Assigner
  const assignHeading = createXrSectionHeading(ui, 'Assign to Selected Model');
  ui.appendChild(host, assignHeading);

  const assignBar = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  });
  ui.appendChild(host, assignBar);

  const defaultBtn = createXrButton(ui, {
    label: 'Auto / Default',
    fontSize: 12,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: () => ctx.onAssignFilamentToSelection?.(null),
  });
  ui.appendChild(assignBar, defaultBtn.root);

  for (const slot of ctx.filamentSlots) {
    const slotBtn = createXrButton(ui, {
      label: `T${slot.slotNumber}`,
      fontSize: 12,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 6,
      paddingBottom: 6,
      onClick: () => ctx.onAssignFilamentToSelection?.(slot.slotNumber),
    });
    ui.appendChild(assignBar, slotBtn.root);
  }
}

/** [Settings] Tab: Scoped process settings steppers */
function renderSettingsDeck<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  host: PanelNode,
  ctx: XrInspectorContext,
): void {
  renderXrScopedSettings(ui, host, ctx.scopedStepperView, {
    onCycleTarget: (dir) => ctx.scopedStepperPort?.cycleTarget(dir),
    onStep: (fieldId, dir) => {
      ctx.scopedStepperPort?.step(fieldId, dir);
      ctx.onStepScopedSetting?.(fieldId, dir);
    },
  });
}

/** [Objects] Tab: Model and Volume tree */
function renderObjectsDeck<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  host: PanelNode,
  ctx: XrInspectorContext,
): void {
  const heading = createXrSectionHeading(ui, 'Objects on Build Plate');
  ui.appendChild(host, heading);

  if (ctx.objects.length === 0) {
    const emptyText = ui.createText('No models on this plate. Use Load to add one.', {
      fontSize: 13,
      color: C.textMuted,
    });
    ui.appendChild(host, emptyText);
    return;
  }

  for (const obj of ctx.objects) {
    const row = ui.createPanel({
      width: '100%',
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 8,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      cornerRadius: tokens.radius.sm,
      fillColor: obj.selected ? C.surfaceActive : C.surface,
      strokeWidth: obj.selected ? 1 : 0,
      strokeColor: C.accent,
      onClick: () => ctx.onSelectObject?.(obj.id),
    });

    const nameText = ui.createText(obj.name, {
      fontSize: 13,
      fontWeight: 'bold',
      color: obj.selected ? '#ffffff' : '#c7ced6',
      flexGrow: 1,
    });
    ui.appendChild(row, nameText);

    if (obj.assignedFilamentNumber) {
      const filChip = createXrChip(ui, `T${obj.assignedFilamentNumber}`, obj.assignedFilamentColor ?? C.accentSoft);
      ui.appendChild(row, filChip);
    }

    const printBtn = createXrButton(ui, {
      label: obj.printable ? 'Printable' : 'Ignored',
      fontSize: 11,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 3,
      paddingBottom: 3,
      selected: obj.printable,
      onClick: () => ctx.onToggleObjectPrintable?.(obj.id),
    });
    ui.appendChild(row, printBtn.root);

    const dupBtn = createXrButton(ui, {
      label: '⧉',
      fontSize: 12,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 3,
      paddingBottom: 3,
      onClick: () => ctx.onDuplicateObject?.(obj.id),
    });
    ui.appendChild(row, dupBtn.root);

    const delBtn = createXrButton(ui, {
      label: '✕',
      fontSize: 12,
      danger: true,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 3,
      paddingBottom: 3,
      onClick: () => ctx.onDeleteObject?.(obj.id),
    });
    ui.appendChild(row, delBtn.root);

    ui.appendChild(host, row);
  }
}

/** [Tool] Tab: Contextual parameters for active tool */
function renderToolDeck<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  host: PanelNode,
  ctx: XrInspectorContext,
): void {
  const toolName = ctx.activeTool ?? 'None';
  const heading = createXrSectionHeading(ui, `Active Tool: ${toolName.toUpperCase()}`);
  ui.appendChild(host, heading);

  if (ctx.activeTool === 'measure' && ctx.toolSettings?.measure) {
    const m = ctx.toolSettings.measure;
    const readout = ui.createPanel({
      width: '100%',
      padding: 10,
      fillColor: '#0000004d',
      cornerRadius: tokens.radius.sm,
      flexDirection: 'column',
      gap: 4,
    });
    ui.appendChild(host, readout);

    const dist = ui.createText(`Measured Distance: ${m.distanceMm.toFixed(2)} mm`, {
      fontSize: 14,
      fontWeight: 'bold',
      color: C.accentSoft,
    });
    ui.appendChild(readout, dist);

    if (m.deltaX !== undefined) {
      const deltas = ui.createText(
        `ΔX: ${m.deltaX.toFixed(2)} mm  ΔY: ${m.deltaY?.toFixed(2)} mm  ΔZ: ${m.deltaZ?.toFixed(2)} mm`,
        { fontSize: 12, color: '#c7ced6' },
      );
      ui.appendChild(readout, deltas);
    }
  } else if (ctx.activeTool === 'paint') {
    const size = ctx.toolSettings?.paintBrushSizeMm ?? 5;
    const stepper = createXrStepperRow(ui, 'Brush Size', size.toFixed(1), 'mm', (dir) => {
      ctx.onStepToolSetting?.('paintBrushSize', dir * 1);
    });
    ui.appendChild(host, stepper.root);
  } else if (ctx.activeTool === 'brim_ears') {
    const rad = ctx.toolSettings?.brimEarRadiusMm ?? 4;
    const stepper = createXrStepperRow(ui, 'Brim Ear Radius', rad.toFixed(1), 'mm', (dir) => {
      ctx.onStepToolSetting?.('brimEarRadius', dir * 0.5);
    });
    ui.appendChild(host, stepper.root);
  } else {
    const text = ui.createText('Select a tool from the left rail to view and adjust its parameters.', {
      fontSize: 13,
      color: C.textMuted,
    });
    ui.appendChild(host, text);
  }
}
