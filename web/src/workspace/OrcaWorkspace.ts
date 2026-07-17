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
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
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
    const rawPalette: string[] | undefined =
      Array.isArray(config.filament_colour) && config.filament_colour.length
        ? config.filament_colour
        : Array.isArray(config.extruder_colour) && config.extruder_colour.length
          ? config.extruder_colour
          : undefined;
    const palette = rawPalette?.map((c: string) => {
      const hex = c.startsWith('#') ? c : `#${c}`;
      return hex.length === 9 ? hex.substring(0, 7) : hex;
    });
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
          let e = parseInt(part.querySelector('metadata[key="extruder"]')?.getAttribute('value') ?? '0', 10);
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
    interface ObjInfo {
      hasTris: boolean;
      components: string[];
    }
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

    // FullSpectrum projects assign parts to VIRTUAL filament IDs past the
    // physical count (mixed_filament_definitions rows). Extend the palette
    // with their pigment-blended display colors so extruder 23 renders as
    // its mix, not wrapped modulo-N onto some physical filament.
    const virtuals = virtualFilamentsFromConfig(config).map((v) => v.color);
    const full = [...palette, ...virtuals];
    const colors = ordered.map((id) => {
      const e = Math.max(1, extruderOf.get(id) ?? 1);
      return full[e - 1] ?? palette[(e - 1) % palette.length] ?? '#ffffff';
    });
    console.log(
      `extract3mfColors: ${colors.length} meshes (order-aligned), palette ${palette.length}+${virtuals.length} virtual`,
    );
    return colors;
  } catch (e) {
    console.error('Failed to extract 3mf colors', e);
    return null;
  }
}

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { buildRegistry } from '../actions/catalog';
import type { Action, ActionSurface } from '../actions/ActionRegistry';
import { MENU_SECTIONS } from '../actions/ActionRegistry';
import type { ActionContext } from '../actions/ActionContext';
import { renderXrActionButton, xrToolRailActions, type XrUiFactory } from '../ui/xr/XrShell';
import { CalibrationRampGenerator } from '../features/CalibrationRampGenerator';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import * as xb from 'xrblocks';
import {
  UICore,
  UICard,
  UIPanel,
  UIText,
  UIImage as XRImage,
  raycastSortFunction,
  ManipulationBehavior,
  type UIPanelProperties,
  type UIImageProperties as XRImageProperties,
} from 'xrblocks/addons/uiblocks/src/index.js';

import { parseGcodeToolpath } from '../slicer/GcodeToolpath';
import { FilamentPalette } from './FilamentPalette';
import { bedSizeFromProfile, ProfileCatalog, SlicerProfile } from '../slicer/ProfileLoader';
import { SlicerClient } from '../slicer/SlicerClient';
import {
  combinedSemanticImportRequiresCanonicalSlice,
  requireSemanticSlice,
  sameSemanticProjectSnapshot,
  selectSemanticSliceRoute,
  type SemanticBufferSnapshot,
  type SemanticProjectSnapshot,
} from '../slicer/SemanticSliceGuard';
import { detectBedCollision, bedCollisionBanner } from '../features/BedCollision';
import {
  loadFilamentRules,
  evaluateFilamentRules,
  bedKeyFor,
  EMPTY_RULES,
  type FilamentRules,
} from '../features/FilamentRules';
import { evaluateTopCover } from '../features/TopCoverRule';
import { scoreWipeTower, parseBias, type AabbXY } from '../features/WipeTowerPlacement';
import { deriveTriangleFilaments } from '../features/PaintedSlice';
import { splitConnectedComponents } from '../features/MeshSplit';
import { SemanticPaintPlanner } from '../features/SemanticPaintPlanner';
import { cutByPlane } from '../features/MeshCut';
import { writeMinimal3mf } from '../features/Write3mf';
import { writeProject3mf, parseProject3mf, type ProjectMeta, type ProjectObjectMeta } from '../features/Project3mf';
import { exportConfigJson, parseConfigJson } from '../features/ConfigIO';
import { extract3mfPaint, applyPaintToPositions, type Paint3mfResult } from '../features/Paint3mf';
import { virtualFilamentsFromConfig, type VirtualFilament } from '../features/MixedFilamentPreview';
import { xrIcon } from '../ui/icons';

/** A single pre-flight banner surfaced to both shells. */
export interface PreflightBanner {
  id: string;
  severity: 'error' | 'warning' | 'info';
  text: string;
}

/** Fallback bed until the profile catalog loads. */
const PLATE_MM = 200;
const MM = 0.001;
/** Visual magnification of the whole workspace: true-scale 3D-print beds
 *  read tiny in XR. Uniform, so transform baking cancels it exactly. */
const WORKSPACE_SCALE = 1.75;
/** Fallback pose before the XR session gives us a head pose. */
const PLATE_Y = 1.2;
const PLATE_Z = -0.7;

/** Copy an arbitrary ArrayBuffer view into an owned, Blob/File-safe buffer. */
function ownedArrayBuffer(view: ArrayBufferView<ArrayBufferLike>): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

/** One plated model: its source geometry, the display mesh, and the grab proxy. */
type ModelEntry = { raw: THREE.BufferGeometry; display: THREE.Mesh; viewer: THREE.Object3D };

export type WorkspaceGizmoTool = 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint';

export interface WorkspaceAutomationSnapshot {
  workspaceMode: 'Prepare' | 'Preview';
  activePlateId: number;
  gizmoTool: WorkspaceGizmoTool;
  selectedProfileId: string | null;
  placedModelsTotalAllPlates: number;
  plates: { id: number; label: string; count: number; active: boolean }[];
  placedModels: {
    id: string;
    label: string;
    plateId: number;
    translateXmm: number;
    translateYmm: number;
    translateZmm: number;
    rotXDeg: number;
    rotYDeg: number;
    rotZDeg: number;
    scaleXPct: number;
    scaleYPct: number;
    scaleZPct: number;
  }[];
}

export class OrcaWorkspace extends xb.Script {
  private uiCore: UICore;
  private readonly lifecycleDisposers: Array<() => void> = [];
  private disposed = false;
  private readonly actionRegistry = buildRegistry();
  private slicer = new SlicerClient();
  /** True once a post-import local-engine warm-up has been scheduled. */
  private slicerWarmupQueued = false;
  private catalog = new ProfileCatalog();
  private profile: SlicerProfile | null = null;
  /** Live bed size (mm) — from the active profile's printable_area. */
  private bedMm = { x: PLATE_MM, y: PLATE_MM };
  private plateAnchor = new THREE.Object3D();
  /** Everything spatial lives in this group: scaled up for legibility and
   *  re-posed in front of the user when the XR session starts. */
  private workspace = new THREE.Group();
  /**
   * Multi-plate: each plate owns its own models. `models` is the ACTIVE plate's
   * array (a getter, so all the existing `.push`/`.splice`/`.indexOf` on
   * `this.models` transparently target the active plate). Inactive plates keep
   * their viewers in the scene graph but hidden.
   */
  private plates: { id: number; label: string; models: ModelEntry[] }[] = [{ id: 1, label: 'Plate 1', models: [] }];
  private activePlateId = 1;
  private nextPlateId = 2;
  private get models(): ModelEntry[] {
    return (this.plates.find((p) => p.id === this.activePlateId) ?? this.plates[0]).models;
  }
  /** Fired on plate add/remove/switch so the DOM plate bar can re-render. */
  public onPlatesChanged: (() => void) | null = null;
  /** The model actions like Repair / Delete / Boolean / Auto-orient act on.
   *  Set by selectModel and auto-selected on load; previously undeclared, which
   *  silently made all those actions no-op ("select a model first"). */
  private selectedModel: ModelEntry | null = null;
  /** Fired when the selection changes so the UI can enable selection actions. */
  public onSelectionChanged: ((hasSelection: boolean) => void) | null = null;
  /** Fired when the selected model is transformed (moved, rotated, scaled). */
  public onSelectionTransformChanged: (() => void) | null = null;
  public onSliceStateChanged: ((isSlicing: boolean) => void) | null = null;
  private statusText: UIText | null = null;
  private sliceModalCard: UICard | null = null;
  private sliceModalText: UIText | null = null;
  private sliceModalBar: UIPanel | null = null;
  private sliceModalProgressContainer: UIPanel | null = null;
  private lastGcode: string | null = null;
  private toolpathObj: THREE.LineSegments | null = null;
  private previewOn = false;
  private needsRecenter = false;

  public orbitControls: OrbitControls | null = null;
  private transformControls: TransformControls | null = null;
  public onStatusChanged: ((text: string, percent?: number) => void) | null = null;
  public onDownloadReady: ((ready: boolean) => void) | null = null;
  /** Extra slicer overrides set from the UI (e.g. wall generator). Merged last. */
  public customOverrides: Record<string, string> = {};
  /** When true, sliceNow computes wipe_tower_x/y from the plated models. */
  public wipeTowerAuto = false;
  /**
   * Painted (multi-colour) slicing. ON since patch 0075: the engine's
   * multi-material tool-ordering OOBs (empty filament_map/flush-matrix
   * indexing in `calc_filament_change_info_by_toolorder`,
   * `cal_most_used_extruder`'s heap-corrupting write, and the silent
   * layer-wipe in `reorder_extruders_for_minimum_flush_volume`) are fixed,
   * the never-called `init_filament_option_keys()` now runs so
   * `set_num_filaments` actually sizes the per-filament vectors, and the
   * wasm shim normalizes them post-overrides. Verified under Node
   * (wasm/test_slice_painted.mjs) with and without a prime tower.
   */
  public paintedSliceEnabled = true;
  /** Fired whenever the pre-flight banner set changes (bed collision, filament rules…). */
  public onPreflight: ((banners: PreflightBanner[]) => void) | null = null;
  private preflightBanners: PreflightBanner[] = [];
  private filamentRules: FilamentRules = EMPTY_RULES;

  constructor() {
    super();
    this.uiCore = new UICore(this);
  }

  async init() {
    if (xb.core.input.raycaster) {
      xb.core.input.raycaster.sortFunction = raycastSortFunction;
    }
    xb.core.input.addReticles();

    this.addLights();
    // NOTE: the group is NOT scaled — XR Blocks' DragManager (platform
    // translate, rotation cylinder, panel pinch) breaks inside scaled
    // ancestors. Sizes are multiplied by WORKSPACE_SCALE directly.
    this.add(this.workspace);
    this.addBuildPlate();
    // A bad uikit prop in a panel must not kill everything after it in this
    // init (profile catalog, slicer warm-up) — the July 2026 "menus stuck in
    // Loading profiles" prod outage was exactly that, via an invalid margin.
    try {
      this.addControlPanel();
    } catch (e) {
      console.error('[orcaxr] XR control panel failed to build', e);
    }

    // Do not fetch the large local WASM slicer during first paint. Most first
    // visits are spent choosing a printer or inspecting the workspace; the
    // warm-up is scheduled after the first model arrives instead.
    // Load the profile catalog; default to the user's Centauri Carbon.
    // One flaky fetch (mobile network, the COI service-worker reload racing
    // the request) used to leave the catalog empty for the whole session —
    // blank, dead profile dropdowns. Retry with backoff and again when the
    // browser comes back online.
    let catalogLoading = false;
    const loadCatalog = async () => {
      if (catalogLoading || this.catalog.profiles.length > 0) return;
      catalogLoading = true;
      try {
        for (let attempt = 0; this.catalog.profiles.length === 0 && attempt < 4; attempt++) {
          if (attempt > 0) {
            const delay = 1000 * 2 ** (attempt - 1);
            console.warn(`[orcaxr] profile catalog empty — retry ${attempt} in ${delay} ms`);
            await new Promise((r) => setTimeout(r, delay));
          }
          await this.catalog.load();
        }
        if (this.catalog.profiles.length === 0) {
          this.setStatus('Profile catalog failed to load — check the connection and reload.');
          return;
        }
        const p =
          this.catalog.find('Snapmaker U1 (0.4 nozzle)', '0.20 Standard', 'Snapmaker PLA') ??
          this.catalog.profiles[0] ??
          null;
        if (p) this.setProfile(p);
      } finally {
        catalogLoading = false;
      }
    };
    void loadCatalog();
    const onOnline = () => void loadCatalog();
    window.addEventListener('online', onOnline);
    this.lifecycleDisposers.push(() => window.removeEventListener('online', onOnline));
    this.slicer.onProgress = (p) => this.setStatus(`Slicing... ${p.message}`, p.percent);

    // Filament-vs-bed rules for the pre-flight check (falls back to EMPTY).
    void loadFilamentRules().then((r) => {
      this.filamentRules = r;
      this.recomputePreflight();
    });

    this.workspace.position.set(0, PLATE_Y, PLATE_Z);
    xb.core.camera.position.set(0, PLATE_Y + 0.35, PLATE_Z + 0.55);
    xb.core.camera.lookAt(0, PLATE_Y + 0.03, PLATE_Z);

    // To guarantee transient user activation for the file picker, we must
    // trigger it synchronously from the native WebXR select event, not
    // from XRBlocks' async loop or SpatialPanel's onTriggered.
    let activeSession: XRSession | null = null;
    const onSelect = () => this.checkLoadButtonAndTrigger();
    const onSessionStart = () => {
      activeSession?.removeEventListener('select', onSelect);
      const session = xb.core.renderer.xr.getSession();
      activeSession = session;
      session?.addEventListener('select', onSelect);
    };
    xb.core.renderer.xr.addEventListener('sessionstart', onSessionStart);
    this.lifecycleDisposers.push(() => {
      xb.core.renderer.xr.removeEventListener('sessionstart', onSessionStart);
      activeSession?.removeEventListener('select', onSelect);
      activeSession = null;
    });
  }

  /** Release every listener, subscription, UI card, and owned GPU resource. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.actionContext = undefined;
    this.actionStateRefreshers.clear();
    for (const dispose of this.lifecycleDisposers.splice(0).reverse()) dispose();
    this.palette.onChanged = null;
    this.uiCore.dispose();
    this.orbitControls?.dispose();
    this.orbitControls = null;
    if (this.transformControls) {
      this.transformControls.detach();
      this.remove(this.transformControls.getHelper());
      this.transformControls.dispose();
      this.transformControls = null;
    }

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.workspace.traverse((object) => {
      const renderable = object as THREE.Mesh | THREE.LineSegments;
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (Array.isArray(renderable.material)) {
        for (const material of renderable.material) materials.add(material);
      } else if (renderable.material) {
        materials.add(renderable.material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.clear();
  }

  /** Where 2D navigation should orbit: the build plate's center. Derived
   *  from the live workspace pose so camera and plate can't drift apart. */
  public plateFocus(): THREE.Vector3 {
    return this.workspace.position.clone().add(new THREE.Vector3(0, 0.03, 0));
  }

  /**
   * Snap the 2D camera to a preset view (Orca's View menu). World axes: +X =
   * printer right, +Y = up, +Z = toward the viewer (printer front), so the
   * offsets below read as the named face. No-op visually in XR (the headset
   * drives the camera and OrbitControls is disabled), harmless if called there.
   */
  public setCameraView(view: string) {
    const cam = xb.core.camera;
    const t = this.plateFocus();
    const R = 0.75;
    // Tiny Z on top/bottom avoids the straight-down gimbal lock in OrbitControls.
    const OFF: Record<string, [number, number, number]> = {
      default: [0, 0.35, 0.6],
      top: [0, R, 0.0015],
      bottom: [0, -R, 0.0015],
      front: [0, 0.06, R],
      rear: [0, 0.06, -R],
      left: [-R, 0.06, 0],
      right: [R, 0.06, 0],
    };
    const o = OFF[view] ?? OFF.default;
    cam.position.set(t.x + o[0], t.y + o[1], t.z + o[2]);
    cam.lookAt(t);
    if (this.orbitControls) {
      this.orbitControls.target.copy(t);
      this.orbitControls.update();
    }
    this.setStatus(`View: ${view}`);
  }

  public setup2DControls(canvas: HTMLCanvasElement) {
    this.transformControls = new TransformControls(xb.core.camera, canvas);
    const onDraggingChanged = (event: { value: unknown }) => {
      if (this.orbitControls) this.orbitControls.enabled = !event.value;
      if (!event.value && this.selectedModel) {
        this.snapToBed(this.selectedModel);
        if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
      }
    };
    const onTransformChanged = () => {
      if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
    };
    this.transformControls.addEventListener('dragging-changed', onDraggingChanged);
    this.transformControls.addEventListener('change', onTransformChanged);
    const controls = this.transformControls;
    this.lifecycleDisposers.push(() => {
      controls.removeEventListener('dragging-changed', onDraggingChanged);
      controls.removeEventListener('change', onTransformChanged);
    });
    this.add(this.transformControls.getHelper());

    if (this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    } else {
      this.unselectModel();
    }

    this.setupSelectionRaycaster(canvas);
  }

  public selectModel(entry: ModelEntry) {
    // Track the selection in both shells so Repair / Delete / Boolean /
    // Auto-orient have a target; the transform gizmo is 2D-only.
    this.selectedModel = entry;
    if (this.transformControls && !xb.core.renderer.xr.isPresenting) {
      this.add(this.transformControls.getHelper());
      this.transformControls.attach(entry.viewer);
      this.transformControls.getHelper().visible = true;
      this.setTool(this.tool);
      this.setStatus(`Selected model`);
    }
    if (this.onSelectionChanged) this.onSelectionChanged(true);
  }

