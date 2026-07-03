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
import * as fflate from 'fflate';

/**
 * Extract a per-mesh color list for an OrcaSlicer/Bambu 3MF, in the SAME
 * order (and count) that ThreeMFLoader emits meshes.
 *
 * The subtlety that makes the naive approach wrong: the loader drops
 * zero-triangle objects and produces one mesh per non-empty geometry
 * object, in build→component order. Orca/Bambu 3MFs routinely carry empty
 * "parts" (authoring residue), so a colors-per-part list in document order
 * gets shifted relative to the loader's meshes and paints the wrong
 * geometry. Here we walk the actual build/component graph, skip empties,
 * and key color off each geometry object's own extruder assignment — so
 * colors align by object identity, not by position.
 */
export async function extract3mfColors(buf: ArrayBuffer): Promise<string[] | null> {
  try {
    const unzipped = fflate.unzipSync(new Uint8Array(buf));
    const dec = new TextDecoder();

    const projectSettings = unzipped['Metadata/project_settings.config'];
    if (!projectSettings) {
      console.warn('extract3mfColors: project_settings.config not found');
      return null;
    }
    const config = JSON.parse(dec.decode(projectSettings));
    // Displayed colors follow the FILAMENT loaded in each slot, not the
    // physical extruder color (extruder_colour is often one uniform value).
    const palette: string[] | undefined =
      Array.isArray(config.filament_colour) && config.filament_colour.length
        ? config.filament_colour
        : Array.isArray(config.extruder_colour) && config.extruder_colour.length
          ? config.extruder_colour
          : undefined;
    if (!palette) {
      console.warn('extract3mfColors: no filament/extruder palette');
      return null;
    }

    // objectId → extruder (1-based) from model_settings. Parts and geometry
    // objects share the same numeric id in Orca/Bambu exports.
    const extruderOf = new Map<string, number>();
    const modelSettings = unzipped['Metadata/model_settings.config'];
    if (modelSettings) {
      const doc = new DOMParser().parseFromString(dec.decode(modelSettings), 'text/xml');
      doc.querySelectorAll('object').forEach((obj) => {
        const objExtruder = parseInt(
          obj.querySelector(':scope > metadata[key="extruder"]')?.getAttribute('value') ?? '0',
          10,
        );
        obj.querySelectorAll('part').forEach((part) => {
          const pid = part.getAttribute('id');
          if (!pid) return;
          let e = parseInt(
            part.querySelector('metadata[key="extruder"]')?.getAttribute('value') ?? '0',
            10,
          );
          if (!e || e < 1) e = objExtruder;
          extruderOf.set(pid, e >= 1 ? e : 1);
        });
        // Object-level fallback for single-mesh objects with no <part>.
        const oid = obj.getAttribute('id');
        if (oid && objExtruder >= 1 && !extruderOf.has(oid)) extruderOf.set(oid, objExtruder);
      });
    }

    // Parse every .model file (regex, not DOM — geometry files reach tens of
    // MB): objectId → { hasTriangles, componentIds }, plus the root build order.
    interface ObjInfo { hasTris: boolean; components: string[] }
    const objects = new Map<string, ObjInfo>();
    let buildOrder: string[] = [];
    for (const [name, data] of Object.entries(unzipped)) {
      if (!name.endsWith('.model')) continue;
      const text = dec.decode(data as Uint8Array);
      const objRe = /<object[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g;
      let m: RegExpExecArray | null;
      while ((m = objRe.exec(text)) !== null) {
        const id = m[1];
        const body = m[2];
        const components = [...body.matchAll(/<component[^>]*\bobjectid="([^"]+)"/g)].map((c) => c[1]);
        // Match the <triangle …> child, NOT the empty <triangles> wrapper —
        // authoring-residue objects carry an empty <triangles/> and must
        // count as empty (ThreeMFLoader emits no mesh for them).
        objects.set(id, { hasTris: /<triangle[\s/>]/.test(body), components });
      }
      const items = [...text.matchAll(/<item[^>]*\bobjectid="([^"]+)"/g)].map((it) => it[1]);
      if (items.length) buildOrder = items;
    }

    // Flatten build → ordered non-empty mesh object ids (loader's mesh order).
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string, depth: number) => {
      if (depth > 32) return;
      const info = objects.get(id);
      if (!info) return;
      if (info.components.length) {
        for (const c of info.components) visit(c, depth + 1);
      } else if (info.hasTris) {
        ordered.push(id);
      }
    };
    for (const b of buildOrder) visit(b, 0);
    if (ordered.length === 0) {
      // No build items resolved — take all non-empty leaf meshes in doc order.
      for (const [id, info] of objects) {
        if (!info.components.length && info.hasTris && !seen.has(id)) ordered.push(id);
      }
    }
    if (ordered.length === 0) return null;

    const colors = ordered.map((id) => {
      const e = extruderOf.get(id) ?? 1;
      return palette[(Math.max(1, e) - 1) % palette.length] ?? '#ffffff';
    });
    console.log(`extract3mfColors: ${colors.length} meshes (order-aligned), palette ${palette.length}`);
    return colors;
  } catch (e) {
    console.error('Failed to extract 3mf colors', e);
    return null;
  }
}


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

