/**
 * XrProjectWorkspace — full spatial Project Hub & Calibration Workspace in XR.
 *
 * Provides feature-parity with the desktop Project page:
 *  - Project Overview: Filename, model/plate counts, dirty state, file operations (Open, Save, Export).
 *  - Recent Projects: One-touch load list.
 *  - Calibration Workflows Grid: Interactive cards for all 11+ OrcaSlicer/Snapmaker calibration tests
 *    (Temp tower, Flow YOLO, Pressure Advance, Retraction, Max Flow, Tolerance, VFA, Input Shaping).
 *  - Calibration Session Bar: In-session controls (Slice & Test, Keep Calibration, Discard).
 */
import { createXrButton, createXrChip, createXrSectionHeading } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export interface XrCalibrationWorkflowItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
}

export const CALIBRATION_WORKFLOWS: readonly XrCalibrationWorkflowItem[] = [
  { id: 'calib_temperature', title: 'Temperature Tower', subtitle: 'Material hotend temp sweep', icon: 'thermostat' },
  { id: 'calib_flow_yolo', title: 'Flow Rate (YOLO)', subtitle: 'Fast single-print flow multiplier', icon: 'tune' },
  { id: 'calib_flow_pass1', title: 'Flow Rate (Pass 1)', subtitle: 'Coarse flow multiplier calibration', icon: 'tune' },
  { id: 'calib_flow_pass2', title: 'Flow Rate (Pass 2)', subtitle: 'Fine flow multiplier calibration', icon: 'tune' },
  {
    id: 'calib_pressure_advance',
    title: 'Pressure Advance',
    subtitle: 'Corner extrusion & line program',
    icon: 'timeline',
  },
  {
    id: 'calib_retraction',
    title: 'Retraction Test',
    subtitle: 'Stringing & retraction distance/speed',
    icon: 'unfold_more',
  },
  { id: 'calib_max_flow', title: 'Max Volumetric Flow', subtitle: 'Speed limit & extruder maximum', icon: 'speed' },
  {
    id: 'calib_tolerance',
    title: 'Tolerance Test',
    subtitle: 'Mechanical fit & dimensional clearance',
    icon: 'straighten',
  },
  { id: 'calib_vfa', title: 'VFA Resonance', subtitle: 'Vertical fine artifact & vibration sweep', icon: 'waves' },
  {
    id: 'calib_input_shaping_frequency',
    title: 'Input Shaping',
    subtitle: 'Resonance frequency & damping tuning',
    icon: 'graphic_eq',
  },
];

export interface XrRecentProjectItem {
  readonly name: string;
  readonly path?: string;
  readonly modelCount: number;
  readonly modifiedDate: string;
}

export interface XrProjectContext {
  readonly projectName: string;
  readonly plateCount: number;
  readonly modelCount: number;
  readonly isDirty: boolean;
  readonly recentProjects: readonly XrRecentProjectItem[];
  readonly activeCalibrationSession?: {
    readonly workflowId: string;
    readonly title: string;
    readonly canSlice: boolean;
  } | null;
  onOpenProject?(): void;
  onSaveProject?(): void;
  onSaveProjectAs?(): void;
  onExport3mf?(): void;
  onExportGcode?(): void;
  onSelectRecentProject?(project: XrRecentProjectItem): void;
  onSelectCalibrationWorkflow?(workflowId: string): void;
  onCalibrationSlice?(): void;
  onCalibrationKeep?(): void;
  onCalibrationDiscard?(): void;
  onClose?(): void;
}

