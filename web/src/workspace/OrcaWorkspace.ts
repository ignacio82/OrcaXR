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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as xb from 'xrblocks';

import { bedSizeFromProfile, ProfileCatalog, SlicerProfile } from '../slicer/ProfileLoader';
import { SlicerClient } from '../slicer/SlicerClient';

/** Fallback bed until the profile catalog loads. */
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
  private catalog = new ProfileCatalog();
  private profile: SlicerProfile | null = null;
  /** Live bed size (mm) — from the active profile's printable_area. */
  private bedMm = { x: PLATE_MM, y: PLATE_MM };
  private plateAnchor = new THREE.Object3D();
  /** Everything spatial lives in this group: scaled up for legibility and
   *  re-posed in front of the user when the XR session starts. */
  private workspace = new THREE.Group();
  private models: { raw: THREE.BufferGeometry; display: THREE.Mesh; viewer: THREE.Object3D }[] = [];
  private statusText: { text: string } | null = null;
  private lastGcode: string | null = null;
  private needsRecenter = false;
  
  public orbitControls: OrbitControls | null = null;
  private transformControls: TransformControls | null = null;
  public onStatusChanged: ((text: string) => void) | null = null;
  public onDownloadReady: ((ready: boolean) => void) | null = null;

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
    // Load the profile catalog; default to the user's Centauri Carbon.
    void this.catalog.load().then(() => {
      const p =
        this.catalog.find('Centauri Carbon 0.4', '0.20mm Standard @Elegoo CC 0.4', 'PLA Matte') ??
        this.catalog.profiles[0] ?? null;
      if (p) this.setProfile(p);
    });
    this.slicer.onProgress = (p) => this.setStatus(`${p.percent}% ${p.message}`);

    this.workspace.position.set(0, PLATE_Y, PLATE_Z);
    xb.core.camera.position.set(0, PLATE_Y + 0.35, PLATE_Z + 0.55);
    xb.core.camera.lookAt(0, PLATE_Y + 0.03, PLATE_Z);

    // To guarantee transient user activation for the file picker, we must
    // trigger it synchronously from the native WebXR select event, not
    // from XRBlocks' async loop or SpatialPanel's onTriggered.
    xb.core.renderer.xr.addEventListener('sessionstart', () => {
      const session = xb.core.renderer.xr.getSession();
      session?.addEventListener('select', () => {
        this.checkLoadButtonAndTrigger();
      });
    });
  }

  public setup2DControls(canvas: HTMLCanvasElement) {
    this.transformControls = new TransformControls(xb.core.camera, canvas);
    this.transformControls.addEventListener('dragging-changed', (event) => {
      if (this.orbitControls) this.orbitControls.enabled = !event.value;
    });
    this.add(this.transformControls.getHelper());

    if (this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    } else {
      this.unselectModel();
    }

    this.setupSelectionRaycaster(canvas);
  }

  public selectModel(entry: { viewer: THREE.Object3D }) {
    if (this.transformControls && !xb.core.renderer.xr.isPresenting) {
      this.add(this.transformControls.getHelper());
      this.transformControls.attach(entry.viewer);
      this.transformControls.getHelper().visible = true;
      this.setTool(this.tool);
      this.setStatus(`Selected model`);
    }
  }

  public unselectModel() {
    if (this.transformControls) {
      this.transformControls.detach();
      this.transformControls.getHelper().visible = false;
      this.remove(this.transformControls.getHelper());
      this.setStatus('Model unselected');
    }
  }

  private setupSelectionRaycaster(canvas: HTMLCanvasElement) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0, downY = 0;

    canvas.addEventListener('pointerdown', (event) => {
      downX = event.clientX;
      downY = event.clientY;
    });

    canvas.addEventListener('pointerup', (event) => {
      if (xb.core.renderer.xr.isPresenting) return;
      if (this.transformControls && (this.transformControls as unknown as { dragging: boolean }).dragging) return;
      
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // It was a drag

      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, xb.core.camera);

      // Don't unselect if they clicked the transform gizmo directly
      if (this.transformControls && (this.transformControls as any).axis !== null) {
        return;
      }

      let hitModel = false;
      for (const entry of this.models) {
        const intersects = raycaster.intersectObject(entry.display, true);
        if (intersects.length > 0) {
          hitModel = true;
          this.selectModel(entry);
          break;
        }
      }

      if (!hitModel) {
        this.unselectModel();
      }
    });
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
    const halfX = (this.bedMm.x * MM * WORKSPACE_SCALE) / 2;
    const halfZ = (this.bedMm.y * MM * WORKSPACE_SCALE) / 2;
    if (this.tool === 'move') {
      entry.viewer.position.set(
        THREE.MathUtils.clamp(d.startPos.x + delta.x, -halfX, halfX),
        0,
        THREE.MathUtils.clamp(d.startPos.z + delta.z, -halfZ, halfZ),
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
    const halfX = (this.bedMm.x * MM * WORKSPACE_SCALE) / 2;
    const halfZ = (this.bedMm.y * MM * WORKSPACE_SCALE) / 2;
    for (const { viewer } of this.models) {
      viewer.position.y = 0;
      viewer.position.x = THREE.MathUtils.clamp(viewer.position.x, -halfX, halfX);
      viewer.position.z = THREE.MathUtils.clamp(viewer.position.z, -halfZ, halfZ);
    }
  }

  private setProfile(p: SlicerProfile) {
    this.profile = p;
    this.bedMm = bedSizeFromProfile(p.config);
    this.rebuildPlate();
    this.setStatus(`profile: ${p.displayName}\nbed ${this.bedMm.x}×${this.bedMm.y} mm`);
  }

  onXRSessionStarted() {
    // Head pose isn't valid yet on the session-start callback; recenter on
    // the next update tick.
    this.needsRecenter = true;
    
    // The TransformControls plane is infinite and invisible. If left in the scene,
    // it blocks ALL WebXR hand raycasts. We must physically remove it.
    if (this.transformControls) {
      this.transformControls.enabled = false;
      this.transformControls.detach();
      this.transformControls.getHelper().visible = false;
      this.remove(this.transformControls.getHelper());
    }
    
    // OrbitControls fights the WebXR camera. Disable it.
    if (this.orbitControls) {
      this.orbitControls.enabled = false;
    }

    // Enable XR drag for models
    for (const m of this.models) {
      (m.viewer as any).draggable = true;
      m.viewer.traverse((o) => { delete (o as any).draggingMode; });
    }

    if (this.panel) this.panel.visible = true;
  }

  onXRSessionEnded() {
    if (this.orbitControls) {
      this.orbitControls.enabled = true;
    }

    // Disable XR drag for models (rely on TransformControls in 2D)
    for (const m of this.models) {
      (m.viewer as any).draggable = false;
      m.viewer.traverse((o) => { (o as any).draggingMode = xb.DragManager.DO_NOT_DRAG; });
    }

    // Restore 2D selection
    if (this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    }

    if (this.panel) this.panel.visible = false;
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

  private plateParts = new THREE.Group();

  private addBuildPlate() {
    this.workspace.add(this.plateParts);
    this.rebuildPlate();

    // Anchor at the plate's top-center, carrying the visual magnification:
    // baking relativizes against it, so the scale cancels exactly.
    this.plateAnchor.position.set(0, 0, 0);
    this.plateAnchor.scale.setScalar(WORKSPACE_SCALE);
    this.workspace.add(this.plateAnchor);
    this.plateAnchor.updateMatrixWorld(true);
  }

  /** (Re)build plate/grid/grab-bar sized to the active profile's bed. */
  private rebuildPlate() {
    this.plateParts.clear();
    const sx = this.bedMm.x * MM * WORKSPACE_SCALE;
    const sz = this.bedMm.y * MM * WORKSPACE_SCALE;

    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(sx, 0.006, sz),
      new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.8 }),
    );
    plate.name = 'plate';
    plate.position.set(0, -0.003, 0);
    this.plateParts.add(plate);

    const grid = new THREE.GridHelper(Math.max(sx, sz), 8, 0x5a5f66, 0x3a3e44);
    grid.position.set(0, 0.0002, 0);
    grid.scale.set(sx / Math.max(sx, sz), 1, sz / Math.max(sx, sz));
    // Decorative only: line raycasting has a fat threshold and the grid
    // was swallowing nearly every pinch in the workspace (hit-probe v5).
    grid.raycast = () => {};
    this.plateParts.add(grid);

    // Grab bar on the front edge: DragManager translates the whole
    // workspace when it's pinched (draggable object + TRANSLATING child).
    const bar = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.012, sx * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xff6d00, roughness: 0.4 }),
    );
    bar.name = 'grabBar';
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.005, sz / 2 + 0.045);
    (bar as unknown as { draggingMode: unknown }).draggingMode = xb.DragManager.TRANSLATING;
    this.plateParts.add(bar);
    (this.workspace as unknown as { draggable: boolean }).draggable = true;
  }

  private async addStlModel(url: string, color: number) {
    const raw = await new STLLoader().loadAsync(url);
    this.library.push({ name: 'cube_20mm.stl', geometry: raw });
    this.addModelFromGeometry(raw, color);
    if (this.transformControls && this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    }
  }

  /** Model library: everything uploaded on the 2D page plus the default
   *  cube. The XR panel's swap button cycles through it. */
  private library: { name: string; geometry: THREE.BufferGeometry }[] = [];
  private libraryIndex = 0;
  /** Injected by main.ts: triggers the browser download of a gcode blob. */
  onDownloadGcode: ((gcode: string) => void) | null = null;
  /** Injected by main.ts: requests the browser to open the file picker. */
  onRequestLoadStl: (() => void) | null = null;

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
    if (this.transformControls && this.models.length > 0) {
      this.selectModel(this.models[0]);
    }
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
  private loadButtonNode: THREE.Object3D | null = null;

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
    panel.visible = false; // Hidden in 2D mode by default
    this.add(panel);
    this.panel = panel;

    const grid = panel.addGrid();
    this.statusText = grid.addRow({ weight: 0.3 }).addText({
      text: 'OrcaXR v13 — pick a tool, then\npinch-drag the model.',
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
    const loadButton = ctrl
      .addCol({ weight: 1 / 5 })
      .addIconButton({ text: 'upload_file', fontSize: 0.42 });
    this.loadButtonNode = loadButton as unknown as THREE.Object3D;
    (loadButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      // Fallback: mostly ignored because the native select hook catches it first,
      // but left here in case the user clicks via Desktop simulator (mouse).
      if (this.onRequestLoadStl) this.onRequestLoadStl();
    };
    const swapButton = ctrl
      .addCol({ weight: 1 / 5 })
      .addIconButton({ text: 'swap_horiz', fontSize: 0.42 });
    (swapButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      this.cycleModel();
    };
    const sliceButton = ctrl
      .addCol({ weight: 1 / 5 })
      .addIconButton({ text: 'play_circle', fontSize: 0.5 });
    (sliceButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      void this.sliceNow();
    };
    const dlButton = ctrl
      .addCol({ weight: 1 / 5 })
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
      .addCol({ weight: 1 / 5 })
      .addIconButton({ text: 'logout', fontSize: 0.42 });
    (exitButton as unknown as { onTriggered: () => void }).onTriggered = () => {
      // End the immersive session — back to the 2D page (Load STL /
      // Download G-code live there; downloads flush on exit).
      void xb.core.renderer.xr.getSession()?.end();
    };
    panel.updateLayouts();
    this.refreshToolButtons();
  }

  public setTool(tool: 'move' | 'rotate' | 'scale') {
    this.tool = tool;
    this.refreshToolButtons();
    this.setStatus(`tool: ${tool} — pinch-drag the model`);
    
    if (this.transformControls) {
      if (tool === 'move') this.transformControls.setMode('translate');
      else if (tool === 'rotate') this.transformControls.setMode('rotate');
      else if (tool === 'scale') this.transformControls.setMode('scale');
    }
  }

  private checkLoadButtonAndTrigger() {
    if (!this.loadButtonNode || !this.onRequestLoadStl) return;
    const input = xb.core.input as unknown as {
      intersectionsForController: Map<unknown, THREE.Intersection[]>;
    };
    for (const ints of input.intersectionsForController.values()) {
      const hitLoad = ints.some(i => {
        let o: THREE.Object3D | null = i.object;
        while (o) {
          if (o === this.loadButtonNode) return true;
          o = o.parent;
        }
        return false;
      });
      if (hitLoad) {
        // Browsers strictly suppress HTML dialogs like file pickers while inside
        // an immersive WebXR session. We must end the session to return to the
        // 2D compositor, then immediately trigger the picker.
        const session = xb.core.renderer.xr.getSession();
        if (session) {
          void session.end().then(() => {
            this.onRequestLoadStl?.();
          });
        } else {
          this.onRequestLoadStl?.();
        }
        return;
      }
    }
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
    if (this.onStatusChanged) {
      this.onStatusChanged(text);
    }
    console.log('[orcaxr-web]', text);
  }

  public async sliceNow() {
    if (this.slicer.isSlicing) return;
    const entry = this.models[0];
    if (!entry) return;
    try {
      this.setStatus('baking transforms…');
      const stl = this.bakeToPrinterStl(entry.display);
      this.setStatus('slicing…');
      const t0 = performance.now();
      const gcode = await this.slicer.slice(stl, 4, this.profile?.config ?? {});
      const ms = Math.round(performance.now() - t0);
      this.lastGcode = gcode;
      if (this.onDownloadReady) this.onDownloadReady(true);
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
      1000, 0, 0, this.bedMm.x / 2,
      0, 0, -1000, this.bedMm.y / 2,
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
