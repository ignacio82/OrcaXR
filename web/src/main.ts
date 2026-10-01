import type { ApplicationInitialization } from './startup/ApplicationInitialization';
import { SurfaceLifecycle, ownPageLifetime } from './ui/SurfaceLifecycle';
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
  loadPrinterEndpointPreferences,
  MoonrakerTransport,
  MoonrakerTransportError,
  PrintJobCommandError,
  PrintHistoryError,
  PrinterCameraError,
  PrinterConsoleError,
  PrinterConsoleLog,
  PrinterStorageError,
  assessGcodeCommand,
  buildMacroInvocation,
  cameraCanShowFrames,
  cameraDirectFrameUrl,
  cameraMechanisms,
  deletePrinterFile,
  downloadPrinterFile,
  fetchCameraSnapshot,
  listPrintHistory,
  listPrinterCameras,
  listPrinterDirectory,
  listPrinterMacros,
  movePrinterFile,
  queryMoonrakerFilamentSlots,
  readPrintHistoryTotals,
  readPrinterFileMetadata,
  recentCommands,
  renamedStoragePath,
  runGcodeScript,
  savePrinterEndpointPreferences,
  PrinterSessionController,
  type PrintJobCommandIntent,
  type MoonrakerConnectionState,
  type MoonrakerHandshake,
  type PrintJobCommand,
  type PrintJobSnapshot,
  type PrintHistoryPage,
  type PrintHistoryTotals,
  type CameraMechanism,
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
import { activeDomTheme, initialDomTheme, injectTokenCss, setDomTheme } from './ui/tokens';
import { UiState } from './actions/UiState';
import { ActionContext } from './actions/ActionContext';
import { buildRegistry } from './actions/catalog';
import { Localizer, createCatalogLoader } from './l10n/Localizer';
import { findLocale, negotiateLocale, selectableLocales } from './l10n/locales';
import { installLocalizer } from './l10n/t';
import type { ActionInvocation, ActionRegistry } from './actions/ActionRegistry';
import { buildShortcutCatalog, isShortcutEditingTarget, matchShortcut } from './actions/ShortcutCatalog';
import { DomShell } from './ui/dom/DomShell';
import { CommandPalette } from './ui/dom/CommandPalette';
import { ContextMenu, contextMenuGroups } from './ui/dom/ContextMenu';
import { ObjectsPanel, type ObjectsPanelSelectionRequest } from './ui/dom/ObjectsPanel';
import { FilamentAssignmentSelector } from './ui/dom/FilamentAssignmentSelector';
import { SelectionFilamentBar } from './ui/dom/SelectionFilamentBar';
import { askThreeMfIntake } from './ui/dom/FileIntakeDialog';
import { PrintWorkflowController } from './printer/PrintWorkflowController';
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
import { ProjectSummaryPanel } from './ui/dom/ProjectSummaryPanel';
import { WorkspaceViews, type WorkspaceViewId } from './ui/dom/WorkspaceViews';
import { hydrateIcons } from './ui/icons';
import { PaintPanel } from './ui/dom/PaintPanel';
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
  randomPrinterId,
  removePrinter,
  savePrinterDirectory,
  setDefaultPrinter,
} from './printer/PrinterDirectory';
import {
  applyPreferences,
  exportPreferences,
  importPreferences,
  LANGUAGE_KEY,
  loadPreferences,
  resetPreferences,
  savePreferences,
} from './settings/Preferences';
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
import { t } from './l10n/t';
import { diagnoseLocalNetwork, normalizeHttpEndpoint } from './net/LocalNetworkAccess';

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
// change. Kill it so dev is always fresh. (Production applies service-worker updates through the unsaved-work guard.)
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
const PRINT_JOB_ACTION_IDS: Readonly<Record<PrintJobCommand, string>> = Object.freeze({
  pause: 'printer_pause_print',
  resume: 'printer_resume_print',
  cancel: 'printer_cancel_print',
  'emergency-stop': 'printer_emergency_stop',
  'firmware-restart': 'printer_firmware_restart',
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
/**
 * Bring a panel into view in the parameter sidebar.
 *
 * A sidebar card folds and a `<details>` inside it closes, and either one
 * leaves the element with no box at all — so "scroll to it" has to open what
 * is holding it shut first, or it scrolls to nothing and reports success.
 */
function revealInSidebar(element: Element): void {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
    if (node.classList.contains('oxr-card')) {
      node.classList.remove('folded');
      node.querySelector('[data-card-toggle]')?.setAttribute('aria-expanded', 'true');
    }
  }
  element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

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
  'firmware-restart': {
    title: 'Restart this printer’s firmware?',
    message: 'Klipper restarts on the selected printer',
    consequences: ['An active print will be interrupted. Check the printer before starting another job.'],
    confirmLabel: 'Restart firmware',
    dismissLabel: 'Keep current state',
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
/**
 * Show one of the four workspaces, once the tab strip exists.
 *
 * Set when the tabs are built, and read by anything that has to *show*
 * something — the camera panel lives on the Device page, and opening it while
 * Prepare is up changes nothing the operator can see.
 */
let showWorkspaceView: ((id: WorkspaceViewId) => void) | undefined;

function setupDomUI(
  workspace: OrcaWorkspace,
  uiState: UiState,
  actionCtx: ActionContext,
  registry: ActionRegistry,
  l10n: () => Localizer,
  initialization: ApplicationInitialization,
  surfaces: SurfaceLifecycle,
) {
  surfaces.bind(workspace, 'onRequestSplitToObjectsConfirmation', (confirmation) =>
    window.confirm(
      `Split “${confirmation.objectName}” into separate objects?\n\n` +
        `${confirmation.strategy === 'existing-volumes' ? `${confirmation.volumeCount} existing volumes will be promoted` : `${confirmation.triangleCount.toLocaleString()} triangles will be separated by connected body`} across all ${confirmation.affectedInstanceIds.length} instance${confirmation.affectedInstanceIds.length === 1 ? '' : 's'}.\n\n` +
        'The original object will be replaced in one undoable edit.',
    ),
  );
  // On phones the parameter sidebar is a bottom sheet; its handle toggles it
  // so the 3D view isn't permanently half-covered. On desktop the same class
  // is what the toolbar's `‹›` control writes, so one state serves both.
  const sidebar = document.getElementById('param-sidebar') as HTMLElement;
  const sidebarHandle = document.getElementById('sidebar-handle') as HTMLButtonElement;
  // On a phone the sheet starts folded, so the first thing an operator sees is
  // the plate rather than a settings panel over it. The same class folds the
  // docked column on desktop, so this is asked of the layout rather than
  // applied unconditionally.
  if (window.matchMedia('(max-width: 768px)').matches) {
    sidebar.classList.add('collapsed');
    sidebarHandle.setAttribute('aria-expanded', 'false');
  }
  surfaces.listen(sidebarHandle, 'click', () => {
    sidebar.classList.toggle('collapsed');
    sidebarHandle.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
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
  const toolbarToggle = document.getElementById('toolbar-toggle') as HTMLButtonElement;
  const statusDot = document.getElementById('status-dot') as HTMLElement;
  const printerHost = document.getElementById('printer-host') as HTMLInputElement;
  const printerApiKey = document.getElementById('printer-api-key') as HTMLInputElement;
  const btnPrinterTest = document.getElementById('btn-printer-test') as HTMLButtonElement;
  const btnPrinterSend = document.getElementById('btn-printer-send') as HTMLButtonElement;
  const printerCfg = loadPrinterEndpointPreferences();
  const printerSession = new PrinterSessionController((selection) => {
    const transport = new MoonrakerTransport({
      endpoint: selection.endpoint,
      defaultPort: selection.port,
      clientName: 'OrcaXR Web',
      clientVersion: window.ORCAXR_VERSION,
    });
    transport.setSessionCredentials({ apiKey: selection.apiKey });
    return transport;
  });
  surfaces.own(printerSession);
  let printJobSnapshot: PrintJobSnapshot | null = null;
  let printerConnectionState: MoonrakerConnectionState | null = null;
  /**
   * Surfaces that derive from the active profile subscribe here rather than
   * each one racing to own `onProfileChanged`.
   */
  const profileChangeListeners = new Set<() => void>();
  const printJobListeners = new Set<() => void>();
  surfaces.defer(() => {
    profileChangeListeners.clear();
    printJobListeners.clear();
  });
  surfaces.defer(
    printerSession.subscribe(() => {
      printJobSnapshot = printerSession.snapshot;
      printerConnectionState = printerSession.state;
      uiState.update({
        printerJobState:
          printerConnectionState?.status === 'connected' ? (printJobSnapshot?.state ?? 'unknown') : 'disconnected',
      });
      for (const listener of printJobListeners) listener();
    }),
  );

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
    const actions = printerSession
      .availability()
      .map((action) =>
        !printerSession.transport &&
        printerCfg.host.trim() &&
        (action.command === 'emergency-stop' || action.command === 'firmware-restart')
          ? { ...action, allowed: true, reason: undefined }
          : action,
      );
    return guardedPrinterActions(actions, {
      stale: summary.stale,
      ...(summary.recovery ? { staleReason: summary.recovery.message } : {}),
    });
  };

  const disposePrinterTransport = () => printerSession.clear();

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
    return printerSession.select({
      id: printers.defaultId ?? endpoint,
      name: defaultPrinter(printers)?.name ?? endpoint,
      endpoint,
      port: printerCfg.port,
      apiKey: printerApiKey.value.trim() || undefined,
    });
  };

  const connectConfiguredPrinter = async (
    signal?: AbortSignal,
  ): Promise<{
    transport: MoonrakerTransport;
    handshake: MoonrakerHandshake;
  }> => {
    configuredPrinterTransport();
    return printerSession.connect(signal);
  };

  const capturePrinterIntent = (command: PrintJobCommand): PrintJobCommandIntent | undefined => {
    try {
      configuredPrinterTransport();
      return printerSession.captureIntent(command);
    } catch (error) {
      workspace.setStatus((error as Error).message);
      return undefined;
    }
  };

  /**
   * The endpoint in this message came out of a text field, and the modal takes
   * HTML. Escape it rather than trusting what was typed into a settings box.
   */
  const escapeHtml = (value: string): string =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
    );

  /**
   * Report a LAN endpoint that could not be reached, in terms that can be acted on.
   *
   * The status line gets the one-line version and, when the browser refused the
   * request outright, a modal gets the whole explanation — an operator whose
   * HTTPS page cannot see their printer needs to be told which of three moves
   * to make, and that does not fit on one line.
   */
  const reportLocalNetworkFailure = async (
    endpoint: string,
    service: string,
    corsSetting: string,
    cause: unknown,
    appOrigin?: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    const diagnosis = await diagnoseLocalNetwork(endpoint, service, corsSetting, cause, {
      // The all-in-one server publishes this app beside the slicer, so a
      // configured one is the shortest way out of a mixed-content block.
      ...(appOrigin ? { appOrigin } : {}),
    });
    if (surfaces.signal.aborted || !isCurrent()) return;
    workspace.setStatus(diagnosis.summary);
    if (!endpoint || !diagnosis.blocked) return;
    const paragraphs = diagnosis.detail
      .split('\n\n')
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');
    // Somewhere to go, not an address to retype.
    const link = diagnosis.openAppAt
      ? `<p><a href="${escapeHtml(diagnosis.openAppAt)}" rel="noreferrer">${escapeHtml(
          t('app.main.openOrcaXrThere', 'Open OrcaXR there'),
        )}</a></p>`
      : '';
    workspace.showModal(
      t('app.main.cannotReachLocalNetwork', 'This page cannot reach your local network'),
      paragraphs + link,
    );
  };

  surfaces.bind(workspace, 'onRequestPrinterConnectionTest', async () => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint', 'Enter an explicit Moonraker endpoint first.'),
      );
      return;
    }
    workspace.setStatus(t('app.main.testingPrinterConnection', 'Testing printer connection…'));
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
      // "No response: Failed to fetch" is what a browser says when it refused
      // to send the request at all, and it reads as a printer that is switched
      // off. Say which of the two it is.
      await reportLocalNetworkFailure(
        normalizeHttpEndpoint(printerCfg.host),
        'printer',
        "Moonraker's cors_domains",
        error,
        SlicerClient.getExternalSlicerUrl(),
      );
    }
  });

  surfaces.bind(workspace, 'onRequestPrinterFilamentInspection', async () => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint2', 'Enter an explicit Moonraker endpoint first.'),
      );
      return;
    }
    workspace.setStatus(
      t('app.main.readingFilamentSlotsFromThe', 'Reading filament slots from the connected printer…'),
    );
    try {
      const { transport, handshake } = await connectConfiguredPrinter();
      if (!handshake.capabilities.klippyConnected) {
        throw new MoonrakerTransportError('invalid_state', 'query_filament_slots');
      }
      const slots = await queryMoonrakerFilamentSlots(transport);
      if (slots.length === 0) {
        workspace.setStatus(t('app.main.thePrinterReportedNoLoaded', 'The printer reported no loaded filament slots.'));
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
  });

  surfaces.bind(workspace, 'onRequestPrinterFilamentQuery', async () => {
    if (!printerCfg.host.trim()) return null;
    try {
      const { transport, handshake } = await connectConfiguredPrinter();
      if (!handshake.capabilities.klippyConnected) return null;
      const slots = await queryMoonrakerFilamentSlots(transport);
      return slots.length > 0 ? slots : null;
    } catch {
      return null;
    }
  });

  const printWorkflow = new PrintWorkflowController({
    captureSession: async (signal) => {
      await connectConfiguredPrinter(signal);
      return printerSession.captureLease();
    },
    confirm: async (input, signal) =>
      xb.core.renderer?.xr?.isPresenting
        ? workspace.askXrPrintSubmission(input, signal)
        : (await import('./ui/dom/PrintSubmissionDialog')).askPrintSubmission(input, signal),
  });

  surfaces.own(printWorkflow);
  surfaces.bind(workspace, 'onRequestPrintSubmission', async (intent) => {
    if (printWorkflow.busy) {
      workspace.setStatus(
        t('app.main.aSendIsAlreadyIn', 'A send is already in progress; cancel it before starting another.'),
      );
      return;
    }
    setPrinterSendBusy(true);
    try {
      const result = await printWorkflow.run(intent, {
        onUploadElapsed: ({ elapsedMs, totalBytes }) => {
          const seconds = Math.floor(elapsedMs / 1000);
          const clock = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
          workspace.setStatus(
            t(
              'app.main.uploadElapsed',
              'Uploading {filename} ({megabytes} MB) — {elapsed} elapsed. Press Cancel send to stop.',
              { filename: intent.filename, megabytes: (totalBytes / 1048576).toFixed(1), elapsed: clock },
            ),
          );
        },
        onPhase: (phase) => {
          const messages = {
            checking: t('app.main.checkingPrinter', 'Checking the printer…'),
            confirming: t('app.main.confirmSend', 'Confirm the send options…'),
            uploading: t('app.main.uploadingFile', 'Uploading {filename}…', { filename: intent.filename }),
            verifying: t('app.main.verifyingFile', 'Verifying the stored file…'),
            preparing: t('app.main.preparingPrinter', 'Preparing the printer with the confirmed options…'),
            starting: t('app.main.startingPrint', 'Starting the print…'),
            completed: t('app.main.sendCompleted', 'Send completed.'),
          };
          workspace.setStatus(messages[phase]);
        },
      });
      if (!result) {
        workspace.setStatus(t('app.main.sendCancelledNothingWasUploaded', 'Send cancelled; nothing was uploaded.'));
        return;
      }
      if (result.startedPrint) await printerSession.refresh().catch(() => {});
      workspace.setStatus(
        result.startedPrint
          ? t('app.main.verifiedPrint', 'Printing {filename} — {kilobytes} KB verified on the printer.', {
              filename: result.path,
              kilobytes: (result.verifiedBytes / 1024).toFixed(0),
            })
          : t(
              'app.main.verifiedUpload',
              'Uploaded {filename} — {kilobytes} KB verified; start it from the printer when ready.',
              { filename: result.path, kilobytes: (result.verifiedBytes / 1024).toFixed(0) },
            ),
      );
    } catch (error) {
      workspace.setStatus(t('app.main.sendFailure', 'Send failed: {reason}', { reason: (error as Error).message }));
    } finally {
      setPrinterSendBusy(false);
    }
  });

  // Every surface passes the original press-time intent or captures one here
  // before opening a dialog. The controller alone refreshes and dispatches it.
  surfaces.bind(workspace, 'onRequestPrintJobCommand', async (command, options) => {
    try {
      configuredPrinterTransport();
      const intent = options?.confirmation?.intent ?? printerSession.captureIntent(command);
      if (intent.command !== command)
        throw new PrintJobCommandError(
          'The confirmation is for a different command.',
          'confirmation-required',
          command,
        );
      const dialog = PRINT_JOB_CONFIRMATIONS[command];
      await printerSession.execute(
        intent,
        options?.confirmation ??
          (dialog
            ? async (original, signal) =>
                askPrintJobConfirmation(
                  {
                    ...dialog,
                    message: `${dialog.message} (${original.printerLabel}${original.displayedFilename ? ` · ${original.displayedFilename}` : ''})`,
                  },
                  signal,
                )
            : undefined),
      );
      workspace.setStatus(PRINT_JOB_OUTCOMES[command]);
    } catch (error) {
      workspace.setStatus((error as Error).message);
    }
  });

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

  surfaces.bind(workspace, 'onRequestPrinterStorage', async (operation) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint5', 'Enter an explicit Moonraker endpoint first.'),
      );
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
          const started = await printWorkflow.startStored(operation.path);
          if (!started) {
            storageState.message = 'Print cancelled.';
            break;
          }
          await printerSession.refresh().catch(() => {});
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
  });

  const printerStorageHost = document.getElementById('printer-storage-host');
  if (printerStorageHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void initialization.mount('printer-storage', 'Printer files', async (scope) => {
      surfaces.attach(scope);
      const { PrinterStoragePanel } = await scope.import(import('./ui/dom/PrinterStoragePanel'));
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
          await scope.load(
            registry.invoke(PRINTER_STORAGE_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
              printerStorage: operation,
            }),
          );
        },
        askName: async (current) => {
          const next = window.prompt(
            t('app.main.newNameForThisFile', 'New name for this file on the printer'),
            current,
          );
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
      scope.own(storagePanel);
      storagePanel.mount();
      scope.defer(() => {
        releaseThumbnail();
        storagePanel.dispose();
      });
    });
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
  let consoleTransport: MoonrakerTransport | undefined;
  surfaces.defer(() => {
    unsubscribeConsole?.();
    unsubscribeConsole = undefined;
    consoleTransport = undefined;
  });
  const trackConsoleResponses = (transport: MoonrakerTransport) => {
    if (surfaces.signal.aborted || (consoleTransport === transport && unsubscribeConsole)) return;
    unsubscribeConsole?.();
    consoleTransport = transport;
    unsubscribeConsole = transport.subscribeNotifications((notification) => {
      if (consoleLog.appendNotification(notification.method, notification.params)) notifyConsole();
    });
  };

  surfaces.bind(workspace, 'onRequestPrinterConsole', async (operation) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint6', 'Enter an explicit Moonraker endpoint first.'),
      );
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
  });

  const printerConsoleHost = document.getElementById('printer-console-host');
  if (printerConsoleHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void initialization.mount('printer-console', 'Printer console', async (scope) => {
      surfaces.attach(scope);
      const { PrinterConsolePanel } = await scope.import(import('./ui/dom/PrinterConsolePanel'));
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
          await scope.load(
            registry.invoke(PRINTER_CONSOLE_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
              printerConsole: operation,
            }),
          );
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
      scope.own(consolePanel);
      consolePanel.mount();
    });
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

  surfaces.bind(workspace, 'onRequestPrintHistory', async (start) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint7', 'Enter an explicit Moonraker endpoint first.'),
      );
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
  });

  const printerHistoryHost = document.getElementById('printer-history-host');
  if (printerHistoryHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void initialization.mount('printer-history', 'Printer history', async (scope) => {
      surfaces.attach(scope);
      const { PrintHistoryPanel } = await scope.import(import('./ui/dom/PrintHistoryPanel'));
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
          await scope.load(
            registry.invoke('printer_view_history', 'dom-inspector', actionCtx, uiState.get(), {
              printHistoryStart: start,
            }),
          );
        },
      });
      scope.own(historyPanel);
      historyPanel.mount();
    });
  }

  // The camera. Every frame is its own authenticated request, so the panel owns
  // a timer that stops the moment nobody can see it.
  const cameraState: {
    cameras: readonly PrinterCamera[];
    selected?: string;
    frameUrl?: string;
    busy: boolean;
    message?: string;
    /** The last frame fetch that failed, cleared by the next one that works. */
    failure?: string;
    /**
     * How each camera's frames are being obtained, and what has already been
     * ruled out. A printer's cameras can sit on Moonraker, on nginx, or on a
     * streamer's own port, and rather than ask anyone which, each route is
     * tried in turn and the one that works is kept.
     */
    routes: Map<string, { readonly tried: Set<CameraMechanism>; current?: CameraMechanism; proven?: boolean }>;
  } = { cameras: [], busy: false, routes: new Map() };

  /**
   * The next route to try for this camera, or undefined when none is left.
   *
   * Every failure narrows the set, so a camera that ends up unreachable spends
   * a handful of requests saying so rather than one per frame forever.
   */
  const cameraRoute = (camera: PrinterCamera): CameraMechanism | undefined => {
    let state = cameraState.routes.get(camera.uid);
    if (!state) {
      state = { tried: new Set<CameraMechanism>() };
      cameraState.routes.set(camera.uid, state);
    }
    if (state.current && !state.tried.has(state.current)) return state.current;
    const next = cameraMechanisms(camera).find((mechanism) => !state.tried.has(mechanism));
    state.current = next;
    return next;
  };
  /**
   * What to say once every route has failed.
   *
   * The common dead end is worth naming exactly, because it is not something
   * the operator can fix in this app: a plain-HTTP camera cannot be displayed
   * on an HTTPS page at all, so the only route left is reading its bytes, and
   * most camera services send no cross-origin headers.
   */
  const describeExhaustedCamera = (camera: PrinterCamera, lastMessage: string): string => {
    if (window.location.protocol === 'https:' && camera.snapshotUrl?.startsWith('http:')) {
      return (
        `${lastMessage} This page is HTTPS and ${camera.snapshotUrl} is plain HTTP, so the browser will not ` +
        'display it directly and can only read its bytes — which the camera itself has to allow with a ' +
        'cross-origin header. Reaching the printer over HTTPS, or allowing this origin on the camera, would show it.'
      );
    }
    return `${lastMessage} There is nothing else left to try for ${camera.name}.`;
  };

  /**
   * Record that a route produced a frame.
   *
   * A route that has worked is not given up on. Cameras drop frames — a busy
   * Pi, a Wi-Fi blip — and retiring the route that has been feeding the panel
   * over one of those would walk off a working arrangement onto a broken one,
   * and then report the broken one's failure as the camera's.
   */
  const cameraRouteWorked = (camera: PrinterCamera) => {
    const state = cameraState.routes.get(camera.uid);
    if (state) state.proven = true;
  };
  const cameraRouteFailed = (camera: PrinterCamera, mechanism: CameraMechanism) => {
    const state = cameraState.routes.get(camera.uid);
    if (!state || state.proven) return;
    state.tried.add(mechanism);
    delete state.current;
  };
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

  /**
   * Bring the camera on screen: the Device workspace first, then the section.
   *
   * Opening the `<details>` on its own is what made "Tools ▸ View Webcam" look
   * like it did nothing — the section it opened lives on the Device page, and
   * that page is hidden while Prepare or Preview is up. An action that names a
   * thing has to show the thing.
   */
  const revealPrinterCamera = () => {
    showWorkspaceView?.('device');
    const details = document.getElementById('printer-camera-details') as HTMLDetailsElement | null;
    if (!details) return;
    details.open = true;
    details.scrollIntoView({ block: 'nearest' });
  };

  surfaces.bind(workspace, 'onRequestPrinterCamera', async (uid) => {
    if (!printerCfg.host.trim()) {
      workspace.setStatus(
        t('app.main.enterAnExplicitMoonrakerEndpoint8', 'Enter an explicit Moonraker endpoint first.'),
      );
      return;
    }
    // Shown first, then loaded: the operator asked to see the camera, and a
    // window that changes only if the request succeeds looks like a dead menu
    // item whenever the printer is slow or unreachable.
    revealPrinterCamera();
    cameraState.busy = true;
    notifyCamera();
    try {
      const { transport } = await connectConfiguredPrinter();
      // The endpoint goes in because most Klipper boxes serve the camera from
      // another port of the same machine, and without something to compare
      // against, such a URL is indistinguishable from one on Moonraker itself.
      cameraState.cameras = await listPrinterCameras(transport, undefined, transport.endpoint.directHttpUrl);
      // Prefer a camera that can actually be shown, so the first thing anyone
      // sees is a picture rather than an explanation.
      const requested = uid ?? cameraState.selected;
      cameraState.selected =
        cameraState.cameras.find((camera) => camera.uid === requested)?.uid ??
        cameraState.cameras.find((camera) => cameraCanShowFrames(camera) && camera.enabled)?.uid ??
        cameraState.cameras[0]?.uid;
      releaseFrame();
      delete cameraState.failure;
      // A fresh look at the printer is a fresh chance for every route: a camera
      // that was unreachable a minute ago may be a camera that has been plugged
      // back in.
      cameraState.routes.clear();
      cameraState.message =
        cameraState.cameras.length === 0
          ? 'This printer reports no cameras.'
          : `${cameraState.cameras.length} camera${cameraState.cameras.length === 1 ? '' : 's'} found.`;
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
  });

  const printerCameraHost = document.getElementById('printer-camera-host');
  if (printerCameraHost) {
    const cameraDetails = document.getElementById('printer-camera-details') as HTMLDetailsElement | null;
    const devicePage = document.getElementById('page-device');
    const visibilityListeners = new Set<() => void>();
    const announceVisibility = () => {
      for (const listener of visibilityListeners) listener();
    };
    surfaces.listen(document, 'visibilitychange', announceVisibility);
    if (cameraDetails) surfaces.listen(cameraDetails, 'toggle', announceVisibility);
    // The Device page is hidden by whoever switches workspaces, so the panel
    // watches the attribute rather than the switch: polling a camera nobody can
    // see is the same waste whether the tab moved or the tab bar did.
    const pageVisibility = devicePage ? surfaces.observe(new MutationObserver(announceVisibility)) : undefined;
    if (devicePage) pageVisibility?.observe(devicePage, { attributes: true, attributeFilter: ['hidden'] });
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void initialization.mount('printer-camera-panel', 'Printer camera controls', async (scope) => {
      surfaces.attach(scope);
      const { PrinterCameraPanel } = await scope.import(import('./ui/dom/PrinterCameraPanel'));
      const cameraPanel = new PrinterCameraPanel(
        printerCameraHost,
        {
          getCameras: () => cameraState.cameras,
          getSelected: () => selectedCamera(),
          getFrameUrl: () => cameraState.frameUrl,
          getRoute: () => {
            const camera = selectedCamera();
            return camera ? cameraState.routes.get(camera.uid)?.current : undefined;
          },
          getStatus: () => ({
            busy: cameraState.busy,
            ...(cameraState.message ? { message: cameraState.message } : {}),
            ...(cameraState.failure ? { failure: cameraState.failure } : {}),
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
            await scope.load(registry.invoke('view_webcam', 'dom-inspector', actionCtx, uiState.get()));
          },
          captureFrame: async (signal) => {
            const camera = selectedCamera();
            const current = () =>
              !scope.signal.aborted &&
              !signal?.aborted &&
              selectedCamera()?.uid === camera?.uid &&
              document.visibilityState === 'visible' &&
              cameraDetails?.open !== false &&
              devicePage?.hidden !== true;
            if (!camera || !cameraCanShowFrames(camera) || !current()) return;
            const route = cameraRoute(camera);
            if (!route) {
              // Every route has been tried. Whatever the last one said stands;
              // saying "waiting" on top of it would only invite more waiting.
              notifyCamera();
              return;
            }
            // The browser loads this one itself. It needs no credential, and an
            // image needs no CORS — which is the only reason a stock camera
            // service is visible at all.
            if (route === 'image') {
              releaseFrame();
              cameraState.frameUrl = cameraDirectFrameUrl(camera, Date.now());
              delete cameraState.message;
              delete cameraState.failure;
              notifyCamera();
              return;
            }
            try {
              const { transport } = await scope.load(connectConfiguredPrinter());
              if (!current()) return;
              const bytes = await scope.load(fetchCameraSnapshot(transport, camera, signal, route));
              if (!current()) return;
              releaseFrame();
              cameraState.frameUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
              cameraRouteWorked(camera);
              delete cameraState.message;
              delete cameraState.failure;
            } catch (error) {
              if (!current()) return;
              const message = error instanceof PrinterCameraError ? error.message : (error as Error).message;
              cameraRouteFailed(camera, route);
              cameraState.message = message;
              // Shown where the picture would be: a panel that keeps saying
              // "waiting for the first frame" while every fetch fails is asking
              // the operator to wait for something that is not coming.
              cameraState.failure = cameraRoute(camera) ? message : describeExhaustedCamera(camera, message);
            }
            notifyCamera();
          },
          reportFrameShown: () => {
            const camera = selectedCamera();
            if (camera) cameraRouteWorked(camera);
          },
          reportFrameError: (url) => {
            const camera = selectedCamera();
            if (!camera) return;
            cameraRouteFailed(camera, 'image');
            releaseFrame();
            const remaining = cameraRoute(camera);
            const message = `The browser would not load a frame from ${url}.`;
            cameraState.failure = remaining ? message : describeExhaustedCamera(camera, message);
            cameraState.message = cameraState.failure;
            notifyCamera();
          },
        },
        {
          // Hidden tab, another workspace, or a collapsed section: all three
          // mean nobody is watching.
          isVisible: () =>
            document.visibilityState === 'visible' && cameraDetails?.open !== false && devicePage?.hidden !== true,
          subscribeVisibility: (listener) => {
            visibilityListeners.add(listener);
            return () => visibilityListeners.delete(listener);
          },
          setInterval: (handler, ms) => window.setInterval(handler, ms),
          clearInterval: (handle) => window.clearInterval(handle),
        },
      );
      scope.own(cameraPanel);
      cameraPanel.mount();
      scope.defer(releaseFrame);
    });
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
    surfaces.own(panel);
    panel.mount();
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
      captureIntent: capturePrinterIntent,
      run: async (intent) => {
        // The hold that got here *is* the confirmation, and it stated the
        // consequence before it completed.
        try {
          await registry.invoke(PRINT_JOB_ACTION_IDS[intent.command], 'dom-inspector', actionCtx, uiState.get(), {
            printJobConfirmation: printerSession.confirm(intent),
          });
        } catch (error) {
          workspace.setStatus((error as Error).message);
        }
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
        document.querySelector<HTMLElement>('[data-view-tab="device"]')?.click();
        notifyStatusBar();
      },
    });
    surfaces.own(statusBar);
    statusBar.mount();

    // A stale reading's age is the only thing on the surface that changes with
    // nothing else happening, so it gets its own slow tick — and only while it
    // is actually stale, so an idle session schedules nothing.
    const ageTimer = window.setInterval(() => {
      if (printerReadingIsStale() && printJobSnapshot) notifyStatusBar();
    }, 5_000);

    // The spatial card renders the same summary and the same guarded actions;
    // only the gesture differs, and that lives in the shared hold machine.
    surfaces.bind(workspace, 'onReadPrinterStatus', () => {
      const summary = livePrinterStatus();
      return {
        summary: statusOverride === undefined ? summary : { ...summary, present: statusOverride },
        actions: livePrinterActions(),
      };
    });
    surfaces.bind(workspace, 'onCapturePrinterCommandIntent', capturePrinterIntent);
    surfaces.bind(workspace, 'onRunPrinterStatusCommand', async (intent) => {
      try {
        await registry.invoke(PRINT_JOB_ACTION_IDS[intent.command], 'xr-inspector', actionCtx, uiState.get(), {
          printJobConfirmation: printerSession.confirm(intent),
        });
      } catch (error) {
        workspace.setStatus((error as Error).message);
      }
    });
    surfaces.bind(workspace, 'onReconnectPrinter', async () => {
      try {
        await connectConfiguredPrinter();
      } catch (error) {
        workspace.setStatus(`Reconnect failed: ${(error as Error).message}`);
      }
      notifyStatusBar();
    });
    statusListeners.add(() => workspace.refreshPrinterStatusCard());

    surfaces.bind(workspace, 'onTogglePrinterStatusBar', () => {
      statusOverride = !(statusOverride ?? livePrinterStatus().present);
      notifyStatusBar();
      workspace.setStatus(statusOverride ? 'Printer status pinned over the plate.' : 'Printer status hidden.');
    });

    surfaces.defer(() => {
      window.clearInterval(ageTimer);
    });
  }

  // The calibration ledger (P8.5). It lives on this device rather than in the
  // project, because a measurement belongs to the machine it was taken on and
  // has to outlive every project sliced for it.
  const calibrationHistoryHost = document.getElementById('calibration-history-host');
  if (calibrationHistoryHost) {
    // Behind a closed <details>, and it carries the whole pinned calibration
    // catalog with it, so none of this belongs in first paint.
    void initialization.mount('calibration-history', 'Calibration history', async (scope) => {
      surfaces.attach(scope);
      const featureSurface = scope.own(new SurfaceLifecycle());
      const [{ CalibrationHistoryStore }, history, { CALIBRATION_JOB_DEFINITIONS, getCalibrationJobDefinition }] =
        await scope.import(
          Promise.all([
            import('./project/calibration/historyStore'),
            import('./project/calibration/history'),
            import('./project/calibration/definitions'),
          ]),
        );
      const { describeCalibrationApplication, planCalibrationApplication } = await scope.import(
        import('./project/calibration/application'),
      );
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
      scope.defer(() => profileChangeListeners.delete(notifyCalibration));

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

      featureSurface.bind(workspace, 'onRequestCalibrationHistory', async (operation: CalibrationHistoryOperation) => {
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
      });

      const { CalibrationHistoryPanel } = await scope.import(import('./ui/dom/CalibrationHistoryPanel'));
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
          await scope.load(
            registry.invoke(CALIBRATION_HISTORY_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
              calibrationHistory: operation,
            }),
          );
        },
        confirmDelete: async (record) =>
          window.confirm(
            `Delete the ${record.method.label} result measured on ${record.conditions.printerModel}? ` +
              'The measurement cannot be recovered.',
          ),
      });
      scope.own(calibrationPanel);
      calibrationPanel.mount();
    });
  }

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
  surfaces.bind(emptySetupPrinter, 'onclick', () => {
    // Goes through the real tab control the header renders, so this stays
    // correct if the tab set is ever reordered or relabelled.
    document.querySelector<HTMLElement>('[data-view-tab="device"]')?.click();
    printerHost.focus();
    statusText.textContent = t(
      'app.main.enterYourPrinterAddressIt',
      'Enter your printer address; it is saved on this device.',
    );
  });

  surfaces.bind(emptyLoadModel, 'onclick', () => {
    void registry
      .invoke('load_model_from_path', 'dom-primary', actionCtx, uiState.get())
      .catch((error) => console.error('[orcaxr] empty-state load action failed:', error));
  });
  /**
   * The `‹›` control against the panel edge, which is where the desktop app
   * puts the handle that folds the parameter sidebar away for a wider look at
   * the plate. Keep its label and expanded state in step with the class that
   * drives the CSS.
   */
  const syncSidebarToggle = () => {
    const collapsed = sidebar.classList.contains('collapsed');
    toolbarToggle.setAttribute('aria-expanded', String(!collapsed));
    toolbarToggle.title = collapsed
      ? t('app.main.showTheSettingsSidebar', 'Show the settings sidebar')
      : t('app.main.hideTheSettingsSidebar', 'Hide the settings sidebar');
    const glyph = toolbarToggle.querySelector('.tool-icon');
    const label = toolbarToggle.querySelector('.tool-label');
    if (glyph) glyph.textContent = collapsed ? '›‹' : '‹›';
    if (label) label.textContent = toolbarToggle.title;
    sidebarHandle.setAttribute('aria-expanded', String(!collapsed));
  };
  surfaces.defer(
    uiState.subscribe((state) => {
      emptyState.hidden = state.modelCount > 0;
      uiContainer.classList.toggle('no-model', state.modelCount === 0);
      statusDot.classList.toggle('busy', state.isSlicing);
      statusDot.classList.toggle('ready', !state.isSlicing && state.gcodeReady);
      syncSidebarToggle();
    }),
  );
  surfaces.bind(toolbarToggle, 'onclick', () => {
    sidebar.classList.toggle('collapsed');
    syncSidebarToggle();
  });

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
            // "Open as project" vs "import geometry only" is a question about
            // what to do with work that is already open. With an empty
            // workspace there is nothing to preserve and nothing to replace,
            // and opening as a project is strictly the more complete of the
            // two — it keeps the plates, settings, filaments and paint that
            // geometry-only would discard. So don't ask; just open it.
            const choice = workspace.modelCount === 0 ? 'project' : await askThreeMfIntake(file.name);
            if (choice === 'cancel') {
              statusText.textContent = t('app.main.loadCancelled', 'Load cancelled.');
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
  dropOverlay.textContent = t('app.main.dropA3MFSTLOBJ', 'Drop a 3MF, STL, OBJ, AMF, ZIP, or G-code file to load it');
  dropOverlay.style.cssText =
    'position:fixed;inset:16px;z-index:9998;display:none;align-items:center;justify-content:center;' +
    'border:2px dashed var(--oxr-color-accent);border-radius:var(--oxr-radius-lg);background:var(--oxr-bg-sunken);' +
    'color:var(--oxr-text);font:600 16px/1.4 var(--oxr-font-sans);pointer-events:none;text-align:center;padding:24px;';
  surfaces.defer(() => dropOverlay.remove());
  document.body.appendChild(dropOverlay);
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  surfaces.listen(window, 'dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
    dropOverlay.style.display = 'flex';
  });
  surfaces.listen(window, 'dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  surfaces.listen(window, 'dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
      dropOverlay.style.display = 'none';
    }
  });
  surfaces.listen(window, 'drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    dropOverlay.style.display = 'none';
    void intakeFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  surfaces.bind(fileInput, 'onchange', async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    await intakeFiles(files);
  });

  const downloadGcode = (gcode: string) => {
    const blob = new Blob([gcode], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'orcaxr.gcode';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  surfaces.bind(workspace, 'onDownloadGcode', downloadGcode);
  // Generic file save for the export actions (STL today, 3MF/config later).
  surfaces.bind(workspace, 'onDownloadFile', (name, data, mime) => {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  surfaces.bind(workspace, 'onRequestLoadStl', () => fileInput.click());

  // Import Zip Archive (File menu): a dedicated .zip-filtered picker routed
  // through the shared importZipArchive path.
  const zipInput = document.createElement('input');
  zipInput.type = 'file';
  zipInput.accept = '.zip';
  zipInput.style.display = 'none';
  surfaces.defer(() => zipInput.remove());
  document.body.appendChild(zipInput);
  surfaces.bind(zipInput, 'onchange', async () => {
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
  });
  surfaces.bind(workspace, 'onRequestLoadZip', () => zipInput.click());

  // Open G-code (File menu): a read-only viewer route that never touches the
  // canonical project.
  const gcodeInput = document.createElement('input');
  gcodeInput.type = 'file';
  gcodeInput.accept = '.gcode,.gco,.g';
  gcodeInput.style.display = 'none';
  surfaces.defer(() => gcodeInput.remove());
  document.body.appendChild(gcodeInput);
  surfaces.bind(gcodeInput, 'onchange', async () => {
    const file = gcodeInput.files?.[0];
    if (!file) return;
    loadingModal.style.display = 'flex';
    loadingModalText.textContent = `Reading ${file.name}...`;
    try {
      await workspace.openGcodeForPreview(await file.text(), file.name);
    } catch (error) {
      statusText.textContent = `Failed to open G-code: ${(error as Error).message}`;
    }
    loadingModal.style.display = 'none';
    gcodeInput.value = '';
  });
  surfaces.bind(workspace, 'onRequestOpenGcode', () => gcodeInput.click());

  const previousImportPreview = workspace.onProjectImportPreview;
  workspace.onProjectImportPreview = showProjectImportPreviewDialog;
  surfaces.defer(() => {
    if (workspace.onProjectImportPreview === showProjectImportPreviewDialog)
      workspace.onProjectImportPreview = previousImportPreview;
  });

  // Right-click in the scene, answered by the catalog (P11.2). The workspace
  // says what was clicked; the menu is generated from the same action model the
  // menu bar and the command palette render, with the same availability, so a
  // shortcut surface can never drift into a private list of operations.
  const sceneContextMenu = new ContextMenu(document.body, { datasetKey: 'sceneContextMenu' });
  surfaces.own(sceneContextMenu);
  surfaces.bind(workspace, 'onRequestSceneContextMenu', (request) => {
    sceneContextMenu.open({
      x: request.clientX,
      y: request.clientY,
      target: request.target,
      ariaLabel: request.target === 'object' ? 'Actions for the selected model' : 'Actions for this plate',
      instance: request.instanceId,
      groups: contextMenuGroups(registry, request.target, uiState.get(), (action) => {
        void registry.invoke(action.id, 'dom-context', actionCtx, uiState.get());
      }),
    });
  });

  // Open Project (File menu): every 3MF uses worker parse and explicit preview.
  const projInput = document.createElement('input');
  projInput.type = 'file';
  projInput.accept = '.3mf';
  projInput.style.display = 'none';
  surfaces.defer(() => projInput.remove());
  document.body.appendChild(projInput);
  surfaces.bind(projInput, 'onchange', async () => {
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
  });
  surfaces.bind(workspace, 'onRequestLoadProject', () => projInput.click());

  // Import Config (File menu): a .json picker → workspace.importConfig.
  const cfgInput = document.createElement('input');
  cfgInput.type = 'file';
  cfgInput.accept = '.json';
  cfgInput.style.display = 'none';
  surfaces.defer(() => cfgInput.remove());
  document.body.appendChild(cfgInput);
  surfaces.bind(cfgInput, 'onchange', async () => {
    const f = cfgInput.files?.[0];
    if (!f) return;
    try {
      workspace.importConfig(await f.text());
    } catch (e) {
      statusText.textContent = `Failed to import config: ${(e as Error).message}`;
    }
    cfgInput.value = '';
  });
  surfaces.bind(workspace, 'onRequestLoadConfig', () => cfgInput.click());

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
    // Invoking a menu item closes its dropdown, which takes the item out of
    // the layout and makes it unfocusable. Hand focus back to the trigger that
    // opened that menu — or, on a window narrow enough that the bar itself is
    // behind the hamburger, to the hamburger — so a keyboard user is never
    // left with focus on <body>.
    if (document.activeElement !== returnFocus) {
      const trigger = returnFocus.closest('.menu-host')?.querySelector<HTMLElement>('.menu-trigger');
      (trigger ?? document.getElementById('menu-button'))?.focus();
    }
  };
  const buildModal = (title: string, body: HTMLElement | string): void => {
    closeModal();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalReturnFocus = active?.closest('.menu-host')?.querySelector<HTMLElement>('.menu-trigger') ?? active;
    const overlay = document.createElement('div');
    overlay.id = 'oxr-modal-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(20,26,28,0.42);z-index:10001;display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'oxr-modal-title');
    card.setAttribute('aria-describedby', 'oxr-modal-body');
    card.tabIndex = -1;
    card.style.cssText =
      'background:var(--oxr-color-bg-card);color:var(--oxr-color-text);padding:22px 26px;border-radius:var(--oxr-radius-lg);border:1px solid var(--oxr-color-stroke-strong);box-shadow:var(--oxr-shadow-modal);width:min(470px,88vw);max-height:82vh;overflow:auto;';
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
  surfaces.defer(closeModal);
  surfaces.listen(document, 'keydown', (e) => {
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
  surfaces.bind(workspace, 'onShowModal', ({ title, bodyHtml }) => buildModal(title, bodyHtml));

  // Searchable help: topics, per-error troubleshooting, and the action catalog
  // in one index, because someone typing "wipe tower" does not know whether
  // their answer is a concept, an error, or a button.
  surfaces.bind(workspace, 'onShowHelpSearch', () => {
    const body = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = 'help-search-input';
    label.textContent = t('app.main.searchHelp', 'Search help');
    label.style.cssText = 'display:block;margin-bottom:4px;color:var(--oxr-color-text-muted);';
    const input = document.createElement('input');
    input.id = 'help-search-input';
    input.type = 'search';
    input.className = 'text-input';
    input.placeholder = t('app.main.wipeTowerCorsPaintingToken', 'wipe tower, cors, painting, token…');
    input.dataset.helpSearch = 'true';
    input.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:10px;';

    const results = document.createElement('div');
    results.dataset.helpResults = 'true';
    // A live region, so a screen reader hears the count change as they type.
    results.setAttribute('role', 'region');
    results.setAttribute('aria-live', 'polite');
    results.setAttribute('aria-label', t('app.main.helpResults', 'Help results'));

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
        kind.style.cssText = 'margin-inline-start:6px;font-size:11px;opacity:.7;font-weight:400;';
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
  });

  // ---- Language (P10.4) ------------------------------------------------
  //
  // The picker lives with the other modals because it is one; the localizer
  // itself is owned by the entry point, which is why it arrives as a getter —
  // `setupDomUI` runs before it exists.
  surfaces.bind(workspace, 'onShowLanguagePicker', () => {
    const body = document.createElement('div');
    const intro = document.createElement('p');
    intro.textContent = t(
      'app.main.orcaXRIsTranslatedFromThe',
      'OrcaXR is translated from the pinned Snapmaker OrcaSlicer catalogues.',
    );
    intro.style.cssText = 'margin:0 0 8px;color:var(--oxr-color-text-muted);';
    const list = document.createElement('div');
    list.style.cssText = 'display:grid;gap:4px;max-height:52vh;overflow:auto;';
    const showPseudo = new URLSearchParams(location.search).has('pseudo');
    for (const locale of selectableLocales(showPseudo)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'oxr-btn';
      button.style.cssText = 'justify-content:space-between;width:100%;';
      button.setAttribute('lang', locale.id);
      button.setAttribute('aria-pressed', String(locale.id === l10n().locale));
      // The endonym leads: a picker that offers "German" to someone who reads
      // only German is a list they cannot use. The English name follows for an
      // operator picking a language they cannot yet read.
      const name = document.createElement('span');
      name.textContent = locale.endonym;
      const english = document.createElement('span');
      english.textContent = locale.englishName;
      english.style.cssText = 'color:var(--oxr-color-text-muted);margin-inline-start:12px;';
      english.setAttribute('lang', 'en');
      button.append(name, english);
      button.onclick = () => {
        void (async () => {
          const applied = await l10n().setLocale(locale.id);
          if (!applied) {
            workspace.setStatus(`Could not load ${locale.englishName}; OrcaXR is still in ${l10n().locale}.`);
            return;
          }
          try {
            localStorage.setItem(LANGUAGE_KEY, locale.id);
          } catch {
            // Private mode: the language still applies for this session.
          }
          workspace.setStatus(`Language: ${locale.endonym}.`);
          closeModal();
        })();
      };
      list.appendChild(button);
    }
    body.append(intro, list);
    buildModal('Language', body);
  });

  // Interactive setup wizard: reuse the live profile catalogue.
  surfaces.bind(workspace, 'onShowSetupWizard', () => {
    const opts = workspace.getProfileOptions();
    const body = document.createElement('div');
    const intro = document.createElement('p');
    intro.textContent = t(
      'app.main.pickYourPrinterPrintProcess',
      'Pick your printer, print process and filament to get started.',
    );
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
    apply.textContent = t('app.main.applyClose', 'Apply & Close');
    apply.setAttribute('data-testid', 'wizard-apply');
    apply.style.cssText =
      'margin-top:14px;width:100%;padding:10px;border:none;border-radius:var(--oxr-radius-md);' +
      'background:var(--oxr-grad-accent);color:var(--oxr-on-accent);font-weight:600;font-size:14px;cursor:pointer;';
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
  });

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
  surfaces.own(preflightPanel);
  surfaces.bind(workspace, 'onPreflight', (result) => {
    preflightPanel.render(result);
    uiState.update({ preflightBlocked: !result.canSlice });
  });
  workspace.recomputePreflight();

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
  surfaces.bind(chkWipeTower, 'onchange', () => {
    void registry
      .invoke('auto_place_wipe', 'dom-menu', actionCtx, uiState.get(), {
        wipeTowerAuto: { enabled: chkWipeTower.checked },
      })
      .finally(() => {
        chkWipeTower.checked = workspace.wipeTowerAuto;
      })
      .catch((error) => console.error('[orcaxr] wipe-tower action failed:', error));
  });

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
      opt.textContent = t('app.main.loadingProfiles', 'Loading profiles…');
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
      opt.textContent = t('app.main.noCompatiblePresets', 'No compatible presets');
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
      placeholder.textContent = t('app.main.usingTheProjectSOwn', 'Using the project’s own settings');
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
  surfaces.defer(() => headsPanel.replaceChildren());
  const profileFilamentHint = document.getElementById('profile-filament-hint') as HTMLParagraphElement | null;
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
    // Those pickers live on the Filament tab, so say where they went rather than
    // leaving a multi-head printer looking like it lost its filament control.
    selFilament.style.display = exCount > 1 ? 'none' : 'block';
    if (profileFilamentHint) {
      profileFilamentHint.hidden = exCount <= 1;
      profileFilamentHint.textContent = t(
        'app.main.perHeadFilamentsAreOnThe',
        'This printer has {count} heads — pick each one’s filament on the Filament tab.',
        { count: exCount },
      );
    }

    // Offered whatever the extruder count is. Gating this on exCount > 1 made
    // it unreachable in the case that needs it most: a single-tool project
    // cannot grow to match a four-slot machine if the button that adopts those
    // slots only appears once the project already has several.
    {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'action-btn';
      syncBtn.style.cssText = 'margin-bottom:6px;font-size:12px;';
      syncBtn.textContent = t('app.main.syncFilamentsFromPrinter', 'Sync Filaments From Printer');
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
          'width:22px;height:22px;flex:0 0 22px;padding:0;border:1px solid var(--oxr-stroke);' +
          'border-radius:var(--radius-sm);background:none;cursor:pointer;';
        colorInput.setAttribute(
          'aria-label',
          isAuxiliaryPaletteSlot
            ? t('app.main.paletteColour', 'Palette colour {index}', { index: i + 1 })
            : t('app.main.headColour', 'Head {index} colour', { index: i + 1 }),
        );
        colorInput.onchange = () => {
          workspace.palette.setColor(i, colorInput.value);
          workspace.rebuildHeadsPanel();
        };
        row.appendChild(colorInput);

        const lbl = document.createElement('span');
        lbl.textContent = isAuxiliaryPaletteSlot ? `A-${i + 1}:` : `H-${i + 1}:`;
        lbl.style.cssText =
          'color:var(--oxr-text-muted);flex:0 0 auto;font-size:11px;font-weight:600;white-space:nowrap;';
        row.appendChild(lbl);

        const fSel = document.createElement('select');
        fSel.className = 'action-btn';
        fSel.style.cssText = 'flex-grow:1;margin:0;padding:6px;font-size:12px;';
        fSel.setAttribute('aria-describedby', profileStatus.id);
        fSel.setAttribute(
          'aria-label',
          isAuxiliaryPaletteSlot
            ? t('app.main.paletteFilament', 'Palette filament {index}', { index: i + 1 })
            : t('app.main.headFilament', 'Head {index} filament', { index: i + 1 }),
        );
        fillPresetSelect(fSel, o.filamentOptions, workspace.getHeadFilamentPresetId(i));
        fSel.onchange = () => {
          workspace.setHeadFilamentPreset(i, fSel.value as WorkspacePresetOption['id']);
        };
        row.appendChild(fSel);

        if (!isAuxiliaryPaletteSlot) {
          const nSel = document.createElement('select');
          nSel.className = 'action-btn';
          nSel.style.cssText = 'width:60px;margin:0;padding:6px;font-size:12px;';
          nSel.setAttribute('aria-label', t('app.main.headNozzle', 'Head {index} nozzle', { index: i + 1 }));
          fillSelect(nSel, ['0.2', '0.4', '0.6', '0.8'], workspace.getHeadNozzle(i));
          nSel.onchange = () => {
            workspace.setHeadNozzle(i, nSel.value);
          };
          row.appendChild(nSel);
        } else {
          const delBtn = document.createElement('button');
          delBtn.className = 'action-btn';
          delBtn.style.cssText =
            'width:52px;margin:0;padding:4px;font-size:11px;color:var(--oxr-danger);border-color:var(--oxr-stroke);';
          delBtn.textContent = t('app.main.del', 'Del');
          delBtn.setAttribute(
            'aria-label',
            t('app.main.removePaletteSlot', 'Remove palette colour {index}', { index: i + 1 }),
          );
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
      openVirtualLibrary.style.cssText = 'margin-top:4px;font-size:12px;';
      openVirtualLibrary.textContent = t('app.main.openVirtualFilamentLibrary', 'Open virtual filament library');
      openVirtualLibrary.onclick = () => {
        const section = document.getElementById('virtual-filament-library-section') as HTMLDetailsElement | null;
        section?.setAttribute('open', '');
        if (section) revealInSidebar(section);
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
  surfaces.bind(selMachine, 'onchange', () => {
    workspace.selectProfilePresets({
      machinePresetId: selMachine.value as WorkspacePresetOption['id'],
    });
  });
  surfaces.bind(selProcess, 'onchange', () => {
    workspace.selectProfilePresets({
      processPresetId: selProcess.value as WorkspacePresetOption['id'],
    });
  });
  surfaces.bind(selFilament, 'onchange', () => {
    const selected = workspace.getProfileOptions();
    const filamentPresetIds = [...selected.filamentPresetIds];
    filamentPresetIds[0] = selFilament.value as WorkspacePresetOption['id'];
    workspace.selectProfilePresets({ filamentPresetIds });
  });
  surfaces.bind(workspace, 'onProfileChanged', () => {
    for (const listener of profileChangeListeners) listener();
    renderProfileSelects();
    if (pendingPersistedSelection) queuePersistedProfileRestore();
    else persistProfileSelection();
  });
  surfaces.bind(workspace, 'onProfileSelectionResult', (feedback) => {
    renderProfileSelectionStatus(profileStatus, { feedback });
    if (feedback.applied && !pendingPersistedSelection) persistProfileSelection();
  });
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

  surfaces.bind(workspace, 'onRequestPresetLibrary', async (operation: PresetLibraryOperation) => {
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
  });

  if (presetLibraryHost) {
    // Behind a closed <details>: loaded when it is opened, not at first paint.
    void initialization.mount('preset-library', 'Preset library', async (scope) => {
      surfaces.attach(scope);
      const { PresetLibraryPanel } = await scope.import(import('./ui/dom/PresetLibraryPanel'));
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
          await scope.load(
            registry.invoke(PRESET_LIBRARY_ACTION_IDS[operation.kind], 'dom-inspector', actionCtx, uiState.get(), {
              presetLibrary: operation,
            }),
          );
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
      scope.own(presetPanel);
      presetPanel.mount();
    });
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
    surfaces.bind(autoPairCheckbox, 'onchange', async () => {
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
    });
    if (autoPairConfirmButton) {
      surfaces.bind(autoPairConfirmButton, 'onclick', async () => {
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
      });
    }
    const unsubscribeAutoPairStatus = workspace.subscribeCanonicalState(() => renderAutoPairStatus());
    surfaces.defer(unsubscribeAutoPairStatus);
  }

  const recreateColorsButton = document.getElementById('btn-recreate-model-colors') as HTMLButtonElement | null;
  if (recreateColorsButton) {
    surfaces.bind(recreateColorsButton, 'onclick', async () => {
      try {
        await registry.invoke('recreate_model_colors_fullspectrum', 'dom-inspector', actionCtx, uiState.get(), {
          recreateModelColors: { allowNewFullSpectrumRecipes: true },
        });
      } catch (error) {
        console.error('Failed to recreate model colors:', error);
      }
    });
  }

  const virtualFilamentHost = document.getElementById('virtual-filament-library-host');
  if (virtualFilamentHost) {
    const colorMatchSearch = surfaces.own(new ColorMatchSearchWorkerClient());
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
    surfaces.own(virtualFilamentLibrary);
    virtualFilamentLibrary.mount();
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
      // The same catalog the scene's right-click renders, so an object offers
      // the same operations wherever a person happens to right-click it.
      listContextActions: (target) =>
        contextMenuGroups(registry, target, uiState.get(), (action) => {
          void registry.invoke(action.id, 'dom-context', actionCtx, uiState.get());
        }),
      onError: (error) => {
        statusText.textContent = `Objects panel: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    surfaces.own(objectsPanel);
    objectsPanel.mount();
  }

  // The workspace opens the toolpath preview on its own — after a slice, and
  // when a standalone G-code file is opened — not only through the toggle
  // action. The stage bar, the inspector tabs and the layer scrubber all render
  // from `mode`, so follow the workspace instead of just the toggle, or the
  // header would still read "Prepare" over a visible toolpath. Assigned before
  // the preview panel mounts so its own subscription chains onto this one.
  // Loading and empty/unsupported windows still own a preview session: its
  // controls must stay reachable until the operator closes it.
  const syncPreviewMode = () => {
    const preview = workspace.getPreviewState();
    uiState.update({
      mode: preview.loading || preview.view ? 'preview' : 'prepare',
    });
  };
  surfaces.bind(workspace, 'onPreviewStateChanged', syncPreviewMode);
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
      surfaces.own(previewPanel);
      previewPanel.mount();
    }
    if (previewScrubberHost) {
      const scrubber = new PreviewScrubber(previewScrubberHost, previewAdapter, uiState);
      surfaces.own(scrubber);
      scrubber.mount();
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
    surfaces.own(paintPanel);
    paintPanel.mount();
  }

  const smartPaintPanelHost = document.getElementById('smart-paint-panel-host');
  if (smartPaintPanelHost) {
    // Tool-gated, like the other paint and gizmo panels.
    void initialization.mount('smart-paint-panel', 'Smart Paint controls', async (scope) => {
      surfaces.attach(scope);
      const { SmartPaintPanel } = await scope.import(import('./ui/dom/SmartPaintPanel'));
      const configure = async (request: NonNullable<ActionInvocation['smartPaint']>): Promise<void> => {
        const invoked = await scope.load(
          registry.invoke('paint_smart_configure', 'dom-inspector', actionCtx, uiState.get(), {
            smartPaint: request,
          }),
        );
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
          const invoked = await scope.load(
            registry.invoke('paint_smart_request', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Select a model part before asking the Smart Paint assistant.');
        },
        onApply: async () => {
          const invoked = await scope.load(
            registry.invoke('paint_smart_apply', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Applying the Smart Paint mask is unavailable.');
        },
        onCancel: async () => {
          const invoked = await scope.load(
            registry.invoke('paint_smart_cancel', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Discarding the Smart Paint mask is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `Smart Paint: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(smartPaintPanel);
      smartPaintPanel.mount();
    });
  }

  const measurePanelHost = document.getElementById('measure-panel-host');
  if (measurePanelHost) {
    // Tool-gated, like the emboss and SVG panels beside it.
    void initialization.mount('measure-panel', 'Measurement controls', async (scope) => {
      surfaces.attach(scope);
      const { MeasurePanel } = await scope.import(import('./ui/dom/MeasurePanel'));
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
          const invoked = await scope.load(registry.invoke('tool_measure', 'dom-toolbar', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Add a model before measuring it.');
        },
        onClear: async () => {
          const invoked = await scope.load(registry.invoke('measure_clear', 'dom-inspector', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Clearing the measurement is unavailable.');
        },
        onAlign: async (kind, parameter) => {
          const invoked = await scope.load(
            registry.invoke('assembly_align', 'dom-inspector', actionCtx, uiState.get(), {
              assemblyAlignment: {
                kind: kind as NonNullable<ActionInvocation['assemblyAlignment']>['kind'],
                ...(parameter !== undefined ? { parameter } : {}),
              },
            }),
          );
          if (!invoked) throw new Error('Assembly alignment is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `Measure: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(measurePanel);
      measurePanel.mount();
    });
  }

  const gcodePanelHost = document.getElementById('gcode-panel-host');
  if (gcodePanelHost) {
    // Inspector-gated and only useful after a slice, so it is fetched then.
    void initialization.mount('gcode-panel', 'G-code inspector', async (scope) => {
      surfaces.attach(scope);
      const [{ GcodePanel }, { GcodeDocument }] = await scope.import(
        Promise.all([import('./ui/dom/GcodePanel'), import('./project/gcode/GcodeDocument')]),
      );
      // Rebuilt only when the program itself changes: indexing is cheap but a
      // fresh document on every canonical tick would drop the operator's
      // scroll position and search while they were reading.
      let lastGcode: string | null = null;
      let document_: InstanceType<typeof GcodeDocument> | null = null;
      const panel = new GcodePanel(gcodePanelHost, {
        getState: () => {
          const gcode = workspace.getLastGcode();
          if (gcode !== lastGcode) {
            lastGcode = gcode;
            document_ = gcode === null ? null : new GcodeDocument(gcode);
          }
          return { document: document_, title: 'Sliced G-code' };
        },
        // Both signals, because they are genuinely different things and the
        // panel needs each. Canonical state changes when the project does;
        // `gcodeReady` changes when a slice produces or invalidates a program,
        // which is the only event that makes a listing appear or go stale.
        // Subscribing to the canonical one alone left the window permanently
        // empty — caught by the browser check rather than by the unit traces,
        // which supply their own document.
        subscribe: (listener) => {
          const stopCanonical = workspace.subscribeCanonicalState(listener);
          const stopUi = uiState.subscribe(listener);
          return () => {
            stopCanonical();
            stopUi();
          };
        },
        onError: (error) => {
          statusText.textContent = `G-code: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(panel);
      panel.mount();
    });
  }

  const calibrationParametersHost = document.getElementById('calibration-parameters-host');
  if (calibrationParametersHost) {
    void initialization.mount('calibration-parameters', 'Calibration controls', async (scope) => {
      surfaces.attach(scope);
      const featureSurface = scope.own(new SurfaceLifecycle());
      const [{ CalibrationParametersPanel }, form, docs, inventory] = await scope.import(
        Promise.all([
          import('./ui/dom/CalibrationParametersPanel'),
          import('./project/calibration/form'),
          import('./project/calibration/docs'),
          import('./features/calibrationInventory'),
        ]),
      );
      const listeners = new Set<() => void>();
      const announce = (): void => {
        for (const listener of listeners) listener();
      };
      featureSurface.bind(workspace, 'onCalibrationParametersChanged', announce);

      const chooser = document.createElement('label');
      chooser.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:0.75;';
      chooser.textContent = 'Calibration';
      const select = document.createElement('select');
      select.dataset.calibrationWorkflow = 'true';
      for (const id of inventory.CALIBRATION_WORKFLOW_IDS) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        select.appendChild(option);
      }
      featureSurface.listen(select, 'change', () => {
        void registry.invoke('calib_choose', 'dom-inspector', actionCtx, uiState.get(), {
          calibrationWorkflowId: select.value,
        });
      });
      chooser.appendChild(select);
      const panelHost = document.createElement('div');
      scope.defer(() => calibrationParametersHost.replaceChildren());
      calibrationParametersHost.replaceChildren(chooser, panelHost);

      const panel = new CalibrationParametersPanel(panelHost, {
        getState: () => {
          // The workspace holds the id as a plain string so it need not import
          // the catalog; this surface already has the catalog loaded, so it is
          // the right place to narrow, and an id the catalog does not know is
          // reported by `buildCalibrationForm` rather than assumed away.
          const workflow = workspace.getCalibrationWorkflowId() as (typeof inventory.CALIBRATION_WORKFLOW_IDS)[number];
          select.value = workflow;
          const preview = form.buildCalibrationForm(
            workflow,
            workspace.calibrationPrerequisites(),
            workspace.getCalibrationEdits(),
            'calibration:preview',
          );
          // The XR surface renders steppers from the same fields this panel
          // renders inputs from — one form, two shells, so they cannot show
          // different values for the same parameter.
          workspace.setCalibrationFormPreview(preview);
          return {
            workflowLabel: workflow,
            preview,
            docHref: docs.calibrationDocHref(workflow),
            ...(preview.plan ? { planSummary: form.describeCalibrationPlan(preview.plan) } : {}),
            // Withheld, not broken: the compiler produces a plan, but building
            // one into the canonical project graph is still P8.2 work. Saying
            // so beats a control that looks ready and would produce something
            // other than what the preview describes.
            generateUnavailableReason:
              'Building a compiled plan into the project is still P8.2 work; the menu entries add the existing alpha geometry.',
          };
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onEdit: async (key, text) => {
          const invoked = await scope.load(
            registry.invoke('calib_configure', 'dom-inspector', actionCtx, uiState.get(), {
              calibrationParameter: { key, text },
            }),
          );
          if (!invoked) throw new Error('Setting a calibration parameter is unavailable.');
        },
        onReset: async () => {
          await scope.load(registry.invoke('calib_reset_parameters', 'dom-inspector', actionCtx, uiState.get()));
        },
        onGenerate: () => {
          throw new Error('Building a compiled calibration plan into the project is not available yet (P8.2).');
        },
        onError: (error) => {
          statusText.textContent = `Calibration: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(panel);
      panel.mount();
    });
  }

  const calibrationSessionHost = document.getElementById('calibration-session-host');
  if (calibrationSessionHost) {
    // In the viewport, so it is seen; loaded on demand, because it is empty
    // until someone starts a calibration.
    void initialization.mount('calibration-session', 'Calibration session', async (scope) => {
      surfaces.attach(scope);
      const { CalibrationSessionBar } = await scope.import(import('./ui/dom/CalibrationSessionBar'));
      const bar = new CalibrationSessionBar(calibrationSessionHost, {
        getState: () => {
          const ui = uiState.get();
          return {
            open: workspace.calibrationSessionOpen,
            sliced: ui.gcodeReady,
            ...(ui.printerJobState === 'disconnected'
              ? { sendUnavailableReason: 'No printer is connected, so there is nowhere to send it.' }
              : {}),
          };
        },
        subscribe: (listener) => {
          const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
          const previous = workspace.onCalibrationSessionChanged;
          workspace.onCalibrationSessionChanged = () => {
            previous?.();
            listener();
          };
          return () => {
            unsubscribeCanonical();
            workspace.onCalibrationSessionChanged = previous;
          };
        },
        onDiscard: async () => {
          const invoked = await scope.load(
            registry.invoke('calib_session_discard', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('There is no calibration to discard.');
        },
        onKeep: async () => {
          const invoked = await scope.load(
            registry.invoke('calib_session_keep', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('There is no calibration to keep.');
        },
        // Routed through the same registry actions the toolbar uses: the
        // calibration is an ordinary project while its session is open, so
        // slicing and sending it must not take a second code path that could
        // drift from the one everything else is tested against.
        onSlice: async () => {
          const invoked = await scope.load(
            registry.invoke('slice_active_plate', 'dom-toolbar', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Slicing the calibration is unavailable.');
        },
        onExport: async () => {
          const invoked = await scope.load(
            registry.invoke('save_gcode_to_downloads', 'dom-toolbar', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Saving the calibration G-code is unavailable.');
        },
        onSend: async () => {
          const invoked = await scope.load(registry.invoke('send_to_printer', 'dom-toolbar', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Sending the calibration is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `Calibration: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(bar);
      bar.mount();
    });
  }

  const simplifyPanelHost = document.getElementById('simplify-panel-host');
  if (simplifyPanelHost) {
    // Disclosure-gated, so it is fetched when the inspector wants it rather
    // than carried in the main chunk everyone pays for at first paint.
    void initialization.mount('simplify-panel', 'Simplify controls', async (scope) => {
      surfaces.attach(scope);
      let requested = { useCount: true, decimateRatio: 50, maxError: 1 };
      const { SimplifyPanel } = await scope.import(import('./ui/dom/SimplifyPanel'));
      const simplifyPanel = new SimplifyPanel(simplifyPanelHost, {
        getState: () => {
          const snapshot = workspace.getSimplifySnapshot();
          return {
            hasSelection: uiState.get().hasSelection,
            previewing: snapshot.previewing,
            useCount: snapshot.configuration?.useCount ?? requested.useCount,
            decimateRatio: snapshot.configuration?.decimateRatio ?? requested.decimateRatio,
            maxError: snapshot.configuration?.maxError ?? requested.maxError,
            parts: snapshot.parts,
            beforeTriangles: snapshot.beforeTriangles,
            afterTriangles: snapshot.afterTriangles,
            stoppedOnError: snapshot.stoppedOnError,
          };
        },
        subscribe: (listener) => {
          const unsubscribeCanonical = workspace.subscribeCanonicalState(listener);
          const previous = workspace.onSimplifyStateChanged;
          workspace.onSimplifyStateChanged = () => {
            previous?.();
            listener();
          };
          return () => {
            unsubscribeCanonical();
            workspace.onSimplifyStateChanged = previous;
          };
        },
        onPreview: async (configuration) => {
          requested = { ...configuration };
          const invoked = await scope.load(
            registry.invoke('simplify_preview', 'dom-inspector', actionCtx, uiState.get(), {
              simplifyByError: !configuration.useCount,
              simplifyRatio: configuration.decimateRatio,
              simplifyMaxError: configuration.maxError,
            }),
          );
          if (!invoked) throw new Error('Select a model before previewing a simplify.');
        },
        onApply: async () => {
          const invoked = await scope.load(
            registry.invoke('simplify_apply', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('There is no simplify preview to apply.');
        },
        onCancel: async () => {
          const invoked = await scope.load(
            registry.invoke('simplify_cancel', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('There is no simplify preview to cancel.');
        },
        onError: (error) => {
          statusText.textContent = `Simplify: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(simplifyPanel);
      simplifyPanel.mount();
    });
  }

  const brimEarsPanelHost = document.getElementById('brim-ears-panel-host');
  if (brimEarsPanelHost) {
    // Disclosure-gated like the simplify panel beside it, and fetched the same
    // way: the ear controls are a tool an operator opens, not first paint.
    void initialization.mount('brim-ears-panel', 'Brim controls', async (scope) => {
      surfaces.attach(scope);
      const { BrimEarsPanel } = await scope.import(import('./ui/dom/BrimEarsPanel'));
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
            stranded: snapshot.stranded,
            hint: snapshot.hint,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
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
          const invoked = await scope.load(registry.invoke('tool_brim_ears', 'dom-toolbar', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Select a model part before placing brim ears.');
        },
        onSetRadius: async (radiusMm) => {
          const invoked = await scope.load(
            registry.invoke('brim_ears_configure', 'dom-inspector', actionCtx, uiState.get(), {
              brimEarRadiusMm: radiusMm,
            }),
          );
          if (!invoked) throw new Error('Setting the brim-ear radius is unavailable.');
        },
        onRemove: async (index) => {
          const invoked = await scope.load(
            registry.invoke('brim_ears_remove', 'dom-inspector', actionCtx, uiState.get(), {
              brimEarIndex: index,
            }),
          );
          if (!invoked) throw new Error('Removing a brim ear is unavailable.');
        },
        onAutoPlace: async () => {
          const invoked = await scope.load(
            registry.invoke('brim_ears_auto', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Automatic brim-ear placement is unavailable.');
        },
        onClear: async () => {
          const invoked = await scope.load(
            registry.invoke('brim_ears_clear', 'dom-inspector', actionCtx, uiState.get()),
          );
          if (!invoked) throw new Error('Clearing brim ears is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `Brim ears: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(brimEarsPanel);
      brimEarsPanel.mount();
    });
  }

  const embossPanelHost = document.getElementById('emboss-panel-host');
  if (embossPanelHost) {
    // Disclosure-gated and font-heavy: fetched when the emboss tool wants it.
    void initialization.mount('emboss-panel', 'Emboss controls', async (scope) => {
      surfaces.attach(scope);
      const { EmbossPanel } = await scope.import(import('./ui/dom/EmbossPanel'));
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
          const invoked = await scope.load(registry.invoke('add_emboss', 'dom-toolbar', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Load a model before embossing text onto it.');
        },
        onLoadFont: async (name, bytes) => {
          const invoked = await scope.load(
            registry.invoke('emboss_load_font', 'dom-inspector', actionCtx, uiState.get(), {
              emboss: { font: { name, bytes } },
            }),
          );
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
          const invoked = await scope.load(
            registry.invoke('emboss_configure', 'dom-inspector', actionCtx, uiState.get(), {
              emboss: { recipe },
            }),
          );
          if (!invoked) throw new Error('Changing the emboss recipe is unavailable.');
        },
        onApply: async () => {
          const invoked = await scope.load(registry.invoke('emboss_apply', 'dom-inspector', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Adding embossed text is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `Emboss: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(embossPanel);
      embossPanel.mount();
    });
  }

  const svgPanelHost = document.getElementById('svg-panel-host');
  if (svgPanelHost) {
    // Tool-gated like emboss beside it, and fetched the same way.
    void initialization.mount('svg-panel', 'SVG controls', async (scope) => {
      surfaces.attach(scope);
      const { SvgPanel } = await scope.import(import('./ui/dom/SvgPanel'));
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
          const invoked = await scope.load(registry.invoke('tool_svg', 'dom-toolbar', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Load a model before cutting an SVG part.');
        },
        onLoadDrawing: async (name, source) => {
          const invoked = await scope.load(
            registry.invoke('svg_load_drawing', 'dom-inspector', actionCtx, uiState.get(), {
              svg: { drawing: { name, source } },
            }),
          );
          if (!invoked) throw new Error('Loading an SVG drawing is unavailable.');
        },
        onConfigure: async (patch) => {
          const invoked = await scope.load(
            registry.invoke('svg_configure', 'dom-inspector', actionCtx, uiState.get(), {
              svg: { size: patch },
            }),
          );
          if (!invoked) throw new Error('Changing the SVG part size is unavailable.');
        },
        onApply: async () => {
          const invoked = await scope.load(registry.invoke('svg_apply', 'dom-inspector', actionCtx, uiState.get()));
          if (!invoked) throw new Error('Adding an SVG part is unavailable.');
        },
        onError: (error) => {
          statusText.textContent = `SVG part: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(svgPanel);
      svgPanel.mount();
    });
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
    surfaces.own(semanticEditor);
    semanticEditor.mount();
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
    surfaces.own(selector);
    selector.mount();
  }

  // The same canonical action as the inspector selector, one press away from a
  // model the operator just clicked in the viewport.
  const selectionFilamentHost = document.getElementById('selection-filament-host');
  if (selectionFilamentHost) {
    const bar = new SelectionFilamentBar(selectionFilamentHost, {
      getSnapshot: () => workspace.getFilamentAssignmentSnapshot(),
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      onApply: async (request) => {
        const invoked = await registry.invoke('objects_assign_filament', 'dom-inspector', actionCtx, uiState.get(), {
          objectsFilamentAssignment: request,
        });
        if (!invoked) throw new Error('Filament assignment is unavailable in the current workspace state.');
      },
      onError: (error) => {
        statusText.textContent = t('app.main.filamentAssignmentFailed', 'Filament assignment: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    });
    surfaces.own(bar);
    bar.mount();
  }

  const layerEventHost = document.getElementById('layer-event-host');
  if (layerEventHost) {
    // Inspector-gated: authored layer events are a tool, not first paint.
    void initialization.mount('layer-events', 'Layer events', async (scope) => {
      surfaces.attach(scope);
      const { LayerEventPanel } = await scope.import(import('./ui/dom/LayerEventPanel'));
      const layerEvents = new LayerEventPanel(layerEventHost, {
        getSnapshot: () => workspace.getLayerEventSnapshot(),
        getCapabilities: () => workspace.getLayerEventCapabilities(),
        subscribe: (listener) => workspace.subscribeCanonicalState(listener),
        onMutate: async (request) => {
          const invoked = await scope.load(
            registry.invoke('layer_event_mutate', 'dom-inspector', actionCtx, uiState.get(), {
              layerEventMutation: request,
            }),
          );
          if (!invoked) throw new Error('Layer-event authoring is unavailable in the current workspace state.');
        },
        onError: (error) => {
          statusText.textContent = `Layer event: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
      scope.own(layerEvents);
      layerEvents.mount();
    });
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
    surfaces.own(plateManager);
    plateManager.mount();
  }

  // The Project page leads with the project itself, as upstream's does: what is
  // on the bed, whether it is saved, and what was open before. Opening and
  // saving are registry actions — this panel only reads.
  const projectSummaryHost = document.getElementById('project-summary-host');
  if (projectSummaryHost) {
    const projectSummary = new ProjectSummaryPanel(projectSummaryHost, {
      read: () => {
        const summary = workspace.getCanonicalSummary();
        const active = summary.plates.find((plate) => plate.id === summary.activePlateId);
        return {
          modelCount: active?.instanceCount ?? 0,
          plateCount: summary.plates.length,
          dirty: summary.dirty,
          recent: workspace.listRecentProjects(),
        };
      },
      subscribe: (listener) => workspace.subscribeCanonicalState(listener),
      openProject: () => {
        void registry
          .invoke('file_open_project', 'dom-inspector', actionCtx, uiState.get())
          .catch((error) => console.error('[orcaxr] open-project action failed:', error));
      },
      saveProject: () => {
        void registry
          .invoke('file_save_project', 'dom-inspector', actionCtx, uiState.get())
          .catch((error) => console.error('[orcaxr] save-project action failed:', error));
      },
    });
    surfaces.own(projectSummary);
    projectSummary.mount();
  }

  void initialization.registry.run('settings', async (scope) => {
    surfaces.attach(scope);
    const { mountSettingsEditors } = await scope.import(import('./ui/dom/mountSettingsEditors'));
    const settingsHost = document.getElementById('settings-inspector-host');
    if (!settingsHost) throw new Error('The settings surface is missing. Reload the application.');
    await mountSettingsEditors({ workspace, registry, actionCtx, uiState, settingsHost, statusText }, scope);
  });
  const wavePanelHost = document.getElementById('wave-overhangs-panel-host');
  if (wavePanelHost)
    void initialization.mount('wave-overhangs', 'Wave overhang controls', async (scope) => {
      surfaces.attach(scope);
      const { mountWaveOverhangsPanel } = await scope.import(import('./ui/dom/WaveOverhangsPanel'));
      scope.defer(
        mountWaveOverhangsPanel({
          container: wavePanelHost,
          workspace,
          registry,
          actionCtx,
          getUiState: () => uiState.get(),
          onErrorMessage: (msg) => {
            statusText.textContent = msg;
          },
        }),
      );
    });

  // Filament palette: color swatches that drive paint + 3MF display + slice.
  const swatchWrap = document.getElementById('filament-swatches') as HTMLDivElement;
  surfaces.defer(() => swatchWrap.replaceChildren());
  const btnAddFilament = document.getElementById('btn-add-filament') as HTMLButtonElement;
  btnAddFilament.title = t(
    'app.main.addAnAuxiliaryPaletteColor',
    'Add an auxiliary palette color (not a virtual recipe)',
  );
  btnAddFilament.setAttribute('aria-label', btnAddFilament.title);
  const renderPalette = () => {
    swatchWrap.innerHTML = '';
    // Each head's own colour is edited on its row in the Filaments card above;
    // repeating those swatches here only invited two controls for one value.
    // What is left is what has no row of its own: the auxiliary palette slots.
    const auxiliaryFrom = workspace.extruderCount;
    workspace.palette.list().forEach((slot, i) => {
      if (i < auxiliaryFrom) return;
      const cell = document.createElement('div');
      cell.style.cssText = 'position:relative;';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = slot.color.length === 7 ? slot.color : '#cccccc';
      input.title = `Filament ${i + 1} (${slot.type})`;
      input.style.cssText =
        'width:36px;height:36px;border:2px solid var(--oxr-stroke-strong);border-radius:6px;padding:0;background:none;cursor:pointer;';
      input.oninput = () => workspace.palette.setColor(i, input.value);
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = t('app.main.removeFilament', 'Remove filament');
      del.style.cssText =
        'position:absolute;top:-6px;inset-inline-end:-6px;width:16px;height:16px;line-height:14px;' +
        'border-radius:50%;border:none;background:var(--oxr-surface);color:var(--oxr-text);font-size:11px;cursor:pointer;';
      del.onclick = () => workspace.removeAuxiliaryFilamentSlot(i);
      cell.appendChild(input);
      cell.appendChild(del);
      swatchWrap.appendChild(cell);
    });
    // A heading over nothing is noise; the "+" that creates the first one lives
    // on the heading, so the section returns as soon as one exists.
    const auxiliaryCount = Math.max(0, workspace.palette.count() - auxiliaryFrom);
    swatchWrap.hidden = auxiliaryCount === 0;

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
        `width:24px;height:24px;border-radius:5px;border:1px solid var(--oxr-stroke-strong);` +
        `background:${vf.color};position:relative;`;
      const idTag = document.createElement('span');
      idTag.textContent = String(vf.id);
      idTag.style.cssText =
        'position:absolute;bottom:-4px;inset-inline-end:-4px;background:var(--oxr-bg-sunken);color:var(--oxr-text-muted);' +
        'font-size:8px;line-height:1;padding:1px 2px;border-radius:3px;';
      chip.appendChild(idTag);
      vWrap.appendChild(chip);
    }
  };
  surfaces.bind(btnAddFilament, 'onclick', () => workspace.addFilamentSlot());
  // A palette change (e.g. adopted from a loaded 3MF) must also refresh the
  // heads panel — its per-head color swatches read the same palette.
  surfaces.bind(workspace, 'onPaletteChanged', () => {
    renderPalette();
    renderProfileSelects();
  });
  renderPalette();

  // Printer endpoint and session credential setup. Live operations are
  // read-only until the complete P9 mapping/preflight/send lifecycle exists.
  printerHost.value = printerCfg.host;
  surfaces.bind(printerHost, 'oninput', () => {
    printerCfg.host = printerHost.value.trim();
    savePrinterEndpointPreferences(printerCfg);
    refreshFirstRunPrompt();
    disposePrinterTransport();
  });

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
  printers = adoptLegacyEndpoint(printers, printerCfg.host.trim() ? printerCfg : undefined, () => randomPrinterId());
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
      option.textContent = t('app.main.noPrinterSavedYet', 'No printer saved yet');
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

  surfaces.bind(printerSelect, 'onchange', () => activatePrinter(printerSelect.value));

  surfaces.bind(btnPrinterAdd, 'onclick', () => {
    const host = printerHost.value.trim();
    if (!host) {
      statusText.textContent = t(
        'app.main.enterThePrinterAddressFirst',
        'Enter the printer address first, then Add names it.',
      );
      printerHost.focus();
      return;
    }
    const name = window.prompt(
      t('app.main.nameThisPrinter', 'Name this printer'),
      `Printer ${printers.printers.length + 1}`,
    );
    if (name === null) return;
    try {
      printers = addPrinter(printers, { name, host, port: printerCfg.port }, () => randomPrinterId());
      savePrinterDirectory(printers, printerStorage);
      activatePrinter(printers.printers[printers.printers.length - 1].id);
      statusText.textContent = `Saved ${name.trim()}. Switch between printers with the list above.`;
    } catch (error) {
      statusText.textContent = `Could not add that printer: ${(error as Error).message}`;
    }
  });

  surfaces.bind(btnPrinterRemove, 'onclick', () => {
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
  });

  surfaces.bind(printerApiKey, 'oninput', () => {
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
  });
  surfaces.bind(rememberCredentials, 'onchange', () => {
    persistCredentials();
    statusText.textContent = rememberCredentials.checked
      ? 'Credentials will be remembered on this device.'
      : 'Stopped remembering credentials; the saved copies were erased.';
  });
  // Diagnostics: a bounded, redacted record of this session. Secrets are
  // registered so they are struck from every entry as it is recorded, not on
  // the way out.
  const diagnostics = new DiagnosticsRecorder();
  surfaces.listen(window, 'error', (event) => diagnostics.recordError('window', event.error ?? event.message));
  surfaces.listen(window, 'unhandledrejection', (event) => diagnostics.recordError('promise', event.reason));

  // Diagnostics: the operator reads exactly what would be sent, then decides.
  surfaces.bind(workspace, 'onRequestDiagnosticsExport', async () => {
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
      statusText.textContent = t(
        'app.main.diagnosticsExportCancelledNothingWas',
        'Diagnostics export cancelled; nothing was written.',
      );
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
  });

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
  surfaces.bind(prefReduceMotion, 'onchange', () => {
    preferences = { ...preferences, reduceMotion: prefReduceMotion.checked ? 'always' : 'system' };
    savePreferences(preferences);
    applyPreferences(preferences, document.documentElement);
  });

  surfaces.bind(btnPrefsExport, 'onclick', () => {
    const blob = new Blob([JSON.stringify(exportPreferences(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orcaxr-settings.json';
    link.click();
    URL.revokeObjectURL(url);
    statusText.textContent = t(
      'app.main.exportedThisDeviceSSettings',
      'Exported this device’s settings. The file carries no tokens.',
    );
  });

  surfaces.bind(btnPrefsImport, 'onclick', () => prefsImportFile.click());
  surfaces.bind(prefsImportFile, 'onchange', async () => {
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
  });

  surfaces.bind(btnPrefsReset, 'onclick', () => {
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
    statusText.textContent = t(
      'app.main.resetThisDeviceSSettings',
      'Reset this device’s settings. Your projects and presets are untouched.',
    );
  });

  surfaces.bind(btnForgetCredentials, 'onclick', () => {
    forgetRememberedCredentials();
    printerApiKey.value = '';
    const tokenField = document.getElementById('external-slicer-token') as HTMLInputElement | null;
    if (tokenField) tokenField.value = '';
    SlicerClient.setExternalSlicerToken('', { persist: false });
    remembered = loadRememberedCredentials();
    rememberCredentials.checked = remembered.remember;
    disposePrinterTransport();
    statusText.textContent = t(
      'app.main.forgotTheSavedPrinterKey',
      'Forgot the saved printer key and slicer token on this device.',
    );
  });
  // Loading the settings surface on demand keeps connection UI outside the core
  // workspace bundle. The shared controller remains available to DOM and XR routes.
  void initialization.mount('external-slicer-controls', 'External slicer controls', async (scope) => {
    surfaces.attach(scope);
    const { mountExternalSlicerSettings } = await scope.import(import('./ui/dom/ExternalSlicerSettings'));
    scope.own(
      mountExternalSlicerSettings({
        root: document,
        initialToken: remembered.slicerToken,
        status: (message) => {
          statusText.textContent = message;
        },
        changed: refreshFirstRunPrompt,
        credentialsChanged: persistCredentials,
        reportFailure: (endpoint, error, isCurrent) =>
          reportLocalNetworkFailure(
            endpoint,
            'slicer server',
            "the server's ORCAXR_ALLOWED_ORIGINS",
            error,
            endpoint,
            isCurrent,
          ),
      }),
    );
  });

  surfaces.bind(btnPrinterTest, 'onclick', async () => {
    btnPrinterTest.disabled = true;
    btnPrinterTest.setAttribute('aria-busy', 'true');
    try {
      await registry.invoke('printer_test_connection', 'dom-inspector', actionCtx, uiState.get());
    } finally {
      btnPrinterTest.disabled = false;
      btnPrinterTest.removeAttribute('aria-busy');
    }
  });
  const btnPrinterWebcam = document.getElementById('btn-printer-webcam') as HTMLButtonElement;
  btnPrinterWebcam.disabled = false;
  btnPrinterWebcam.textContent = 'Camera';
  btnPrinterWebcam.title = t('app.main.discoverThisPrinterSCameras', "Discover this printer's cameras and watch one");
  surfaces.bind(btnPrinterWebcam, 'onclick', () => {
    void registry.invoke('view_webcam', 'dom-inspector', actionCtx, uiState.get());
  });
  surfaces.bind(btnPrinterSend, 'onclick', () => {
    if (printWorkflow.busy) {
      printWorkflow.cancel();
      workspace.setStatus(t('app.main.cancellingTheSend', 'Cancelling the send…'));
      return;
    }
    void registry
      .invoke('send_to_printer', 'dom-inspector', actionCtx, uiState.get())
      .catch((error) => workspace.setStatus(`Send failed: ${(error as Error).message}`));
  });
  setPrinterSendBusy(false);

  // Download and send availability are both registry-driven; webcam discovery
  // stays blocked until it is routed through the shared printer connection.
  // Build-plate bar: a chip per plate + an add button. Switching hides the
  // current plate's models and shows the target's (the workspace owns the sets).
  const plateBar = document.getElementById('plate-bar') as HTMLDivElement;
  surfaces.defer(() => plateBar.replaceChildren());
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
    add.title = t('app.main.addBuildPlate', 'Add build plate');
    add.onclick = () => {
      void registry
        .invoke('add_plate', 'dom-menu', actionCtx, uiState.get())
        .catch((error) => console.error('[orcaxr] add-plate action failed:', error));
    };
    plateBar.appendChild(add);
    uiState.update({ plateCount: plates.length, modelCount: workspace.modelCount });
  };
  surfaces.bind(workspace, 'onPlatesChanged', renderPlateBar);
  renderPlateBar();

  const updateCanonicalUi = (summary: ReturnType<OrcaWorkspace['getCanonicalSummary']>) => {
    const active = summary.plates.find((plate) => plate.id === summary.activePlateId);
    uiState.update({
      modelCount: active?.instanceCount ?? 0,
      plateCount: summary.plates.length,
      hasSelection: workspace.getObjectsTreeSnapshot().selection.refs.length > 0,
      simplifyPreviewing: workspace.getSimplifySnapshot().previewing,
      calibrationSessionOpen: workspace.calibrationSessionOpen,
      hasInstanceSelection: summary.primaryInstanceId !== undefined,
      canUndo: summary.history.undoCount > 0,
      canRedo: summary.history.redoCount > 0,
      dirty: summary.dirty,
      projectionHealthy: summary.projectionHealth.healthy,
    });
  };
  surfaces.bind(workspace, 'onCanonicalStateChanged', updateCanonicalUi);
  updateCanonicalUi(workspace.getCanonicalSummary());

  surfaces.bind(workspace, 'onDownloadReady', (ready) => {
    uiState.update({ gcodeReady: ready });
    // A stale artifact must not stay sendable; an in-flight send keeps its own
    // cancel affordance until it settles.
    if (!printWorkflow.busy) btnPrinterSend.disabled = !ready;
  });

  surfaces.bind(workspace, 'onSelectionChanged', () => {
    const summary = workspace.getCanonicalSummary();
    uiState.update({
      hasSelection: workspace.getObjectsTreeSnapshot().selection.refs.length > 0,
      simplifyPreviewing: workspace.getSimplifySnapshot().previewing,
      calibrationSessionOpen: workspace.calibrationSessionOpen,
      hasInstanceSelection: summary.primaryInstanceId !== undefined,
      modelCount: workspace.modelCount,
    });
    renderPlateBar();
  });

  const domSliceModal = document.getElementById('dom-slice-modal') as HTMLDivElement;
  const domSliceText = document.getElementById('dom-slice-text') as HTMLParagraphElement;
  const domSliceBar = document.getElementById('dom-slice-bar') as HTMLDivElement;

  surfaces.bind(workspace, 'onSliceStateChanged', (isSlicing) => {
    if (domSliceModal) {
      domSliceModal.style.display = isSlicing ? 'flex' : 'none';
    }
    // Drive both DOM and immersive action enablement from the same source.
    // Without this, Slice could still look ready while a previous job ran.
    uiState.update({ isSlicing });
  });

  surfaces.bind(workspace, 'onStatusChanged', (text, percent) => {
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
  });

  // AI & MCP Server
  const chkMcpEnabled = document.getElementById('chk-mcp-enabled') as HTMLInputElement;
  const mcpControls = document.getElementById('mcp-controls') as HTMLDivElement;
  const inMcpToken = document.getElementById('in-mcp-token') as HTMLInputElement;
  const btnMcpConnect = document.getElementById('btn-mcp-connect') as HTMLButtonElement;
  const btnMcpShare = document.getElementById('btn-mcp-share') as HTMLButtonElement;

  let mcp: OrcaWebMcpClient | null = null;

  const renderMcpStatus = (status: Readonly<WebMcpStatus>) => {
    if (surfaces.signal.aborted) return;
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

  surfaces.bind(chkMcpEnabled, 'onchange', () => {
    mcpControls.style.display = chkMcpEnabled.checked ? 'flex' : 'none';
    if (chkMcpEnabled.checked) {
      ensureMcpClient();
      statusText.textContent = t(
        'app.main.webMCPToolsAreReadyPaste',
        'WebMCP tools are ready. Paste a local bridge token and connect.',
      );
    } else {
      mcp?.disconnect('WebMCP tools disabled.');
    }
  });

  surfaces.bind(btnMcpConnect, 'onclick', async () => {
    const client = ensureMcpClient();
    if (client.isConnected) {
      client.disconnect();
      return;
    }
    const token = inMcpToken.value.trim();
    if (!token) {
      statusText.textContent = t('app.main.pleasePasteATokenFirst', 'Please paste a token first.');
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
  });

  surfaces.bind(btnMcpShare, 'onclick', async () => {
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
      statusText.textContent = t(
        'app.main.claudeDesktopMCPConfigSnippet',
        'Claude Desktop MCP config snippet copied to clipboard.',
      );
    } catch {
      statusText.textContent = t(
        'app.main.clipboardAccessWasDeniedCopy',
        'Clipboard access was denied. Copy the MCP snippet from a secure browser context.',
      );
    }
  });

  surfaces.defer(() => mcp?.disconnect());
}

document.addEventListener('DOMContentLoaded', async () => {
  const bootstrap = await Promise.all([
    import('./startup/ApplicationInitialization'),
    import('./ui/dom/StartupStatus'),
  ]).catch(() => {
    // No workspace exists yet, so this last-resort reload cannot discard edits.
    const host = document.getElementById('app-boot')!;
    host.dataset.bootState = 'failed';
    const message = document.createElement('p');
    message.textContent = t(
      'startup.bootstrapFailed',
      'The application could not load its startup controls. Check the connection and reload.',
    );
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.dataset.startupReload = 'true';
    reload.textContent = t('startup.reload', 'Reload application');
    reload.addEventListener('click', () => location.reload());
    host.replaceChildren(message, reload);
    return null;
  });
  if (!bootstrap) return;
  const [{ ApplicationInitialization }, { StartupStatus }] = bootstrap;
  const initialization = new ApplicationInitialization();
  let recoverFeature = (id: string) => {
    void initialization.recover(id);
  };
  const startupStatus = initialization.lifetime.own(
    new StartupStatus(document.getElementById('app-boot')!, initialization.registry, (id) => recoverFeature(id)),
  );
  startupStatus.mount();
  initialization.connectRecovery({
    reload: async () => {
      location.reload();
      return true;
    },
    report: () => {},
  });
  ownPageLifetime(window, initialization.lifetime, () => initialization.dispose());
  try {
    // The simulator is a development aid, not a headset runtime dependency. Its
    // custom controls pull a substantial rendering stack into the initial page;
    // defer that cost in production unless someone explicitly asks for desktop
    // simulation (`?simulator=1`). It still loads before `xb.init`, so simulator
    // behaviour is unchanged for local development and opt-in QA sessions.
    const wantsSimulator = import.meta.env.DEV || new URLSearchParams(window.location.search).get('simulator') === '1';
    if (wantsSimulator)
      await initialization.mount('simulator', 'Desktop simulator', (scope) =>
        scope.import(import('xrblocks/addons/simulator/SimulatorAddons.js')),
      );

    // Design tokens as CSS custom properties — the DOM shell's single source of
    // truth for colours/spacing (the XR shell reads the same `tokens` object).
    // Both themes are emitted; the attribute below picks the one in force.
    injectTokenCss();
    setDomTheme(initialDomTheme());

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
    // Localization is attached to the registry rather than to each shell: every
    // surface already reads its text through `all()` and `get()`, so one seam
    // covers DOM, XR, the palette, and context menus at the same instant. A menu
    // that translated while a tooltip did not reads as a broken translation.
    // No `reference` is passed: the English for every message is already at its
    // call site as the `source` argument, so shipping a second copy in the bundle
    // would cost every operator ~80 KB to render text the code already contains.
    const l10n = new Localizer({
      load: createCatalogLoader('l10n/'),
      onProblem: (problem) => console.warn(`[orcaxr-web] message ${problem.id ?? ''}: ${problem.message}`),
    });
    registry.useTextSource(l10n);
    // Every surface outside the action catalogue reads its text through `t`,
    // which finds the localizer here rather than being handed one; installing it
    // before anything is built is what makes that true from the first frame.
    installLocalizer(l10n);
    (window as unknown as { __orcaL10n: unknown }).__orcaL10n = l10n;

    const uiState = new UiState();
    initialization.lifetime.defer(
      initialization.registry.subscribe((snapshot) => uiState.update({ initialization: snapshot })),
    );
    const initializedWorkspace = await initialization.registry.run('workspace', async (scope) => {
      const persistenceModule = await scope.import(import('./persistence/BrowserProjectPersistence'));
      const serializer = scope.own(new persistenceModule.WorkerProjectSerializer());
      const workspace = new OrcaWorkspace(registry, {
        initialization: initialization.registry,
        projectSerializer: serializer,
        fullSpectrumAutoPairPreferences: loadFullSpectrumAutoPairPreferences(),
      });
      scope.own(workspace);
      (window as any).workspace = workspace;

      // Foundation for the shared-registry UI (Phase 1 renders both shells from
      // these). Construct now so the store is live and debuggable from the console.
      const actionCtx = new ActionContext(workspace, uiState, registry);
      // The XR tool card (built eagerly in the workspace ctor) routes clicks through
      // this at click time, so both shells run identical action handlers.
      workspace.actionContext = actionCtx;
      (window as unknown as { __orcaUi: unknown }).__orcaUi = uiState;
      (window as unknown as { __orcaCtx: unknown }).__orcaCtx = actionCtx;

      // A desktop slicer window is not a simulated headset. The simulator's
      // living-room passthrough stand-in is what a flat browser session would
      // otherwise show behind the build plate, so it is cleared here and replaced
      // by the plain gradient the plate sits on below. A real session supplies its
      // own background — passthrough in AR, the transition colour in VR — so this
      // changes nothing in the headset.
      for (const environment of options.simulator.environments) {
        environment.scenePath = null;
        environment.scenePlanesPath = null;
      }

      xb.add(workspace);
      await scope.load(xb.init(options));

      // Setup OrbitControls for 2D mode navigation
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const orbit = new OrbitControls(xb.core.camera, canvas);
      // Orbit around the live plate position — a hardcoded target here silently
      // diverges when the workspace constants move (the plate "disappeared" once).
      orbit.target.copy(workspace.plateFocus());
      orbit.update();
      workspace.orbitControls = orbit;
      // Start on the plate. Without this the window opens on whatever pose the XR
      // runtime seeded, which in a flat browser is a room-scale view of a plate the
      // size of a postage stamp.
      if (!xb.core.renderer?.xr?.isPresenting) workspace.frameCameraView('default');
      workspace.setup2DControls(canvas);

      // Debug handles for remote scene inspection / automated testing via CDP.
      (window as unknown as { __orcaScene: unknown }).__orcaScene = xb.core.scene;
      (window as unknown as { __orcaRenderer: unknown }).__orcaRenderer = xb.core.renderer;
      (window as unknown as { THREE: unknown }).THREE = THREE;
      (window as unknown as { __orca: unknown }).__orca = workspace;
      return { workspace, actionCtx, persistenceModule };
    });
    if (!initializedWorkspace.ready) return;
    const { workspace, actionCtx, persistenceModule } = initializedWorkspace.value;
    workspace.onRequestStartupRecovery = (id) => initialization.recover(id);
    recoverFeature = (id) => {
      void registry.invoke('help_startup_recovery', 'dom-inspector', actionCtx, uiState.get(), {
        startupFeatureId: id,
      });
    };
    initialization.connectRecovery({
      reload: async () => {
        if (workspace.getCanonicalSummary().dirty) {
          workspace.setStatus(
            t(
              'startup.unsavedReloadBlocked',
              'Save or discard the current project before reloading. Your unsaved work has been kept.',
            ),
          );
          return false;
        }
        location.reload();
        return true;
      },
      report: (message) => workspace.setStatus(message),
    });
    await initialization.registry.run('shell', async (scope) => {
      const surfaces = scope.own(new SurfaceLifecycle());
      setupDomUI(workspace, uiState, actionCtx, registry, () => l10n, initialization, surfaces);
      const persistence = scope.own(
        new persistenceModule.BrowserProjectPersistence({
          project: workspace.createPersistenceProjectPort(),
          host: document.querySelector('#page-project .page-inner') as HTMLElement,
          download: (name, bytes, mediaType) => {
            if (!workspace.onDownloadFile) throw new Error('No download surface is available.');
            workspace.onDownloadFile(name, Uint8Array.from(bytes).buffer, mediaType);
          },
          restore: (bytes, name, proof, signal) =>
            workspace.openProject(Uint8Array.from(bytes).buffer, name, proof, signal),
          report: (message) => workspace.setStatus(message),
          isXrPresenting: () => Boolean(xb.core.renderer?.xr?.isPresenting),
          chooseInXr: (name, signal) => workspace.askXrUnsavedProjectDecision(name, signal),
          invoke: (operation, id) =>
            registry.invoke(
              operation === 'recover'
                ? 'file_recover_project'
                : operation === 'download'
                  ? 'file_download_recovery'
                  : 'file_discard_recovery',
              'dom-inspector',
              actionCtx,
              uiState.get(),
              { recoverySessionId: id },
            ),
          directoryChanged: (rows, message) => workspace.updateRecoveryDirectory(rows, message),
        }),
      );
      workspace.connectProjectPersistence(persistence.controller);
      surfaces.bind(workspace, 'onRequestRecoveryView', () => showWorkspaceView?.('project'));
      surfaces.bind(workspace, 'onRequestApplicationUpdate', () => persistence.checkForUpdates());
      initialization.connectRecovery({
        reload: () => persistence.navigate('reload', () => location.reload()),
        report: (message) => workspace.setStatus(message),
      });

      // Render the tool rail, primary bar, Add/Tools menus, and mode control from
      // the shared registry (the same catalog the XR shell renders). Mounted after
      // setupDomUI so the file-input + onRequestLoadStl the Load action depends on
      // is in place.
      const byId = (id: string) => document.getElementById(id) as HTMLElement;
      const domShell = new DomShell(registry, actionCtx, uiState);
      const domShellHosts = {
        toolbar: byId('model-toolbar'),
        primary: byId('action-panel'),
        quickActions: byId('quick-actions'),
        printActions: byId('print-actions'),
        menuBar: byId('menu-bar-host'),
        menuButton: byId('menu-button') as HTMLButtonElement,
        calibration: byId('calibration-grid'),
      };
      surfaces.own(domShell);
      domShell.mount(domShellHosts);

      // ---- Language (P10.4) ------------------------------------------------
      //
      // `lang` and `dir` are not decoration: `lang` is what a screen reader picks a
      // voice from, and `dir` is what mirrors the layout. Both move with the same
      // subscription that repaints, so the app is never announcing German text in
      // an English voice.
      //
      // The repaint is a full remount rather than a refresh, because every label in
      // the rail, the primary bar, and the menu columns was written at build time.
      // A surface that kept its old words until it next opened would leave the
      // operator unable to tell which parts of the switch took effect.
      const applyDocumentLanguage = () => {
        document.documentElement.lang = l10n.locale;
        document.documentElement.dir = l10n.direction;
      };
      applyDocumentLanguage();
      surfaces.defer(
        l10n.subscribe(() => {
          applyDocumentLanguage();
          domShell.mount(domShellHosts);
          hydrateIcons();
          uiState.update({});
        }),
      );

      // A stored choice is a decision and outranks the browser's list; only an
      // operator who has never chosen gets one negotiated for them.
      void (async () => {
        let stored: string | null;
        try {
          stored = localStorage.getItem(LANGUAGE_KEY);
        } catch {
          // Private mode: nothing was stored, so the browser's list decides.
          stored = null;
        }
        const target = stored && findLocale(stored) ? stored : negotiateLocale([...(navigator.languages ?? [])]);
        if (target !== l10n.locale) await l10n.setLocale(target);
      })();

      // Prepare · Preview · Device · Project — the workspace the whole window is
      // showing, not a panel inside one. Prepare and Preview share the parameter
      // sidebar; Device and Project are pages over the viewport.
      const workspaceViews = new WorkspaceViews(
        {
          tabs: byId('view-tabs'),
          sidebar: byId('param-sidebar'),
          toolbar: byId('viewport-toolbar'),
          plateBar: byId('plate-bar'),
          devicePage: byId('page-device'),
          projectPage: byId('page-project'),
          previewCard: byId('card-preview'),
        },
        uiState,
        (actionId) => {
          void registry
            .invoke(actionId, 'dom-primary', actionCtx, uiState.get())
            .catch((error) => console.error(`[orcaxr] view action "${actionId}" failed:`, error));
        },
      );
      surfaces.own(workspaceViews);
      workspaceViews.mount();
      const showView = (id: WorkspaceViewId) => workspaceViews.activate(id);
      showWorkspaceView = showView;
      surfaces.defer(() => {
        if (showWorkspaceView === showView) showWorkspaceView = undefined;
      });

      // ---- Shell chrome ------------------------------------------------------
      //
      // Icons are declared in the markup as `data-icon` and resolved here, so
      // index.html never has to know where the vendored SVGs live or what the
      // deployment's base path is.
      hydrateIcons();

      // The home button snaps the camera back — the same action the View menu runs.
      surfaces.listen(byId('btn-home'), 'click', () => {
        void registry
          .invoke('view_camera_default', 'dom-menu', actionCtx, uiState.get())
          .catch((error) => console.error('[orcaxr] default-view action failed:', error));
      });

      // Sidebar cards fold away, as upstream's do, and say so to assistive tech.
      for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-card-toggle]')) {
        const card = toggle.closest('.oxr-card');
        if (!card) continue;
        surfaces.listen(toggle, 'click', () => {
          const folded = card.classList.toggle('folded');
          toggle.setAttribute('aria-expanded', String(!folded));
        });
      }

      // Dark mode. An explicit choice is remembered on this device and outranks
      // everything else, which is what the official application's preference does.
      const themeButton = byId('btn-theme') as HTMLButtonElement;
      const syncThemeButton = () => {
        const dark = activeDomTheme() === 'dark';
        themeButton.setAttribute('aria-pressed', String(dark));
        themeButton.title = dark
          ? t('app.main.switchToLightMode', 'Switch to light mode')
          : t('app.main.switchToDarkMode', 'Switch to dark mode');
        themeButton.setAttribute('aria-label', themeButton.title);
      };
      surfaces.listen(themeButton, 'click', () => {
        setDomTheme(activeDomTheme() === 'dark' ? 'light' : 'dark');
        syncThemeButton();
      });
      syncThemeButton();

      // ---- Process card head -------------------------------------------------
      //
      // Upstream puts two controls on the Process band: which scope is being
      // edited, and how much of the schema to show. Both already exist inside the
      // panel below — the scope picker and the Simple/Advanced/Develop modes — so
      // these drive those real controls rather than keeping a second state.
      const settingsHostEl = byId('settings-inspector-host');
      const advancedSwitch = byId('process-advanced') as HTMLButtonElement;
      const scopeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-process-scope]')];
      const modeRadio = (mode: string) =>
        settingsHostEl.querySelector<HTMLInputElement>(`[data-settings-mode="${mode}"]`);
      const targetSelect = () => settingsHostEl.querySelector<HTMLSelectElement>('[data-scoped-settings-target]');
      const objectOption = () => {
        const select = targetSelect();
        if (!select) return undefined;
        const options = [...select.options];
        return (
          options.find((option) => option.dataset.scope === 'object') ??
          options.find((option) => option.dataset.scope === 'part') ??
          options.find((option) => option.dataset.scope === 'layerRange')
        );
      };
      const syncProcessHead = () => {
        const simple = modeRadio('simple');
        const advanced = modeRadio('advanced');
        advancedSwitch.disabled = !simple || !advanced;
        advancedSwitch.setAttribute('aria-checked', String(Boolean(simple && !simple.checked)));

        const select = targetSelect();
        const object = objectOption();
        const scope = select?.selectedOptions[0]?.dataset.scope ?? 'project';
        for (const button of scopeButtons) {
          const wantsObjects = button.dataset.processScope === 'objects';
          button.setAttribute('aria-pressed', String(wantsObjects === (scope !== 'project')));
          button.disabled = !select || (wantsObjects && !object);
          button.title =
            wantsObjects && !object
              ? t('app.main.selectAnObjectToGive', 'Add an object to the plate to give it its own settings')
              : '';
        }
      };
      surfaces.listen(advancedSwitch, 'click', () => {
        const on = advancedSwitch.getAttribute('aria-checked') === 'true';
        const target = modeRadio(on ? 'simple' : 'advanced');
        if (!target) return;
        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        syncProcessHead();
      });
      for (const button of scopeButtons) {
        surfaces.listen(button, 'click', () => {
          const select = targetSelect();
          if (!select) return;
          const wanted =
            button.dataset.processScope === 'objects'
              ? objectOption()
              : [...select.options].find((option) => option.dataset.scope === 'project');
          if (!wanted) return;
          select.value = wanted.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          syncProcessHead();
        });
      }
      surfaces.listen(byId('btn-process-search'), 'click', () => {
        const search = settingsHostEl.querySelector<HTMLInputElement>('[data-settings-search]');
        search?.focus();
        search?.scrollIntoView({ block: 'nearest' });
      });
      // The panel rebuilds itself whenever the scope or the canonical project
      // changes, so the head reads the DOM it drives rather than caching it.
      surfaces.listen(settingsHostEl, 'change', syncProcessHead);
      surfaces
        .observe(new MutationObserver(() => syncProcessHead()))
        .observe(settingsHostEl, { childList: true, subtree: true });
      syncProcessHead();

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
      surfaces.listen(window, 'resize', centreCameraOnViewport);
      surfaces.observe(new ResizeObserver(centreCameraOnViewport)).observe(viewport);
      xb.core.renderer?.xr?.addEventListener('sessionstart', centreCameraOnViewport);
      xb.core.renderer?.xr?.addEventListener('sessionend', centreCameraOnViewport);
      surfaces.defer(() => {
        xb.core.renderer?.xr?.removeEventListener('sessionstart', centreCameraOnViewport);
        xb.core.renderer?.xr?.removeEventListener('sessionend', centreCameraOnViewport);
      });

      // ---- Viewport chrome ----------------------------------------------------
      //
      // The wash the plate stands on is painted by the page, not the renderer: the
      // WebGL canvas is transparent by design (that is what lets the docked chrome
      // sit over it), so the gradient belongs to the stylesheet where it follows
      // the theme with everything else.
      //
      // The reticle does not. It is an XR aiming cue, and in a desktop window it is
      // a stray dot in the middle of a slicer's viewport where the operator already
      // has a pointer. It comes back for the session that needs it.
      // A headset renders at a wide field of view because the display fills the
      // wearer's vision. A window does not, and the same 90° through a monitor
      // leaves the build plate the size of a postage stamp in the middle of the
      // frame. The flat shell uses the field of view a desktop slicer uses; an XR
      // session's projection comes from the runtime, so the value is restored for
      // the sake of anything that reads it rather than because the session needs it.
      const XR_FOV = xb.core.camera instanceof THREE.PerspectiveCamera ? xb.core.camera.fov : 90;
      const FLAT_FOV = 45;
      const syncViewportChrome = () => {
        const presenting = Boolean(xb.core.renderer?.xr?.isPresenting);
        const camera = xb.core.camera;
        if (camera instanceof THREE.PerspectiveCamera) {
          const wanted = presenting ? XR_FOV : FLAT_FOV;
          if (camera.fov !== wanted) {
            camera.fov = wanted;
            camera.updateProjectionMatrix();
          }
        }
        const reticles = xb.core.input?.reticles;
        if (reticles) reticles.visible = presenting;
        // The plate is dressed for the surface it is being seen on: a grabbable
        // object in the headset, a slicer's bed in the window.
        workspace.setPlateAppearance(presenting ? 'xr' : activeDomTheme() === 'dark' ? 'flat-dark' : 'flat-light');
      };
      syncViewportChrome();
      xb.core.renderer?.xr?.addEventListener('sessionstart', syncViewportChrome);
      xb.core.renderer?.xr?.addEventListener('sessionend', syncViewportChrome);
      surfaces.defer(() => {
        xb.core.renderer?.xr?.removeEventListener('sessionstart', syncViewportChrome);
        xb.core.renderer?.xr?.removeEventListener('sessionend', syncViewportChrome);
      });
      surfaces.listen(themeButton, 'click', syncViewportChrome);

      const toolSettingsPanel = byId('tool-settings-panel');
      const toolSettingsTitle = byId('tool-settings-title');
      const toolSettingsContent = byId('tool-settings-content');
      surfaces.defer(() => toolSettingsContent.replaceChildren());
      const btnCloseToolSettings = byId('btn-close-tool-settings');

      surfaces.bind(btnCloseToolSettings, 'onclick', () => {
        void registry
          .invoke('tool_move', 'dom-toolbar', actionCtx, uiState.get())
          .catch((error) => console.error('[orcaxr] close-tool action failed:', error));
      });

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
              <span style="font-size:13px; color:var(--oxr-text-muted); width:20px;">X</span>
              <input type="number" id="ts-x" step="0.1" style="width:100px; background:var(--oxr-bg-sunken); border:1px solid var(--oxr-stroke); color:var(--oxr-text); padding:4px; border-radius:4px; font-size:13px;" />
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:var(--oxr-text-muted); width:20px;">Y</span>
              <input type="number" id="ts-y" step="0.1" style="width:100px; background:var(--oxr-bg-sunken); border:1px solid var(--oxr-stroke); color:var(--oxr-text); padding:4px; border-radius:4px; font-size:13px;" />
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:var(--oxr-text-muted); width:20px;">Z</span>
              <input type="number" id="ts-z" step="0.1" style="width:100px; background:var(--oxr-bg-sunken); border:1px solid var(--oxr-stroke); color:var(--oxr-text); padding:4px; border-radius:4px; font-size:13px;" />
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

      surfaces.defer(uiState.subscribe(updateToolSettings));
      surfaces.bind(workspace, 'onSelectionTransformChanged', updateToolSettings);

      // The command palette: every action, searchable, one Ctrl/⌘-K away.
      const palette = new CommandPalette(registry, actionCtx, uiState);

      surfaces.defer(() => AiConfigDialog.dispose());
      AiConfigDialog.init();
      const aiConfigTrigger = document.getElementById('cmd-ai-config');
      if (aiConfigTrigger)
        surfaces.listen(aiConfigTrigger, 'click', () => {
          AiConfigDialog.show();
        });

      surfaces.own(palette);
      palette.mount(
        byId('command-palette'),
        document.getElementById('cmd-input') as HTMLInputElement,
        byId('cmd-list'),
        byId('cmd-search-btn'),
      );

      // Remove the first-paint readiness surface only after both the workspace and
      // its actionable shell exist. This avoids a blank / seemingly frozen canvas
      // on cold headset loads.
    });
  } catch (error) {
    await initialization.registry.run('shell', () => {
      throw error;
    });
  }
});
