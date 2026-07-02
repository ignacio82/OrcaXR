/**
 * OrcaXR Web — Phase 2 workspace.
 *
 * A build plate with a manipulable model (XR Blocks DragManager: pinch
 * the platform to move, the model to rotate, two hands to scale) and a
 * spatial panel that drives the WASM slicer. On "slice" the model's
 * CURRENT world pose is baked into printer coordinates and sliced —
 * what you see is exactly what slices.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import * as xb from 'xrblocks';

import { SlicerClient } from '../slicer/SlicerClient';

/** Default slicer profile bed is 200×200 mm (real profiles land in Phase 3). */
const PLATE_MM = 200;
const MM = 0.001;
/** Visual magnification of the whole workspace: true-scale 3D-print beds
 *  read tiny in XR. Uniform, so transform baking cancels it exactly. */
const WORKSPACE_SCALE = 1.75;
/** Fallback pose before the XR session gives us a head pose. */
const PLATE_Y = 0.8;
const PLATE_Z = -0.9;

export class OrcaWorkspace extends xb.Script {
  private slicer = new SlicerClient();
  private plateAnchor = new THREE.Object3D();
  /** Everything spatial lives in this group: scaled up for legibility and
   *  re-posed in front of the user when the XR session starts. */
  private workspace = new THREE.Group();
  private models: { raw: THREE.BufferGeometry; display: THREE.Mesh; viewer: THREE.Object3D }[] = [];
  private statusText: { text: string } | null = null;
  private lastGcode: string | null = null;
  private needsRecenter = false;

  async init() {
    xb.core.input.addReticles();
    this.addLights();
    // NOTE: the group is NOT scaled — XR Blocks' DragManager (platform
    // translate, rotation cylinder, panel pinch) breaks inside scaled
    // ancestors. Sizes are multiplied by WORKSPACE_SCALE directly.
    this.add(this.workspace);
    this.addBuildPlate();
    this.addControlPanel();
    await this.addStlModel('/models/cube_20mm.stl', 0x4fc3f7);
    // Warm the slicer module in the background so the first slice is quick.
    this.slicer.load().catch((e) => this.setStatus(`slicer load failed: ${e.message}`));
    this.slicer.onProgress = (p) => this.setStatus(`${p.percent}% ${p.message}`);

    this.workspace.position.set(0, PLATE_Y, PLATE_Z);
    xb.core.camera.position.set(0, PLATE_Y + 0.35, PLATE_Z + 0.55);
    xb.core.camera.lookAt(0, PLATE_Y + 0.03, PLATE_Z);
  }

  private tool: 'move' | 'rotate' | 'scale' = 'move';
  private drag: {
    controller: THREE.Object3D;
    startControllerLocal: THREE.Vector3;
    startPos: THREE.Vector3;
    startRotY: number;
    startScale: number;
  } | null = null;

  /** Modal manipulation: a pinch that lands anywhere on the model starts
   *  a drag whose meaning is the active tool (OrcaSlicer-style). */
  onSelectStart(event: { target: unknown }) {
    const input = xb.core.input as unknown as {
      intersectionsForController: Map<unknown, THREE.Intersection[]>;
    };
    const ints = input.intersectionsForController.get(event.target) ?? [];
    console.log('[orcaxr-hit]', ints.slice(0, 3)
      .map((i) => `${i.object.name || i.object.type}@${i.distance.toFixed(2)}`)
      .join(' | ') || 'NOTHING');
    const first = ints[0];
    if (!first) return;
    const entry = this.models.find(({ viewer }) => {
      let o: THREE.Object3D | null = first.object;
      while (o) {
        if (o === viewer) return true;
        o = o.parent;
      }
      return false;
    });
    if (!entry) return;
    const controller = event.target as THREE.Object3D;
    const startControllerLocal = this.workspace.worldToLocal(
      controller.getWorldPosition(new THREE.Vector3()),
    );
    this.drag = {
      controller,
      startControllerLocal,
      startPos: entry.viewer.position.clone(),
      startRotY: entry.viewer.rotation.y,
      startScale: entry.viewer.scale.x,
    };
  }