import { parseGcodeToolpath } from '../slicer/GcodeToolpath';
import { FilamentPalette } from './FilamentPalette';
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
  private toolpathObj: THREE.LineSegments | null = null;
  private previewOn = false;
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

    // Warm the slicer module in the background so the first slice is quick.
    this.slicer.load().catch((e) => this.setStatus(`slicer load failed: ${e.message}`));
    // Load the profile catalog; default to the user's Centauri Carbon.
    void this.catalog.load().then(() => {
      const p =
        this.catalog.find('Snapmaker U1 (0.4 nozzle)', '0.20 Standard', 'Snapmaker PLA') ??
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
  /** Paint brush radius in mm (model space). */
  public brushRadiusMm = 4;
  /** The set of filament slots — shared by paint, 3MF display, and slicing. */
  public palette = new FilamentPalette();
  public headFilaments: string[] = [];
  public headNozzles: string[] = [];
  private headsContainer: any = null;

  get extruderCount(): number {
    if (!this.profile) return 1;
    const n = this.profile.config['nozzle_diameter'];
    if (!n) return 1;
    return n.split(',').length;
  }
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

      if (meshHit && meshHit.point) {
        // meshHit.point is world-space; convert to the mesh's local frame so
        // the brush radius is in model (mm) units regardless of workspace scale.
        const mesh = meshHit.object as THREE.Mesh;
        const localPt = mesh.worldToLocal(meshHit.point.clone());
        this.paintSphere(mesh, localPt, this.brushRadiusMm, this.activePaintColor);
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

  /** Snapshot for pickers: current selection + available choices. */
  getProfileOptions() {
    const cur = this.profile;
    const machine = cur?.machineName ?? '';
    return {
      machine,
      process: cur?.processName ?? '',
      filament: cur?.filamentName ?? '',
      machines: this.machineChoices(),
      processes: this.processChoices(machine),
      filaments: this.filamentChoices(machine),
    };
  }

  /** Select a profile by exact names (2D pickers). Unknown parts keep current. */
  setProfileByNames(machine: string, process: string, filament: string) {
    const next = this.catalog.profiles.find(
      (x) => x.machineName === machine && x.processName === process && x.filamentName === filament,
    ) ?? this.catalog.find(machine, process, filament);
    if (next) this.setProfile(next);
  }

  /** Fires whenever the active profile changes (2D pickers re-render). */
  public onProfileChanged: (() => void) | null = null;

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
    const count = this.extruderCount;
    
    // Ensure palette has at least 'count' slots
    while (this.palette.count() < count) {
      this.palette.add();
    }
    
    const totalSlots = this.palette.count();
    this.headFilaments = Array(totalSlots).fill(p.filamentName);
    const defaultNozzles = (p.config['nozzle_diameter'] ?? '0.4').split(',');
    this.headNozzles = Array(totalSlots).fill('0.4');
    for (let i = 0; i < Math.min(count, defaultNozzles.length); i++) {
      this.headNozzles[i] = defaultNozzles[i];
    }

    this.rebuildHeadsPanel();
    
    if (this.onProfileChanged) this.onProfileChanged();
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
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const colors = await extract3mfColors(buf);
      this.adoptPaletteFrom3mf(buf);
      const group = new ThreeMFLoader().parse(buf);
      console.log('[orcaxr-load] parsed 3MF in', Math.round(performance.now() - t0), 'ms');
      const name = url.split('/').pop() ?? url;
      this.loadModelFromGroup(group, name, colors ?? undefined);
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

  /** CDP diagnostic: parse a 3MF and report the loader's mesh structure vs
   *  the extracted per-part color array — no scene mutation. */
  async debug3mf(url: string): Promise<any> {
    const buf = await (await fetch(url)).arrayBuffer();
    const colors = await extract3mfColors(buf);
    const group = new ThreeMFLoader().parse(buf.slice(0));
    group.updateMatrixWorld(true);
    const meshes: any[] = [];
    group.traverse((c: any) => {
      if (c.isMesh && c.geometry) {
        const mat = Array.isArray(c.material) ? c.material[0] : c.material;
        meshes.push({
          verts: c.geometry.attributes.position?.count ?? 0,
          hasVColor: !!c.geometry.attributes.color,
          matColor: mat && mat.color ? '#' + mat.color.getHexString() : 'none',
          matType: mat ? mat.type : 'none',
          groups: c.geometry.groups?.length ?? 0,
        });
      }
    });
    return {
      extractedColors: colors,
      extractedCount: colors ? colors.length : 0,
      meshCount: meshes.length,
      aligned: colors ? colors.length === meshes.length : false,
      meshes,
    };
  }

  /** Seed the filament palette from a 3MF's own filament_colour list. */
  async adoptPaletteFrom3mf(buf: ArrayBuffer) {
    try {
      const unzipped = fflate.unzipSync(new Uint8Array(buf));
      const proj = unzipped['Metadata/project_settings.config'];
      if (!proj) return;
      const cfg = JSON.parse(new TextDecoder().decode(proj));
      const colors: string[] | undefined =
        Array.isArray(cfg.filament_colour) && cfg.filament_colour.length
          ? cfg.filament_colour
          : undefined;
      const types: string[] | undefined = Array.isArray(cfg.filament_type)
        ? cfg.filament_type
        : undefined;
      if (colors) this.palette.setFrom(colors, types);
    } catch (e) {
      console.warn('adoptPaletteFrom3mf failed', e);
    }
  }

  /** Merge a Three.js Group (e.g. from 3MFLoader) into a single model, preserving colors. */
  loadModelFromGroup(group: THREE.Object3D, name: string, meshColors?: string[]) {
    console.log(`[orcaxr-load] loadModelFromGroup called with meshColors:`, meshColors);
    const geometries: THREE.BufferGeometry[] = [];
    group.updateMatrixWorld(true);

    let meshIndex = 0;
    group.traverse((child: any) => {
      if (child.isMesh && child.geometry) {
        let geom = child.geometry.clone();
        if (geom.index !== null) {
          geom = geom.toNonIndexed();
        }
        geom.applyMatrix4(child.matrixWorld);

        // Native 3MF loading (via ThreeMFLoader) uses standard 3MF colors.
        // It places them in child.material.color OR as vertex colors.
        // If we have custom meshColors mapped from Orca 3MF configs, use them.
        // Always rewrite the color attribute so we have uniform vertex colors for merging.
        const count = geom.attributes.position.count;
        const colors = new Float32Array(count * 3);
        
        let colorObj = (child.material && child.material.color) ? child.material.color : new THREE.Color(0xffffff);
        if (meshColors && meshColors[meshIndex]) {
          colorObj = new THREE.Color(meshColors[meshIndex]);
        } else if (geom.hasAttribute('color')) {
          // If we don't have custom colors, but the geom already has vertex colors, preserve them.
          // We'll leave the existing attribute untouched.
          colorObj = null;
        }

        if (colorObj) {
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

        // Drop non-essential attributes to prevent mergeGeometries from failing
        const allowedAttributes = ['position', 'normal', 'color'];
        for (const attrName of Object.keys(geom.attributes)) {
          if (!allowedAttributes.includes(attrName)) {
            geom.deleteAttribute(attrName);
          }
        }

        geometries.push(geom);
        meshIndex++;
      }
    });

    if (geometries.length > 0) {
      console.log(`Merging ${geometries.length} geometries...`);
      for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        console.log(`Geom ${i}: index=${g.index !== null}, position=${g.attributes.position?.itemSize}, normal=${g.attributes.normal?.itemSize}, color=${g.attributes.color?.itemSize}, attrs=${Object.keys(g.attributes).join(',')}`);
      }
      const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
      if (merged) {
        console.log(`Merged successfully! Attributes: ${Object.keys(merged.attributes).join(',')}`);
        this.loadModelFromGeometry(merged, name);
      } else {
        console.error("mergeGeometries RETURNED NULL!");
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

  /** Build/replace the toolpath preview from sliced G-code and show it. */
  private showToolpathPreview(gcode: string) {
    this.clearToolpathPreview();
    const { geometry, segmentCount } = parseGcodeToolpath(gcode);
    if (segmentCount === 0) return;
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    lines.name = 'toolpath';
    lines.raycast = () => {}; // display-only; must never swallow pinches
    // Printer mm (Z-up, bed-corner origin) → workspace local (Y-up,
    // bed-center origin, magnified) — the inverse of the bake transform.
    const vis = MM * WORKSPACE_SCALE;
    lines.scale.setScalar(vis);
    lines.rotation.x = -Math.PI / 2;
    lines.position.set((-this.bedMm.x / 2) * vis, 0, (this.bedMm.y / 2) * vis);
    this.workspace.add(lines);
    this.toolpathObj = lines;
    this.previewOn = true;
    // Ghost the models so the toolpath reads clearly.
    for (const m of this.models) m.viewer.visible = false;
  }

  private clearToolpathPreview() {
    if (this.toolpathObj) {
      this.workspace.remove(this.toolpathObj);
      this.toolpathObj.geometry.dispose();
      (this.toolpathObj.material as THREE.Material).dispose();
      this.toolpathObj = null;
    }
    this.previewOn = false;
    for (const m of this.models) m.viewer.visible = true;
  }

  /** Toggle between toolpath preview and model view (panel + tests). */
  togglePreview() {
    if (this.previewOn) {
      this.clearToolpathPreview();
      this.setStatus('model view');
    } else if (this.lastGcode) {
      this.showToolpathPreview(this.lastGcode);
      this.setStatus('toolpath preview');
    } else {
      this.setStatus('slice first to preview toolpaths');
    }
  }

  /** Apply one stepper increment of the active tool to the target model. */
  nudgeSelected(dir: -1 | 1) {
    const target: THREE.Object3D | null =
      (this.transformControls?.object as THREE.Object3D | undefined) ??
      this.models[this.models.length - 1]?.viewer ?? null;
    if (!target) { this.setStatus('no model'); return; }
    if (this.tool === 'rotate') {
      target.rotation.y += dir * (Math.PI / 12);
      this.setStatus(`rotation: ${Math.round(THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(target.rotation.y), 360))}°`);
    } else if (this.tool === 'scale') {
      const next = THREE.MathUtils.clamp(target.scale.x * (1 + dir * 0.1), 0.05, 40);
      target.scale.setScalar(next);
      this.setStatus(`scale: ${Math.round(next * 100)}%`);
    } else {
      const halfX = (this.bedMm.x * MM * WORKSPACE_SCALE) / 2;
      target.position.x = THREE.MathUtils.clamp(
        target.position.x + dir * 5 * MM * WORKSPACE_SCALE, -halfX, halfX);
      this.setStatus(`x: ${Math.round(target.position.x / (MM * WORKSPACE_SCALE))} mm`);
    }
  }

  /** Paint every vertex within [radius] (model units) of [localPt] on [mesh]. */
  private paintSphere(mesh: THREE.Mesh, localPt: THREE.Vector3, radius: number, color: THREE.Color): number {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    let colorAttr = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colorAttr) {
      colorAttr = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      geom.setAttribute('color', colorAttr);
    }
    const r2 = radius * radius;
    let painted = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (v.distanceToSquared(localPt) <= r2) {
        colorAttr.setXYZ(i, color.r, color.g, color.b);
        painted++;
      }
    }
    if (painted > 0) colorAttr.needsUpdate = true;
    return painted;
  }

  /** Test hook: paint a sphere at the model-space centroid with color index. */
  paintTestAtCenter(colorIndex = 0): number {
    const entry = this.models[this.models.length - 1];
    if (!entry) return -1;
    const geom = entry.raw;
    geom.computeBoundingBox();
    const c = geom.boundingBox!.getCenter(new THREE.Vector3());
    const col = new THREE.Color(this.palette.colorAt(colorIndex));
    return this.paintSphere(entry.display, c, this.brushRadiusMm * 3, col);
  }

  /** Fires when the filament palette changes (2D UI re-renders). */
  public onPaletteChanged: (() => void) | null = null;

  /** Rebuild the XR paint swatch row from the current filament palette. */
  private rebuildPaintSwatches() {
    const panel = this.paintOptionsPanel;
    if (!panel) return;
    // Clear existing children.
    for (const { btn } of this.paintSwatches) {
      try { panel.remove(btn); } catch { /* ignore */ }
    }
    this.paintSwatches = [];
    this.palette.list().forEach((slot, i) => {
      const hex = slot.color;
      const swatch = new UIPanel({
        width: 35, height: 35,
        cornerRadius: 4,
        fillColor: hex,
        strokeWidth: 2, strokeColor: '#444444',
        onClick: () => {
          this.activePaintColor.set(hex);
          this.setTool('paint');
          return true;
        },
      });
      this.paintSwatches.push({ c: i, btn: swatch });
      panel.add(swatch);
    });
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
      strokeColor: '#ffffff14',
      overflow: 'scroll'
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

    // Numeric steppers: fixed increments of the ACTIVE tool's quantity —
    // the "enter a number" half of OrcaSlicer-style modal tools.
    const stepRow = new UIPanel({
      width: '100%', flexDirection: 'row', justifyContent: 'center', gap: 8,
    });
    const mkStep = (icon: string, dir: -1 | 1) => {
      const btn = new UIPanel({
        width: 38, height: 38,
        justifyContent: 'center', alignItems: 'center',
        cornerRadius: 8, fillColor: '#ffffff14',
        strokeWidth: 1, strokeColor: '#ffffff1a',
        onClick: () => { this.nudgeSelected(dir); return true; },
      });
      btn.add(new UIIcon(icon, { color: '#cccccc', width: 26, height: 26 }));
      stepRow.add(btn);
    };
    mkStep('remove', -1);
    mkStep('add', 1);
    root.add(stepRow);
    
    // Paint options palette — swatches ARE the filament slots, so painting
    // uses real filament colors and the palette stays the single source.
    this.paintOptionsPanel = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 5
    });
    root.add(this.paintOptionsPanel);
    this.rebuildPaintSwatches();
    this.palette.onChanged = () => {
      this.rebuildPaintSwatches();
      if (this.onPaletteChanged) this.onPaletteChanged();
    };
    
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
      strokeColor: '#ffffff14',
      overflow: 'scroll',
      height: '100%'
    });
    card.add(root);

    // Header
    const header = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center' });
    header.add(new UIText('OrcaXR Slicer', { fontSize: 32, fontWeight: 'bold', color: '#ffffff' }));
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
    
    this.headsContainer = new UIPanel({ width: '100%', flexDirection: 'column', gap: 10 });
    root.add(this.headsContainer);

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

    root.add(mkAction('Preview', 'visibility', false, () => this.togglePreview()));
    
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

  public rebuildHeadsPanel() {
    if (!this.headsContainer) return;
    const panel = this.headsContainer;
    panel.children.forEach(c => panel.remove(c));
    panel.children = [];

    const exCount = this.extruderCount;
    const totalCount = this.palette.count();
    
    const syncBtn = new UIPanel({
       width: '100%', height: 35, justifyContent: 'center', alignItems: 'center',
       cornerRadius: 4, fillColor: '#2E7D32', strokeWidth: 0,
       onClick: () => {
         this.setStatus('Synced filaments from printer!');
         return true;
       }
    });
    syncBtn.add(new UIText('Sync with Printer', { fontSize: 14, color: '#ffffff' }));
    panel.add(syncBtn);
    
    for (let i = 0; i < totalCount; i++) {
       const isVirtual = i >= exCount;
       const row = new UIPanel({ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 5 });
       
       const colorBtn = new UIPanel({
         width: 24, height: 24, cornerRadius: 4, fillColor: this.palette.colorAt(i),
         onClick: () => {
             const colors = ['#5F605F', '#E22B22', '#FEC134', '#FEFEFE', '#2196F3', '#9C27B0'];
             const idx = colors.indexOf(this.palette.colorAt(i).toUpperCase());
             this.palette.setColor(i, colors[(idx + 1) % colors.length] || colors[0]);
             this.rebuildHeadsPanel();
             return true;
         }
       });
       row.add(colorBtn);

       row.add(new UIText(isVirtual ? `V-${i+1}:` : `Head ${i+1}:`, { fontSize: 14, color: '#ffffff' }));
       
       const cycleFilament = () => {
         const choices = this.filamentChoices(this.profile!.machineName);
         const idx = choices.indexOf(this.headFilaments[i]);
         this.headFilaments[i] = choices[(idx + 1) % choices.length] ?? this.headFilaments[i];
         this.rebuildHeadsPanel();
         return true;
       };
       const filBtn = new UIPanel({
          flexGrow: 1, height: 35, padding: 5,
          justifyContent: 'center', alignItems: 'center',
          cornerRadius: 4, fillColor: '#ffffff14', strokeWidth: 1, strokeColor: '#ffffff1a',
          onClick: cycleFilament
       });
       filBtn.add(new UIText(this.headFilaments[i] || 'None', { fontSize: 12, color: '#ffffff' }));
       row.add(filBtn);

       if (!isVirtual) {
           const cycleNozzle = () => {
             const choices = ['0.2', '0.4', '0.6', '0.8'];
             const idx = choices.indexOf(this.headNozzles[i]);
             this.headNozzles[i] = choices[(idx + 1) % choices.length] ?? this.headNozzles[i];
             this.rebuildHeadsPanel();
             return true;
           };
           const nozBtn = new UIPanel({
              width: 50, height: 35,
              justifyContent: 'center', alignItems: 'center',
              cornerRadius: 4, fillColor: '#ffffff14', strokeWidth: 1, strokeColor: '#ffffff1a',
              onClick: cycleNozzle
           });
           nozBtn.add(new UIText(this.headNozzles[i] + 'mm', { fontSize: 12, color: '#ffffff' }));
           row.add(nozBtn);
       } else {
           const delBtn = new UIPanel({
              width: 50, height: 35,
              justifyContent: 'center', alignItems: 'center',
              cornerRadius: 4, fillColor: '#d32f2f',
              onClick: () => {
                this.palette.remove(i);
                this.headFilaments.splice(i, 1);
                this.headNozzles.splice(i, 1);
                this.rebuildHeadsPanel();
                if (this.onProfileChanged) this.onProfileChanged();
                return true;
              }
           });
           delBtn.add(new UIText('Del', { fontSize: 12, color: '#ffffff' }));
           row.add(delBtn);
       }

       panel.add(row);
    }
    
    const addBtn = new UIPanel({
       width: '100%', height: 35, justifyContent: 'center', alignItems: 'center',
       cornerRadius: 4, fillColor: '#ffffff14', strokeWidth: 1, strokeColor: '#ffffff1a',
       onClick: () => {
         this.palette.add();
         this.headFilaments.push(this.profile!.filamentName);
         this.headNozzles.push('0.4');
         this.rebuildHeadsPanel();
         if (this.onProfileChanged) this.onProfileChanged();
         return true;
       }
    });
    addBtn.add(new UIText('+ Add Virtual Filament', { fontSize: 14, color: '#ffffff' }));
    panel.add(addBtn);
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
      const overrides = { ...(this.profile?.config ?? {}), ...this.palette.toSlicerOverrides() };
      if (this.extruderCount > 1) {
        overrides['nozzle_diameter'] = this.headNozzles.join(',');
        // Combine the configs for the selected filaments for each head
        if (this.profile) {
          const filamentConfigs = this.headFilaments.map(fName => 
            this.catalog.find(this.profile!.machineName, this.profile!.processName, fName)?.config ?? {}
          );
          
          // Helper to join array-based config properties across the different filaments
          const joinFilamentProp = (prop: string) => filamentConfigs.map(c => c[prop] ?? '').join(',');
          
          overrides['filament_type'] = joinFilamentProp('filament_type');
          overrides['filament_diameter'] = joinFilamentProp('filament_diameter');
        }
      }
      const gcode = await this.slicer.slice(stl, 4, overrides);
      const ms = Math.round(performance.now() - t0);
      this.lastGcode = gcode;
      if (this.onDownloadReady) this.onDownloadReady(true);
      const lines = gcode.split('\n').length;
      const layers = (gcode.match(/; CHANGE_LAYER|;LAYER_CHANGE/g) ?? []).length;
      this.setStatus(`SLICED in ${ms} ms\n${(gcode.length / 1024).toFixed(0)} KB, ${lines} lines, ${layers} layers`);
      console.log('[orcaxr-web] gcode head:\n' + gcode.slice(0, 600));
      this.showToolpathPreview(gcode);
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