export function renderXrProjectWorkspace<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrProjectContext,
): PanelNode {
  const container = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    fillColor: '#0d141cF5',
    cornerRadius: tokens.radius.lg,
    padding: 16,
    gap: 12,
    strokeWidth: 1,
    strokeColor: '#ffffff1a',
    overflow: 'scroll',
  });
  ui.appendChild(root, container);

  // Header
  const header = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  });
  ui.appendChild(container, header);

  const titleCol = ui.createPanel({ flexDirection: 'row', alignItems: 'center', gap: 10 });
  const title = ui.createText('Project & Calibration Hub', {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(titleCol, title);
  if (ctx.isDirty) {
    const dirtyBadge = createXrChip(ui, 'UNSAVED CHANGES', C.warn);
    ui.appendChild(titleCol, dirtyBadge);
  }
  ui.appendChild(header, titleCol);

  if (ctx.onClose) {
    const closeBtn = createXrButton(ui, {
      label: '✕',
      fontSize: 14,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      onClick: ctx.onClose,
    });
    ui.appendChild(header, closeBtn.root);
  }

  // Active Calibration Session Bar (if running)
  if (ctx.activeCalibrationSession) {
    const sess = ctx.activeCalibrationSession;
    const sessBar = ui.createPanel({
      width: '100%',
      padding: 12,
      cornerRadius: tokens.radius.sm,
      fillColor: '#ffb74d26',
      strokeWidth: 1,
      strokeColor: C.warn,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    });
    ui.appendChild(container, sessBar);

    const sessInfo = ui.createPanel({ flexDirection: 'column', gap: 2 });
    const sessTitle = ui.createText(`Calibration Active: ${sess.title}`, {
      fontSize: 14,
      fontWeight: 'bold',
      color: '#ffffff',
    });
    ui.appendChild(sessInfo, sessTitle);
    const sessSub = ui.createText('Adjust parameters in the inspector, then slice and test print.', {
      fontSize: 11,
      color: '#c7ced6',
    });
    ui.appendChild(sessInfo, sessSub);
    ui.appendChild(sessBar, sessInfo);

    const sessActions = ui.createPanel({ flexDirection: 'row', gap: 6 });
    if (ctx.onCalibrationSlice) {
      const sliceBtn = createXrButton(ui, {
        label: 'Slice Test',
        primary: true,
        fontSize: 12,
        onClick: ctx.onCalibrationSlice,
      });
      ui.appendChild(sessActions, sliceBtn.root);
    }
    if (ctx.onCalibrationKeep) {
      const keepBtn = createXrButton(ui, {
        label: 'Keep',
        fontSize: 12,
        onClick: ctx.onCalibrationKeep,
      });
      ui.appendChild(sessActions, keepBtn.root);
    }
    if (ctx.onCalibrationDiscard) {
      const discardBtn = createXrButton(ui, {
        label: 'Discard',
        danger: true,
        fontSize: 12,
        onClick: ctx.onCalibrationDiscard,
      });
      ui.appendChild(sessActions, discardBtn.root);
    }
    ui.appendChild(sessBar, sessActions);
  }

  // Section 1: Project Summary & Actions
  const summaryHeading = createXrSectionHeading(ui, 'Project Overview');
  ui.appendChild(container, summaryHeading);

  const summaryRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
  });
  ui.appendChild(container, summaryRow);

  const metaCol = ui.createPanel({ flexDirection: 'column', gap: 2 });
  const projName = ui.createText(ctx.projectName || 'Untitled Project', {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(metaCol, projName);
  const projCounts = ui.createText(`${ctx.plateCount} Plate(s) · ${ctx.modelCount} Model(s)`, {
    fontSize: 12,
    color: '#a0aab5',
  });
  ui.appendChild(metaCol, projCounts);
  ui.appendChild(summaryRow, metaCol);

  const projButtons = ui.createPanel({ flexDirection: 'row', gap: 6 });
  const openBtn = createXrButton(ui, {
    label: 'Open',
    fontSize: 12,
    onClick: ctx.onOpenProject,
  });
  ui.appendChild(projButtons, openBtn.root);

  const saveBtn = createXrButton(ui, {
    label: 'Save',
    fontSize: 12,
    primary: ctx.isDirty,
    onClick: ctx.onSaveProject,
  });
  ui.appendChild(projButtons, saveBtn.root);

  const exportBtn = createXrButton(ui, {
    label: 'Export 3MF',
    fontSize: 12,
    onClick: ctx.onExport3mf,
  });
  ui.appendChild(projButtons, exportBtn.root);
  ui.appendChild(summaryRow, projButtons);

  // Section 2: Recent Projects List
  if (ctx.recentProjects.length > 0) {
    const recentHeading = createXrSectionHeading(ui, 'Recent Projects');
    ui.appendChild(container, recentHeading);

    const recentRow = ui.createPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    });
    ui.appendChild(container, recentRow);

    for (const recent of ctx.recentProjects.slice(0, 4)) {
      const card = ui.createPanel({
        flexGrow: 1,
        minWidth: 140,
        padding: 10,
        cornerRadius: tokens.radius.sm,
        fillColor: C.surface,
        flexDirection: 'column',
        gap: 4,
        onClick: () => ctx.onSelectRecentProject?.(recent),
      });
      const name = ui.createText(recent.name, { fontSize: 13, fontWeight: 'bold', color: '#ffffff' });
      ui.appendChild(card, name);
      const detail = ui.createText(`${recent.modelCount} models · ${recent.modifiedDate}`, {
        fontSize: 10,
        color: '#a0aab5',
      });
      ui.appendChild(card, detail);
      ui.appendChild(recentRow, card);
    }
  }

  // Section 3: Calibration Workflows Grid
  const calibHeading = createXrSectionHeading(ui, 'Calibration Workflows');
  ui.appendChild(container, calibHeading);

  const grid = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  });
  ui.appendChild(container, grid);

  for (const calib of CALIBRATION_WORKFLOWS) {
    const card = ui.createPanel({
      width: '48%',
      flexGrow: 1,
      minWidth: 180,
      padding: 10,
      cornerRadius: tokens.radius.sm,
      fillColor: C.surface,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
      flexDirection: 'column',
      gap: 4,
      onClick: () => ctx.onSelectCalibrationWorkflow?.(calib.id),
    });

    const cTitle = ui.createText(calib.title, {
      fontSize: 13,
      fontWeight: 'bold',
      color: '#ffffff',
    });
    ui.appendChild(card, cTitle);

    const cSub = ui.createText(calib.subtitle, {
      fontSize: 11,
      color: '#a0aab5',
    });
    ui.appendChild(card, cSub);

    ui.appendChild(grid, card);
  }

  return container;
}
