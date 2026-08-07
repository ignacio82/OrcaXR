/**
 * OrcaXR Web — Phase 2 workspace.
 *
 * A build plate whose Three/XR scene is a one-way projection of the canonical
 * project controller. Manipulation commits stable-ID commands back to that
 * controller; save and slice serialize the same canonical state.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { FilamentId, InstanceId, LayerRangeId, ObjectId, PlateId, VolumeId } from '../project/domain/ids';
import { entityId, UuidIdSource } from '../project/domain/ids';
import type { ConfigMap, Transform } from '../project/domain/model';
import type { FullSpectrumAutoPairGenerationPreferences } from '../project/filaments/autoPairReconciliation';
import type { ImportCommitConfirmation, ProjectImportPreview } from '../project/import/types';
import type { ObjectTreeEntityRef } from '../project/objects';
import {
  SlicePreflightError,
  type CanonicalProjectSliceGuard,
  type CanonicalSlicePreflightResult,
  type SliceJobStatus,
} from '../project/slicing';
import type { ProjectSettingsOverrideGuard, ProjectSettingsOverrideSnapshot } from '../project/settingsOverrides';
import { CURRENT_THREE_WORLD_UNITS_PER_MM, getThreeProjectEntity } from '../project/surfaces/ThreeProjectSurface';
import { PaintStrokeService, type PaintToolKind, type PaintToolSettings } from '../project/painting/PaintStrokeService';
import { paintPaletteColors, type PaintPalette } from '../project/painting/paintPalette';
import {
  CanonicalWorkspaceController,
  type CanonicalFilamentAssignableEntityRef,
  type CanonicalFilamentAssignmentSnapshot,
  type CanonicalAutoPairReconciliationConfirmation,
  type CanonicalAutoPairReconciliationResult,
  type CanonicalAutoPairPolicySnapshot,
  type CanonicalObjectsTreeSnapshot,
  type CanonicalSemanticLayerRangeRequest,
  type CanonicalSemanticObjectEditorSnapshot,
  type CanonicalSemanticVolumeRoleRequest,
  type CanonicalSplitToObjectsConfirmation,
  type CanonicalVirtualFilamentLibrarySnapshot,
  type CanonicalVirtualFilamentMutationRequest,
  type CanonicalWorkspaceSummary,
} from './CanonicalWorkspaceController';
import { runCanonicalSplitToObjectsFlow } from './CanonicalSplitToObjectsFlow';
import { CanonicalWorkspaceSlicer } from './CanonicalWorkspaceSlicer';
import {
  projectMultiInstancePrimaryTransform,
  projectMultiInstanceTransform,
  type MultiInstanceTransformMode,
  type MultiInstanceTransformOrigin,
} from './multiInstanceTransform';
import { deriveLiveProfilePreflightConstraints, LiveProfileSlicePreflight } from './ProfilePreflightConstraints';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Action, ActionRegistry, ActionSurface } from '../actions/ActionRegistry';
import { MENU_SECTIONS } from '../actions/ActionRegistry';
import type { ActionContext } from '../actions/ActionContext';
import { renderXrActionButton, xrToolRailActions, type XrUiFactory } from '../ui/xr/XrShell';
import { SceneGestureGuard } from '../ui/xr/SceneGestureGuard';
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
import { bedSizeFromProfile, ProfileCatalog, type SlicerProfile } from '../slicer/ProfileLoader';
import { SlicerClient } from '../slicer/SlicerClient';
import { exportConfigJson, parseConfigJson } from '../features/ConfigIO';
import { virtualFilamentsFromConfig, type VirtualFilament } from '../features/MixedFilamentPreview';
import { xrIcon } from '../ui/icons';

export type WorkspacePresetId = NonNullable<SlicerProfile['machinePresetId']>;

export interface WorkspacePresetOption {
  readonly id: WorkspacePresetId;
  /** Exact canonical preset name. */
  readonly name: string;
  /** Compact, disambiguated picker label. */
  readonly label: string;
}

export interface WorkspaceProfileSelectionRequest {
  readonly machinePresetId?: WorkspacePresetId;
  readonly processPresetId?: WorkspacePresetId;
  readonly filamentPresetIds?: readonly (WorkspacePresetId | undefined)[];
}

export interface WorkspaceProfileSelectionFeedback {
  readonly applied: boolean;
  readonly severity: 'info' | 'warning' | 'error';
  readonly messages: readonly string[];
}

interface HeadFilamentSelection {
  readonly presetId?: WorkspacePresetId;
  readonly name: string;
}

/** Fallback bed until the profile catalog loads. */
const PLATE_MM = 200;
const MM = 0.001;

/** Derived colour overlays never occlude or intercept the canonical mesh. */
const PAINT_OVERLAY_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.85,
  metalness: 0,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const PAINT_PREVIEW_MATERIAL = new THREE.MeshBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.55,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
});
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

function cryptographicRandomWord(): number {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Cryptographically secure project ID generation is unavailable');
  }
  const word = new Uint32Array(1);
  globalThis.crypto.getRandomValues(word);
  return word[0] / 0x1_0000_0000;
}

function matchPresetOption(
  options: readonly WorkspacePresetOption[],
  query: string,
): WorkspacePresetOption | undefined {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized) return undefined;
  const exactLabels = options.filter((option) => option.label.toLocaleLowerCase('en-US') === normalized);
  if (exactLabels.length === 1) return exactLabels[0];
  const exactNames = options.filter((option) => option.name.toLocaleLowerCase('en-US') === normalized);
  if (exactNames.length === 1) return exactNames[0];
  const partial = options.filter(
    (option) =>
      option.name.toLocaleLowerCase('en-US').includes(normalized) ||
      option.label.toLocaleLowerCase('en-US').includes(normalized),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

function disambiguatePresetOptionLabels(options: readonly WorkspacePresetOption[]): WorkspacePresetOption[] {
  const labelCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const option of options) {
    labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
    nameCounts.set(option.name, (nameCounts.get(option.name) ?? 0) + 1);
  }
  return options.map((option) =>
    labelCounts.get(option.label) === 1
      ? option
      : Object.freeze({
          ...option,
          label:
            nameCounts.get(option.name) === 1
              ? option.name
              : `${option.name} — ${presetVendorName(option.id) ?? 'another vendor'}`,
        }),
  );
}