  onSelecting(event: { target: unknown }) {
    const d = this.drag;
    if (!d || event.target !== d.controller) return;
    const entry = this.models[0];
    if (!entry) return;
    const local = this.workspace.worldToLocal(
      d.controller.getWorldPosition(new THREE.Vector3()),
    );
    const delta = local.clone().sub(d.startControllerLocal);
    const half = (PLATE_MM * MM * WORKSPACE_SCALE) / 2;
    if (this.tool === 'move') {
      entry.viewer.position.set(
        THREE.MathUtils.clamp(d.startPos.x + delta.x, -half, half),
        0,
        THREE.MathUtils.clamp(d.startPos.z + delta.z, -half, half),
      );
      this.showValues(`x ${(entry.viewer.position.x / (MM * WORKSPACE_SCALE)).toFixed(1)}  y ${(-entry.viewer.position.z / (MM * WORKSPACE_SCALE)).toFixed(1)} mm`);
    } else if (this.tool === 'rotate') {
      // Horizontal hand sweep = yaw: 25 cm of travel = a full turn.
      entry.viewer.rotation.y = d.startRotY + (delta.x / 0.25) * Math.PI * 2;
      this.showValues(`rotZ ${((entry.viewer.rotation.y * 180) / Math.PI % 360).toFixed(0)}°`);
    } else {
      // Vertical hand travel = scale: +25 cm doubles, −25 cm halves.
      const f = Math.pow(2, delta.y / 0.25);
      const sNew = THREE.MathUtils.clamp(d.startScale * f, 0.05, 20);
      entry.viewer.scale.setScalar(sNew);
      this.showValues(`scale ${(sNew * 100).toFixed(0)}%`);
    }
  }

  /** After any drag ends, keep models seated on the plate and inside it. */
  onSelectEnd() {
    this.drag = null;
    const half = (PLATE_MM * MM * WORKSPACE_SCALE) / 2;
    for (const { viewer } of this.models) {
      viewer.position.y = 0;
      viewer.position.x = THREE.MathUtils.clamp(viewer.position.x, -half, half);
      viewer.position.z = THREE.MathUtils.clamp(viewer.position.z, -half, half);
    }
  }

  onXRSessionStarted() {
    // Head pose isn't valid yet on the session-start callback; recenter on
    // the next update tick.
    this.needsRecenter = true;
  }

  onSimulatorStarted() {
    this.needsRecenter = true;
  }

  update() {
    if (this.needsRecenter) {
      const cam = xb.core.camera;
      if (cam.position.lengthSq() > 1e-6) {
        this.needsRecenter = false;
        this.recenterInFrontOfUser();
      }
    }
  }