  public getSelectedModelPosition(): THREE.Vector3 | null {
    return this.selectedModel ? this.selectedModel.viewer.position : null;
  }
  public getSelectedModelRotation(): THREE.Euler | null {
    return this.selectedModel ? this.selectedModel.viewer.rotation : null;
  }
  public getSelectedModelScale(): THREE.Vector3 | null {
    return this.selectedModel ? this.selectedModel.viewer.scale : null;
  }
  public setSelectedModelPosition(x: number, y: number, z: number) {
    if (this.selectedModel) {
      this.selectedModel.viewer.position.set(x, y, z);
      this.selectedModel.viewer.updateMatrixWorld();
      if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
    }
  }
  public setSelectedModelRotation(x: number, y: number, z: number) {
    if (this.selectedModel) {
      this.selectedModel.viewer.rotation.set(x, y, z);
      this.selectedModel.viewer.updateMatrixWorld();
      this.snapToBed(this.selectedModel);
      if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
    }
  }
  public setSelectedModelScale(x: number, y: number, z: number) {
    if (this.selectedModel) {
      this.selectedModel.viewer.scale.set(x, y, z);
      this.selectedModel.viewer.updateMatrixWorld();
      this.snapToBed(this.selectedModel);
      if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
    }
  }

  public unselectModel() {
    this.selectedModel = null;
    if (this.transformControls) {
      this.transformControls.detach();
      this.transformControls.getHelper().visible = false;
      this.remove(this.transformControls.getHelper());
      this.setStatus('Model unselected');
    }
    if (this.onSelectionChanged) this.onSelectionChanged(false);
  }