function presetVendorName(id: WorkspacePresetId): string | undefined {
  const encoded = id.split(':')[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function unambiguousProfileScalar(value: string | undefined): string | undefined {
  if (!value?.trim() || /[;,]/.test(value)) return undefined;
  return value.trim();
}

function profileNozzleForTool(profile: SlicerProfile | null, toolId: number): string {
  const nozzles = profile?.config['nozzle_diameter']
    ?.split(/[;,]/)
    .map((value) => value.trim())
    .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (nozzles?.[toolId]) return nozzles[toolId];
  const singleExtruderMultiMaterial =
    unambiguousProfileScalar(profile?.config['single_extruder_multi_material'])?.toLowerCase() === '1' ||
    unambiguousProfileScalar(profile?.config['single_extruder_multi_material'])?.toLowerCase() === 'true';
  return nozzles?.length === 1 && singleExtruderMultiMaterial ? nozzles[0] : '0.4';
}

function canonicalPreflightUnavailable(plateId: PlateId, error: unknown): CanonicalSlicePreflightResult {
  const detail = (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 240);
  const issue = Object.freeze({
    id: 'slice-preflight:invalid-project-state:canonical-source-unavailable',
    code: 'invalid-project-state' as const,
    detailCode: 'canonical-source-unavailable',
    severity: 'error' as const,
    message: `Canonical slice preflight is unavailable${detail ? `: ${detail}` : '.'}`,
    help: 'Resolve the canonical project or projection error before slicing. The scene projection is never used as fallback validation.',
    entities: Object.freeze([{ kind: 'project' as const }]),
    actions: Object.freeze([]),
  });
  return Object.freeze({
    plateId,
    canSlice: false,
    blockingCount: 1,
    issues: Object.freeze([issue]),
    printableInstanceIds: Object.freeze([]),
    usedFilamentIds: Object.freeze([]),
  });
}

function transformFromObject(object: THREE.Object3D): Transform {
  const quaternion = object.quaternion.clone().normalize();
  return {
    translationMm: [object.position.x, object.position.y, object.position.z],
    rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

/** One plated model: its source geometry, the display mesh, and the grab proxy. */
type ProjectedModelEntry = {
  instanceId: InstanceId;
  objectId: ObjectId;
  plateId: PlateId;
  volumeId: VolumeId;
  raw: THREE.BufferGeometry;
  display: THREE.Mesh;
  viewer: THREE.Object3D;
};

interface ActiveTransformGesture {
  readonly id: string;
  readonly origins: readonly MultiInstanceTransformOrigin[];
  readonly initialPivotTransform: Transform;
}

interface GeometryLoadOptions {
  preservePrinterXY?: boolean;
  preservePrinterZ?: boolean;
  deferPostAdd?: boolean;
  deferBoundsTree?: boolean;
}

type ProjectPrimeTower = { enabled: boolean; xMm: number; yMm: number; widthMm: number };

export type WorkspaceGizmoTool = 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint';

export interface WorkspaceAutomationSnapshot {
  workspaceMode: 'Prepare' | 'Preview';
  activePlateId: PlateId;
  gizmoTool: WorkspaceGizmoTool;
  selectedProfileId: string | null;
  placedModelsTotalAllPlates: number;
  plates: { id: PlateId; label: string; count: number; active: boolean }[];
  placedModels: {
    id: string;
    label: string;
    plateId: PlateId;
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

export interface OrcaWorkspaceOptions {
  readonly fullSpectrumAutoPairPreferences?: FullSpectrumAutoPairGenerationPreferences;
}

export class OrcaWorkspace extends xb.Script {
  private uiCore: UICore;
  private readonly lifecycleDisposers: Array<() => void> = [];
  private disposed = false;
  private slicer = new SlicerClient();
  /** True once a post-import local-engine warm-up has been scheduled. */
  private slicerWarmupQueued = false;
  private catalog = new ProfileCatalog();
  private profile: SlicerProfile | null = null;
  /** Prevent the asynchronous catalog default from overwriting an import's
   * canonical slicing configuration while its preview is open or after commit. */
  private projectImportInProgress = false;
  private importedProjectOwnsSlicingConfiguration = false;
  /** Live bed size (mm) — from the active profile's printable_area. */
  private bedMm = { x: PLATE_MM, y: PLATE_MM };
  private plateAnchor = new THREE.Object3D();
  /** Everything spatial lives in this group: scaled up for legibility and
   *  re-posed in front of the user when the XR session starts. */
  private workspace = new THREE.Group();
  /** Sole mutable owner of project/model/plate/selection/history state. */
  private readonly canonicalProject: CanonicalWorkspaceController;
  private activeCanonicalSlicer: CanonicalWorkspaceSlicer | null = null;

  /** Read-only compatibility projection while the surrounding shell migrates. */
  private get plates(): ReadonlyArray<{
    id: PlateId;
    label: string;
    models: readonly ProjectedModelEntry[];
  }> {
    const summary = this.canonicalProject.getSummary();
    return summary.plates.map((plate) => ({
      id: plate.id,
      label: plate.name,
      models: this.projectedModels(plate.id),
    }));
  }

  private get activePlateId(): PlateId {
    return this.canonicalProject.getSummary().activePlateId;
  }

  private get models(): ProjectedModelEntry[] {
    return this.projectedModels(this.activePlateId);
  }
  /** Fired on plate add/remove/switch so the DOM plate bar can re-render. */
  public onPlatesChanged: (() => void) | null = null;
  /** The model actions like Repair / Delete / Boolean / Auto-orient act on.
   *  Set by selectModel and auto-selected on load; previously undeclared, which
   *  silently made all those actions no-op ("select a model first"). */
  private get selectedModel(): ProjectedModelEntry | null {
    const selected = this.canonicalProject.getSummary().primaryInstanceId;
    if (!selected) return null;
    return this.projectedModels().find((entry) => entry.instanceId === selected) ?? null;
  }
  /** Fired when the selection changes so the UI can enable selection actions. */
  public onSelectionChanged: ((hasSelection: boolean) => void) | null = null;
  /** Fired when the selected model is transformed (moved, rotated, scaled). */
  public onSelectionTransformChanged: (() => void) | null = null;
  /** Canonical revision/history/health snapshot for both UI shells. */
  public onCanonicalStateChanged: ((summary: CanonicalWorkspaceSummary) => void) | null = null;
  public onSliceStateChanged: ((isSlicing: boolean) => void) | null = null;
  private statusText: UIText | null = null;
  private sliceModalCard: UICard | null = null;
  private sliceModalText: UIText | null = null;
  private sliceModalBar: UIPanel | null = null;
  private sliceModalProgressContainer: UIPanel | null = null;
  private publishedGcode: { readonly gcode: string; readonly guard: CanonicalProjectSliceGuard } | null = null;
  private toolpathObj: THREE.LineSegments | null = null;
  private previewOn = false;
  private needsRecenter = false;

  public orbitControls: OrbitControls | null = null;
  private transformControls: TransformControls | null = null;
  private readonly transformProxy = new THREE.Object3D();
  private transformGestureSequence = 0;
  private activeTransformGesture: ActiveTransformGesture | undefined;
  public onStatusChanged: ((text: string, percent?: number) => void) | null = null;
  public onDownloadReady: ((ready: boolean) => void) | null = null;
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
  /** Fired whenever canonical active-plate preflight evidence changes. */
  public onPreflight: ((result: CanonicalSlicePreflightResult) => void) | null = null;
  private preflightResult: CanonicalSlicePreflightResult | null = null;
  private preflightRecomputeQueued = false;

  constructor(
    private readonly actionRegistry: ActionRegistry,
    options: OrcaWorkspaceOptions = {},
  ) {
    super();
    this.canonicalProject = CanonicalWorkspaceController.createEmpty({
      idSource: new UuidIdSource(cryptographicRandomWord),
      clock: () => new Date(),
      parent: this.workspace,
      mapping: {
        bedSizeMm: [PLATE_MM, PLATE_MM],
        worldUnitsPerMm: CURRENT_THREE_WORLD_UNITS_PER_MM,
      },
      initialProjectConfig: {
        printable_area: [`0x0`, `${PLATE_MM}x0`, `${PLATE_MM}x${PLATE_MM}`, `0x${PLATE_MM}`],
      },
      ...(options.fullSpectrumAutoPairPreferences
        ? { fullSpectrumAutoPairPreferences: options.fullSpectrumAutoPairPreferences }
        : {}),
    });
    this.uiCore = new UICore(this);
    this.palette.onChanged = () => {
      this.synchronizeHeadSlotLengths();
      this.applyLiveSlicingConfiguration();
      this.rebuildPaintSwatches();
      this.onPaletteChanged?.();
      this.recomputePreflight();
    };
    const unsubscribeCanonical = this.canonicalProject.subscribe(
      (change) => {
        if (change.sources.includes('project')) {
          this.markPublishedGcodeStale();
          this.revalidatePublishedGcode();
          this.onPlatesChanged?.();
          this.queuePreflightRecompute();
          this.refreshPaintOverlays();
        }
        if (change.sources.includes('selection') || change.sources.includes('project')) {
          if (!this.activeTransformGesture) this.syncTransformProxy();
          this.onSelectionChanged?.(this.canonicalProject.getObjectsTree().selection.refs.length > 0);
        }
        this.onCanonicalStateChanged?.(change.current);
      },
      { emitCurrent: false },
    );
    this.lifecycleDisposers.push(unsubscribeCanonical);
  }

  private queuePreflightRecompute(): void {
    if (this.disposed || this.preflightRecomputeQueued || this.activeTransformGesture || this.drag) return;
    this.preflightRecomputeQueued = true;
    queueMicrotask(() => {
      this.preflightRecomputeQueued = false;
      if (this.disposed || this.activeTransformGesture || this.drag) return;
      this.recomputePreflight();
    });
  }

  /** Stable-ID scene projection; never a mutable model authority. */
  private projectedModels(plateId?: PlateId): ProjectedModelEntry[] {
    const entries: ProjectedModelEntry[] = [];
    for (const viewer of this.canonicalProject.surface.root.children) {
      const instance = getThreeProjectEntity(viewer);
      if (!instance || instance.kind !== 'instance' || (plateId && instance.plateId !== plateId)) continue;
      const display = viewer.children.find((child): child is THREE.Mesh => {
        const entity = getThreeProjectEntity(child);
        return child instanceof THREE.Mesh && entity?.kind === 'volume';
      });
      const volume = display ? getThreeProjectEntity(display) : undefined;
      if (!display || !volume?.volumeId) continue;
      entries.push({
        instanceId: instance.instanceId,
        objectId: instance.objectId,
        plateId: instance.plateId,
        volumeId: volume.volumeId,
        raw: display.geometry,
        display,
        viewer,
      });
    }
    return entries;
  }

  /** Read-only live boundary for diagnostics/E2E; returned summaries are immutable. */
  public getCanonicalSummary() {
    return this.canonicalProject.getSummary();
  }

  /** Read-only canonical hierarchy/selection snapshot for DOM and XR Objects surfaces. */
  public getObjectsTreeSnapshot(): CanonicalObjectsTreeSnapshot {
    return this.canonicalProject.getObjectsTree();
  }

  /** Observe canonical command boundaries without exposing mutable stores. */
  public subscribeCanonicalState(listener: () => void): () => void {
    return this.canonicalProject.subscribe(() => listener(), { emitCurrent: false });
  }

  /** Commit a typed Objects-tree selection through the canonical selection owner. */
  public setObjectsTreeSelection(
    refs: readonly ObjectTreeEntityRef[],
    primary: ObjectTreeEntityRef | undefined = refs.at(-1),
  ): void {
    this.canonicalProject.setObjectsTreeSelection(refs, primary);
  }

  /** Revision-bound filament options/effective assignments for the current Objects selection. */
  public getFilamentAssignmentSnapshot(refs?: readonly ObjectTreeEntityRef[]): CanonicalFilamentAssignmentSnapshot {
    return this.canonicalProject.getFilamentAssignmentSnapshot(refs);
  }

  /** Commit one guarded stable-ID assignment transaction across heterogeneous scopes. */
  public setFilamentAssignments(
    entities: readonly CanonicalFilamentAssignableEntityRef[],
    filamentId: FilamentId | null,
    guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
  ): boolean {
    return this.canonicalProject.setFilamentAssignments(entities, filamentId, guard);
  }

  /** Revision-bound physical/virtual library for the shared FullSpectrum editor. */
  public getVirtualFilamentLibrarySnapshot(): CanonicalVirtualFilamentLibrarySnapshot {
    return this.canonicalProject.getVirtualFilamentLibrarySnapshot();
  }

  /** One registry-routed, guarded canonical FullSpectrum lifecycle request. */
  public mutateVirtualFilament(request: CanonicalVirtualFilamentMutationRequest): void {
    const result = this.canonicalProject.mutateVirtualFilament(request);
    this.revalidatePublishedGcode();
    this.onSelectionChanged?.(false);
    this.setStatus(
      result.operation === 'delete'
        ? result.outcome === 'tombstoned'
          ? 'Deleted the virtual filament as a reference-preserving tombstone.'
          : 'Deleted the virtual filament.'
        : result.operation === 'set-enabled'
          ? 'Updated virtual filament availability.'
          : result.operation === 'edit'
            ? 'Updated the virtual filament recipe.'
            : result.operation === 'duplicate'
              ? 'Duplicated the virtual filament recipe.'
              : 'Added the virtual filament recipe.',
    );
  }

  /** Apply the explicit app-level auto-pair preference through canonical reconciliation. */
  public configureFullSpectrumAutoPairs(
    enabled: boolean,
    confirmation?: CanonicalAutoPairReconciliationConfirmation,
  ): CanonicalAutoPairReconciliationResult {
    const result = this.canonicalProject.setFullSpectrumAutoPairGenerationEnabled(enabled, confirmation);
    this.setStatus(
      !enabled
        ? 'Automatic virtual-filament pairs are off; existing recipes were preserved.'
        : result.status === 'confirmation-required'
          ? `Confirm generation of ${result.projectedPairCount} automatic pairs for ${result.physicalCount} physical filaments.`
          : result.status === 'reconciled'
            ? `Generated the complete ${result.projectedPairCount}-pair virtual-filament set.`
            : 'Automatic virtual-filament pairs are enabled and already current.',
    );
    return result;
  }

  public getFullSpectrumAutoPairPolicySnapshot(): CanonicalAutoPairPolicySnapshot {
    return this.canonicalProject.getFullSpectrumAutoPairPolicySnapshot();
  }

  /** Semantic role/range projection for the current typed Objects selection. */
  public getSemanticObjectEditorSnapshot(): CanonicalSemanticObjectEditorSnapshot | undefined {
    return this.canonicalProject.getSemanticObjectEditorSnapshot();
  }

  public createLayerRangeId(): LayerRangeId {
    return this.canonicalProject.createLayerRangeId();
  }

  public convertSemanticVolumeRole(request: CanonicalSemanticVolumeRoleRequest): void {
    this.canonicalProject.convertSemanticVolumeRole(request);
    this.revalidatePublishedGcode();
    this.setStatus('Updated the selected part role.');
  }

  public editSemanticLayerRange(request: CanonicalSemanticLayerRangeRequest): void {
    this.canonicalProject.editSemanticLayerRange(request);
    this.revalidatePublishedGcode();
    this.onSelectionChanged?.(false);
    this.setStatus('Updated the selected object height ranges.');
  }

  /** Rename only entity kinds with a canonical editable-name command. */
  public renameObjectsTreeEntity(
    entity: Extract<ObjectTreeEntityRef, { kind: 'object' | 'volume' }>,
    name: string,
  ): void {
    if (entity.kind === 'object') this.canonicalProject.renameObject(entity.id, name);
    else this.canonicalProject.renameVolume(entity.id, name);
  }

  /** Select, activate the owning plate, and frame an Objects row in the DOM scene. */
  public revealObjectsTreeEntity(entity: ObjectTreeEntityRef): void {
    const tree = this.canonicalProject.getObjectsTree().projection;
    const rowKey = tree.entityRowKeys.get(`${entity.kind}:${entity.id}`);
    let row = rowKey ? tree.rowsByKey.get(rowKey) : undefined;
    let plateId: PlateId | undefined;
    let objectId: ObjectId | undefined;
    while (row) {
      if (row.entity?.kind === 'plate') plateId = row.entity.id;
      if (row.entity?.kind === 'object') objectId = row.entity.id;
      row = row.parentKey ? tree.rowsByKey.get(row.parentKey) : undefined;
    }
    if (!plateId) throw new Error(`Objects row ${entity.kind}:${entity.id} has no owning plate`);
    if (this.canonicalProject.getSummary().activePlateId !== plateId) this.canonicalProject.activatePlate(plateId);
    this.canonicalProject.setObjectsTreeSelection([entity], entity);

    const targets: THREE.Object3D[] = [];
    if (entity.kind === 'instance') {
      const instance = this.canonicalProject.surface.getInstanceGroup(entity.id);
      if (instance) targets.push(instance);
    } else {
      for (const model of this.projectedModels(plateId)) {
        if (entity.kind === 'object' && model.objectId !== entity.id) continue;
        if (entity.kind === 'volume' && model.volumeId !== entity.id) continue;
        if (entity.kind === 'layer-range' && model.objectId !== objectId) continue;
        targets.push(entity.kind === 'volume' ? model.display : model.viewer);
      }
    }
    if (this.orbitControls && targets.length > 0) {
      const bounds = new THREE.Box3();
      for (const target of targets) {
        target.updateWorldMatrix(true, true);
        bounds.expandByObject(target, true);
      }
      if (!bounds.isEmpty()) {
        this.orbitControls.target.copy(bounds.getCenter(new THREE.Vector3()));
        this.orbitControls.update();
      }
    }
    this.setStatus(`Revealed ${tree.rowsByKey.get(rowKey!)?.label ?? entity.kind} in the scene.`);
  }

  private synchronizeHeadSlotLengths(): void {
    const target = this.palette.count();
    this.headFilaments.length = Math.min(this.headFilaments.length, target);
    this.headNozzles.length = Math.min(this.headNozzles.length, target);
    while (this.headFilaments.length < target) {
      this.headFilaments.push(this.headSelectionFromProfile(this.profile));
    }
    while (this.headNozzles.length < target) {
      this.headNozzles.push(profileNozzleForTool(this.profile, this.headNozzles.length));
    }
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
        this.applyCatalogDefaultProfile();
      } finally {
        catalogLoading = false;
      }
    };
    void loadCatalog();
    const onOnline = () => void loadCatalog();
    window.addEventListener('online', onOnline);
    this.lifecycleDisposers.push(() => window.removeEventListener('online', onOnline));
    this.slicer.onProgress = (p) => this.setStatus(`Slicing... ${p.message}`, p.percent);

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
    this.cancelPaintStroke();
    for (const [volumeId, overlay] of [...this.paintOverlays]) this.disposeOverlay(volumeId, overlay);
    this.paintServiceInstance = null;
    this.onPaintStateChanged = null;
    for (const dispose of this.lifecycleDisposers.splice(0).reverse()) dispose();
    this.palette.onChanged = null;
    this.activeCanonicalSlicer?.dispose();
    this.activeCanonicalSlicer = null;
    this.canonicalProject.dispose();
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
      if (event.value) {
        this.transformGestureSequence += 1;
        this.syncTransformProxy();
        const selection = this.captureSelectedInstanceOrigins();
        this.activeTransformGesture = selection
          ? {
              id: `transform-controls:${this.transformGestureSequence}`,
              origins: selection.origins,
              initialPivotTransform: transformFromObject(this.transformProxy),
            }
          : undefined;
      } else {
        this.activeTransformGesture = undefined;
        this.syncTransformProxy();
        this.revalidatePublishedGcode();
        this.recomputePreflight();
        this.onSelectionTransformChanged?.();
      }
    };
    const onTransformChanged = () => {
      const selected = this.selectedModel;
      if (!selected) return;
      const gesture = this.activeTransformGesture;
      const current = transformFromObject(this.transformProxy);
      if (gesture && gesture.origins.length > 1) {
        this.canonicalProject.setInstanceTransforms(
          projectMultiInstanceTransform(gesture.origins, gesture.initialPivotTransform, current, this.transformMode()),
          gesture.id,
        );
      } else {
        this.canonicalProject.setInstanceTransform(selected.instanceId, current, gesture?.id);
      }
      this.onSelectionTransformChanged?.();
    };
    this.transformControls.addEventListener('dragging-changed', onDraggingChanged);
    this.transformControls.addEventListener('objectChange', onTransformChanged);
    const controls = this.transformControls;
    this.lifecycleDisposers.push(() => {
      controls.removeEventListener('dragging-changed', onDraggingChanged);
      controls.removeEventListener('objectChange', onTransformChanged);
    });
    this.canonicalProject.surface.root.add(this.transformProxy);
    this.add(this.transformControls.getHelper());

    if (this.models.length > 0) {
      this.selectModel(this.models[this.models.length - 1]);
    } else {
      this.unselectModel();
    }

    this.setupSelectionRaycaster(canvas);
  }

  public selectModel(entry: ProjectedModelEntry, extendSelection = false) {
    // Track the selection in both shells so Repair / Delete / Boolean /
    // Auto-orient have a target; the transform gizmo is 2D-only.
    if (extendSelection) {
      const selected = this.canonicalProject.getSummary().selectedInstanceIds;
      const next = selected.includes(entry.instanceId)
        ? selected.filter((instanceId) => instanceId !== entry.instanceId)
        : [...selected, entry.instanceId];
      this.canonicalProject.setObjectsTreeSelection(
        next.map((instanceId) => ({ kind: 'instance', id: instanceId })),
        next.length > 0 ? { kind: 'instance', id: next.at(-1)! } : undefined,
      );
    } else {
      this.canonicalProject.selectInstance(entry.instanceId);
    }
    this.syncTransformProxy();
    if (this.transformControls && !xb.core.renderer.xr.isPresenting && this.selectedModel) {
      this.add(this.transformControls.getHelper());
      this.transformControls.attach(this.transformProxy);
      this.transformControls.getHelper().visible = true;
      this.setTool(this.tool);
      this.setStatus(`Selected model`);
    } else if (this.transformControls && !this.selectedModel) {
      this.transformControls.detach();
      this.transformControls.getHelper().visible = false;
      this.remove(this.transformControls.getHelper());
    }
    if (this.onSelectionChanged) this.onSelectionChanged(this.selectedModel !== null);
  }

  /** Select every visible instance on the active plate by stable identity. */
  public selectAllModels(): void {
    const entries = this.models;
    if (entries.length === 0) {
      this.unselectModel();
      return;
    }
    const refs = entries.map((entry) => ({ kind: 'instance' as const, id: entry.instanceId }));
    this.canonicalProject.setObjectsTreeSelection(refs, refs.at(-1));
    this.syncTransformProxy();
    if (this.transformControls && !xb.core.renderer.xr.isPresenting) {
      this.add(this.transformControls.getHelper());
      this.transformControls.attach(this.transformProxy);
      this.transformControls.getHelper().visible = true;
      this.setTool(this.tool);
    }
    this.setStatus(`Selected ${entries.length} model${entries.length === 1 ? '' : 's'}`);
    this.onSelectionChanged?.(true);
  }

  /** Drop every selected active-plate instance independently onto canonical Z=0. */
  public dropSelectedToBed(): void {
    const selection = this.captureSelectedInstanceOrigins();
    if (!selection) {
      this.setStatus('Select a model instance to drop to the bed.');
      return;
    }
    const result = this.canonicalProject.dropInstancesToBed(selection.origins.map((origin) => origin.instanceId));
    this.syncTransformProxy();
    this.revalidatePublishedGcode();
    this.recomputePreflight();
    this.onSelectionTransformChanged?.();
    const moved = result.instances.filter((instance) => instance.deltaZMm !== 0).length;
    this.setStatus(
      moved === 0
        ? result.instances.length === 1
          ? 'The selected model is already on the bed.'
          : 'The selected models are already on the bed.'
        : `Dropped ${moved} model${moved === 1 ? '' : 's'} to the bed.`,
    );
  }

  public getSelectedModelPosition(): THREE.Vector3 | null {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    return instance ? new THREE.Vector3().fromArray(instance.transform.translationMm) : null;
  }
  public getSelectedModelRotation(): THREE.Euler | null {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    return instance
      ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(instance.transform.rotation))
      : null;
  }
  public getSelectedModelScale(): THREE.Vector3 | null {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    return instance ? new THREE.Vector3().fromArray(instance.transform.scale) : null;
  }
  public setSelectedModelPosition(x: number, y: number, z: number) {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    if (!selected || !instance) return;
    this.commitSelectedPrimaryTransform(
      {
        ...instance.transform,
        translationMm: [x, y, z],
      },
      'move',
    );
    this.syncTransformProxy();
    this.revalidatePublishedGcode();
    this.onSelectionTransformChanged?.();
  }
  public setSelectedModelRotation(x: number, y: number, z: number) {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    if (!selected || !instance) return;
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).normalize();
    this.commitSelectedPrimaryTransform(
      {
        ...instance.transform,
        rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      },
      'rotate',
    );
    this.syncTransformProxy();
    this.revalidatePublishedGcode();
    this.onSelectionTransformChanged?.();
  }
  public setSelectedModelScale(x: number, y: number, z: number) {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    if (!selected || !instance) return;
    this.commitSelectedPrimaryTransform(
      {
        ...instance.transform,
        scale: [x, y, z],
      },
      'scale',
    );
    this.syncTransformProxy();
    this.revalidatePublishedGcode();
    this.onSelectionTransformChanged?.();
  }

  public unselectModel() {
    this.canonicalProject.clearSelection();
    if (this.transformControls) {
      this.transformControls.detach();
      this.transformControls.getHelper().visible = false;
      this.remove(this.transformControls.getHelper());
      this.setStatus('Model unselected');
    }
    if (this.onSelectionChanged) this.onSelectionChanged(false);
  }

  private syncTransformProxy(): void {
    const selection = this.captureSelectedInstanceOrigins();
    if (!selection) return;
    if (selection.origins.length > 1) {
      const bounds = this.canonicalProject.getInstanceBounds(selection.origins.map((origin) => origin.instanceId));
      this.transformProxy.position.set(
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      );
      this.transformProxy.quaternion.identity();
      this.transformProxy.scale.setScalar(1);
    } else {
      const instance = this.canonicalProject.getInstance(selection.primaryInstanceId);
      if (!instance) return;
      this.transformProxy.position.fromArray(instance.transform.translationMm);
      this.transformProxy.quaternion.fromArray(instance.transform.rotation).normalize();
      this.transformProxy.scale.fromArray(instance.transform.scale);
    }
    this.transformProxy.updateMatrix();
    this.transformProxy.updateMatrixWorld(true);
  }

  private captureSelectedInstanceOrigins():
    | {
        readonly primaryInstanceId: InstanceId;
        readonly origins: readonly MultiInstanceTransformOrigin[];
      }
    | undefined {
    const summary = this.canonicalProject.getSummary();
    const primaryInstanceId = summary.primaryInstanceId;
    if (!primaryInstanceId) return undefined;
    const primary = this.canonicalProject.getInstance(primaryInstanceId);
    if (!primary) return undefined;
    const selectedIds = summary.selectedInstanceIds.includes(primaryInstanceId)
      ? summary.selectedInstanceIds
      : [primaryInstanceId];
    const origins = selectedIds.flatMap((instanceId) => {
      const instance = this.canonicalProject.getInstance(instanceId);
      return instance && instance.plateId === primary.plateId ? [{ instanceId, transform: instance.transform }] : [];
    });
    return origins.length > 0 ? { primaryInstanceId, origins: Object.freeze(origins) } : undefined;
  }

  private commitSelectedPrimaryTransform(currentPrimaryTransform: Transform, mode: MultiInstanceTransformMode): void {
    const selection = this.captureSelectedInstanceOrigins();
    if (!selection) return;
    if (selection.origins.length === 1) {
      this.canonicalProject.setInstanceTransform(selection.primaryInstanceId, currentPrimaryTransform);
      return;
    }
    this.canonicalProject.setInstanceTransforms(
      projectMultiInstancePrimaryTransform(
        selection.origins,
        selection.primaryInstanceId,
        currentPrimaryTransform,
        mode,
      ),
    );
  }

  private transformMode(): MultiInstanceTransformMode {
    return this.tool === 'rotate' ? 'rotate' : this.tool === 'scale' ? 'scale' : 'move';
  }

  private setupSelectionRaycaster(canvas: HTMLCanvasElement) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0,
      downY = 0;

    const pointerRay = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, xb.core.camera);
      return raycaster;
    };

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      if (this.tool !== 'paint' || xb.core.renderer.xr.isPresenting || event.button !== 0) return;
      if (this.beginPaintStroke(pointerRay(event), event.pointerId)) {
        // A paint gesture owns the pointer: orbiting would fight the stroke.
        if (this.orbitControls) this.orbitControls.enabled = false;
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.paintStroke || event.pointerId !== this.paintStroke.pointerId) return;
      const [hit] = pointerRay(event).intersectObject(this.paintStroke.display, false);
      if (hit) this.samplePaintStroke(hit);
    };

    const finishPaintGesture = (event: PointerEvent, cancelled: boolean) => {
      if (!this.paintStroke || event.pointerId !== this.paintStroke.pointerId) return false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (cancelled) this.cancelPaintStroke();
      else this.endPaintStroke();
      if (this.orbitControls) this.orbitControls.enabled = true;
      return true;
    };

    const onPointerUp = (event: PointerEvent) => {
      if (finishPaintGesture(event, false)) return;
      if (xb.core.renderer.xr.isPresenting) return;
      if (this.tool === 'paint') return;
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
          this.selectModel(entry, event.shiftKey || event.ctrlKey || event.metaKey);
          break;
        }
      }

      if (!hitModel) {
        this.unselectModel();
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      finishPaintGesture(event, true);
    };
    const onPaintEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !this.paintStroke) return;
      this.cancelPaintStroke();
      if (this.orbitControls) this.orbitControls.enabled = true;
      this.setStatus('Paint stroke cancelled.');
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onPaintEscape);
    this.lifecycleDisposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onPaintEscape);
    });
  }

  private tool: WorkspaceGizmoTool = 'move';
  /** The set of filament slots — shared by paint, 3MF display, and slicing. */
  public palette = new FilamentPalette();
  /** Virtual (mixed) filaments adopted from the loaded FullSpectrum 3MF —
   *  read-only in the UI; their display colors match the desktop app. */
  public virtualFilaments: VirtualFilament[] = [];
  /** Prime/purge tower setup adopted from the loaded 3MF (null = none). */
  private projectPrimeTower: ProjectPrimeTower | null = null;
  private wipeTowerGhost: THREE.Group | null = null;
  private headFilaments: HeadFilamentSelection[] = [];
  private headNozzles: string[] = [];
  private applyingProfile = false;
  private headsContainer: UIPanel | null = null;

  // ---------------------------------------------------------------------------
  // Canonical colour painting (P4.2–P4.4)
  // ---------------------------------------------------------------------------

  private paintServiceInstance: PaintStrokeService | null = null;
  private paintOverlays = new Map<VolumeId, THREE.Mesh>();
  private paintPreviewOverlay: THREE.Mesh | null = null;
  private paintStroke: {
    volumeId: VolumeId;
    display: THREE.Mesh;
    triangles: Set<number>;
    previousLocal?: THREE.Vector3;
    pointerId: number;
  } | null = null;
  private paintSettings: PaintToolSettings = { tool: 'circle', radiusMm: 4, smartFillAngleDegrees: 30 };
  private paintFilamentId: FilamentId | undefined;
  private paintMode: 'paint' | 'erase' = 'paint';

  private get paintService(): PaintStrokeService {
    if (!this.paintServiceInstance) this.paintServiceInstance = this.canonicalProject.createPaintStrokeService();
    return this.paintServiceInstance;
  }

  /** Read-only painted-facet total for diagnostics, automation, and E2E. */
  public getPaintedFacetCount(plateId?: PlateId): number {
    let total = 0;
    for (const assignments of this.canonicalProject.getColorFacetsByVolume(plateId ?? this.activePlateId).values()) {
      for (const assignment of assignments) total += assignment.triangles.length;
    }
    return total;
  }

  /** Palette rows for paint surfaces; every row carries a stable identity. */
  public getPaintPalette(includeUnavailable = false): PaintPalette {
    return this.canonicalProject.getPaintPalette({ includeUnavailable });
  }

  public getPaintToolState(): {
    readonly settings: PaintToolSettings;
    readonly filamentId?: FilamentId;
    readonly mode: 'paint' | 'erase';
    readonly active: boolean;
  } {
    return Object.freeze({
      settings: Object.freeze({ ...this.paintSettings }),
      ...(this.paintFilamentId ? { filamentId: this.paintFilamentId } : {}),
      mode: this.paintMode,
      active: this.tool === 'paint',
    });
  }

  /** Choose the stable filament a stroke assigns; `undefined` erases. */
  public setPaintFilament(filamentId: FilamentId | undefined): void {
    if (filamentId) {
      const entry = this.getPaintPalette(true).entries.find(
        (candidate: PaintPalette['entries'][number]) => candidate.filamentId === filamentId,
      );
      if (!entry) {
        this.setStatus('That filament is not in this project.');
        return;
      }
      if (!entry.selectable) {
        this.setStatus(entry.unavailableReason ?? 'That filament cannot be painted.');
        return;
      }
      this.paintFilamentId = filamentId;
      this.paintMode = 'paint';
      this.setStatus(`Paint colour: ${entry.name}`);
    } else {
      this.paintFilamentId = undefined;
      this.paintMode = 'erase';
      this.setStatus('Paint colour: erase to default');
    }
    this.onPaintStateChanged?.();
  }

  /** Select a palette row by its displayed `1`–`9` shortcut. */
  public setPaintFilamentByNumber(keyboardNumber: number): boolean {
    const entry = this.getPaintPalette().entries.find(
      (candidate: PaintPalette['entries'][number]) => candidate.keyboardNumber === keyboardNumber,
    );
    if (!entry?.filamentId) return false;
    this.setPaintFilament(entry.filamentId);
    return true;
  }

  public setPaintTool(tool: PaintToolKind): void {
    this.paintSettings = { ...this.paintSettings, tool };
    this.setStatus(`Paint tool: ${tool}`);
    this.onPaintStateChanged?.();
  }

  public setPaintSettings(settings: Partial<PaintToolSettings>): void {
    this.paintSettings = { ...this.paintSettings, ...settings };
    this.onPaintStateChanged?.();
  }

  public setPaintMode(mode: 'paint' | 'erase'): void {
    this.paintMode = mode;
    this.onPaintStateChanged?.();
  }

  /** Erase every colour facet on the selected volumes ("Erase all"). */
  public eraseAllPaint(): number {
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length === 0) {
      this.setStatus('Select a model to erase its colour painting.');
      return 0;
    }
    let cleared = 0;
    for (const volumeId of volumes) {
      const result = this.paintService.clearVolume(volumeId);
      if (result.status === 'applied') cleared += 1;
    }
    this.refreshPaintOverlays();
    this.setStatus(cleared > 0 ? `Erased colour painting on ${cleared} part(s).` : 'Nothing was painted.');
    return cleared;
  }

  /** Volumes the current selection paints, defaulting to the whole plate. */
  private paintableSelectedVolumes(): VolumeId[] {
    const selected = new Set(
      this.canonicalProject
        .getObjectsTree()
        .selection.refs.filter((ref) => ref.kind === 'volume')
        .map((ref) => ref.id as VolumeId),
    );
    const objectIds = new Set(
      this.canonicalProject
        .getObjectsTree()
        .selection.refs.filter((ref) => ref.kind === 'object')
        .map((ref) => ref.id),
    );
    const volumes: VolumeId[] = [];
    for (const record of this.paintTargets()) {
      if (
        selected.has(record.volumeId) ||
        objectIds.has(record.objectId) ||
        (selected.size === 0 && objectIds.size === 0)
      ) {
        volumes.push(record.volumeId);
      }
    }
    return [...new Set(volumes)];
  }

  /** Every rendered volume mesh on the active plate, with canonical identity. */
  private paintTargets(): { volumeId: VolumeId; objectId: ObjectId; display: THREE.Mesh }[] {
    const targets: { volumeId: VolumeId; objectId: ObjectId; display: THREE.Mesh }[] = [];
    for (const viewer of this.canonicalProject.surface.root.children) {
      const instance = getThreeProjectEntity(viewer);
      if (!instance || instance.kind !== 'instance' || instance.plateId !== this.activePlateId) continue;
      for (const child of viewer.children) {
        const entity = getThreeProjectEntity(child);
        if (!(child instanceof THREE.Mesh) || entity?.kind !== 'volume' || !entity.volumeId) continue;
        targets.push({ volumeId: entity.volumeId, objectId: instance.objectId, display: child });
      }
    }
    return targets;
  }

  /** Begin a paint gesture at this canvas ray, if it hits a paintable part. */
  private beginPaintStroke(raycaster: THREE.Raycaster, pointerId: number): boolean {
    const targets = this.paintTargets();
    for (const target of targets) {
      const [hit] = raycaster.intersectObject(target.display, false);
      if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) continue;
      this.paintStroke = {
        volumeId: target.volumeId,
        display: target.display,
        triangles: new Set<number>(),
        pointerId,
      };
      this.samplePaintStroke(hit);
      return true;
    }
    return false;
  }

  /** Accumulate one pointer sample without touching canonical state. */
  private samplePaintStroke(hit: THREE.Intersection): void {
    const stroke = this.paintStroke;
    if (!stroke || hit.faceIndex === undefined || hit.faceIndex === null) return;
    const local = stroke.display.worldToLocal(hit.point.clone());
    const camera = stroke.display.worldToLocal(xb.core.camera.getWorldPosition(new THREE.Vector3()));
    try {
      const preview = this.paintService.previewStroke({
        hit: {
          volumeId: stroke.volumeId,
          triangleIndex: hit.faceIndex,
          localPoint: [local.x, local.y, local.z],
          localCameraPosition: [camera.x, camera.y, camera.z],
          ...(stroke.previousLocal
            ? { previousLocalPoint: [stroke.previousLocal.x, stroke.previousLocal.y, stroke.previousLocal.z] as const }
            : {}),
          plateZMm: local.z,
        },
        settings: this.paintSettings,
        ...(this.paintMode === 'paint' && this.paintFilamentId ? { filamentId: this.paintFilamentId } : {}),
        mode: this.paintMode,
      });
      for (const triangle of preview.triangleIndices) stroke.triangles.add(triangle);
      stroke.previousLocal = local;
      this.renderPaintPreview(stroke.display, stroke.triangles);
    } catch (error) {
      this.setStatus(`Paint failed: ${(error as Error).message}`);
      this.cancelPaintStroke();
    }
  }

  /** Commit the accumulated gesture as exactly one undoable stroke. */
  private endPaintStroke(): void {
    const stroke = this.paintStroke;
    this.paintStroke = null;
    this.clearPaintPreview();
    if (!stroke || stroke.triangles.size === 0) return;
    try {
      const result = this.paintService.commitTriangles({
        volumeId: stroke.volumeId,
        triangleIndices: [...stroke.triangles].sort((left, right) => left - right),
        ...(this.paintMode === 'paint' && this.paintFilamentId ? { filamentId: this.paintFilamentId } : {}),
        mode: this.paintMode,
      });
      if (result.status === 'applied') {
        this.setStatus(this.paintMode === 'erase' ? 'Erased colour facets.' : 'Painted colour facets.');
      }
    } catch (error) {
      this.setStatus(`Paint failed: ${(error as Error).message}`);
    }
    this.refreshPaintOverlays();
  }

  private cancelPaintStroke(): void {
    this.paintStroke = null;
    this.clearPaintPreview();
  }

  /** Rebuild every derived colour overlay from canonical annotations. */
  public refreshPaintOverlays(): void {
    if (this.disposed) return;
    const facets = this.canonicalProject.getColorFacetsByVolume(this.activePlateId);
    const colors = paintPaletteColors(this.getPaintPalette(true));
    const live = new Set<VolumeId>();
    for (const target of this.paintTargets()) {
      const assignments = facets.get(target.volumeId);
      const existing = this.paintOverlays.get(target.volumeId);
      if (!assignments || assignments.length === 0) {
        if (existing) this.disposeOverlay(target.volumeId, existing);
        continue;
      }
      live.add(target.volumeId);
      const geometry = this.buildPaintOverlayGeometry(target.display, assignments, colors);
      if (!geometry) {
        if (existing) this.disposeOverlay(target.volumeId, existing);
        continue;
      }
      if (existing) {
        existing.geometry.dispose();
        existing.geometry = geometry;
        if (existing.parent !== target.display) target.display.add(existing);
      } else {
        const overlay = new THREE.Mesh(geometry, PAINT_OVERLAY_MATERIAL.clone());
        overlay.name = 'paint-overlay';
        overlay.raycast = () => {};
        overlay.renderOrder = 2;
        target.display.add(overlay);
        this.paintOverlays.set(target.volumeId, overlay);
      }
    }
    for (const [volumeId, overlay] of [...this.paintOverlays]) {
      if (!live.has(volumeId)) this.disposeOverlay(volumeId, overlay);
    }
  }

  private disposeOverlay(volumeId: VolumeId, overlay: THREE.Mesh): void {
    overlay.removeFromParent();
    overlay.geometry.dispose();
    (overlay.material as THREE.Material).dispose();
    this.paintOverlays.delete(volumeId);
  }

  private buildPaintOverlayGeometry(
    display: THREE.Mesh,
    assignments: readonly { triangles: number[]; value: FilamentId }[],
    colors: ReadonlyMap<FilamentId, string>,
  ): THREE.BufferGeometry | null {
    const source = display.geometry;
    const position = source.getAttribute('position');
    const index = source.getIndex();
    if (!position || !index) return null;
    const triangles: { triangle: number; color: THREE.Color }[] = [];
    for (const assignment of assignments) {
      const color = new THREE.Color(colors.get(assignment.value) ?? '#ffffff');
      for (const triangle of assignment.triangles) triangles.push({ triangle, color });
    }
    if (triangles.length === 0) return null;
    const positions = new Float32Array(triangles.length * 9);
    const vertexColors = new Float32Array(triangles.length * 9);
    triangles.forEach(({ triangle, color }, slot) => {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index.getX(triangle * 3 + corner);
        const offset = slot * 9 + corner * 3;
        positions[offset] = position.getX(vertex);
        positions[offset + 1] = position.getY(vertex);
        positions[offset + 2] = position.getZ(vertex);
        vertexColors[offset] = color.r;
        vertexColors[offset + 1] = color.g;
        vertexColors[offset + 2] = color.b;
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  /** Show the in-flight selection before it becomes a canonical command. */
  private renderPaintPreview(display: THREE.Mesh, triangles: ReadonlySet<number>): void {
    this.clearPaintPreview();
    if (triangles.size === 0) return;
    const previewColor =
      this.paintMode === 'erase'
        ? '#ffffff'
        : this.paintFilamentId
          ? (paintPaletteColors(this.getPaintPalette(true)).get(this.paintFilamentId) ?? '#ffffff')
          : '#ffffff';
    const geometry = this.buildPaintOverlayGeometry(
      display,
      [{ triangles: [...triangles], value: 'preview' as unknown as FilamentId }],
      new Map([['preview' as unknown as FilamentId, previewColor]]),
    );
    if (!geometry) return;
    const preview = new THREE.Mesh(geometry, PAINT_PREVIEW_MATERIAL.clone());
    preview.name = 'paint-preview';
    preview.raycast = () => {};
    preview.renderOrder = 3;
    display.add(preview);
    this.paintPreviewOverlay = preview;
  }

  private clearPaintPreview(): void {
    if (!this.paintPreviewOverlay) return;
    this.paintPreviewOverlay.removeFromParent();
    this.paintPreviewOverlay.geometry.dispose();
    (this.paintPreviewOverlay.material as THREE.Material).dispose();
    this.paintPreviewOverlay = null;
  }

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

  public getHeadFilament(index: number): string {
    return this.headFilaments[index]?.name ?? '';
  }

  public getHeadFilamentPresetId(index: number): WorkspacePresetId | undefined {
    return this.headFilaments[index]?.presetId;
  }

  public getHeadNozzle(index: number): string {
    return this.headNozzles[index] ?? '0.4';
  }

  public setHeadFilament(index: number, filament: string): void {
    const option = this.getProfileOptions().filamentOptions.find(
      (candidate) => candidate.name === filament || candidate.label === filament,
    );
    if (!option) {
      this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [`Filament preset ${JSON.stringify(filament)} is unavailable for the active printer and process.`],
      });
      return;
    }
    this.setHeadFilamentPreset(index, option.id);
  }

  public setHeadFilamentPreset(index: number, filamentPresetId: WorkspacePresetId): void {
    if (index < 0 || index >= this.headFilaments.length) return;
    if (this.headFilaments[index]?.presetId === filamentPresetId) return;
    const filamentPresetIds = this.headFilaments.map((selection) => selection.presetId);
    filamentPresetIds[index] = filamentPresetId;
    this.selectProfilePresets({ filamentPresetIds });
  }

  public setHeadNozzle(index: number, nozzle: string): void {
    if (index < 0 || index >= this.headNozzles.length || this.headNozzles[index] === nozzle) return;
    this.headNozzles[index] = nozzle;
    this.applyLiveSlicingConfiguration();
    this.recomputePreflight();
    this.rebuildHeadsPanel();
  }

  public addFilamentSlot(): void {
    if (this.palette.count() >= 16) {
      this.setStatus('The 16-slot filament limit has been reached.');
      return;
    }
    this.headFilaments.push(this.headSelectionFromProfile(this.profile));
    this.headNozzles.push(profileNozzleForTool(this.profile, this.headNozzles.length));
    this.palette.add();
    this.applyLiveSlicingConfiguration();
    this.rebuildHeadsPanel();
    this.onProfileChanged?.();
  }

  public removeAuxiliaryFilamentSlot(index: number): void {
    if (index < this.extruderCount || index >= this.palette.count()) return;
    this.headFilaments.splice(index, 1);
    this.headNozzles.splice(index, 1);
    this.palette.remove(index);
    this.applyLiveSlicingConfiguration();
    this.rebuildHeadsPanel();
    this.onProfileChanged?.();
  }
  private drag: {
    controller: THREE.Object3D;
    entry: ProjectedModelEntry;
    startControllerLocal: THREE.Vector3;
    startTransform: Transform;
    gestureId: string;
  } | null = null;
  private readonly sceneGestureGuard = new SceneGestureGuard<unknown>();

  private controllerHitsUi(controller: unknown): boolean {
    const input = xb.core.input as unknown as {
      intersectionsForController: Map<unknown, THREE.Intersection[]>;
    };
    const cards = new Set<THREE.Object3D>(this.uiCore.cards);
    return (input.intersectionsForController.get(controller) ?? []).some((intersection) => {
      let object: THREE.Object3D | null = intersection.object;
      while (object) {
        if (cards.has(object)) return true;
        object = object.parent;
      }
      return false;
    });
  }

  /** Modal manipulation: a pinch that lands anywhere on the model starts
   *  a drag whose meaning is the active tool (OrcaSlicer-style). */
  onSelectStart(event: { target: unknown }) {
    const input = xb.core.input as unknown as {
      intersectionsForController: Map<unknown, THREE.Intersection[]>;
    };
    const ints = input.intersectionsForController.get(event.target) ?? [];

    if (this.drag?.controller === event.target) this.drag = null;
    // A select that lands on UI owns the complete gesture. Remember that
    // decision so later `selecting` frames cannot paint/manipulate through the
    // card after doing their own model-only raycast.
    if (!this.sceneGestureGuard.begin(event.target, this.controllerHitsUi(event.target))) return;

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

    const controller = event.target as THREE.Object3D;
    this.selectModel(entry);
    const instance = this.canonicalProject.getInstance(entry.instanceId);
    if (!instance) return;
    this.transformGestureSequence += 1;
    const startControllerLocal = this.workspace.worldToLocal(controller.getWorldPosition(new THREE.Vector3()));
    this.drag = {
      controller,
      entry,
      startControllerLocal,
      startTransform: instance.transform,
      gestureId: `xr-transform:${this.transformGestureSequence}`,
    };
  }

  onSelecting(event: { target: unknown }) {
    if (!this.sceneGestureGuard.allow(event.target, this.controllerHitsUi(event.target))) return;

    const d = this.drag;
    if (!d || event.target !== d.controller) return;
    const entry = d.entry;
    if (!this.models.includes(entry)) return;
    const local = this.workspace.worldToLocal(d.controller.getWorldPosition(new THREE.Vector3()));
    const delta = local.clone().sub(d.startControllerLocal);
    const printerDelta = new THREE.Vector3(
      delta.x / CURRENT_THREE_WORLD_UNITS_PER_MM,
      -delta.z / CURRENT_THREE_WORLD_UNITS_PER_MM,
      delta.y / CURRENT_THREE_WORLD_UNITS_PER_MM,
    );
    let next: Transform | undefined;
    if (this.tool === 'move') {
      next = {
        ...d.startTransform,
        translationMm: [
          THREE.MathUtils.clamp(d.startTransform.translationMm[0] + printerDelta.x, 0, this.bedMm.x),
          THREE.MathUtils.clamp(d.startTransform.translationMm[1] + printerDelta.y, 0, this.bedMm.y),
          Math.max(0, d.startTransform.translationMm[2] + printerDelta.z),
        ],
      };
      this.showValues(`x ${next.translationMm[0].toFixed(1)}  y ${next.translationMm[1].toFixed(1)} mm`);
    } else if (this.tool === 'rotate') {
      // Horizontal hand sweep = yaw: 25 cm of travel = a full turn.
      const angle = (delta.x / 0.25) * Math.PI * 2;
      const rotation = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle)
        .multiply(new THREE.Quaternion().fromArray(d.startTransform.rotation))
        .normalize();
      next = {
        ...d.startTransform,
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      };
      this.showValues(`rotZ ${THREE.MathUtils.radToDeg(angle).toFixed(0)}°`);
    } else if (this.tool === 'scale') {
      // Vertical hand travel = scale: +25 cm doubles, −25 cm halves.
      const f = Math.pow(2, delta.y / 0.25);
      const sNew = THREE.MathUtils.clamp(d.startTransform.scale[0] * f, 0.05, 20);
      next = { ...d.startTransform, scale: [sNew, sNew, sNew] };
      this.showValues(`scale ${(sNew * 100).toFixed(0)}%`);
    }
    if (next) this.canonicalProject.setInstanceTransform(entry.instanceId, next, d.gestureId);
  }

  /** After any drag ends, keep models seated on the plate and inside it. */
  onSelectEnd(event?: { target: unknown }) {
    if (event) this.sceneGestureGuard.end(event.target);
    else this.sceneGestureGuard.clear();
    const endedDrag = this.drag;
    if (!endedDrag || (event && event.target !== endedDrag.controller)) return;
    this.drag = null;
    this.recomputePreflight();
  }

  /** Complete printers in deterministic catalog order, keyed by canonical graph ID. */
  private machinePresetChoices(): WorkspacePresetOption[] {
    const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
    for (const profile of this.catalog.profiles) {
      if (!profile.machinePresetId || choices.has(profile.machinePresetId)) continue;
      choices.set(
        profile.machinePresetId,
        Object.freeze({
          id: profile.machinePresetId,
          name: profile.machineName,
          label: profile.machineName,
        }),
      );
    }
    return disambiguatePresetOptionLabels([...choices.values()]);
  }

  /** Compatibility-filtered processes for one exact printer preset. */
  private processPresetChoices(machinePresetId: WorkspacePresetId | undefined): WorkspacePresetOption[] {
    if (!machinePresetId) return [];
    const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
    for (const profile of this.catalog.profiles) {
      if (
        profile.machinePresetId !== machinePresetId ||
        !profile.processPresetId ||
        choices.has(profile.processPresetId)
      ) {
        continue;
      }
      choices.set(
        profile.processPresetId,
        Object.freeze({
          id: profile.processPresetId,
          name: profile.processName,
          label: profile.processName,
        }),
      );
    }
    return disambiguatePresetOptionLabels([...choices.values()]);
  }

  /** Compatibility-filtered filaments for one exact printer/process pair. */
  private filamentPresetChoices(
    machinePresetId: WorkspacePresetId | undefined,
    processPresetId: WorkspacePresetId | undefined,
  ): WorkspacePresetOption[] {
    if (!machinePresetId || !processPresetId) return [];
    const choices = new Map<WorkspacePresetId, WorkspacePresetOption>();
    for (const profile of this.catalog.profiles) {
      if (
        profile.machinePresetId !== machinePresetId ||
        profile.processPresetId !== processPresetId ||
        !profile.filamentPresetId ||
        choices.has(profile.filamentPresetId)
      ) {
        continue;
      }
      choices.set(
        profile.filamentPresetId,
        Object.freeze({
          id: profile.filamentPresetId,
          name: profile.filamentPresetName ?? profile.filamentName,
          label: profile.filamentName,
        }),
      );
    }
    return disambiguatePresetOptionLabels([...choices.values()]);
  }

  private applyCatalogDefaultProfile(): void {
    if (this.profile || this.projectImportInProgress || this.importedProjectOwnsSlicingConfiguration) return;
    const fallback =
      this.catalog.find('Snapmaker U1 (0.4 nozzle)', '0.20 Standard', 'Snapmaker PLA') ??
      this.catalog.profiles[0] ??
      null;
    if (!fallback) return;
    if (fallback.machinePresetId && fallback.processPresetId && fallback.filamentPresetId) {
      this.selectProfilePresets({
        machinePresetId: fallback.machinePresetId,
        processPresetId: fallback.processPresetId,
        filamentPresetIds: [fallback.filamentPresetId],
      });
    } else {
      this.setProfile(fallback);
    }
  }

  /** Snapshot for pickers: current selection + available choices. */
  getProfileOptions() {
    const cur = this.profile;
    const machinePresetId = cur?.machinePresetId;
    const processPresetId = cur?.processPresetId;
    const machineOptions = this.machinePresetChoices();
    const processOptions = this.processPresetChoices(machinePresetId);
    const filamentOptions = this.filamentPresetChoices(machinePresetId, processPresetId);
    return {
      machine: cur?.machineName ?? '',
      process: cur?.processName ?? '',
      filament: cur?.filamentName ?? '',
      machinePresetId,
      processPresetId,
      filamentPresetIds: Object.freeze(this.headFilaments.map((selection) => selection.presetId)),
      machineOptions: Object.freeze(machineOptions),
      processOptions: Object.freeze(processOptions),
      filamentOptions: Object.freeze(filamentOptions),
      machines: machineOptions.map((choice) => choice.label),
      processes: processOptions.map((choice) => choice.label),
      filaments: filamentOptions.map((choice) => choice.label),
      unavailableReasons: Object.freeze(
        this.catalog.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.message),
      ),
    };
  }

  /** Process + filament choices for an arbitrary machine (setup wizard). */
  choicesForMachine(machine: string, process = '') {
    const machineOption = matchPresetOption(this.machinePresetChoices(), machine);
    const processOptions = this.processPresetChoices(machineOption?.id);
    const processOption = matchPresetOption(processOptions, process) ?? processOptions[0];
    const filamentOptions = this.filamentPresetChoices(machineOption?.id, processOption?.id);
    return {
      processPresetId: processOption?.id,
      processOptions: Object.freeze(processOptions),
      filamentOptions: Object.freeze(filamentOptions),
      processes: processOptions.map((choice) => choice.label),
      filaments: filamentOptions.map((choice) => choice.label),
    };
  }

  /** Legacy name adapter. Exact scoped matches reconcile through stable IDs. */
  setProfileByNames(machine: string, process: string, filament: string) {
    const machineOption = machine.trim() ? matchPresetOption(this.machinePresetChoices(), machine) : undefined;
    if (machine.trim() && !machineOption) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [`Printer preset ${JSON.stringify(machine)} is unavailable.`],
      });
    }
    const machinePresetId = machineOption?.id ?? this.profile?.machinePresetId;
    const processOptions = this.processPresetChoices(machinePresetId);
    const processOption = process.trim() ? matchPresetOption(processOptions, process) : undefined;
    if (process.trim() && !processOption) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [`Process preset ${JSON.stringify(process)} is unavailable for the selected printer.`],
      });
    }
    const processPresetId = processOption?.id ?? this.profile?.processPresetId;
    const filamentOptions = this.filamentPresetChoices(machinePresetId, processPresetId);
    const filamentOption = filament.trim() ? matchPresetOption(filamentOptions, filament) : undefined;
    if (filament.trim() && !filamentOption) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [`Filament preset ${JSON.stringify(filament)} is unavailable for the selected printer and process.`],
      });
    }
    const filamentPresetIds = this.headFilaments.map((selection) => selection.presetId);
    if (filamentOption) filamentPresetIds[0] = filamentOption.id;
    return this.selectProfilePresets({
      ...(machinePresetId ? { machinePresetId } : {}),
      ...(processPresetId ? { processPresetId } : {}),
      filamentPresetIds,
    });
  }

  /** Fires whenever the active profile changes (2D pickers re-render). */
  public onProfileChanged: (() => void) | null = null;
  /** Reconciliation feedback for DOM/XR substitution and unavailable notices. */
  public onProfileSelectionResult: ((feedback: WorkspaceProfileSelectionFeedback) => void) | null = null;
  public onRequestNewProjectConfirmation: ((dirty: boolean) => boolean | Promise<boolean>) | null = null;
  /** Composition-root review of the canonical object and every affected instance. */
  public onRequestSplitToObjectsConfirmation:
    ((confirmation: CanonicalSplitToObjectsConfirmation) => boolean | Promise<boolean>) | null = null;

  /** Cycle one dimension of the profile triple (public: panel + tests). */
  cycleProfilePart(part: 'machine' | 'process' | 'filament') {
    const current = this.getProfileOptions();
    if (!current.machinePresetId || !current.processPresetId) return;
    const cycle = (list: readonly WorkspacePresetOption[], id: WorkspacePresetId | undefined) => {
      const index = list.findIndex((choice) => choice.id === id);
      return list[index < 0 ? 0 : (index + 1) % list.length];
    };
    if (part === 'machine') {
      const next = cycle(current.machineOptions, current.machinePresetId);
      if (next) this.selectProfilePresets({ machinePresetId: next.id });
    } else if (part === 'process') {
      const next = cycle(current.processOptions, current.processPresetId);
      if (next) this.selectProfilePresets({ processPresetId: next.id });
    } else {
      const next = cycle(current.filamentOptions, current.filamentPresetIds[0]);
      if (!next) return;
      const filamentPresetIds = [...current.filamentPresetIds];
      filamentPresetIds[0] = next.id;
      this.selectProfilePresets({ filamentPresetIds });
    }
  }

  /**
   * Reconcile exact graph identities and commit only a complete
   * printer/process/all-slot result. Compatible process and filament choices
   * survive printer/process changes; resolver substitutions are reported.
   */
  public selectProfilePresets(request: WorkspaceProfileSelectionRequest): WorkspaceProfileSelectionFeedback {
    const machinePresetId = request.machinePresetId ?? this.profile?.machinePresetId;
    if (!machinePresetId) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: ['Choose an available printer before selecting process or filament presets.'],
      });
    }
    const processPresetId = request.processPresetId ?? this.profile?.processPresetId;
    const filamentPresetIds = request.filamentPresetIds ?? this.headFilaments.map((selection) => selection.presetId);
    const resolution = this.catalog.reconcileSelection({
      printerId: machinePresetId,
      ...(processPresetId ? { processId: processPresetId } : {}),
      filamentIds: filamentPresetIds,
    });
    if (!resolution.selection) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [resolution.unavailableReason ?? 'The requested profile selection is unavailable.'],
      });
    }

    const resolved = resolution.selection;
    const messages = this.profileReconciliationMessages(resolved);
    if (!resolved.complete || !resolved.process || resolved.filaments.some((filament) => !filament)) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages:
          messages.length > 0
            ? messages
            : ['No complete compatible process and filament selection exists for this printer.'],
      });
    }

    const profiles = resolved.filaments.map((filament) =>
      filament
        ? this.catalog.profiles.find(
            (profile) =>
              profile.machinePresetId === resolved.printer.id &&
              profile.processPresetId === resolved.process?.id &&
              profile.filamentPresetId === filament.id,
          )
        : undefined,
    );
    const primary = profiles[0];
    if (!primary || profiles.some((profile) => !profile)) {
      return this.publishProfileSelectionFeedback({
        applied: false,
        severity: 'error',
        messages: [
          'The resolver produced a combination that is absent from the validated slicing catalog; the prior selection was preserved.',
        ],
      });
    }

    this.applyResolvedProfile(
      primary,
      profiles.map((profile) => this.headSelectionFromProfile(profile)),
    );
    return this.publishProfileSelectionFeedback({
      applied: true,
      severity: messages.length > 0 ? 'warning' : 'info',
      messages: messages.length > 0 ? messages : ['Profile selection is compatible.'],
    });
  }

  private profileReconciliationMessages(
    resolved: NonNullable<ReturnType<ProfileCatalog['reconcileSelection']>['selection']>,
  ): string[] {
    const messages: string[] = [];
    for (const substitution of resolved.substitutions) {
      const nextName = substitution.nextId ? this.presetDisplayName(substitution.kind, substitution.nextId) : undefined;
      const previousName = substitution.previousId
        ? this.presetDisplayName(substitution.kind, substitution.previousId)
        : undefined;
      if (substitution.kind === 'process') {
        if (nextName) {
          messages.push(
            previousName
              ? `${previousName} is unavailable for ${resolved.printer.name}; substituted ${nextName}.`
              : `Selected ${nextName} for ${resolved.printer.name}.`,
          );
        } else {
          messages.push(`No compatible process preset is available for ${resolved.printer.name}.`);
        }
        continue;
      }
      const slot = `Filament slot ${(substitution.slot ?? 0) + 1}`;
      if (nextName) {
        messages.push(
          previousName
            ? `${slot}: ${previousName} is unavailable for ${resolved.printer.name} / ${resolved.process?.name ?? 'the selected process'}; substituted ${nextName}.`
            : `${slot}: selected ${nextName}.`,
        );
      } else {
        messages.push(
          `${slot}: no compatible filament preset is available for ${resolved.printer.name} / ${resolved.process?.name ?? 'the selected process'}.`,
        );
      }
    }
    messages.push(...resolved.diagnostics.map((diagnostic) => diagnostic.message));
    return [...new Set(messages)];
  }

  private presetDisplayName(kind: 'process' | 'filament', id: WorkspacePresetId): string {
    const profile = this.catalog.profiles.find((candidate) =>
      kind === 'process' ? candidate.processPresetId === id : candidate.filamentPresetId === id,
    );
    if (!profile) return 'The previous preset';
    return kind === 'process' ? profile.processName : (profile.filamentPresetName ?? profile.filamentName);
  }

  private publishProfileSelectionFeedback(
    feedback: WorkspaceProfileSelectionFeedback,
  ): WorkspaceProfileSelectionFeedback {
    const frozen = Object.freeze({
      ...feedback,
      messages: Object.freeze([...feedback.messages]),
    });
    if (feedback.severity !== 'info') this.setStatus(feedback.messages.join('\n'));
    this.onProfileSelectionResult?.(frozen);
    return frozen;
  }

  public setProfile(p: SlicerProfile) {
    this.applyResolvedProfile(p, []);
  }

  private applyResolvedProfile(p: SlicerProfile, resolvedHeads: readonly HeadFilamentSelection[]) {
    this.importedProjectOwnsSlicingConfiguration = false;
    this.applyingProfile = true;
    try {
      this.profile = p;
      const count = this.extruderCount;

      // Ensure palette has at least 'count' slots.
      while (this.palette.count() < count) this.palette.add();

      const totalSlots = this.palette.count();
      this.headFilaments = Array.from(
        { length: totalSlots },
        (_, index) => resolvedHeads[index] ?? this.headSelectionFromProfile(p),
      );
      this.headNozzles = Array.from({ length: totalSlots }, (_, toolId) => profileNozzleForTool(p, toolId));
    } finally {
      this.applyingProfile = false;
    }
    this.applyLiveSlicingConfiguration();

    this.rebuildHeadsPanel();
    this.refreshXrProfileValues();

    if (this.onProfileChanged) this.onProfileChanged();
    this.bedMm = bedSizeFromProfile(p.config);
    this.rebuildPlate();
    this.rebuildWipeTowerGhost();
    this.setStatus(`profile: ${p.displayName}\nbed ${this.bedMm.x}×${this.bedMm.y} mm`);
    this.recomputePreflight();
  }

  private headSelectionFromProfile(profile: SlicerProfile | null | undefined): HeadFilamentSelection {
    if (!profile) return Object.freeze({ name: '' });
    return Object.freeze({
      ...(profile.filamentPresetId ? { presetId: profile.filamentPresetId } : {}),
      name: profile.filamentName,
    });
  }

  private exactCatalogPrimaryProfile(): SlicerProfile | undefined {
    const profile = this.profile;
    if (
      !profile?.machinePresetId ||
      !profile.processPresetId ||
      !profile.filamentPresetId ||
      !this.catalog.profiles.includes(profile)
    ) {
      return undefined;
    }
    return profile;
  }

  private exactLiveFilamentProfiles(toolCount: number): readonly (SlicerProfile | undefined)[] {
    const primary = this.exactCatalogPrimaryProfile();
    if (!primary?.machinePresetId || !primary.processPresetId) {
      return Object.freeze(new Array<SlicerProfile | undefined>(toolCount).fill(undefined));
    }
    return Object.freeze(
      Array.from({ length: toolCount }, (_, toolId) => {
        const filamentPresetId = this.headFilaments[toolId]?.presetId;
        if (!filamentPresetId) return undefined;
        return this.catalog.profiles.find(
          (candidate) =>
            candidate.machinePresetId === primary.machinePresetId &&
            candidate.processPresetId === primary.processPresetId &&
            candidate.filamentPresetId === filamentPresetId,
        );
      }),
    );
  }

  private createLiveProfilePreflight(): LiveProfileSlicePreflight {
    const toolCount = this.canonicalProject.getSlicingConfiguration().printer.toolCount;
    return new LiveProfileSlicePreflight(
      deriveLiveProfilePreflightConstraints({
        primaryProfile: this.exactCatalogPrimaryProfile(),
        filamentProfiles: this.exactLiveFilamentProfiles(toolCount),
        toolCount,
      }),
    );
  }

  /** Commit the exact profile/filament state consumed by canonical save and slice. */
  private applyLiveSlicingConfiguration(): void {
    const profile = this.profile;
    if (!profile || this.applyingProfile || this.disposed) return;
    this.synchronizeHeadSlotLengths();
    const slots = this.palette.list();
    const previous = this.canonicalProject.getSlicingConfiguration();
    const previousPhysicalByTool = new Map(previous.filaments.physical.map((filament) => [filament.toolId, filament]));
    const config = {
      ...profile.config,
      ...this.palette.toSlicerOverrides(),
      printer_settings_id: profile.machineName,
      print_settings_id: profile.processName,
    };
    const physical = slots.map((slot, index) => {
      const filamentSelection = this.headFilaments[index] ?? this.headSelectionFromProfile(profile);
      const filamentName = filamentSelection.name || profile.filamentName;
      const exactFilamentProfile =
        profile.machinePresetId && profile.processPresetId && filamentSelection.presetId
          ? this.catalog.profiles.find(
              (candidate) =>
                candidate.machinePresetId === profile.machinePresetId &&
                candidate.processPresetId === profile.processPresetId &&
                candidate.filamentPresetId === filamentSelection.presetId,
            )
          : undefined;
      const filamentProfile =
        exactFilamentProfile ?? this.catalog.find(profile.machineName, profile.processName, filamentName) ?? profile;
      const exactMaterial = exactFilamentProfile
        ? unambiguousProfileScalar(exactFilamentProfile.config['filament_type'])
        : undefined;
      const nozzle = Number(this.headNozzles[index] ?? '0.4');
      return {
        id:
          previousPhysicalByTool.get(index)?.id ??
          entityId<'physical-filament'>(`import:live:filament-slot-${index + 1}`),
        name: filamentName || `Filament ${index + 1}`,
        toolId: index,
        presetId: filamentSelection.presetId ?? (filamentName || undefined),
        material: (exactMaterial ?? slot.type) || 'Unknown',
        color: slot.color,
        ...(Number.isFinite(nozzle) && nozzle > 0 ? { nozzleDiameterMm: nozzle } : {}),
        config: { ...filamentProfile.config },
        enabled: true,
      };
    });
    const availableFilaments = new Set([
      ...physical.map((filament) => filament.id),
      ...previous.filaments.mixed.map((filament) => filament.id),
    ]);
    const orphanedComponent = previous.filaments.mixed
      .flatMap((filament) => filament.components)
      .find((component) => !availableFilaments.has(component.filamentId));
    if (orphanedComponent) {
      throw new Error(
        `The selected profile would orphan mixed-filament component ${orphanedComponent.filamentId}; remap it before changing profiles.`,
      );
    }
    this.canonicalProject.setSlicingConfiguration({
      printer: {
        profileId: profile.machineName,
        toolCount: Math.max(1, slots.length),
      },
      config,
      filaments: {
        physical,
        mixed: previous.filaments.mixed,
      },
    });
    this.bedMm = bedSizeFromProfile(profile.config);
    this.canonicalProject.setPrinterSpaceMapping({
      bedSizeMm: [this.bedMm.x, this.bedMm.y],
      worldUnitsPerMm: CURRENT_THREE_WORLD_UNITS_PER_MM,
    });
  }

  private synchronizePrinterMappingFromCanonicalConfig(): void {
    const printableArea = this.canonicalProject.getSlicingConfiguration().config.printable_area;
    const serialized =
      typeof printableArea === 'string'
        ? printableArea
        : Array.isArray(printableArea) && printableArea.every((value) => typeof value === 'string')
          ? printableArea.join(',')
          : '';
    this.bedMm = bedSizeFromProfile({ printable_area: serialized });
    this.canonicalProject.setPrinterSpaceMapping({
      bedSizeMm: [this.bedMm.x, this.bedMm.y],
      worldUnitsPerMm: CURRENT_THREE_WORLD_UNITS_PER_MM,
    });
    this.rebuildPlate();
    this.rebuildWipeTowerGhost();
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
      geo.dispose();
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
    this.addModelFromGeometry(raw, color, {}, url.split('/').pop() ?? 'Imported model');
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
  /** Composition-root confirmation for the immutable worker import preview. */
  onProjectImportPreview: ((preview: ProjectImportPreview) => Promise<ImportCommitConfirmation | null>) | null = null;
  /** Injected by main.ts: requests the browser to open the file picker. */
  onRequestLoadStl: (() => void) | null = null;
  /** Injected by main.ts: opens a .zip-filtered picker (Import Zip Archive). */
  onRequestLoadZip: (() => void) | null = null;
  /** Injected by main.ts: opens a .3mf picker for Open Project. */
  onRequestLoadProject: (() => void) | null = null;
  /** Injected by main.ts: opens a .json picker for Import Config. */
  onRequestLoadConfig: (() => void) | null = null;
  /** Injected by the live typed printer composition root. */
  onRequestPrinterConnectionTest: (() => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root. */
  onRequestPrinterFilamentInspection: (() => Promise<void>) | null = null;

  public async testPrinterConnection(): Promise<void> {
    if (!this.onRequestPrinterConnectionTest) {
      this.setStatus('Printer connection is unavailable in this shell.');
      return;
    }
    await this.onRequestPrinterConnectionTest();
  }

  public async inspectPrinterFilaments(): Promise<void> {
    if (!this.onRequestPrinterFilamentInspection) {
      this.setStatus('Printer filament inspection is unavailable in this shell.');
      return;
    }
    await this.onRequestPrinterFilamentInspection();
  }

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
   * Import one model source (STL, OBJ, AMF, or a ZIP of those) through the
   * canonical transactional route: signature-first decode, immutable preview,
   * explicit confirmation for anything repaired or dropped, then one undoable
   * command. A cancelled, malformed, or unsupported source leaves the project
   * untouched. Returns how many objects were added, or 0 when cancelled.
   */
  async importModelFile(name: string, bytes: ArrayBuffer | Uint8Array): Promise<number> {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (source.byteLength === 0) throw new Error(`${name} is empty.`);
    if (this.projectImportInProgress) throw new Error('Another import preview is already open.');
    this.projectImportInProgress = true;
    try {
      const before = new Set(this.projectedModels().map((entry) => entry.instanceId));
      const prepared = await this.canonicalProject.prepareModelImport(
        source,
        { filename: name },
        { placement: { bedSizeMm: [this.bedMm.x, this.bedMm.y], dropToBed: true } },
      );
      const preview = prepared.preview;
      let committed = false;
      try {
        if (preview.blocked) {
          const errors = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          throw new Error(
            `${name} cannot be imported: ${errors[0]?.message ?? 'the preview reported an unresolved problem'}`,
          );
        }
        if (preview.requiredAcknowledgementIds.length > 0) {
          // Repairs, conflicts, and dropped fields always need a human decision.
          const confirm = this.onProjectImportPreview;
          if (!confirm) throw new Error('This import changes or drops source data and needs a confirmation surface.');
          const decision = await confirm(preview);
          if (!decision) {
            this.setStatus('Import cancelled.');
            return 0;
          }
          prepared.confirm(decision);
        } else {
          prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] });
        }
        committed = true;
      } finally {
        if (!committed) prepared.cancel('model import did not commit');
      }

      const added = this.projectedModels().filter((entry) => !before.has(entry.instanceId));
      added.forEach((entry, index) => {
        if (this.wireframeOn) this.applyWireframe(entry, true);
        if (this.labelsOn) this.applyLabel(entry, this.models.length - added.length + index, true);
        if (this.overhangOn) this.applyOverhang(entry, true);
      });
      const last = added[added.length - 1];
      if (last) this.selectModel(last);
      this.recomputePreflight();
      this.warmSlicerAfterFirstModel();
      const objects = new Set(added.map((entry) => entry.objectId)).size;
      this.setStatus(`Imported ${name} — ${objects} object${objects === 1 ? '' : 's'}.`);
      return objects;
    } finally {
      this.projectImportInProgress = false;
    }
  }

  /**
   * Compatibility entry point for callers that import one model buffer.
   * Returns true when at least one object was added.
   */
  async loadModelFromBuffer(name: string, buf: ArrayBuffer): Promise<boolean> {
    return (await this.importModelFile(name, buf)) > 0;
  }

  /**
   * Import every supported model inside a .zip archive (Orca File → Import Zip
   * Archive) as one atomic transaction. Returns how many objects were added.
   */
  async importZipArchive(buf: ArrayBuffer, name = 'archive.zip'): Promise<number> {
    return this.importModelFile(name, buf);
  }

  /**
   * Load a model source by URL (tests + built-in samples). The bytes take the
   * same signature-first transactional route as a picked file, so a served
   * file never gets a second, more permissive decoder.
   */
  async loadModelFromUrl(url: string): Promise<void> {
    const t0 = performance.now();
    console.log('[orcaxr-load] fetching', url);
    const name = url.split('/').pop() ?? url;

    if (url.toLowerCase().endsWith('.3mf')) {
      throw new Error('3MF URLs must use the canonical project-open preview flow.');
    }
    this.setStatus(`Downloading ${name}...`);
    this.setProgress(10);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    this.setStatus(`Building scene...`);
    this.setProgress(90);
    await this.importModelFile(name, bytes);
    this.setProgress(undefined);
    console.log('[orcaxr-load] scene setup done at', Math.round(performance.now() - t0), 'ms');
  }

  /** Replace the current model with [raw] (STL geometry: mm, Z-up). */
  loadModelFromGeometry(raw: THREE.BufferGeometry, name: string, options: GeometryLoadOptions = {}) {
    this.library.push({ name, geometry: raw });
    this.libraryIndex = this.library.length - 1;
    this.addModelFromGeometry(raw, 0x4fc3f7, options, name);
    if (!options.deferPostAdd) this.setStatus(`Loaded ${name}.`);
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
    return this.canonicalProject.getSummary().plates.length;
  }
  public getPlates(): { id: PlateId; label: string; count: number; active: boolean }[] {
    return this.canonicalProject.getSummary().plates.map((plate) => ({
      id: plate.id,
      label: plate.name,
      count: plate.instanceCount,
      active: plate.active,
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
      placedModels: this.models.map((model, index) => {
        const instance = this.canonicalProject.getInstance(model.instanceId)!;
        const rotation = new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion().fromArray(instance.transform.rotation),
        );
        return {
          id: model.instanceId,
          label: instance.name || `Model ${index + 1}`,
          plateId: instance.plateId,
          translateXmm: instance.transform.translationMm[0],
          translateYmm: instance.transform.translationMm[1],
          translateZmm: instance.transform.translationMm[2],
          rotXDeg: THREE.MathUtils.radToDeg(rotation.x),
          rotYDeg: THREE.MathUtils.radToDeg(rotation.y),
          rotZDeg: THREE.MathUtils.radToDeg(rotation.z),
          scaleXPct: instance.transform.scale[0] * 100,
          scaleYPct: instance.transform.scale[1] * 100,
          scaleZPct: instance.transform.scale[2] * 100,
        };
      }),
    };
  }

  /** Create a new empty plate and switch to it. */
  public addPlate() {
    const id = this.canonicalProject.addPlate();
    this.setStatus(`Added ${this.canonicalProject.getSummary().plates.find((plate) => plate.id === id)?.name}.`);
    return id;
  }

  /** Duplicate one complete canonical plate graph and activate the copy. */
  public duplicatePlate(id: PlateId = this.activePlateId, expectedRevision?: number): PlateId {
    const duplicateId = this.canonicalProject.duplicatePlate(id, expectedRevision);
    this.revalidatePublishedGcode();
    this.onSelectionChanged?.(false);
    this.onPlatesChanged?.();
    const duplicate = this.canonicalProject.getSummary().plates.find((plate) => plate.id === duplicateId);
    this.setStatus(`Duplicated ${duplicate?.name ?? 'build plate'}.`);
    return duplicateId;
  }

  /** @deprecated Use duplicatePlate() with the displayed canonical revision. */
  public duplicateCurrentPlate(): PlateId {
    return this.duplicatePlate();
  }

  /** Switch the active plate; inactive plates' models are hidden, not removed. */
  public setActivePlate(id: PlateId, expectedRevision?: number) {
    const target = this.canonicalProject.getSummary().plates.find((plate) => plate.id === id);
    if (id === this.activePlateId) {
      this.canonicalProject.activatePlate(id, expectedRevision);
      this.onPlatesChanged?.();
      return;
    }
    this.canonicalProject.activatePlate(id, expectedRevision);
    this.setStatus(`Switched to ${target?.name ?? 'build plate'}.`);
    this.onSelectionChanged?.(false);
    this.onPlatesChanged?.();
  }

  /** Delete a plate (defaults to the active one); refuses the last plate. */
  public deletePlate(id: PlateId = this.activePlateId, expectedRevision?: number) {
    const before = this.canonicalProject.getSummary();
    const wasActive = id === before.activePlateId;
    this.canonicalProject.deletePlate(id, expectedRevision);
    this.revalidatePublishedGcode();
    if (wasActive) {
      this.unselectModel();
      const next = this.canonicalProject.getSummary().plates.find((plate) => plate.active)!;
      this.onSelectionChanged?.(false);
      this.setStatus(`Deleted plate; switched to ${next.name}.`);
    } else {
      this.setStatus('Plate deleted.');
    }
    this.onPlatesChanged?.();
  }

  public renamePlate(id: PlateId, name: string, expectedRevision?: number): void {
    this.canonicalProject.renamePlate(id, name, expectedRevision);
    this.setStatus(`Renamed build plate to ${name.trim()}.`);
    this.onPlatesChanged?.();
  }

  public reorderPlates(ids: readonly PlateId[], expectedRevision?: number): void {
    this.canonicalProject.reorderPlates(ids, expectedRevision);
    this.setStatus('Reordered build plates.');
    this.onPlatesChanged?.();
  }

  public setPlatePrintable(id: PlateId, printable: boolean, expectedRevision?: number): void {
    this.canonicalProject.setPlatePrintable(id, printable, expectedRevision);
    this.revalidatePublishedGcode();
    this.setStatus(printable ? 'Included build plate in print output.' : 'Excluded build plate from print output.');
    this.onPlatesChanged?.();
  }

  /** Projection-only simplification is forbidden until a canonical topology command owns it. */
  public simplifySelected(keepRatio = 0.5) {
    void keepRatio;
    this.setStatus('Simplify is unavailable until topology and annotation remapping commit canonically.');
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
    if (!this.publishedGcode) return null;
    return this.revalidatePublishedGcode();
  }

  /** Immediately withdraw output controls after a known semantic mutation. */
  private markPublishedGcodeStale(): void {
    if (!this.publishedGcode) return;
    if (this.previewOn) this.clearToolpathPreview();
    this.onDownloadReady?.(false);
  }

  /** Re-evaluate an artifact at a stable mutation boundary (for exact undo). */
  private revalidatePublishedGcode(): string | null {
    const published = this.publishedGcode;
    if (!published) return null;
    const gcode = this.canonicalProject.createCanonicalSliceSource().isCurrent(published.guard)
      ? published.gcode
      : null;
    if (!gcode) {
      if (this.previewOn) this.clearToolpathPreview();
    }
    this.onDownloadReady?.(gcode !== null);
    return gcode;
  }

  /** Frozen canonical base/override/effective settings projection for editor adapters. */
  public getProjectSettingsOverrideSnapshot(): ProjectSettingsOverrideSnapshot {
    return this.canonicalProject.getProjectSettingsOverrideSnapshot();
  }

  /** One revision/hash-guarded settings history boundary; no shadow UI state exists. */
  public setProjectSettingsOverrides(
    inheritedConfig: Readonly<ConfigMap>,
    overrides: Readonly<ConfigMap>,
    guard: ProjectSettingsOverrideGuard,
  ): ProjectSettingsOverrideSnapshot {
    const result = this.canonicalProject.setProjectSettingsOverrides({ inheritedConfig, overrides }, guard);
    this.revalidatePublishedGcode();
    return result;
  }

  private addModelFromGeometry(
    raw: THREE.BufferGeometry,
    _color: number,
    options: GeometryLoadOptions = {},
    name?: string,
  ) {
    raw.computeBoundingBox();
    const bb = raw.boundingBox!;
    if (!bb || bb.isEmpty()) throw new Error('Imported geometry has no finite bounds');
    const centerX = (bb.min.x + bb.max.x) / 2;
    const centerY = (bb.min.y + bb.max.y) / 2;
    const transform: Transform = {
      translationMm: [
        options.preservePrinterXY ? 0 : this.bedMm.x / 2 - centerX,
        options.preservePrinterXY ? 0 : this.bedMm.y / 2 - centerY,
        options.preservePrinterZ ? 0 : -bb.min.z,
      ],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    const imported = this.canonicalProject.importBufferGeometry(raw, {
      name,
      sourceFilename: name,
      transform,
    });
    const entry = this.projectedModels().find((candidate) => candidate.instanceId === imported.instanceId);
    if (!entry) throw new Error('Canonical model projection did not produce the imported instance');
    // Keep new models consistent with active View overlays.
    if (this.wireframeOn) this.applyWireframe(entry, true);
    if (this.labelsOn) this.applyLabel(entry, this.models.length - 1, true);
    if (this.overhangOn) this.applyOverhang(entry, true);
    if (!options.deferPostAdd) {
      // Auto-select the just-loaded model so Repair / Delete / Auto-orient act
      // on it immediately (standard slicer behaviour, works in both shells).
      this.selectModel(entry);
      this.recomputePreflight();
      this.warmSlicerAfterFirstModel();
    }
    return entry;
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
    } else {
      const gcode = this.getLastGcode();
      if (!gcode) {
        this.setStatus(
          this.publishedGcode
            ? 'project changed — slice again to preview current toolpaths'
            : 'slice first to preview toolpaths',
        );
        return;
      }
      this.showToolpathPreview(gcode);
      this.setStatus('toolpath preview');
    }
  }

  /** Apply one stepper increment of the active tool to the target model. */
  nudgeSelected(dir: -1 | 1) {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    if (!selected || !instance) {
      this.setStatus('no model');
      return;
    }
    let transform = instance.transform;
    let mode: MultiInstanceTransformMode = 'move';
    if (this.tool === 'rotate') {
      const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dir * (Math.PI / 12));
      const rotation = delta.multiply(new THREE.Quaternion().fromArray(transform.rotation)).normalize();
      transform = { ...transform, rotation: [rotation.x, rotation.y, rotation.z, rotation.w] };
      mode = 'rotate';
      this.setStatus(`rotation step: ${dir > 0 ? '+' : '-'}15°`);
    } else if (this.tool === 'scale') {
      const next = THREE.MathUtils.clamp(transform.scale[0] * (1 + dir * 0.1), 0.05, 40);
      transform = { ...transform, scale: [next, next, next] };
      mode = 'scale';
      this.setStatus(`scale: ${Math.round(next * 100)}%`);
    } else {
      const x = THREE.MathUtils.clamp(transform.translationMm[0] + dir * 5, 0, this.bedMm.x);
      transform = { ...transform, translationMm: [x, transform.translationMm[1], transform.translationMm[2]] };
      this.setStatus(`x: ${Math.round(x)} mm`);
    }
    this.commitSelectedPrimaryTransform(transform, mode);
    this.syncTransformProxy();
  }

  /** Fires when the filament palette changes (2D UI re-renders). */
  public onPaletteChanged: (() => void) | null = null;
  /** Fires when the paint tool, colour, or mode changes (DOM/XR surfaces). */
  public onPaintStateChanged: (() => void) | null = null;

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
    // XR swatches project the same canonical palette as the DOM panel, so a
    // spatial pinch assigns the identical stable filament identity.
    for (const entry of this.getPaintPalette().entries) {
      if (!entry.filamentId || !entry.selectable) continue;
      const filamentId = entry.filamentId;
      const swatch = new UIPanel({
        width: 35,
        height: 35,
        cornerRadius: 4,
        fillColor: entry.displayColor,
        strokeWidth: 2,
        strokeColor: this.paintFilamentId === filamentId ? '#ffffff' : '#444444',
        onClick: () => {
          this.setPaintFilament(filamentId);
          this.actionContext?.setTool('paint');
          return true;
        },
      });
      this.paintSwatches.push({ filamentId, btn: swatch });
      panel.add(swatch);
    }
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
  private paintSwatches: { filamentId: FilamentId; btn: UIPanel }[] = [];
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
    if (tool === 'lay_on_face') {
      this.setStatus('Lay on face is unavailable until the orientation result commits canonically.');
      return;
    }
    this.tool = tool;
    this.refreshToolButtons();
    if (tool === 'paint') {
      const palette = this.getPaintPalette();
      if (!this.paintFilamentId && this.paintMode === 'paint') {
        const first = palette.entries.find((entry: PaintPalette['entries'][number]) => entry.filamentId);
        if (first?.filamentId) this.paintFilamentId = first.filamentId;
      }
      this.refreshPaintOverlays();
      this.onPaintStateChanged?.();
      this.setStatus('Paint: drag across a model to colour it, Escape cancels.');
      return;
    }
    this.setStatus(`tool: ${tool} - pinch-drag the model`);
    if (this.transformControls) {
      if (tool === 'move') this.transformControls.setMode('translate');
      else if (tool === 'rotate') this.transformControls.setMode('rotate');
      else if (tool === 'scale') this.transformControls.setMode('scale');
    }
  }

  public autoOrientSelectedModel() {
    this.setStatus('Auto-orient is unavailable until its analysis commits a canonical transform.');
  }
  private checkLoadButtonAndTrigger() {
    if (!this.loadButtonNode || !this.onRequestLoadStl) return;
    const invokeLoadAction = () => {
      const ctx = this.actionContext;
      if (!ctx) return;
      void this.actionRegistry
        .invoke('load_model_from_path', 'xr-primary', ctx, ctx.ui.get())
        .catch((error) => console.error('[orcaxr] XR load action failed:', error));
    };
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
            invokeLoadAction();
          });
        } else {
          // `ActionRegistry.invoke` reaches the synchronous load handler before
          // its first await, preserving the native select's user activation.
          invokeLoadAction();
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
    for (const { filamentId, btn } of this.paintSwatches) {
      btn.setStrokeColor(filamentId === this.paintFilamentId ? '#ffffff' : '#444444');
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
    this.revalidatePublishedGcode();
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
      fillColor: '#ffffff08',
      strokeWidth: 1,
      strokeColor: '#ffffff12',
    });
    syncBtn.add(new UIText('Printer sync unavailable in XR', { fontSize: 11, color: '#9aa4af' }));
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
        const choices = this.getProfileOptions().filamentOptions;
        const idx = choices.findIndex((choice) => choice.id === this.headFilaments[i]?.presetId);
        const next = choices[idx < 0 ? 0 : (idx + 1) % choices.length];
        if (next) this.setHeadFilamentPreset(i, next.id);
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
      filBtn.add(new UIText(this.headFilaments[i]?.name || 'None', { fontSize: 12, color: '#ffffff' }));
      row.add(filBtn);

      if (!isVirtual) {
        const cycleNozzle = () => {
          const choices = ['0.2', '0.4', '0.6', '0.8'];
          const idx = choices.indexOf(this.headNozzles[i]);
          this.setHeadNozzle(i, choices[(idx + 1) % choices.length] ?? this.headNozzles[i]);
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
            this.removeAuxiliaryFilamentSlot(i);
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
      fillColor: '#ffffff08',
      strokeWidth: 1,
      strokeColor: '#ffffff12',
    });
    addBtn.add(new UIText('Virtual filament authoring unavailable', { fontSize: 11, color: '#9aa4af' }));
    panel.add(addBtn);
  }

  public undo(): boolean {
    const changed = this.canonicalProject.undo();
    if (changed) {
      this.syncTransformProxy();
      this.revalidatePublishedGcode();
      this.setStatus('Undid the last project edit.');
    }
    return changed;
  }

  public redo(): boolean {
    const changed = this.canonicalProject.redo();
    if (changed) {
      this.syncTransformProxy();
      this.revalidatePublishedGcode();
      this.setStatus('Redid the project edit.');
    }
    return changed;
  }

  public deleteSelectedModel() {
    const deleted = this.canonicalProject.deleteSelectedInstance();
    if (!deleted) return;
    this.setStatus(deleted.scope === 'object' ? 'Model deleted.' : 'Model instance deleted.');
  }

  /** Delete every model on the ACTIVE plate (Orca's Edit → Delete all). */
  public deleteAllModels() {
    this.setStatus('Delete All is unavailable until it is one canonical transaction.');
  }

  /**
   * New Project — clear every model on every plate, reset to a single empty
   * plate, and drop any slice output / preview. The fresh-start action from
   * Snapmaker Orca's File menu. (docs/parity.md)
   */
  public async newProject(): Promise<boolean> {
    const dirty = this.canonicalProject.getSummary().dirty;
    if (dirty) {
      const confirm = this.onRequestNewProjectConfirmation;
      if (!confirm || !(await confirm(true))) {
        this.setStatus('New Project cancelled; the current project was not changed.');
        return false;
      }
    }
    this.canonicalProject.resetProject();
    this.clearToolpathPreview();
    this.publishedGcode = null;
    this.onDownloadReady?.(false);
    this.onSelectionChanged?.(false);
    this.onPlatesChanged?.();
    this.setStatus('Started a new project.');
    return true;
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
    this.canonicalProject.duplicateSelectedInstance();
    this.setStatus('Model cloned — use the Move tool to reposition the copy.');
  }

  public async splitSelectedToObjects(): Promise<boolean> {
    const result = await runCanonicalSplitToObjectsFlow(
      this.canonicalProject,
      this.onRequestSplitToObjectsConfirmation,
      (message) => this.setStatus(message),
    );
    if (!result) return false;
    this.syncTransformProxy();
    return true;
  }

  public cutSelectedByPlane() {
    this.setStatus('Cut is unavailable until topology and annotations commit atomically.');
  }
  // --- Edit clipboard (canonical implementation pending) ----------------
  public get hasClipboard(): boolean {
    return false;
  }

  public copySelectedModel(): boolean {
    this.setStatus('Copy is unavailable until the canonical clipboard preserves full object semantics.');
    return false;
  }

  public cutSelectedModel(): boolean {
    this.setStatus('Cut is unavailable until the canonical clipboard preserves full object semantics.');
    return false;
  }

  public pasteClipboard() {
    this.setStatus('Paste is unavailable until the canonical clipboard preserves full object semantics.');
  }
  // --- View overlays (Orca View → Show Wireframe / Printable Box) ------
  private wireframeOn = false;
  private printableBox: THREE.LineSegments | null = null;

  /** Add/remove a wireframe overlay child on one model's display mesh. */
  private applyWireframe(entry: ProjectedModelEntry, on: boolean) {
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

  private applyLabel(entry: ProjectedModelEntry, idx: number, on: boolean) {
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

  private applyOverhang(entry: ProjectedModelEntry, on: boolean) {
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

  public arrangePlate() {
    this.setStatus('Arrange is unavailable until placement commits as one canonical transaction.');
  }

  public exportPlateStl() {
    const summary = this.canonicalProject.getSummary();
    const selected = summary.selectedInstanceIds.filter(
      (instanceId) => this.canonicalProject.getInstance(instanceId)?.plateId === summary.activePlateId,
    );
    const instanceIds = selected.length > 0 ? selected : this.models.map((model) => model.instanceId);
    try {
      const exported = this.canonicalProject.exportCanonicalStl(instanceIds);
      this.onDownloadFile?.(exported.suggestedFilename, ownedArrayBuffer(exported.bytes), exported.mediaType);
      this.setStatus(
        `Exported ${exported.instanceCount} model${exported.instanceCount === 1 ? '' : 's'} as ${exported.triangleCount.toLocaleString()} STL triangle${exported.triangleCount === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      this.setStatus(`STL export failed: ${(error as Error).message}`);
      throw error;
    }
  }

  public build3mfBytes(): Uint8Array | null {
    this.setStatus('Geometry-only 3MF export is unavailable; use canonical project save.');
    return null;
  }

  public exportPlate3mf() {
    this.setStatus('Geometry-only 3MF export is unavailable; use canonical project save.');
  }
  // --- Save / Open Project (Orca File → Save / Open Project) -----------
  /** Save the project as a downloadable OrcaXR .3mf (File → Save Project). */
  public async saveProject(): Promise<void> {
    if (this.canonicalProject.getSummary().objectCount === 0) {
      this.setStatus('Nothing to save — add a model first.');
      return;
    }
    try {
      const saved = await this.canonicalProject.saveCanonical3mf();
      this.onDownloadFile?.(saved.suggestedFilename, ownedArrayBuffer(saved.bytes), saved.mediaType);
      const warnings = saved.warnings?.length ?? 0;
      this.setStatus(`Project saved${warnings > 0 ? ` (${warnings} compatibility warning(s))` : ''}.`);
    } catch (error) {
      this.setStatus(`Project save failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /** Restore a scene from OrcaXR project bytes (File → Open Project). */
  public async openProject(bytes: ArrayBuffer, filename = 'project.3mf'): Promise<boolean> {
    if (bytes.byteLength === 0) throw new Error('The selected project is empty.');
    if (this.projectImportInProgress) throw new Error('Another project import preview is already open.');
    this.projectImportInProgress = true;
    try {
      const prepared = await this.canonicalProject.prepareCanonical3mfImport(new Uint8Array(bytes), {
        filename,
        mediaType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      });
      const preview = prepared.preview;
      const confirm = this.onProjectImportPreview;
      if (!confirm) {
        prepared.cancel('no import confirmation surface');
        throw new Error('Project import needs an explicit preview confirmation surface.');
      }
      let committed = false;
      try {
        const decision = await confirm(preview);
        if (preview.blocked) {
          const errors = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          throw new Error(
            `The project import preview is blocked by ${errors.length || 1} unresolved problem${errors.length === 1 ? '' : 's'}.`,
          );
        }
        if (!decision) {
          this.setStatus('Project open cancelled.');
          return false;
        }
        prepared.confirm(decision);
        committed = true;
      } finally {
        if (!committed) prepared.cancel('project open did not commit');
      }
      this.importedProjectOwnsSlicingConfiguration = true;
      this.profile = null;
      const slicing = this.canonicalProject.getSlicingConfiguration();
      const physical = [...slicing.filaments.physical].sort((left, right) => left.toolId - right.toolId);
      this.headFilaments = physical.map((filament) =>
        Object.freeze({
          name: filament.name,
          ...(filament.presetId?.startsWith('preset:') ? { presetId: filament.presetId as WorkspacePresetId } : {}),
        }),
      );
      this.headNozzles = physical.map((filament) => String(filament.nozzleDiameterMm ?? 0.4));
      this.virtualFilaments = virtualFilamentsFromConfig({
        ...slicing.config,
        filament_colour: physical.map((filament) => filament.color),
      });
      this.projectPrimeTower = null;
      if (physical.length > 0) {
        this.palette.setFrom(
          physical.map((filament) => filament.color),
          physical.map((filament) => filament.material),
        );
      }
      this.synchronizePrinterMappingFromCanonicalConfig();
      this.unselectModel();
      this.onProfileChanged?.();
      this.recomputePreflight();
      const summary = this.canonicalProject.getSummary();
      this.setStatus(
        `Opened ${summary.projectName} — ${summary.objectCount} model${summary.objectCount === 1 ? '' : 's'}, ${summary.plates.length} plate${summary.plates.length === 1 ? '' : 's'}.`,
      );
      return true;
    } finally {
      this.projectImportInProgress = false;
      this.applyCatalogDefaultProfile();
    }
  }

  public async sliceNow() {
    if (this.activeCanonicalSlicer) return;
    const activePlate = this.canonicalProject.getSummary().plates.find((plate) => plate.id === this.activePlateId);
    if (!activePlate || activePlate.instanceCount === 0) {
      this.setStatus('No models to slice.');
      return;
    }
    if (SlicerClient.useExternalSlicer()) {
      this.setStatus(
        'slice failed: external canonical slicing needs independently attested engine provenance; disable the external slicer to use the verified browser engine.',
      );
      return;
    }
    const startedAt = performance.now();
    const preflight = this.createLiveProfilePreflight();
    const slicer = new CanonicalWorkspaceSlicer({
      workspace: this.canonicalProject,
      client: this.slicer,
      route: { kind: 'browser-wasm' },
      maxThreads: 4,
      preflight,
    });
    this.activeCanonicalSlicer = slicer;
    const unsubscribe = slicer.subscribe((status) => this.renderCanonicalSliceStatus(status));
    try {
      this.markPublishedGcodeStale();
      this.onSliceStateChanged?.(true);
      this.sliceModalCard?.show();
      const result = await slicer.startCurrentPlate().completion;
      const plate = result.plates[0];
      if (!plate) throw new Error('The canonical slicer returned no active-plate output.');
      const gcode = new TextDecoder('utf-8', { fatal: true }).decode(plate.gcode);
      this.publishedGcode = {
        gcode,
        guard: {
          sourceRevision: result.sourceRevision,
          sourceHash: result.sourceHash,
          sourceAssetHash: result.sourceAssetHash,
        },
      };
      if (!this.revalidatePublishedGcode()) {
        throw new Error('The project changed while slicing; the stale result was discarded. Slice again.');
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      const lines = gcode.split('\n').length;
      const layers = (gcode.match(/; CHANGE_LAYER|;LAYER_CHANGE/g) ?? []).length;
      const warningSuffix = result.warnings.length > 0 ? `, ${result.warnings.length} warning(s)` : '';
      this.setStatus(
        `SLICED in ${elapsedMs} ms\n${(plate.gcode.byteLength / 1024).toFixed(0)} KB, ${lines} lines, ${layers} layers${warningSuffix}`,
      );
      this.showToolpathPreview(gcode);
      return;
    } catch (e) {
      if (e instanceof SlicePreflightError) this.publishPreflightResult(e.result);
      this.setStatus(`slice failed: ${(e as Error).message}`);
      this.revalidatePublishedGcode();
    } finally {
      unsubscribe();
      slicer.dispose();
      if (this.activeCanonicalSlicer === slicer) this.activeCanonicalSlicer = null;
      this.onSliceStateChanged?.(false);
      this.sliceModalCard?.hide();
    }
  }

  public cancelSlice(): void {
    this.activeCanonicalSlicer?.cancelAll('Cancelled by user');
  }

  private renderCanonicalSliceStatus(status: SliceJobStatus): void {
    const message = status.progressMessage ?? status.phase.replaceAll('-', ' ');
    const percent = status.progressPercent ?? Math.round((status.completedPlateCount / status.totalPlateCount) * 100);
    this.setStatus(`Slicing: ${message}`, percent);
  }

  /**
   * Projection helper retained only for explicit geometry STL export.
   * Canonical slicing and preflight read the immutable graph/assets directly.
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
      // frame that world matrix is still stale, which misplaces exported models.
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

  /** Toggle wipe-tower auto-positioning (Section 1 pre-flight). */
  public setWipeTowerAuto(on: boolean): void {
    void on;
    this.setStatus('Automatic wipe-tower placement is unavailable until canonical collision placement lands.');
  }

  /** Fail closed until canonical active-plate validation has produced evidence. */
  public hasBlockingPreflight(): boolean {
    return !this.preflightResult?.canSlice;
  }

  /** Recompute the same canonical/profile-aware preflight used by slicing. */
  public recomputePreflight(): void {
    this.revalidatePublishedGcode();
    this.rebuildWipeTowerGhost();
    try {
      const snapshot = this.canonicalProject.createCanonicalSliceSource().capture();
      const result = this.createLiveProfilePreflight().evaluate(snapshot, this.activePlateId);
      this.publishPreflightResult(result);
    } catch (error) {
      this.publishPreflightResult(canonicalPreflightUnavailable(this.activePlateId, error));
    }
  }

  private publishPreflightResult(result: CanonicalSlicePreflightResult): void {
    this.preflightResult = result;
    this.onPreflight?.(result);
  }

  public async fixSelectedModel(): Promise<void> {
    this.setStatus('Repair is unavailable until topology and annotations commit atomically.');
  }

  public async booleanModels(op: 'UNION' | 'A_NOT_B' | 'INTERSECTION'): Promise<void> {
    this.setStatus(`Boolean ${op} is unavailable until topology and annotations commit atomically.`);
  }

  async smartPaint(): Promise<void> {
    this.setStatus('Smart Paint is unavailable until results commit as canonical facet annotations.');
  }

  async smartPaintImage(): Promise<void> {
    this.setStatus('Image Smart Paint is unavailable until results commit as canonical facet annotations.');
  }
}
