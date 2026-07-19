/**
 * OrcaXR Web — entry point.
 *
 * Phase 2: build-plate workspace with DragManager model manipulation and
 * the libslic3r WASM module slicing the live scene (see OrcaWorkspace).
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as xb from 'xrblocks';
import * as uikit from '@pmndrs/uikit';

import { OrcaWorkspace, extract3mfImportMetadata } from './workspace/OrcaWorkspace';
import { SlicerClient } from './slicer/SlicerClient';
import { loadPrinterConfig, savePrinterConfig } from './net/PrinterClient';
import { fetchLocalNetwork, normalizeHttpEndpoint } from './net/LocalNetworkAccess';
import { registerWorkspaceTools } from './mcp/WorkspaceTools';
import { registerSystemTools } from './mcp/SystemTools';
import { OrcaWebMcpClient, WEBMCP_CLI_PACKAGE, WebMcpConnectionError, type WebMcpStatus } from './mcp/OrcaWebMcpClient';
import { injectTokenCss } from './ui/tokens';
import { UiState } from './actions/UiState';
import { ActionContext } from './actions/ActionContext';
import { buildRegistry } from './actions/catalog';
import type { ActionRegistry } from './actions/ActionRegistry';
import { DomShell } from './ui/dom/DomShell';
import { CommandPalette } from './ui/dom/CommandPalette';
import { SettingsInspector } from './ui/dom/SettingsInspector';
import { AiConfigDialog } from './ui/dom/AiConfigDialog';

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

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace, uiState: UiState, actionCtx: ActionContext, registry: ActionRegistry) {
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
  let hadModels = false;

  emptyLoadModel.onclick = () => fileInput.click();
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
    const files = Array.from(fileInput.files ?? []);
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
        const lowerName = file.name.toLowerCase();
        console.log(`[main.ts] Uploaded file: ${file.name}, lowerName: ${lowerName}`);
        if (lowerName.endsWith('.3mf')) {
          updateModal(`Extracting colors...`, 30);
          await new Promise((r) => setTimeout(r, 50));
          const metadata = await extract3mfImportMetadata(buf);

          updateModal(`Parsing 3MF geometry...`, 60);
          await new Promise((r) => setTimeout(r, 50));
          const group = new ThreeMFLoader().parse(buf);

          updateModal(`Building scene...`, 90);
          await new Promise((r) => setTimeout(r, 50));
          // Keep semantic adoption and synchronous geometry commit adjacent so
          // no user action can interleave with the import checkpoint.
          await workspace.adoptPaletteFrom3mf(buf, metadata.projectConfig); // seed palette + Bambu import detection
          workspace.loadModelFromGroup(
            group,
            file.name,
            metadata.colors || undefined,
            metadata.paint,
            metadata.plateLayout,
            metadata.plateLayoutStatus,
          );
        } else if (lowerName.endsWith('.zip')) {
          updateModal(`Reading archive...`, 40);
          await new Promise((r) => setTimeout(r, 50));
          await workspace.importZipArchive(buf);
        } else if (lowerName.endsWith('.stl')) {
          updateModal(`Parsing STL geometry...`, 50);
          await new Promise((r) => setTimeout(r, 50));
          const geometry = new STLLoader().parse(buf);

          updateModal(`Building scene...`, 90);
          await new Promise((r) => setTimeout(r, 50));
          workspace.loadModelFromGeometry(geometry, file.name);
        } else {
          throw new Error(`Unsupported model format for ${file.name}. Choose an STL or 3MF file.`);
        }
      } catch (e) {
        statusText.textContent = `Failed to load: ${(e as Error).message}`;
      }
    }
    loadingModal.style.display = 'none';
    uiState.update({ modelCount: workspace.modelCount, status: 'Ready', progress: null });
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
      const n = await workspace.importZipArchive(await f.arrayBuffer());
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

  // Open Project (File menu): a .3mf picker. If the file isn't an OrcaXR project
  // (no metadata sidecar), fall back to importing it as a plain model.
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
      if (!workspace.openProject(buf)) await workspace.loadModelFromBuffer(f.name, buf);
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
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      !!target?.isContentEditable;
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') {
      // Let the command palette own Escape while it is open; otherwise close a
      // help/setup modal first, then clear the active model selection.
      if (document.getElementById('command-palette')?.classList.contains('open')) return;
      if (document.getElementById('oxr-modal-overlay')) {
        closeModal();
      } else if (uiState.get().hasSelection) {
        void registry.invoke('edit_deselect_all', 'keyboard', actionCtx, uiState.get());
      }
      return;
    }
    if (e.key === 'Delete' && uiState.get().hasSelection) {
      e.preventDefault();
      void registry.invoke('edit_delete_selected', 'keyboard', actionCtx, uiState.get());
      return;
    }
    const toolByKey: Record<string, string> = {
      g: 'tool_move',
      r: 'tool_rotate',
      s: 'tool_scale',
    };
    const actionId = toolByKey[e.key.toLowerCase()];
    if (actionId && uiState.get().hasSelection) {
      e.preventDefault();
      void registry.invoke(actionId, 'keyboard', actionCtx, uiState.get());
    }
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
    const fill = (sel: HTMLSelectElement, values: string[], current: string) => {
      sel.innerHTML = '';
      for (const v of values) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        if (v === current) o.selected = true;
        sel.appendChild(o);
      }
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
    fill(mSel, opts.machines, opts.machine);
    const pSel = mk('Process');
    fill(pSel, opts.processes, opts.process);
    const fSel = mk('Filament');
    fill(fSel, opts.filaments, opts.filament);
    mSel.onchange = () => {
      const ch = workspace.choicesForMachine(mSel.value);
      fill(pSel, ch.processes, ch.processes[0] ?? '');
      fill(fSel, ch.filaments, ch.filaments[0] ?? '');
    };
    const apply = document.createElement('button');
    apply.textContent = 'Apply & Close';
    apply.setAttribute('data-testid', 'wizard-apply');
    apply.style.cssText =
      'margin-top:14px;width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(90deg,#ffb74d,#ff9800);color:#1a1a1a;font-weight:600;font-size:14px;cursor:pointer;';
    apply.onclick = () => {
      workspace.setProfileByNames(mSel.value, pSel.value, fSel.value);
      closeModal();
    };
    body.appendChild(apply);
    buildModal('Setup Wizard', body);
  };

  // Pre-flight banners (Section 1): bed collision, filament rules, top cover,
  // Bambu import. Blocking (error) banners disable the Slice button.
  const bannerWrap = document.getElementById('preflight-banners') as HTMLDivElement;
  workspace.onPreflight = (banners) => {
    bannerWrap.innerHTML = '';
    const palette = {
      error: { bg: '#3a1e1e', border: '#f4433699', fg: '#ff8a80' },
      warning: { bg: '#3a331e', border: '#ffb74d99', fg: '#ffcc80' },
      info: { bg: '#1e2a3a', border: '#4fc3f799', fg: '#90caf9' },
    } as const;
    for (const b of banners) {
      const c = palette[b.severity];
      const el = document.createElement('div');
      el.dataset.bannerId = b.id;
      el.dataset.severity = b.severity;
      el.style.cssText =
        `background:${c.bg};border:1px solid ${c.border};color:${c.fg};` +
        `border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.4;`;
      el.textContent = b.text;
      bannerWrap.appendChild(el);
    }
    // Slice enablement is now driven by the registry via UiState.preflightBlocked.
    uiState.update({ preflightBlocked: workspace.hasBlockingPreflight() });
  };

  // Wipe-tower auto-position toggle (Section 1).
  const chkWipeTower = document.getElementById('chk-wipe-tower-auto') as HTMLInputElement;
  chkWipeTower.onchange = () => workspace.setWipeTowerAuto(chkWipeTower.checked);

  // Profile pickers: mirror the XR panel's machine/process/filament cyclers.
  const selMachine = document.getElementById('sel-machine') as HTMLSelectElement;
  const selProcess = document.getElementById('sel-process') as HTMLSelectElement;
  const selFilament = document.getElementById('sel-filament') as HTMLSelectElement;
  const fillSelect = (sel: HTMLSelectElement, items: string[], current: string) => {
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
      return;
    }
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it;
      opt.textContent = it;
      opt.selected = it === current;
      sel.appendChild(opt);
    }
  };
  const headsPanel = document.getElementById('heads-panel') as HTMLDivElement;
  const renderProfileSelects = () => {
    const o = workspace.getProfileOptions();
    fillSelect(selMachine, o.machines, o.machine);
    fillSelect(selProcess, o.processes, o.process);
    fillSelect(selFilament, o.filaments, o.filament);
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
      syncBtn.textContent = 'Sync with Printer';
      syncBtn.onclick = async () => {
        const cfg = loadPrinterConfig();
        if (!cfg.host) {
          (workspace as any).setStatus('No printer IP set.');
          return;
        }
        try {
          (workspace as any).setStatus('Syncing filaments from printer...');
          const { MoonrakerClient } = await import('./features/MoonrakerClient');
          const client = new MoonrakerClient(cfg as any);
          // Provide a timeout so fetch doesn't hang indefinitely
          const slots = await client.queryFilamentSlots();
          if (slots.length > 0) {
            workspace.palette.setFrom(
              slots.map((s) => s.colorHex),
              slots.map((s) => s.material),
            );
            (workspace as any).setStatus('Synced filaments from printer!');
          } else {
            (workspace as any).setStatus('No filaments found on printer.');
          }
        } catch (e) {
          (workspace as any).setStatus(`Failed to sync: ${(e as Error).message}`);
        }
      };
      headsPanel.appendChild(syncBtn);

      for (let i = 0; i < totalCount; i++) {
        const isVirtual = i >= exCount;
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
        lbl.textContent = isVirtual ? `V-${i + 1}:` : `H-${i + 1}:`;
        lbl.style.cssText = 'color:#fff;width:30px;font-size:12px;';
        row.appendChild(lbl);

        const fSel = document.createElement('select');
        fSel.className = 'action-btn';
        fSel.style.cssText = 'flex-grow:1;margin:0;padding:6px;font-size:12px;';
        fillSelect(fSel, o.filaments, workspace.getHeadFilament(i));
        fSel.onchange = () => {
          workspace.setHeadFilament(i, fSel.value);
        };
        row.appendChild(fSel);

        if (!isVirtual) {
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

      const addBtn = document.createElement('button');
      addBtn.className = 'action-btn';
      addBtn.style.cssText =
        'background: rgba(255,255,255,0.05); color: #9aa4af; padding: 8px; margin-top: 4px; border-radius: 8px; cursor: not-allowed; font-size: 13px; width: 100%; border: 1px dashed rgba(255,255,255,0.18);';
      addBtn.textContent = 'Virtual filament authoring unavailable';
      addBtn.title =
        'Mixed-filament import and preview are available, but creating or editing virtual filaments is not implemented yet.';
      addBtn.disabled = true;
      headsPanel.appendChild(addBtn);
    }
  };
  const applySelects = () => {
    if (selMachine.selectedIndex < 1 || selProcess.selectedIndex < 1 || selFilament.selectedIndex < 1) return;
    try {
      localStorage.setItem(
        'orcaxr.profiles',
        JSON.stringify({
          machine: selMachine.value,
          process: selProcess.value,
          filament: selFilament.value,
        }),
      );
    } catch {
      /* local storage can be unavailable in private/restricted contexts */
    }
    workspace.setProfileByNames(selMachine.value, selProcess.value, selFilament.value);
  };
  selMachine.onchange = () => {
    // New machine resets compatible process/filament to first choices.
    const o = workspace.getProfileOptions();
    void o;
    workspace.setProfileByNames(selMachine.value, '', '');
  };
  selProcess.onchange = applySelects;
  selFilament.onchange = applySelects;
  workspace.onProfileChanged = renderProfileSelects;

  try {
    const raw = localStorage.getItem('orcaxr.profiles');
    if (raw) {
      const p = JSON.parse(raw);
      if (p.machine) selMachine.value = p.machine;
      if (p.process) selProcess.value = p.process;
      if (p.filament) selFilament.value = p.filament;
    }
  } catch {
    /* ignore invalid or unavailable saved profile state */
  }
  renderProfileSelects();

  // The settings inspector writes through the workspace's invalidating override API.
  const settingsHost = document.getElementById('settings-inspector-host');
  if (settingsHost) {
    const settingsInspector = new SettingsInspector(settingsHost, workspace);
    settingsInspector.mount();
  }

  // Filament palette: color swatches that drive paint + 3MF display + slice.
  const swatchWrap = document.getElementById('filament-swatches') as HTMLDivElement;
  const btnAddFilament = document.getElementById('btn-add-filament') as HTMLButtonElement;
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

    // Virtual (mixed) filaments from a loaded FullSpectrum 3MF: read-only
    // swatches with the same pigment-blended colors the desktop app shows.
    const vPanel = document.getElementById('virtual-filament-panel') as HTMLDivElement;
    const vTitle = document.getElementById('virtual-filament-title') as HTMLDivElement;
    const vWrap = document.getElementById('virtual-filament-swatches') as HTMLDivElement;
    const virtuals = workspace.virtualFilaments;
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

  // Printer: send sliced G-code to a Moonraker printer (e.g. Centauri Carbon).
  const printerHost = document.getElementById('printer-host') as HTMLInputElement;
  const btnPrinterTest = document.getElementById('btn-printer-test') as HTMLButtonElement;
  const btnPrinterSend = document.getElementById('btn-printer-send') as HTMLButtonElement;
  const printerCfg = loadPrinterConfig();
  printerHost.value = printerCfg.host;
  printerHost.oninput = () => {
    printerCfg.host = printerHost.value.trim();
    savePrinterConfig(printerCfg);
  };
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

  externalSlicerEnabled.onchange = () => {
    SlicerClient.setExternalSlicerEnabled(externalSlicerEnabled.checked);
    refreshExternalSlicerControls();
  };

  btnExternalSlicerDelete.onclick = () => {
    SlicerClient.clearExternalSlicer();
    externalSlicerUrl.value = '';
    updateExternalSlicerStatus(false);
    refreshExternalSlicerControls();
    statusText.textContent = 'External slicer removed — slicing locally.';
  };

  btnExternalSlicerConnect.onclick = async () => {
    const val = normalizeHttpEndpoint(externalSlicerUrl.value);
    if (!val) {
      SlicerClient.clearExternalSlicer();
      updateExternalSlicerStatus(false);
      refreshExternalSlicerControls();
      return;
    }
    btnExternalSlicerConnect.textContent = '...';
    try {
      const res = await fetchLocalNetwork(`${val}/ping`);
      if (res.ok) {
        SlicerClient.setExternalSlicerUrl(val);
        SlicerClient.setExternalSlicerEnabled(true); // connecting opts in
        updateExternalSlicerStatus(true);
      } else {
        throw new Error('Bad status');
      }
    } catch {
      // Keep the saved server (if any) on a failed reachability check; just
      // report offline. Deleting is an explicit action via the Delete button.
      updateExternalSlicerStatus(false);
    } finally {
      btnExternalSlicerConnect.textContent = 'Connect';
      refreshExternalSlicerControls();
    }
  };

  refreshExternalSlicerControls();
  if (externalSlicerUrl.value) {
    btnExternalSlicerConnect.click(); // auto-connect on load if url exists
  }

  btnPrinterTest.onclick = async () => {
    statusText.textContent = 'Testing printer connection…';
    try {
      const { MoonrakerClient } = await import('./features/MoonrakerClient');
      const client = new MoonrakerClient(printerCfg as any);
      const info = await client.ping();
      statusText.textContent = `Connected — printer ${info.state}.`;
    } catch (e) {
      statusText.textContent = `No response: ${(e as Error).message}`;
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
      chip.onclick = () => workspace.setActivePlate(p.id);
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
          workspace.deletePlate(p.id);
        };
        chip.appendChild(del);
      }
      plateBar.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'plate-add';
    add.textContent = '+';
    add.title = 'Add build plate';
    add.onclick = () => workspace.addPlate();
    plateBar.appendChild(add);
    uiState.update({ plateCount: plates.length, modelCount: workspace.modelCount });
  };
  workspace.onPlatesChanged = renderPlateBar;
  renderPlateBar();

  workspace.onDownloadReady = (ready) => {
    btnPrinterSend.disabled = true;
    uiState.update({ gcodeReady: ready });
  };

  workspace.onSelectionChanged = (hasSelection) => {
    uiState.update({ hasSelection, modelCount: workspace.modelCount });
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
    registerWorkspaceTools(mcp, workspace);
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

  const workspace = new OrcaWorkspace();
  (window as any).workspace = workspace;

  // Foundation for the shared-registry UI (Phase 1 renders both shells from
  // these). Construct now so the store is live and debuggable from the console.
  const uiState = new UiState();
  const actionCtx = new ActionContext(workspace, uiState);
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
  const registry = buildRegistry();
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
    actionCtx.setTool('move');
  };

  let currentSettingsTool = '';
  const updateToolSettings = () => {
    const s = uiState.get();
    const hasSelection = !!workspace.getSelectedModelScale();

    if (
      s.activeTool === 'paint' ||
      s.activeTool === 'support_paint' ||
      s.activeTool === 'seam_paint' ||
      s.activeTool === 'fuzzy_skin'
    ) {
      toolSettingsPanel.style.display = 'block';
      if (currentSettingsTool !== s.activeTool) {
        currentSettingsTool = s.activeTool;
        if (s.activeTool === 'paint') {
          toolSettingsTitle.textContent = 'Color Painting';
          toolSettingsContent.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:#a0aab5;">Brush Size (mm)</span>
              <span id="lbl-brush-size" style="font-size:13px;">${workspace.brushRadiusMm.toFixed(1)}</span>
            </div>
            <input type="range" id="in-brush-size" min="0.1" max="20" step="0.1" value="${workspace.brushRadiusMm}" style="accent-color:var(--oxr-color-accent);" />
            
            <div style="font-size:13px; color:#a0aab5; margin-top:8px;">Active Color</div>
            <div id="paint-tool-swatches" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
          `;

          const inBrushSize = byId('in-brush-size') as HTMLInputElement;
          const lblBrushSize = byId('lbl-brush-size');
          inBrushSize.oninput = () => {
            const val = parseFloat(inBrushSize.value);
            workspace.brushRadiusMm = val;
            lblBrushSize.textContent = val.toFixed(1);
          };

          const swatchesContainer = byId('paint-tool-swatches');
          const activeHex = workspace.getActivePaintColorHex();
          workspace.palette.list().forEach((slot) => {
            const btn = document.createElement('button');
            btn.style.cssText = `width:28px; height:28px; border-radius:14px; border:2px solid ${activeHex === slot.color ? '#fff' : 'transparent'}; background:${slot.color}; cursor:pointer;`;
            btn.onclick = () => {
              workspace.setActivePaintColor(slot.color);
              uiState.update({ ...s });
            };
            swatchesContainer.appendChild(btn);
          });
        } else {
          let title = 'Tool Settings';
          if (s.activeTool === 'support_paint') title = 'Support Painting';
          if (s.activeTool === 'seam_paint') title = 'Seam Painting';
          if (s.activeTool === 'fuzzy_skin') title = 'Fuzzy-skin Painting';
          toolSettingsTitle.textContent = title;
          toolSettingsContent.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; color:#a0aab5;">Brush Size (mm)</span>
              <span id="lbl-brush-size" style="font-size:13px;">${workspace.brushRadiusMm.toFixed(1)}</span>
            </div>
            <input type="range" id="in-brush-size" min="0.1" max="20" step="0.1" value="${workspace.brushRadiusMm}" style="accent-color:var(--oxr-color-accent);" />
          `;
          const inBrushSize = byId('in-brush-size') as HTMLInputElement;
          const lblBrushSize = byId('lbl-brush-size');
          inBrushSize.oninput = () => {
            const val = parseFloat(inBrushSize.value);
            workspace.brushRadiusMm = val;
            lblBrushSize.textContent = val.toFixed(1);
          };
        }
      }
    } else if (hasSelection && (s.activeTool === 'move' || s.activeTool === 'rotate' || s.activeTool === 'scale')) {
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
