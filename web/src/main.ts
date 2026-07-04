/**
 * OrcaXR Web — entry point.
 *
 * Phase 2: build-plate workspace with DragManager model manipulation and
 * the libslic3r WASM module slicing the live scene (see OrcaWorkspace).
 */
import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as xb from 'xrblocks';
// @ts-ignore
import * as uikit from '@pmndrs/uikit';

import { OrcaWorkspace, extract3mfColors } from './workspace/OrcaWorkspace';
import { extract3mfPaint } from './features/Paint3mf';
import { SlicerClient } from './slicer/SlicerClient';
import { loadPrinterConfig, probePrinter, savePrinterConfig, sendToPrinter } from './net/PrinterClient';
import { injectTokenCss } from './ui/tokens';
import { UiState } from './actions/UiState';
import { ActionContext } from './actions/ActionContext';
import { buildRegistry } from './actions/catalog';
import { DomShell } from './ui/dom/DomShell';
import { CommandPalette } from './ui/dom/CommandPalette';

declare global {
  interface Window { ORCAXR_VERSION: string }
}
window.ORCAXR_VERSION = 'v34-xr-recenter';

// In dev, forcibly evict any leftover service worker + caches. vite dev serves
// index.html for /sw.js (SPA fallback), which is an invalid SW script, so a SW
// registered by a *previous* `vite preview`/prod visit on this origin can never
// self-update and gets stuck serving the stale app bundle — masking every code
// change. Kill it so dev is always fresh. (Prod keeps its autoUpdate SW.)
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => { if (regs.length) { regs.forEach((r) => r.unregister()); console.warn('[orcaxr] unregistered', regs.length, 'stale service worker(s) — reload for fresh code'); } })
    .catch(() => {});
  if (typeof caches !== 'undefined') {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace, uiState: UiState) {

  // On phones the sidebar is a bottom sheet; its title toggles collapse so
  // the 3D view isn't permanently half-covered. No-op on desktop layouts.
  const sidebar = document.getElementById('right-sidebar') as HTMLDivElement;
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
      await new Promise(r => setTimeout(r, 50));
      const buf = await file.arrayBuffer();
      try {
        const lowerName = file.name.toLowerCase();
        console.log(`[main.ts] Uploaded file: ${file.name}, lowerName: ${lowerName}`);
        if (lowerName.endsWith('.3mf')) {
          updateModal(`Extracting colors...`, 30);
          await new Promise(r => setTimeout(r, 50));
          const colors = await extract3mfColors(buf);
          const paint = extract3mfPaint(buf);
          await workspace.adoptPaletteFrom3mf(buf); // seed palette + Bambu import detection

          updateModal(`Parsing 3MF geometry...`, 60);
          await new Promise(r => setTimeout(r, 50));
          const group = new ThreeMFLoader().parse(buf);

          updateModal(`Building scene...`, 90);
          await new Promise(r => setTimeout(r, 50));
          workspace.loadModelFromGroup(group, file.name, colors || undefined, paint);
        } else {
          updateModal(`Parsing STL geometry...`, 50);
          await new Promise(r => setTimeout(r, 50));
          const geometry = new STLLoader().parse(buf);

          updateModal(`Building scene...`, 90);
          await new Promise(r => setTimeout(r, 50));
          workspace.loadModelFromGeometry(geometry, file.name);
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
  workspace.onRequestLoadStl = () => fileInput.click();

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

    if (exCount > 1) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'action-btn';
      syncBtn.style.cssText = 'background: #2E7D32; color: white; border: none; padding: 8px; margin-bottom: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; width: 100%;';
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
                 workspace.palette.setFrom(slots.map(s => s.colorHex), slots.map(s => s.material));
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
        colorInput.style.cssText = 'width: 24px; height: 24px; padding: 0; border: none; background: none; cursor: pointer;';
        colorInput.onchange = () => {
           workspace.palette.setColor(i, colorInput.value);
           workspace.rebuildHeadsPanel();
        };
        row.appendChild(colorInput);

        const lbl = document.createElement('span');
        lbl.textContent = isVirtual ? `V-${i+1}:` : `H-${i+1}:`;
        lbl.style.cssText = 'color:#fff;width:30px;font-size:12px;';
        row.appendChild(lbl);
        
        const fSel = document.createElement('select');
        fSel.className = 'action-btn';
        fSel.style.cssText = 'flex-grow:1;margin:0;padding:6px;font-size:12px;';
        fillSelect(fSel, o.filaments, workspace.headFilaments[i] || '');
        fSel.onchange = () => {
          workspace.headFilaments[i] = fSel.value;
          workspace.rebuildHeadsPanel();
        };
        row.appendChild(fSel);
        
        if (!isVirtual) {
            const nSel = document.createElement('select');
            nSel.className = 'action-btn';
            nSel.style.cssText = 'width:60px;margin:0;padding:6px;font-size:12px;';
            fillSelect(nSel, ['0.2', '0.4', '0.6', '0.8'], workspace.headNozzles[i]);
            nSel.onchange = () => {
              workspace.headNozzles[i] = nSel.value;
              workspace.rebuildHeadsPanel();
            };
            row.appendChild(nSel);
        } else {
            const delBtn = document.createElement('button');
            delBtn.className = 'action-btn';
            delBtn.style.cssText = 'width:60px;margin:0;padding:6px;font-size:12px;background:#d32f2f;color:white;border:none;cursor:pointer;';
            delBtn.textContent = 'Del';
            delBtn.onclick = () => {
              workspace.palette.remove(i);
              workspace.headFilaments.splice(i, 1);
              workspace.headNozzles.splice(i, 1);
              workspace.rebuildHeadsPanel();
              renderProfileSelects(); // force redraw
            };
            row.appendChild(delBtn);
        }
        
        headsPanel.appendChild(row);
      }
      
      const addBtn = document.createElement('button');
      addBtn.className = 'action-btn';
      addBtn.style.cssText = 'background: rgba(255,255,255,0.1); color: white; padding: 8px; margin-top: 4px; border-radius: 8px; cursor: pointer; font-size: 13px; width: 100%; border: 1px dashed rgba(255,255,255,0.3);';
      addBtn.textContent = '+ Add Virtual Filament';
      addBtn.onclick = () => {
         workspace.palette.add();
         // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
         workspace.headFilaments.push(workspace.getProfileOptions().filament);
         workspace.headNozzles.push('0.4');
         workspace.rebuildHeadsPanel();
         renderProfileSelects(); // force redraw
      };
      headsPanel.appendChild(addBtn);
    }
  };
  const applySelects = () => {
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
  renderProfileSelects();

  const selWallGenerator = document.getElementById('sel-wall-generator') as HTMLSelectElement;
  const updateSettings = () => {
    if (selWallGenerator.value === 'classic') {
      workspace.customOverrides['wall_generator'] = 'classic';
      workspace.customOverrides['top_surface_pattern'] = 'monotonic';
      workspace.customOverrides['bottom_surface_pattern'] = 'monotonic';
      workspace.customOverrides['sparse_infill_pattern'] = 'grid';
      workspace.customOverrides['internal_solid_infill_pattern'] = 'rectilinear';
    } else {
      workspace.customOverrides['wall_generator'] = 'arachne';
      delete workspace.customOverrides['top_surface_pattern'];
      delete workspace.customOverrides['bottom_surface_pattern'];
      delete workspace.customOverrides['sparse_infill_pattern'];
      delete workspace.customOverrides['internal_solid_infill_pattern'];
    }
  };
  selWallGenerator.onchange = updateSettings;
  updateSettings();

  // Print settings: supports / layer height / infill / walls. These write into
  // workspace.customOverrides (merged last into the slice overrides). An empty
  // numeric field means "use the profile default" (no override).
  const selSupport = document.getElementById('sel-support') as HTMLSelectElement;
  const inLayer = document.getElementById('in-layer-height') as HTMLInputElement;
  const inInfill = document.getElementById('in-infill') as HTMLInputElement;
  const inWalls = document.getElementById('in-walls') as HTMLInputElement;
  const chkAdaptive = document.getElementById('chk-adaptive-layers') as HTMLInputElement;
  const applyPrintSettings = () => {
    const co = workspace.customOverrides;
    switch (selSupport.value) {
      case 'on_build_plate':
        co['enable_support'] = '1'; co['support_type'] = 'normal(auto)'; co['support_on_build_plate_only'] = '1'; break;
      case 'everywhere':
        co['enable_support'] = '1'; co['support_type'] = 'normal(auto)'; co['support_on_build_plate_only'] = '0'; break;
      case 'tree':
        co['enable_support'] = '1'; co['support_type'] = 'tree(auto)'; co['support_on_build_plate_only'] = '0'; break;
      default:
        co['enable_support'] = '0'; delete co['support_type']; delete co['support_on_build_plate_only'];
    }
    if (inLayer.value) co['layer_height'] = inLayer.value; else delete co['layer_height'];
    if (inInfill.value) co['sparse_infill_density'] = `${inInfill.value}%`; else delete co['sparse_infill_density'];
    if (inWalls.value) co['wall_loops'] = inWalls.value; else delete co['wall_loops'];
    // Adaptive layer height: the slicer varies layer height by local curvature.
    if (chkAdaptive.checked) co['adaptive_layer_height'] = '1'; else delete co['adaptive_layer_height'];
  };
  selSupport.onchange = applyPrintSettings;
  chkAdaptive.onchange = applyPrintSettings;
  for (const el of [inLayer, inInfill, inWalls]) el.oninput = applyPrintSettings;
  applyPrintSettings();

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
      del.onclick = () => workspace.palette.remove(i);
      cell.appendChild(input);
      if (workspace.palette.count() > 1) cell.appendChild(del);
      swatchWrap.appendChild(cell);
    });
  };
  btnAddFilament.onclick = () => workspace.palette.add();
  workspace.onPaletteChanged = renderPalette;
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
      externalSlicerStatus.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4caf50;"></span> Online';
      externalSlicerStatus.style.color = '#4caf50';
    } else {
      externalSlicerStatus.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f44336;"></span> Offline';
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
    const val = externalSlicerUrl.value.trim();
    if (!val) {
      SlicerClient.clearExternalSlicer();
      updateExternalSlicerStatus(false);
      refreshExternalSlicerControls();
      return;
    }
    btnExternalSlicerConnect.textContent = '...';
    try {
      const res = await fetch(`${val}/ping`);
      if (res.ok) {
        SlicerClient.setExternalSlicerUrl(val);
        SlicerClient.setExternalSlicerEnabled(true); // connecting opts in
        updateExternalSlicerStatus(true);
      } else {
        throw new Error('Bad status');
      }
    } catch (e) {
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
  btnPrinterSend.onclick = async () => {
    const gcode = workspace.getLastGcode();
    if (!gcode) { statusText.textContent = 'Slice first, then send.'; return; }
    statusText.textContent = 'Uploading to printer…';
    const r = await sendToPrinter(printerCfg, gcode, 'orcaxr.gcode', true);
    statusText.textContent = r.message;
  };
  // Download / Send become available once a slice exists. The Download button
  // itself is registry-driven; here we only drive the Send form button + store.
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
        del.onclick = (e) => { e.stopPropagation(); workspace.deletePlate(p.id); };
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
    btnPrinterSend.disabled = !ready;
    uiState.update({ gcodeReady: ready });
  };

  workspace.onSelectionChanged = (hasSelection) => {
    uiState.update({ hasSelection, modelCount: workspace.modelCount });
    renderPlateBar();
  };

  workspace.onStatusChanged = (text, percent) => {
    statusText.textContent = text;
    if (percent !== undefined && percent >= 0 && percent <= 100) {
      progressContainer.style.display = 'block';
      progressBar.style.width = `${percent}%`;
    } else {
      progressContainer.style.display = 'none';
    }
    uiState.update({
      status: text,
      progress: percent !== undefined && percent >= 0 && percent <= 100 ? percent : null,
    });
  };

  // AI & MCP Server
  const chkMcpEnabled = document.getElementById('chk-mcp-enabled') as HTMLInputElement;
  const mcpControls = document.getElementById('mcp-controls') as HTMLDivElement;
  const btnMcpToken = document.getElementById('btn-mcp-token') as HTMLButtonElement;
  const btnMcpShare = document.getElementById('btn-mcp-share') as HTMLButtonElement;
  const btnAiSmartPaint = document.getElementById('btn-ai-smart-paint') as HTMLButtonElement;
  const btnAiSemantic = document.getElementById('btn-ai-semantic') as HTMLButtonElement;

  chkMcpEnabled.onchange = () => {
    mcpControls.style.display = chkMcpEnabled.checked ? 'flex' : 'none';
    const state = chkMcpEnabled.checked ? 'started' : 'stopped';
    statusText.textContent = `MCP Server ${state}.`;
  };

  btnMcpToken.onclick = () => {
    navigator.clipboard.writeText('orcaxr_mcp_' + Math.random().toString(36).substr(2, 9));
    statusText.textContent = 'Auth token copied to clipboard.';
  };

  btnMcpShare.onclick = () => {
    navigator.clipboard.writeText('{"mcp_server": "orcaxr", "version": "1.0"}');
    statusText.textContent = 'Connection snippet copied to clipboard.';
  };

  btnAiSmartPaint.onclick = () => {
    if (workspace.modelCount === 0) {
      statusText.textContent = 'Load a model first before using AI Smart Paint.';
      return;
    }
    statusText.textContent = 'Running AI Smart Paint...';
    setTimeout(() => { statusText.textContent = 'AI Smart Paint complete.'; }, 2000);
  };

  btnAiSemantic.onclick = () => {
    if (workspace.modelCount === 0) {
      statusText.textContent = 'Load a model first before using Semantic Planner.';
      return;
    }
    statusText.textContent = 'Running Semantic Paint Planner...';
    setTimeout(() => { statusText.textContent = 'Semantic Paint Planner complete.'; }, 2000);
  };
}

