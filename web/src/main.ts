/**
 * OrcaXR Web — entry point.
 *
 * Phase 2: build-plate workspace with DragManager model manipulation and
 * the libslic3r WASM module slicing the live scene (see OrcaWorkspace).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as xb from 'xrblocks';
import * as uikit from '@pmndrs/uikit';

import { OrcaWorkspace, type WorkspacePresetOption } from './workspace/OrcaWorkspace';
import { SlicerClient } from './slicer/SlicerClient';
import {
  executePrintJobCommand,
  loadPrinterEndpointPreferences,
  MoonrakerTransport,
  MoonrakerTransportError,
  PrintJobCommandError,
  PrintJobStatusModel,
  PrintSubmissionError,
  PrintHistoryError,
  PrinterCameraError,
  PrinterConsoleError,
  PrinterConsoleLog,
  PrinterStorageError,
  assessGcodeCommand,
  buildMacroInvocation,
  deletePrinterFile,
  downloadPrinterFile,
  fetchCameraSnapshot,
  listPrintHistory,
  listPrinterCameras,
  listPrinterDirectory,
  listPrinterMacros,
  movePrinterFile,
  printJobCommandAvailability,
  queryMoonrakerFilamentSlots,
  queryPrintReadiness,
  readPrintHistoryTotals,
  readPrinterFileMetadata,
  recentCommands,
  renamedStoragePath,
  runGcodeScript,
  savePrinterEndpointPreferences,
  startStoredPrint,
  submitPrintJob,
  validateToolMapping,
  PRINT_JOB_OBJECTS,
  PRINT_JOB_QUERY_PATH,
  type MoonrakerFilamentSlot,
  type MoonrakerConnectionState,
  type MoonrakerHandshake,
  type PrintJobCommand,
  type PrintJobSnapshot,
  type PrintHistoryPage,
  type PrintHistoryTotals,
  type PrinterCamera,
  type PrinterConsoleOperation,
  type PrinterDirectoryListing,
  type PrinterFileMetadata,
  type PrinterMacro,
  type PrinterStorageOperation,
} from './printer';
import { registerWorkspaceTools } from './mcp/WorkspaceTools';
import { registerSystemTools } from './mcp/SystemTools';
import { OrcaWebMcpClient, WEBMCP_CLI_PACKAGE, WebMcpConnectionError, type WebMcpStatus } from './mcp/OrcaWebMcpClient';
import { injectTokenCss } from './ui/tokens';
import { UiState } from './actions/UiState';
import { ActionContext } from './actions/ActionContext';
import { buildRegistry } from './actions/catalog';
import type { ActionInvocation, ActionRegistry } from './actions/ActionRegistry';
import { buildShortcutCatalog, isShortcutEditingTarget, matchShortcut } from './actions/ShortcutCatalog';
import { DomShell } from './ui/dom/DomShell';
import { CommandPalette } from './ui/dom/CommandPalette';
import type { GeneratedSettingsPanelAdapter } from './ui/dom/GeneratedSettingsPanel';
import { ScopedSettingsPanel } from './ui/dom/ScopedSettingsPanel';
import { ObjectsPanel, type ObjectsPanelSelectionRequest } from './ui/dom/ObjectsPanel';
import { FilamentAssignmentSelector } from './ui/dom/FilamentAssignmentSelector';
import { LayerEventPanel } from './ui/dom/LayerEventPanel';
import { askThreeMfIntake } from './ui/dom/FileIntakeDialog';
import { askPrintSubmission } from './ui/dom/PrintSubmissionDialog';
import { askPrintJobConfirmation } from './ui/dom/PrintJobConfirmDialog';
import { PrintJobPanel } from './ui/dom/PrintJobPanel';
import { PrinterStatusBar } from './ui/dom/PrinterStatusBar';
import type { PresetJsonValue } from './settings/presets/PresetGraph';
import type {
  CalibrationComparison,
  CalibrationConditions,
  CalibrationHistoryIssue,
  CalibrationHistoryOperation,
} from './project/calibration/history';
import { fnv1a64Text } from './project/domain/canonical';
import { guardedPrinterActions, summarizePrinterStatus } from './printer/PrinterStatusSummary';
import {
  PresetLibraryStore,
  applyPresetLibraryOperation,
  coerceOverrideValue,
  type PresetLibraryIssue,
  type PresetLibraryOperation,
} from './settings/presets/PresetLibrary';
import { GcodePreviewPanel, type GcodePreviewPanelAdapter } from './ui/dom/GcodePreviewPanel';
import { PreviewScrubber } from './ui/dom/PreviewScrubber';
import { InspectorTabs } from './ui/dom/InspectorTabs';
import { PaintPanel } from './ui/dom/PaintPanel';
import { BrimEarsPanel } from './ui/dom/BrimEarsPanel';
import { EmbossPanel } from './ui/dom/EmbossPanel';
import { SvgPanel } from './ui/dom/SvgPanel';
import {
  forgetRememberedCredentials,
  loadRememberedCredentials,
  saveRememberedCredentials,
} from './settings/RememberedCredentials';
import { HELP_TOPICS, TROUBLESHOOTING, searchHelp } from './help/HelpCatalog';
import {
  DiagnosticsRecorder,
  buildDiagnosticsBundle,
  describeDiagnosticsBundle,
  serializeDiagnosticsBundle,
} from './diagnostics/DiagnosticsBundle';
import { PINNED_ENGINE_PROVENANCE } from './slicer/pinnedEngineProvenance';
import {
  addPrinter,
  adoptLegacyEndpoint,
  defaultPrinter,
  findPrinter,
  loadPrinterDirectory,
  removePrinter,
  savePrinterDirectory,
  setDefaultPrinter,
} from './printer/PrinterDirectory';
import {
  applyPreferences,
  exportPreferences,
  importPreferences,
  loadPreferences,
  resetPreferences,
  savePreferences,
} from './settings/Preferences';
import { MeasurePanel } from './ui/dom/MeasurePanel';
import { SmartPaintPanel } from './ui/dom/SmartPaintPanel';
import { PlateManager } from './ui/dom/PlateManager';
import { SemanticObjectEditor } from './ui/dom/SemanticObjectEditor';
import { VirtualFilamentLibrary } from './ui/dom/VirtualFilamentLibrary';
import { CanonicalVirtualFilamentLibraryAdapter } from './ui/dom/CanonicalVirtualFilamentLibraryAdapter';
import { renderProfileSelectionStatus } from './ui/dom/ProfileSelectionStatus';
import { SlicePreflightPanel } from './ui/dom/SlicePreflightPanel';
import { ColorMatchSearchWorkerClient } from './filaments/ColorMatchSearchWorkerClient';
import {
  loadFullSpectrumAutoPairPreferences,
  saveFullSpectrumAutoPairPreferences,
} from './filaments/FullSpectrumAutoPairPreferences';
import { AiConfigDialog } from './ui/dom/AiConfigDialog';
import { showProjectImportPreviewDialog } from './import/ProjectImportPreviewDialog';
import type { ObjectTreeEntityRef } from './project/objects';
import type { ConfigMap } from './project/domain/model';
import { loadEngineOptionCatalog, type EngineOptionCatalog } from './settings/generated/loader';
import { applySettingsCommitToConfig, decodeSettingsConfig } from './settings/editor';
import type { ProjectSettingsOverrideSnapshot } from './project/settingsOverrides';
import type { ScopedOverrideSnapshot, ScopedOverrideTargetOption } from './project/scopedOverrides';

declare global {
  interface Window {
    ORCAXR_VERSION: string;
  }
}
window.ORCAXR_VERSION = 'v34-xr-recenter';

// In dev, forcibly evict any leftover service worker + caches. vite dev serves
// index.html for /sw.js (SPA fallback), which is an invalid SW script, so a SW
// registered by a *previous* `vite preview`/prod visit on this origin can never
// self-update and gets stuck serving the stale app bundle — masking every code
// change. Kill it so dev is always fresh. (Prod keeps its autoUpdate SW.)
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      if (regs.length) {
        regs.forEach((r) => r.unregister());
        console.warn('[orcaxr] unregistered', regs.length, 'stale service worker(s) — reload for fresh code');
      }
    })
    .catch(() => {});
  if (typeof caches !== 'undefined') {
    caches
      .keys()
      .then((keys) => keys.forEach((k) => caches.delete(k)))
      .catch(() => {});
  }
}

/** Human summary of which tools a job needs and what the printer has loaded. */
function describeToolUsage(tools: readonly number[], slots: readonly MoonrakerFilamentSlot[] | undefined): string {
  if (tools.length === 0) return 'single filament';
  const used = tools.map((tool) => `T${tool}`).join(', ');
  if (!slots || slots.length === 0) {
    return `${tools.length} tool${tools.length === 1 ? '' : 's'} (${used}); printer slots not reported`;
  }
  const loaded = slots.map((slot) => `slot ${slot.slotIndex + 1} ${slot.material} ${slot.colorHex}`).join(', ');
  return `${tools.length} tool${tools.length === 1 ? '' : 's'} (${used}) — loaded: ${loaded}`;
}

/** Registry action that owns each lifecycle command, so the panel routes through one path. */
const PRINT_JOB_ACTION_IDS: Readonly<Record<PrintJobCommand, string>> = Object.freeze({
  pause: 'printer_pause_print',
  resume: 'printer_resume_print',
  cancel: 'printer_cancel_print',
  'emergency-stop': 'printer_emergency_stop',
  'firmware-restart': 'printer_emergency_stop',
});

/** Registry action that owns each storage operation, so the panel routes through one path. */
const PRINTER_STORAGE_ACTION_IDS: Readonly<Record<PrinterStorageOperation['kind'], string>> = Object.freeze({
  browse: 'printer_browse_storage',
  print: 'printer_print_stored_file',
  rename: 'printer_rename_stored_file',
  download: 'printer_download_stored_file',
  delete: 'printer_delete_stored_file',
});

/** Registry action that owns each console operation, so the panel routes through one path. */
const PRINTER_CONSOLE_ACTION_IDS: Readonly<Record<PrinterConsoleOperation['kind'], string>> = Object.freeze({
  send: 'printer_console_send',
  macro: 'printer_run_macro',
  'refresh-macros': 'printer_list_macros',
});

