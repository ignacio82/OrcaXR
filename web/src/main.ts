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

declare global {
  interface Window { ORCAXR_VERSION: string }
}
window.ORCAXR_VERSION = 'v31-filament-palette';

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace) {
// Inject error logger
const errDiv = document.createElement('div');
errDiv.style.position = 'fixed';
errDiv.style.bottom = '0';
errDiv.style.left = '0';
errDiv.style.width = '100%';
errDiv.style.maxHeight = '50%';
errDiv.style.overflow = 'auto';
errDiv.style.backgroundColor = 'rgba(100,0,0,0.8)';
errDiv.style.color = 'white';
errDiv.style.zIndex = '999999';
errDiv.style.fontFamily = 'monospace';
errDiv.style.fontSize = '12px';
errDiv.style.padding = '10px';
errDiv.style.pointerEvents = 'none';
document.body.appendChild(errDiv);

const oldError = console.error;
console.error = function(...args) {
  oldError.apply(console, args);
  const msg = args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');
  errDiv.innerHTML += msg + '<br/><hr/>';
};
window.addEventListener('error', e => {
  console.error(e.error ? e.error.stack : e.message);
});
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const btnLoad = document.getElementById('btn-load') as HTMLButtonElement;
  const btnSlice = document.getElementById('btn-slice') as HTMLButtonElement;
  const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
  const statusText = document.getElementById('status-text') as HTMLParagraphElement;
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
  const renderProfileSelects = () => {
    const o = workspace.getProfileOptions();
    fillSelect(selMachine, o.machines, o.machine);
    fillSelect(selProcess, o.processes, o.process);
    fillSelect(selFilament, o.filaments, o.filament);
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

  workspace.onDownloadReady = (ready) => {
    btnDownload.disabled = !ready;
  };

  btnDownload.onclick = () => {
    const gcode = workspace.getLastGcode();
    if (gcode) downloadGcode(gcode);
  };

  workspace.onStatusChanged = (text) => {
    statusText.textContent = text;
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
  options.setAppTitle('OrcaXR Web');
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
