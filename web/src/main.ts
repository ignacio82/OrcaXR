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
import { loadPrinterConfig, probePrinter, savePrinterConfig, sendToPrinter } from './net/PrinterClient';

declare global {
  interface Window { ORCAXR_VERSION: string }
}
window.ORCAXR_VERSION = 'v33-brush-paint';

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace) {

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const btnLoad = document.getElementById('btn-load') as HTMLButtonElement;
  const btnSlice = document.getElementById('btn-slice') as HTMLButtonElement;
  const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
  const statusText = document.getElementById('status-text') as HTMLParagraphElement;
  const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
  const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
  const btnMove = document.getElementById('btn-move') as HTMLButtonElement;
  const btnRotate = document.getElementById('btn-rotate') as HTMLButtonElement;
  const btnScale = document.getElementById('btn-scale') as HTMLButtonElement;

  btnLoad.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files ?? []);
    for (const file of files) {
      const buf = await file.arrayBuffer();
      try {
        const lowerName = file.name.toLowerCase();
        console.log(`[main.ts] Uploaded file: ${file.name}, lowerName: ${lowerName}`);
        if (lowerName.endsWith('.3mf')) {
          const colors = await extract3mfColors(buf);
          const group = new ThreeMFLoader().parse(buf);
          workspace.loadModelFromGroup(group, file.name, colors || undefined);
        } else {
          const geometry = new STLLoader().parse(buf);
          workspace.loadModelFromGeometry(geometry, file.name);
        }
      } catch (e) {
        statusText.textContent = `Failed to load: ${(e as Error).message}`;
      }
    }
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

  btnSlice.onclick = () => {
    void workspace.sliceNow();
  };

  const btnPreview = document.getElementById('btn-preview') as HTMLButtonElement;
  btnPreview.onclick = () => workspace.togglePreview();

  // Profile pickers: mirror the XR panel's machine/process/filament cyclers.
  const selMachine = document.getElementById('sel-machine') as HTMLSelectElement;
  const selProcess = document.getElementById('sel-process') as HTMLSelectElement;
  const selFilament = document.getElementById('sel-filament') as HTMLSelectElement;
  const fillSelect = (sel: HTMLSelectElement, items: string[], current: string) => {
    sel.innerHTML = '';
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

    headsPanel.innerHTML = '';
    const exCount = workspace.extruderCount;
    const totalCount = workspace.palette.count();

    if (exCount > 1) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'action-btn';
      syncBtn.style.cssText = 'background: #2E7D32; color: white; border: none; padding: 8px; margin-bottom: 8px; border-radius: 8px; cursor: pointer; font-size: 13px; width: 100%;';
      syncBtn.textContent = 'Sync with Printer';
      syncBtn.onclick = () => {
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         (workspace as any).setStatus('Synced filaments from printer!');
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
  btnPrinterTest.onclick = async () => {
    statusText.textContent = 'Testing printer connection…';
    const r = await probePrinter(printerCfg);
    statusText.textContent = r.message;
  };
  btnPrinterSend.onclick = async () => {
    const gcode = workspace.getLastGcode();
    if (!gcode) { statusText.textContent = 'Slice first, then send.'; return; }
    statusText.textContent = 'Uploading to printer…';
    const r = await sendToPrinter(printerCfg, gcode, 'orcaxr.gcode', true);
    statusText.textContent = r.message;
  };
  // Enable Send only once a slice exists.
  const prevDownloadReady = workspace.onDownloadReady;
  workspace.onDownloadReady = (ready) => {
    if (prevDownloadReady) prevDownloadReady(ready);
    btnPrinterSend.disabled = !ready;
  };

  workspace.onDownloadReady = (ready) => {
    btnDownload.disabled = !ready;
  };

  btnDownload.onclick = () => {
    const gcode = workspace.getLastGcode();
    if (gcode) downloadGcode(gcode);
  };

  workspace.onStatusChanged = (text, percent) => {
    statusText.textContent = text;
    if (percent !== undefined && percent >= 0 && percent <= 100) {
      progressContainer.style.display = 'block';
      progressBar.style.width = `${percent}%`;
    } else {
      progressContainer.style.display = 'none';
    }
  };

  const setTool = (tool: 'move' | 'rotate' | 'scale', btn: HTMLButtonElement) => {
    btnMove.classList.remove('active');
    btnRotate.classList.remove('active');
    btnScale.classList.remove('active');
    btn.classList.add('active');
    workspace.setTool(tool);
  };

  btnMove.onclick = () => setTool('move', btnMove);
  btnRotate.onclick = () => setTool('rotate', btnRotate);
  btnScale.onclick = () => setTool('scale', btnScale);
}

document.addEventListener('DOMContentLoaded', async () => {
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
  setupDomUI(workspace);
});
