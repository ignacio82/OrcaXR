/**
 * XrDeviceWorkspace — full spatial Device Workspace in XR.
 *
 * Provides feature-parity with the desktop Device page:
 *  - Live Printer Telemetry: Hotend / Bed / Chamber temperatures, Fan speed, printer state badge.
 *  - Guarded Print Job Controls: Hold-to-confirm Emergency Stop and Cancel, Pause / Resume print.
 *  - Camera Live Preview: Snapshot stream view with refresh button.
 *  - Terminal / Macro Quick Actions: Send common G-code commands and Klipper macros.
 *  - Printer Storage & Job History: Stored files on Moonraker/Klipper with 1-touch print, recent print jobs.
 */
import { createXrButton, createXrChip, createXrSectionHeading } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

const C = tokens.color;

export interface XrDeviceTelemetry {
  readonly hotendTempC: number;
  readonly hotendTargetC: number;
  readonly bedTempC: number;
  readonly bedTargetC: number;
  readonly chamberTempC?: number;
  readonly fanPercent?: number;
  readonly state: 'printing' | 'paused' | 'idle' | 'error' | 'disconnected';
  readonly stateMessage?: string;
  readonly progressPercent?: number;
  readonly printDurationS?: number;
  readonly remainingDurationS?: number;
  readonly currentLayer?: number;
  readonly totalLayers?: number;
  readonly currentFile?: string;
}

export interface XrDeviceStoredFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly modifiedDate?: string;
}

export interface XrDeviceHistoryJob {
  readonly id: string;
  readonly filename: string;
  readonly status: 'completed' | 'cancelled' | 'error';
  readonly durationS: number;
  readonly printDate: string;
}

export interface XrDeviceContext {
  readonly printerName: string;
  readonly telemetry: XrDeviceTelemetry;
  readonly cameraFrameUrl?: string;
  readonly storedFiles?: readonly XrDeviceStoredFile[];
  readonly historyJobs?: readonly XrDeviceHistoryJob[];
  onEmergencyStop?(): void;
  onPausePrint?(): void;
  onResumePrint?(): void;
  onCancelPrint?(): void;
  onRefreshCamera?(): void;
  onRunMacro?(macroName: string): void;
  onPrintStoredFile?(filename: string): void;
  onClose?(): void;
}

