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
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import * as xb from 'xrblocks';
// @ts-ignore
import { UICore, UIPanel, UIText, UIIcon, raycastSortFunction, ManipulationBehavior } from 'xrblocks/addons/uiblocks/src/index.js';

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
  private uiCore: any;
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

  constructor() {
    super();
    this.uiCore = new UICore(this);
  }

  async init() {
    if (xb.core.input.raycaster) {
      xb.core.input.raycaster.sortFunction = raycastSortFunction;
    }
    xb.core.input.addReticles();
    
    // Bind interaction events
    xb.core.input.controllers.forEach((controller: any) => {
      controller.addEventListener('selectstart', (e: any) => this.onSelectStart(e));
      controller.addEventListener('select', (e: any) => this.onSelecting(e));
      controller.addEventListener('selectend', () => this.onSelectEnd());
    });
    
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
          if (this.tool === 'lay_on_face' && intersects[0].face) {
            this.layOnFace(entry, intersects[0].face.normal, intersects[0].object);
            this.setTool('move');
          } else {
            this.selectModel(entry);
          }
          break;
        }
      }

      if (!hitModel) {
        this.unselectModel();
      }
    });
  }

  private tool: 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint' = 'move';
  private activePaintColor = new THREE.Color(0xff0000); // Default to red
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
    
    // Do nothing if we hit a UI panel! (Otherwise clicking a UI button unselects the model)
    const hitUI = ints.some(i => {
      let isUi = false;
      i.object.traverseAncestors(a => {
        if (a.name === 'LeftToolbar' || a.name === 'RightSidebar') isUi = true;
      });
      return isUi || i.object.name === 'LeftToolbar' || i.object.name === 'RightSidebar';
    });
    if (hitUI) return;

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

    if (this.tool === 'lay_on_face' && first.face) {
      this.layOnFace(entry, first.face.normal, first.object);
      this.setTool('move');
      return;
    }

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
    if (this.tool === 'paint') {
      const controller = event.target as THREE.Object3D;
      const raycaster = new THREE.Raycaster();
      const tempMatrix = new THREE.Matrix4().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

      const meshes = this.models.map(m => m.viewer.getObjectByName('modelMesh')).filter(Boolean) as THREE.Mesh[];
      const hits = raycaster.intersectObjects(meshes, false);
      const meshHit = hits[0];

      if (meshHit && meshHit.face) {
        const geom = meshHit.object.geometry as THREE.BufferGeometry;
        const colorAttr = geom.getAttribute('color') as THREE.BufferAttribute;
        
        // Paint the hit triangle and its neighbors within a small radius (brush size)
        // For simplicity right now we'll just paint the exact triangle hit.
        const face = meshHit.face;
        const r = this.activePaintColor.r;
        const g = this.activePaintColor.g;
        const b = this.activePaintColor.b;
        
        colorAttr.setXYZ(face.a, r, g, b);
        colorAttr.setXYZ(face.b, r, g, b);
        colorAttr.setXYZ(face.c, r, g, b);
        colorAttr.needsUpdate = true;
      }
      return;
    }

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
    } else if (this.tool === 'scale') {
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

  /** Distinct machine names in catalog order. */
  private machineChoices(): string[] {
    return [...new Set(this.catalog.profiles.map((p) => p.machineName))];
  }

  /** Processes compatible with the machine (same nozzle-size token). */
  private processChoices(machine: string): string[] {
    const nozzle = /0\.\d+/.exec(machine)?.[0] ?? '';
    return [...new Set(
      this.catalog.profiles
        .filter((p) => p.machineName === machine && (!nozzle || p.processName.includes(nozzle)))
        .map((p) => p.processName),
    )];
  }

  private filamentChoices(machine: string): string[] {
    return [...new Set(
      this.catalog.profiles
        .filter((p) => p.machineName === machine)
        .map((p) => p.filamentName),
    )];
  }

  /** Cycle one dimension of the profile triple (public: panel + tests). */
  cycleProfilePart(part: 'machine' | 'process' | 'filament') {
    const cur = this.profile;
    if (!cur) return;
    const cycle = (list: string[], val: string) =>
      list[(Math.max(0, list.indexOf(val)) + 1) % Math.max(1, list.length)] ?? val;
    let machine = cur.machineName;
    let process = cur.processName;
    let filament = cur.filamentName;
    if (part === 'machine') {
      machine = cycle(this.machineChoices(), machine);
      process = this.processChoices(machine)[0] ?? process;
      filament = this.filamentChoices(machine)[0] ?? filament;
    } else if (part === 'process') {
      process = cycle(this.processChoices(machine), process);
    } else {
      filament = cycle(this.filamentChoices(machine), filament);
    }
    const next = this.catalog.profiles.find(
      (x) => x.machineName === machine && x.processName === process && x.filamentName === filament,
    ) ?? this.catalog.find(machine, process, filament);
    if (next) this.setProfile(next);
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

    if (this.leftToolbarCard) this.leftToolbarCard.show();
    if (this.rightSidebarCard) this.rightSidebarCard.show();
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

    if (this.leftToolbarCard) this.leftToolbarCard.hide();
    if (this.rightSidebarCard) this.rightSidebarCard.hide();
  }

  onSimulatorStarted() {
    this.needsRecenter = true;
  }

  update(time: number, frame: XRFrame) {
    if (this.needsRecenter) {
      const cam = xb.core.camera;
      if (cam.position.lengthSq() > 1e-6) {
        this.needsRecenter = false;
        this.recenterInFrontOfUser();
      }
    }
    
    try {
      for (const card of this.uiCore.cards) {
        try {
          card.update(time, frame);
        } catch (e: any) {
          console.error('UICard update error:', e);
        }
      }
    } catch (e) {
      console.error("UI Card update error:", e);
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

    if (this.leftToolbarCard) {
      const left = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      const ppos = pos.clone().addScaledVector(left, 0.45);
      ppos.y = pos.y + 0.15;
      ppos.addScaledVector(fwd, -0.15);
      this.leftToolbarCard.position.copy(ppos);
      this.leftToolbarCard.rotation.set(0, yaw, 0);
      this.leftToolbarCard.updateMatrixWorld(true);
    }

    if (this.rightSidebarCard) {
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).negate();
      const ppos = pos.clone().addScaledVector(right, -0.45);
      ppos.y = pos.y + 0.25;
      ppos.addScaledVector(fwd, -0.15);
      this.rightSidebarCard.position.copy(ppos);
      this.rightSidebarCard.rotation.set(0, yaw, 0);
      this.rightSidebarCard.updateMatrixWorld(true);
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

  /** Load an STL or 3MF by URL into the library (used by tests + built-ins). */
  async loadModelFromUrl(url: string): Promise<void> {
    const t0 = performance.now();
    console.log('[orcaxr-load] fetching', url);
    
    if (url.toLowerCase().endsWith('.3mf')) {
      const group = await new ThreeMFLoader().loadAsync(url);
      console.log('[orcaxr-load] parsed 3MF in', Math.round(performance.now() - t0), 'ms');
      const name = url.split('/').pop() ?? url;
      this.loadModelFromGroup(group, name);
    } else {
      const raw = await new STLLoader().loadAsync(url);
      console.log('[orcaxr-load] parsed STL in', Math.round(performance.now() - t0), 'ms,',
        raw.getAttribute('position').count / 3, 'tris');
      this.loadModelFromGeometry(raw, url.split('/').pop() ?? url);
    }
    console.log('[orcaxr-load] scene setup done at', Math.round(performance.now() - t0), 'ms');
  }

  /** Replace the current model with [raw] (STL geometry: mm, Z-up). */
  loadModelFromGeometry(raw: THREE.BufferGeometry, name: string) {
    this.library.push({ name, geometry: raw });
    this.libraryIndex = this.library.length - 1;
    this.addModelFromGeometry(raw, 0x4fc3f7);
    if (this.transformControls && this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    }
    this.setStatus(`Loaded ${name}.`);
  }

  /** Merge a Three.js Group (e.g. from 3MFLoader) into a single model, preserving colors. */
  loadModelFromGroup(group: THREE.Object3D, name: string) {
    const geometries: THREE.BufferGeometry[] = [];
    group.updateMatrixWorld(true);
    group.traverse((child: any) => {
      if (child.isMesh && child.geometry) {
        const geom = child.geometry.clone();
        geom.applyMatrix4(child.matrixWorld);

        // Ensure color attribute exists if material has color
        if (!geom.hasAttribute('color') && child.material && child.material.color) {
          const count = geom.attributes.position.count;
          const colors = new Float32Array(count * 3);
          const colorObj = child.material.color;
          for (let i = 0; i < count * 3; i += 3) {
            colors[i] = colorObj.r;
            colors[i + 1] = colorObj.g;
            colors[i + 2] = colorObj.b;
          }
          geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        if (!geom.hasAttribute('normal')) {
          geom.computeVertexNormals();
        }

        geometries.push(geom);
      }
    });

    if (geometries.length > 0) {
      const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
      if (merged) {
        this.loadModelFromGeometry(merged, name);
      }
    }
  }

  private addFromLibrary() {
    if (this.library.length === 0) return;
    this.libraryIndex = (this.libraryIndex + 1) % this.library.length;
    const entry = this.library[this.libraryIndex];
    if (entry) {
      this.addModelFromGeometry(entry.geometry, 0x4fc3f7);
      if (this.transformControls && this.models.length > 0) {
        this.selectModel(this.models[this.models.length - 1]);
      }
      this.setStatus(`Added ${entry.name}`);
    }
  }

  getLastGcode(): string | null {
    return this.lastGcode;
  }

  private addModelFromGeometry(raw: THREE.BufferGeometry, color: number) {
    raw.computeVertexNormals();
    raw.computeBoundsTree();

    if (!raw.hasAttribute('color')) {
      const colors = new Float32Array(raw.attributes.position.count * 3);
      const colorObj = new THREE.Color(color);
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = colorObj.r;
        colors[i + 1] = colorObj.g;
        colors[i + 2] = colorObj.b;
      }
      raw.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    const mesh = new THREE.Mesh(
      raw,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }),
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

  private toolButtons: { tool: string; btn: UIPanel; iconEl: UIIcon }[] = [];
  private paintOptionsPanel?: UIPanel;
  private paintSwatches: { c: number; btn: UIPanel }[] = [];
  private valueText: any = null;
  private loadButtonNode: THREE.Object3D | null = null;
  private leftToolbarCard: any = null;
  private rightSidebarCard: any = null;

  private addControlPanel() {
    this.addLeftToolbar();
    this.addRightSidebar();
    this.refreshToolButtons();
  }

  private addLeftToolbar() {
    const card = this.uiCore.createCard({
      name: 'LeftToolbar',
      sizeX: 0.12,
      sizeY: 0.8,
      pixelSize: 0.0012,
      position: new THREE.Vector3(-0.45, PLATE_Y + 0.15, PLATE_Z + 0.1),
      width: 100,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 10,
          manipulationCornerRadius: 12,
        })
      ]
    });
    card.visible = false;
    this.leftToolbarCard = card;

    const root = new UIPanel({
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      fillColor: '#14171aA6',
      cornerRadius: 12,
      padding: 10,
      gap: 10,
      strokeWidth: 1,
      strokeColor: '#ffffff14'
    });
    card.add(root);

    const addToolBtn = (tool: 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint', icon: string) => {
      const btn = new UIPanel({
        width: 80, height: 80,
        justifyContent: 'center', alignItems: 'center',
        cornerRadius: 8,
        fillColor: '#ffffff14',
        strokeWidth: 1, strokeColor: '#ffffff1a',
        onClick: () => { this.setTool(tool); return true; },
        onHoverEnter: () => { btn.fillColor = '#ffffff26'; },
        onHoverExit: () => { this.refreshToolButtons(); }
      });
      const iconEl = new UIIcon(icon, { color: '#cccccc', width: 48, height: 48 });
      btn.add(iconEl);
      root.add(btn);
      this.toolButtons.push({ tool, btn, iconEl });
    };

    addToolBtn('move', 'open_with');
    addToolBtn('rotate', 'rotate_right');
    addToolBtn('scale', 'open_in_full');
    addToolBtn('lay_on_face', 'flip_to_back');
    addToolBtn('paint', 'format_paint');
    
    // Paint options palette
    this.paintOptionsPanel = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 5
    });
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xffffff, 0x444444];
    this.paintSwatches = [];
    for (const c of colors) {
      const swatch = new UIPanel({
        width: 35, height: 35,
        cornerRadius: 4,
        fillColor: '#' + c.toString(16).padStart(6, '0'),
        strokeWidth: 2, strokeColor: '#444444',
        onClick: () => { 
          this.activePaintColor.setHex(c); 
          this.setTool('paint'); 
          return true; 
        }
      });
      this.paintSwatches.push({ c, btn: swatch });
      this.paintOptionsPanel.add(swatch);
    }
    root.add(this.paintOptionsPanel);
    
    // Add spacer
    const spacer = new UIPanel({ width: 60, height: 2, fillColor: '#ffffff33' });
    root.add(spacer);

    // Auto orient button
    const orientBtn = new UIPanel({
      width: 80, height: 80,
      justifyContent: 'center', alignItems: 'center',
      cornerRadius: 8,
      fillColor: '#ffffff14',
      strokeWidth: 1, strokeColor: '#ffffff1a',
      onClick: () => { this.autoOrientSelectedModel(); return true; },
      onHoverEnter: () => { orientBtn.fillColor = '#ffffff26'; },
      onHoverExit: () => { orientBtn.fillColor = '#ffffff14'; }
    });
    orientBtn.add(new UIIcon('explore', { color: '#cccccc', width: 48, height: 48 }));
    root.add(orientBtn);

    // Delete button
    const delBtn = new UIPanel({
      width: 80, height: 80,
      justifyContent: 'center', alignItems: 'center',
      cornerRadius: 8,
      fillColor: '#ffffff14',
      strokeWidth: 1, strokeColor: '#ff525233',
      onClick: () => { this.deleteSelectedModel(); return true; },
      onHoverEnter: () => { delBtn.fillColor = '#ff525226'; },
      onHoverExit: () => { delBtn.fillColor = '#ffffff14'; }
    });
    delBtn.add(new UIIcon('delete', { color: '#ff5252', width: 48, height: 48 }));
    root.add(delBtn);
  }

  private addRightSidebar() {
    const card = this.uiCore.createCard({
      name: 'RightSidebar',
      sizeX: 0.35,
      sizeY: 0.6,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0.45, PLATE_Y + 0.25, PLATE_Z + 0.1),
      width: 290,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 16,
          manipulationCornerRadius: 16,
        })
      ]
    });
    card.visible = false;
    this.rightSidebarCard = card;

    const root = new UIPanel({
      width: '100%',
      flexDirection: 'column',
      fillColor: '#14171aA6',
      cornerRadius: 16,
      padding: 24,
      gap: 20,
      strokeWidth: 1,
      strokeColor: '#ffffff14'
    });
    card.add(root);

    // Header
    const header = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center' });
    header.add(new UIText('OrcaXR Web', { fontSize: 32, fontWeight: 'bold', color: '#ffffff' }));
    root.add(header);

    // Profile selectors
    const profPanel = new UIPanel({ width: '100%', flexDirection: 'row', justifyContent: 'space-between', gap: 10 });
    const mkProf = (part: 'machine' | 'process' | 'filament', icon: string) => {
      const btn = new UIPanel({
        flexGrow: 1, height: 50,
        justifyContent: 'center', alignItems: 'center',
        cornerRadius: 8,
        fillColor: '#ffffff14',
        strokeWidth: 1, strokeColor: '#ffffff1a',
        onClick: () => { this.cycleProfilePart(part); return true; },
        onHoverEnter: () => { btn.fillColor = '#ffffff26'; },
        onHoverExit: () => { btn.fillColor = '#ffffff14'; }
      });
      btn.add(new UIIcon(icon, { color: '#ffffff', width: 24, height: 24 }));
      profPanel.add(btn);
    };
    mkProf('machine', 'print');
    mkProf('process', 'tune');
    mkProf('filament', 'water_drop');
    root.add(profPanel);

    // Action buttons
    const mkAction = (text: string, icon: string, primary: boolean, onClick: () => void) => {
      const btn = new UIPanel({
        width: '100%', height: 50,
        flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10,
        cornerRadius: 10,
        fillColor: primary ? '#ffb74d' : '#ffffff14',
        strokeWidth: primary ? 0 : 1,
        strokeColor: primary ? '#ffb74d' : '#ffffff1a',
        onClick: () => { onClick(); return true; },
        onHoverEnter: () => { btn.fillColor = primary ? '#ff6d00' : '#ffffff26'; },
        onHoverExit: () => { btn.fillColor = primary ? '#ffb74d' : '#ffffff14'; }
      });
      btn.add(new UIIcon(icon, { color: primary ? '#000000' : '#ffffff', width: 24, height: 24 }));
      btn.add(new UIText(text, { fontSize: 20, fontWeight: 'bold', color: primary ? '#000000' : '#ffffff' }));
      return btn;
    };

    const loadBtn = mkAction('Load Model', 'upload_file', false, () => {
      if (this.onRequestLoadStl) this.onRequestLoadStl();
    });
    this.loadButtonNode = loadBtn as unknown as THREE.Object3D;
    root.add(loadBtn);
    
    root.add(mkAction('Slice', 'play_circle', true, () => void this.sliceNow()));
    
    root.add(mkAction('Download G-Code', 'download', false, () => {
      if (this.lastGcode && this.onDownloadGcode) {
        this.onDownloadGcode(this.lastGcode);
        this.setStatus('G-code download queued');
      } else {
        this.setStatus('No G-code yet - slice first.');
      }
    }));
    
    root.add(mkAction('Add from Library', 'add_circle', false, () => this.addFromLibrary()));
    root.add(mkAction('Fix Model (ADMesh)', 'healing', false, () => void this.fixSelectedModel()));
    root.add(mkAction('Union (Merge All)', 'merge', false, () => void this.booleanModels('UNION')));
    root.add(mkAction('Subtract (Cut)', 'content_cut', false, () => void this.booleanModels('A_NOT_B')));

    // Status Area
    const statusPanel = new UIPanel({
      width: '100%',
      padding: 16,
      fillColor: '#0000004d',
      cornerRadius: 8,
      strokeWidth: 1,
      strokeColor: '#ffffff0d'
    });
    this.statusText = new UIText('Ready. Load a model to begin.', { fontSize: 16, color: '#a0aab5' });
    statusPanel.add(this.statusText);
    root.add(statusPanel);
    
    // Value text (for tools)
    this.valueText = new UIText(' ', { fontSize: 18, color: '#ffb74d' });
    root.add(this.valueText);
  }

  public setTool(tool: 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint') {
    this.tool = tool;
    this.refreshToolButtons();
    if (this.tool === 'lay_on_face') {
      this.setStatus('Select a face on the model to lay flat');
    } else {
      this.setStatus(`tool: ${tool} - pinch-drag the model`);
      
      if (this.transformControls) {
        if (tool === 'move') this.transformControls.setMode('translate');
        else if (tool === 'rotate') this.transformControls.setMode('rotate');
        else if (tool === 'scale') this.transformControls.setMode('scale');
      }
    }
  }

  private snapToBed(entry: { viewer: THREE.Object3D }) {
    entry.viewer.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(entry.viewer);
    const lowestWorldY = box.min.y;
    const bedWorldY = this.workspace.getWorldPosition(new THREE.Vector3()).y;
    entry.viewer.position.y += (bedWorldY - lowestWorldY);
  }

  private layOnFace(entry: { viewer: THREE.Object3D, display: THREE.Mesh }, faceNormal: THREE.Vector3, hitObject: THREE.Object3D) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hitObject.matrixWorld);
    const worldNormal = faceNormal.clone().applyMatrix3(normalMatrix).normalize();
    const targetNormal = new THREE.Vector3(0, -1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(worldNormal, targetNormal);
    
    const workspaceWorldQuat = this.workspace.getWorldQuaternion(new THREE.Quaternion());
    const workspaceInvQuat = workspaceWorldQuat.clone().invert();
    const localQ = workspaceInvQuat.clone().multiply(q).multiply(workspaceWorldQuat);
    
    entry.viewer.quaternion.premultiply(localQ);
    this.snapToBed(entry);
    this.setStatus('Laid on face');
  }

  private autoOrientSelectedModel() {
    if (!this.selectedModel) return;
    const entry = this.selectedModel;
    const originalQuat = entry.viewer.quaternion.clone();
    
    const candidates = [
      new THREE.Quaternion(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2),
    ];
    
    let bestQuat = originalQuat;
    let minHeight = Infinity;
    
    for (const q of candidates) {
      entry.viewer.quaternion.copy(q);
      entry.viewer.updateMatrixWorld();
      const box = new THREE.Box3().setFromObject(entry.viewer);
      const height = box.max.y - box.min.y;
      if (height < minHeight) {
        minHeight = height;
        bestQuat = q;
      }
    }
    
    entry.viewer.quaternion.copy(bestQuat);
    this.snapToBed(entry);
    this.setStatus('Auto-oriented model');
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
    for (const { tool, btn, iconEl } of this.toolButtons) {
      const active = this.tool === tool;
      btn.fillColor = active ? '#ffffff4d' : '#ffffff14';
      iconEl.color = active ? '#ffffff' : '#cccccc';
    }
    if (this.paintOptionsPanel) {
      this.refreshPaintSwatches();
    }
  }

  private refreshPaintSwatches() {
    const activeHex = this.activePaintColor.getHex();
    for (const { c, btn } of this.paintSwatches) {
      btn.strokeColor = (c === activeHex) ? '#ffffff' : '#444444';
    }
  }

  private showValues(text: string) {
    if (this.valueText && this.rightSidebarCard && !this.rightSidebarCard.visible) {
      this.valueText.setText(text);
    }
  }

  private setStatus(text: string) {
    if (this.statusText && this.rightSidebarCard && !this.rightSidebarCard.visible) {
      this.statusText.setText(text);
    }
    if (this.onStatusChanged) {
      this.onStatusChanged(text);
    }
    console.log('[orcaxr-web]', text);
  }

  private deleteSelectedModel() {
    if (!this.selectedModel) return;
    const idx = this.models.indexOf(this.selectedModel);
    if (idx !== -1) {
      this.workspace.remove(this.selectedModel.viewer);
      this.models.splice(idx, 1);
      this.unselectModel();
      if (this.models.length > 0) {
        this.selectModel(this.models[this.models.length - 1]);
      }
      this.setStatus('Model deleted.');
    }
  }

  public async sliceNow() {
    if (this.slicer.isSlicing) return;
    if (this.models.length === 0) {
      this.setStatus('No models to slice.');
      return;
    }
    try {
      this.setStatus('baking transforms…');
      const stl = this.bakeToPrinterStl();
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
   * Bake the display meshes' CURRENT world poses into a binary STL in
   * printer coordinates: mm, Z-up, bed origin at the plate corner with
   * the models dropped onto Z=0.
   */
  private bakeToPrinterStl(): ArrayBuffer {
    this.plateAnchor.updateMatrixWorld(true);
    const plateInverse = new THREE.Matrix4().copy(this.plateAnchor.matrixWorld).invert();

    const conv = new THREE.Matrix4().set(
      1000, 0, 0, this.bedMm.x / 2,
      0, 0, -1000, this.bedMm.y / 2,
      0, 1000, 0, 0,
      0, 0, 0, 1,
    );

    const geometries: THREE.BufferGeometry[] = [];
    
    for (const entry of this.models) {
      entry.display.updateMatrixWorld(true);
      const rel = new THREE.Matrix4()
        .copy(plateInverse)
        .multiply(entry.display.matrixWorld);

      const geo = (entry.display.geometry as THREE.BufferGeometry).clone();
      geo.applyMatrix4(rel);
      geo.applyMatrix4(conv);
      geometries.push(geo);
    }
    
    if (geometries.length === 0) {
       return new ArrayBuffer(84);
    }

    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    if (!merged) return new ArrayBuffer(84);

    merged.computeBoundingBox();
    const minZ = merged.boundingBox!.min.z;
    merged.translate(0, 0, -minZ);

    return writeBinaryStl(merged);
  }

  private async fixSelectedModel() {
    if (!this.selectedModel) {
      this.setStatus('Select a model to fix first.');
      return;
    }
    const entry = this.selectedModel;
    try {
      this.setStatus('Fixing model (ADMesh + CGAL)...');
      const stlBuf = writeBinaryStl(entry.raw);
      const repaired = await this.slicer.repair(stlBuf);
      
      const raw = new STLLoader().parse(repaired);
      entry.raw = raw;
      entry.raw.computeVertexNormals();
      entry.raw.computeBoundsTree();
      
      entry.display.geometry.dispose();
      entry.display.geometry = raw;
      
      this.setStatus('Model repaired successfully.');
    } catch (e: any) {
      this.setStatus(`Repair failed: ${e.message}`);
    }
  }

  private async booleanModels(op: 'UNION' | 'A_NOT_B' | 'INTERSECTION') {
    if (this.models.length < 2) {
      this.setStatus('Requires at least 2 models for boolean operations.');
      return;
    }
    let target = this.selectedModel;
    let tool = this.models.find(m => m !== target);

    if (!target) {
      target = this.models[0];
      tool = this.models[1];
    }

    if (!target || !tool) return;

    try {
      this.setStatus(`Running boolean ${op}...`);
      
      // We must bake the transforms into the STL so mcut sees world space overlaps
      const targetGeom = target.raw.clone();
      targetGeom.applyMatrix4(target.viewer.matrixWorld);
      const toolGeom = tool.raw.clone();
      toolGeom.applyMatrix4(tool.viewer.matrixWorld);

      const targetStl = writeBinaryStl(targetGeom);
      const toolStl = writeBinaryStl(toolGeom);

      const resultStl = await this.slicer.boolean(targetStl, toolStl, op);

      const raw = new STLLoader().parse(resultStl);
      
      // Inverse the target's matrixWorld so the resulting mesh stays in the target's local space
      const invMatrix = target.viewer.matrixWorld.clone().invert();
      raw.applyMatrix4(invMatrix);

      target.raw = raw;
      target.raw.computeVertexNormals();
      target.raw.computeBoundsTree();

      target.display.geometry.dispose();
      target.display.geometry = raw;

      // Remove the tool model from the workspace
      this.workspace.remove(tool.viewer);
      this.models = this.models.filter(m => m !== tool);

      this.setStatus(`Boolean ${op} successful.`);
    } catch (e: any) {
      this.setStatus(`Boolean failed: ${e.message}`);
    }
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
