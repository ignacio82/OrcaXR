/**
 * OrcaXR Web — entry point.
 *
 * Phase 2: build-plate workspace with DragManager model manipulation and
 * the libslic3r WASM module slicing the live scene (see OrcaWorkspace).
 */
import 'xrblocks/addons/simulator/SimulatorAddons.js';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as xb from 'xrblocks';

import { OrcaWorkspace } from './workspace/OrcaWorkspace';

declare global {
  interface Window { ORCAXR_VERSION: string }
}
window.ORCAXR_VERSION = 'v13-real-profiles';

/** 2D-page UI wiring for standard web slicer mode. */
function setupDomUI(workspace: OrcaWorkspace) {
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
        const geometry = new STLLoader().parse(buf);
        workspace.loadModelFromGeometry(geometry, file.name);
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
  const workspace = new OrcaWorkspace();
  xb.add(workspace);
  await xb.init(options);

  // Setup OrbitControls for 2D mode navigation
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const orbit = new OrbitControls(xb.core.camera, canvas);
  orbit.target.set(0, 0.8, -0.9); // Target the workspace center
  orbit.update();
  workspace.orbitControls = orbit;
  workspace.setup2DControls(canvas);

  // Debug handle for remote scene inspection via CDP.
  (window as unknown as { __orcaScene: unknown }).__orcaScene = xb.core.scene;
  setupDomUI(workspace);
});