  /** Park the plate ~0.85 m ahead of the head, 0.45 m below eye level,
   *  facing the user — like the Android app's workspace placement. */
  private recenterInFrontOfUser() {
    const cam = xb.core.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const pos = cam.getWorldPosition(new THREE.Vector3())
      .addScaledVector(fwd, 0.85);
    pos.y = Math.max(cam.getWorldPosition(new THREE.Vector3()).y - 0.45, 0.35);
    this.workspace.position.copy(pos);
    const yaw = Math.atan2(fwd.x, fwd.z) + Math.PI;
    this.workspace.rotation.set(0, yaw, 0);
    this.workspace.updateMatrixWorld(true);

    // Park the panel to the right of the plate, raised, facing the user.
    if (this.panel) {
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).negate();
      const ppos = pos.clone().addScaledVector(right, -0.45);
      ppos.y = pos.y + 0.28;
      ppos.addScaledVector(fwd, -0.05);
      this.panel.position.copy(ppos);
      this.panel.rotation.set(0, yaw, 0);
      this.panel.updateMatrixWorld(true);
    }
  }

  private addLights() {
    this.add(new THREE.HemisphereLight(0xbbbbbb, 0x888888, 3));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(0.5, 2, 0.5);
    this.add(light);
  }

  private addBuildPlate() {
    const size = PLATE_MM * MM * WORKSPACE_SCALE;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.006, size),
      new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.8 }),
    );
    plate.name = 'plate';
    plate.position.set(0, -0.003, 0);
    this.workspace.add(plate);

    const grid = new THREE.GridHelper(size, 8, 0x5a5f66, 0x3a3e44);
    grid.position.set(0, 0.0002, 0);
    // Decorative only: line raycasting has a fat threshold and the grid
    // was swallowing nearly every pinch in the workspace (hit-probe v5).
    grid.raycast = () => {};
    this.workspace.add(grid);

    // Grab bar on the front edge: DragManager translates the whole
    // workspace when it's pinched (draggable object + TRANSLATING child).
    const bar = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.012, size * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xff6d00, roughness: 0.4 }),
    );
    bar.name = 'grabBar';
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.005, size / 2 + 0.045);
    (bar as unknown as { draggingMode: unknown }).draggingMode = xb.DragManager.TRANSLATING;
    this.workspace.add(bar);
    (this.workspace as unknown as { draggable: boolean }).draggable = true;

    // Anchor at the plate's top-center, carrying the visual magnification:
    // baking relativizes against it, so the scale cancels exactly.
    this.plateAnchor.position.set(0, 0, 0);
    this.plateAnchor.scale.setScalar(WORKSPACE_SCALE);
    this.workspace.add(this.plateAnchor);
    this.plateAnchor.updateMatrixWorld(true);
  }

  private async addStlModel(url: string, color: number) {
    const raw = await new STLLoader().loadAsync(url);
    this.library.push({ name: 'cube_20mm.stl', geometry: raw });
    this.addModelFromGeometry(raw, color);
  }

  /** Model library: everything uploaded on the 2D page plus the default
   *  cube. The XR panel's swap button cycles through it. */
  private library: { name: string; geometry: THREE.BufferGeometry }[] = [];
  private libraryIndex = 0;
  /** Injected by main.ts: triggers the browser download of a gcode blob. */
  onDownloadGcode: ((gcode: string) => void) | null = null;

  /** Replace the current model with [raw] (STL geometry: mm, Z-up). */
  loadModelFromGeometry(raw: THREE.BufferGeometry, name: string) {
    this.library.push({ name, geometry: raw });
    this.libraryIndex = this.library.length - 1;
    this.showLibraryModel();
  }

  private showLibraryModel() {
    const entry = this.library[this.libraryIndex];
    if (!entry) return;
    for (const { viewer } of this.models) {
      this.workspace.remove(viewer);
    }
    this.models.length = 0;
    this.addModelFromGeometry(entry.geometry, 0x4fc3f7);
    this.setStatus(
      `model ${this.libraryIndex + 1}/${this.library.length}: ${entry.name}\n` +
      '(swap cycles files loaded on the 2D page)',
    );
  }

  private cycleModel() {
    if (this.library.length === 0) return;
    this.libraryIndex = (this.libraryIndex + 1) % this.library.length;
    this.showLibraryModel();
  }

  getLastGcode(): string | null {
    return this.lastGcode;
  }

  private addModelFromGeometry(raw: THREE.BufferGeometry, color: number) {
    raw.computeVertexNormals();

    const mesh = new THREE.Mesh(
      raw,
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
    );
    mesh.name = 'modelMesh';
    // STL is mm / Z-up; display is meters / Y-up, magnified.
    const vis = MM * WORKSPACE_SCALE;
    mesh.scale.setScalar(vis);
    mesh.rotation.x = -Math.PI / 2;
    raw.computeBoundingBox();
    const bb = raw.boundingBox!;
    mesh.position.set(
      (-(bb.min.x + bb.max.x) / 2) * vis,
      -bb.min.z * vis,
      ((bb.min.y + bb.max.y) / 2) * vis,
    );

    const model = new xb.ModelViewer({});
    model.add(mesh);
    model.setupBoundingBox();
    // Big cylindrical raycast target around the model — the one grab
    // surface. What a drag DOES is decided by the active tool (modal,
    // like OrcaSlicer's toolbar), so no competing colliders exist.
    model.setupRaycastCylinder();
    model.position.set(0, 0, 0);
    // Disable XR Blocks' own drag semantics on the model — the modal
    // tool logic in onSelectStart/onSelecting owns manipulation.
    (model as unknown as { draggable: boolean }).draggable = false;
    model.traverse((o) => {
      (o as unknown as { draggingMode: unknown }).draggingMode = xb.DragManager.DO_NOT_DRAG;
    });
    this.workspace.add(model);
    this.models.push({ raw, display: mesh, viewer: model });
  }

  private panel: InstanceType<typeof xb.SpatialPanel> | null = null;

  private toolButtons: { tool: 'move' | 'rotate' | 'scale'; btn: { fontColor: string | number } }[] = [];
  private valueText: { text: string } | null = null;

  private addControlPanel() {
    // Size via panel options — scaling the panel object desyncs its
    // internal view hit-rects (v5: button pinches only ever hit PanelMesh).
    const panel = new xb.SpatialPanel({
      backgroundColor: '#20242baa',
      width: 0.52,
      height: 0.42,
      useDefaultPosition: false,
    });
    panel.isRoot = true;
    panel.position.set(0.45, PLATE_Y + 0.25, PLATE_Z + 0.1);
    this.add(panel);
    this.panel = panel;

    const grid = panel.addGrid();
    this.statusText = grid.addRow({ weight: 0.3 }).addText({
      text: 'OrcaXR v12 — pick a tool, then\npinch-drag the model.',
      fontColor: '#ffffff',
      fontSize: 0.05,
    }) as unknown as { text: string };
    this.valueText = grid.addRow({ weight: 0.18 }).addText({
      text: '',
      fontColor: '#ffb74d',
      fontSize: 0.055,
    }) as unknown as { text: string };

    const tools = grid.addRow({ weight: 0.3 });
    const mk = (tool: 'move' | 'rotate' | 'scale', icon: string) => {
      const btn = tools
        .addCol({ weight: 1 / 3 })
        .addIconButton({ text: icon, fontSize: 0.42 }) as unknown as {
        fontColor: string | number;
        onTriggered: () => void;
      };
      btn.onTriggered = () => this.setTool(tool);
      this.toolButtons.push({ tool, btn });
    };
    mk('move', 'open_with');
    mk('rotate', 'rotate_right');
    mk('scale', 'open_in_full');

    const ctrl = grid.addRow({ weight: 0.22 });
    const swapButton = ctrl
      .addCol({ weight: 1 / 4 })
      .addIconButton({ text: 'swap_horiz', fontSize: 0.42 });
    (swapButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      this.cycleModel();
    };
    const sliceButton = ctrl
      .addCol({ weight: 1 / 4 })
      .addIconButton({ text: 'play_circle', fontSize: 0.5 });
    (sliceButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      void this.sliceNow();
    };
    const dlButton = ctrl
      .addCol({ weight: 1 / 4 })
      .addIconButton({ text: 'download', fontSize: 0.42 });
    (dlButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      if (this.lastGcode && this.onDownloadGcode) {
        this.onDownloadGcode(this.lastGcode);
        this.setStatus('G-code download queued —\ncheck Downloads after exiting XR.');
      } else {
        this.setStatus('No G-code yet — slice first.');
      }
    };
    const exitButton = ctrl
      .addCol({ weight: 1 / 4 })
      .addIconButton({ text: 'logout', fontSize: 0.42 });
    (exitButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      // End the immersive session — back to the 2D page (Load STL /
      // Download G-code live there; downloads flush on exit).
      void xb.core.renderer.xr.getSession()?.end();
    };
    panel.updateLayouts();
    this.refreshToolButtons();
  }

  private setTool(tool: 'move' | 'rotate' | 'scale') {
    this.tool = tool;
    this.refreshToolButtons();
    this.setStatus(`tool: ${tool} — pinch-drag the model`);
  }

  private refreshToolButtons() {
    for (const { tool, btn } of this.toolButtons) {
      btn.fontColor = tool === this.tool ? '#ff6d00' : '#ffffff';
    }
  }

  private showValues(text: string) {
    if (this.valueText) this.valueText.text = text;
  }

  private setStatus(text: string) {
    if (this.statusText) {
      this.statusText.text = text;
    }
    console.log('[orcaxr-web]', text);
  }

  private async sliceNow() {
    if (this.slicer.isSlicing) return;
    const entry = this.models[0];
    if (!entry) return;
    try {
      this.setStatus('baking transforms…');
      const stl = this.bakeToPrinterStl(entry.display);
      this.setStatus('slicing…');
      const t0 = performance.now();
      const gcode = await this.slicer.slice(stl);
      const ms = Math.round(performance.now() - t0);
      this.lastGcode = gcode;
      const lines = gcode.split('\n').length;
      const layers = (gcode.match(/; CHANGE_LAYER|;LAYER_CHANGE/g) ?? []).length;
      this.setStatus(`SLICED in ${ms} ms\n${(gcode.length / 1024).toFixed(0)} KB, ${lines} lines, ${layers} layers`);
      console.log('[orcaxr-web] gcode head:\n' + gcode.slice(0, 600));
    } catch (e) {
      this.setStatus(`slice failed: ${(e as Error).message}`);
    }
  }

  /**
   * Bake the display mesh's CURRENT world pose into a binary STL in
   * printer coordinates: mm, Z-up, bed origin at the plate corner with
   * the model dropped onto Z=0.
   */
  private bakeToPrinterStl(display: THREE.Mesh): ArrayBuffer {
    display.updateMatrixWorld(true);
    this.plateAnchor.updateMatrixWorld(true);

    // Display-world → plate-local (meters, Y-up).
    const rel = new THREE.Matrix4()
      .copy(this.plateAnchor.matrixWorld)
      .invert()
      .multiply(display.matrixWorld);

    // Plate-local meters (Y-up) → printer mm (Z-up):
    // (x, y, z) → (x·1000, −z·1000, y·1000), then shift to bed center.
    const conv = new THREE.Matrix4().set(
      1000, 0, 0, PLATE_MM / 2,
      0, 0, -1000, PLATE_MM / 2,
      0, 1000, 0, 0,
      0, 0, 0, 1,
    );

    const geo = (display.geometry as THREE.BufferGeometry).clone();
    geo.applyMatrix4(rel);
    geo.applyMatrix4(conv);

    // Drop onto the bed.
    geo.computeBoundingBox();
    const minZ = geo.boundingBox!.min.z;
    geo.translate(0, 0, -minZ);

    return writeBinaryStl(geo);
  }
}

/** Minimal binary STL writer (non-indexed triangles, recomputed normals). */
function writeBinaryStl(geometry: THREE.BufferGeometry): ArrayBuffer {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.getAttribute('position');
  const triCount = pos.count / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    n.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    for (const v of [n, a, b, c]) {
      dv.setFloat32(off, v.x, true);
      dv.setFloat32(off + 4, v.y, true);
      dv.setFloat32(off + 8, v.z, true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}
