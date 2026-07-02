/**
 * OrcaXR Web — entry point.
 *
 * Phase 2: build-plate workspace with DragManager model manipulation and
 * the libslic3r WASM module slicing the live scene (see OrcaWorkspace).
 */
import 'xrblocks/addons/simulator/SimulatorAddons.js';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import * as xb from 'xrblocks';

import { OrcaWorkspace } from './workspace/OrcaWorkspace';

declare global {
  interface Window { ORCAXR_VERSION: string }
}
window.ORCAXR_VERSION = 'v12-library-label';

/** 2D-page toolbar: load an STL before entering XR; download the last
 *  G-code after slicing (both impossible from inside the XR session). */
function setupDomBar(workspace: OrcaWorkspace) {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;top:12px;left:12px;z-index:30;display:flex;gap:8px;' +
    'font-family:sans-serif;';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.stl';
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  const mkButton = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'padding:10px 16px;border:none;border-radius:8px;background:#ff6d00;' +
      'color:#000;font-size:15px;cursor:pointer;';
    return b;
  };

  const loadBtn = mkButton('Load STL…');
  loadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files ?? []);
    for (const file of files) {
      const buf = await file.arrayBuffer();
      try {
        const geometry = new STLLoader().parse(buf);
        workspace.loadModelFromGeometry(geometry, file.name);
        loadBtn.textContent = file.name;
      } catch (e) {
        loadBtn.textContent = `failed: ${(e as Error).message}`.slice(0, 40);
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

  const dlBtn = mkButton('Download G-code');
  dlBtn.style.background = '#4fc3f7';
  dlBtn.onclick = () => {
    const gcode = workspace.getLastGcode();
    if (!gcode) {
      dlBtn.textContent = 'No G-code yet — slice first';
      setTimeout(() => (dlBtn.textContent = 'Download G-code'), 1800);
      return;
    }
    downloadGcode(gcode);
  };

  bar.append(loadBtn, dlBtn, fileInput);
  document.body.append(bar);
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
  // Debug handle for remote scene inspection via CDP.
  (window as unknown as { __orcaScene: unknown }).__orcaScene = xb.core.scene;
  setupDomBar(workspace);
});