  private setupSelectionRaycaster(canvas: HTMLCanvasElement) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0,
      downY = 0;

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent) => {
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
      if (this.transformControls && (this.transformControls as unknown as { axis: string | null }).axis !== null) {
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
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    this.lifecycleDisposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
    });
  }

  private tool: WorkspaceGizmoTool = 'move';
  private activePaintColor = new THREE.Color(0xff0000); // Default to red
  public setActivePaintColor(hex: string): void {
    this.activePaintColor.set(hex);
  }
  public getActivePaintColorHex(): string {
    return '#' + this.activePaintColor.getHexString();
  }
  /** Paint brush radius in mm (model space). */
  public brushRadiusMm = 4;
  /** The set of filament slots — shared by paint, 3MF display, and slicing. */
  public palette = new FilamentPalette();
  /** Virtual (mixed) filaments adopted from the loaded FullSpectrum 3MF —
   *  read-only in the UI; their display colors match the desktop app. */
  public virtualFilaments: VirtualFilament[] = [];
  /** Prime/purge tower setup adopted from the loaded 3MF (null = none). */
  private projectPrimeTower: { enabled: boolean; xMm: number; yMm: number; widthMm: number } | null = null;
  /** The loaded project 3MF's raw bytes — FullSpectrum projects slice from
   *  this file (embedded mixed-filament config), like the desktop app. */
  private originalProject: ArrayBuffer | null = null;
  /** Exact semantic state represented by originalProject. Null means that an
   *  as-authored slice cannot safely stand in for the live workspace. */
  private originalProjectSnapshot: SemanticProjectSnapshot | null = null;
  private projectSnapshotPending = false;
  private projectSourceWasExclusive = false;
  /** Set when multiple imported semantic sources cannot be represented by one
   * immutable as-authored project. This keeps later geometry routes blocked. */
  private canonicalSliceRequiredReason: string | null = null;
  private wipeTowerGhost: THREE.Group | null = null;
  public headFilaments: string[] = [];
  public headNozzles: string[] = [];
  private headsContainer: UIPanel | null = null;

  /** Number of models currently on the plate. */
  get modelCount(): number {
    return this.models.length;
  }

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
    const cards = new Set<THREE.Object3D>(this.uiCore.cards);
    const hitUI = ints.some((intersection) => {
      let object: THREE.Object3D | null = intersection.object;
      while (object) {
        if (cards.has(object)) return true;
        object = object.parent;
      }
      return false;
    });
    if (hitUI) return;

    console.log(
      '[orcaxr-hit]',
      ints
        .slice(0, 3)
        .map((i) => `${i.object.name || i.object.type}@${i.distance.toFixed(2)}`)
        .join(' | ') || 'NOTHING',
    );
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
    const startControllerLocal = this.workspace.worldToLocal(controller.getWorldPosition(new THREE.Vector3()));
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

      const meshes = this.models.map((m) => m.viewer.getObjectByName('modelMesh')).filter(Boolean) as THREE.Mesh[];
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
    const local = this.workspace.worldToLocal(d.controller.getWorldPosition(new THREE.Vector3()));
    const delta = local.clone().sub(d.startControllerLocal);
    const halfX = (this.bedMm.x * MM * WORKSPACE_SCALE) / 2;
    const halfZ = (this.bedMm.y * MM * WORKSPACE_SCALE) / 2;
    if (this.tool === 'move') {
      entry.viewer.position.set(
        THREE.MathUtils.clamp(d.startPos.x + delta.x, -halfX, halfX),
        d.startPos.y,
        THREE.MathUtils.clamp(d.startPos.z + delta.z, -halfZ, halfZ),
      );
      this.showValues(
        `x ${(entry.viewer.position.x / (MM * WORKSPACE_SCALE)).toFixed(1)}  y ${(-entry.viewer.position.z / (MM * WORKSPACE_SCALE)).toFixed(1)} mm`,
      );
    } else if (this.tool === 'rotate') {
      // Horizontal hand sweep = yaw: 25 cm of travel = a full turn.
      entry.viewer.rotation.y = d.startRotY + (delta.x / 0.25) * Math.PI * 2;
      this.showValues(`rotZ ${(((entry.viewer.rotation.y * 180) / Math.PI) % 360).toFixed(0)}°`);
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
    for (const { viewer, display } of this.models) {
      this.snapToBed({ viewer, display });
      viewer.position.x = THREE.MathUtils.clamp(viewer.position.x, -halfX, halfX);
      viewer.position.z = THREE.MathUtils.clamp(viewer.position.z, -halfZ, halfZ);
    }
    this.recomputePreflight();
  }

  /** Distinct machine names in catalog order. */
  private machineChoices(): string[] {
    return [...new Set(this.catalog.profiles.map((p) => p.machineName))];
  }

  /** Processes compatible with the machine (same nozzle-size token). */
  private processChoices(machine: string): string[] {
    const nozzle = /0\.\d+/.exec(machine)?.[0] ?? '';
    return [
      ...new Set(
        this.catalog.profiles
          .filter((p) => p.machineName === machine && (!nozzle || p.processName.includes(nozzle)))
          .map((p) => p.processName),
      ),
    ];
  }

  private filamentChoices(machine: string): string[] {
    return [...new Set(this.catalog.profiles.filter((p) => p.machineName === machine).map((p) => p.filamentName))];
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

  /** Process + filament choices for an arbitrary machine (setup wizard). */
  choicesForMachine(machine: string) {
    return { processes: this.processChoices(machine), filaments: this.filamentChoices(machine) };
  }

  /** Select a profile by exact names (2D pickers). Unknown parts keep current. */
  setProfileByNames(machine: string, process: string, filament: string) {
    const next =
      this.catalog.profiles.find(
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
    const next =
      this.catalog.profiles.find(
        (x) => x.machineName === machine && x.processName === process && x.filamentName === filament,
      ) ?? this.catalog.find(machine, process, filament);
    if (next) this.setProfile(next);
  }

  public setProfile(p: SlicerProfile) {
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
    this.refreshXrProfileValues();

    if (this.onProfileChanged) this.onProfileChanged();
    this.bedMm = bedSizeFromProfile(p.config);
    this.rebuildPlate();
    this.rebuildWipeTowerGhost();
    this.setStatus(`profile: ${p.displayName}\nbed ${this.bedMm.x}×${this.bedMm.y} mm`);
    this.recomputePreflight();
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
      m.viewer.traverse((o) => {
        delete (o as any).draggingMode;
      });
    }

    if (this.topStripCard) this.topStripCard.show();
    if (this.leftToolbarCard) this.leftToolbarCard.show();
    // Menu/profile surfaces are opt-in. Showing every card on entry obscures
    // the plate and, worse, exposed the blank menu card before a menu was open.
    if (this.rightSidebarCard) this.rightSidebarCard.hide();
    if (this.profileCard) this.profileCard.hide();
    if (this.aiMcpCard) this.aiMcpCard.hide();
    if (this.bottomBarCard) this.bottomBarCard.show();
  }

  onXRSessionEnded() {
    if (this.orbitControls) {
      this.orbitControls.enabled = true;
    }

    // Disable XR drag for models (rely on TransformControls in 2D)
    for (const m of this.models) {
      (m.viewer as any).draggable = false;
      m.viewer.traverse((o) => {
        (o as any).draggingMode = xb.DragManager.DO_NOT_DRAG;
      });
    }

    // Restore 2D selection
    if (this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    }

    if (this.topStripCard) this.topStripCard.hide();
    if (this.leftToolbarCard) this.leftToolbarCard.hide();
    if (this.rightSidebarCard) this.rightSidebarCard.hide();
    if (this.profileCard) this.profileCard.hide();
    if (this.aiMcpCard) this.aiMcpCard.hide();
    if (this.bottomBarCard) this.bottomBarCard.hide();
  }

  onSimulatorStarted() {
    this.needsRecenter = true;
  }

  update(_time: number, _frame: XRFrame) {
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
    const pos = cam.getWorldPosition(new THREE.Vector3()).addScaledVector(fwd, 0.85);
    pos.y = Math.max(cam.getWorldPosition(new THREE.Vector3()).y - 0.45, 0.35);
    this.workspace.position.copy(pos);
    const yaw = Math.atan2(fwd.x, fwd.z) + Math.PI;
    this.workspace.rotation.set(0, yaw, 0);
    this.workspace.updateMatrixWorld(true);

    // Card zones follow the imported "OrcaXR Slicer" XR design:
    //   top-centre  → menu/mode strip
    //   left        → tool rail
    //   right (near→far) → settings inspector · all-actions/menus · device/AI
    //   bottom-centre → primary action bar
    const left = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const right = left.clone().negate();
    const place = (card: any, lateral: THREE.Vector3, dist: number, up: number, depth: number) => {
      if (!card) return;
      const ppos = pos.clone().addScaledVector(lateral, dist);
      ppos.y = pos.y + up;
      ppos.addScaledVector(fwd, depth);
      card.position.copy(ppos);
      card.rotation.set(0, yaw, 0);
      card.updateMatrixWorld(true);
    };

    // Top-centre menu/mode strip, tilted just above the plate.
    place(this.topStripCard, right, 0, 0.5, -0.05);
    // Left tool rail.
    place(this.leftToolbarCard, left, 0.5, 0.15, -0.12);
    // Right column, curving toward the user as it fans out.
    place(this.profileCard, right, 0.5, 0.2, -0.08); // settings inspector (nearest)
    place(this.rightSidebarCard, right, 0.98, 0.15, 0.06); // all actions / menus
    place(this.aiMcpCard, right, 1.42, 0.12, 0.16); // device / AI (farthest)
    // Bottom-centre primary action bar, in front of and below the plate.
    place(this.bottomBarCard, right, 0, -0.35, 0.35);
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
    const maxDim = Math.max(sx, sz);

    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(sx, 0.006, sz),
      new THREE.MeshStandardMaterial({
        color: 0x0d141c,
        roughness: 0.2,
        metalness: 0.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    plate.name = 'plate';
    plate.position.set(0, -0.003, 0);
    this.plateParts.add(plate);

    const grid = new THREE.GridHelper(maxDim, 10, 0xff6d00, 0xff8a3d);
    grid.position.set(0, 0.0002, 0);
    grid.scale.set(sx / maxDim, 1, sz / maxDim);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.15;
    grid.raycast = () => {};
    this.plateParts.add(grid);

    const createRing = (radius: number, color: number, opacity: number, yOffset: number) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.002, 16, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = yOffset;
      ring.raycast = () => {};
      return ring;
    };

    const rBase = maxDim * 0.6;
    this.plateParts.add(createRing(rBase * 0.5, 0xff8a3d, 0.5, -0.01));
    this.plateParts.add(createRing(rBase * 0.75, 0xffb74d, 0.55, -0.02));
    this.plateParts.add(createRing(rBase, 0xff6d00, 0.7, -0.03));

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.01, 32),
      new THREE.MeshBasicMaterial({ color: 0xff6d00, transparent: true, opacity: 0.8 }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.0003;
    dot.raycast = () => {};
    this.plateParts.add(dot);

    const bar = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.012, sx * 0.5),
      new THREE.MeshStandardMaterial({
        color: 0xff6d00,
        roughness: 0.3,
        emissive: 0xff6d00,
        emissiveIntensity: 0.2,
      }),
    );
    bar.name = 'grabBar';
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.005, sz / 2 + 0.045);
    (bar as unknown as { draggingMode: unknown }).draggingMode = xb.DragManager.TRANSLATING;
    this.plateParts.add(bar);
    (this.workspace as unknown as { draggable: boolean }).draggable = true;
  }

  /**
   * (Re)build the semi-transparent prime/purge tower ghost on the plate,
   * mirroring the loaded project's `enable_prime_tower` + `wipe_tower_x/y` +
   * `prime_tower_width` — the same frame libslic3r uses (mm, bed corner
   * origin, the tower's front-left corner). The footprint is square (the real
   * tower's depth depends on purge volumes; this is a placement ghost, like
   * the desktop plate preview before slicing).
   */
  public rebuildWipeTowerGhost() {
    if (this.wipeTowerGhost) {
      this.workspace.remove(this.wipeTowerGhost);
      this.wipeTowerGhost = null;
    }
    const pt = this.projectPrimeTower;
    if (!pt || !pt.enabled) return;

    const vis = MM * WORKSPACE_SCALE;
    const w = Math.max(1, pt.widthMm) * vis;
    // Tower height tracks the tallest plated model (printer mm), like the
    // desktop ghost; a stand-in height when the plate is still empty.
    let heightMm = 0;
    for (const geo of this.printerGeometries()) {
      geo.computeBoundingBox();
      if (geo.boundingBox) heightMm = Math.max(heightMm, geo.boundingBox.max.z);
    }
    if (heightMm <= 0) heightMm = 30;
    const h = heightMm * vis;

    // Clamp the corner so the ghost stays on the bed even for odd configs.
    const xMm = Math.min(Math.max(pt.xMm, 0), Math.max(0, this.bedMm.x - pt.widthMm));
    const yMm = Math.min(Math.max(pt.yMm, 0), Math.max(0, this.bedMm.y - pt.widthMm));

    const group = new THREE.Group();
    group.name = 'wipeTowerGhost';
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, w),
      new THREE.MeshStandardMaterial({
        color: 0x9e9e9e,
        roughness: 0.7,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    box.raycast = () => {}; // decorative: never swallow picks
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry),
      new THREE.LineBasicMaterial({ color: 0xcfd8dc, transparent: true, opacity: 0.8 }),
    );
    edges.raycast = () => {};
    group.add(box, edges);

    // Bed corner-origin (xMm, yMm) → workspace: bed centre at origin,
    // printer +Y toward the back (world -Z). Position the box's CENTER.
    group.position.set(
      (xMm + pt.widthMm / 2 - this.bedMm.x / 2) * vis,
      h / 2,
      (this.bedMm.y / 2 - (yMm + pt.widthMm / 2)) * vis,
    );
    this.wipeTowerGhost = group;
    this.workspace.add(group);
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
  /** Generic file save (STL/3MF export). Wired to a browser download in main.ts. */
  onDownloadFile: ((name: string, data: BlobPart, mime: string) => void) | null = null;
  /** Injected by main.ts: requests the browser to open the file picker. */
  onRequestLoadStl: (() => void) | null = null;
  /** Injected by main.ts: opens a .zip-filtered picker (Import Zip Archive). */
  onRequestLoadZip: (() => void) | null = null;
  /** Injected by main.ts: opens a .3mf picker for Open Project. */
  onRequestLoadProject: (() => void) | null = null;
  /** Injected by main.ts: opens a .json picker for Import Config. */
  onRequestLoadConfig: (() => void) | null = null;

  // --- Import / Export Config (Orca File → Import / Export Config) -----
  /** Serialise the active profile's config to a JSON bundle string (or null). */
  public buildConfigJson(): string | null {
    if (!this.profile) return null;
    const opts = this.getProfileOptions();
    return exportConfigJson({
      machineName: opts.machine,
      processName: opts.process,
      filamentName: opts.filament,
      config: this.profile.config,
    });
  }

  /** Download the active config as JSON (File → Export Config). */
  public exportActiveConfig() {
    const json = this.buildConfigJson();
    if (!json) {
      this.setStatus('No active profile to export.');
      return;
    }
    if (this.onDownloadFile) this.onDownloadFile('orcaxr_config.json', json, 'application/json');
    this.setStatus('Exported config.');
  }

  /** Apply an imported config bundle over the current profile (File → Import Config). */
  public importConfig(text: string): boolean {
    const b = parseConfigJson(text);
    if (!b) {
      this.setStatus('Not a valid config file.');
      return false;
    }
    // Merge over the current config so a partial bundle still yields a working
    // profile (a full OrcaXR export replaces it outright).
    const merged = { ...(this.profile?.config ?? {}), ...b.config };
    this.setProfile({
      id: 'imported',
      displayName: `${b.machineName} (imported)`,
      machineName: b.machineName,
      processName: b.processName,
      filamentName: b.filamentName,
      config: merged,
    });
    this.setStatus(`Imported config — ${Object.keys(b.config).length} keys.`);
    return true;
  }
  /** Injected by main.ts: renders a simple informational modal (Help menu). */
  onShowModal: ((spec: { title: string; bodyHtml: string }) => void) | null = null;
  /** Injected by main.ts: opens the interactive printer/filament setup wizard. */
  onShowSetupWizard: (() => void) | null = null;

  /** Show a titled informational modal, or fall back to the status line in XR. */
  public showModal(title: string, bodyHtml: string) {
    if (this.onShowModal) this.onShowModal({ title, bodyHtml });
    else this.setStatus(title);
  }

  /**
   * Load one model from an in-memory file buffer, dispatching by extension
   * (STL / 3MF / OBJ). Shared by the zip importer so archive entries get the
   * same treatment as a directly-imported file. Returns true if it loaded.
   */
  async loadModelFromBuffer(name: string, buf: ArrayBuffer): Promise<boolean> {
    const lower = name.toLowerCase();
    if (lower.endsWith('.stl')) {
      this.loadModelFromGeometry(new STLLoader().parse(buf), name);
      return true;
    }
    if (lower.endsWith('.3mf')) {
      const colors = await extract3mfColors(buf);
      const paint = extract3mfPaint(buf);
      await this.adoptPaletteFrom3mf(buf);
      this.loadModelFromGroup(new ThreeMFLoader().parse(buf), name, colors ?? undefined, paint);
      return true;
    }
    if (lower.endsWith('.obj')) {
      const group = new OBJLoader().parse(new TextDecoder().decode(new Uint8Array(buf)));
      let any = false;
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) {
          this.loadModelFromGeometry(mesh.geometry as THREE.BufferGeometry, name);
          any = true;
        }
      });
      return any;
    }
    return false;
  }

  /**
   * Import every STL / 3MF / OBJ model inside a .zip archive (Orca File →
   * Import Zip Archive). Returns how many models loaded.
   */
  async importZipArchive(buf: ArrayBuffer): Promise<number> {
    let entries: Record<string, Uint8Array>;
    try {
      entries = fflate.unzipSync(new Uint8Array(buf));
    } catch (e) {
      this.setStatus(`Not a readable zip: ${(e as Error).message}`);
      return 0;
    }
    const names = Object.keys(entries).filter(
      (n) => /\.(stl|3mf|obj)$/i.test(n) && !n.startsWith('__MACOSX') && !n.includes('/._'),
    );
    let count = 0;
    for (const n of names) {
      const u8 = entries[n];
      const ab = ownedArrayBuffer(u8);
      try {
        if (await this.loadModelFromBuffer(n.split('/').pop() || n, ab)) count++;
      } catch (e) {
        console.warn('[zip] failed to load', n, e);
      }
    }
    this.setStatus(
      count > 0
        ? `Imported ${count} model${count === 1 ? '' : 's'} from archive.`
        : 'No STL/3MF/OBJ models found in the archive.',
    );
    return count;
  }

  /** Load an STL or 3MF by URL into the library (used by tests + built-ins). */
  async loadModelFromUrl(url: string): Promise<void> {
    const t0 = performance.now();
    console.log('[orcaxr-load] fetching', url);
    const name = url.split('/').pop() ?? url;

    if (url.toLowerCase().endsWith('.3mf')) {
      this.setStatus(`Downloading ${name}...`);
      this.setProgress(10);
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();

      this.setStatus(`Extracting colors...`);
      this.setProgress(30);
      await new Promise((r) => setTimeout(r, 50));
      const colors = await extract3mfColors(buf);
      const paint = extract3mfPaint(buf);
      await this.adoptPaletteFrom3mf(buf);

      this.setStatus(`Parsing 3MF geometry...`);
      this.setProgress(60);
      await new Promise((r) => setTimeout(r, 50));
      const group = new ThreeMFLoader().parse(buf);
      console.log('[orcaxr-load] parsed 3MF in', Math.round(performance.now() - t0), 'ms');

      this.setStatus(`Building scene...`);
      this.setProgress(90);
      await new Promise((r) => setTimeout(r, 50));
      this.loadModelFromGroup(group, name, colors ?? undefined, paint);
    } else {
      this.setStatus(`Downloading ${name}...`);
      this.setProgress(10);
      const raw = await new STLLoader().loadAsync(url);
      console.log(
        '[orcaxr-load] parsed STL in',
        Math.round(performance.now() - t0),
        'ms,',
        raw.getAttribute('position').count / 3,
        'tris',
      );

      this.setStatus(`Building scene...`);
      this.setProgress(90);
      await new Promise((r) => setTimeout(r, 50));
      this.loadModelFromGeometry(raw, name);
    }
    this.setProgress(undefined);
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

  /** Drop a stock primitive on the bed (20 mm, printer-frame Z-up). */
  public addPrimitive(kind: 'cube' | 'cylinder' | 'sphere') {
    let geo: THREE.BufferGeometry;
    switch (kind) {
      case 'cylinder':
        geo = new THREE.CylinderGeometry(10, 10, 20, 48);
        geo.rotateX(Math.PI / 2); // axis Y → printer Z
        break;
      case 'sphere':
        geo = new THREE.SphereGeometry(10, 48, 32);
        break;
      default:
        geo = new THREE.BoxGeometry(20, 20, 20);
    }
    this.loadModelFromGeometry(geo.toNonIndexed(), `${kind}.stl`);
    this.setStatus(`Added ${kind}.`);
  }

  /** Drop a calibration test model (temperature/overhang tower or XYZ cube). */
  public addCalibration(
    kind:
      | 'tower'
      | 'cube'
      | 'flow_pass1'
      | 'flow_pass2'
      | 'flow_yolo'
      | 'pressure_advance'
      | 'retraction'
      | 'max_flow'
      | 'vfa'
      | 'tolerance',
  ) {
    const gen = new CalibrationRampGenerator();
    let geo: THREE.BufferGeometry;
    let filename = `calib_${kind}.stl`;
    switch (kind) {
      case 'tower':
        geo = gen.generateTemperatureTower();
        filename = 'temp_tower.stl';
        break;
      case 'cube':
        geo = gen.generateCalibrationCube();
        filename = 'calibration_cube.stl';
        break;
      case 'flow_pass1':
        geo = gen.generateFlowPass1();
        break;
      case 'flow_pass2':
        geo = gen.generateFlowPass2();
        break;
      case 'flow_yolo':
        geo = gen.generateFlowYolo();
        break;
      case 'pressure_advance':
        geo = gen.generatePressureAdvance();
        break;
      case 'retraction':
        geo = gen.generateRetraction();
        break;
      case 'max_flow':
        geo = gen.generateMaxFlow();
        break;
      case 'vfa':
        geo = gen.generateVfa();
        break;
      case 'tolerance':
        geo = gen.generateTolerance();
        break;
    }
    this.loadModelFromGeometry(geo.toNonIndexed(), filename);
    this.setStatus(`Added calibration ${kind}.`);
  }

  // ---- Multi-plate --------------------------------------------------------
  public get plateCount(): number {
    return this.plates.length;
  }
  public getPlates(): { id: number; label: string; count: number; active: boolean }[] {
    return this.plates.map((p) => ({
      id: p.id,
      label: p.label,
      count: p.models.length,
      active: p.id === this.activePlateId,
    }));
  }

  /** Read-only, serializable boundary used by diagnostics and permissioned automation. */
  public getAutomationSnapshot(): WorkspaceAutomationSnapshot {
    const plates = this.getPlates();
    return {
      workspaceMode: this.previewOn ? 'Preview' : 'Prepare',
      activePlateId: this.activePlateId,
      gizmoTool: this.tool,
      selectedProfileId: this.profile?.id ?? null,
      placedModelsTotalAllPlates: plates.reduce((sum, plate) => sum + plate.count, 0),
      plates,
      placedModels: this.models.map((model, index) => ({
        id: model.viewer.uuid,
        label: model.viewer.name || `Model ${index + 1}`,
        plateId: this.activePlateId,
        translateXmm: model.viewer.position.x / (MM * WORKSPACE_SCALE),
        translateYmm: -model.viewer.position.z / (MM * WORKSPACE_SCALE),
        translateZmm: model.viewer.position.y / (MM * WORKSPACE_SCALE),
        rotXDeg: THREE.MathUtils.radToDeg(model.viewer.rotation.x),
        rotYDeg: THREE.MathUtils.radToDeg(model.viewer.rotation.y),
        rotZDeg: THREE.MathUtils.radToDeg(model.viewer.rotation.z),
        scaleXPct: model.viewer.scale.x * 100,
        scaleYPct: model.viewer.scale.y * 100,
        scaleZPct: model.viewer.scale.z * 100,
      })),
    };
  }

  /** Create a new empty plate and switch to it. */
  public addPlate() {
    const id = this.nextPlateId++;
    this.plates.push({ id, label: `Plate ${id}`, models: [] });
    this.setActivePlate(id);
  }

  /**
   * Duplicate the active plate: create a new plate and deep-copy every model
   * (geometry + its move/rotate/scale transform) onto it (Orca top toolbar →
   * Duplicate Plate). Snapshots the source before switching plates, since
   * `this.models` follows the active plate.
   */
  public duplicateCurrentPlate() {
    const snap = this.models.map((m) => ({
      raw: m.raw.clone(), // clone carries the vertex-colour paint
      pos: m.viewer.position.clone(),
      quat: m.viewer.quaternion.clone(),
      scale: m.viewer.scale.clone(),
    }));
    this.addPlate(); // creates + switches to a new empty plate
    for (const s of snap) {
      this.addModelFromGeometry(s.raw, 0x4fc3f7);
      const added = this.models[this.models.length - 1];
      added.viewer.position.copy(s.pos);
      added.viewer.quaternion.copy(s.quat);
      added.viewer.scale.copy(s.scale);
    }
    this.recomputePreflight();
    this.setStatus(`Duplicated plate — ${snap.length} model${snap.length === 1 ? '' : 's'} copied.`);
  }

  /** Switch the active plate; inactive plates' models are hidden, not removed. */
  public setActivePlate(id: number) {
    const target = this.plates.find((p) => p.id === id);
    if (!target) return;
    if (id === this.activePlateId) {
      if (this.onPlatesChanged) this.onPlatesChanged();
      return;
    }
    for (const m of this.models) m.viewer.visible = false; // hide current plate
    this.unselectModel();
    this.activePlateId = id;
    for (const m of this.models) m.viewer.visible = true; // show target plate
    this.setStatus(`Switched to ${target.label}.`);
    this.recomputePreflight();
    if (this.onSelectionChanged) this.onSelectionChanged(false);
    if (this.onPlatesChanged) this.onPlatesChanged();
  }

  /** Delete a plate (defaults to the active one); refuses the last plate. */
  public deletePlate(id: number = this.activePlateId) {
    if (this.plates.length <= 1) {
      this.setStatus('Cannot delete the last plate.');
      return;
    }
    const idx = this.plates.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const wasActive = id === this.activePlateId;
    for (const m of this.plates[idx].models) {
      this.workspace.remove(m.viewer);
      m.display.geometry.dispose();
    }
    this.plates.splice(idx, 1);
    if (wasActive) {
      const next = this.plates[Math.min(idx, this.plates.length - 1)];
      this.activePlateId = next.id;
      this.unselectModel();
      for (const m of next.models) m.viewer.visible = true;
      if (this.onSelectionChanged) this.onSelectionChanged(false);
      this.recomputePreflight();
      this.setStatus(`Deleted plate; switched to ${next.label}.`);
    } else {
      this.setStatus('Plate deleted.');
    }
    if (this.onPlatesChanged) this.onPlatesChanged();
  }

  /**
   * Decimate the selected model's mesh (quadric-ish edge collapse via THREE's
   * SimplifyModifier). `keepRatio` is the fraction of vertices to retain.
   */
  public simplifySelected(keepRatio = 0.5) {
    if (!this.selectedModel) {
      this.setStatus('Select a model to simplify first.');
      return;
    }
    const entry = this.selectedModel;
    const before = entry.raw.getAttribute('position').count;
    const remove = Math.max(0, Math.floor(before * (1 - keepRatio)));
    try {
      this.setStatus(`Simplifying ${before} verts…`);
      const simplified = new SimplifyModifier().modify(entry.raw, remove);
      if (!simplified.hasAttribute('color')) {
        const n = simplified.getAttribute('position').count;
        const colors = new Float32Array(n * 3).fill(0.62);
        simplified.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
      simplified.computeVertexNormals();
      simplified.computeBoundsTree();
      entry.raw = simplified;
      entry.display.geometry.dispose();
      entry.display.geometry = simplified;
      const after = simplified.getAttribute('position').count;
      this.setStatus(`Simplified: ${before} → ${after} verts.`);
      this.recomputePreflight();
    } catch (e) {
      this.setStatus(`Simplify failed: ${(e as Error).message}`);
    }
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

  /** Seed the filament palette from a 3MF's own filament_colour list, adopt
   *  its FullSpectrum virtual filaments, and pick up its prime-tower setup. */
  async adoptPaletteFrom3mf(buf: ArrayBuffer) {
    // Importing anything after an as-authored project invalidates that source.
    // A new FullSpectrum source is eligible only when it starts from the one
    // empty default plate; otherwise its raw bytes omit existing workspace
    // content and must never be used as a lossy shortcut.
    const sourceWasExclusive =
      this.plates.length === 1 && this.plates[0].id === this.activePlateId && this.plates[0].models.length === 0;
    const hadFullSpectrumSource =
      this.canonicalSliceRequiredReason !== null || (this.virtualFilaments.length > 0 && this.originalProject !== null);

    let cfg: Record<string, unknown>;
    try {
      const unzipped = fflate.unzipSync(new Uint8Array(buf));
      const proj = unzipped['Metadata/project_settings.config'];
      if (!proj) return;
      const parsed = JSON.parse(new TextDecoder().decode(proj));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Metadata/project_settings.config must contain a JSON object');
      }
      cfg = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Could not read 3MF project settings: ${(e as Error).message}`, { cause: e });
    }

    const colors: string[] | undefined =
      Array.isArray(cfg.filament_colour) && cfg.filament_colour.length ? (cfg.filament_colour as string[]) : undefined;
    const types: string[] | undefined = Array.isArray(cfg.filament_type) ? (cfg.filament_type as string[]) : undefined;
    const virtualFilaments = virtualFilamentsFromConfig(cfg);
    const first = (value: unknown): string =>
      Array.isArray(value) ? `${value[0] ?? ''}` : value === null || value === undefined ? '' : `${value}`;

    this.originalProject = buf.slice(0);
    this.originalProjectSnapshot = null;
    this.projectSnapshotPending = true;
    this.projectSourceWasExclusive = sourceWasExclusive;
    this.virtualFilaments = virtualFilaments;
    this.projectPrimeTower = {
      enabled: first(cfg.enable_prime_tower) === '1',
      xMm: parseFloat(first(cfg.wipe_tower_x)) || 0,
      yMm: parseFloat(first(cfg.wipe_tower_y)) || 0,
      widthMm: parseFloat(first(cfg.prime_tower_width)) || 35,
    };
    this.canonicalSliceRequiredReason = combinedSemanticImportRequiresCanonicalSlice({
      sourceWasExclusive,
      hadFullSpectrumSource,
      incomingVirtualFilamentCount: virtualFilaments.length,
    })
      ? 'Multiple imported project sources include FullSpectrum intent and require canonical live-project slicing.'
      : null;

    // Virtual rows are committed before the palette notification so both UIs
    // observe one coherent material snapshot.
    if (colors) this.palette.setFrom(colors, types);
    else this.palette.onChanged?.();
    this.rebuildHeadsPanel();
    this.rebuildWipeTowerGhost();
  }

  /** Merge a Three.js Group (e.g. from 3MFLoader) into a single model, preserving colors. */
  loadModelFromGroup(group: THREE.Object3D, name: string, meshColors?: string[], paint?: Paint3mfResult | null) {
    console.log(
      `[orcaxr-load] loadModelFromGroup called with meshColors:`,
      meshColors,
      'paintedMeshes:',
      paint ? [...paint.meshes.keys()] : 'none',
    );
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

        // Per-triangle 3MF paint (Orca/Bambu paint_color) wins over the flat
        // per-object extruder color: subdivide painted triangles and bake the
        // palette into vertex colors (display + painted slicing both read
        // vertex colors downstream).
        const meshPaint = paint?.meshes.get(meshIndex);
        if (meshPaint) {
          const baseHex = meshColors?.[meshIndex] ?? '#cccccc';
          const painted = applyPaintToPositions(
            geom.attributes.position.array as Float32Array,
            meshPaint,
            paint!.palette,
            baseHex,
          );
          if (painted) {
            const pg = new THREE.BufferGeometry();
            pg.setAttribute('position', new THREE.BufferAttribute(painted.positions, 3));
            pg.setAttribute('color', new THREE.BufferAttribute(painted.colors, 3));
            pg.computeVertexNormals();
            console.log(
              `[paint3mf] mesh ${meshIndex}: ${geom.attributes.position.count / 3} tris → ${painted.positions.length / 9} painted tris`,
            );
            geom = pg;
          }
        }

        // Native 3MF loading (via ThreeMFLoader) uses standard 3MF colors.
        // It places them in child.material.color OR as vertex colors.
        // If we have custom meshColors mapped from Orca 3MF configs, use them.
        // Always rewrite the color attribute so we have uniform vertex colors for merging.
        const count = geom.attributes.position.count;
        const colors = new Float32Array(count * 3);

        let colorObj = child.material && child.material.color ? child.material.color : new THREE.Color(0xffffff);
        if (meshPaint && geom.hasAttribute('color')) {
          colorObj = null; // paint already baked per-vertex colors
        } else if (meshColors && meshColors[meshIndex]) {
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
        console.log(
          `Geom ${i}: index=${g.index !== null}, position=${g.attributes.position?.itemSize}, normal=${g.attributes.normal?.itemSize}, color=${g.attributes.color?.itemSize}, attrs=${Object.keys(g.attributes).join(',')}`,
        );
      }
      const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
      if (merged) {
        console.log(`Merged successfully! Attributes: ${Object.keys(merged.attributes).join(',')}`);
        this.loadModelFromGeometry(merged, name);
        // Finalize only for an exclusive import. An FS file added beside any
        // existing workspace content remains visible/editable, but slicing it
        // must wait for the canonical live-project coordinator.
        if (this.projectSnapshotPending) {
          this.originalProjectSnapshot = this.projectSourceWasExclusive ? this.captureSemanticProjectSnapshot() : null;
          this.projectSnapshotPending = false;
          this.projectSourceWasExclusive = false;
        }
      } else {
        console.error('mergeGeometries RETURNED NULL!');
      }
    }
    if (this.projectSnapshotPending) {
      // A source whose geometry failed to load can never become an eligible
      // snapshot during some later, unrelated group import.
      this.projectSnapshotPending = false;
      this.projectSourceWasExclusive = false;
    }
  }

  public addFromLibrary() {
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

    const mesh = new THREE.Mesh(raw, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    mesh.name = 'modelMesh';
    // STL is mm / Z-up; display is meters / Y-up, magnified.
    const vis = MM * WORKSPACE_SCALE;
    mesh.scale.setScalar(vis);
    mesh.rotation.x = -Math.PI / 2;
    raw.computeBoundingBox();
    const bb = raw.boundingBox!;
    mesh.position.set((-(bb.min.x + bb.max.x) / 2) * vis, -bb.min.z * vis, ((bb.min.y + bb.max.y) / 2) * vis);

    const model = new xb.ModelViewer({});
    model.add(mesh);
    void model.setupBoundingBox();
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
    const entry: ModelEntry = { raw, display: mesh, viewer: model };
    this.workspace.add(model);
    this.models.push(entry);
    // Keep new models consistent with active View overlays.
    if (this.wireframeOn) this.applyWireframe(entry, true);
    if (this.labelsOn) this.applyLabel(entry, this.models.length - 1, true);
    if (this.overhangOn) this.applyOverhang(entry, true);
    // Auto-select the just-loaded model so Repair / Delete / Auto-orient act on
    // it immediately (standard slicer behaviour, works in both shells).
    this.selectModel(entry);
    this.recomputePreflight();
    this.warmSlicerAfterFirstModel();
  }

  /**
   * Prime the local engine after import has settled, not while the empty
   * workspace is trying to appear. `SlicerClient` deduplicates this promise,
   * so an immediate Slice simply joins the same load. An external slicer has
   * no browser WASM cost and intentionally skips this path.
   */
  private warmSlicerAfterFirstModel() {
    if (this.slicerWarmupQueued || SlicerClient.useExternalSlicer()) return;
    this.slicerWarmupQueued = true;
    window.setTimeout(() => {
      this.slicer.load().catch((e) => {
        console.warn('[slicer] background warm-up failed; it will retry on Slice:', e);
        this.slicerWarmupQueued = false;
      });
    }, 1200);
  }

  /** Build/replace the toolpath preview from sliced G-code and show it. */
  private showToolpathPreview(gcode: string) {
    this.clearToolpathPreview();
    const filamentColors = this.palette
      .list()
      .map((s) => s.color)
      .concat(this.virtualFilaments.map((v) => v.color));
    const { geometry, segmentCount } = parseGcodeToolpath(gcode, filamentColors);
    if (segmentCount === 0) return;
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
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
      this.models[this.models.length - 1]?.viewer ??
      null;
    if (!target) {
      this.setStatus('no model');
      return;
    }
    if (this.tool === 'rotate') {
      target.rotation.y += dir * (Math.PI / 12);
      this.setStatus(
        `rotation: ${Math.round(THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(target.rotation.y), 360))}°`,
      );
    } else if (this.tool === 'scale') {
      const next = THREE.MathUtils.clamp(target.scale.x * (1 + dir * 0.1), 0.05, 40);
      target.scale.setScalar(next);
      this.setStatus(`scale: ${Math.round(next * 100)}%`);
    } else {
      const halfX = (this.bedMm.x * MM * WORKSPACE_SCALE) / 2;
      target.position.x = THREE.MathUtils.clamp(target.position.x + dir * 5 * MM * WORKSPACE_SCALE, -halfX, halfX);
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
      try {
        panel.remove(btn);
      } catch {
        /* ignore */
      }
    }
    this.paintSwatches = [];
    this.palette.list().forEach((slot, i) => {
      const hex = slot.color;
      const swatch = new UIPanel({
        width: 35,
        height: 35,
        cornerRadius: 4,
        fillColor: hex,
        strokeWidth: 2,
        strokeColor: '#444444',
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

  /**
   * Injected by main.ts after construction. The XR tool card routes button
   * clicks through this so the immersive shell runs the SAME action handlers as
   * the DOM shell (structural parity). Read at click time, so it can be set
   * after the (eagerly-built, hidden) cards are constructed.
   */
  private _actionContext?: ActionContext;
  private actionStateUnsubscribe: (() => void) | null = null;
  private readonly actionStateRefreshers = new Set<() => void>();

  public get actionContext(): ActionContext | undefined {
    return this._actionContext;
  }

  public set actionContext(value: ActionContext | undefined) {
    this.actionStateUnsubscribe?.();
    this.actionStateUnsubscribe = null;
    this._actionContext = value;
    if (!value) return;
    // Exactly one subscription owns all XR capability-state refreshes. Panels
    // register render callbacks even when they are constructed before main.ts
    // injects the ActionContext.
    this.actionStateUnsubscribe = value.ui.subscribe(() => {
      for (const refresh of this.actionStateRefreshers) refresh();
    });
  }

  private registerActionStateRefresher(refresh: () => void): void {
    this.actionStateRefreshers.add(refresh);
    if (this.actionContext) refresh();
  }
  private toolButtons: { action: Action; btn: UIPanel; iconEl: XRImage }[] = [];
  // Top-bar dropdown menu state (progressive disclosure of the full menu surface).
  private menuBarButtons: { id: string; btn: UIPanel; label: UIText }[] = [];
  private openMenuSection: string | null = null;
  private menuPanelRoot: UIPanel | null = null;
  private menuPanelTitle: UIText | null = null;
  private paintOptionsPanel?: UIPanel;
  private paintSwatches: { c: number; btn: UIPanel }[] = [];
  private valueText: UIText | null = null;
  private progressBar: UIPanel | null = null;
  private progressContainer: UIPanel | null = null;
  private loadButtonNode: THREE.Object3D | null = null;
  private leftToolbarCard: UICard | null = null;
  private rightSidebarCard: UICard | null = null;
  private profileCard: UICard | null = null;
  /** Live profile values shown in the XR profile picker. Icons alone made it
   * impossible to know what a click would change without looking back at 2D. */
  private xrProfileValueLabels: { part: 'machine' | 'process' | 'filament'; value: UIText }[] = [];
  private aiMcpCard: UICard | null = null;
  // Design's top HUD strip (wordmark + mode switch) and bottom action bar.
  private topStripCard: UICard | null = null;
  private bottomBarCard: UICard | null = null;
  private xrMode: 'prepare' | 'paint' | 'preview' = 'prepare';
  private xrModeButtons: { mode: 'prepare' | 'paint' | 'preview'; btn: UIPanel; label: UIText }[] = [];

  private addControlPanel() {
    // Card zones mirror the imported "OrcaXR Slicer" XR design, deliberately
    // kept SPARSE so the Galaxy XR compositor isn't flooded with panels:
    //   top-centre    → wordmark + dropdown menu bar + mode switch + Exit
    //   left          → clean tool rail (one icon+label per row)
    //   right         → ONE contextual panel (profile / settings)
    //   bottom-centre → primary action bar + live status line
    // The full Snapmaker-Orca menu surface is reached through the top-bar
    // dropdown (addActionPanel → menu panel), shown one section at a time —
    // never as an always-open, floor-length list. recenterInFrontOfUser()
    // anchors each card in its zone.
    // A malformed optional card must never make immersive editing unusable.
    // Keep cards independent and identify the failing surface in the console;
    // this is especially important because uikit validates some props lazily.
    const build = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.error(`[orcaxr] XR ${name} panel failed to build`, e);
      }
    };
    build('top strip', () => this.addTopStrip());
    build('tool rail', () => this.addLeftToolbar());
    build('menu', () => this.addActionPanel()); // hidden dropdown, populated per section
    build('profile', () => this.addProfilePanel());
    build('bottom bar', () => this.addBottomBar());
    build('slice progress', () => this.addSliceModal());
    this.refreshToolButtons();
  }

  /** Top-centre HUD strip: wordmark + dropdown menu bar + Prepare/Paint/Preview
   *  mode switch + Exit. Mirrors the imported design's "MENU STRIP" zone: the
   *  menus open a single dropdown panel (addActionPanel) one section at a time,
   *  instead of the old always-open, floor-length action list. */
  private addTopStrip() {
    const card = this.uiCore.createCard({
      name: 'TopStrip',
      sizeX: 1.0,
      sizeY: 0.085,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0, PLATE_Y + 0.65, PLATE_Z - 0.1),
      width: 1000,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 12,
          manipulationCornerRadius: 16,
        }),
      ],
    });
    card.visible = false;
    this.topStripCard = card;

    const root = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      fillColor: '#0d141cE6',
      cornerRadius: 14,
      padding: 12,
      gap: 12,
      strokeWidth: 1,
      strokeColor: '#FF6D0066',
    });
    card.add(root);

    const brand = new UIPanel({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10 });
    brand.add(new UIText('OrcaXR', { fontSize: 20, fontWeight: 'bold', color: '#FFB74D' }));
    brand.add(new UIText('Slicer', { fontSize: 20, fontWeight: 'bold', color: '#FFB74DCC' }));
    root.add(brand);

    // Dropdown menu bar — one trigger per Snapmaker-Orca menu section. Clicking a
    // trigger opens (or closes) the shared dropdown panel with just that
    // section's items. This is the full menu surface, progressively disclosed.
    const menuBar = new UIPanel({ flexDirection: 'row', alignItems: 'center', gap: 2 });
    this.menuBarButtons = [];
    const reg = this.actionRegistry;
    for (const sec of MENU_SECTIONS) {
      const hasMenuItems = reg.forSurface('xr-menu').some((x) => x.menuSection === sec.id);
      const hasToolOverflow =
        sec.id === 'tools' && reg.forSurface('xr-toolbar').some((action) => !xrToolRailActions([action]).length);
      if (!hasMenuItems && !hasToolOverflow) continue;
      const btn = new UIPanel({
        paddingLeft: 11,
        paddingRight: 11,
        paddingTop: 8,
        paddingBottom: 8,
        cornerRadius: 8,
        fillColor: '#00000000',
        justifyContent: 'center',
        alignItems: 'center',
        onClick: () => {
          this.toggleMenu(sec.id);
          return true;
        },
      });
      const label = new UIText(sec.label, { fontSize: 15, fontWeight: 'bold', color: '#ffffff' });
      btn.add(label);
      menuBar.add(btn);
      this.menuBarButtons.push({ id: sec.id, btn, label });
    }
    root.add(menuBar);

    root.add(new UIPanel({ flexGrow: 1 })); // spacer pushes mode switch + exit right

    const track = new UIPanel({
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      fillColor: '#0000004d',
      cornerRadius: 10,
      padding: 4,
    });
    const modes: { mode: 'prepare' | 'paint' | 'preview'; label: string }[] = [
      { mode: 'prepare', label: 'Prepare' },
      { mode: 'paint', label: 'Paint' },
      { mode: 'preview', label: 'Preview' },
    ];
    this.xrModeButtons = [];
    for (const m of modes) {
      const btn = new UIPanel({
        paddingLeft: 14,
        paddingRight: 14,
        paddingTop: 8,
        paddingBottom: 8,
        cornerRadius: 8,
        fillColor: '#00000000',
        justifyContent: 'center',
        alignItems: 'center',
        onClick: () => {
          this.setXrMode(m.mode);
          return true;
        },
      });
      const label = new UIText(m.label, { fontSize: 16, fontWeight: 'bold', color: '#ffffff' });
      btn.add(label);
      track.add(btn);
      this.xrModeButtons.push({ mode: m.mode, btn, label });
    }
    root.add(track);

    // Keep secondary panels progressive: the plate stays readable until the
    // maker explicitly opens profile controls. Recenter is deliberately always
    // one pinch away because room-scale users regularly change where they are
    // standing relative to the workspace.
    const utility = (icon: string, hint: string, onClick: () => void) => {
      const btn = new UIPanel({
        width: 38,
        height: 38,
        cornerRadius: 9,
        fillColor: '#ffffff14',
        strokeWidth: 1,
        strokeColor: '#ffffff1a',
        justifyContent: 'center',
        alignItems: 'center',
        onClick: () => {
          onClick();
          return true;
        },
        onHoverEnter: () => {
          btn.setFillColor('#ffffff26');
        },
        onHoverExit: () => {
          btn.setFillColor('#ffffff14');
        },
      });
      (btn as any).userData = { hint };
      btn.add(new XRImage(xrIcon(icon), { color: '#dfe4ea', width: 20, height: 20 }));
      root.add(btn);
    };
    utility('tune', 'Profile settings', () => this.toggleProfilePanel());
    utility('view_default', 'Recenter workspace', () => {
      this.needsRecenter = true;
      this.setStatus('Recentering workspace…');
    });

    const exitBtn = new UIPanel({
      paddingLeft: 13,
      paddingRight: 13,
      paddingTop: 8,
      paddingBottom: 8,
      cornerRadius: 8,
      fillColor: '#e5393526',
      strokeWidth: 1,
      strokeColor: '#e5393559',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      justifyContent: 'center',
      onClick: () => {
        void xb.core.renderer.xr.getSession()?.end();
        return true;
      },
      onHoverEnter: () => {
        exitBtn.setFillColor('#e5393559');
      },
      onHoverExit: () => {
        exitBtn.setFillColor('#e5393526');
      },
    });
    exitBtn.add(new XRImage(xrIcon('logout'), { color: '#ff8a80', width: 18, height: 18, flexShrink: 0 }));
    exitBtn.add(new UIText('Exit', { fontSize: 15, fontWeight: 'bold', color: '#ff8a80', flexShrink: 0 }));
    root.add(exitBtn);

    this.refreshXrMode();
    this.refreshMenuBar();
  }

  /** Open the dropdown for `id` (or close it if already open). Only one section
   *  is ever visible — the panel is short and anchored just under the menu bar. */
  private toggleMenu(id: string) {
    if (this.openMenuSection === id) {
      this.closeMenu();
      return;
    }
    this.openMenuSection = id;
    this.populateMenuPanel(id);
    const c = this.rightSidebarCard;
    if (c && this.topStripCard) {
      // Anchor the dropdown just below the top strip, matching its facing, but pop it out slightly in Z.
      c.position.copy(this.topStripCard.position);
      c.position.y -= 0.4;
      c.position.z += 0.05;
      c.quaternion.copy(this.topStripCard.quaternion);
      c.updateMatrixWorld(true);
      c.show();
    }
    this.refreshMenuBar();
  }

  private closeMenu() {
    this.openMenuSection = null;
    if (this.rightSidebarCard) this.rightSidebarCard.hide();
    this.refreshMenuBar();
  }

  private refreshMenuBar() {
    for (const m of this.menuBarButtons) {
      const active = m.id === this.openMenuSection;
      m.btn.setFillColor(active ? '#ff6d0033' : '#00000000');
      m.label.setColor(active ? '#FFB74D' : '#ffffff');
    }
  }

  /** Fill the shared dropdown panel with a single menu section's rows. */
  private populateMenuPanel(id: string) {
    const root = this.menuPanelRoot;
    if (!root) return;
    for (const c of [...root.children]) {
      try {
        root.remove(c);
      } catch {
        /* detached */
      }
    }
    const sec = MENU_SECTIONS.find((s) => s.id === id);
    if (this.menuPanelTitle) this.menuPanelTitle.setText(sec ? sec.label : 'Menu');
    const reg = this.actionRegistry;
    const entries: { action: Action; surface: ActionSurface }[] = reg
      .forSurface('xr-menu')
      .filter((action) => action.menuSection === id)
      .map((action) => ({ action, surface: 'xr-menu' as const }));
    if (id === 'tools') {
      for (const action of reg.forSurface('xr-toolbar')) {
        if (xrToolRailActions([action]).length === 0) {
          entries.push({ action, surface: 'xr-toolbar' });
        }
      }
    }
    for (const { action: a, surface } of entries) {
      const availability = this.actionContext
        ? reg.availability(a, surface, this.actionContext.ui.get())
        : { state: 'disabled' as const, reason: 'Workspace is still initializing.' };
      const enabled = availability.state === 'enabled';
      const unavailable = a.capability.status === 'unavailable' || a.capability.status === 'blocked';
      const restFill = enabled ? '#ffffff12' : '#ffffff08';
      const btn = new UIPanel({
        width: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 11,
        paddingBottom: 11,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        cornerRadius: 9,
        fillColor: restFill,
        opacity: enabled ? 1 : 0.5,
        strokeWidth: 1,
        strokeColor: '#ffffff12',
        onClick: () => {
          if (enabled) this.closeMenu();
          if (this.actionContext) {
            void reg.invoke(a, surface, this.actionContext, this.actionContext.ui.get());
          }
          return true;
        },
        onHoverEnter: () => {
          if (enabled) btn.setFillColor('#ffffff24');
        },
        onHoverExit: () => {
          btn.setFillColor(restFill);
        },
      });
      btn.userData.hint = availability.state === 'disabled' ? availability.reason : a.hint;
      btn.add(
        new XRImage(xrIcon(a.icon), { color: enabled ? '#dfe4ea' : '#8a94a0', width: 20, height: 20, flexShrink: 0 }),
      );
      btn.add(
        new UIText(a.label, { fontSize: 17, color: enabled ? '#eef2f6' : '#8a94a0', flexGrow: 1, flexShrink: 1 }),
      );
      if (unavailable)
        btn.add(new UIText('UNAVAILABLE', { fontSize: 10, fontWeight: 'bold', color: '#ffb74d', flexShrink: 0 }));
      root.add(btn);
    }
  }

  private setXrMode(mode: 'prepare' | 'paint' | 'preview') {
    this.xrMode = mode;
    if (this.actionContext) {
      if (mode === 'paint') {
        // Paint is a modal tool, not a separate renderer mode. The previous
        // implementation only coloured this tab, leaving the workspace in its
        // prior tool and making the control feel broken.
        this.actionContext.setMode('prepare');
        this.actionContext.setTool('paint');
        this.setStatus('Paint mode — choose a color, then pinch the model');
      } else if (mode === 'preview') {
        this.actionContext.setMode('preview');
        if (!this.previewOn) this.actionContext.togglePreview();
      } else {
        if (this.previewOn) this.actionContext.togglePreview();
        this.actionContext.setMode('prepare');
      }
    }
    this.refreshXrMode();
  }
  private refreshXrMode() {
    for (const m of this.xrModeButtons) {
      const active = m.mode === this.xrMode;
      m.btn.setFillColor(active ? '#FF6D00' : '#00000000');
      m.label.setColor(active ? '#000000' : '#ffffff');
    }
  }

  /** Bottom-centre action bar: the primary Load / Slice / Preview / Download
   *  actions, pulled prominent like the design's "BOTTOM ACTION BAR". */
  private addBottomBar() {
    const card = this.uiCore.createCard({
      name: 'BottomBar',
      sizeX: 0.66,
      sizeY: 0.17,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0, PLATE_Y - 0.25, PLATE_Z + 0.15),
      width: 640,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 12,
          manipulationCornerRadius: 16,
        }),
      ],
    });
    card.visible = false;
    this.bottomBarCard = card;

    const root = new UIPanel({
      width: '100%',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 8,
      fillColor: '#0d141cE6',
      cornerRadius: 18,
      padding: 12,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
    });
    card.add(root);

    const btnRow = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    });
    root.add(btnRow);

    const reg = this.actionRegistry;
    const runReg = (a: Action) => {
      if (this.actionContext) {
        void reg.invoke(a, 'xr-primary', this.actionContext, this.actionContext.ui.get());
      }
    };
    const primaryHandles: { action: Action; btn: UIPanel; icon: XRImage; primary: boolean; restFill: string }[] = [];
    for (const a of reg.forSurface('xr-primary')) {
      const primary = a.id === 'slice_active_plate';
      const restFill = '#ffffff14';
      const btn = new UIPanel({
        paddingLeft: 18,
        paddingRight: 18,
        paddingTop: 12,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        cornerRadius: 10,
        fillColor: primary ? '#ffb74d' : restFill,
        strokeWidth: primary ? 0 : 1,
        strokeColor: primary ? '#ffb74d' : '#ffffff1a',
        onClick: () => {
          runReg(a);
          return true;
        },
        onHoverEnter: () => {
          if (
            this.actionContext &&
            reg.availability(a, 'xr-primary', this.actionContext.ui.get()).state === 'enabled'
          ) {
            btn.setFillColor(primary ? '#ff6d00' : '#ffffff26');
          }
        },
        onHoverExit: () => {
          /* active-aware color restored by refresh below */
        },
      });
      const icon = new XRImage(xrIcon(a.icon), {
        color: primary ? '#000000' : '#ffffff',
        width: 22,
        height: 22,
        flexShrink: 0,
      });
      btn.add(icon);
      btn.add(
        new UIText(a.label, {
          fontSize: 18,
          fontWeight: 'bold',
          color: primary ? '#000000' : '#ffffff',
          flexShrink: 0,
        }),
      );
      primaryHandles.push({ action: a, btn, icon, primary, restFill });
      // Load must end the immersive session before the file picker (browsers
      // suppress dialogs in XR); the per-frame ray probe watches this node.
      if (a.id === 'load_model_from_path') this.loadButtonNode = btn as unknown as THREE.Object3D;
      btnRow.add(btn);
    }
    // The immersive bar shares the DOM shell's readiness rules. A bright Slice
    // button on an empty plate is a false affordance, particularly in-headset
    // where the status line is farther from the user's focal point.
    const refreshPrimary = () => {
      if (!this.actionContext) return;
      const state = this.actionContext.ui.get();
      for (const h of primaryHandles) {
        const enabled = reg.availability(h.action, 'xr-primary', state).state === 'enabled';
        h.btn.setProperties({ opacity: enabled ? 1 : 0.38 });
        h.btn.setFillColor(enabled ? (h.primary ? '#ffb74d' : h.restFill) : '#ffffff08');
        h.icon.setColor(enabled ? (h.primary ? '#000000' : '#ffffff') : '#8a94a0');
      }
    };
    this.registerActionStateRefresher(refreshPrimary);

    // Live status line + slice progress (relocated here from the old action
    // panel so it's always visible, matching the design's bottom status text).
    const statusRow = new UIPanel({ width: '100%', flexDirection: 'column', gap: 6, paddingLeft: 6, paddingRight: 6 });
    this.statusText = new UIText('Ready. Load a model to begin.', { fontSize: 14, color: '#a0aab5' });
    statusRow.add(this.statusText);
    this.progressBar = new UIPanel({ width: '0%', height: 4, fillColor: '#ffb74d', cornerRadius: 2 });
    this.progressContainer = new UIPanel({ width: '100%', height: 4, fillColor: '#ffffff1a', cornerRadius: 2 });
    this.progressContainer.add(this.progressBar);
    this.progressContainer.visible = false;
    statusRow.add(this.progressContainer);
    root.add(statusRow);
  }

  private addSliceModal() {
    const card = this.uiCore.createCard({
      name: 'SliceModal',
      sizeX: 0.6,
      sizeY: 0.25,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0, PLATE_Y + 0.35, PLATE_Z + 0.3),
      width: 500,
      alignItems: 'center',
      justifyContent: 'center',
      behaviors: [new ManipulationBehavior({ draggable: true, faceCamera: true })],
    });
    // `createCard` already registers the card with UICore. There is no
    // separate uiGroup in the web workspace; attempting to add it again used
    // to throw here and left the XR slice feedback surface half-constructed.
    const root = new UIPanel({
      width: '100%',
      height: '100%',
      padding: 24,
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      fillColor: '#1e1e1eed', // dark glassmorphism
      cornerRadius: 16,
      strokeWidth: 1,
      strokeColor: '#ffffff1a',
      gap: 16,
    });
    card.add(root);

    root.add(new UIText('Slicing in Progress', { fontSize: 24, fontWeight: 'bold', color: '#ffffff' }));

    this.sliceModalText = new UIText('Initializing...', { fontSize: 16, color: '#a0aab5', textAlign: 'center' });
    root.add(this.sliceModalText);

    this.sliceModalProgressContainer = new UIPanel({
      width: '100%',
      height: 8,
      fillColor: '#ffffff1a',
      cornerRadius: 4,
      marginTop: 12,
    });
    this.sliceModalBar = new UIPanel({ width: '0%', height: 8, fillColor: '#ffb74d', cornerRadius: 4 });
    this.sliceModalProgressContainer.add(this.sliceModalBar);
    this.sliceModalProgressContainer.visible = false;
    root.add(this.sliceModalProgressContainer);

    this.sliceModalCard = card;
    card.hide();
  }

  private addLeftToolbar() {
    const card = this.uiCore.createCard({
      name: 'LeftToolbar',
      sizeX: 0.17,
      sizeY: 0.78,
      pixelSize: 0.0012,
      position: new THREE.Vector3(-0.85, PLATE_Y + 0.15, PLATE_Z + 0.1),
      width: 158,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 10,
          manipulationCornerRadius: 12,
        }),
      ],
    });
    card.visible = false;
    this.leftToolbarCard = card;

    const root = new UIPanel({
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      fillColor: '#0d141cE6',
      cornerRadius: 18,
      padding: 10,
      gap: 6,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
      // This rail is intentionally finite: the full action catalogue lives in
      // the top menu panel. A scrolling column of large spatial buttons is
      // unusable in-headset and wastes layout work every frame.
      overflow: 'hidden',
    });
    card.add(root);

    const divider = () => new UIPanel({ width: '100%', height: 1, fillColor: '#ffffff1a' });
    const heading = (t: string) => new UIText(t, { fontSize: 11, fontWeight: 'bold', color: '#8a94a0' });

    // Tool rail rendered from the shared ActionRegistry — the same catalogue the
    // DOM shell renders — so the two shells can't drift. Clicks run through the
    // injected ActionContext (read at click time; set by main.ts after build).
    const factory: XrUiFactory<UIPanel, XRImage> = {
      createPanel: (properties) => new UIPanel(properties as UIPanelProperties),
      createIcon: (icon, properties) => new XRImage(icon, properties as XRImageProperties),
    };
    const runAction = (a: Action) => {
      if (this.actionContext) {
        void this.actionRegistry.invoke(a, 'xr-toolbar', this.actionContext, this.actionContext.ui.get());
      }
    };
    const toolbar = xrToolRailActions(this.actionRegistry.forSurface('xr-toolbar'));

    // Modal tool gizmos (move/rotate/scale/lay-flat/paint) — the `.tool` actions.
    root.add(heading('TOOLS'));
    for (const a of toolbar) {
      if (!a.tool) continue;
      const h = renderXrActionButton(a, runAction, factory, {
        size: 64,
        iconSize: 34,
        enabled: this.actionContext
          ? this.actionRegistry.availability(a, 'xr-toolbar', this.actionContext.ui.get()).state === 'enabled'
          : false,
        onHoverExit: () => this.refreshToolButtons(),
      });
      root.add(h.btn);
      this.toolButtons.push({
        action: a,
        btn: h.btn,
        iconEl: h.iconEl,
      });
    }

    // Keep only the two high-frequency object actions beside the modal tools.
    // The rest of the toolbar catalogue remains reachable via the top menu,
    // avoiding a floor-length, overflowing rail in XR.
    root.add(divider());
    for (const a of toolbar) {
      if (a.tool || !['drop_to_bed', 'delete_models'].includes(a.id)) continue;
      const h = renderXrActionButton(a, runAction, factory, {
        size: 64,
        iconSize: 34,
        danger: a.id === 'delete_models',
        enabled: this.actionContext
          ? this.actionRegistry.availability(a, 'xr-toolbar', this.actionContext.ui.get()).state === 'enabled'
          : false,
      });
      root.add(h.btn);
      this.toolButtons.push({ action: a, btn: h.btn, iconEl: h.iconEl });
    }

    // Paint colours — the filament slots doubling as the paint palette. Fixed
    // swatch sizes wrap cleanly at this rail width. It is only visible when
    // Paint is active, preserving a compact neutral rail.
    root.add(divider());
    root.add(heading('COLORS'));
    this.paintOptionsPanel = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    });
    this.paintOptionsPanel.visible = false;
    root.add(this.paintOptionsPanel);
    this.rebuildPaintSwatches();
    this.palette.onChanged = () => {
      this.rebuildPaintSwatches();
      if (this.onPaletteChanged) this.onPaletteChanged();
    };
    this.registerActionStateRefresher(() => this.refreshToolButtons());
  }

  /** The dropdown panel the top-bar menu triggers populate one section at a
   *  time. Built hidden; `toggleMenu` anchors it under the strip and shows it.
   *  This replaces the old always-open, full-height action list. */
  private addActionPanel() {
    const card = this.uiCore.createCard({
      name: 'MenuPanel',
      sizeX: 0.44,
      sizeY: 0.8,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0, PLATE_Y + 0.25, PLATE_Z + 0.1),
      width: 400,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 16,
          manipulationCornerRadius: 16,
        }),
      ],
    });
    card.visible = false;
    this.rightSidebarCard = card; // reused as the toggled dropdown panel

    const root = new UIPanel({
      width: '100%',
      flexDirection: 'column',
      fillColor: '#0d141cF2',
      cornerRadius: 18,
      padding: 16,
      gap: 6,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
      overflow: 'scroll',
      height: '100%',
    });
    card.add(root);

    const header = new UIPanel({
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 4,
    });
    this.menuPanelTitle = new UIText('Menu', { fontSize: 22, fontWeight: 'bold', color: '#ffffff' });
    header.add(this.menuPanelTitle);
    const closeBtn = new UIPanel({
      width: 34,
      height: 34,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 8,
      fillColor: '#ffffff14',
      onClick: () => {
        this.closeMenu();
        return true;
      },
      onHoverEnter: () => {
        closeBtn.setFillColor('#ffffff26');
      },
      onHoverExit: () => {
        closeBtn.setFillColor('#ffffff14');
      },
    });
    closeBtn.add(new XRImage(xrIcon('close'), { color: '#ffffff', width: 18, height: 18 }));
    header.add(closeBtn);
    root.add(header);

    // Rows are (re)built per section by populateMenuPanel().
    this.menuPanelRoot = new UIPanel({ width: '100%', flexDirection: 'column', gap: 6 });
    root.add(this.menuPanelRoot);
  }

  private addProfilePanel() {
    const card = this.uiCore.createCard({
      name: 'ProfilePanel',
      sizeX: 0.4,
      sizeY: 0.7,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0.95, PLATE_Y + 0.15, PLATE_Z + 0.1),
      width: 330,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 16,
          manipulationCornerRadius: 16,
        }),
      ],
    });
    card.visible = false;
    this.profileCard = card;

    const root = new UIPanel({
      width: '100%',
      flexDirection: 'column',
      fillColor: '#0d141cE6',
      cornerRadius: 18,
      padding: 24,
      gap: 20,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
      overflow: 'scroll',
      height: '100%',
    });
    card.add(root);

    const header = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center' });
    header.add(new UIText('Profiles', { fontSize: 32, fontWeight: 'bold', color: '#ffffff' }));
    root.add(header);

    const intro = new UIText('Pinch a row to cycle its active profile.', { fontSize: 14, color: '#a0aab5' });
    root.add(intro);
    const profPanel = new UIPanel({ width: '100%', flexDirection: 'column', gap: 8 });
    const mkProf = (part: 'machine' | 'process' | 'filament', icon: string, title: string) => {
      const btn = new UIPanel({
        width: '100%',
        minHeight: 58,
        paddingLeft: 12,
        paddingRight: 12,
        justifyContent: 'flex-start',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        cornerRadius: 8,
        fillColor: '#ffffff14',
        strokeWidth: 1,
        strokeColor: '#ffffff1a',
        onClick: () => {
          this.cycleProfilePart(part);
          return true;
        },
        onHoverEnter: () => {
          btn.setFillColor('#ffffff26');
        },
        onHoverExit: () => {
          btn.setFillColor('#ffffff14');
        },
      });
      btn.add(new XRImage(xrIcon(icon), { color: '#cccccc', width: 24, height: 24 }));
      const copy = new UIPanel({ flexDirection: 'column', flexGrow: 1, gap: 2 });
      copy.add(new UIText(title.toUpperCase(), { fontSize: 11, fontWeight: 'bold', color: '#8a94a0' }));
      const value = new UIText('Loading...', { fontSize: 16, fontWeight: 'bold', color: '#ffffff', flexShrink: 1 });
      copy.add(value);
      btn.add(copy);
      btn.add(new XRImage(xrIcon('chevron_right'), { color: '#ffb74d', width: 22, height: 22, flexShrink: 0 }));
      this.xrProfileValueLabels.push({ part, value });
      profPanel.add(btn);
    };
    mkProf('machine', 'printer', 'Printer');
    mkProf('process', 'tune', 'Process');
    mkProf('filament', 'filament', 'Filament');
    root.add(profPanel);

    this.headsContainer = new UIPanel({ width: '100%', flexDirection: 'column', gap: 10 });
    root.add(this.headsContainer);
    this.refreshXrProfileValues();
  }

  private toggleProfilePanel() {
    if (!this.profileCard) return;
    const visible = !!this.profileCard.visible;
    if (visible) this.profileCard.hide();
    else this.profileCard.show();
    this.closeMenu();
  }

  private refreshXrProfileValues() {
    const p = this.profile;
    for (const item of this.xrProfileValueLabels) {
      const value = !p
        ? 'Loading...'
        : item.part === 'machine'
          ? p.machineName
          : item.part === 'process'
            ? p.processName
            : p.filamentName;
      item.value.setText(value);
    }
  }

  public setTool(tool: WorkspaceGizmoTool) {
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

  private snapToBed(entry: { viewer: THREE.Object3D; display?: THREE.Object3D }) {
    entry.viewer.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(entry.display || entry.viewer);
    const lowestWorldY = box.min.y;
    const bedWorldY = this.workspace.getWorldPosition(new THREE.Vector3()).y;
    entry.viewer.position.y += bedWorldY - lowestWorldY;
  }

  private layOnFace(
    entry: { viewer: THREE.Object3D; display: THREE.Mesh },
    faceNormal: THREE.Vector3,
    hitObject: THREE.Object3D,
  ) {
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

  public autoOrientSelectedModel() {
    if (!this.selectedModel) return;
    const entry = this.selectedModel;
    const posAttr = entry.raw.attributes.position;
    if (!posAttr) return;

    this.setStatus('Auto-orienting...');

    // Defer computation slightly to let UI update
    setTimeout(() => {
      const scale = entry.viewer.scale;
      const pts: THREE.Vector3[] = [];
      const step = Math.max(1, Math.floor(posAttr.count / 100000));
      for (let i = 0; i < posAttr.count; i += step) {
        pts.push(new THREE.Vector3(posAttr.getX(i) * scale.x, posAttr.getY(i) * scale.y, posAttr.getZ(i) * scale.z));
      }

      const hull = new ConvexHull().setFromPoints(pts);
      const normalAreas: { normal: THREE.Vector3; area: number }[] = [];

      for (let i = 0; i < hull.faces.length; i++) {
        const f = hull.faces[i];
        const e1 = new THREE.Vector3().subVectors(f.edge.next.vertex.point, f.edge.vertex.point);
        const e2 = new THREE.Vector3().subVectors(f.edge.prev.vertex.point, f.edge.vertex.point);
        const area = new THREE.Vector3().crossVectors(e1, e2).length() * 0.5;

        let found = false;
        for (const na of normalAreas) {
          if (na.normal.dot(f.normal) > 0.999) {
            na.area += area;
            found = true;
            break;
          }
        }
        if (!found) normalAreas.push({ normal: f.normal.clone(), area });
      }

      if (normalAreas.length > 0) {
        normalAreas.sort((a, b) => b.area - a.area);
        const bestNormal = normalAreas[0].normal;

        const quat = new THREE.Quaternion().setFromUnitVectors(bestNormal, new THREE.Vector3(0, -1, 0));
        entry.viewer.quaternion.copy(quat);

        this.snapToBed(entry);
        if (this.onSelectionTransformChanged) this.onSelectionTransformChanged();
        this.setStatus('Auto-oriented model');
      }
    }, 10);
  }

  private checkLoadButtonAndTrigger() {
    if (!this.loadButtonNode || !this.onRequestLoadStl) return;
    const input = xb.core.input as unknown as {
      intersectionsForController: Map<unknown, THREE.Intersection[]>;
    };
    for (const ints of input.intersectionsForController.values()) {
      const hitLoad = ints.some((i) => {
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
    const state = this.actionContext?.ui.get();
    for (const { action, btn, iconEl } of this.toolButtons) {
      const enabled = state ? this.actionRegistry.availability(action, 'xr-toolbar', state).state === 'enabled' : false;
      const active = enabled && Boolean(action.tool) && this.tool === action.tool;
      btn.setProperties({ opacity: enabled ? 1 : 0.38 });
      btn.setFillColor(enabled ? (active ? '#ffffff4d' : '#ffffff14') : '#ffffff08');
      iconEl.setColor(enabled ? (active ? '#ffffff' : '#cccccc') : '#8a94a0');
    }
    if (this.paintOptionsPanel) {
      this.paintOptionsPanel.visible = this.tool === 'paint';
      this.refreshPaintSwatches();
    }
  }

  private refreshPaintSwatches() {
    const activeHex = this.activePaintColor.getHex();
    for (const { c, btn } of this.paintSwatches) {
      btn.setStrokeColor(c === activeHex ? '#ffffff' : '#444444');
    }
  }

  private showValues(text: string) {
    if (this.valueText && this.rightSidebarCard && !this.rightSidebarCard.visible) {
      this.valueText.setText(text);
    }
  }

  private lastStatusText = '';
  /** Update just the progress bar, keeping the current status text. */
  private setProgress(percent?: number) {
    this.setStatus(this.lastStatusText, percent);
  }

  // Public so `ActionContext` (the shared shell routing surface) can post
  // status lines — e.g. coming-soon parity placeholders and feature stubs.
  public setStatus(text: string, percent?: number) {
    this.lastStatusText = text;
    // Troika's XR font atlas does not include a few typographic symbols used
    // by profile display names (notably · and ×). Keep DOM status text intact
    // but feed the immersive card a supported, equally legible equivalent.
    const xrText = text.replaceAll('·', '-').replaceAll('×', 'x').replaceAll('…', '...');
    if (this.statusText) {
      this.statusText.setText(xrText);
    }
    if (this.progressContainer && this.progressBar) {
      if (percent !== undefined && percent >= 0 && percent <= 100) {
        this.progressContainer.visible = true;
        this.progressBar.setProperties({ width: `${percent}%` });
      } else {
        this.progressContainer.visible = false;
      }
    }
    if (this.sliceModalText) {
      this.sliceModalText.setText(xrText);
    }
    if (this.sliceModalProgressContainer && this.sliceModalBar) {
      if (percent !== undefined && percent >= 0 && percent <= 100) {
        this.sliceModalProgressContainer.visible = true;
        this.sliceModalBar.setProperties({ width: `${percent}%` });
      } else {
        this.sliceModalProgressContainer.visible = false;
      }
    }
    if (this.onStatusChanged) {
      this.onStatusChanged(text, percent);
    }
    console.log('[orcaxr-web]', text);
  }

  public rebuildHeadsPanel() {
    if (!this.headsContainer) return;
    const panel = this.headsContainer;
    // Remove over a COPY: removing while forEach-ing the live array skips
    // every other child, and force-assigning children = [] leaves orphans
    // whose .parent still points here → uikit "parent mismatch" on update.
    for (const c of [...panel.children]) {
      try {
        panel.remove(c);
      } catch {
        /* already detached */
      }
    }

    const exCount = this.extruderCount;
    const totalCount = this.palette.count();

    const syncBtn = new UIPanel({
      width: '100%',
      height: 35,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 4,
      fillColor: '#2E7D32',
      strokeWidth: 0,
      onClick: () => {
        this.setStatus('Synced filaments from printer!');
        return true;
      },
    });
    syncBtn.add(new UIText('Sync with Printer', { fontSize: 14, color: '#ffffff' }));
    panel.add(syncBtn);

    for (let i = 0; i < totalCount; i++) {
      const isVirtual = i >= exCount;
      const row = new UIPanel({
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 5,
      });

      const colorBtn = new UIPanel({
        width: 24,
        height: 24,
        cornerRadius: 4,
        fillColor: this.palette.colorAt(i),
        onClick: () => {
          const colors = ['#5F605F', '#E22B22', '#FEC134', '#FEFEFE', '#2196F3', '#9C27B0'];
          const idx = colors.indexOf(this.palette.colorAt(i).toUpperCase());
          this.palette.setColor(i, colors[(idx + 1) % colors.length] || colors[0]);
          this.rebuildHeadsPanel();
          return true;
        },
      });
      row.add(colorBtn);

      row.add(new UIText(isVirtual ? `V-${i + 1}:` : `Head ${i + 1}:`, { fontSize: 14, color: '#ffffff' }));

      const cycleFilament = () => {
        const choices = this.filamentChoices(this.profile!.machineName);
        const idx = choices.indexOf(this.headFilaments[i]);
        this.headFilaments[i] = choices[(idx + 1) % choices.length] ?? this.headFilaments[i];
        this.rebuildHeadsPanel();
        return true;
      };
      const filBtn = new UIPanel({
        flexGrow: 1,
        height: 35,
        padding: 5,
        justifyContent: 'center',
        alignItems: 'center',
        cornerRadius: 4,
        fillColor: '#ffffff14',
        strokeWidth: 1,
        strokeColor: '#ffffff1a',
        onClick: cycleFilament,
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
          width: 50,
          height: 35,
          justifyContent: 'center',
          alignItems: 'center',
          cornerRadius: 4,
          fillColor: '#ffffff14',
          strokeWidth: 1,
          strokeColor: '#ffffff1a',
          onClick: cycleNozzle,
        });
        nozBtn.add(new UIText(this.headNozzles[i] + 'mm', { fontSize: 12, color: '#ffffff' }));
        row.add(nozBtn);
      } else {
        const delBtn = new UIPanel({
          width: 50,
          height: 35,
          justifyContent: 'center',
          alignItems: 'center',
          cornerRadius: 4,
          fillColor: '#d32f2f',
          onClick: () => {
            this.palette.remove(i);
            this.headFilaments.splice(i, 1);
            this.headNozzles.splice(i, 1);
            this.rebuildHeadsPanel();
            if (this.onProfileChanged) this.onProfileChanged();
            return true;
          },
        });
        delBtn.add(new UIText('Del', { fontSize: 12, color: '#ffffff' }));
        row.add(delBtn);
      }

      panel.add(row);
    }

    // Virtual (mixed) filaments from the loaded FullSpectrum project —
    // read-only, desktop-parity display colors (task: UI/MCP parity).
    if (this.virtualFilaments.length > 0) {
      const header = new UIPanel({ width: '100%', height: 22, justifyContent: 'center', alignItems: 'center' });
      header.add(new UIText(`Mixed filaments (${this.virtualFilaments.length})`, { fontSize: 12, color: '#a0aab5' }));
      panel.add(header);
      for (const vf of this.virtualFilaments) {
        const row = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 5 });
        row.add(new UIPanel({ width: 18, height: 18, cornerRadius: 3, fillColor: vf.color }));
        row.add(new UIText(`F${vf.id} - ${vf.label}`, { fontSize: 11, color: '#ffffff' }));
        panel.add(row);
      }
    }

    const addBtn = new UIPanel({
      width: '100%',
      height: 35,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 4,
      fillColor: '#ffffff14',
      strokeWidth: 1,
      strokeColor: '#ffffff1a',
      onClick: () => {
        this.palette.add();
        this.headFilaments.push(this.profile!.filamentName);
        this.headNozzles.push('0.4');
        this.rebuildHeadsPanel();
        if (this.onProfileChanged) this.onProfileChanged();
        return true;
      },
    });
    addBtn.add(new UIText('+ Add Virtual Filament', { fontSize: 14, color: '#ffffff' }));
    panel.add(addBtn);
  }

  public deleteSelectedModel() {
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
      this.recomputePreflight();
    }
  }

  /** Delete every model on the ACTIVE plate (Orca's Edit → Delete all). */
  public deleteAllModels() {
    if (this.models.length === 0) {
      this.setStatus('Nothing to delete.');
      return;
    }
    for (const m of [...this.models]) {
      this.workspace.remove(m.viewer);
      m.display.geometry.dispose();
    }
    this.models.length = 0;
    this.unselectModel();
    if (this.onSelectionChanged) this.onSelectionChanged(false);
    if (this.onPlatesChanged) this.onPlatesChanged();
    this.recomputePreflight();
    this.setStatus('All models deleted.');
  }

  /**
   * New Project — clear every model on every plate, reset to a single empty
   * plate, and drop any slice output / preview. The fresh-start action from
   * Snapmaker Orca's File menu. (docs/parity.md)
   */
  public newProject() {
    for (const plate of this.plates) {
      for (const m of plate.models) {
        this.workspace.remove(m.viewer);
        m.display.geometry.dispose();
      }
    }
    this.plates = [{ id: 1, label: 'Plate 1', models: [] }];
    this.nextPlateId = 2;
    this.activePlateId = 1;
    this.originalProject = null;
    this.originalProjectSnapshot = null;
    this.projectSnapshotPending = false;
    this.projectSourceWasExclusive = false;
    this.canonicalSliceRequiredReason = null;
    this.virtualFilaments = [];
    this.projectPrimeTower = null;
    this.palette.onChanged?.();
    this.rebuildHeadsPanel();
    this.unselectModel();
    this.lastGcode = null;
    if (this.previewOn) this.togglePreview();
    this.rebuildPlate();
    if (this.onPlatesChanged) this.onPlatesChanged();
    if (this.onSelectionChanged) this.onSelectionChanged(false);
    this.recomputePreflight();
    this.setStatus('New project — plate cleared.');
  }

  /**
   * Clone the selected model onto the same plate, offset so the copy isn't
   * hidden under the original. Mirrors Orca's Edit → Clone selected.
   */
  public cloneSelectedModel() {
    if (!this.selectedModel) {
      this.setStatus('Select a model to clone first.');
      return;
    }
    // raw.clone() carries the vertex `color` attribute, so painted colours copy.
    // The copy lands centred on the bed (coincident with the original, like
    // loading a second model) and is auto-selected — use Move to reposition it.
    this.addModelFromGeometry(this.selectedModel.raw.clone(), 0x4fc3f7);
    this.setStatus('Model cloned — use the Move tool to reposition the copy.');
  }

  /**
   * Split the selected model into its connected components, one new model per
   * body (Orca right-click → Split to Objects). Each body keeps the exact place
   * it held inside the original (same display offset + viewer transform), so a
   * boolean-union of two separated solids splits cleanly back apart.
   */
  public splitSelectedToObjects() {
    if (!this.selectedModel) {
      this.setStatus('Select a model to split first.');
      return;
    }
    const src = this.selectedModel;
    const g = src.raw.index ? src.raw.toNonIndexed() : src.raw;
    const positions = g.getAttribute('position').array as ArrayLike<number>;
    const colorAttr = g.getAttribute('color');
    const comps = splitConnectedComponents(positions, colorAttr ? (colorAttr.array as ArrayLike<number>) : null);
    if (comps.length <= 1) {
      this.setStatus('Already a single connected body — nothing to split.');
      return;
    }

    // Capture the original placement so every body lands where it was.
    const meshPos = src.display.position.clone();
    const vPos = src.viewer.position.clone();
    const vQuat = src.viewer.quaternion.clone();
    const vScale = src.viewer.scale.clone();

    // Remove the original (bypass deleteSelectedModel's auto-select).
    const idx = this.models.indexOf(src);
    if (idx !== -1) {
      this.workspace.remove(src.viewer);
      this.models.splice(idx, 1);
    }
    this.unselectModel();

    for (const comp of comps) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(comp.positions, 3));
      if (comp.colors) geo.setAttribute('color', new THREE.BufferAttribute(comp.colors, 3));
      this.addModelFromGeometry(geo, 0x4fc3f7);
      const added = this.models[this.models.length - 1];
      // addModelFromGeometry recentres each body on its own bbox; overwrite that
      // with the ORIGINAL display offset + transform so bodies keep their layout.
      added.display.position.copy(meshPos);
      added.viewer.position.copy(vPos);
      added.viewer.quaternion.copy(vQuat);
      added.viewer.scale.copy(vScale);
    }
    this.recomputePreflight();
    this.setStatus(`Split into ${comps.length} objects.`);
  }

  /**
   * Cut the selected model in two with a horizontal plane through its mid-height
   * (Orca gizmo → Cut). Both halves are capped and land in the model's original
   * place (like Split to Objects) so they read as the source until moved apart.
   * Paint colours are not carried across the cut (geometry-only op).
   */
  public cutSelectedByPlane() {
    if (!this.selectedModel) {
      this.setStatus('Select a model to cut first.');
      return;
    }
    const src = this.selectedModel;
    const g = src.raw.index ? src.raw.toNonIndexed() : src.raw;
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const cz = (bb.min.z + bb.max.z) / 2; // raw is Z-up mm → horizontal mid-cut
    const positions = g.getAttribute('position').array as ArrayLike<number>;
    const res = cutByPlane(positions, 0, 0, 1, cz);
    if (!res.didCut) {
      this.setStatus('Cut plane missed the model.');
      return;
    }

    const meshPos = src.display.position.clone();
    const vPos = src.viewer.position.clone();
    const vQuat = src.viewer.quaternion.clone();
    const vScale = src.viewer.scale.clone();

    const idx = this.models.indexOf(src);
    if (idx !== -1) {
      this.workspace.remove(src.viewer);
      this.models.splice(idx, 1);
    }
    this.unselectModel();

    for (const half of [res.positive, res.negative]) {
      if (half.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(half, 3));
      this.addModelFromGeometry(geo, 0x4fc3f7);
      const added = this.models[this.models.length - 1];
      added.display.position.copy(meshPos);
      added.viewer.position.copy(vPos);
      added.viewer.quaternion.copy(vQuat);
      added.viewer.scale.copy(vScale);
    }
    this.recomputePreflight();
    this.setStatus('Cut into 2 halves.');
  }

  // --- Edit clipboard (Orca Edit → Cut / Copy / Paste) -----------------
  /** Single-slot geometry clipboard for Cut/Copy/Paste. */
  private clipboard: THREE.BufferGeometry | null = null;
  public get hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  /** Copy the selected model's geometry into the clipboard. */
  public copySelectedModel(): boolean {
    if (!this.selectedModel) {
      this.setStatus('Select a model to copy first.');
      return false;
    }
    this.clipboard?.dispose();
    // Clone carries the vertex `color` attribute, so painted colours survive.
    this.clipboard = this.selectedModel.raw.clone();
    this.setStatus('Copied to clipboard.');
    return true;
  }

  /** Copy the selection, then delete it (Cut). */
  public cutSelectedModel(): boolean {
    if (!this.copySelectedModel()) return false;
    this.deleteSelectedModel();
    this.setStatus('Cut to clipboard.');
    return true;
  }

  /** Add a fresh copy of the clipboard geometry, centred + auto-selected. */
  public pasteClipboard() {
    if (!this.clipboard) {
      this.setStatus('Clipboard is empty.');
      return;
    }
    this.addModelFromGeometry(this.clipboard.clone(), 0x4fc3f7);
    this.setStatus('Pasted from clipboard — use Move to reposition.');
  }

  // --- View overlays (Orca View → Show Wireframe / Printable Box) ------
  private wireframeOn = false;
  private printableBox: THREE.LineSegments | null = null;

  /** Add/remove a wireframe overlay child on one model's display mesh. */
  private applyWireframe(entry: ModelEntry, on: boolean) {
    const existing = entry.display.getObjectByName('wireframeOverlay') as THREE.LineSegments | undefined;
    if (on && !existing) {
      // WireframeGeometry(raw) lives in the same coord space as display.geometry,
      // so parenting it to display inherits the exact scale/rotation/offset.
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(entry.raw),
        new THREE.LineBasicMaterial({ color: 0x101418, transparent: true, opacity: 0.28 }),
      );
      wire.name = 'wireframeOverlay';
      entry.display.add(wire);
    } else if (!on && existing) {
      entry.display.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
    }
  }

  /** Toggle wireframe overlays across every model on the active plate. */
  public toggleWireframe(): boolean {
    this.wireframeOn = !this.wireframeOn;
    for (const m of this.models) this.applyWireframe(m, this.wireframeOn);
    this.setStatus(`Wireframe ${this.wireframeOn ? 'on' : 'off'}.`);
    return this.wireframeOn;
  }

  // --- Object labels (Orca View → Show Labels) ------------------------
  private labelsOn = false;

  /** A camera-facing text billboard for one model. */
  private makeLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(20,24,28,0.82)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#e8eaed';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    const mat = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      depthTest: false,
      transparent: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.14, 0.035, 1);
    sp.raycast = () => {}; // never intercept the model grab raycast
    sp.name = 'objectLabel';
    return sp;
  }

  private applyLabel(entry: ModelEntry, idx: number, on: boolean) {
    const existing = entry.viewer.getObjectByName('objectLabel') as THREE.Sprite | undefined;
    if (on && !existing) {
      const sp = this.makeLabelSprite(`Model ${idx + 1}`);
      sp.position.set(0, 0.12, 0); // float above the model
      entry.viewer.add(sp);
    } else if (!on && existing) {
      entry.viewer.remove(existing);
      const m = existing.material as THREE.SpriteMaterial;
      m.map?.dispose();
      m.dispose();
    }
  }

  /** Toggle floating name labels on every model (Orca View → Show Labels). */
  public toggleLabels(): boolean {
    this.labelsOn = !this.labelsOn;
    this.models.forEach((m, i) => this.applyLabel(m, i, this.labelsOn));
    this.setStatus(`Object labels ${this.labelsOn ? 'on' : 'off'}.`);
    return this.labelsOn;
  }

  // --- Overhang highlight (Orca View → Show Overhang) -----------------
  private overhangOn = false;

  /**
   * A red overlay mesh of just the steeply down-facing triangles (raw is Z-up,
   * so an overhang faces −Z). Rendered as a display child so it inherits the
   * model transform — and leaves display.geometry (the slice source) untouched.
   */
  private buildOverhangOverlay(raw: THREE.BufferGeometry): THREE.Mesh | null {
    const g = raw.index ? raw.toNonIndexed() : raw;
    const pos = g.getAttribute('position');
    const n = pos.count;
    const out: number[] = [];
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    const ab = new THREE.Vector3(),
      ac = new THREE.Vector3(),
      nor = new THREE.Vector3();
    for (let t = 0; t < n; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      nor.crossVectors(ab, ac).normalize();
      if (nor.z < -0.5) out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); // ~>60° down
    }
    if (out.length === 0) return null;
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
    og.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.6, depthWrite: false });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(og, mat);
    mesh.name = 'overhangOverlay';
    mesh.raycast = () => {};
    mesh.renderOrder = 2;
    return mesh;
  }

  private applyOverhang(entry: ModelEntry, on: boolean) {
    const existing = entry.display.getObjectByName('overhangOverlay') as THREE.Mesh | undefined;
    if (on && !existing) {
      const o = this.buildOverhangOverlay(entry.raw);
      if (o) entry.display.add(o);
    } else if (!on && existing) {
      entry.display.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
    }
  }

  /** Toggle the overhang highlight across every model (Orca View → Overhang). */
  public toggleOverhang(): boolean {
    this.overhangOn = !this.overhangOn;
    for (const m of this.models) this.applyOverhang(m, this.overhangOn);
    this.setStatus(`Overhang highlight ${this.overhangOn ? 'on' : 'off'}.`);
    return this.overhangOn;
  }

  /** Toggle the printable build-volume wire box. */
  public togglePrintableBox(): boolean {
    if (this.printableBox) {
      this.workspace.remove(this.printableBox);
      this.printableBox.geometry.dispose();
      (this.printableBox.material as THREE.Material).dispose();
      this.printableBox = null;
      this.setStatus('Printable box off.');
      return false;
    }
    const vis = MM * WORKSPACE_SCALE;
    const sx = this.bedMm.x * vis;
    const sz = this.bedMm.y * vis;
    // Profiles carry bed X/Y but no Z extent; 250 mm is a representative height.
    const sy = 250 * vis;
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
      new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.5 }),
    );
    box.name = 'printableBox';
    // Workspace-local origin is the bed centre at y=0 (models sit here), so lift
    // the box by half its height to stand it on the plate.
    box.position.set(0, sy / 2, 0);
    this.workspace.add(box);
    this.printableBox = box;
    this.setStatus('Printable box on.');
    return true;
  }

  /**
   * Auto-arrange every model on the active plate into a centred grid so nothing
   * overlaps (Orca top toolbar → Arrange). Cell size is the largest model
   * footprint plus a 10 mm gap; the grid is centred on the bed. Models that
   * still fall outside the bed (too many / too large) surface in the off-bed
   * pre-flight, exactly as a manual layout would.
   */
  public arrangePlate() {
    const n = this.models.length;
    if (n === 0) {
      this.setStatus('Nothing to arrange.');
      return;
    }
    const vis = MM * WORKSPACE_SCALE;
    // Footprint of each model in world units: its mm bed extent (raw X/Y, since
    // display rotates Z-up mm onto the bed) × magnification × per-model scale.
    let cell = 0;
    for (const m of this.models) {
      m.raw.computeBoundingBox();
      const bb = m.raw.boundingBox!;
      const foot = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * vis * m.viewer.scale.x;
      cell = Math.max(cell, foot);
    }
    cell += 10 * vis; // 10 mm gap between cells
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const x0 = -((cols - 1) / 2) * cell;
    const z0 = -((rows - 1) / 2) * cell;
    this.models.forEach((m, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      m.viewer.position.set(x0 + col * cell, 0, z0 + row * cell);
    });
    this.recomputePreflight();
    this.setStatus(`Arranged ${n} model${n > 1 ? 's' : ''} in a ${cols}×${rows} grid.`);
  }

  /**
   * Export every plated model, merged in printer coordinates (mm, Z-up, dropped
   * onto the bed), as a binary STL — the same "what you see is what slices"
   * geometry the slicer bakes. Orca's File → Export as STL.
   */
  public exportPlateStl() {
    const merged = this.mergedPrinterGeometry();
    if (!merged) {
      this.setStatus('Nothing to export — add a model first.');
      return;
    }
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
    const stl = new STLExporter().parse(mesh, { binary: true }) as DataView;
    merged.dispose();
    if (this.onDownloadFile) this.onDownloadFile('orcaxr_plate.stl', ownedArrayBuffer(stl), 'model/stl');
    this.setStatus('Exported plate as STL.');
  }

  /** Merged-plate geometry serialised to minimal 3MF package bytes (or null). */
  public build3mfBytes(): Uint8Array | null {
    const merged = this.mergedPrinterGeometry();
    if (!merged) return null;
    const nonIndexed = merged.index ? merged.toNonIndexed() : merged;
    const positions = nonIndexed.getAttribute('position').array as ArrayLike<number>;
    const bytes = writeMinimal3mf(positions);
    if (nonIndexed !== merged) nonIndexed.dispose();
    merged.dispose();
    return bytes;
  }

  /** Export the plate as a generic (geometry-only) 3MF (Orca File → Export 3MF). */
  public exportPlate3mf() {
    const bytes = this.build3mfBytes();
    if (!bytes) {
      this.setStatus('Nothing to export — add a model first.');
      return;
    }
    if (this.onDownloadFile) {
      this.onDownloadFile(
        'orcaxr_plate.3mf',
        ownedArrayBuffer(bytes),
        'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      );
    }
    this.setStatus('Exported plate as 3MF.');
  }

  // --- Save / Open Project (Orca File → Save / Open Project) -----------
  /** Serialise the whole scene (all plates + transforms + profile) to project bytes. */
  public buildProjectBytes(): Uint8Array | null {
    const objects: { positions: Float32Array }[] = [];
    const objMeta: ProjectObjectMeta[] = [];
    for (const plate of this.plates) {
      for (const m of plate.models) {
        const g = m.raw.index ? m.raw.toNonIndexed() : m.raw;
        const arr = g.getAttribute('position').array;
        objects.push({ positions: arr instanceof Float32Array ? arr : new Float32Array(arr as ArrayLike<number>) });
        const v = m.viewer;
        objMeta.push({
          plate: plate.id,
          viewer: {
            position: [v.position.x, v.position.y, v.position.z],
            quaternion: [v.quaternion.x, v.quaternion.y, v.quaternion.z, v.quaternion.w],
            scale: [v.scale.x, v.scale.y, v.scale.z],
          },
          display: [m.display.position.x, m.display.position.y, m.display.position.z],
        });
      }
    }
    if (objects.length === 0) return null;
    const opts = this.getProfileOptions();
    const meta: ProjectMeta = {
      version: 1,
      profile: { machine: opts.machine, process: opts.process, filament: opts.filament },
      activePlate: this.activePlateId,
      plates: this.plates.map((p) => ({ id: p.id, label: p.label })),
      objects: objMeta,
    };
    return writeProject3mf(objects, meta);
  }

  /**
   * Exact guard for the immutable FullSpectrum source. The lightweight
   * OrcaXR writer captures geometry/transforms/plates but not vertex paint or
   * every slicer control, so those are included alongside its bytes.
   */
  private captureSemanticProjectSnapshot(): SemanticProjectSnapshot | null {
    const projectBytes = this.buildProjectBytes();
    if (!projectBytes) return null;

    const colorBuffers: Array<SemanticBufferSnapshot | null> = [];
    for (const plate of this.plates) {
      for (const model of plate.models) {
        const color = model.raw.getAttribute('color');
        if (!color) {
          colorBuffers.push(null);
          continue;
        }
        const array = color.array as unknown as ArrayBufferView;
        const bytes = new Uint8Array(array.byteLength);
        bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        colorBuffers.push({
          arrayType: (array as unknown as { constructor: { name: string } }).constructor.name,
          itemSize: color.itemSize,
          normalized: color.normalized,
          bytes,
        });
      }
    }

    const sortedEntries = (record: Record<string, string>) =>
      Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
    const controls = JSON.stringify({
      version: 1,
      palette: this.palette.list(),
      virtualFilaments: this.virtualFilaments,
      projectPrimeTower: this.projectPrimeTower,
      profile: this.profile
        ? {
            id: this.profile.id,
            displayName: this.profile.displayName,
            machineName: this.profile.machineName,
            processName: this.profile.processName,
            filamentName: this.profile.filamentName,
            config: sortedEntries(this.profile.config),
          }
        : null,
      customOverrides: sortedEntries(this.customOverrides),
      wipeTowerAuto: this.wipeTowerAuto,
      paintedSliceEnabled: this.paintedSliceEnabled,
      headFilaments: [...this.headFilaments],
      headNozzles: [...this.headNozzles],
    });

    return { projectBytes, colorBuffers, controls };
  }

  /** Save the project as a downloadable OrcaXR .3mf (File → Save Project). */
  public saveProject() {
    const bytes = this.buildProjectBytes();
    if (!bytes) {
      this.setStatus('Nothing to save — add a model first.');
      return;
    }
    if (this.onDownloadFile) {
      this.onDownloadFile(
        'orcaxr_project.3mf',
        ownedArrayBuffer(bytes),
        'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      );
    }
    this.setStatus('Project saved.');
  }

  /** Restore a scene from OrcaXR project bytes (File → Open Project). */
  public openProject(bytes: ArrayBuffer): boolean {
    const parsed = parseProject3mf(new Uint8Array(bytes));
    if (!parsed) {
      this.setStatus('Not an OrcaXR project file (use Import for plain models).');
      return false;
    }
    const { meta, geometries } = parsed;
    this.newProject();
    if (meta.profile) this.setProfileByNames(meta.profile.machine, meta.profile.process, meta.profile.filament);

    // Map saved plate ids onto freshly-created plates (newProject left plate 1).
    const savedPlates = meta.plates?.length ? meta.plates : [{ id: 1, label: 'Plate 1' }];
    const plateMap = new Map<number, number>();
    const first = this.plates[0];
    first.label = savedPlates[0].label;
    plateMap.set(savedPlates[0].id, first.id);
    for (let i = 1; i < savedPlates.length; i++) {
      this.addPlate();
      const created = this.plates[this.plates.length - 1];
      created.label = savedPlates[i].label;
      plateMap.set(savedPlates[i].id, created.id);
    }

    meta.objects.forEach((om, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(geometries[i] ?? new Float32Array(0), 3));
      this.setActivePlate(plateMap.get(om.plate) ?? first.id);
      this.addModelFromGeometry(geo, 0x4fc3f7);
      const added = this.models[this.models.length - 1];
      added.viewer.position.set(om.viewer.position[0], om.viewer.position[1], om.viewer.position[2]);
      added.viewer.quaternion.set(
        om.viewer.quaternion[0],
        om.viewer.quaternion[1],
        om.viewer.quaternion[2],
        om.viewer.quaternion[3],
      );
      added.viewer.scale.set(om.viewer.scale[0], om.viewer.scale[1], om.viewer.scale[2]);
      added.display.position.set(om.display[0], om.display[1], om.display[2]);
    });

    this.setActivePlate(plateMap.get(meta.activePlate) ?? first.id);
    this.unselectModel();
    if (this.onSelectionChanged) this.onSelectionChanged(false);
    if (this.onPlatesChanged) this.onPlatesChanged();
    this.recomputePreflight();
    this.setStatus(
      `Opened project — ${meta.objects.length} model${meta.objects.length === 1 ? '' : 's'}, ${savedPlates.length} plate${savedPlates.length === 1 ? '' : 's'}.`,
    );
    return true;
  }

  public async sliceNow() {
    if (this.slicer.isSlicing) return;
    if (this.models.length === 0) {
      this.setStatus('No models to slice.');
      return;
    }
    try {
      if (this.onSliceStateChanged) this.onSliceStateChanged(true);
      if (this.sliceModalCard) this.sliceModalCard.show();
      this.setStatus('baking transforms…', 0);
      await new Promise((r) => setTimeout(r, 50)); // let UI paint
      const fsProject = this.canonicalSliceRequiredReason !== null || this.virtualFilaments.length > 0;
      // Painted (multi-colour) input, if the plated models use >1 filament.
      const painted = this.buildPaintedInput();
      const sliceRoute = selectSemanticSliceRoute({
        hasFullSpectrumSource: fsProject,
        paintedInputAvailable: painted !== null,
        distinctPaintAssignments: painted?.distinctCount ?? 0,
        paintedEngineEnabled: this.paintedSliceEnabled,
        externalGeometryEndpoint: SlicerClient.useExternalSlicer(),
      });
      const isPainted = sliceRoute === 'painted';
      this.setStatus(isPainted ? 'slicing (multi-colour)…' : 'slicing…', 0);
      const t0 = performance.now();
      const overrides: Record<string, string> = {
        ...(this.profile?.config ?? {}),
        ...this.palette.toSlicerOverrides(),
        ...this.customOverrides,
      };
      if (this.wipeTowerAuto) {
        const pick = scoreWipeTower(this.printerPartAabbs(), this.bedMm.x, this.bedMm.y, {
          bias: parseBias(this.profile?.config['wipe_tower_bias']),
        });
        overrides['wipe_tower_x'] = pick.xMm.toFixed(2);
        overrides['wipe_tower_y'] = pick.yMm.toFixed(2);
        if (this.projectPrimeTower?.enabled) {
          this.projectPrimeTower.xMm = pick.xMm;
          this.projectPrimeTower.yMm = pick.yMm;
          this.rebuildWipeTowerGhost();
        }
      }
      if (!isPainted && this.extruderCount > 1) {
        overrides['nozzle_diameter'] = this.headNozzles.join(',');
        // Combine the configs for the selected filaments for each head
        if (this.profile) {
          const filamentConfigs = this.headFilaments.map(
            (fName) => this.catalog.find(this.profile!.machineName, this.profile!.processName, fName)?.config ?? {},
          );

          // Helper to join array-based config properties across the different filaments
          const joinFilamentProp = (prop: string, sep: ',' | ';') =>
            filamentConfigs.map((c) => c[prop] ?? '').join(sep);

          // String vectors split on ';' in libslic3r; numeric vectors on ','
          // (gotcha #19 — a comma-joined string list parses as ONE value).
          overrides['filament_type'] = joinFilamentProp('filament_type', ';');
          overrides['filament_diameter'] = joinFilamentProp('filament_diameter', ',');
        }
      }

      let gcode: string;
      // FullSpectrum geometry cannot express the embedded mixed-filament
      // definitions on its own. Slice the original bytes only while every
      // slice-relevant value is exactly as loaded; edits fail closed until the
      // canonical live-project coordinator can serialize them without loss.
      if (sliceRoute === 'fullspectrum') {
        this.setStatus('slicing FullSpectrum project (as authored)…', 0);
        gcode = await requireSemanticSlice('fullspectrum', async () => {
          if (this.canonicalSliceRequiredReason) {
            throw new Error(this.canonicalSliceRequiredReason);
          }
          const current = this.captureSemanticProjectSnapshot();
          if (
            !current ||
            !this.originalProjectSnapshot ||
            !sameSemanticProjectSnapshot(this.originalProjectSnapshot, current)
          ) {
            throw new Error(
              'The FullSpectrum workspace differs from its imported source; canonical live-project slicing is required.',
            );
          }
          return this.slicer.sliceProject(this.originalProject!, 4, {});
        });
      } else if (isPainted && painted) {
        // Painted colours = one physical nozzle with N filaments swapped by
        // colour (MMU / AMS model). single_extruder_multi_material avoids the
        // per-printer-extruder config lookup that fails on a multi-head profile,
        // and a full N×N flush matrix keeps the tool-ordering flush optimiser
        // in bounds. The engine's historical multi-material OOBs
        // (calc_filament_change_info_by_toolorder & friends) are fixed by
        // patch 0075 + the shim's post-override filament-vector normalization.
        // Failure is intentionally terminal for this attempt: substituting the
        // geometry route would silently erase the user's material intent.
        const n = painted.filamentCount;
        // ';' separator: ConfigOptionStrings parses a comma-joined list as
        // ONE color, silently shrinking the engine's filament count.
        const colors = this.palette
          .list()
          .slice(0, n)
          .map((s) => s.color)
          .join(';');
        const matrix: number[] = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) matrix.push(i === j ? 0 : 140);
        const paintedOverrides: Record<string, string> = {
          ...overrides,
          single_extruder_multi_material: '1',
          nozzle_diameter: (this.profile?.config['nozzle_diameter'] ?? '0.4').split(',')[0] || '0.4',
          filament_colour: colors,
          extruder_colour: colors,
          flush_volumes_matrix: matrix.join(','),
          flush_volumes_vector: Array(n).fill(140).join(','),
        };
        gcode = await requireSemanticSlice('painted', () =>
          this.slicer.slicePainted(painted.positions, painted.triFilament, painted.filamentCount, 4, paintedOverrides),
        );
      } else {
        gcode = await this.slicer.slice(this.bakeToPrinterStl(), 4, overrides);
      }
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
    } finally {
      if (this.onSliceStateChanged) this.onSliceStateChanged(false);
      if (this.sliceModalCard) this.sliceModalCard.hide();
    }
  }

  /**
   * Bake the display meshes' CURRENT world poses into a binary STL in
   * printer coordinates: mm, Z-up, bed origin at the plate corner with
   * the models dropped onto Z=0.
   */
  /**
   * Each plated model's geometry converted into printer coordinates (mm,
   * Z-up, bed-centre origin, +X right / +Y back). One geometry per model —
   * the shared basis for both the slice bake and the pre-flight / wipe-tower
   * checks, so "what you see is what slices" stays a single transform path.
   */
  private printerGeometries(): THREE.BufferGeometry[] {
    this.plateAnchor.updateMatrixWorld(true);
    const plateInverse = new THREE.Matrix4().copy(this.plateAnchor.matrixWorld).invert();

    const conv = new THREE.Matrix4().set(
      1000,
      0,
      0,
      this.bedMm.x / 2,
      0,
      0,
      -1000,
      this.bedMm.y / 2,
      0,
      1000,
      0,
      0,
      0,
      0,
      0,
      1,
    );

    const geometries: THREE.BufferGeometry[] = [];
    for (const entry of this.models) {
      // Update the viewer (parent) FIRST: display.updateMatrixWorld reads
      // viewer.matrixWorld as-is, and for a model added since the last render
      // frame that world matrix is still stale — which placed every model past
      // the first at the bed edge (off-bed pre-flight, blocked slicing).
      entry.viewer.updateMatrixWorld(true);
      entry.display.updateMatrixWorld(true);
      const rel = new THREE.Matrix4().copy(plateInverse).multiply(entry.display.matrixWorld);

      const geo = (entry.display.geometry as THREE.BufferGeometry).clone();
      geo.applyMatrix4(rel);
      geo.applyMatrix4(conv);
      geometries.push(geo);
    }
    return geometries;
  }

  /**
   * All plated models merged into one non-indexed printer-space geometry
   * (mm, Z-up, dropped onto Z=0). Carries the `color` attribute so the painted
   * slice can read per-triangle filament from vertex colours. Single source for
   * the mono bake, the painted bake, and the pre-flight collision check.
   */
  private mergedPrinterGeometry(): THREE.BufferGeometry | null {
    const geometries = this.printerGeometries();
    if (geometries.length === 0) return null;
    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    if (!merged) return null;
    merged.computeBoundingBox();
    merged.translate(0, 0, -merged.boundingBox!.min.z);
    return merged.index ? merged.toNonIndexed() : merged;
  }

  private bakeToPrinterStl(): ArrayBuffer {
    const merged = this.mergedPrinterGeometry();
    if (!merged) return new ArrayBuffer(84);
    return writeBinaryStl(merged);
  }

  /**
   * Build the painted-slice input from the plated models' vertex colours:
   * raw Float32 positions (9/tri) + a 0-based filament index per triangle.
   * Returns null when there's nothing to slice. `distinctCount > 1` means the
   * model is genuinely multi-colour and should take the painted path.
   */
  private buildPaintedInput(): {
    positions: Float32Array;
    triFilament: Int32Array;
    filamentCount: number;
    distinctCount: number;
  } | null {
    const merged = this.mergedPrinterGeometry();
    if (!merged) return null;
    const posAttr = merged.getAttribute('position');
    if (!posAttr) return null;
    const colAttr = merged.getAttribute('color');
    const triCount = Math.floor(posAttr.count / 3);
    const paletteHex = this.palette.list().map((s) => s.color);
    const { triFilament, distinctCount } = deriveTriangleFilaments(
      colAttr?.array as ArrayLike<number> | undefined,
      triCount,
      paletteHex,
    );
    const posArr = posAttr.array;
    const positions = posArr instanceof Float32Array ? posArr : new Float32Array(posArr);
    return { positions, triFilament, filamentCount: paletteHex.length, distinctCount };
  }

  /**
   * Per-model XY bounding boxes in printer coordinates — the input the
   * wipe-tower placement scorer needs. Bed origin is the corner (0..bed),
   * matching libslic3r's `wipe_tower_x/y` frame.
   */
  private printerPartAabbs(): AabbXY[] {
    const out: AabbXY[] = [];
    for (const geo of this.printerGeometries()) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) continue;
      // printerGeometries() centres the bed at origin; shift to corner origin.
      out.push({
        xMin: bb.min.x + this.bedMm.x / 2,
        xMax: bb.max.x + this.bedMm.x / 2,
        yMin: bb.min.y + this.bedMm.y / 2,
        yMax: bb.max.y + this.bedMm.y / 2,
      });
    }
    return out;
  }

  /** Toggle wipe-tower auto-positioning (Section 1 pre-flight). */
  public setWipeTowerAuto(on: boolean): void {
    this.wipeTowerAuto = on;
  }

  /** True when a blocking (error) pre-flight banner is active — gates Slice. */
  public hasBlockingPreflight(): boolean {
    return this.preflightBanners.some((b) => b.severity === 'error');
  }

  /**
   * Recompute the pre-flight banner set from the live scene: bed collision,
   * filament-vs-bed rules, and the top-cover hint. Fires `onPreflight`. Cheap
   * enough to run on load / profile change / transform-end.
   */
  public recomputePreflight(): void {
    // The tower ghost's height tracks the tallest plated model; this runs on
    // every load / delete / transform-end, which is exactly when that changes.
    this.rebuildWipeTowerGhost();
    const banners: PreflightBanner[] = [];

    if (this.models.length > 0) {
      const merged = BufferGeometryUtils.mergeGeometries(this.printerGeometries(), false);
      const pos = merged?.getAttribute('position');
      if (pos) {
        const res = detectBedCollision(pos.array as ArrayLike<number>, this.bedMm.x, this.bedMm.y);
        const text = bedCollisionBanner(res);
        if (text) banners.push({ id: 'bed-collision', severity: 'error', text });
      }
    }

    const cfg = this.profile?.config ?? {};
    const bedKey = bedKeyFor(cfg['curr_bed_type']);
    const filamentTypes = this.palette.list().map((s) => s.type);
    const rule = evaluateFilamentRules(this.filamentRules, bedKey, filamentTypes);
    if (rule.kind === 'forbidden') banners.push({ id: 'filament-rule', severity: 'error', text: rule.message });
    else if (rule.kind === 'warning') banners.push({ id: 'filament-rule', severity: 'warning', text: rule.message });

    const topCover = evaluateTopCover(cfg);
    if (topCover.kind === 'warning') banners.push({ id: 'top-cover', severity: 'info', text: topCover.message });

    this.preflightBanners = banners;
    if (this.onPreflight) this.onPreflight(banners);
  }

  public async fixSelectedModel() {
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

  public async booleanModels(op: 'UNION' | 'A_NOT_B' | 'INTERSECTION') {
    if (this.models.length < 2) {
      this.setStatus('Requires at least 2 models for boolean operations.');
      return;
    }
    let target = this.selectedModel;
    let tool = this.models.find((m) => m !== target);

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

      // Remove the tool model from the workspace (active plate).
      this.workspace.remove(tool.viewer);
      const ti = this.models.indexOf(tool);
      if (ti !== -1) this.models.splice(ti, 1);

      this.setStatus(`Boolean ${op} successful.`);
    } catch (e: any) {
      this.setStatus(`Boolean failed: ${e.message}`);
    }
  }

  private addAiMcpPanel() {
    const card = this.uiCore.createCard({
      name: 'AiMcpPanel',
      sizeX: 0.4,
      sizeY: 0.6,
      pixelSize: 0.0012,
      position: new THREE.Vector3(0.95, PLATE_Y + 0.15, PLATE_Z - 0.3),
      width: 330,
      alignItems: 'center',
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 16,
          manipulationCornerRadius: 16,
        }),
      ],
    });
    card.visible = false;
    this.aiMcpCard = card;

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
      height: '100%',
    });
    card.add(root);

    const mcpHeader = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center' });
    mcpHeader.add(new UIText('MCP Server', { fontSize: 24, fontWeight: 'bold', color: '#ffffff' }));
    root.add(mcpHeader);

    const mcpBtn = new UIPanel({
      width: '100%',
      height: 50,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 8,
      fillColor: '#ffffff14',
      strokeWidth: 1,
      strokeColor: '#ffffff1a',
      onClick: () => {
        this.setStatus('MCP Server enabled');
        return true;
      },
      onHoverEnter: () => {
        mcpBtn.setFillColor('#ffffff26');
      },
      onHoverExit: () => {
        mcpBtn.setFillColor('#ffffff14');
      },
    });
    mcpBtn.add(new UIText('Enable MCP Server', { fontSize: 18, color: '#e0e6ee' }));
    root.add(mcpBtn);

    const aiHeader = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center', marginTop: 10 });
    aiHeader.add(new UIText('AI Features', { fontSize: 24, fontWeight: 'bold', color: '#ffffff' }));
    root.add(aiHeader);

    const makeAiBtn = (label: string, actionMsg: string) => {
      const btn = new UIPanel({
        width: '100%',
        height: 50,
        justifyContent: 'center',
        alignItems: 'center',
        cornerRadius: 8,
        fillColor: '#ffffff14',
        strokeWidth: 1,
        strokeColor: '#ffffff1a',
        onClick: () => {
          if (this.models.length === 0) {
            this.setStatus('Load a model first');
          } else {
            this.setStatus(actionMsg);
          }
          return true;
        },
        onHoverEnter: () => {
          btn.setFillColor('#ffffff26');
        },
        onHoverExit: () => {
          btn.setFillColor('#ffffff14');
        },
      });
      btn.add(new UIText(label, { fontSize: 18, color: '#e0e6ee' }));
      return btn;
    };

    root.add(makeAiBtn('Smart Paint (AI)', 'Running Smart Paint...'));
    root.add(makeAiBtn('Semantic Planner', 'Running Semantic Planner...'));
  }

  async smartPaint() {
    if (!this.selectedModel) {
      this.setStatus('Select a model first to paint');
      return;
    }
    const prompt = window.prompt("Enter what you want to paint (e.g. 'Paint the top surface red')");
    if (!prompt) return;

    this.setStatus('Generating AI Paint Plan...');
    try {
      // The Gemini SDK is only needed after a maker deliberately invokes an
      // AI feature. Keeping it out of the startup graph makes initial WebXR
      // entry and ordinary local slicing faster on constrained headsets.
      const { AiPaintService } = await import('../features/AiPaintService');
      const plan = await AiPaintService.generatePaintPlan(prompt);
      await this.applySemanticPaintPlan(plan);
      this.setStatus('Smart Paint applied successfully');
    } catch (e: any) {
      this.setStatus('Smart Paint failed: ' + e.message);
    }
  }

  async smartPaintImage() {
    if (!this.selectedModel) {
      this.setStatus('Select a model first to paint');
      return;
    }
    const prompt = window.prompt('Enter instructions for painting with an image');
    if (!prompt) return;

    // Open file picker for image
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Url = reader.result as string;
        const base64 = base64Url.split(',')[1]; // remove data:image/...;base64,
        this.setStatus('Generating AI Paint Plan with Image...');
        try {
          const { AiPaintService } = await import('../features/AiPaintService');
          const plan = await AiPaintService.generatePaintPlan(prompt, base64);
          await this.applySemanticPaintPlan(plan);
          this.setStatus('Smart Paint (Image) applied successfully');
        } catch (e: any) {
          this.setStatus('Smart Paint failed: ' + e.message);
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  async applySemanticPaintPlan(plan: any) {
    if (!this.selectedModel) return;
    const mesh = this.selectedModel.display;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry.boundsTree) {
      geometry.computeBoundsTree();
    }

    // We need a dummy camera spec
    const camera = {
      widthPx: 512,
      heightPx: 512,
      projMatrixRowMajor: new Float32Array(16),
      viewMatrixRowMajor: new Float32Array(16),
    };

    const filamentSlots = this.palette.list();
    const palette = filamentSlots.map((_filament, index) => ({
      slot: index + 1,
      lab: { l: 50, a: 0, b: 0 },
    }));

    const resolved = SemanticPaintPlanner.resolve(geometry.boundsTree, camera, plan, palette);
    if (!resolved) {
      this.setStatus('Failed to resolve AI paint plan on mesh.');
      return;
    }

    // Convert resolved.perTriangleSlot to colors
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < resolved.perTriangleSlot.length; i++) {
      const slot = resolved.perTriangleSlot[i];
      const fil = filamentSlots[slot - 1] ?? filamentSlots[0];
      if (!fil) continue;
      const c = new THREE.Color(fil.color);
      // set color for 3 vertices of triangle
      for (let v = 0; v < 3; v++) {
        colors[(i * 3 + v) * 3] = c.r;
        colors[(i * 3 + v) * 3 + 1] = c.g;
        colors[(i * 3 + v) * 3 + 2] = c.b;
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
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