/**
 * The browser's own key/value store, or null when it refuses to hand it over
 * (private mode, a blocked third-party context). Module-level so every caller
 * reaches it the same way, whatever order the shell builds its panels in.
 */
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Bump the patch component, so each save is a distinguishable preset version. */
function nextPresetVersion(version: string): string {
  const parts = version.split('.');
  const patch = Number.parseInt(parts[2] ?? '', 10);
  if (parts.length !== 3 || !Number.isFinite(patch)) return `${version}+1`;
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

/** Registry action that owns each calibration-ledger operation (P8.5). */
const CALIBRATION_HISTORY_ACTION_IDS: Readonly<Record<CalibrationHistoryOperation['kind'], string>> = Object.freeze({
  refresh: 'calib_view_history',
  record: 'calib_record_result',
  compare: 'calib_compare_results',
  rerun: 'calib_rerun_result',
  apply: 'calib_apply_result',
  delete: 'calib_delete_result',
  export: 'calib_export_history',
});

/** Registry action that owns each preset-library operation (P6.4). */
const PRESET_LIBRARY_ACTION_IDS: Readonly<Record<PresetLibraryOperation['kind'], string>> = Object.freeze({
  install: 'presets_install_printer',
  create: 'presets_create_custom',
  update: 'presets_update_custom',
  delete: 'presets_delete_custom',
  export: 'presets_export_bundle',
  import: 'presets_import_bundle',
});

/** What just changed, in the operator's terms rather than the operation's. */
function describePresetChange(operation: PresetLibraryOperation): string {
  switch (operation.kind) {
    case 'install':
      return operation.variants.length === 0
        ? `Removed ${operation.model}.`
        : `${operation.model} now offers ${operation.variants.map((variant) => `${variant} mm`).join(', ')}.`;
    case 'create':
      return `Created ${operation.draft.name}.`;
    case 'update':
      return `Updated ${operation.name}.`;
    case 'delete':
      return `Deleted ${operation.name}.`;
    case 'import':
      return 'Replaced this setup from the bundle.';
    case 'export':
      return 'Exported this setup.';
  }
}

/** Commands that end or halt work already in progress get an explicit confirmation. */
const PRINT_JOB_CONFIRMATIONS: Partial<
  Record<
    PrintJobCommand,
    { title: string; message: string; consequences: readonly string[]; confirmLabel: string; dismissLabel: string }
  >
> = Object.freeze({
  cancel: {
    title: 'Cancel this print?',
    message: 'The printer stops the running job',
    consequences: ['The partially printed object cannot be resumed; it has to be started again from the beginning.'],
    confirmLabel: 'Cancel the print',
    dismissLabel: 'Keep printing',
  },
  'emergency-stop': {
    title: 'Emergency stop?',
    message: 'Klipper halts immediately',
    consequences: [
      'Heaters and motors stop at once, wherever the toolhead is.',
      'Klipper stays halted until the firmware is restarted, so the printer accepts nothing else until then.',
    ],
    confirmLabel: 'Stop the printer now',
    dismissLabel: 'Do not stop',
  },
});

const PRINT_JOB_OUTCOMES: Readonly<Record<PrintJobCommand, string>> = Object.freeze({
  pause: 'Paused the print on the printer.',
  resume: 'Resumed the print on the printer.',
  cancel: 'Cancelled the print on the printer.',
  'emergency-stop': 'Emergency stop sent. Klipper is halted and needs a firmware restart before it accepts work.',
  'firmware-restart': 'Firmware restart requested.',
});

function objectsEntityKey(entity: ObjectTreeEntityRef): string {
  return `${entity.kind}:${entity.id}`;
}

function cloneObjectsEntity<T extends ObjectTreeEntityRef>(entity: T): T {
  return { ...entity };
}

function objectsSelectionForRequest(
  snapshot: ReturnType<OrcaWorkspace['getObjectsTreeSnapshot']>,
  request: ObjectsPanelSelectionRequest,
): { readonly refs: readonly ObjectTreeEntityRef[]; readonly primary?: ObjectTreeEntityRef } {
  if (request.mode === 'replace') {
    return { refs: [cloneObjectsEntity(request.target)], primary: cloneObjectsEntity(request.target) };
  }
  if (request.mode === 'range') {
    const refs = (request.range ?? [request.target]).map(cloneObjectsEntity);
    return { refs, primary: cloneObjectsEntity(request.target) };
  }

  const targetKey = objectsEntityKey(request.target);
  const refs = snapshot.selection.refs.map(cloneObjectsEntity);
  const index = refs.findIndex((candidate) => objectsEntityKey(candidate) === targetKey);
  if (index >= 0) refs.splice(index, 1);
  else refs.push(cloneObjectsEntity(request.target));
  const existingPrimary = snapshot.selection.primary;
  const primary =
    index < 0
      ? cloneObjectsEntity(request.target)
      : existingPrimary && refs.some((candidate) => objectsEntityKey(candidate) === objectsEntityKey(existingPrimary))
        ? cloneObjectsEntity(existingPrimary)
        : refs.at(-1);
  return { refs, ...(primary ? { primary } : {}) };
}

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace, uiState: UiState, actionCtx: ActionContext, registry: ActionRegistry) {
  workspace.onRequestNewProjectConfirmation = () =>
    window.confirm('Discard the current unsaved project and start a new project?');
  workspace.onRequestSplitToObjectsConfirmation = (confirmation) =>
    window.confirm(
      `Split “${confirmation.objectName}” into separate objects?\n\n` +
        `${confirmation.strategy === 'existing-volumes' ? `${confirmation.volumeCount} existing volumes will be promoted` : `${confirmation.triangleCount.toLocaleString()} triangles will be separated by connected body`} across all ${confirmation.affectedInstanceIds.length} instance${confirmation.affectedInstanceIds.length === 1 ? '' : 's'}.\n\n` +
        'The original object will be replaced in one undoable edit.',
    );
  // On phones the sidebar is a bottom sheet; its title toggles collapse so
  // the 3D view isn't permanently half-covered. No-op on desktop layouts.
  const sidebar = document.getElementById('right-sidebar') as HTMLDivElement;
  // Start collapsed so the "OrcaXR Slicer" panel doesn't cover the build plate
  // on load on phones — the user taps the title to expand it. The `.collapsed`
  // styles live ONLY inside the max-width:768px media query, so this is a no-op
  // on desktop (the full sidebar always renders there); applying it
  // unconditionally avoids a matchMedia load-timing race on mobile.
  sidebar.classList.add('collapsed');
  sidebar.querySelector('h2')?.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      sidebar.classList.toggle('collapsed');
    }
  });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const statusText = document.getElementById('status-text') as HTMLParagraphElement;
  const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
  const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
  const loadingModal = document.getElementById('loading-modal') as HTMLDivElement;
  const loadingModalBar = document.getElementById('loading-modal-bar') as HTMLDivElement;
  const loadingModalText = document.getElementById('loading-modal-text') as HTMLParagraphElement;
  const emptyState = document.getElementById('workspace-empty-state') as HTMLElement;
  const emptyLoadModel = document.getElementById('empty-load-model') as HTMLButtonElement;
  const domSliceProgress = document.getElementById('dom-slice-progress') as HTMLElement;
  const uiContainer = document.getElementById('ui-container') as HTMLElement;
  const toolRail = document.getElementById('tool-rail') as HTMLElement;
  const toolbarToggle = document.getElementById('toolbar-toggle') as HTMLButtonElement;
  const statusDot = document.getElementById('status-dot') as HTMLElement;
  const printerHost = document.getElementById('printer-host') as HTMLInputElement;
  const printerApiKey = document.getElementById('printer-api-key') as HTMLInputElement;
  const btnPrinterTest = document.getElementById('btn-printer-test') as HTMLButtonElement;
  const btnPrinterSend = document.getElementById('btn-printer-send') as HTMLButtonElement;
  const printerCfg = loadPrinterEndpointPreferences();
  let printerTransport: MoonrakerTransport | null = null;
  let printerTransportKey = '';
  let hadModels = false;

  // One live job model per session. It is seeded from an explicit query and
  // then kept current by the transport's own status notifications, so the
  // panel shows what the machine reports rather than what this tab last asked
  // for — a job started at the printer's own screen appears here too.
  const printJobStatus = new PrintJobStatusModel();
  let printJobSnapshot: PrintJobSnapshot | null = null;
  let printerConnectionState: MoonrakerConnectionState | null = null;
  let unsubscribePrintJob: (() => void) | null = null;
  /**
   * Surfaces that derive from the active profile subscribe here rather than
   * each one racing to own `onProfileChanged`.
   */
  const profileChangeListeners = new Set<() => void>();
  const printJobListeners = new Set<() => void>();
  const publishPrintJob = (snapshot: PrintJobSnapshot | null) => {
    printJobSnapshot = snapshot;
    uiState.update({ printerJobState: snapshot?.state ?? 'disconnected' });
    for (const listener of printJobListeners) listener();
  };

  /** True only while the printer itself can confirm what it just reported. */
  const printerReadingIsStale = (): boolean => printerConnectionState?.status !== 'connected';

  const livePrinterStatus = () =>
    summarizePrinterStatus({
      snapshot: printJobSnapshot,
      connection: printerConnectionState,
      nowMs: Date.now(),
      configured: Boolean(printerCfg.host.trim()),
    });

  const livePrinterActions = () => {
    const summary = livePrinterStatus();
    return guardedPrinterActions(printJobCommandAvailability(printJobSnapshot), {
      stale: summary.stale,
      ...(summary.recovery ? { staleReason: summary.recovery.message } : {}),
    });
  };

  const disposePrinterTransport = () => {
    unsubscribePrintJob?.();
    unsubscribePrintJob = null;
    printerTransport?.dispose();
    printerTransport = null;
    printerTransportKey = '';
    printJobStatus.reset();
    publishPrintJob(null);
  };

  /** The send button doubles as the cancel affordance while a send is running. */
  const setPrinterSendBusy = (busy: boolean) => {
    btnPrinterSend.textContent = busy ? 'Cancel send' : 'Send to Printer';
    btnPrinterSend.title = busy
      ? 'Stop the send in progress'
      : 'Upload the sliced G-code to the configured Moonraker printer';
    btnPrinterSend.disabled = busy ? false : !uiState.get().gcodeReady;
    btnPrinterSend.setAttribute('aria-busy', String(busy));
    btnPrinterSend.dataset.sendBusy = String(busy);
  };

  const configuredPrinterTransport = (): MoonrakerTransport => {
    const endpoint = printerCfg.host.trim();
    if (!endpoint) throw new MoonrakerTransportError('invalid_endpoint', 'connect');
    const key = `${endpoint}|${printerCfg.port}`;
    if (!printerTransport || printerTransportKey !== key) {
      disposePrinterTransport();
      printerTransport = new MoonrakerTransport({
        endpoint,
        defaultPort: printerCfg.port,
        clientName: 'OrcaXR Web',
        clientVersion: window.ORCAXR_VERSION,
      });
      printerTransportKey = key;
    }
    printerTransport.setSessionCredentials({ apiKey: printerApiKey.value.trim() || undefined });
    return printerTransport;
  };

  /**
   * Start (or restart) live job tracking on a connected transport: subscribe to
   * the Klipper objects the model reads, seed it from one explicit query, then
   * fold in every status notification. A re-seed on reconnect keeps a dropped
   * socket from leaving a stale "printing" readout on screen.
   */
  const trackPrintJob = (transport: MoonrakerTransport): void => {
    unsubscribePrintJob?.();
    transport.setObjectSubscription(PRINT_JOB_OBJECTS);
    const stopNotifications = transport.subscribeNotifications((notification) => {
      if (notification.method !== 'notify_status_update') return;
      const next = printJobStatus.applyNotification(notification.params);
      if (next) publishPrintJob(next);
    });
    const seed = () => {
      void transport
        .request<unknown>(PRINT_JOB_QUERY_PATH, { operation: 'print_job_status' })
        .then((payload) => publishPrintJob(printJobStatus.applyQuery(payload)))
        .catch(() => publishPrintJob(null));
    };
    const stopState = transport.subscribeState((state) => {
      printerConnectionState = state;
      if (state.status === 'connected') {
        seed();
        return;
      }
      // The last reading is kept rather than blanked: mid-job it is still the
      // most useful thing on screen, and the compact surface labels it with its
      // age. What does change is that nothing may be *acted* on — canonical UI
      // state drops to disconnected, so every guarded command is refused until
      // the printer can confirm its own state again.
      if (state.status !== 'connecting') printJobStatus.reset();
      uiState.update({ printerJobState: 'disconnected' });
      for (const listener of printJobListeners) listener();
    });
    unsubscribePrintJob = () => {
      stopNotifications();
      stopState();
    };
  };

  const connectConfiguredPrinter = async (): Promise<{
    transport: MoonrakerTransport;
    handshake: MoonrakerHandshake;
  }> => {
    const transport = configuredPrinterTransport();
    const handshake = await transport.connect();
    if (!unsubscribePrintJob) trackPrintJob(transport);
    return { transport, handshake };
  };

  workspace.onRequestPrinterConnectionTest = async () => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    workspace.setStatus('Testing printer connection…');
    try {
      const { handshake } = await connectConfiguredPrinter();
      const capabilities = [
        handshake.capabilities.fileManagement ? 'files' : null,
        handshake.capabilities.jobQueue ? 'queue' : null,
        handshake.capabilities.webcams ? 'webcam' : null,
      ].filter(Boolean);
      workspace.setStatus(
        `Connected — ${handshake.printer.hostname || 'printer'} ${handshake.printer.state}; Moonraker ${handshake.server.moonrakerVersion}${capabilities.length ? ` (${capabilities.join(', ')})` : ''}.`,
      );
    } catch (error) {
      workspace.setStatus(`No response: ${(error as Error).message}`);
    }
  };

  workspace.onRequestPrinterFilamentInspection = async () => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    workspace.setStatus('Reading filament slots from the connected printer…');
    try {
      const { transport, handshake } = await connectConfiguredPrinter();
      if (!handshake.capabilities.klippyConnected) {
        throw new MoonrakerTransportError('invalid_state', 'query_filament_slots');
      }
      const slots = await queryMoonrakerFilamentSlots(transport);
      if (slots.length === 0) {
        workspace.setStatus('The printer reported no loaded filament slots.');
        return;
      }
      const summary = slots.map((slot) => `H${slot.slotIndex + 1}: ${slot.material} ${slot.colorHex}`).join('; ');
      // Adopting the machine's own loaded filaments is a project edit, so it
      // goes through one undoable canonical command and reports what changed.
      if (!workspace.syncFilamentsFromPrinter(slots)) {
        workspace.setStatus(`Printer filaments: ${summary}.`);
      }
    } catch (error) {
      workspace.setStatus(`Filament inspection failed: ${(error as Error).message}`);
    }
  };

  // One in-flight send at a time, cancellable from the same button that
  // started it. A second send cannot race the first onto the same printer.
  let printSubmission: AbortController | null = null;

  workspace.onRequestPrintSubmission = async (intent) => {
    if (printSubmission) {
      workspace.setStatus('A send is already in progress; cancel it before starting another.');
      return;
    }
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    const controller = new AbortController();
    printSubmission = controller;
    setPrinterSendBusy(true);
    try {
      workspace.setStatus('Connecting to the printer…');
      const { transport, handshake } = await connectConfiguredPrinter();
      if (!handshake.capabilities.fileManagement) {
        workspace.setStatus('This Moonraker instance does not expose file management; nothing was sent.');
        return;
      }
      // Read the machine's own facts before asking anything: what it is doing,
      // and what it actually has loaded.
      const readiness = await queryPrintReadiness(transport, controller.signal);
      let slots: readonly MoonrakerFilamentSlot[] | undefined;
      try {
        slots = await queryMoonrakerFilamentSlots(transport, controller.signal);
      } catch {
        // Not every Moonraker exposes Snapmaker's slot object; the mapping
        // check then reports "unknown" instead of pretending it matched.
        slots = undefined;
      }
      const mapping = validateToolMapping(intent.usage, slots);
      const readinessBlockers = readiness.blockers.map((blocker) => blocker.message);
      const decision = await askPrintSubmission({
        filename: intent.filename,
        plateName: intent.plateName,
        byteLength: new TextEncoder().encode(intent.gcode).byteLength,
        endpointLabel: handshake.printer.hostname || printerCfg.host.trim(),
        printerStateLabel: readiness.ready ? `ready (${readiness.printState ?? 'idle'})` : readinessBlockers.join(' '),
        toolSummary: describeToolUsage(intent.usage.tools, slots),
        blockers: [...mapping.blockers.map((notice) => notice.message), ...(readiness.ready ? [] : readinessBlockers)],
        warnings: mapping.warnings.map((notice) => notice.message),
      });
      if (decision.choice === 'cancel') {
        workspace.setStatus('Send cancelled; nothing was uploaded.');
        return;
      }
      // The dialog waits on a person, and a printer connection does not wait
      // with it. Re-establish before committing to an upload that may take
      // minutes, rather than discovering the session lapsed partway through.
      await connectConfiguredPrinter();
      const result = await submitPrintJob(transport, {
        filename: intent.filename,
        gcode: intent.gcode,
        startPrint: decision.choice === 'upload-and-print',
        overwrite: decision.overwrite,
        signal: controller.signal,
        // An upload has no deadline, so the status line is what tells an
        // operator it is alive. `fetch` cannot report bytes sent, so this
        // counts time rather than inventing a percentage, and points at the
        // button that stops it.
        onUploadElapsed: ({ elapsedMs, totalBytes }) => {
          const seconds = Math.floor(elapsedMs / 1000);
          const clock = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
          workspace.setStatus(
            `Uploading ${intent.filename} (${(totalBytes / 1048576).toFixed(1)} MB) — ${clock} elapsed. ` +
              'Press Cancel send to stop.',
          );
        },
        onPhase: (phase) => {
          const message =
            phase === 'uploading'
              ? // Naming the size is what distinguishes "this is a big file" from
                // "this has hung", on an upload that legitimately runs for minutes.
                `Uploading ${intent.filename} (${(new Blob([intent.gcode]).size / 1048576).toFixed(1)} MB)…`
              : phase === 'verifying'
                ? 'Verifying the stored file…'
                : phase === 'starting'
                  ? 'Starting the print…'
                  : phase === 'checking'
                    ? 'Checking the printer…'
                    : null;
          if (message) workspace.setStatus(message);
        },
      });
      if (result.startedPrint) {
        // We just changed what the machine is doing; read it back rather than
        // waiting for the next push so the live panel is correct immediately.
        await transport
          .request<unknown>(PRINT_JOB_QUERY_PATH, { operation: 'print_job_status' })
          .then((payload) => publishPrintJob(printJobStatus.applyQuery(payload)))
          .catch(() => {});
      }
      const renamed = result.renamedFrom ? ` (stored as ${result.path} to avoid replacing ${result.renamedFrom})` : '';
      workspace.setStatus(
        result.startedPrint
          ? `Printing ${result.path} — ${(result.verifiedBytes / 1024).toFixed(0)} KB verified on the printer${renamed}.`
          : `Uploaded ${result.path} — ${(result.verifiedBytes / 1024).toFixed(0)} KB verified; start it from the printer when ready${renamed}.`,
      );
    } catch (error) {
      const message =
        error instanceof PrintSubmissionError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      workspace.setStatus(`Send failed: ${message}`);
    } finally {
      printSubmission = null;
      setPrinterSendBusy(false);
    }
  };

  // Lifecycle commands act on a running machine, so each one is checked twice:
  // the registry gates it on the state the panel is showing, and the transport
  // call re-checks the freshly re-read state before anything is sent.
  workspace.onRequestPrintJobCommand = async (command, options) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    // A surface that already took an explicit confirmation gesture — the status
    // surface's hold — does not get asked again. Two confirmations for one act
    // teaches people to dismiss both without reading either.
    const confirmation = options?.preconfirmed ? undefined : PRINT_JOB_CONFIRMATIONS[command];
    if (confirmation) {
      const filename = printJobSnapshot?.filename;
      const confirmed = await askPrintJobConfirmation({
        ...confirmation,
        message: filename ? `${confirmation.message} (${filename})` : confirmation.message,
      });
      if (!confirmed) {
        workspace.setStatus(
          `${command === 'cancel' ? 'Cancel' : 'Emergency stop'} dismissed; the printer was left alone.`,
        );
        return;
      }
    }
    try {
      const { transport } = await connectConfiguredPrinter();
      // Re-read the machine immediately before acting: the operator may have
      // been looking at a panel drawn before the job changed.
      const observed = await transport
        .request<unknown>(PRINT_JOB_QUERY_PATH, { operation: 'print_job_status' })
        .then((payload) => publishPrintJob(printJobStatus.applyQuery(payload)) ?? printJobSnapshot)
        .catch(() => printJobSnapshot);
      await executePrintJobCommand(transport, {
        command,
        observed,
        ...(observed?.filename ? { expectedFilename: observed.filename } : {}),
      });
      workspace.setStatus(PRINT_JOB_OUTCOMES[command]);
    } catch (error) {
      const message =
        error instanceof PrintJobCommandError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      workspace.setStatus(message);
    }
  };

  // Printer storage: browsing, reprinting, renaming, downloading, and deleting
  // what is already on the machine. Every operation goes through the registry so
  // the same guarded path serves the panel, the command palette, and automation.
  const storageState: {
    listing?: PrinterDirectoryListing;
    metadata?: PrinterFileMetadata;
    thumbnailUrl?: string;
    selected?: string;
    busy: boolean;
    message?: string;
  } = { busy: false };
  const storageListeners = new Set<() => void>();
  const notifyStorage = () => {
    for (const listener of storageListeners) listener();
  };
  const releaseThumbnail = () => {
    if (storageState.thumbnailUrl) URL.revokeObjectURL(storageState.thumbnailUrl);
    delete storageState.thumbnailUrl;
  };
  /**
   * Read the selected file's own metadata and thumbnail.
   *
   * A file the printer has never scanned simply has none; that is reported as
   * absent rather than retried, because the retry would return the same nothing.
   */
  const loadStorageSelection = async (transport: MoonrakerTransport, path: string): Promise<void> => {
    releaseThumbnail();
    delete storageState.metadata;
    try {
      storageState.metadata = await readPrinterFileMetadata(transport, path);
    } catch {
      return;
    }
    const thumbnail = storageState.metadata.thumbnails[0];
    if (!thumbnail) return;
    try {
      const bytes = await downloadPrinterFile(transport, thumbnail.path);
      storageState.thumbnailUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    } catch {
      // A missing thumbnail is a missing thumbnail; the facts still render.
    }
  };

  workspace.onRequestPrinterStorage = async (operation) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    storageState.busy = true;
    notifyStorage();
    try {
      const { transport } = await connectConfiguredPrinter();
      switch (operation.kind) {
        case 'browse': {
          storageState.listing = await listPrinterDirectory(transport, operation.path ?? '');
          // A selection that the new listing does not contain is dropped rather
          // than kept pointing at a file this folder does not hold.
          if (storageState.selected && !storageState.listing.files.some((f) => f.path === storageState.selected)) {
            delete storageState.selected;
            delete storageState.metadata;
            releaseThumbnail();
          }
          storageState.message = `${storageState.listing.files.length} file${
            storageState.listing.files.length === 1 ? '' : 's'
          } in gcodes${storageState.listing.path ? `/${storageState.listing.path}` : ''}.`;
          break;
        }
        case 'print': {
          const started = await startStoredPrint(transport, operation.path);
          await transport
            .request<unknown>(PRINT_JOB_QUERY_PATH, { operation: 'print_job_status' })
            .then((payload) => publishPrintJob(printJobStatus.applyQuery(payload)))
            .catch(() => {});
          storageState.message = `Printing ${started}.`;
          workspace.setStatus(`Printing ${started} from the printer's own storage.`);
          break;
        }
        case 'rename': {
          const next = await movePrinterFile(
            transport,
            operation.path,
            renamedStoragePath(operation.path, operation.nextName),
          );
          storageState.selected = next;
          storageState.listing = await listPrinterDirectory(transport, storageState.listing?.path ?? '');
          await loadStorageSelection(transport, next);
          storageState.message = `Renamed to ${next}.`;
          break;
        }
        case 'download': {
          const bytes = await downloadPrinterFile(transport, operation.path);
          workspace.onDownloadFile?.(
            operation.path.split('/').pop() ?? operation.path,
            new TextDecoder().decode(bytes),
            'text/plain',
          );
          storageState.message = `Downloaded ${operation.path}.`;
          break;
        }
        case 'delete': {
          await deletePrinterFile(transport, operation.path);
          if (storageState.selected === operation.path) {
            delete storageState.selected;
            delete storageState.metadata;
            releaseThumbnail();
          }
          storageState.listing = await listPrinterDirectory(transport, storageState.listing?.path ?? '');
          storageState.message = `Deleted ${operation.path}.`;
          break;
        }
      }
    } catch (error) {
      const message =
        error instanceof PrinterStorageError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      storageState.message = message;
      workspace.setStatus(`Printer storage: ${message}`);
    } finally {
      storageState.busy = false;
      notifyStorage();
    }
  };

  const printerStorageHost = document.getElementById('printer-storage-host');
  if (printerStorageHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void (async () => {
      const { PrinterStoragePanel } = await import('./ui/dom/PrinterStoragePanel');
      const storagePanel = new PrinterStoragePanel(printerStorageHost, {
        getListing: () => storageState.listing,
        getMetadata: () => storageState.metadata,
        getThumbnailUrl: () => storageState.thumbnailUrl,
        getSelectedPath: () => storageState.selected,
        getStatus: () => ({
          busy: storageState.busy,
          ...(storageState.message ? { message: storageState.message } : {}),
        }),
        subscribe: (listener) => {
          storageListeners.add(listener);
          return () => storageListeners.delete(listener);
        },
        select: (path) => {
          storageState.selected = path;
          delete storageState.metadata;
          releaseThumbnail();
          notifyStorage();
          if (!path) return;
          void connectConfiguredPrinter()
            .then(({ transport }) => loadStorageSelection(transport, path))
            .catch(() => {})
            .finally(notifyStorage);
        },
        run: async (operation) => {
          await registry.invoke(PRINTER_STORAGE_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
            printerStorage: operation,
          });
        },
        askName: async (current) => {
          const next = window.prompt('New name for this file on the printer', current);
          return next === null ? undefined : next.trim();
        },
        confirmDelete: (path) =>
          askPrintJobConfirmation({
            title: 'Delete this file from the printer?',
            message: path,
            consequences: [
              'The file is removed from the printer immediately.',
              'This cannot be undone from OrcaXR, and the printer may be the only place it exists.',
            ],
            confirmLabel: 'Delete file',
            dismissLabel: 'Keep it',
          }),
      });
      storagePanel.mount();
      window.addEventListener(
        'pagehide',
        () => {
          releaseThumbnail();
          storagePanel.dispose();
        },
        { once: true },
      );
    })();
  }

  // The console: what is typed goes to the firmware, so nothing is sent until
  // its assessment has been shown and — when it moves, heats, or halts —
  // explicitly confirmed. Responses arrive over the socket, not the HTTP reply.
  // The transcript is copied into support bundles, so the key is redacted on
  // the way in rather than at render time.
  const consoleLog = new PrinterConsoleLog(200, () =>
    [printerApiKey.value.trim()].filter((entry): entry is string => entry.length > 0),
  );
  const consoleState: { macros: readonly PrinterMacro[]; busy: boolean; message?: string } = {
    macros: [],
    busy: false,
  };
  const consoleListeners = new Set<() => void>();
  const notifyConsole = () => {
    for (const listener of consoleListeners) listener();
  };
  let unsubscribeConsole: (() => void) | undefined;
  const trackConsoleResponses = (transport: MoonrakerTransport) => {
    if (unsubscribeConsole) return;
    unsubscribeConsole = transport.subscribeNotifications((notification) => {
      if (consoleLog.appendNotification(notification.method, notification.params)) notifyConsole();
    });
  };

  workspace.onRequestPrinterConsole = async (operation) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    consoleState.busy = true;
    notifyConsole();
    try {
      const { transport } = await connectConfiguredPrinter();
      trackConsoleResponses(transport);
      if (operation.kind === 'refresh-macros') {
        consoleState.macros = await listPrinterMacros(transport);
        consoleState.message = `${consoleState.macros.length} macro${
          consoleState.macros.length === 1 ? '' : 's'
        } read from the printer.`;
        return;
      }
      const script =
        operation.kind === 'send' ? operation.script : buildMacroInvocation(operation.name, operation.values ?? {});
      const assessment = assessGcodeCommand(script, printJobSnapshot);
      if (assessment.level !== 'safe') {
        const confirmed = await askPrintJobConfirmation({
          title: assessment.level === 'dangerous' ? 'Run this command anyway?' : 'Run this command?',
          message: script,
          consequences: assessment.reasons,
          confirmLabel: `Run ${assessment.command}`,
          dismissLabel: 'Do not run it',
        });
        if (!confirmed) {
          consoleState.message = `${assessment.command} was not sent.`;
          return;
        }
      }
      await runGcodeScript(transport, script);
      consoleLog.append('sent', script);
      consoleState.message = `Sent ${assessment.command || script}.`;
    } catch (error) {
      const message =
        error instanceof PrinterConsoleError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      consoleLog.append('error', message);
      consoleState.message = message;
      workspace.setStatus(`Printer console: ${message}`);
    } finally {
      consoleState.busy = false;
      notifyConsole();
    }
  };

  const printerConsoleHost = document.getElementById('printer-console-host');
  if (printerConsoleHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void (async () => {
      const { PrinterConsolePanel } = await import('./ui/dom/PrinterConsolePanel');
      const consolePanel = new PrinterConsolePanel(printerConsoleHost, {
        getEntries: () => consoleLog.entries,
        getMacros: () => consoleState.macros,
        getRecentCommands: () => recentCommands(consoleLog.entries),
        assess: (script) => assessGcodeCommand(script, printJobSnapshot),
        getStatus: () => ({
          busy: consoleState.busy,
          ...(consoleState.message ? { message: consoleState.message } : {}),
        }),
        subscribe: (listener) => {
          consoleListeners.add(listener);
          return () => consoleListeners.delete(listener);
        },
        run: async (operation) => {
          await registry.invoke(PRINTER_CONSOLE_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
            printerConsole: operation,
          });
        },
        askParameters: async (macro) => {
          const values: Record<string, string> = {};
          for (const parameter of macro.parameters) {
            const supplied = window.prompt(
              `${macro.name} — ${parameter.name}${parameter.required ? ' (required)' : ''}`,
              parameter.defaultValue ?? '',
            );
            if (supplied === null) return undefined;
            if (supplied.trim()) values[parameter.name] = supplied.trim();
          }
          return values;
        },
      });
      consolePanel.mount();
      window.addEventListener('pagehide', () => consolePanel.dispose(), { once: true });
    })();
  }

  // The printer's own record of what it has run. Paged rather than fetched
  // whole: a machine in daily service has thousands of jobs.
  const historyState: {
    page?: PrintHistoryPage;
    totals?: PrintHistoryTotals;
    busy: boolean;
    message?: string;
  } = { busy: false };
  const historyListeners = new Set<() => void>();
  const notifyHistory = () => {
    for (const listener of historyListeners) listener();
  };

  workspace.onRequestPrintHistory = async (start) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    historyState.busy = true;
    notifyHistory();
    try {
      const { transport } = await connectConfiguredPrinter();
      historyState.page = await listPrintHistory(transport, { start, limit: 20 });
      // Totals are a separate endpoint; a printer that lists jobs but keeps no
      // totals still shows its jobs rather than failing the whole load.
      historyState.totals = await readPrintHistoryTotals(transport).catch(() => undefined);
      historyState.message = `${historyState.page.total} recorded job${historyState.page.total === 1 ? '' : 's'}.`;
    } catch (error) {
      const message =
        error instanceof PrintHistoryError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      historyState.message = message;
      workspace.setStatus(`Print history: ${message}`);
    } finally {
      historyState.busy = false;
      notifyHistory();
    }
  };

  const printerHistoryHost = document.getElementById('printer-history-host');
  if (printerHistoryHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void (async () => {
      const { PrintHistoryPanel } = await import('./ui/dom/PrintHistoryPanel');
      const historyPanel = new PrintHistoryPanel(printerHistoryHost, {
        getPage: () => historyState.page,
        getTotals: () => historyState.totals,
        getStatus: () => ({
          busy: historyState.busy,
          ...(historyState.message ? { message: historyState.message } : {}),
        }),
        subscribe: (listener) => {
          historyListeners.add(listener);
          return () => historyListeners.delete(listener);
        },
        load: async (start) => {
          await registry.invoke('printer_view_history', 'dom-inspector', actionCtx, uiState.get(), {
            printHistoryStart: start,
          });
        },
      });
      historyPanel.mount();
      window.addEventListener('pagehide', () => historyPanel.dispose(), { once: true });
    })();
  }

  // The camera. Every frame is its own authenticated request, so the panel owns
  // a timer that stops the moment nobody can see it.
  const cameraState: {
    cameras: readonly PrinterCamera[];
    selected?: string;
    frameUrl?: string;
    busy: boolean;
    message?: string;
  } = { cameras: [], busy: false };
  const cameraListeners = new Set<() => void>();
  const notifyCamera = () => {
    for (const listener of cameraListeners) listener();
  };
  const releaseFrame = () => {
    if (cameraState.frameUrl) URL.revokeObjectURL(cameraState.frameUrl);
    delete cameraState.frameUrl;
  };
  const selectedCamera = () =>
    cameraState.cameras.find((camera) => camera.uid === cameraState.selected) ?? cameraState.cameras[0];

  workspace.onRequestPrinterCamera = async (uid) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus('Enter an explicit Moonraker endpoint first.');
      return;
    }
    cameraState.busy = true;
    notifyCamera();
    try {
      const { transport } = await connectConfiguredPrinter();
      cameraState.cameras = await listPrinterCameras(transport);
      // Prefer a camera that can actually be shown, so the first thing anyone
      // sees is a picture rather than an explanation.
      const requested = uid ?? cameraState.selected;
      cameraState.selected =
        cameraState.cameras.find((camera) => camera.uid === requested)?.uid ??
        cameraState.cameras.find((camera) => camera.snapshotPath && camera.enabled)?.uid ??
        cameraState.cameras[0]?.uid;
      releaseFrame();
      cameraState.message =
        cameraState.cameras.length === 0
          ? 'This printer reports no cameras.'
          : `${cameraState.cameras.length} camera${cameraState.cameras.length === 1 ? '' : 's'} found.`;
      document.getElementById('printer-camera-details')?.setAttribute('open', '');
    } catch (error) {
      const message =
        error instanceof PrinterCameraError || error instanceof MoonrakerTransportError
          ? error.message
          : (error as Error).message;
      cameraState.message = message;
      workspace.setStatus(`Printer camera: ${message}`);
    } finally {
      cameraState.busy = false;
      notifyCamera();
    }
  };

  const printerCameraHost = document.getElementById('printer-camera-host');
  if (printerCameraHost) {
    const cameraDetails = document.getElementById('printer-camera-details') as HTMLDetailsElement | null;
    const visibilityListeners = new Set<() => void>();
    const announceVisibility = () => {
      for (const listener of visibilityListeners) listener();
    };
    document.addEventListener('visibilitychange', announceVisibility);
    cameraDetails?.addEventListener('toggle', announceVisibility);
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void (async () => {
      const { PrinterCameraPanel } = await import('./ui/dom/PrinterCameraPanel');
      const cameraPanel = new PrinterCameraPanel(
        printerCameraHost,
        {
          getCameras: () => cameraState.cameras,
          getSelected: () => selectedCamera(),
          getFrameUrl: () => cameraState.frameUrl,
          getStatus: () => ({
            busy: cameraState.busy,
            ...(cameraState.message ? { message: cameraState.message } : {}),
          }),
          subscribe: (listener) => {
            cameraListeners.add(listener);
            return () => cameraListeners.delete(listener);
          },
          select: (uid) => {
            cameraState.selected = uid;
            releaseFrame();
            notifyCamera();
          },
          refresh: async () => {
            await registry.invoke('view_webcam', 'dom-inspector', actionCtx, uiState.get());
          },
          captureFrame: async () => {
            const camera = selectedCamera();
            if (!camera?.snapshotPath) return;
            try {
              const { transport } = await connectConfiguredPrinter();
              const bytes = await fetchCameraSnapshot(transport, camera);
              releaseFrame();
              cameraState.frameUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
              delete cameraState.message;
            } catch (error) {
              cameraState.message = error instanceof PrinterCameraError ? error.message : (error as Error).message;
            }
            notifyCamera();
          },
        },
        {
          // Hidden tab or collapsed section both mean nobody is watching.
          isVisible: () => document.visibilityState === 'visible' && cameraDetails?.open !== false,
          subscribeVisibility: (listener) => {
            visibilityListeners.add(listener);
            return () => visibilityListeners.delete(listener);
          },
          setInterval: (handler, ms) => window.setInterval(handler, ms),
          clearInterval: (handle) => window.clearInterval(handle),
        },
      );
      cameraPanel.mount();
      window.addEventListener(
        'pagehide',
        () => {
          releaseFrame();
          cameraPanel.dispose();
          document.removeEventListener('visibilitychange', announceVisibility);
        },
        { once: true },
      );
    })();
  }

  const printJobHost = document.getElementById('printer-job-host');
  if (printJobHost) {
    const panel = new PrintJobPanel(printJobHost, {
      getSnapshot: () => printJobSnapshot,
      getCommands: () =>
        livePrinterActions().map((action) => ({
          command: action.command,
          label: action.label,
          destructive: action.destructive,
          allowed: action.enabled,
          ...(action.reason ? { reason: action.reason } : {}),
        })),
      subscribe: (listener) => {
        printJobListeners.add(listener);
        return () => printJobListeners.delete(listener);
      },
      onCommand: async (command) => {
        await registry.invoke(PRINT_JOB_ACTION_IDS[command], 'dom-inspector', actionCtx, uiState.get());
      },
    });
    panel.mount();
    window.addEventListener('pagehide', () => panel.dispose(), { once: true });
  }

  // The glanceable printer status (P9.7). It follows the live job on its own;
  // the override only decides whether the operator has pinned or dismissed it,
  // and is dropped whenever the job state changes so a new print re-asserts the
  // default rather than staying hidden behind an old dismissal.
  /**
   * The operator's preset library, shared by the setup panel that owns it and
   * the calibration ledger that writes results into it.
   */
  let presetStore: PresetLibraryStore | undefined;

  const printerStatusHost = document.getElementById('printer-status-host');
  if (printerStatusHost) {
    let statusOverride: boolean | undefined;
    let lastJobState: string | undefined;

    const statusListeners = new Set<() => void>();
    const notifyStatusBar = () => {
      for (const listener of statusListeners) listener();
    };
    printJobListeners.add(() => {
      const state = printJobSnapshot?.state;
      if (state !== lastJobState) {
        lastJobState = state;
        statusOverride = undefined;
      }
      notifyStatusBar();
    });

    const statusBar = new PrinterStatusBar(printerStatusHost, {
      getSummary: () => {
        const summary = livePrinterStatus();
        return statusOverride === undefined ? summary : { ...summary, present: statusOverride };
      },
      getActions: () => livePrinterActions(),
      subscribe: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      run: async (command) => {
        // The hold that got here *is* the confirmation, and it stated the
        // consequence before it completed.
        await registry.invoke(PRINT_JOB_ACTION_IDS[command], 'dom-inspector', actionCtx, uiState.get(), {
          printJobPreconfirmed: true,
        });
      },
      reconnect: async () => {
        try {
          await connectConfiguredPrinter();
        } catch (error) {
          workspace.setStatus(`Reconnect failed: ${(error as Error).message}`);
        }
        notifyStatusBar();
      },
      openDetails: () => {
        document.getElementById('insp-tab-printer')?.click();
        notifyStatusBar();
      },
    });
    statusBar.mount();

    // A stale reading's age is the only thing on the surface that changes with
    // nothing else happening, so it gets its own slow tick — and only while it
    // is actually stale, so an idle session schedules nothing.
    const ageTimer = window.setInterval(() => {
      if (printerReadingIsStale() && printJobSnapshot) notifyStatusBar();
    }, 5_000);

    // The spatial card renders the same summary and the same guarded actions;
    // only the gesture differs, and that lives in the shared hold machine.
    workspace.onReadPrinterStatus = () => {
      const summary = livePrinterStatus();
      return {
        summary: statusOverride === undefined ? summary : { ...summary, present: statusOverride },
        actions: livePrinterActions(),
      };
    };
    workspace.onRunPrinterStatusCommand = async (command) => {
      await registry.invoke(PRINT_JOB_ACTION_IDS[command], 'xr-menu', actionCtx, uiState.get(), {
        printJobPreconfirmed: true,
      });
    };
    workspace.onReconnectPrinter = async () => {
      try {
        await connectConfiguredPrinter();
      } catch (error) {
        workspace.setStatus(`Reconnect failed: ${(error as Error).message}`);
      }
      notifyStatusBar();
    };
    statusListeners.add(() => workspace.refreshPrinterStatusCard());

    workspace.onTogglePrinterStatusBar = () => {
      statusOverride = !(statusOverride ?? livePrinterStatus().present);
      notifyStatusBar();
      workspace.setStatus(statusOverride ? 'Printer status pinned over the plate.' : 'Printer status hidden.');
    };

    window.addEventListener(
      'pagehide',
      () => {
        window.clearInterval(ageTimer);
        statusBar.dispose();
      },
      { once: true },
    );
  }

  // The calibration ledger (P8.5). It lives on this device rather than in the
  // project, because a measurement belongs to the machine it was taken on and
  // has to outlive every project sliced for it.
  const calibrationHistoryHost = document.getElementById('calibration-history-host');
  if (calibrationHistoryHost) {
    // Behind a closed <details>, and it carries the whole pinned calibration
    // catalog with it, so none of this belongs in first paint.
    void (async () => {
      const [{ CalibrationHistoryStore }, history, { CALIBRATION_JOB_DEFINITIONS, getCalibrationJobDefinition }] =
        await Promise.all([
          import('./project/calibration/historyStore'),
          import('./project/calibration/history'),
          import('./project/calibration/definitions'),
        ]);
      const { describeCalibrationApplication, planCalibrationApplication } =
        await import('./project/calibration/application');
      const {
        UNKNOWN_CONDITION,
        assessCalibrationApplicability,
        calibrationMethodFromDefinition,
        canRerunCalibration,
        compareCalibrationRecords,
        exportCalibrationHistory,
        recordCalibrationRun,
      } = history;
      const calibrationStore = new CalibrationHistoryStore(safeLocalStorage() ?? undefined);
      let calibrationIssues: readonly CalibrationHistoryIssue[] = calibrationStore.loadIssues;
      let calibrationComparison: CalibrationComparison | undefined;
      let calibrationBusy = false;
      let calibrationMessage: string | undefined;
      const calibrationListeners = new Set<() => void>();
      const notifyCalibration = () => {
        for (const listener of calibrationListeners) listener();
      };
      // Applicability is judged against the *live* profile, so a filament change
      // has to redraw the ledger. Without this the rows keep claiming a result
      // applies to a material it was never measured on.
      profileChangeListeners.add(notifyCalibration);

      // The conditions a result would be applied *to* right now. Read from the
      // live profile rather than remembered, so switching filament immediately
      // invalidates results measured on the previous one.
      const liveCalibrationConditions = (): CalibrationConditions => {
        const options = workspace.getProfileOptions();
        const nozzle = Number.parseFloat(workspace.getHeadNozzle(0));
        const physical = workspace.getVirtualFilamentLibrarySnapshot().physical;
        return {
          printerModel: options.machine || UNKNOWN_CONDITION,
          // Firmware is only knowable through a live connection; a record made
          // offline says so rather than claiming a flavor it never checked.
          firmwareFlavor: printerHandshakeFlavor() ?? UNKNOWN_CONDITION,
          firmwareVersion: printerHandshakeVersion() ?? UNKNOWN_CONDITION,
          nozzleDiameterMm: Number.isFinite(nozzle) ? nozzle : 0.4,
          filamentMaterial: physical[0]?.material ?? UNKNOWN_CONDITION,
          filamentPresetHash: fnv1a64Text(options.filamentPresetIds.join('|')),
          processPresetHash: fnv1a64Text(options.processPresetId ?? ''),
        };
      };

      // Firmware facts come from the live handshake or not at all.
      const printerHandshakeFlavor = (): string | undefined =>
        printerConnectionState?.status === 'connected' ? 'klipper' : undefined;
      const printerHandshakeVersion = (): string | undefined =>
        printerConnectionState?.status === 'connected'
          ? printerConnectionState.handshake.printer.softwareVersion || undefined
          : undefined;

      workspace.onRequestCalibrationHistory = async (operation: CalibrationHistoryOperation) => {
        calibrationBusy = true;
        notifyCalibration();
        try {
          switch (operation.kind) {
            case 'refresh': {
              calibrationIssues = [];
              calibrationMessage = `${calibrationStore.history.size} recorded run${
                calibrationStore.history.size === 1 ? '' : 's'
              }.`;
              return;
            }
            case 'record': {
              const definition = getCalibrationJobDefinition(operation.definitionId as never);
              if (!definition) {
                calibrationIssues = [];
                calibrationMessage = `Unknown calibration ${operation.definitionId}.`;
                return;
              }
              const written = recordCalibrationRun(
                calibrationMethodFromDefinition(
                  definition,
                  Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, parameter.default])),
                ),
                liveCalibrationConditions(),
                operation.entry,
              );
              calibrationIssues = written.issues;
              if (!written.record) {
                calibrationMessage = 'Nothing was recorded.';
                return;
              }
              calibrationStore.history.add(written.record);
              calibrationStore.save();
              calibrationMessage = `Recorded ${definition.label}.`;
              return;
            }
            case 'compare': {
              const left = calibrationStore.history.get(operation.leftId);
              const right = calibrationStore.history.get(operation.rightId);
              if (!left || !right) {
                calibrationMessage = 'Pick two recorded runs to compare.';
                return;
              }
              calibrationComparison = compareCalibrationRecords(left, right);
              calibrationIssues = [];
              calibrationMessage = 'Comparing two runs.';
              return;
            }
            case 'rerun': {
              const record = calibrationStore.history.get(operation.recordId);
              if (!record) {
                calibrationMessage = 'That run is no longer recorded.';
                return;
              }
              const definition = getCalibrationJobDefinition(record.method.definitionId);
              calibrationIssues = canRerunCalibration(record, definition);
              calibrationMessage =
                calibrationIssues.length === 0
                  ? `${record.method.label} can be run again with the same sweep.`
                  : 'This run cannot be repeated.';
              return;
            }
            case 'apply': {
              const record = calibrationStore.history.get(operation.recordId);
              if (!record) {
                calibrationMessage = 'That run is no longer recorded.';
                return;
              }
              const plan = planCalibrationApplication(record, liveCalibrationConditions());
              calibrationIssues = plan.issues;
              if (plan.manualTransfer.length > 0) {
                // Nothing is written, and nothing pretends to have been: these
                // values belong in the printer's own configuration.
                calibrationMessage = `${describeCalibrationApplication(plan)} ${plan.manualTransfer.join('  ')}`;
                return;
              }
              if (!plan.applicable) {
                calibrationMessage = 'This result was not saved.';
                return;
              }
              const store = presetStore;
              if (!store) {
                calibrationMessage = 'The preset library has not loaded yet.';
                return;
              }
              const kind = plan.scope === 'process' ? 'process' : plan.scope === 'filament' ? 'filament' : 'machine';
              const base = store.library.basePresetsFor(kind)[0];
              if (!base) {
                calibrationMessage = `No selectable ${kind} preset to derive from.`;
                return;
              }
              // The write goes through the preset library's own validated path,
              // so provenance, versioning, and the refusal of unknown or
              // reserved keys all still apply — and each value is coerced into
              // the shape the base already uses.
              const overrides: Record<string, PresetJsonValue> = {};
              for (const change of plan.overrides) {
                overrides[change.presetKey] = coerceOverrideValue(base.effective[change.presetKey], change.value);
              }
              const presetName = `${base.name} — ${record.method.label}`;
              const existing = store.library.customPresets(kind).find((preset) => preset.name === presetName);
              const written = existing
                ? applyPresetLibraryOperation(store.library, {
                    kind: 'update',
                    vendor: existing.vendor,
                    presetKind: existing.kind,
                    name: existing.name,
                    draft: { overrides, version: nextPresetVersion(existing.provenance.version) },
                  })
                : applyPresetLibraryOperation(store.library, {
                    kind: 'create',
                    draft: {
                      kind,
                      name: presetName,
                      inherits: base.name,
                      overrides,
                      note: `Saved from a ${record.method.label} result measured on ${record.conditions.printerModel}.`,
                    },
                  });
              calibrationIssues = [
                ...plan.issues,
                ...written.issues.map((entry) => ({
                  code: 'invalid-record' as const,
                  severity: 'error' as const,
                  path: '$.preset',
                  message: entry.message,
                })),
              ];
              if (!written.ok) {
                calibrationMessage = 'The preset library refused this result.';
                return;
              }
              store.save();
              workspace.recomposeProfileCatalog();
              calibrationMessage = `Saved to ${presetName}. ${describeCalibrationApplication(plan)}`;
              return;
            }
            case 'delete': {
              const record = calibrationStore.history.get(operation.recordId);
              const result = calibrationStore.history.delete(operation.recordId);
              calibrationIssues = result.issues;
              if (result.ok) {
                calibrationStore.save();
                calibrationComparison = undefined;
                calibrationMessage = `Deleted ${record?.method.label ?? 'the run'}.`;
              }
              return;
            }
            case 'export': {
              const exported = exportCalibrationHistory(calibrationStore.history.list(), new Date().toISOString());
              calibrationIssues = exported.issues;
              if (!exported.text) {
                calibrationMessage = 'Export refused: the ledger carried something that may not be shared.';
                return;
              }
              const blob = new Blob([exported.text], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'orcaxr-calibration-history.json';
              link.click();
              URL.revokeObjectURL(url);
              calibrationMessage = 'Exported every recorded run. The file carries no address or credential.';
              return;
            }
          }
        } finally {
          calibrationBusy = false;
          notifyCalibration();
        }
      };

      const { CalibrationHistoryPanel } = await import('./ui/dom/CalibrationHistoryPanel');
      const calibrationPanel = new CalibrationHistoryPanel(calibrationHistoryHost, {
        getRecords: () => calibrationStore.history.list(),
        getMethods: () =>
          CALIBRATION_JOB_DEFINITIONS.map((definition) => ({
            id: definition.id,
            label: definition.label,
            resultFields: definition.resultFields,
          })),
        now: () => new Date().toISOString(),
        assess: (record) => assessCalibrationApplicability(record, liveCalibrationConditions()),
        planApplication: (record) => {
          const plan = planCalibrationApplication(record, liveCalibrationConditions());
          return { applicable: plan.applicable, summary: describeCalibrationApplication(plan) };
        },
        getComparison: () => calibrationComparison,
        getIssues: () => calibrationIssues,
        getStatus: () => ({
          busy: calibrationBusy,
          ...(calibrationMessage ? { message: calibrationMessage } : {}),
        }),
        subscribe: (listener) => {
          calibrationListeners.add(listener);
          return () => calibrationListeners.delete(listener);
        },
        run: async (operation) => {
          await registry.invoke(
            CALIBRATION_HISTORY_ACTION_IDS[operation.kind],
            'dom-inspector',
            actionCtx,
            uiState.get(),
            { calibrationHistory: operation },
          );
        },
        confirmDelete: async (record) =>
          window.confirm(
            `Delete the ${record.method.label} result measured on ${record.conditions.printerModel}? ` +
              'The measurement cannot be recovered.',
          ),
      });
      calibrationPanel.mount();
      window.addEventListener('pagehide', () => calibrationPanel.dispose(), { once: true });
    })();
  }

  window.addEventListener('pagehide', disposePrinterTransport, { once: true });

  // First run: nothing configured yet, so offer the setup path directly rather
  // than leaving a new operator to find the Printer tab. Both the printer and
  // the slicer are remembered, so once either is set this never returns. The
  // click handler is attached once the inspector exists, further down.
  const emptySetupPrinter = document.getElementById('empty-setup-printer') as HTMLButtonElement;
  const refreshFirstRunPrompt = () => {
    const configured = Boolean(printerCfg.host.trim()) || Boolean(SlicerClient.getExternalSlicerUrl());
    emptySetupPrinter.hidden = configured;
  };
  refreshFirstRunPrompt();
  emptySetupPrinter.onclick = () => {
    // Goes through the real tab control the inspector renders, so this stays
    // correct if the tab set is ever reordered or relabelled.
    document.getElementById('insp-tab-printer')?.click();
    printerHost.focus();
    statusText.textContent = 'Enter your printer address; it is saved on this device.';
  };

  emptyLoadModel.onclick = () => {
    void registry
      .invoke('load_model_from_path', 'dom-primary', actionCtx, uiState.get())
      .catch((error) => console.error('[orcaxr] empty-state load action failed:', error));
  };
  /**
   * The rail collapses to icons rather than disappearing, so the modal tools
   * stay one click away at every width. Keep its label and expanded state in
   * step with the class that drives the CSS.
   */
  const syncRailToggle = () => {
    const collapsed = toolRail.classList.contains('collapsed');
    toolbarToggle.setAttribute('aria-expanded', String(!collapsed));
    toolbarToggle.title = collapsed ? 'Show tool labels' : 'Collapse the tool rail to icons';
    const glyph = toolbarToggle.querySelector('.tool-icon');
    const label = toolbarToggle.querySelector('.tool-label');
    if (glyph) glyph.textContent = collapsed ? '⤓' : '⤒';
    if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
  };
  uiState.subscribe((state) => {
    emptyState.hidden = state.modelCount > 0;
    uiContainer.classList.toggle('no-model', state.modelCount === 0);
    // A newly loaded model should expose the plate and the obvious Slice
    // action, not a floor-to-ceiling list of labelled editing commands.
    // Preserve the maker's choice after they explicitly expand the rail.
    if (state.modelCount > 0 && !hadModels) toolRail.classList.add('collapsed');
    hadModels = state.modelCount > 0;
    statusDot.classList.toggle('busy', state.isSlicing);
    statusDot.classList.toggle('ready', !state.isSlicing && state.gcodeReady);
    syncRailToggle();
  });
  toolbarToggle.onclick = () => {
    toolRail.classList.toggle('collapsed');
    syncRailToggle();
  };

  /**
   * Single intake for picked and dropped files: a 3MF asks whether to open as
   * a project or contribute geometry, meshes merge as models, and G-code opens
   * read-only in the viewer.
   */
  const intakeFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    loadingModal.style.display = 'flex';
    try {
      for (const file of files) {
        loadingModalText.textContent = `Reading ${file.name}...`;
        loadingModalBar.style.width = '40%';
        uiState.update({ status: `Reading ${file.name}...`, progress: 40 });
        try {
          const bytes = await file.arrayBuffer();
          const isProjectArchive = /\.3mf$/i.test(file.name);
          if (isProjectArchive) {
            const choice = await askThreeMfIntake(file.name);
            if (choice === 'cancel') {
              statusText.textContent = 'Load cancelled.';
              continue;
            }
            await workspace.openFile(file.name, bytes, { threeMfMode: choice });
          } else {
            await workspace.openFile(file.name, bytes);
          }
        } catch (error) {
          statusText.textContent = `Failed to load ${file.name}: ${(error as Error).message}`;
        }
      }
    } finally {
      loadingModal.style.display = 'none';
      uiState.update({ modelCount: workspace.modelCount, progress: null });
    }
  };

  // Drag and drop anywhere over the app, with a visible drop affordance.
  const dropOverlay = document.createElement('div');
  dropOverlay.dataset.fileDropOverlay = 'true';
  dropOverlay.setAttribute('role', 'status');
  dropOverlay.hidden = true;
  dropOverlay.textContent = 'Drop a 3MF, STL, OBJ, AMF, ZIP, or G-code file to load it';
  dropOverlay.style.cssText =
    'position:fixed;inset:16px;z-index:9998;display:none;align-items:center;justify-content:center;' +
    'border:2px dashed var(--oxr-color-accent,#4fc3f7);border-radius:16px;background:rgba(6,10,16,0.72);' +
    'color:#fff;font:600 16px/1.4 system-ui,sans-serif;pointer-events:none;text-align:center;padding:24px;';
  document.body.appendChild(dropOverlay);
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
    dropOverlay.style.display = 'flex';
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
      dropOverlay.style.display = 'none';
    }
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    dropOverlay.style.display = 'none';
    void intakeFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    await intakeFiles(files);
  };

  const downloadGcode = (gcode: string) => {
    const blob = new Blob([gcode], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'orcaxr.gcode';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  workspace.onDownloadGcode = downloadGcode;
  // Generic file save for the export actions (STL today, 3MF/config later).
  workspace.onDownloadFile = (name, data, mime) => {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  workspace.onRequestLoadStl = () => fileInput.click();

  // Import Zip Archive (File menu): a dedicated .zip-filtered picker routed
  // through the shared importZipArchive path.
  const zipInput = document.createElement('input');
  zipInput.type = 'file';
  zipInput.accept = '.zip';
  zipInput.style.display = 'none';
  document.body.appendChild(zipInput);
  zipInput.onchange = async () => {
    const f = zipInput.files?.[0];
    if (!f) return;
    loadingModal.style.display = 'flex';
    loadingModalText.textContent = `Reading ${f.name}...`;
    loadingModalBar.style.width = '30%';
    try {
      const n = await workspace.importZipArchive(await f.arrayBuffer(), f.name);
      uiState.update({
        modelCount: workspace.modelCount,
        status: n > 0 ? `Imported ${n} model${n === 1 ? '' : 's'} from archive` : 'No models in archive',
        progress: null,
      });
    } catch (e) {
      statusText.textContent = `Failed to import zip: ${(e as Error).message}`;
    }
    loadingModal.style.display = 'none';
    zipInput.value = '';
  };
  workspace.onRequestLoadZip = () => zipInput.click();

  // Open G-code (File menu): a read-only viewer route that never touches the
  // canonical project.
  const gcodeInput = document.createElement('input');
  gcodeInput.type = 'file';
  gcodeInput.accept = '.gcode,.gco,.g';
  gcodeInput.style.display = 'none';
  document.body.appendChild(gcodeInput);
  gcodeInput.onchange = async () => {
    const file = gcodeInput.files?.[0];
    if (!file) return;
    loadingModal.style.display = 'flex';
    loadingModalText.textContent = `Reading ${file.name}...`;
    try {
      workspace.openGcodeForPreview(await file.text(), file.name);
    } catch (error) {
      statusText.textContent = `Failed to open G-code: ${(error as Error).message}`;
    }
    loadingModal.style.display = 'none';
    gcodeInput.value = '';
  };
  workspace.onRequestOpenGcode = () => gcodeInput.click();

  workspace.onProjectImportPreview = showProjectImportPreviewDialog;

  // Open Project (File menu): every 3MF uses worker parse and explicit preview.
  const projInput = document.createElement('input');
  projInput.type = 'file';
  projInput.accept = '.3mf';
  projInput.style.display = 'none';
  document.body.appendChild(projInput);
  projInput.onchange = async () => {
    const f = projInput.files?.[0];
    if (!f) return;
    loadingModal.style.display = 'flex';
    loadingModalText.textContent = `Opening ${f.name}...`;
    loadingModalBar.style.width = '40%';
    try {
      const buf = await f.arrayBuffer();
      await workspace.openProject(buf, f.name);
      uiState.update({ modelCount: workspace.modelCount, status: 'Ready', progress: null });
    } catch (e) {
      statusText.textContent = `Failed to open project: ${(e as Error).message}`;
    }
    loadingModal.style.display = 'none';
    projInput.value = '';
  };
  workspace.onRequestLoadProject = () => projInput.click();

  // Import Config (File menu): a .json picker → workspace.importConfig.
  const cfgInput = document.createElement('input');
  cfgInput.type = 'file';
  cfgInput.accept = '.json';
  cfgInput.style.display = 'none';
  document.body.appendChild(cfgInput);
  cfgInput.onchange = async () => {
    const f = cfgInput.files?.[0];
    if (!f) return;
    try {
      workspace.importConfig(await f.text());
    } catch (e) {
      statusText.textContent = `Failed to import config: ${(e as Error).message}`;
    }
    cfgInput.value = '';
  };
  workspace.onRequestLoadConfig = () => cfgInput.click();

  // --- Modal framework (Help menu + setup wizard) --------------------------
  let modalReturnFocus: HTMLElement | null = null;
  const closeModal = () => {
    const overlay = document.getElementById('oxr-modal-overlay');
    if (!overlay) return;
    overlay.remove();
    const returnFocus = modalReturnFocus;
    modalReturnFocus = null;
    if (!returnFocus?.isConnected) return;
    returnFocus.focus();
    // Invoking a menu item closes the mega menu, which takes the section
    // header out of the layout. Hand focus to the control that opens it so a
    // keyboard user is never left with focus on <body>.
    if (document.activeElement !== returnFocus) {
      document.getElementById('menu-button')?.focus();
    }
  };
  const buildModal = (title: string, body: HTMLElement | string): void => {
    closeModal();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalReturnFocus = active?.closest('.menu-host')?.querySelector<HTMLElement>('.menu-trigger') ?? active;
    const overlay = document.createElement('div');
    overlay.id = 'oxr-modal-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);z-index:10001;display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'oxr-modal-title');
    card.setAttribute('aria-describedby', 'oxr-modal-body');
    card.tabIndex = -1;
    card.style.cssText =
      'background:var(--oxr-color-bg-card);color:var(--oxr-color-text);padding:22px 26px;border-radius:var(--oxr-radius-lg);border:1px solid var(--oxr-color-stroke-strong);box-shadow:0 24px 80px rgba(0,0,0,0.8);width:min(470px,88vw);max-height:82vh;overflow:auto;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:16px;';
    const h = document.createElement('h3');
    h.id = 'oxr-modal-title';
    h.textContent = title;
    h.style.cssText = 'margin:0;font-size:19px;font-weight:600;';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Close');
    x.style.cssText =
      'background:none;border:none;color:var(--oxr-color-text-muted);font-size:18px;cursor:pointer;padding:2px 8px;line-height:1;';
    x.onclick = closeModal;
    head.append(h, x);
    const bodyEl = document.createElement('div');
    bodyEl.id = 'oxr-modal-body';
    bodyEl.style.cssText = 'font-size:14px;line-height:1.55;';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.appendChild(body);
    card.append(head, bodyEl);
    overlay.appendChild(card);
    overlay.onclick = (e) => {
      if (e.target === overlay) closeModal();
    };
    overlay.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [
        ...card.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]'),
      ].filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && !element.hidden);
      if (focusable.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.body.appendChild(overlay);
    (card.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]') ?? card).focus();
  };
  const shortcutCatalog = buildShortcutCatalog(registry.all());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Let the command palette own Escape while it is open; otherwise close a
      // help/setup modal first, then clear the active model selection.
      if (document.getElementById('command-palette')?.classList.contains('open')) return;
      if (document.getElementById('oxr-modal-overlay')) {
        e.preventDefault();
        closeModal();
        return;
      }
    }
    if (isShortcutEditingTarget(e.target)) return;
    const shortcut = matchShortcut(shortcutCatalog, e);
    if (!shortcut || registry.availability(shortcut.actionId, 'keyboard', uiState.get()).state !== 'enabled') return;
    e.preventDefault();
    void registry.invoke(shortcut.actionId, 'keyboard', actionCtx, uiState.get());
  });
  workspace.onShowModal = ({ title, bodyHtml }) => buildModal(title, bodyHtml);

  // Searchable help: topics, per-error troubleshooting, and the action catalog
  // in one index, because someone typing "wipe tower" does not know whether
  // their answer is a concept, an error, or a button.
  workspace.onShowHelpSearch = () => {
    const body = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = 'help-search-input';
    label.textContent = 'Search help';
    label.style.cssText = 'display:block;margin-bottom:4px;color:var(--oxr-color-text-muted);';
    const input = document.createElement('input');
    input.id = 'help-search-input';
    input.type = 'search';
    input.className = 'text-input';
    input.placeholder = 'wipe tower, cors, painting, token…';
    input.dataset.helpSearch = 'true';
    input.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:10px;';

    const results = document.createElement('div');
    results.dataset.helpResults = 'true';
    // A live region, so a screen reader hears the count change as they type.
    results.setAttribute('role', 'region');
    results.setAttribute('aria-live', 'polite');
    results.setAttribute('aria-label', 'Help results');

    const render = () => {
      const query = input.value.trim();
      const hits = query.length >= 2 ? searchHelp(query, registry.all()) : [];
      results.replaceChildren();

      const summary = document.createElement('p');
      summary.style.cssText = 'margin:0 0 8px;color:var(--oxr-color-text-muted);';
      summary.textContent =
        query.length < 2
          ? `Type to search ${HELP_TOPICS.length} topics, ${TROUBLESHOOTING.length} error explanations, and every action.`
          : `${hits.length} result${hits.length === 1 ? '' : 's'} for “${query}”.`;
      results.appendChild(summary);

      for (const hit of hits.slice(0, 40)) {
        const entry = document.createElement('section');
        entry.dataset.helpHit = hit.kind;
        entry.style.cssText = 'margin-bottom:10px;';
        const heading = document.createElement('h4');
        heading.style.cssText = 'margin:0 0 2px;font-size:13px;';
        heading.textContent = hit.title;
        const kind = document.createElement('span');
        kind.style.cssText = 'margin-left:6px;font-size:11px;opacity:.7;font-weight:400;';
        kind.textContent = hit.kind === 'troubleshooting' ? 'error' : hit.kind;
        heading.appendChild(kind);
        const text = document.createElement('p');
        text.style.cssText = 'margin:0;opacity:.9;';
        text.textContent = hit.body;
        entry.append(heading, text);
        results.appendChild(entry);
      }
    };

    input.addEventListener('input', render);
    render();
    body.append(label, input, results);
    buildModal('Help', body);
    input.focus();
  };

  // Interactive setup wizard: reuse the live profile catalogue.
  workspace.onShowSetupWizard = () => {
    const opts = workspace.getProfileOptions();
    const body = document.createElement('div');
    const intro = document.createElement('p');
    intro.textContent = 'Pick your printer, print process and filament to get started.';
    intro.style.cssText = 'margin:0 0 6px;color:var(--oxr-color-text-muted);';
    body.appendChild(intro);
    const fill = (
      sel: HTMLSelectElement,
      values: readonly WorkspacePresetOption[],
      current: WorkspacePresetOption['id'] | undefined,
    ) => {
      sel.innerHTML = '';
      for (const v of values) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.label;
        if (v.id === current) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = values.length === 0;
    };
    const mk = (label: string): HTMLSelectElement => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:block;margin:10px 0;font-size:13px;color:var(--oxr-color-text-muted);';
      wrap.textContent = label;
      const sel = document.createElement('select');
      sel.style.cssText =
        'display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:var(--oxr-color-bg);color:var(--oxr-color-text);border:1px solid var(--oxr-color-stroke-strong);font-size:14px;';
      wrap.appendChild(sel);
      body.appendChild(wrap);
      return sel;
    };
    const mSel = mk('Printer');
    fill(mSel, opts.machineOptions, opts.machinePresetId);
    const pSel = mk('Process');
    fill(pSel, opts.processOptions, opts.processPresetId);
    const fSel = mk('Filament');
    fill(fSel, opts.filamentOptions, opts.filamentPresetIds[0]);
    const updateWizardFilaments = () => {
      const machine = opts.machineOptions.find((choice) => choice.id === mSel.value);
      const process = workspace
        .choicesForMachine(machine?.name ?? '')
        .processOptions.find((choice) => choice.id === pSel.value);
      const choices = workspace.choicesForMachine(machine?.name ?? '', process?.name ?? '');
      const current = choices.filamentOptions.some((choice) => choice.id === fSel.value)
        ? (fSel.value as WorkspacePresetOption['id'])
        : choices.filamentOptions[0]?.id;
      fill(fSel, choices.filamentOptions, current);
    };
    mSel.onchange = () => {
      const machine = opts.machineOptions.find((choice) => choice.id === mSel.value);
      const choices = workspace.choicesForMachine(machine?.name ?? '', opts.process);
      const current = choices.processOptions.some((choice) => choice.id === opts.processPresetId)
        ? opts.processPresetId
        : choices.processOptions[0]?.id;
      fill(pSel, choices.processOptions, current);
      updateWizardFilaments();
    };
    pSel.onchange = updateWizardFilaments;
    const wizardStatus = document.createElement('p');
    renderProfileSelectionStatus(wizardStatus, { unavailableReasons: opts.unavailableReasons });
    body.appendChild(wizardStatus);
    const apply = document.createElement('button');
    apply.textContent = 'Apply & Close';
    apply.setAttribute('data-testid', 'wizard-apply');
    apply.style.cssText =
      'margin-top:14px;width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(90deg,#ffb74d,#ff9800);color:#1a1a1a;font-weight:600;font-size:14px;cursor:pointer;';
    apply.onclick = () => {
      const feedback = workspace.selectProfilePresets({
        machinePresetId: mSel.value as WorkspacePresetOption['id'],
        processPresetId: pSel.value as WorkspacePresetOption['id'],
        filamentPresetIds: [fSel.value as WorkspacePresetOption['id']],
      });
      renderProfileSelectionStatus(wizardStatus, { feedback });
      if (feedback.applied) closeModal();
    };
    body.appendChild(apply);
    buildModal('Setup Wizard', body);
  };

  // Canonical active-plate preflight. Only actions already implemented by the
  // shared registry are projected into this surface.
  const bannerWrap = document.getElementById('preflight-banners') as HTMLDivElement;
  const preflightPanel = new SlicePreflightPanel(bannerWrap, {
    runAction: async ({ action }) => {
      if (action.id === 'reveal') {
        const invoked = await registry.invoke('objects_reveal', 'dom-inspector', actionCtx, uiState.get(), {
          objectsReveal: action.entity,
        });
        if (!invoked) throw new Error('Reveal is unavailable for this preflight entity.');
        return;
      }
      const selected = await registry.invoke('objects_select', 'dom-inspector', actionCtx, uiState.get(), {
        objectsSelection: { refs: [action.entity], primary: action.entity },
      });
      if (!selected) throw new Error('The affected model could not be selected.');
      const dropped = await registry.invoke('drop_to_bed', 'dom-toolbar', actionCtx, uiState.get());
      if (!dropped) throw new Error('Drop to bed is unavailable for the affected model.');
    },
    onError: (error) => {
      statusText.textContent = `Preflight action: ${error instanceof Error ? error.message : String(error)}`;
    },
  });
  workspace.onPreflight = (result) => {
    preflightPanel.render(result);
    uiState.update({ preflightBlocked: !result.canSlice });
  };
  workspace.recomputePreflight();
  window.addEventListener('pagehide', () => preflightPanel.dispose(), { once: true });

  // Wipe-tower auto-position toggle (Section 1).
  const chkWipeTower = document.getElementById('chk-wipe-tower-auto') as HTMLInputElement;
  const wipeTowerAvailability = registry.availability('auto_place_wipe', 'dom-menu', uiState.get());
  chkWipeTower.checked = workspace.wipeTowerAuto;
  chkWipeTower.disabled = wipeTowerAvailability.state !== 'enabled';
  chkWipeTower.title =
    wipeTowerAvailability.state === 'enabled' ? 'Automatically position the wipe tower' : wipeTowerAvailability.reason;
  if (wipeTowerAvailability.state !== 'enabled') {
    const reason = document.createElement('span');
    reason.id = 'wipe-tower-auto-unavailable';
    reason.className = 'soon-badge';
    reason.textContent = 'UNAVAILABLE';
    reason.title = wipeTowerAvailability.reason;
    chkWipeTower.setAttribute('aria-describedby', reason.id);
    chkWipeTower.closest('label')?.appendChild(reason);
  }
  chkWipeTower.onchange = () => {
    void registry
      .invoke('auto_place_wipe', 'dom-menu', actionCtx, uiState.get())
      .finally(() => {
        chkWipeTower.checked = workspace.wipeTowerAuto;
      })
      .catch((error) => console.error('[orcaxr] wipe-tower action failed:', error));
  };

  // Profile pickers: mirror the XR panel's machine/process/filament cyclers.
  const selMachine = document.getElementById('sel-machine') as HTMLSelectElement;
  const selProcess = document.getElementById('sel-process') as HTMLSelectElement;
  const selFilament = document.getElementById('sel-filament') as HTMLSelectElement;
  const profileStatus = document.createElement('p');
  profileStatus.id = 'profile-selection-status';
  profileStatus.dataset.testid = 'profile-selection-status';
  selFilament.insertAdjacentElement('afterend', profileStatus);
  for (const select of [selMachine, selProcess, selFilament]) {
    select.setAttribute('aria-describedby', profileStatus.id);
  }
  const fillSelect = (sel: HTMLSelectElement, items: readonly string[], current: string) => {
    sel.innerHTML = '';
    if (items.length === 0) {
      // Never leave a select blank — Android renders an empty select as a
      // dead, label-less box. The placeholder is replaced as soon as the
      // catalog loads (onProfileChanged → renderProfileSelects).
      const opt = document.createElement('option');
      opt.textContent = 'Loading profiles…';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it;
      opt.textContent = it;
      opt.selected = it === current;
      sel.appendChild(opt);
    }
  };
  const fillPresetSelect = (
    sel: HTMLSelectElement,
    items: readonly WorkspacePresetOption[],
    current: WorkspacePresetOption['id'] | undefined,
  ) => {
    sel.innerHTML = '';
    if (items.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No compatible presets';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    // With no selection the browser would display the first option, which
    // silently implies a printer nobody chose. An imported project owns its own
    // configuration, so say that instead of letting a catalog entry masquerade.
    if (current === undefined) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Using the project’s own settings';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.dataset.presetPlaceholder = 'true';
      sel.appendChild(placeholder);
    }
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      opt.selected = item.id === current;
      sel.appendChild(opt);
    }
  };
  const headsPanel = document.getElementById('heads-panel') as HTMLDivElement;
  const renderProfileSelects = () => {
    const o = workspace.getProfileOptions();
    fillPresetSelect(selMachine, o.machineOptions, o.machinePresetId);
    fillPresetSelect(selProcess, o.processOptions, o.processPresetId);
    fillPresetSelect(selFilament, o.filamentOptions, o.filamentPresetIds[0]);
    renderProfileSelectionStatus(profileStatus, { unavailableReasons: o.unavailableReasons });
    uiState.update({ extruderCount: workspace.extruderCount });

    headsPanel.innerHTML = '';
    const exCount = workspace.extruderCount;
    const totalCount = workspace.palette.count();

    // Hide the global filament dropdown if the printer has multiple extruders,
    // as it is redundant and confusing (each head gets its own filament picker).
    selFilament.style.display = exCount > 1 ? 'none' : 'block';

    // Offered whatever the extruder count is. Gating this on exCount > 1 made
    // it unreachable in the case that needs it most: a single-tool project
    // cannot grow to match a four-slot machine if the button that adopts those
    // slots only appears once the project already has several.
    {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'action-btn';
      syncBtn.style.cssText =
        'background: #2E7D32; color: white; border: none; padding: 8px; margin-bottom: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; width: 100%;';
      syncBtn.textContent = 'Sync Filaments From Printer';
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        syncBtn.setAttribute('aria-busy', 'true');
        try {
          await registry.invoke('printer_inspect_filaments', 'dom-inspector', actionCtx, uiState.get());
        } finally {
          syncBtn.disabled = false;
          syncBtn.removeAttribute('aria-busy');
        }
      };
      headsPanel.appendChild(syncBtn);

      for (let i = 0; i < totalCount; i++) {
        const isAuxiliaryPaletteSlot = i >= exCount;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px;';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = workspace.palette.colorAt(i);
        colorInput.style.cssText =
          'width: 24px; height: 24px; padding: 0; border: none; background: none; cursor: pointer;';
        colorInput.onchange = () => {
          workspace.palette.setColor(i, colorInput.value);
          workspace.rebuildHeadsPanel();
        };
        row.appendChild(colorInput);

        const lbl = document.createElement('span');
        lbl.textContent = isAuxiliaryPaletteSlot ? `A-${i + 1}:` : `H-${i + 1}:`;
        lbl.style.cssText = 'color:#fff;width:30px;font-size:12px;';
        row.appendChild(lbl);

        const fSel = document.createElement('select');
        fSel.className = 'action-btn';
        fSel.style.cssText = 'flex-grow:1;margin:0;padding:6px;font-size:12px;';
        fSel.setAttribute('aria-describedby', profileStatus.id);
        fillPresetSelect(fSel, o.filamentOptions, workspace.getHeadFilamentPresetId(i));
        fSel.onchange = () => {
          workspace.setHeadFilamentPreset(i, fSel.value as WorkspacePresetOption['id']);
        };
        row.appendChild(fSel);

        if (!isAuxiliaryPaletteSlot) {
          const nSel = document.createElement('select');
          nSel.className = 'action-btn';
          nSel.style.cssText = 'width:60px;margin:0;padding:6px;font-size:12px;';
          fillSelect(nSel, ['0.2', '0.4', '0.6', '0.8'], workspace.getHeadNozzle(i));
          nSel.onchange = () => {
            workspace.setHeadNozzle(i, nSel.value);
          };
          row.appendChild(nSel);
        } else {
          const delBtn = document.createElement('button');
          delBtn.className = 'action-btn';
          delBtn.style.cssText =
            'width:60px;margin:0;padding:6px;font-size:12px;background:#d32f2f;color:white;border:none;cursor:pointer;';
          delBtn.textContent = 'Del';
          delBtn.onclick = () => {
            workspace.removeAuxiliaryFilamentSlot(i);
            renderProfileSelects(); // force redraw
          };
          row.appendChild(delBtn);
        }

        headsPanel.appendChild(row);
      }

      const openVirtualLibrary = document.createElement('button');
      openVirtualLibrary.className = 'action-btn';
      openVirtualLibrary.style.cssText =
        'background:rgba(255,183,77,0.12);color:#ffcc80;padding:8px;margin-top:4px;border-radius:8px;cursor:pointer;font-size:13px;width:100%;border:1px solid rgba(255,183,77,0.35);';
      openVirtualLibrary.textContent = 'Open virtual filament library';
      openVirtualLibrary.onclick = () => {
        const section = document.getElementById('virtual-filament-library-section') as HTMLDetailsElement | null;
        section?.setAttribute('open', '');
        section?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const add = section?.querySelector<HTMLButtonElement>('[data-virtual-filament-add]');
        add?.focus();
      };
      headsPanel.appendChild(openVirtualLibrary);
    }
  };
  const persistProfileSelection = () => {
    const selected = workspace.getProfileOptions();
    if (!selected.machinePresetId || !selected.processPresetId || !selected.filamentPresetIds[0]) return;
    try {
      localStorage.setItem(
        'orcaxr.profiles',
        JSON.stringify({
          machinePresetId: selected.machinePresetId,
          processPresetId: selected.processPresetId,
          filamentPresetIds: selected.filamentPresetIds,
          machine: selected.machine,
          process: selected.process,
          filament: selected.filament,
        }),
      );
    } catch {
      /* local storage can be unavailable in private/restricted contexts */
    }
  };
  let pendingPersistedSelection:
    | {
        readonly machinePresetId?: WorkspacePresetOption['id'];
        readonly processPresetId?: WorkspacePresetOption['id'];
        readonly filamentPresetIds?: readonly WorkspacePresetOption['id'][];
        readonly machine?: string;
        readonly process?: string;
        readonly filament?: string;
      }
    | undefined;
  try {
    const raw = localStorage.getItem('orcaxr.profiles');
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    if (saved && typeof saved === 'object') {
      const filamentPresetIds = Array.isArray(saved.filamentPresetIds)
        ? saved.filamentPresetIds.filter((id): id is string => typeof id === 'string')
        : undefined;
      pendingPersistedSelection = {
        ...(typeof saved.machinePresetId === 'string'
          ? { machinePresetId: saved.machinePresetId as WorkspacePresetOption['id'] }
          : {}),
        ...(typeof saved.processPresetId === 'string'
          ? { processPresetId: saved.processPresetId as WorkspacePresetOption['id'] }
          : {}),
        ...(filamentPresetIds && filamentPresetIds.length > 0
          ? { filamentPresetIds: filamentPresetIds.map((id) => id as WorkspacePresetOption['id']) }
          : {}),
        ...(typeof saved.machine === 'string' ? { machine: saved.machine } : {}),
        ...(typeof saved.process === 'string' ? { process: saved.process } : {}),
        ...(typeof saved.filament === 'string' ? { filament: saved.filament } : {}),
      };
    }
  } catch {
    /* ignore invalid or unavailable saved profile state */
  }
  let persistedRestoreQueued = false;
  const queuePersistedProfileRestore = () => {
    if (
      persistedRestoreQueued ||
      !pendingPersistedSelection ||
      workspace.getProfileOptions().machineOptions.length === 0
    ) {
      return;
    }
    persistedRestoreQueued = true;
    queueMicrotask(() => {
      const saved = pendingPersistedSelection;
      pendingPersistedSelection = undefined;
      if (!saved) return;
      const feedback = saved.machinePresetId
        ? workspace.selectProfilePresets({
            machinePresetId: saved.machinePresetId,
            ...(saved.processPresetId ? { processPresetId: saved.processPresetId } : {}),
            ...(saved.filamentPresetIds ? { filamentPresetIds: saved.filamentPresetIds } : {}),
          })
        : workspace.setProfileByNames(saved.machine ?? '', saved.process ?? '', saved.filament ?? '');
      if (!feedback.applied) persistProfileSelection();
    });
  };
  selMachine.onchange = () => {
    workspace.selectProfilePresets({
      machinePresetId: selMachine.value as WorkspacePresetOption['id'],
    });
  };
  selProcess.onchange = () => {
    workspace.selectProfilePresets({
      processPresetId: selProcess.value as WorkspacePresetOption['id'],
    });
  };
  selFilament.onchange = () => {
    const selected = workspace.getProfileOptions();
    const filamentPresetIds = [...selected.filamentPresetIds];
    filamentPresetIds[0] = selFilament.value as WorkspacePresetOption['id'];
    workspace.selectProfilePresets({ filamentPresetIds });
  };
  workspace.onProfileChanged = () => {
    for (const listener of profileChangeListeners) listener();
    renderProfileSelects();
    if (pendingPersistedSelection) queuePersistedProfileRestore();
    else persistProfileSelection();
  };
  workspace.onProfileSelectionResult = (feedback) => {
    renderProfileSelectionStatus(profileStatus, { feedback });
    if (feedback.applied && !pendingPersistedSelection) persistProfileSelection();
  };
  renderProfileSelects();
  queuePersistedProfileRestore();

  // Which printers this browser offers, and which presets the operator wrote
  // over them (P6.4). The library is built from the corpus the catalog fetch
  // returns, so it is created inside the composer rather than ahead of it.
  const presetLibraryHost = document.getElementById('preset-library-host');
  const presetBundleFile = document.getElementById('preset-bundle-file') as HTMLInputElement | null;

  let presetIssues: readonly PresetLibraryIssue[] = [];
  let presetBusy = false;
  let presetMessage: string | undefined;
  const presetListeners = new Set<() => void>();
  const notifyPresets = () => {
    for (const listener of presetListeners) listener();
  };

  workspace.installCatalogComposer((raw) => {
    if (!presetStore) {
      presetStore = new PresetLibraryStore(raw, safeLocalStorage() ?? undefined);
      presetIssues = presetStore.loadIssues;
      if (presetIssues.length > 0) queueMicrotask(notifyPresets);
    }
    return presetStore.library.composeCatalog();
  });

  workspace.onRequestPresetLibrary = async (operation: PresetLibraryOperation) => {
    const store = presetStore;
    if (!store) {
      presetMessage = 'The profile catalog has not loaded yet.';
      notifyPresets();
      return;
    }
    presetBusy = true;
    notifyPresets();
    try {
      if (operation.kind === 'export') {
        const blob = new Blob([store.library.exportBundle()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'orcaxr-presets.json';
        link.click();
        URL.revokeObjectURL(url);
        presetIssues = [];
        presetMessage = 'Exported this setup. The bundle names the engine it was made against.';
        return;
      }
      const result = applyPresetLibraryOperation(store.library, operation);
      presetIssues = result.issues;
      if (!result.ok) {
        presetMessage = 'Nothing changed.';
        return;
      }
      // Persist first, then recompose: a change the browser refused to store
      // would otherwise be live until the next reload silently undid it.
      const stored = store.save();
      workspace.recomposeProfileCatalog();
      presetMessage = stored
        ? describePresetChange(operation)
        : `${describePresetChange(operation)} This browser refused to save it, so it lasts until you reload.`;
    } finally {
      presetBusy = false;
      notifyPresets();
    }
  };

  if (presetLibraryHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void (async () => {
      const { PresetLibraryPanel } = await import('./ui/dom/PresetLibraryPanel');
      const presetPanel = new PresetLibraryPanel(presetLibraryHost, {
        getInventory: () =>
          presetStore?.library.inventory() ?? { vendors: Object.freeze([]), models: Object.freeze([]) },
        getCustomPresets: () => presetStore?.library.customPresets() ?? [],
        getBases: (kind) => {
          const selection = workspace.getProfileOptions();
          return (
            presetStore?.library.basePresetsFor(kind, {
              ...(selection.machinePresetId ? { printerId: selection.machinePresetId } : {}),
              ...(selection.processPresetId ? { processId: selection.processPresetId } : {}),
            }) ?? []
          );
        },
        getIssues: () => presetIssues,
        getStatus: () => ({ busy: presetBusy, ...(presetMessage ? { message: presetMessage } : {}) }),
        subscribe: (listener) => {
          presetListeners.add(listener);
          return () => presetListeners.delete(listener);
        },
        run: async (operation) => {
          await registry.invoke(PRESET_LIBRARY_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
            presetLibrary: operation,
          });
        },
        chooseBundle: () =>
          new Promise<string | undefined>((resolve) => {
            if (!presetBundleFile) {
              resolve(undefined);
              return;
            }
            presetBundleFile.value = '';
            presetBundleFile.onchange = () => {
              const file = presetBundleFile.files?.[0];
              if (!file) {
                resolve(undefined);
                return;
              }
              void file.text().then(resolve, () => resolve(undefined));
            };
            presetBundleFile.click();
          }),
        confirmDelete: async (name) =>
          window.confirm(
            `Delete your preset "${name}"? Projects already using it keep the values they were sliced with.`,
          ),
      });
      presetPanel.mount();
      window.addEventListener('pagehide', () => presetPanel.dispose(), { once: true });
    })();
  }

  const autoPairCheckbox = document.getElementById('chk-full-spectrum-auto-pairs') as HTMLInputElement | null;
  const autoPairStatus = document.getElementById('full-spectrum-auto-pairs-status');
  const autoPairConfirmButton = document.getElementById(
    'btn-confirm-full-spectrum-auto-pairs',
  ) as HTMLButtonElement | null;
  if (autoPairCheckbox) {
    let savedPreference = loadFullSpectrumAutoPairPreferences();
    const renderAutoPairStatus = (message?: string) => {
      const policy = workspace.getFullSpectrumAutoPairPolicySnapshot();
      autoPairCheckbox.checked = policy.enabled;
      if (autoPairStatus) {
        autoPairStatus.textContent =
          message ??
          (!policy.enabled
            ? 'Off by default. Existing imported and authored virtual recipes are always preserved.'
            : policy.confirmationRequired
              ? `${policy.projectedPairCount} pairs for the current ${policy.physicalCount}-filament library are pending confirmation.`
              : `Enabled for the current ${policy.physicalCount}-filament library.`);
      }
      if (autoPairConfirmButton) {
        autoPairConfirmButton.style.display = policy.confirmationRequired ? '' : 'none';
        autoPairConfirmButton.textContent = policy.confirmationRequired
          ? `Review and generate ${policy.projectedPairCount} pairs`
          : '';
      }
    };
    const invokeAutoPairPreference = async (enabled: boolean, confirmedPhysicalCount?: number) => {
      const invoked = await registry.invoke('filament_virtual_mutate', 'dom-inspector', actionCtx, uiState.get(), {
        fullSpectrumAutoPairPreference: {
          enabled,
          ...(confirmedPhysicalCount === undefined ? {} : { confirmedPhysicalCount }),
        },
      });
      if (!invoked) throw new Error('The FullSpectrum preference action is unavailable.');
    };
    renderAutoPairStatus();
    autoPairCheckbox.onchange = async () => {
      const previous = savedPreference;
      const enabled = autoPairCheckbox.checked;
      try {
        const policy = workspace.getFullSpectrumAutoPairPolicySnapshot();
        const confirmedPhysicalCount =
          enabled &&
          policy.physicalCount > 4 &&
          window.confirm(
            `Generate ${policy.projectedPairCount} automatic virtual-filament pairs for ${policy.physicalCount} physical filaments?`,
          )
            ? policy.physicalCount
            : undefined;
        await invokeAutoPairPreference(enabled, confirmedPhysicalCount);
        savedPreference = { enabled };
        saveFullSpectrumAutoPairPreferences(savedPreference);
        renderAutoPairStatus();
      } catch (error) {
        autoPairCheckbox.checked = previous.enabled;
        renderAutoPairStatus(`Preference unchanged: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (autoPairConfirmButton) {
      autoPairConfirmButton.onclick = async () => {
        const policy = workspace.getFullSpectrumAutoPairPolicySnapshot();
        if (
          !policy.confirmationRequired ||
          !window.confirm(
            `Generate ${policy.projectedPairCount} automatic virtual-filament pairs for ${policy.physicalCount} physical filaments?`,
          )
        ) {
          return;
        }
        try {
          await invokeAutoPairPreference(true, policy.physicalCount);
          savedPreference = { enabled: true };
          saveFullSpectrumAutoPairPreferences(savedPreference);
          renderAutoPairStatus();
        } catch (error) {
          renderAutoPairStatus(`Pairs were not generated: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
    const unsubscribeAutoPairStatus = workspace.subscribeCanonicalState(() => renderAutoPairStatus());
    window.addEventListener('pagehide', unsubscribeAutoPairStatus, { once: true });
  }

  const virtualFilamentHost = document.getElementById('virtual-filament-library-host');
  if (virtualFilamentHost) {
    const colorMatchSearch = new ColorMatchSearchWorkerClient();
    const virtualFilamentLibrary = new VirtualFilamentLibrary(
      virtualFilamentHost,
      new CanonicalVirtualFilamentLibraryAdapter({
        getSnapshot: () => workspace.getVirtualFilamentLibrarySnapshot(),
        subscribe: (listener) => workspace.subscribeCanonicalState(() => listener()),
        searchMatch: (input) => colorMatchSearch.search(input),
        cancelMatchSearch: (reason) => {
          colorMatchSearch.cancel(reason);
        },
        mutate: async (request) => {
          const invoked = await registry.invoke('filament_virtual_mutate', 'dom-inspector', actionCtx, uiState.get(), {
            virtualFilamentMutation: request,
          });
          if (!invoked) {
            throw new Error('The canonical virtual filament action is unavailable.');
          }
        },
        onError: (error) => {
          statusText.textContent = `Virtual filaments: ${error instanceof Error ? error.message : String(error)}`;
        },
      }),
      { heading: 'Virtual filament library' },
    );
    virtualFilamentLibrary.mount();
    window.addEventListener(
      'pagehide',
      () => {
        virtualFilamentLibrary.dispose();
        colorMatchSearch.dispose();
      },
      { once: true },
    );
  }

  const objectsHost = document.getElementById('objects-panel-host');
  if (objectsHost) {
    const objectsPanel = new ObjectsPanel(objectsHost, {
      getSnapshot: () => workspace.getObjectsTreeSnapshot(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      onSelectionRequest: async (request) => {
        const selection = objectsSelectionForRequest(workspace.getObjectsTreeSnapshot(), request);
        await registry.invoke('objects_select', 'dom-inspector', actionCtx, uiState.get(), {
          objectsSelection: selection,
        });
      },
      onRenameRequest: async (request) => {
        await registry.invoke('objects_rename', 'dom-inspector', actionCtx, uiState.get(), {
          objectsRename: { entity: request.entity, name: request.nextName },
        });
      },
      onRevealRequest: async (request) => {
        await registry.invoke('objects_reveal', 'dom-inspector', actionCtx, uiState.get(), {
          objectsReveal: request.entity,
        });
      },
      onError: (error) => {
        statusText.textContent = `Objects panel: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    objectsPanel.mount();
    window.addEventListener('pagehide', () => objectsPanel.dispose(), { once: true });
  }

  // The workspace opens the toolpath preview on its own — after a slice, and
  // when a standalone G-code file is opened — not only through the toggle
  // action. The stage bar, the inspector tabs and the layer scrubber all render
  // from `mode`, so follow the workspace instead of just the toggle, or the
  // header would still read "Prepare" over a visible toolpath. Assigned before
  // the preview panel mounts so its own subscription chains onto this one.
  const syncPreviewMode = () => {
    uiState.update({
      mode: workspace.getAutomationSnapshot().workspaceMode === 'Preview' ? 'preview' : 'prepare',
    });
  };
  workspace.onPreviewStateChanged = syncPreviewMode;
  syncPreviewMode();

  const previewPanelHost = document.getElementById('gcode-preview-panel-host');
  const previewScrubberHost = document.getElementById('preview-scrubber-host');
  {
    // One adapter, two surfaces: the inspector's full preview controls and the
    // layer scrubber docked under the model. Sharing it keeps the two from
    // ever disagreeing about the projected view.
    const previewAdapter: GcodePreviewPanelAdapter = {
      getState: () => workspace.getPreviewState(),
      subscribe: (listener) => {
        const previous = workspace.onPreviewStateChanged;
        workspace.onPreviewStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          workspace.onPreviewStateChanged = previous;
        };
      },
      onUpdateView: async (patch) => {
        const invoked = await registry.invoke('preview_configure', 'dom-inspector', actionCtx, uiState.get(), {
          previewView: patch,
        });
        if (!invoked) throw new Error('The preview control action is unavailable.');
      },
      onOpenGcode: async () => {
        const invoked = await registry.invoke('view_open_gcode', 'dom-menu', actionCtx, uiState.get());
        if (!invoked) throw new Error('Opening a G-code file is unavailable.');
      },
      getAuthorableEvents: () =>
        workspace
          .getLayerEventCapabilities()
          .filter(
            (capability): capability is typeof capability & { type: 'pause' | 'custom' } =>
              capability.type === 'pause' || capability.type === 'custom',
          ),
      onAuthorEvent: async (type, topZMm) => {
        const snapshot = workspace.getLayerEventSnapshot();
        const invoked = await registry.invoke('layer_event_mutate', 'dom-inspector', actionCtx, uiState.get(), {
          layerEventMutation: {
            operation: 'add',
            type,
            topZMm,
            expectedRevision: snapshot.sourceRevision,
            sourceHash: snapshot.sourceHash,
            // A custom event authored from the viewer starts as a marker the
            // operator edits in the inspector; a body is required, so give it
            // one that is visible on the printer rather than inventing motion.
            ...(type === 'custom' ? { code: `M117 layer at ${topZMm.toFixed(2)} mm` } : {}),
          },
        });
        if (!invoked) throw new Error('Layer-event authoring is unavailable in the current workspace state.');
      },
      onError: (error) => {
        statusText.textContent = `Preview: ${error instanceof Error ? error.message : String(error)}`;
      },
    };

    if (previewPanelHost) {
      const previewPanel = new GcodePreviewPanel(previewPanelHost, previewAdapter);
      previewPanel.mount();
      window.addEventListener('pagehide', () => previewPanel.dispose(), { once: true });
    }
    if (previewScrubberHost) {
      const scrubber = new PreviewScrubber(previewScrubberHost, previewAdapter, uiState);
      scrubber.mount();
      window.addEventListener('pagehide', () => scrubber.dispose(), { once: true });
    }
  }

  const paintPanelHost = document.getElementById('paint-panel-host');
  if (paintPanelHost) {
    const paintPanel = new PaintPanel(paintPanelHost, {
      getState: () => {
        const tool = workspace.getPaintToolState();
        return {
          palette: workspace.getPaintPalette(true),
          settings: tool.settings,
          ...(tool.filamentId ? { filamentId: tool.filamentId } : {}),
          mode: tool.mode,
          active: tool.active,
          channel: tool.channel,
          channelState:
            typeof tool.channelState === 'string' || typeof tool.channelState === 'boolean' ? tool.channelState : null,
        };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onPaintStateChanged;
        workspace.onPaintStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onPaintStateChanged = previous;
        };
      },
      onConfigure: async (request) => {
        const invoked = await registry.invoke('paint_configure', 'dom-inspector', actionCtx, uiState.get(), {
          paintConfiguration: request,
        });
        if (!invoked) throw new Error('The paint configuration action is unavailable.');
      },
      onEraseAll: async () => {
        const invoked = await registry.invoke('paint_erase_all', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Erase all painting is unavailable.');
      },
      onActivate: async () => {
        const channelTool = {
          color: 'tool_paint',
          support: 'tool_support_paint',
          seam: 'tool_seam_paint',
          fuzzySkin: 'tool_fuzzy_skin',
        }[workspace.getPaintToolState().channel];
        const invoked = await registry.invoke(channelTool, 'dom-toolbar', actionCtx, uiState.get());
        if (!invoked) throw new Error('The paint tool is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Paint: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    paintPanel.mount();
    window.addEventListener('pagehide', () => paintPanel.dispose(), { once: true });
  }

  const smartPaintPanelHost = document.getElementById('smart-paint-panel-host');
  if (smartPaintPanelHost) {
    const configure = async (request: NonNullable<ActionInvocation['smartPaint']>): Promise<void> => {
      const invoked = await registry.invoke('paint_smart_configure', 'dom-inspector', actionCtx, uiState.get(), {
        smartPaint: request,
      });
      if (!invoked) throw new Error('The Smart Paint configuration action is unavailable.');
    };
    const smartPaintPanel = new SmartPaintPanel(smartPaintPanelHost, {
      getState: () => {
        const snapshot = workspace.getSmartPaintSnapshot();
        return { ...snapshot, palette: workspace.getPaintPalette(true) };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onSmartPaintStateChanged;
        workspace.onSmartPaintStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onSmartPaintStateChanged = previous;
        };
      },
      onSetConsent: (consent) => configure({ consent }),
      onSetPrompt: (prompt) => configure({ prompt }),
      onAssignRegion: (id, value) => configure({ region: { id, value } }),
      onRequest: async () => {
        const invoked = await registry.invoke('paint_smart_request', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Select a model part before asking the Smart Paint assistant.');
      },
      onApply: async () => {
        const invoked = await registry.invoke('paint_smart_apply', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Applying the Smart Paint mask is unavailable.');
      },
      onCancel: async () => {
        const invoked = await registry.invoke('paint_smart_cancel', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Discarding the Smart Paint mask is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Smart Paint: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    smartPaintPanel.mount();
    window.addEventListener('pagehide', () => smartPaintPanel.dispose(), { once: true });
  }

  const measurePanelHost = document.getElementById('measure-panel-host');
  if (measurePanelHost) {
    const measurePanel = new MeasurePanel(measurePanelHost, {
      getState: () => {
        const measure = workspace.getMeasureSnapshot();
        if (measure.picks.length < 2) return measure;
        const assembly = workspace.getAssemblySnapshot();
        return {
          ...measure,
          assembly: {
            canSetToParallel: assembly.available.canSetToParallel,
            canSetToCenterCoincidence: assembly.available.canSetToCenterCoincidence,
            canRotateAroundFaceCenter: assembly.available.canRotateAroundFaceCenter,
            hasParallelDistance: assembly.available.hasParallelDistance,
            parallelDistanceMm: assembly.available.parallelDistanceMm,
            movable: assembly.movable,
            hint: assembly.hint,
          },
        };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onMeasureStateChanged;
        workspace.onMeasureStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onMeasureStateChanged = previous;
        };
      },
      onActivate: async () => {
        const invoked = await registry.invoke('tool_measure', 'dom-toolbar', actionCtx, uiState.get());
        if (!invoked) throw new Error('Add a model before measuring it.');
      },
      onClear: async () => {
        const invoked = await registry.invoke('measure_clear', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Clearing the measurement is unavailable.');
      },
      onAlign: async (kind, parameter) => {
        const invoked = await registry.invoke('assembly_align', 'dom-inspector', actionCtx, uiState.get(), {
          assemblyAlignment: {
            kind: kind as NonNullable<ActionInvocation['assemblyAlignment']>['kind'],
            ...(parameter !== undefined ? { parameter } : {}),
          },
        });
        if (!invoked) throw new Error('Assembly alignment is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Measure: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    measurePanel.mount();
    window.addEventListener('pagehide', () => measurePanel.dispose(), { once: true });
  }

  const brimEarsPanelHost = document.getElementById('brim-ears-panel-host');
  if (brimEarsPanelHost) {
    const brimEarsPanel = new BrimEarsPanel(brimEarsPanelHost, {
      getState: () => {
        const snapshot = workspace.getBrimEarSnapshot();
        return {
          active: snapshot.active,
          ...(snapshot.objectId ? { objectId: String(snapshot.objectId) } : {}),
          radiusMm: snapshot.radiusMm,
          minRadiusMm: 0.1,
          maxRadiusMm: 20,
          ears: snapshot.ears.map((ear) => ({
            positionMm: [ear.positionMm[0], ear.positionMm[1], ear.positionMm[2]] as const,
            headFrontRadiusMm: ear.headFrontRadiusMm,
          })),
          hint: snapshot.hint,
        };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onBrimEarStateChanged;
        workspace.onBrimEarStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onBrimEarStateChanged = previous;
        };
      },
      onActivate: async () => {
        const invoked = await registry.invoke('tool_brim_ears', 'dom-toolbar', actionCtx, uiState.get());
        if (!invoked) throw new Error('Select a model part before placing brim ears.');
      },
      onSetRadius: async (radiusMm) => {
        const invoked = await registry.invoke('brim_ears_configure', 'dom-inspector', actionCtx, uiState.get(), {
          brimEarRadiusMm: radiusMm,
        });
        if (!invoked) throw new Error('Setting the brim-ear radius is unavailable.');
      },
      onRemove: async (index) => {
        const invoked = await registry.invoke('brim_ears_remove', 'dom-inspector', actionCtx, uiState.get(), {
          brimEarIndex: index,
        });
        if (!invoked) throw new Error('Removing a brim ear is unavailable.');
      },
      onAutoPlace: async () => {
        const invoked = await registry.invoke('brim_ears_auto', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Automatic brim-ear placement is unavailable.');
      },
      onClear: async () => {
        const invoked = await registry.invoke('brim_ears_clear', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Clearing brim ears is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Brim ears: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    brimEarsPanel.mount();
    window.addEventListener('pagehide', () => brimEarsPanel.dispose(), { once: true });
  }

  const embossPanelHost = document.getElementById('emboss-panel-host');
  if (embossPanelHost) {
    const embossPanel = new EmbossPanel(embossPanelHost, {
      getState: () => {
        const snapshot = workspace.getEmbossSnapshot();
        return {
          active: snapshot.active,
          ...(snapshot.objectId ? { objectId: String(snapshot.objectId) } : {}),
          ...(snapshot.volumeId ? { volumeId: String(snapshot.volumeId) } : {}),
          ...(snapshot.fontName ? { fontName: snapshot.fontName } : {}),
          text: snapshot.configuration.text,
          sizeMm: snapshot.configuration.font.lineHeightMm,
          depthMm: snapshot.configuration.projection.depthMm,
          charGapMm: snapshot.configuration.font.charGapMm,
          lineGapMm: snapshot.configuration.font.lineGapMm,
          horizontal: snapshot.configuration.font.horizontal,
          vertical: snapshot.configuration.font.vertical,
          hint: snapshot.hint,
        };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onEmbossStateChanged;
        workspace.onEmbossStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onEmbossStateChanged = previous;
        };
      },
      onActivate: async () => {
        const invoked = await registry.invoke('add_emboss', 'dom-toolbar', actionCtx, uiState.get());
        if (!invoked) throw new Error('Load a model before embossing text onto it.');
      },
      onLoadFont: async (name, bytes) => {
        const invoked = await registry.invoke('emboss_load_font', 'dom-inspector', actionCtx, uiState.get(), {
          emboss: { font: { name, bytes } },
        });
        if (!invoked) throw new Error('Loading an emboss font is unavailable.');
      },
      onConfigure: async (patch) => {
        // The panel speaks in plain millimetres; the recipe keeps the pinned
        // field names, so the mapping happens here rather than in the panel.
        const recipe = {
          ...(patch.text === undefined ? {} : { text: patch.text }),
          font: {
            ...(patch.sizeMm === undefined ? {} : { lineHeightMm: patch.sizeMm }),
            ...(patch.charGapMm === undefined ? {} : { charGapMm: patch.charGapMm }),
            ...(patch.lineGapMm === undefined ? {} : { lineGapMm: patch.lineGapMm }),
            ...(patch.horizontal === undefined ? {} : { horizontal: patch.horizontal }),
            ...(patch.vertical === undefined ? {} : { vertical: patch.vertical }),
          },
          ...(patch.depthMm === undefined ? {} : { projection: { depthMm: patch.depthMm } }),
        };
        const invoked = await registry.invoke('emboss_configure', 'dom-inspector', actionCtx, uiState.get(), {
          emboss: { recipe },
        });
        if (!invoked) throw new Error('Changing the emboss recipe is unavailable.');
      },
      onApply: async () => {
        const invoked = await registry.invoke('emboss_apply', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Adding embossed text is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Emboss: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    embossPanel.mount();
    window.addEventListener('pagehide', () => embossPanel.dispose(), { once: true });
  }

  const svgPanelHost = document.getElementById('svg-panel-host');
  if (svgPanelHost) {
    const svgPanel = new SvgPanel(svgPanelHost, {
      getState: () => {
        const snapshot = workspace.getSvgPartSnapshot();
        return {
          active: snapshot.active,
          ...(snapshot.objectId ? { objectId: String(snapshot.objectId) } : {}),
          ...(snapshot.volumeId ? { volumeId: String(snapshot.volumeId) } : {}),
          ...(snapshot.fileName ? { fileName: snapshot.fileName } : {}),
          depthMm: snapshot.depthMm,
          ...(snapshot.widthMm !== undefined ? { widthMm: snapshot.widthMm } : {}),
          unsupported: snapshot.unsupported,
          hint: snapshot.hint,
        };
      },
      subscribe: (listener) => {
        const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
        const previous = workspace.onSvgStateChanged;
        workspace.onSvgStateChanged = () => {
          previous?.();
          listener();
        };
        return () => {
          unsubscribeCanonical();
          workspace.onSvgStateChanged = previous;
        };
      },
      onActivate: async () => {
        const invoked = await registry.invoke('tool_svg', 'dom-toolbar', actionCtx, uiState.get());
        if (!invoked) throw new Error('Load a model before cutting an SVG part.');
      },
      onLoadDrawing: async (name, source) => {
        const invoked = await registry.invoke('svg_load_drawing', 'dom-inspector', actionCtx, uiState.get(), {
          svg: { drawing: { name, source } },
        });
        if (!invoked) throw new Error('Loading an SVG drawing is unavailable.');
      },
      onConfigure: async (patch) => {
        const invoked = await registry.invoke('svg_configure', 'dom-inspector', actionCtx, uiState.get(), {
          svg: { size: patch },
        });
        if (!invoked) throw new Error('Changing the SVG part size is unavailable.');
      },
      onApply: async () => {
        const invoked = await registry.invoke('svg_apply', 'dom-inspector', actionCtx, uiState.get());
        if (!invoked) throw new Error('Adding an SVG part is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `SVG part: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    svgPanel.mount();
    window.addEventListener('pagehide', () => svgPanel.dispose(), { once: true });
  }

  const semanticObjectEditorHost = document.getElementById('semantic-object-editor-host');
  if (semanticObjectEditorHost) {
    const semanticEditor = new SemanticObjectEditor(semanticObjectEditorHost, {
      getSnapshot: () => workspace.getSemanticObjectEditorSnapshot(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      createLayerRangeId: () => workspace.createLayerRangeId(),
      onConvertVolumeRole: async (request) => {
        const invoked = await registry.invoke(
          'objects_convert_volume_role',
          'dom-inspector',
          actionCtx,
          uiState.get(),
          { semanticVolumeRole: request },
        );
        if (!invoked) throw new Error('The semantic volume-role action is unavailable.');
      },
      onAddLayerRange: async (request) => {
        const invoked = await registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, uiState.get(), {
          semanticLayerRange: { ...request, operation: 'add' },
        });
        if (!invoked) throw new Error('The semantic height-range action is unavailable.');
      },
      onEditLayerRange: async (request) => {
        const invoked = await registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, uiState.get(), {
          semanticLayerRange: { ...request, operation: 'edit' },
        });
        if (!invoked) throw new Error('The semantic height-range action is unavailable.');
      },
      onSplitLayerRange: async (request) => {
        const invoked = await registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, uiState.get(), {
          semanticLayerRange: { ...request, operation: 'split' },
        });
        if (!invoked) throw new Error('The semantic height-range action is unavailable.');
      },
      onMergeLayerRanges: async (request) => {
        const invoked = await registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, uiState.get(), {
          semanticLayerRange: { ...request, operation: 'merge' },
        });
        if (!invoked) throw new Error('The semantic height-range action is unavailable.');
      },
      onDeleteLayerRange: async (request) => {
        const invoked = await registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, uiState.get(), {
          semanticLayerRange: { ...request, operation: 'delete' },
        });
        if (!invoked) throw new Error('The semantic height-range action is unavailable.');
      },
      onError: (error) => {
        statusText.textContent = `Semantic object editor: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    semanticEditor.mount();
    window.addEventListener('pagehide', () => semanticEditor.dispose(), { once: true });
  }

  const filamentAssignmentHost = document.getElementById('filament-assignment-host');
  if (filamentAssignmentHost) {
    const selector = new FilamentAssignmentSelector(filamentAssignmentHost, {
      getSnapshot: () => workspace.getFilamentAssignmentSnapshot(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      onApply: async (request) => {
        await registry.invoke('objects_assign_filament', 'dom-inspector', actionCtx, uiState.get(), {
          objectsFilamentAssignment: request,
        });
      },
      onError: (error) => {
        statusText.textContent = `Filament assignment: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    selector.mount();
    window.addEventListener('pagehide', () => selector.dispose(), { once: true });
  }

  const layerEventHost = document.getElementById('layer-event-host');
  if (layerEventHost) {
    const layerEvents = new LayerEventPanel(layerEventHost, {
      getSnapshot: () => workspace.getLayerEventSnapshot(),
      getCapabilities: () => workspace.getLayerEventCapabilities(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      onMutate: async (request) => {
        const invoked = await registry.invoke('layer_event_mutate', 'dom-inspector', actionCtx, uiState.get(), {
          layerEventMutation: request,
        });
        if (!invoked) throw new Error('Layer-event authoring is unavailable in the current workspace state.');
      },
      onError: (error) => {
        statusText.textContent = `Layer event: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    layerEvents.mount();
    window.addEventListener('pagehide', () => layerEvents.dispose(), { once: true });
  }

  const plateManagerHost = document.getElementById('plate-manager-host');
  if (plateManagerHost) {
    const plateManager = new PlateManager(plateManagerHost, {
      getSnapshot: () => {
        const summary = workspace.getCanonicalSummary();
        return {
          sourceRevision: summary.revision,
          activePlateId: summary.activePlateId,
          plates: summary.plates.map((plate) => ({
            id: plate.id,
            name: plate.name,
            printable: plate.printable,
          })),
        };
      },
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      onActivate: async (request) => {
        await registry.invoke('activate_plate', 'dom-inspector', actionCtx, uiState.get(), {
          plateTarget: request,
        });
      },
      onRename: async (request) => {
        await registry.invoke('rename_plate', 'dom-inspector', actionCtx, uiState.get(), {
          plateRename: request,
        });
      },
      onDuplicate: async (request) => {
        await registry.invoke('duplicate_plate', 'dom-menu', actionCtx, uiState.get(), {
          plateTarget: request,
        });
      },
      onDelete: async (request) => {
        await registry.invoke('delete_plate', 'dom-menu', actionCtx, uiState.get(), {
          plateTarget: request,
        });
      },
      onReorder: async (request) => {
        await registry.invoke('reorder_plates', 'dom-inspector', actionCtx, uiState.get(), {
          plateReorder: request,
        });
      },
      onPrintableChange: async (request) => {
        await registry.invoke('set_plate_printable', 'dom-inspector', actionCtx, uiState.get(), {
          platePrintable: request,
        });
      },
      onError: (error) => {
        statusText.textContent = `Plate manager: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    plateManager.mount();
    window.addEventListener('pagehide', () => plateManager.dispose(), { once: true });
  }

  // One generated schema and one guarded canonical override seam serve every
  // field. Raw unknown/unavailable keys remain untouched by typed editor commits.
  const settingsHost = document.getElementById('settings-inspector-host');
  if (settingsHost) {
    const catalogPromise = loadEngineOptionCatalog();
    let displayedRaw: ProjectSettingsOverrideSnapshot | undefined;
    const projectPanelSnapshot = (catalog: EngineOptionCatalog, raw: ProjectSettingsOverrideSnapshot) => ({
      revision: raw.sourceRevision,
      sourceHash: raw.sourceHash,
      inherited: decodeSettingsConfig(catalog, raw.inheritedConfig as unknown as Readonly<ConfigMap>).values,
      overrides: decodeSettingsConfig(catalog, raw.overrides as unknown as Readonly<ConfigMap>).values,
    });
    const projectAdapter: GeneratedSettingsPanelAdapter = {
      load: async () => {
        const catalog = await catalogPromise;
        displayedRaw = workspace.getProjectSettingsOverrideSnapshot();
        return projectPanelSnapshot(catalog, displayedRaw);
      },
      subscribe: (listener) =>
        workspace.subscribeCanonicalState(() => {
          const current = workspace.getProjectSettingsOverrideSnapshot();
          if (
            !displayedRaw ||
            current.sourceRevision !== displayedRaw.sourceRevision ||
            current.sourceHash !== displayedRaw.sourceHash
          ) {
            listener();
          }
        }),
      apply: async (request) => {
        const raw = displayedRaw;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
        const overrides = applySettingsCommitToConfig(raw.overrides as unknown as Readonly<ConfigMap>, request.commit);
        const invoked = await registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, uiState.get(), {
          projectSettingsApply: {
            inheritedConfig: raw.inheritedConfig as unknown as Readonly<ConfigMap>,
            overrides,
            sourceRevision: raw.sourceRevision,
            sourceHash: raw.sourceHash,
          },
        });
        if (!invoked) throw new Error('The project settings action is unavailable in the current workspace state.');
        displayedRaw = workspace.getProjectSettingsOverrideSnapshot();
        return projectPanelSnapshot(await catalogPromise, displayedRaw);
      },
      cancel: (request) => {
        const raw = displayedRaw;
        if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
          throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
        }
      },
      onError: (error) => {
        statusText.textContent = `Project settings: ${error instanceof Error ? error.message : String(error)}`;
      },
    };

    // A plate, object, part, or height range stores overrides alone, so its
    // adapter reads the resolved chain as "inherited" and writes only the map
    // for that node. One panel, one commit path; the scope decides what may be
    // stored and who wins (P6.5).
    const nodeAdapter = (option: ScopedOverrideTargetOption): GeneratedSettingsPanelAdapter => {
      let displayed: ScopedOverrideSnapshot | undefined;
      const project = async (raw: ScopedOverrideSnapshot) => {
        const catalog = await catalogPromise;
        return {
          revision: raw.sourceRevision,
          sourceHash: raw.sourceHash,
          inherited: decodeSettingsConfig(catalog, raw.inheritedConfig).values,
          overrides: decodeSettingsConfig(catalog, raw.overrides).values,
        };
      };
      return {
        load: async () => {
          displayed = workspace.getScopedOverrideSnapshot(option.target);
          return project(displayed);
        },
        subscribe: (listener) =>
          workspace.subscribeCanonicalState(() => {
            const current = workspace.getScopedOverrideSnapshot(option.target);
            if (
              !displayed ||
              current.sourceRevision !== displayed.sourceRevision ||
              current.sourceHash !== displayed.sourceHash
            ) {
              listener();
            }
          }),
        apply: async (request) => {
          const raw = displayed;
          if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
            throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
          }
          const overrides = applySettingsCommitToConfig(raw.overrides, request.commit);
          const invoked = await registry.invoke('settings_apply_scoped', 'dom-inspector', actionCtx, uiState.get(), {
            scopedSettingsApply: {
              target: option.target,
              overrides,
              sourceRevision: raw.sourceRevision,
              sourceHash: raw.sourceHash,
            },
          });
          if (!invoked) throw new Error('The scoped settings action is unavailable in the current workspace state.');
          displayed = workspace.getScopedOverrideSnapshot(option.target);
          return project(displayed);
        },
        cancel: (request) => {
          const raw = displayed;
          if (!raw || raw.sourceRevision !== request.expectedRevision || raw.sourceHash !== request.sourceHash) {
            throw new Error('The settings draft no longer matches the displayed canonical project snapshot.');
          }
        },
        onError: (error) => {
          statusText.textContent = `${option.path} settings: ${error instanceof Error ? error.message : String(error)}`;
        },
      };
    };

    const settingsPanel = new ScopedSettingsPanel(
      settingsHost,
      {
        listTargets: () => workspace.listScopedOverrideTargets(),
        subscribe: (listener) => workspace.subscribeCanonicalState(listener),
        adapterFor: (option) => (option.scope === 'project' ? projectAdapter : nodeAdapter(option)),
        onError: (error) => {
          statusText.textContent = `Settings: ${error instanceof Error ? error.message : String(error)}`;
        },
      },
      { panel: { loadCatalog: () => catalogPromise } },
    );
    void settingsPanel.mount();
    window.addEventListener('pagehide', () => settingsPanel.dispose(), { once: true });
  }

  // Filament palette: color swatches that drive paint + 3MF display + slice.
  const swatchWrap = document.getElementById('filament-swatches') as HTMLDivElement;
  const btnAddFilament = document.getElementById('btn-add-filament') as HTMLButtonElement;
  btnAddFilament.title = 'Add an auxiliary palette color (not a virtual recipe)';
  btnAddFilament.setAttribute('aria-label', btnAddFilament.title);
  const renderPalette = () => {
    swatchWrap.innerHTML = '';
    workspace.palette.list().forEach((slot, i) => {
      const cell = document.createElement('div');
      cell.style.cssText = 'position:relative;';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = slot.color.length === 7 ? slot.color : '#cccccc';
      input.title = `Filament ${i + 1} (${slot.type})`;
      input.style.cssText =
        'width:36px;height:36px;border:2px solid #ffffff33;border-radius:6px;padding:0;background:none;cursor:pointer;';
      input.oninput = () => workspace.palette.setColor(i, input.value);
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Remove filament';
      del.style.cssText =
        'position:absolute;top:-6px;right:-6px;width:16px;height:16px;line-height:14px;border-radius:50%;border:none;background:#333;color:#fff;font-size:11px;cursor:pointer;';
      del.onclick = () => workspace.removeAuxiliaryFilamentSlot(i);
      cell.appendChild(input);
      if (i >= workspace.extruderCount) cell.appendChild(del);
      swatchWrap.appendChild(cell);
    });

    // Legacy preview fallback. Canonical rows render in the editable library;
    // this chip strip remains only for an older load path that has not adopted
    // a canonical FullSpectrum definition.
    const vPanel = document.getElementById('virtual-filament-panel') as HTMLDivElement;
    const vTitle = document.getElementById('virtual-filament-title') as HTMLDivElement;
    const vWrap = document.getElementById('virtual-filament-swatches') as HTMLDivElement;
    const canonicalVirtualCount = workspace.getVirtualFilamentLibrarySnapshot().mixed.length;
    const virtuals = canonicalVirtualCount === 0 ? workspace.virtualFilaments : [];
    vPanel.style.display = virtuals.length ? 'block' : 'none';
    vTitle.textContent = `MIXED FILAMENTS (${virtuals.length})`;
    vWrap.innerHTML = '';
    for (const vf of virtuals) {
      const chip = document.createElement('div');
      chip.title = `F${vf.id} · ${vf.label}`;
      chip.style.cssText =
        `width:24px;height:24px;border-radius:5px;border:1px solid #ffffff2e;` +
        `background:${vf.color};position:relative;`;
      const idTag = document.createElement('span');
      idTag.textContent = String(vf.id);
      idTag.style.cssText =
        'position:absolute;bottom:-4px;right:-4px;background:#111;color:#cfd8dc;' +
        'font-size:8px;line-height:1;padding:1px 2px;border-radius:3px;';
      chip.appendChild(idTag);
      vWrap.appendChild(chip);
    }
  };
  btnAddFilament.onclick = () => workspace.addFilamentSlot();
  // A palette change (e.g. adopted from a loaded 3MF) must also refresh the
  // heads panel — its per-head color swatches read the same palette.
  workspace.onPaletteChanged = () => {
    renderPalette();
    renderProfileSelects();
  };
  renderPalette();

  // Printer endpoint and session credential setup. Live operations are
  // read-only until the complete P9 mapping/preflight/send lifecycle exists.
  printerHost.value = printerCfg.host;
  printerHost.oninput = () => {
    printerCfg.host = printerHost.value.trim();
    savePrinterEndpointPreferences(printerCfg);
    refreshFirstRunPrompt();
    disposePrinterTransport();
  };

  // The printer key and the slicer token are remembered on this device so a
  // configured machine stays configured across reloads. The switch below turns
  // that off and erases what is stored, which is what a shared machine needs.
  const rememberCredentials = document.getElementById('remember-credentials') as HTMLInputElement;
  const btnForgetCredentials = document.getElementById('btn-forget-credentials') as HTMLButtonElement;
  let remembered = loadRememberedCredentials();
  printerApiKey.value = remembered.printerApiKey;
  rememberCredentials.checked = remembered.remember;

  const refreshDiagnosticSecrets = () => {
    diagnostics.setSecrets([printerApiKey.value.trim(), externalSlicerTokenValue()].filter(Boolean));
  };

  const persistCredentials = () => {
    remembered = {
      printerApiKey: printerApiKey.value.trim(),
      printerApiKeys: remembered.printerApiKeys,
      slicerToken: externalSlicerTokenValue(),
      remember: rememberCredentials.checked,
    };
    saveRememberedCredentials(remembered);
    refreshDiagnosticSecrets();
  };
  const externalSlicerTokenValue = () =>
    (document.getElementById('external-slicer-token') as HTMLInputElement | null)?.value.trim() ?? '';

  // ---- Named printers (P9.2) ----------------------------------------------
  // Each entry owns its address and its credential. Switching carries nothing
  // from the previous machine, because a key or a tool map that follows a
  // switch is one sent to the wrong printer.
  const printerSelect = document.getElementById('printer-select') as HTMLSelectElement;
  const btnPrinterAdd = document.getElementById('btn-printer-add') as HTMLButtonElement;
  const btnPrinterRemove = document.getElementById('btn-printer-remove') as HTMLButtonElement;
  const printerStorage = safeLocalStorage();

  let printers = loadPrinterDirectory(printerStorage);
  // An install configured before printers had names keeps working: its single
  // endpoint becomes the first entry rather than being dropped.
  printers = adoptLegacyEndpoint(printers, printerCfg.host.trim() ? printerCfg : undefined, () => crypto.randomUUID());
  if (printers.printers.length > 0) savePrinterDirectory(printers, printerStorage);

  const keyForPrinter = (id: string): string =>
    remembered.printerApiKeys[id] ?? (id === printers.defaultId ? remembered.printerApiKey : '');

  const renderPrinterSelect = () => {
    printerSelect.replaceChildren();
    for (const entry of printers.printers) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name;
      option.selected = entry.id === printers.defaultId;
      printerSelect.appendChild(option);
    }
    if (printers.printers.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No printer saved yet';
      option.disabled = true;
      option.selected = true;
      printerSelect.appendChild(option);
    }
    btnPrinterRemove.disabled = printers.printers.length === 0;
  };

  const activatePrinter = (id: string) => {
    const entry = findPrinter(printers, id);
    if (!entry) return;
    printers = setDefaultPrinter(printers, id);
    savePrinterDirectory(printers, printerStorage);
    printerCfg.host = entry.host;
    printerCfg.port = entry.port;
    savePrinterEndpointPreferences(printerCfg);
    printerHost.value = entry.host;
    printerApiKey.value = keyForPrinter(id);
    // The transport is rebuilt rather than reused, so no socket, credential, or
    // cached capability crosses from the printer that was selected before.
    disposePrinterTransport();
    refreshDiagnosticSecrets();
    renderPrinterSelect();
    refreshFirstRunPrompt();
    statusText.textContent = `Switched to ${entry.name}.`;
  };

  printerSelect.onchange = () => activatePrinter(printerSelect.value);

  btnPrinterAdd.onclick = () => {
    const host = printerHost.value.trim();
    if (!host) {
      statusText.textContent = 'Enter the printer address first, then Add names it.';
      printerHost.focus();
      return;
    }
    const name = window.prompt('Name this printer', `Printer ${printers.printers.length + 1}`);
    if (name === null) return;
    try {
      printers = addPrinter(printers, { name, host, port: printerCfg.port }, () => crypto.randomUUID());
      savePrinterDirectory(printers, printerStorage);
      activatePrinter(printers.printers[printers.printers.length - 1].id);
      statusText.textContent = `Saved ${name.trim()}. Switch between printers with the list above.`;
    } catch (error) {
      statusText.textContent = `Could not add that printer: ${(error as Error).message}`;
    }
  };

  btnPrinterRemove.onclick = () => {
    const entry = findPrinter(printers, printerSelect.value);
    if (!entry) return;
    if (!window.confirm(`Remove ${entry.name}? Its saved address and key are deleted from this device.`)) return;
    printers = removePrinter(printers, entry.id);
    // The credential goes with the printer; leaving it behind would attach it
    // to whatever id happened to be reused later.
    const { [entry.id]: _removed, ...rest } = remembered.printerApiKeys;
    remembered = { ...remembered, printerApiKeys: rest };
    saveRememberedCredentials(remembered);
    savePrinterDirectory(printers, printerStorage);
    const next = defaultPrinter(printers);
    if (next) activatePrinter(next.id);
    else {
      printerHost.value = '';
      printerApiKey.value = '';
      printerCfg.host = '';
      savePrinterEndpointPreferences(printerCfg);
      disposePrinterTransport();
      renderPrinterSelect();
      refreshFirstRunPrompt();
    }
    statusText.textContent = `Removed ${entry.name}.`;
  };

  printerApiKey.oninput = () => {
    // The key belongs to the selected printer, not to the app.
    const activeId = printers.defaultId;
    if (activeId) {
      remembered = {
        ...remembered,
        printerApiKeys: { ...remembered.printerApiKeys, [activeId]: printerApiKey.value.trim() },
      };
    }
    persistCredentials();
    disposePrinterTransport();
  };
  rememberCredentials.onchange = () => {
    persistCredentials();
    statusText.textContent = rememberCredentials.checked
      ? 'Credentials will be remembered on this device.'
      : 'Stopped remembering credentials; the saved copies were erased.';
  };
  // Diagnostics: a bounded, redacted record of this session. Secrets are
  // registered so they are struck from every entry as it is recorded, not on
  // the way out.
  const diagnostics = new DiagnosticsRecorder();
  window.addEventListener('error', (event) => diagnostics.recordError('window', event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => diagnostics.recordError('promise', event.reason));

  // Diagnostics: the operator reads exactly what would be sent, then decides.
  workspace.onRequestDiagnosticsExport = async () => {
    const bundle = buildDiagnosticsBundle(
      {
        appVersion: window.ORCAXR_VERSION ?? 'unknown',
        engine: {
          commit: PINNED_ENGINE_PROVENANCE.commit,
          route: SlicerClient.useExternalSlicer() ? 'external-server' : 'browser-wasm',
        },
        browser: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          ...(navigator.hardwareConcurrency ? { hardwareConcurrency: navigator.hardwareConcurrency } : {}),
          crossOriginIsolated: globalThis.crossOriginIsolated === true,
        },
        printer: {
          configured: Boolean(printerCfg.host.trim()),
          connected: printerConnectionState?.status === 'connected',
          ...(printJobSnapshot?.state ? { jobState: printJobSnapshot.state } : {}),
        },
        capabilities: {
          actionCount: registry.all().length,
          unavailableCount: registry.all().filter((action) => action.capability.status === 'unavailable').length,
        },
        project: workspace.diagnosticsProjectSummary(),
        log: diagnostics.snapshot(),
      },
      { includeModelNames: false },
    );

    // The preview is the bundle's own description, so what is agreed to and
    // what is written cannot drift apart.
    const agreed = window.confirm(
      `Export this diagnostics bundle?\n\n${describeDiagnosticsBundle(bundle)}\n\nNothing is sent anywhere; the file is saved to this device.`,
    );
    if (!agreed) {
      statusText.textContent = 'Diagnostics export cancelled; nothing was written.';
      return;
    }
    const blob = new Blob([serializeDiagnosticsBundle(bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orcaxr-diagnostics.json';
    link.click();
    URL.revokeObjectURL(url);
    statusText.textContent = `Exported ${bundle.log.length} log entries. No project, addresses, or tokens are in the file.`;
  };

  // Preferences: this device's setup, versioned and separate from the project.
  const prefReduceMotion = document.getElementById('pref-reduce-motion') as HTMLInputElement;
  const btnPrefsExport = document.getElementById('btn-prefs-export') as HTMLButtonElement;
  const btnPrefsImport = document.getElementById('btn-prefs-import') as HTMLButtonElement;
  const btnPrefsReset = document.getElementById('btn-prefs-reset') as HTMLButtonElement;
  const prefsImportFile = document.getElementById('prefs-import-file') as HTMLInputElement;

  let preferences = loadPreferences();
  applyPreferences(preferences, document.documentElement);
  prefReduceMotion.checked = preferences.reduceMotion === 'always';
  renderPrinterSelect();
  const startupPrinter = defaultPrinter(printers);
  if (startupPrinter) printerApiKey.value = keyForPrinter(startupPrinter.id);
  refreshDiagnosticSecrets();
  prefReduceMotion.onchange = () => {
    preferences = { ...preferences, reduceMotion: prefReduceMotion.checked ? 'always' : 'system' };
    savePreferences(preferences);
    applyPreferences(preferences, document.documentElement);
  };

  btnPrefsExport.onclick = () => {
    const blob = new Blob([JSON.stringify(exportPreferences(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orcaxr-settings.json';
    link.click();
    URL.revokeObjectURL(url);
    statusText.textContent = 'Exported this device\u2019s settings. The file carries no tokens.';
  };

  btnPrefsImport.onclick = () => prefsImportFile.click();
  prefsImportFile.onchange = async () => {
    const file = prefsImportFile.files?.[0];
    if (!file) return;
    try {
      const result = importPreferences(JSON.parse(await file.text()));
      // Reloading is the honest way to apply an imported endpoint: the printer
      // transport and slicer route both read their settings at construction.
      statusText.textContent =
        result.applied.length > 0
          ? `Imported ${result.applied.length} setting(s); reload to use them.${result.warnings.length > 0 ? ` ${result.warnings[0]}` : ''}`
          : `Nothing was imported. ${result.warnings[0] ?? ''}`;
    } catch (error) {
      statusText.textContent = `Could not read that settings file: ${(error as Error).message}`;
    } finally {
      prefsImportFile.value = '';
    }
  };

  btnPrefsReset.onclick = () => {
    resetPreferences();
    printerHost.value = '';
    printerApiKey.value = '';
    printerCfg.host = '';
    disposePrinterTransport();
    SlicerClient.setExternalSlicerToken('', { persist: false });
    preferences = loadPreferences();
    prefReduceMotion.checked = preferences.reduceMotion === 'always';
    applyPreferences(preferences, document.documentElement);
    refreshFirstRunPrompt();
    statusText.textContent = 'Reset this device\u2019s settings. Your projects and presets are untouched.';
  };

  btnForgetCredentials.onclick = () => {
    forgetRememberedCredentials();
    printerApiKey.value = '';
    const tokenField = document.getElementById('external-slicer-token') as HTMLInputElement | null;
    if (tokenField) tokenField.value = '';
    SlicerClient.setExternalSlicerToken('', { persist: false });
    remembered = loadRememberedCredentials();
    rememberCredentials.checked = remembered.remember;
    disposePrinterTransport();
    statusText.textContent = 'Forgot the saved printer key and slicer token on this device.';
  };
  const externalSlicerUrl = document.getElementById('external-slicer-url') as HTMLInputElement;
  const externalSlicerStatus = document.getElementById('external-slicer-status') as HTMLSpanElement;
  const btnExternalSlicerConnect = document.getElementById('btn-external-slicer-connect') as HTMLButtonElement;
  const externalSlicerControls = document.getElementById('external-slicer-controls') as HTMLDivElement;
  const externalSlicerEnabled = document.getElementById('external-slicer-enabled') as HTMLInputElement;
  const btnExternalSlicerDelete = document.getElementById('btn-external-slicer-delete') as HTMLButtonElement;
  const externalSlicerHint = document.getElementById('external-slicer-hint') as HTMLParagraphElement;
  externalSlicerUrl.value = SlicerClient.getExternalSlicerUrl();
  const externalSlicerToken = document.getElementById('external-slicer-token') as HTMLInputElement;
  // Session-only by design: the token is a credential, so it is held in memory
  // for this tab rather than persisted where a later script could read it back.
  externalSlicerToken.value = remembered.slicerToken;
  externalSlicerToken.addEventListener('input', () => {
    SlicerClient.setExternalSlicerToken(externalSlicerToken.value);
    persistCredentials();
  });

  const updateExternalSlicerStatus = (connected: boolean) => {
    if (connected) {
      externalSlicerStatus.innerHTML =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4caf50;"></span> Online';
      externalSlicerStatus.style.color = '#4caf50';
    } else {
      externalSlicerStatus.innerHTML =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f44336;"></span> Offline';
      externalSlicerStatus.style.color = '#f44336';
    }
  };

  // Show the enable/delete controls only once a server is saved, and keep
  // the checkbox + hint in sync with the shared SlicerClient state.
  const refreshExternalSlicerControls = () => {
    const configured = !!SlicerClient.getExternalSlicerUrl();
    externalSlicerControls.style.display = configured ? 'flex' : 'none';
    externalSlicerHint.style.display = configured ? 'block' : 'none';
    refreshFirstRunPrompt();
    const enabled = SlicerClient.isExternalSlicerEnabled();
    externalSlicerEnabled.checked = enabled;
    externalSlicerHint.textContent = enabled
      ? 'On — models will be sliced on the external server.'
      : 'Off — slicing locally in‑browser.';
  };

  const connectExternalSlicerCandidate = async (candidate: string) => {
    btnExternalSlicerConnect.disabled = true;
    btnExternalSlicerConnect.textContent = '...';
    // connectExternalSlicer disables the previous route synchronously before
    // its probe begins. Reflect that fail-closed state while the request is in
    // flight instead of leaving a stale checked control on screen.
    const connection = SlicerClient.connectExternalSlicer(candidate);
    refreshExternalSlicerControls();
    try {
      const endpoint = await connection;
      externalSlicerUrl.value = endpoint;
      updateExternalSlicerStatus(true);
      statusText.textContent = 'External slicer connected — external slicing is on.';
    } catch {
      // A failed candidate never replaces the last verified URL and the
      // previous route stays disabled. Restore what can actually be enabled.
      externalSlicerUrl.value = SlicerClient.getExternalSlicerUrl();
      updateExternalSlicerStatus(false);
      statusText.textContent = 'External slicer connection failed — slicing locally.';
    } finally {
      btnExternalSlicerConnect.disabled = false;
      btnExternalSlicerConnect.textContent = 'Connect';
      refreshExternalSlicerControls();
    }
  };

  externalSlicerEnabled.onchange = async () => {
    if (!externalSlicerEnabled.checked) {
      SlicerClient.disableExternalSlicer();
      updateExternalSlicerStatus(false);
      refreshExternalSlicerControls();
      return;
    }

    // Turning a saved endpoint back on is another explicit connection attempt:
    // probe it before routing any model geometry to it.
    const configured = SlicerClient.getExternalSlicerUrl();
    externalSlicerUrl.value = configured;
    await connectExternalSlicerCandidate(configured);
  };

  btnExternalSlicerDelete.onclick = () => {
    SlicerClient.clearExternalSlicer();
    externalSlicerUrl.value = '';
    updateExternalSlicerStatus(false);
    refreshExternalSlicerControls();
    statusText.textContent = 'External slicer removed — slicing locally.';
  };

  btnExternalSlicerConnect.onclick = async () => {
    const candidate = externalSlicerUrl.value;
    if (!candidate.trim()) {
      SlicerClient.clearExternalSlicer();
      updateExternalSlicerStatus(false);
      refreshExternalSlicerControls();
      return;
    }
    await connectExternalSlicerCandidate(candidate);
  };

  refreshExternalSlicerControls();
  if (SlicerClient.useExternalSlicer()) {
    // Re-check only a route the user explicitly left enabled. A saved-but-off
    // URL remains completely idle on page load.
    void connectExternalSlicerCandidate(externalSlicerUrl.value);
  }

  btnPrinterTest.onclick = async () => {
    btnPrinterTest.disabled = true;
    btnPrinterTest.setAttribute('aria-busy', 'true');
    try {
      await registry.invoke('printer_test_connection', 'dom-inspector', actionCtx, uiState.get());
    } finally {
      btnPrinterTest.disabled = false;
      btnPrinterTest.removeAttribute('aria-busy');
    }
  };
  const btnPrinterWebcam = document.getElementById('btn-printer-webcam') as HTMLButtonElement;
  btnPrinterWebcam.disabled = false;
  btnPrinterWebcam.textContent = 'Camera';
  btnPrinterWebcam.title = "Discover this printer's cameras and watch one";
  btnPrinterWebcam.onclick = () => {
    void registry.invoke('view_webcam', 'dom-inspector', actionCtx, uiState.get());
  };
  btnPrinterSend.onclick = () => {
    if (printSubmission) {
      printSubmission.abort();
      workspace.setStatus('Cancelling the send…');
      return;
    }
    void registry
      .invoke('send_to_printer', 'dom-inspector', actionCtx, uiState.get())
      .catch((error) => workspace.setStatus(`Send failed: ${(error as Error).message}`));
  };
  setPrinterSendBusy(false);

  // Download and send availability are both registry-driven; webcam discovery
  // stays blocked until it is routed through the shared printer connection.
  // Build-plate bar: a chip per plate + an add button. Switching hides the
  // current plate's models and shows the target's (the workspace owns the sets).
  const plateBar = document.getElementById('plate-bar') as HTMLDivElement;
  const renderPlateBar = () => {
    const plates = workspace.getPlates();
    plateBar.innerHTML = '';
    for (const p of plates) {
      const chip = document.createElement('span');
      chip.className = 'plate-chip' + (p.active ? ' active' : '');
      chip.dataset.plateId = String(p.id);
      chip.onclick = () => {
        void registry
          .invoke('activate_plate', 'dom-inspector', actionCtx, uiState.get(), { plateId: p.id })
          .catch((error) => console.error('[orcaxr] activate-plate action failed:', error));
      };
      const lbl = document.createElement('span');
      lbl.textContent = `${p.label} · ${p.count}`;
      chip.appendChild(lbl);
      if (plates.length > 1) {
        const del = document.createElement('span');
        del.className = 'plate-del';
        del.textContent = '×';
        del.title = `Delete ${p.label}`;
        del.onclick = (e) => {
          e.stopPropagation();
          void registry
            .invoke('delete_plate', 'dom-menu', actionCtx, uiState.get(), { plateId: p.id })
            .catch((error) => console.error('[orcaxr] delete-plate action failed:', error));
        };
        chip.appendChild(del);
      }
      plateBar.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'plate-add';
    add.textContent = '+';
    add.title = 'Add build plate';
    add.onclick = () => {
      void registry
        .invoke('add_plate', 'dom-menu', actionCtx, uiState.get())
        .catch((error) => console.error('[orcaxr] add-plate action failed:', error));
    };
    plateBar.appendChild(add);
    uiState.update({ plateCount: plates.length, modelCount: workspace.modelCount });
  };
  workspace.onPlatesChanged = renderPlateBar;
  renderPlateBar();

  const updateCanonicalUi = (summary: ReturnType<OrcaWorkspace['getCanonicalSummary']>) => {
    const active = summary.plates.find((plate) => plate.id === summary.activePlateId);
    uiState.update({
      modelCount: active?.instanceCount ?? 0,
      plateCount: summary.plates.length,
      hasSelection: workspace.getObjectsTreeSnapshot().selection.refs.length > 0,
      hasInstanceSelection: summary.primaryInstanceId !== undefined,
      canUndo: summary.history.undoCount > 0,
      canRedo: summary.history.redoCount > 0,
      dirty: summary.dirty,
      projectionHealthy: summary.projectionHealth.healthy,
    });
  };
  workspace.onCanonicalStateChanged = updateCanonicalUi;
  updateCanonicalUi(workspace.getCanonicalSummary());

  workspace.onDownloadReady = (ready) => {
    uiState.update({ gcodeReady: ready });
    // A stale artifact must not stay sendable; an in-flight send keeps its own
    // cancel affordance until it settles.
    if (!printSubmission) btnPrinterSend.disabled = !ready;
  };

  workspace.onSelectionChanged = () => {
    const summary = workspace.getCanonicalSummary();
    uiState.update({
      hasSelection: workspace.getObjectsTreeSnapshot().selection.refs.length > 0,
      hasInstanceSelection: summary.primaryInstanceId !== undefined,
      modelCount: workspace.modelCount,
    });
    renderPlateBar();
  };

  const domSliceModal = document.getElementById('dom-slice-modal') as HTMLDivElement;
  const domSliceText = document.getElementById('dom-slice-text') as HTMLParagraphElement;
  const domSliceBar = document.getElementById('dom-slice-bar') as HTMLDivElement;

  workspace.onSliceStateChanged = (isSlicing) => {
    if (domSliceModal) {
      domSliceModal.style.display = isSlicing ? 'flex' : 'none';
    }
    // Drive both DOM and immersive action enablement from the same source.
    // Without this, Slice could still look ready while a previous job ran.
    uiState.update({ isSlicing });
  };

  workspace.onStatusChanged = (text, percent) => {
    statusText.textContent = text;
    if (percent !== undefined && percent >= 0 && percent <= 100) {
      progressContainer.style.display = 'block';
      progressBar.style.width = `${percent}%`;
      if (domSliceBar) domSliceBar.style.width = `${percent}%`;
      domSliceProgress?.setAttribute('aria-valuenow', String(Math.round(percent)));
    } else {
      progressContainer.style.display = 'none';
    }
    if (domSliceText) domSliceText.textContent = text;
    uiState.update({
      status: text,
      progress: percent !== undefined && percent >= 0 && percent <= 100 ? percent : null,
    });
  };

  // AI & MCP Server
  const chkMcpEnabled = document.getElementById('chk-mcp-enabled') as HTMLInputElement;
  const mcpControls = document.getElementById('mcp-controls') as HTMLDivElement;
  const inMcpToken = document.getElementById('in-mcp-token') as HTMLInputElement;
  const btnMcpConnect = document.getElementById('btn-mcp-connect') as HTMLButtonElement;
  const btnMcpShare = document.getElementById('btn-mcp-share') as HTMLButtonElement;

  let mcp: OrcaWebMcpClient | null = null;

  const renderMcpStatus = (status: Readonly<WebMcpStatus>) => {
    statusText.textContent = status.message;
    const busy = status.state === 'registering' || status.state === 'connecting';
    const connected = status.state === 'connected' || mcp?.isConnected === true;
    btnMcpConnect.disabled = busy;
    inMcpToken.disabled = busy || connected;
    btnMcpConnect.textContent = connected ? 'Disconnect Server' : busy ? 'Connecting…' : 'Connect Server';
  };

  const ensureMcpClient = (): OrcaWebMcpClient => {
    if (mcp) return mcp;
    mcp = new OrcaWebMcpClient({ onStatus: renderMcpStatus });

    mcp.registerTool(
      'get_status',
      'Get current OrcaXR workspace status',
      { type: 'object', properties: {}, additionalProperties: false },
      () => ({
        content: [
          {
            type: 'text',
            text: `Workspace has ${workspace.modelCount} models loaded across ${workspace.getPlates().length} plates.`,
          },
        ],
      }),
    );
    registerWorkspaceTools(mcp, workspace, registry, actionCtx);
    registerSystemTools(mcp);
    return mcp;
  };

  chkMcpEnabled.onchange = () => {
    mcpControls.style.display = chkMcpEnabled.checked ? 'flex' : 'none';
    if (chkMcpEnabled.checked) {
      ensureMcpClient();
      statusText.textContent = 'WebMCP tools are ready. Paste a local bridge token and connect.';
    } else {
      mcp?.disconnect('WebMCP tools disabled.');
    }
  };

  btnMcpConnect.onclick = async () => {
    const client = ensureMcpClient();
    if (client.isConnected) {
      client.disconnect();
      return;
    }
    const token = inMcpToken.value.trim();
    if (!token) {
      statusText.textContent = 'Please paste a token first.';
      return;
    }
    try {
      await client.connect(token);
      // Registration tokens are one-use capabilities; do not retain them in
      // the DOM, storage, logs, or a globally reachable window property.
      inMcpToken.value = '';
    } catch (error) {
      if (!(error instanceof WebMcpConnectionError && error.code === 'cancelled')) {
        // The client status callback already rendered its redacted message.
        inMcpToken.focus();
      }
    }
  };

  btnMcpShare.onclick = async () => {
    const snippet = {
      mcpServers: {
        orcaxr_webmcp: {
          command: 'npx',
          args: ['-y', WEBMCP_CLI_PACKAGE, '--mcp'],
        },
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snippet, null, 2));
      statusText.textContent = 'Claude Desktop MCP config snippet copied to clipboard.';
    } catch {
      statusText.textContent = 'Clipboard access was denied. Copy the MCP snippet from a secure browser context.';
    }
  };

  window.addEventListener('pagehide', () => mcp?.disconnect(), { once: true });
}

document.addEventListener('DOMContentLoaded', async () => {
  // The simulator is a development aid, not a headset runtime dependency. Its
  // custom controls pull a substantial rendering stack into the initial page;
  // defer that cost in production unless someone explicitly asks for desktop
  // simulation (`?simulator=1`). It still loads before `xb.init`, so simulator
  // behaviour is unchanged for local development and opt-in QA sessions.
  const wantsSimulator = import.meta.env.DEV || new URLSearchParams(window.location.search).get('simulator') === '1';
  if (wantsSimulator) await import('xrblocks/addons/simulator/SimulatorAddons.js');

  // Design tokens as CSS custom properties — the DOM shell's single source of
  // truth for colours/spacing (the XR shell reads the same `tokens` object).
  injectTokenCss();

  const options = new xb.Options();
  options.setAppTitle('OrcaXR Slicer');
  options.enableReticles();
  options.enableHands();
  options.hands.enabled = true;
  options.hands.visualization = true;
  // Visible pointer rays: without them there's no way to aim at the
  // control panel from a distance (the reticle alone is easy to miss).
  options.controllers.enabled = true;
  options.controllers.visualizeRays = true;
  options.controllers.performRaycastOnUpdate = true;
  options.enableUI();

  options.uikit.enable(uikit);

  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry, {
    fullSpectrumAutoPairPreferences: loadFullSpectrumAutoPairPreferences(),
  });
  (window as any).workspace = workspace;

  // Foundation for the shared-registry UI (Phase 1 renders both shells from
  // these). Construct now so the store is live and debuggable from the console.
  const uiState = new UiState();
  const actionCtx = new ActionContext(workspace, uiState, registry);
  // The XR tool card (built eagerly in the workspace ctor) routes clicks through
  // this at click time, so both shells run identical action handlers.
  workspace.actionContext = actionCtx;
  (window as unknown as { __orcaUi: unknown }).__orcaUi = uiState;
  (window as unknown as { __orcaCtx: unknown }).__orcaCtx = actionCtx;

  xb.add(workspace);
  await xb.init(options);

  // Setup OrbitControls for 2D mode navigation
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const orbit = new OrbitControls(xb.core.camera, canvas);
  // Orbit around the live plate position — a hardcoded target here silently
  // diverges when the workspace constants move (the plate "disappeared" once).
  orbit.target.copy(workspace.plateFocus());
  orbit.update();
  workspace.orbitControls = orbit;
  workspace.setup2DControls(canvas);

  // Debug handles for remote scene inspection / automated testing via CDP.
  (window as unknown as { __orcaScene: unknown }).__orcaScene = xb.core.scene;
  (window as unknown as { __orcaRenderer: unknown }).__orcaRenderer = xb.core.renderer;
  (window as unknown as { THREE: unknown }).THREE = THREE;
  (window as unknown as { __orca: unknown }).__orca = workspace;
  setupDomUI(workspace, uiState, actionCtx, registry);

  // Render the tool rail, primary bar, Add/Tools menus, and mode control from
  // the shared registry (the same catalog the XR shell renders). Mounted after
  // setupDomUI so the file-input + onRequestLoadStl the Load action depends on
  // is in place.
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const domShell = new DomShell(registry, actionCtx, uiState);
  domShell.mount({
    toolbar: byId('left-toolbar'),
    primary: byId('action-panel'),
    stageBar: byId('stage-bar'),
    menuBar: byId('menu-bar-host'),
    menuButton: byId('menu-button') as HTMLButtonElement,
    calibration: byId('calibration-grid'),
  });

  // Six named inspector tabs replace the old single scroll of disclosures.
  // Every panel still exists; the tabs decide which one is on screen.
  const inspectorTabs = new InspectorTabs(
    {
      tabs: byId('inspector-tabs'),
      title: byId('inspector-title'),
      meta: byId('inspector-meta'),
      panels: byId('inspector-scroll'),
    },
    uiState,
  );
  inspectorTabs.mount();
  window.addEventListener('pagehide', () => inspectorTabs.dispose(), { once: true });

  // The renderer fills the window, but the chrome covers its left, right and
  // top edges. Shift the camera's projection so the build plate is centred in
  // the *visible* viewport instead of behind the inspector. XR sessions drive
  // the camera themselves, so the offset is cleared for the duration.
  const viewport = byId('viewport');
  const centreCameraOnViewport = () => {
    const camera = xb.core.camera;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    if (xb.core.renderer?.xr?.isPresenting) {
      camera.clearViewOffset();
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || width < 1 || height < 1) {
      camera.clearViewOffset();
      return;
    }
    camera.setViewOffset(
      width,
      height,
      Math.round(width / 2 - (rect.left + rect.width / 2)),
      Math.round(height / 2 - (rect.top + rect.height / 2)),
      width,
      height,
    );
  };
  centreCameraOnViewport();
  window.addEventListener('resize', centreCameraOnViewport);
  new ResizeObserver(centreCameraOnViewport).observe(viewport);
  xb.core.renderer?.xr?.addEventListener('sessionstart', centreCameraOnViewport);
  xb.core.renderer?.xr?.addEventListener('sessionend', centreCameraOnViewport);

  const toolSettingsPanel = byId('tool-settings-panel');
  const toolSettingsTitle = byId('tool-settings-title');
  const toolSettingsContent = byId('tool-settings-content');
  const btnCloseToolSettings = byId('btn-close-tool-settings');

  btnCloseToolSettings.onclick = () => {
    void registry
      .invoke('tool_move', 'dom-toolbar', actionCtx, uiState.get())
      .catch((error) => console.error('[orcaxr] close-tool action failed:', error));
  };

  let currentSettingsTool = '';
  const updateToolSettings = () => {
    const s = uiState.get();
    const hasSelection = !!workspace.getSelectedModelScale();

    // Colour painting has its own canonical panel; this legacy surface only
    // covers the numeric transform tools.
    if (hasSelection && (s.activeTool === 'move' || s.activeTool === 'rotate' || s.activeTool === 'scale')) {
      toolSettingsPanel.style.display = 'block';

      const pos = workspace.getSelectedModelPosition() || new THREE.Vector3();
      const rot = workspace.getSelectedModelRotation() || new THREE.Euler();
      const scl = workspace.getSelectedModelScale() || new THREE.Vector3(1, 1, 1);

      let xVal = 0,
        yVal = 0,
        zVal = 0;
      if (s.activeTool === 'move') {
        xVal = pos.x;
        yVal = pos.y;
        zVal = pos.z;
      } else if (s.activeTool === 'rotate') {
        xVal = THREE.MathUtils.radToDeg(rot.x);
        yVal = THREE.MathUtils.radToDeg(rot.y);
        zVal = THREE.MathUtils.radToDeg(rot.z);
      } else if (s.activeTool === 'scale') {
        xVal = scl.x * 100;
        yVal = scl.y * 100;
        zVal = scl.z * 100;
      }

      if (currentSettingsTool !== s.activeTool) {
        currentSettingsTool = s.activeTool;
        let title = '';
        if (s.activeTool === 'move') title = 'Move (mm)';
        else if (s.activeTool === 'rotate') title = 'Rotate (deg)';
        else if (s.activeTool === 'scale') title = 'Scale (%)';

        toolSettingsTitle.textContent = title;
        toolSettingsContent.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:#a0aab5; width:20px;">X</span>
              <input type="number" id="ts-x" step="0.1" style="width:100px; background:#1e293b; border:1px solid #334155; color:#fff; padding:4px; border-radius:4px; font-size:13px;" />
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:#a0aab5; width:20px;">Y</span>
              <input type="number" id="ts-y" step="0.1" style="width:100px; background:#1e293b; border:1px solid #334155; color:#fff; padding:4px; border-radius:4px; font-size:13px;" />
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:#a0aab5; width:20px;">Z</span>
              <input type="number" id="ts-z" step="0.1" style="width:100px; background:#1e293b; border:1px solid #334155; color:#fff; padding:4px; border-radius:4px; font-size:13px;" />
            </div>
          </div>
        `;

        const inX = byId('ts-x') as HTMLInputElement;
        const inY = byId('ts-y') as HTMLInputElement;
        const inZ = byId('ts-z') as HTMLInputElement;

        const onTransformChange = () => {
          const x = parseFloat(inX.value) || 0;
          const y = parseFloat(inY.value) || 0;
          const z = parseFloat(inZ.value) || 0;
          if (s.activeTool === 'move') {
            workspace.setSelectedModelPosition(x, y, z);
          } else if (s.activeTool === 'rotate') {
            workspace.setSelectedModelRotation(
              THREE.MathUtils.degToRad(x),
              THREE.MathUtils.degToRad(y),
              THREE.MathUtils.degToRad(z),
            );
          } else if (s.activeTool === 'scale') {
            workspace.setSelectedModelScale(x / 100, y / 100, z / 100);
          }
        };

        inX.onchange = onTransformChange;
        inY.onchange = onTransformChange;
        inZ.onchange = onTransformChange;
      }

      const inX = byId('ts-x') as HTMLInputElement;
      const inY = byId('ts-y') as HTMLInputElement;
      const inZ = byId('ts-z') as HTMLInputElement;
      if (inX && document.activeElement !== inX) inX.value = xVal.toFixed(2);
      if (inY && document.activeElement !== inY) inY.value = yVal.toFixed(2);
      if (inZ && document.activeElement !== inZ) inZ.value = zVal.toFixed(2);
    } else {
      toolSettingsPanel.style.display = 'none';
      currentSettingsTool = '';
    }
  };

  uiState.subscribe(updateToolSettings);
  workspace.onSelectionTransformChanged = updateToolSettings;

  // The command palette: every action, searchable, one Ctrl/⌘-K away.
  const palette = new CommandPalette(registry, actionCtx, uiState);

  AiConfigDialog.init();
  document.getElementById('cmd-ai-config')?.addEventListener('click', () => {
    AiConfigDialog.show();
  });

  palette.mount(
    byId('command-palette'),
    document.getElementById('cmd-input') as HTMLInputElement,
    byId('cmd-list'),
    byId('cmd-search-btn'),
  );

  // Remove the first-paint readiness surface only after both the workspace and
  // its actionable shell exist. This avoids a blank / seemingly frozen canvas
  // on cold headset loads.
  document.getElementById('app-boot')?.classList.add('ready');
});