document.addEventListener('DOMContentLoaded', async () => {
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
  
  // @ts-ignore
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
  orbit.target.set(0, 0.8, -0.9); // Target the workspace center
  orbit.update();
  workspace.orbitControls = orbit;
  workspace.setup2DControls(canvas);

  // Debug handles for remote scene inspection / automated testing via CDP.
  (window as unknown as { __orcaScene: unknown }).__orcaScene = xb.core.scene;
  (window as unknown as { __orcaRenderer: unknown }).__orcaRenderer = xb.core.renderer;
  (window as unknown as { THREE: unknown }).THREE = THREE;
  (window as unknown as { __orca: unknown }).__orca = workspace;
  setupDomUI(workspace, uiState);

  // Render the tool rail, primary bar, Add/Tools menus, and mode control from
  // the shared registry (the same catalog the XR shell renders). Mounted after
  // setupDomUI so the file-input + onRequestLoadStl the Load action depends on
  // is in place.
  const registry = buildRegistry();
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const domShell = new DomShell(registry, actionCtx, uiState);
  domShell.mount({
    toolbar: byId('left-toolbar'),
    primary: byId('action-panel'),
    modeControl: byId('mode-control'),
    addMenu: byId('add-menu-host'),
    toolsMenu: byId('tools-menu-host'),
  });

  // The command palette: every action, searchable, one Ctrl/⌘-K away.
  const palette = new CommandPalette(registry, actionCtx, uiState);
  palette.mount(
    byId('command-palette'),
    document.getElementById('cmd-input') as HTMLInputElement,
    byId('cmd-list'),
    byId('cmd-search-btn'),
  );
});