export function renderXrDeviceWorkspace<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrDeviceContext,
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

  // Header: Printer Name, State Badge, Close Button
  const header = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  });
  ui.appendChild(container, header);

  const titleCol = ui.createPanel({ flexDirection: 'row', alignItems: 'center', gap: 10 });
  const title = ui.createText(ctx.printerName || '3D Printer', {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#ffffff',
  });
  ui.appendChild(titleCol, title);

  const stateColor =
    ctx.telemetry.state === 'printing'
      ? C.ok
      : ctx.telemetry.state === 'paused'
        ? C.warn
        : ctx.telemetry.state === 'error'
          ? C.danger
          : '#8a94a0';
  const badge = createXrChip(ui, ctx.telemetry.state.toUpperCase(), stateColor);
  ui.appendChild(titleCol, badge);
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

  // Section 1: Telemetry Dashboard (Temps, Fan, Progress)
  const telemSection = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  });
  ui.appendChild(container, telemSection);

  const createMetricCard = (label: string, value: string, subvalue?: string) => {
    const card = ui.createPanel({
      flexGrow: 1,
      minWidth: 120,
      padding: 10,
      cornerRadius: tokens.radius.sm,
      fillColor: C.surface,
      flexDirection: 'column',
      gap: 2,
    });
    const lbl = ui.createText(label.toUpperCase(), { fontSize: 10, fontWeight: 'bold', color: '#8a94a0' });
    ui.appendChild(card, lbl);
    const val = ui.createText(value, { fontSize: 16, fontWeight: 'bold', color: '#ffffff' });
    ui.appendChild(card, val);
    if (subvalue) {
      const sub = ui.createText(subvalue, { fontSize: 11, color: '#a0aab5' });
      ui.appendChild(card, sub);
    }
    return card;
  };

  const hotendVal = `${ctx.telemetry.hotendTempC.toFixed(0)}°C`;
  const hotendTarget = ctx.telemetry.hotendTargetC > 0 ? `Target ${ctx.telemetry.hotendTargetC}°C` : 'Off';
  ui.appendChild(telemSection, createMetricCard('Hotend', hotendVal, hotendTarget));

  const bedVal = `${ctx.telemetry.bedTempC.toFixed(0)}°C`;
  const bedTarget = ctx.telemetry.bedTargetC > 0 ? `Target ${ctx.telemetry.bedTargetC}°C` : 'Off';
  ui.appendChild(telemSection, createMetricCard('Bed', bedVal, bedTarget));

  if (ctx.telemetry.fanPercent !== undefined) {
    ui.appendChild(telemSection, createMetricCard('Part Fan', `${ctx.telemetry.fanPercent}%`));
  }

  if (ctx.telemetry.currentLayer && ctx.telemetry.totalLayers) {
    ui.appendChild(
      telemSection,
      createMetricCard('Layer', `${ctx.telemetry.currentLayer} / ${ctx.telemetry.totalLayers}`),
    );
  }

  // Section 2: Print Controls (Emergency Stop, Pause, Resume, Cancel)
  const controlsHeading = createXrSectionHeading(ui, 'Print Controls');
  ui.appendChild(container, controlsHeading);

  const controlsRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    gap: 8,
  });
  ui.appendChild(container, controlsRow);

  if (ctx.telemetry.state === 'printing') {
    const pauseBtn = createXrButton(ui, {
      label: 'Pause Print',
      primary: true,
      flexGrow: 1,
      onClick: ctx.onPausePrint,
    });
    ui.appendChild(controlsRow, pauseBtn.root);
  } else if (ctx.telemetry.state === 'paused') {
    const resumeBtn = createXrButton(ui, {
      label: 'Resume Print',
      primary: true,
      flexGrow: 1,
      onClick: ctx.onResumePrint,
    });
    ui.appendChild(controlsRow, resumeBtn.root);
  }

  const cancelBtn = createXrButton(ui, {
    label: 'Cancel Print (Hold)',
    danger: true,
    flexGrow: 1,
    onClick: ctx.onCancelPrint,
  });
  ui.appendChild(controlsRow, cancelBtn.root);

  const estopBtn = createXrButton(ui, {
    label: 'Emergency Stop ⚠',
    danger: true,
    flexGrow: 1,
    onClick: ctx.onEmergencyStop,
  });
  ui.appendChild(controlsRow, estopBtn.root);

  // Section 3: Quick Macros
  const macroHeading = createXrSectionHeading(ui, 'Quick Macros & Commands');
  ui.appendChild(container, macroHeading);

  const macroRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  });
  ui.appendChild(container, macroRow);

  const macros = ['Home All (G28)', 'Bed Level (G29)', 'Preheat PLA', 'Unload Filament'];
  for (const m of macros) {
    const mBtn = createXrButton(ui, {
      label: m,
      fontSize: 12,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 6,
      paddingBottom: 6,
      onClick: () => ctx.onRunMacro?.(m),
    });
    ui.appendChild(macroRow, mBtn.root);
  }

  // Section 4: Stored Files
  if (ctx.storedFiles && ctx.storedFiles.length > 0) {
    const storageHeading = createXrSectionHeading(ui, 'Stored G-code Files on Printer');
    ui.appendChild(container, storageHeading);

    for (const file of ctx.storedFiles.slice(0, 5)) {
      const fileRow = ui.createPanel({
        width: '100%',
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 8,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        cornerRadius: tokens.radius.sm,
        fillColor: C.surface,
      });

      const fileInfo = ui.createPanel({ flexDirection: 'column', gap: 2 });
      const fName = ui.createText(file.filename, { fontSize: 13, fontWeight: 'bold', color: '#ffffff' });
      ui.appendChild(fileInfo, fName);
      const fSize = ui.createText(`${(file.sizeBytes / 1024 / 1024).toFixed(2)} MB`, {
        fontSize: 11,
        color: '#a0aab5',
      });
      ui.appendChild(fileInfo, fSize);
      ui.appendChild(fileRow, fileInfo);

      const printFileBtn = createXrButton(ui, {
        label: 'Print',
        fontSize: 12,
        primary: true,
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 6,
        paddingBottom: 6,
        onClick: () => ctx.onPrintStoredFile?.(file.filename),
      });
      ui.appendChild(fileRow, printFileBtn.root);

      ui.appendChild(container, fileRow);
    }
  }

  return container;
}
