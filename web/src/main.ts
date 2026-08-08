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
  queryMoonrakerFilamentSlots,
  savePrinterEndpointPreferences,
  type MoonrakerHandshake,
} from './printer';
import { registerWorkspaceTools } from './mcp/WorkspaceTools';
import { registerSystemTools } from './mcp/SystemTools';
import { OrcaWebMcpClient, WEBMCP_CLI_PACKAGE, WebMcpConnectionError, type WebMcpStatus } from './mcp/OrcaWebMcpClient';
import { injectTokenCss } from './ui/tokens';
import { UiState } from './actions/UiState';
import { ActionContext } from './actions/ActionContext';
import { buildRegistry } from './actions/catalog';
import type { ActionRegistry } from './actions/ActionRegistry';
import { buildShortcutCatalog, isShortcutEditingTarget, matchShortcut } from './actions/ShortcutCatalog';
import { DomShell } from './ui/dom/DomShell';
import { CommandPalette } from './ui/dom/CommandPalette';
import { GeneratedSettingsPanel } from './ui/dom/GeneratedSettingsPanel';
import { ObjectsPanel, type ObjectsPanelSelectionRequest } from './ui/dom/ObjectsPanel';
import { FilamentAssignmentSelector } from './ui/dom/FilamentAssignmentSelector';
import { GcodePreviewPanel } from './ui/dom/GcodePreviewPanel';
import { PaintPanel } from './ui/dom/PaintPanel';
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
  const leftToolbar = document.getElementById('left-toolbar') as HTMLElement;
  const toolbarToggle = document.getElementById('toolbar-toggle') as HTMLButtonElement;
  const printerHost = document.getElementById('printer-host') as HTMLInputElement;
  const printerApiKey = document.getElementById('printer-api-key') as HTMLInputElement;
  const btnPrinterTest = document.getElementById('btn-printer-test') as HTMLButtonElement;
  const btnPrinterSend = document.getElementById('btn-printer-send') as HTMLButtonElement;
  const printerCfg = loadPrinterEndpointPreferences();
  let printerTransport: MoonrakerTransport | null = null;
  let printerTransportKey = '';
  let hadModels = false;

  const disposePrinterTransport = () => {
    printerTransport?.dispose();
    printerTransport = null;
    printerTransportKey = '';
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

  const connectConfiguredPrinter = async (): Promise<{
    transport: MoonrakerTransport;
    handshake: MoonrakerHandshake;
  }> => {
    const transport = configuredPrinterTransport();
    const handshake = await transport.connect();
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
      workspace.setStatus(
        `Printer filaments (read-only): ${summary}. Project mapping was not changed; P9 mapping and confirmation are required.`,
      );
    } catch (error) {
      workspace.setStatus(`Filament inspection failed: ${(error as Error).message}`);
    }
  };

  window.addEventListener('pagehide', disposePrinterTransport, { once: true });

  emptyLoadModel.onclick = () => {
    void registry
      .invoke('load_model_from_path', 'dom-primary', actionCtx, uiState.get())
      .catch((error) => console.error('[orcaxr] empty-state load action failed:', error));
  };
  uiState.subscribe((state) => {
    emptyState.hidden = state.modelCount > 0;
    uiContainer.classList.toggle('no-model', state.modelCount === 0);
    toolbarToggle.hidden = state.modelCount === 0;
    // A newly loaded model should expose the plate and the obvious Slice
    // action, not a floor-to-ceiling list of rarely-used editing commands.
    // Preserve the maker's choice after they explicitly open the rail.
    if (state.modelCount > 0 && !hadModels) leftToolbar.classList.add('collapsed');
    hadModels = state.modelCount > 0;
    toolbarToggle.setAttribute('aria-expanded', String(!leftToolbar.classList.contains('collapsed')));
  });
  toolbarToggle.onclick = () => {
    leftToolbar.classList.toggle('collapsed');
    toolbarToggle.setAttribute('aria-expanded', String(!leftToolbar.classList.contains('collapsed')));
  };

  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files ?? []).slice(0, 1);
    if (files.length > 0) loadingModal.style.display = 'flex';

    const updateModal = (text: string, percent: number) => {
      loadingModalText.textContent = text;
      loadingModalBar.style.width = `${percent}%`;
      uiState.update({ status: text, progress: percent });
    };

    for (const file of files) {
      updateModal(`Reading ${file.name}...`, 10);
      await new Promise((r) => setTimeout(r, 50));
      const buf = await file.arrayBuffer();
      try {
        // One signature-first, transactional route for every model container.
        updateModal(`Decoding ${file.name}...`, 55);
        await new Promise((r) => setTimeout(r, 50));
        await workspace.importModelFile(file.name, buf);
      } catch (e) {
        statusText.textContent = `Failed to load: ${(e as Error).message}`;
      }
    }
    loadingModal.style.display = 'none';
    uiState.update({ modelCount: workspace.modelCount, progress: null });
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
    if (returnFocus?.isConnected) returnFocus.focus();
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

    if (exCount > 1) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'action-btn';
      syncBtn.style.cssText =
        'background: #2E7D32; color: white; border: none; padding: 8px; margin-bottom: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; width: 100%;';
      syncBtn.textContent = 'Inspect Printer Filaments';
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

  const previewPanelHost = document.getElementById('gcode-preview-panel-host');
  if (previewPanelHost) {
    const previewPanel = new GcodePreviewPanel(previewPanelHost, {
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
      onError: (error) => {
        statusText.textContent = `Preview: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
    previewPanel.mount();
    window.addEventListener('pagehide', () => previewPanel.dispose(), { once: true });
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
    const settingsPanel = new GeneratedSettingsPanel(
      settingsHost,
      {
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
          const overrides = applySettingsCommitToConfig(
            raw.overrides as unknown as Readonly<ConfigMap>,
            request.commit,
          );
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
      },
      { loadCatalog: () => catalogPromise },
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
    disposePrinterTransport();
  };
  printerApiKey.oninput = disposePrinterTransport;
  const externalSlicerUrl = document.getElementById('external-slicer-url') as HTMLInputElement;
  const externalSlicerStatus = document.getElementById('external-slicer-status') as HTMLSpanElement;
  const btnExternalSlicerConnect = document.getElementById('btn-external-slicer-connect') as HTMLButtonElement;
  const externalSlicerControls = document.getElementById('external-slicer-controls') as HTMLDivElement;
  const externalSlicerEnabled = document.getElementById('external-slicer-enabled') as HTMLInputElement;
  const btnExternalSlicerDelete = document.getElementById('btn-external-slicer-delete') as HTMLButtonElement;
  const externalSlicerHint = document.getElementById('external-slicer-hint') as HTMLParagraphElement;
  externalSlicerUrl.value = SlicerClient.getExternalSlicerUrl();

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
  const printerMutationReason =
    'Unavailable until printer mapping, preflight, confirmation, integrity, and reconnect handling are complete.';
  btnPrinterSend.disabled = true;
  btnPrinterSend.title = printerMutationReason;
  btnPrinterWebcam.disabled = true;
  btnPrinterWebcam.title = 'Unavailable until webcam discovery is routed through the shared printer connection.';

  // Download availability is registry-driven. Printer mutation stays blocked
  // independently until the complete P9 safety workflow is wired.
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
    btnPrinterSend.disabled = true;
    uiState.update({ gcodeReady: ready });
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
    modeControl: byId('mode-control'),
    menuBar: byId('menu-bar-host'),
  });

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
