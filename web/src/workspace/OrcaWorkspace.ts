/**
 * OrcaXR Web — Phase 2 workspace.
 *
 * A build plate whose Three/XR scene is a one-way projection of the canonical
 * project controller. Manipulation commits stable-ID commands back to that
 * controller; save and slice serialize the same canonical state.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  DEFAULT_EMBOSS_FONT_PROPERTY,
  DEFAULT_EMBOSS_PROJECTION,
  type EmbossFontProperty,
  type EmbossProjection,
  type EmbossTextConfiguration,
  type EmbossedMesh,
  type GlyphOutlineSource,
} from '../project/objects/emboss';
import { readTrueTypeOutlines } from '../project/objects/truetypeOutlines';
import { readSvgShapes } from '../project/objects/svgShapes';
import type { ProjectSummaryInput } from '../diagnostics/DiagnosticsBundle';
import type { FilamentId, InstanceId, LayerRangeId, ObjectId, PlateId, VolumeId } from '../project/domain/ids';
import { entityId, UuidIdSource } from '../project/domain/ids';
import type {
  ConfigMap,
  FacetAnnotations,
  FacetRefinementEncoding,
  JsonValue,
  Transform,
  Vec3,
} from '../project/domain/model';
import { materializeFacetRefinement, type FacetAnnotationGuard } from '../project/annotations';
import {
  collapseFacetRefinementRoots,
  type FacetRefinedRootSet,
  facetRefinementAssignedLeafCount,
} from '../project/domain/facetRefinement';
import type { FullSpectrumAutoPairGenerationPreferences } from '../project/filaments/autoPairReconciliation';
import type { RecreateModelColorsPlan, RecreateModelColorsOptions } from '../project/filaments/recreateModelColors';
import { askRecreateModelColors } from '../ui/dom/RecreateModelColorsDialog';
import type { ImportCommitConfirmation, ProjectImportPreview } from '../project/import/types';
import type { ObjectTreeEntityRef } from '../project/objects';
import {
  SlicePreflightError,
  type CanonicalProjectSliceGuard,
  type CanonicalSlicePreflightResult,
  type SliceJobStatus,
} from '../project/slicing';
import type { ProjectSettingsOverrideGuard, ProjectSettingsOverrideSnapshot } from '../project/settingsOverrides';
import type {
  ScopedOverrideGuard,
  ScopedOverrideSnapshot,
  ScopedOverrideTarget,
  ScopedOverrideTargetOption,
} from '../project/scopedOverrides';
import { detectModelFormat } from '../project/import/formats';
import type { LayerEventType } from '../project/domain/model';
import type { PrintJobCommand } from '../printer/PrintJobControl';
import type { PrintJobIntent } from '../printer/PrintJobSubmission';
import type { PrinterConsoleOperation } from '../printer/PrinterConsole';
import type { PrinterStorageOperation } from '../printer/PrinterStorage';
import type { PresetLibraryOperation } from '../settings/presets/PresetLibrary';
import type { CalibrationHistoryOperation } from '../project/calibration/history';
import { HoldToConfirm, type GuardedPrinterAction, type PrinterStatusSummary } from '../printer/PrinterStatusSummary';
import { summarizeGcodeToolUsage } from '../printer/PrintToolMapping';
import { serializePrintConfigArray } from '../settings/configSerialization';
import type { ArrangeRegion } from '../project/objects/arrange';
import type { WipeTowerPick } from '../project/objects/wipeTowerPlacement';
import { rotateVector } from '../project/objects/transformOperations';
import { summarizeGcodeArtifact, type GcodeArtifactSummary } from '../slicer/GcodeArtifactSummary';
import { GCODE_PREVIEW_MODES } from '../slicer/GcodePreviewModel';
import {
  GCODE_PREVIEW_MOVE_FILTERS,
  GcodePreviewSession,
  type GcodePreviewSessionSource,
  type GcodePreviewViewPatch,
  type GcodePreviewViewState,
} from '../slicer/GcodePreviewSession';
import { GcodePreviewSurface, type GcodePreviewSurfaceOptions } from '../ui/preview/GcodePreviewSurface';
import { CURRENT_THREE_WORLD_UNITS_PER_MM, getThreeProjectEntity } from '../project/surfaces/ThreeProjectSurface';
import {
  DEFAULT_CHANNEL_VALUE,
  PaintStrokeService,
  channelLabel,
  type PaintChannel,
  type PaintToolKind,
  type PaintToolSettings,
} from '../project/painting/PaintStrokeService';
import { SIMPLIFY_DEFAULT_MAX_ERROR } from '../project/objects/simplify';
import type { SimplifyConfiguration } from '../project/objects/simplify';
import { BRIM_EAR_MAX_RADIUS_MM, BRIM_EAR_MIN_RADIUS_MM } from '../project/objects/brimEarCommands';
import type { AiPaintSession } from '../project/painting/AiPaintSession';
import {
  SurfaceFeatureExtractor,
  describeSurfaceFeature,
  measureSurfaceFeatures,
  transformSurfaceFeature,
  type SurfaceFeature,
} from '../project/objects/measure';
import {
  inspectAssemblyActions,
  planAssemblyAlignment,
  type AssemblyAlignmentKind,
  type AssemblyAvailability,
} from '../project/objects/assembly';
import { GEMINI_PAINT_PROVIDER_ID, LazyGeminiAiPaintPort } from '../features/aiPaintProvider';
import { paintPaletteColors, type PaintPalette } from '../project/painting/paintPalette';
import {
  CanonicalWorkspaceController,
  type CanonicalFilamentAssignableEntityRef,
  type CanonicalFilamentAssignmentSnapshot,
  type CanonicalAutoPairReconciliationConfirmation,
  type CanonicalAutoPairReconciliationResult,
  type CanonicalAutoPairPolicySnapshot,
  type CanonicalLayerEventMutationRequest,
  type CanonicalLayerEventSnapshot,
  type CanonicalObjectsTreeSnapshot,
  type CanonicalSemanticLayerRangeRequest,
  type CanonicalSemanticObjectEditorSnapshot,
  type CanonicalSemanticVolumeRoleRequest,
  type CanonicalSplitToObjectsConfirmation,
  type CanonicalVirtualFilamentLibrarySnapshot,
  type CanonicalVirtualFilamentMutationRequest,
  type CanonicalWorkspaceSummary,
} from './CanonicalWorkspaceController';
import type { PreparedSimplify } from './CanonicalWorkspaceController';
import { runCanonicalSplitToObjectsFlow } from './CanonicalSplitToObjectsFlow';
import { CanonicalWorkspaceSlicer } from './CanonicalWorkspaceSlicer';
import {
  projectMultiInstancePrimaryTransform,
  projectMultiInstanceTransform,
  type MultiInstanceTransformMode,
  type MultiInstanceTransformOrigin,
} from './multiInstanceTransform';
import { deriveLiveProfilePreflightConstraints, LiveProfileSlicePreflight } from './ProfilePreflightConstraints';
import { PaintOverlayRegistry } from './PaintOverlayRegistry';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Action, ActionRegistry, ActionSurface } from '../actions/ActionRegistry';
import { GROUPS, MENU_SECTIONS, XR_PANELS_SECTION_ID, type ContextTarget } from '../actions/ActionRegistry';
import type { ActionContext } from '../actions/ActionContext';
import { renderXrActionButton, xrToolRailActions, type XrActionHandle } from '../ui/xr/XrShell';
import { xrBlocksUiAdapter } from '../ui/xr/XrUiAdapter';
import { SceneGestureGuard, type SceneGestureSnapshot } from '../ui/xr/SceneGestureGuard';
import { DEFAULT_BRIM_EAR_DETECTION, detectBrimEars } from '../project/objects/brimEarDetection';
import { projectExplosion } from '../project/objects/assembly';
import type { CalibrationJobPlan, CalibrationJobPrerequisites } from '../project/calibration/types';
import { stepCalibrationValue } from '../project/calibration/stepper';
import { pressureAdvanceLineProgram } from '../project/calibration/lineProgram';
import { extractMachineEnvelope, wrapInMachineEnvelope } from '../project/calibration/machineEnvelope';
import { loadCalibrationResource } from '../project/calibration/resources';
import type { CalibrationFormField, CalibrationFormPreview } from '../project/calibration/form';
import type { ScopedStepperSurface, ScopedStepperView } from '../settings/editor/scopedStepper';
import { renderXrScopedSettings, xrScopedSettingsSignature } from '../ui/xr/XrScopedSettings';
import { primitiveFileName, primitiveGeometry, type PrimitiveKind } from '../project/objects/primitives';
import {
  BRIM_EAR_COLORS,
  BRIM_EAR_DISC_HEIGHT_MM,
  brimEarOutline,
  findDisconnectedBrimEars,
} from '../project/objects/brimEarPreview';
import { CalibrationRampGenerator } from '../features/CalibrationRampGenerator';
import { recentProjectsStore } from '../project/persistence/recentProjects';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

/** A classified right-click in the 3D scene (P11.2). */
export interface SceneContextRequest {
  readonly target: ContextTarget;
  /** The instance under the pointer, so the menu can name what it will act on. */
  readonly instanceId: InstanceId | null;
  readonly clientX: number;
  readonly clientY: number;
}

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
} from 'xrblocks/addons/uiblocks/src/index.js';

import { FilamentPalette } from './FilamentPalette';
import { bedSizeFromProfile, ProfileCatalog, type SlicerProfile } from '../slicer/ProfileLoader';
import { SlicerClient, type SlicerClientProjectRoute } from '../slicer/SlicerClient';
import {
  filamentPresetAgreesWithSlot,
  matchFilamentPreset,
  type FilamentPresetCandidate,
  type ReportedFilamentSlot,
} from '../slicer/filamentPresetMatch';
import { exportConfigJson, parseConfigJson } from '../features/ConfigIO';
import { virtualFilamentsFromConfig, type VirtualFilament } from '../features/MixedFilamentPreview';
import { renderXrPreviewScrubber, type XrPreviewScrubberRender } from '../ui/xr/XrPreviewScrubber';
import { renderXrDeviceWorkspace } from '../ui/xr/XrDeviceWorkspace';
import { renderXrProjectWorkspace } from '../ui/xr/XrProjectWorkspace';
import { renderXrPrintSubmissionDialog } from '../ui/xr/XrPrintSubmissionDialog';
import { xrIcon } from '../ui/icons';
import { surfaceTransform, xrSurface, type XrSurfaceId } from '../ui/xr/XrLayout';
import { t } from '../l10n/t';

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
/** Height the given layer prints at, from the inspection layer index. */
function layerPrintZ(
  layers: { readonly layerIds: Uint32Array; readonly zMm: Float32Array },
  layer: number,
): number | undefined {
  const ordinal = layers.layerIds.indexOf(layer);
  return ordinal < 0 ? undefined : layers.zMm[ordinal];
}

/** One authorable layer event and whether the current profile can perform it. */
export interface LayerEventCapability {
  readonly type: LayerEventType;
  readonly label: string;
  readonly supported: boolean;
  readonly reason?: string;
}

/** Operator-facing names for each authored layer event. */
const LAYER_EVENT_LABELS: Readonly<Record<LayerEventType, string>> = Object.freeze({
  'color-change': 'colour change',
  pause: 'pause',
  'tool-change': 'tool change',
  template: 'template G-code',
  custom: 'custom G-code',
});

const PLATE_MM = 200;
const MM = 0.001;

/**
 * Metres per layout pixel for every immersive card.
 *
 * At 0.0014 a 17 px menu row is 24 mm tall, which subtends about 1.4° at the
 * radius the panels sit at — comfortably above the ~1° where text starts to
 * cost effort in a headset. It is one constant because a card whose pixel
 * scale differs from its neighbour's renders the same font at a different
 * physical size, which reads as sloppiness rather than hierarchy.
 */
const XR_PIXEL_SIZE = 0.0014;

/** The sheet's front page: the list of menu sections rather than one section. */
const XR_MENU_ROOT = 'xr-menu-root';

/**
 * The flat shell's sidebar cards, in the flat shell's order and under the flat
 * shell's names.
 *
 * A maker who has used OrcaXR on a screen already knows where filament lives
 * and what the Process card is called; the headset should not make them learn
 * a second vocabulary for the same catalogue. Each card claims the action
 * groups the corresponding DOM card renders, so the two shells stay a single
 * application seen two ways rather than two applications.
 */
/** The icon each sheet section shows, matching the flat shell's own menus. */
const XR_SECTION_ICONS: Readonly<Record<string, string>> = {
  file: 'file',
  edit: 'edit',
  view: 'view',
  add: 'library',
  tools: 'advanced',
  calibration: 'calibration',
  help: 'help',
  [XR_PANELS_SECTION_ID]: 'system',
};

const XR_CARD_PREFIX = 'xr-card-';
const XR_CARDS: readonly { id: string; label: string; icon: string; groups: readonly string[] }[] = [
  { id: `${XR_CARD_PREFIX}printer`, label: 'Printer', icon: 'output', groups: ['output', 'system'] },
  { id: `${XR_CARD_PREFIX}filament`, label: 'Filament', icon: 'filament', groups: ['filament'] },
  { id: `${XR_CARD_PREFIX}process`, label: 'Process', icon: 'slice_group', groups: ['slice', 'advanced'] },
  { id: `${XR_CARD_PREFIX}objects`, label: 'Objects', icon: 'scene', groups: ['scene', 'edit'] },
  { id: `${XR_CARD_PREFIX}tools`, label: 'Object tools', icon: 'paint', groups: ['paint', 'view'] },
  { id: `${XR_CARD_PREFIX}project`, label: 'Project', icon: 'plate', groups: ['calibration'] },
];

/**
 * The workspaces the flat shell's tab strip offers, in its order.
 *
 * Paint is deliberately absent: on a screen it is a *tool* in the model
 * toolbar, and it is the same tool in the headset's rail. Offering it as a
 * fourth workspace here taught the two shells different ideas of what painting
 * is.
 */
type XrWorkspace = 'prepare' | 'preview' | 'device' | 'project';

/**
 * Whether this page was opened to inspect the immersive shell on a desktop.
 *
 * The XRBlocks simulator starts in the ordinary app too, so "the simulator is
 * running" is not the same question as "show me the XR panels".
 */
function xrUiReviewRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('xrui') === '1';
  } catch {
    // No location (tests, workers): reviewing is a browser-only affordance.
    return false;
  }
}

/**
 * How the build plate is dressed on each surface.
 *
 * `xr` is the app's own identity — a dark, lit tray with amber rings and a
 * grab bar, because in a headset the plate is an object you can take hold of.
 * The two flat skins are a desktop slicer's bed: an unlit tray in the theme's
 * own greys with a quiet grid and no grab affordances, so the window reads as
 * one surface from the sidebar to the plate.
 */
export type PlateAppearance = 'xr' | 'flat-light' | 'flat-dark';

interface PlateSkin {
  plate: number;
  opacity: number;
  roughness: number;
  metalness: number;
  gridMajor: number;
  gridMinor: number;
  gridOpacity: number;
  origin: number;
  grabAffordances: boolean;
}

const PLATE_SKINS: Readonly<Record<PlateAppearance, PlateSkin>> = {
  xr: {
    plate: 0x0d141c,
    opacity: 0.85,
    roughness: 0.2,
    metalness: 0.8,
    gridMajor: 0xff6d00,
    gridMinor: 0xff8a3d,
    gridOpacity: 0.15,
    origin: 0xff6d00,
    grabAffordances: true,
  },
  'flat-light': {
    plate: 0xdfe3e6,
    opacity: 1,
    roughness: 0.85,
    metalness: 0.05,
    gridMajor: 0x8d979d,
    gridMinor: 0xa9b2b7,
    gridOpacity: 0.85,
    origin: 0x009688,
    grabAffordances: false,
  },
  'flat-dark': {
    plate: 0x353b3e,
    opacity: 1,
    roughness: 0.85,
    metalness: 0.05,
    gridMajor: 0x788085,
    gridMinor: 0x5c6367,
    gridOpacity: 0.7,
    origin: 0x00a892,
    grabAffordances: false,
  },
};

/**
 * Non-colour channels have no filament colour, so each assigned state gets a
 * fixed, distinguishable overlay hue. The panel always labels the state too, so
 * hue is never the only cue.
 */
const CHANNEL_STATE_COLORS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  support: Object.freeze({ enforce: '#39d353', block: '#f85149' }),
  seam: Object.freeze({ prefer: '#58a6ff', avoid: '#ff9f43' }),
  fuzzySkin: Object.freeze({ true: '#bc8cff' }),
});

function rgbaToHex(color: readonly [number, number, number, number]): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

function previewRenderFailureMessage(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 240);
  if (/rendered segments|segment limit/i.test(detail)) {
    return 'Preview unavailable: this G-code exceeds the safe renderer segment limit. Show fewer layers or move classes and try again.';
  }
  if (/Float32 world domain|surface transform|printer-to-world transform/i.test(detail)) {
    return 'Preview unavailable: the printer-to-world transform is outside the safe renderer domain. Reset the workspace or printer profile and try again.';
  }
  if (/sidecar|path-point|path point|path kind|arc record/i.test(detail)) {
    return 'Preview unavailable: this G-code path failed safety validation. Re-slice the plate or open a different G-code file.';
  }
  return `Preview unavailable: the toolpath could not be rendered safely${detail ? ` (${detail})` : ''}. Re-slice the plate or open a different G-code file.`;
}

function channelOverlayColors(
  channel: PaintChannel,
  filamentColors: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (channel === 'color') return filamentColors;
  return new Map(Object.entries(CHANNEL_STATE_COLORS[channel] ?? {}));
}

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

/**
 * The local filament every selected scope already shares, or undefined when
 * they differ — the same rule the flat bar uses, so the two agree about what
 * "current" means.
 */
function uniformLocalFilament(snapshot: CanonicalFilamentAssignmentSnapshot): FilamentId | null | undefined {
  let choice: FilamentId | null | undefined;
  for (const [index, scope] of snapshot.scopes.entries()) {
    const local = scope.localFilamentId ?? null;
    if (index === 0) choice = local;
    else if (choice !== local) return undefined;
  }
  return choice;
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

export type WorkspaceGizmoTool =
  | 'move'
  | 'rotate'
  | 'scale'
  | 'lay_on_face'
  | 'measure'
  | 'brim_ears'
  | 'paint'
  | 'support_paint'
  | 'seam_paint'
  | 'fuzzy_skin'
  | 'emboss'
  | 'svg';

/** Group name for the on-model ear discs, parented to a part's display mesh. */
const BRIM_EAR_PREVIEW_NAME = 'brimEarPreview';

/** Read-only view a brim-ear surface renders. */
export interface BrimEarSnapshot {
  readonly active: boolean;
  /** Object the next placement lands on, when exactly one part is in scope. */
  readonly objectId?: ObjectId;
  readonly radiusMm: number;
  readonly ears: readonly { readonly positionMm: Vec3; readonly headFrontRadiusMm: number }[];
  /**
   * Indices into `ears` that reach neither the part nor an ear that does, and
   * so will print an island of brim holding nothing down.
   */
  readonly stranded: readonly number[];
  readonly hint: string;
  /** Present only when `stranded` is non-empty; a surface should show it. */
  readonly warning?: string;
}

/** A bounded change to the emboss recipe; absent fields keep their value. */
export type EmbossRecipePatch = Partial<Omit<EmbossTextConfiguration, 'font' | 'projection'>> & {
  readonly font?: Partial<EmbossFontProperty>;
  readonly projection?: Partial<EmbossProjection>;
};

/** Read-only view an emboss surface renders. */
export interface EmbossSnapshot {
  readonly active: boolean;
  /** Object a new embossed part would be added to, when one part is in scope. */
  readonly objectId?: ObjectId;
  /** Volume whose recipe an edit would re-cut, when an embossed part is selected. */
  readonly volumeId?: VolumeId;
  /** Name of the loaded font, or undefined when the operator has chosen none. */
  readonly fontName?: string;
  readonly configuration: EmbossTextConfiguration;
  readonly hint: string;
}

/** Read-only view an SVG-part surface renders. */
export interface SvgPartSnapshot {
  readonly active: boolean;
  /** Object a new part would be added to, when one part is in scope. */
  readonly objectId?: ObjectId;
  /** Volume an edit would re-cut, when an SVG part is selected. */
  readonly volumeId?: VolumeId;
  /** Name of the loaded drawing, or undefined when none has been chosen. */
  readonly fileName?: string;
  readonly depthMm: number;
  /** Requested width in millimetres; undefined keeps the drawing's own size. */
  readonly widthMm?: number;
  /** What the loaded drawing contains that cannot become solid geometry. */
  readonly unsupported: readonly { readonly element: string; readonly detail: string }[];
  readonly hint: string;
}

/** Read-only view an assembly surface renders. */
export interface AssemblySnapshot {
  readonly available: AssemblyAvailability;
  /** True when the second pick belongs to a different, movable instance. */
  readonly movable: boolean;
  readonly hint: string;
}

const EMPTY_ASSEMBLY_AVAILABILITY: AssemblyAvailability = Object.freeze({
  canSetToParallel: false,
  canSetToCenterCoincidence: false,
  canReverseFeature1: false,
  canReverseFeature2: false,
  canRotateAroundFaceCenter: false,
  hasParallelDistance: false,
  parallelDistanceMm: 0,
  angleRadians: 0,
});

/** Read-only view a measurement readout renders; every number is canonical. */
export interface MeasureSnapshot {
  readonly active: boolean;
  readonly picks: readonly {
    readonly kind: SurfaceFeature['kind'];
    readonly summary: string;
    /** Circle diameter in millimetres, when the pick is a circle. */
    readonly diameterMm?: number;
  }[];
  readonly distanceMm?: number;
  readonly distanceKind?: 'strict' | 'infinite';
  readonly distanceXyzMm?: readonly [number, number, number];
  readonly angleDeg?: number;
  /** Exact reason a value the pinned engine computes is withheld here. */
  readonly unsupportedReason?: string;
  readonly hint: string;
}

/** Modal tools that author facet annotations, and the channel each authors. */
export const PAINT_TOOL_CHANNELS: Readonly<Record<string, PaintChannel>> = Object.freeze({
  paint: 'color',
  support_paint: 'support',
  seam_paint: 'seam',
  fuzzy_skin: 'fuzzySkin',
});

/** Read-only view a Smart Paint surface renders; every number is canonical. */
export interface SmartPaintSnapshot {
  readonly providerId: string;
  readonly unavailableReason?: string;
  readonly channel: PaintChannel;
  readonly consent: { readonly geometry: boolean; readonly image: boolean };
  readonly prompt: string;
  readonly imageAttached: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly preview?: {
    readonly channel: PaintChannel;
    readonly coverage: number;
    readonly confidence: number;
    readonly unassignedFacetCount: number;
    readonly assignable: boolean;
    readonly regions: readonly {
      readonly id: string;
      readonly label: string;
      readonly confidence: number;
      readonly coverage: number;
      readonly facetCount: number;
      readonly value: string | boolean | null;
    }[];
  };
}

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
  /** Renderer dependency seam used to fail closed without constructing test-sized GPU buffers. */
  readonly previewSurfaceFactory?: (options: GcodePreviewSurfaceOptions) => WorkspacePreviewSurface;
  /**
   * Already-loaded profile corpus, so a caller with no network (a test, an
   * offline harness) drives the real preset graph instead of an empty one.
   */
  readonly catalog?: ProfileCatalog;
}

export type WorkspacePreviewSurface = Pick<GcodePreviewSurface, 'clear' | 'render' | 'setVisible'>;

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
  /**
   * How the build plate is dressed.
   *
   * In a headset the plate is a *grabbable object* floating in a room, so it
   * carries the app's own dark-and-amber identity plus the rings and bar that
   * say "you can take hold of this". In a desktop window it is the bed of a
   * slicer, and it is dressed like one: a light tray with a quiet grid, no
   * grab affordances, and no glow. The same geometry either way.
   */
  private plateAppearance: PlateAppearance = 'flat-light';
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
  /** Per-plate artifacts from the last all-plate slice, guarded as one set. */
  private publishedPlateGcode: {
    readonly plates: ReadonlyMap<PlateId, { gcode: string; byteLength: number; warnings: readonly string[] }>;
    readonly guard: CanonicalProjectSliceGuard;
  } | null = null;
  private previewSurface: WorkspacePreviewSurface | null = null;
  private readonly previewSurfaceFactory: (options: GcodePreviewSurfaceOptions) => WorkspacePreviewSurface;
  private previewSession: GcodePreviewSession | null = null;
  private previewSummary: GcodeArtifactSummary | null = null;
  private previewOn = false;
  private previewUnsupportedReason: string | null = null;
  /** Fires when the preview session, view, or projection changes. */
  public onPreviewStateChanged: (() => void) | null = null;
  /** Injected by the shell: opens a standalone G-code picker. */
  public onRequestOpenGcode: (() => void) | null = null;
  /**
   * Injected by the shell: a right-click in the scene, already classified.
   *
   * The workspace owns picking, so it answers *what* was right-clicked and
   * leaves *what to offer* to the shell that owns the action catalog.
   */
  public onRequestSceneContextMenu: ((request: SceneContextRequest) => void) | null = null;
  private needsRecenter = false;

  public orbitControls: OrbitControls | null = null;
  private selectionCanvas: HTMLCanvasElement | null = null;
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
    this.previewSurfaceFactory =
      options.previewSurfaceFactory ?? ((surfaceOptions) => new GcodePreviewSurface(surfaceOptions));
    if (options.catalog) this.catalog = options.catalog;
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
          // Every selection path lands here — click, select-all, the Objects
          // tree, an action — so the outline follows the canonical selection
          // rather than the one call site that happened to change it.
          this.refreshSelectionOutlines();
          this.refreshXrSelectionFilaments();
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

  /** Read-only canonical transform of one instance, for diagnostics and E2E. */
  public getInstanceTransform(instanceId: InstanceId): Transform | undefined {
    return this.canonicalProject.getInstanceTransform(instanceId);
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

  /** Revision-bound layer events for the active plate, in print order. */
  public getLayerEventSnapshot(): CanonicalLayerEventSnapshot {
    return this.canonicalProject.getLayerEventSnapshot();
  }

  /**
   * Which event kinds the selected printer profile can actually perform.
   *
   * Pause, template, and colour change take their body from a profile setting;
   * when that setting is empty the engine emits an empty marker and the printer
   * does nothing. Offering such an event would be a silent no-op, so it is
   * reported as unsupported with the exact missing key instead.
   */
  public getLayerEventCapabilities(): readonly LayerEventCapability[] {
    const bodyKey: Readonly<Partial<Record<LayerEventType, string>>> = {
      pause: 'machine_pause_gcode',
      template: 'template_custom_gcode',
      'color-change': 'color_change_gcode',
    };
    return Object.freeze(
      (['pause', 'color-change', 'template', 'custom'] as const).map((type) => {
        const key = bodyKey[type];
        const value = key ? unambiguousProfileScalar(this.profile?.config[key]) : undefined;
        const supported = key === undefined || (value !== undefined && value.length > 0);
        return Object.freeze({
          type,
          label: LAYER_EVENT_LABELS[type],
          supported,
          ...(supported ? {} : { reason: `The selected printer profile has no ${key}.` }),
        });
      }),
    );
  }

  /**
   * One guarded layer-event change. Authoring an event changes what the machine
   * will do mid-print, so the published artifact is revalidated immediately:
   * the G-code on disk no longer matches the project that produced it.
   */
  public mutateLayerEvent(request: CanonicalLayerEventMutationRequest): void {
    this.canonicalProject.mutateLayerEvent(request);
    this.revalidatePublishedGcode();
    this.setStatus(
      request.operation === 'delete'
        ? 'Removed the layer event; slice again to apply it.'
        : request.operation === 'edit'
          ? 'Updated the layer event; slice again to apply it.'
          : `Added a ${LAYER_EVENT_LABELS[request.type]} at ${request.topZMm.toFixed(2)} mm; slice again to apply it.`,
    );
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
    this.setStatus(t('workspace.orcaWorkspace.updatedTheSelectedPartRole', 'Updated the selected part role.'));
  }

  public editSemanticLayerRange(request: CanonicalSemanticLayerRangeRequest): void {
    this.canonicalProject.editSemanticLayerRange(request);
    this.revalidatePublishedGcode();
    this.onSelectionChanged?.(false);
    this.setStatus(
      t('workspace.orcaWorkspace.updatedTheSelectedObjectHeight', 'Updated the selected object height ranges.'),
    );
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
          this.setStatus(
            t(
              'workspace.orcaWorkspace.profileCatalogFailedToLoad',
              'Profile catalog failed to load — check the connection and reload.',
            ),
          );
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
    for (const handle of this.toolButtons) handle.dispose();
    this.toolButtons = [];
    this.sceneGestureGuard.dispose();
    this.drag = null;
    this.cancelPaintStroke();
    this.paintOverlays.clear((overlay) => this.disposeOverlayResource(overlay));
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
    this.frameCameraView(view);
    this.setStatus(`View: ${view}`);
  }

  /**
   * Put the camera on one of the named views without announcing it.
   *
   * Every offset is a multiple of the plate's own span rather than a fixed
   * distance in metres, so a 400 mm bed is framed the same way a 180 mm one is:
   * filling the viewport, which is what a slicer's default view does. A fixed
   * 0.6 m happened to be right for a 200 mm plate and only for that.
   */
  public frameCameraView(view: string) {
    const cam = xb.core.camera;
    const t = this.plateFocus();
    const span = Math.max(this.bedMm.x, this.bedMm.y) * MM * WORKSPACE_SCALE;
    const R = span * 2.15;
    // Tiny Z on top/bottom avoids the straight-down gimbal lock in OrbitControls.
    const OFF: Record<string, [number, number, number]> = {
      default: [0, span, span * 1.7],
      top: [0, R, 0.0015],
      bottom: [0, -R, 0.0015],
      front: [0, span * 0.17, R],
      rear: [0, span * 0.17, -R],
      left: [-R, span * 0.17, 0],
      right: [R, span * 0.17, 0],
    };
    const o = OFF[view] ?? OFF.default;
    cam.position.set(t.x + o[0], t.y + o[1], t.z + o[2]);
    cam.lookAt(t);
    if (this.orbitControls) {
      this.orbitControls.target.copy(t);
      this.orbitControls.update();
    }
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
      this.setStatus(
        t('workspace.orcaWorkspace.selectAModelInstanceTo', 'Select a model instance to drop to the bed.'),
      );
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
      this.setStatus(t('workspace.orcaWorkspace.modelUnselected', 'Model unselected'));
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

  /**
   * A screen point where clicking really does hit this instance (automation).
   *
   * Where the model's *centre* projects is not the same question, and answering
   * that one is what made this necessary: the fixture's own model has a
   * projected centre that no ray through it intersects, which is ordinary for a
   * shape that is not convex. So this searches the model's projected extent and
   * returns a point **the picker itself confirms**, or null when there is
   * genuinely none — a browser test that clicks a guessed pixel is a test that
   * fails whenever the camera moves.
   */
  public getInstancePickPoint(instanceId: InstanceId): { clientX: number; clientY: number } | null {
    const canvas = this.selectionCanvas;
    const entry = this.models.find((model) => model.instanceId === instanceId);
    if (!canvas || !entry) return null;
    const rect = canvas.getBoundingClientRect();
    const box = new THREE.Box3().setFromObject(entry.display);
    if (box.isEmpty()) return null;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(xb.core.camera);
          const clientX = rect.left + ((projected.x + 1) / 2) * rect.width;
          const clientY = rect.top + ((1 - projected.y) / 2) * rect.height;
          left = Math.min(left, clientX);
          right = Math.max(right, clientX);
          top = Math.min(top, clientY);
          bottom = Math.max(bottom, clientY);
        }
      }
    }
    left = Math.max(left, rect.left);
    right = Math.min(right, rect.right);
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
    if (!(right > left) || !(bottom > top)) return null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const steps = 8;
    for (let row = 0; row <= steps; row += 1) {
      for (let column = 0; column <= steps; column += 1) {
        const clientX = left + ((right - left) * column) / steps;
        const clientY = top + ((bottom - top) * row) / steps;
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, xb.core.camera);
        if (raycaster.intersectObject(entry.display, true).length > 0) return { clientX, clientY };
      }
    }
    return null;
  }

  /** True when this instance is already part of the canonical selection. */
  private isInstanceSelected(instanceId: InstanceId): boolean {
    return this.canonicalProject.getSummary().selectedInstanceIds.includes(instanceId);
  }

  private setupSelectionRaycaster(canvas: HTMLCanvasElement) {
    this.selectionCanvas = canvas;
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
      if (!(this.tool in PAINT_TOOL_CHANNELS) || xb.core.renderer.xr.isPresenting || event.button !== 0) return;
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
      if (this.tool in PAINT_TOOL_CHANNELS) return;
      if (this.tool === 'lay_on_face') {
        const dragX = Math.abs(event.clientX - downX);
        const dragY = Math.abs(event.clientY - downY);
        if (dragX <= 10 && dragY <= 10) this.layPickedFacetOnBed(pointerRay(event));
        return;
      }
      if (this.tool === 'measure') {
        const dragX = Math.abs(event.clientX - downX);
        const dragY = Math.abs(event.clientY - downY);
        if (dragX <= 10 && dragY <= 10) this.pickMeasureFeature(pointerRay(event));
        return;
      }
      if (this.tool === 'brim_ears') {
        const dragX = Math.abs(event.clientX - downX);
        const dragY = Math.abs(event.clientY - downY);
        if (dragX <= 10 && dragY <= 10) this.placeBrimEar(pointerRay(event));
        return;
      }
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
      this.setStatus(t('workspace.orcaWorkspace.paintStrokeCancelled', 'Paint stroke cancelled.'));
    };
    /**
     * Right-click classifies what is under the pointer and selects it (P11.2).
     *
     * Selecting first is what makes the menu truthful: every object action is
     * gated on the selection, so a menu opened without selecting would offer
     * rows disabled for a reason the operator just disproved by clicking the
     * model. Upstream behaves the same way, and it is the behaviour that lets
     * one action model serve the menu bar and the right-click alike.
     */
    const onContextMenu = (event: MouseEvent) => {
      if (xb.core.renderer.xr.isPresenting) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, xb.core.camera);
      let target: ContextTarget = 'plate';
      let instanceId: InstanceId | null = null;
      for (const entry of this.models) {
        if (raycaster.intersectObject(entry.display, true).length > 0) {
          target = 'object';
          instanceId = entry.instanceId;
          // Additive selection is deliberately not honoured here: a right-click
          // that silently extended a selection would run the chosen action on
          // models the operator did not point at.
          if (!this.isInstanceSelected(entry.instanceId)) this.selectModel(entry, false);
          break;
        }
      }
      if (!this.onRequestSceneContextMenu) return;
      event.preventDefault();
      this.onRequestSceneContextMenu({ target, instanceId, clientX: event.clientX, clientY: event.clientY });
    };

    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onPaintEscape);
    this.lifecycleDisposers.push(() => {
      canvas.removeEventListener('contextmenu', onContextMenu);
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
  private xrSelectionFilamentContainer: UIPanel | null = null;

  // ---------------------------------------------------------------------------
  // Canonical colour painting (P4.2–P4.4)
  // ---------------------------------------------------------------------------

  private paintServiceInstance: PaintStrokeService | null = null;
  private paintOverlays = new PaintOverlayRegistry<THREE.Mesh, VolumeId, THREE.Mesh>();
  private paintPreviewOverlay: THREE.Mesh | null = null;
  private paintPreviewHiddenOverlay: THREE.Mesh | null = null;
  private paintStroke: {
    volumeId: VolumeId;
    display: THREE.Mesh;
    triangles: Set<number>;
    channel: PaintChannel;
    mode: 'paint' | 'erase';
    value?: JsonValue;
    refinement?: FacetRefinedRootSet;
    guard?: FacetAnnotationGuard;
    previousLocal?: THREE.Vector3;
    pointerId: number;
  } | null = null;
  private paintSettings: PaintToolSettings = { tool: 'circle', radiusMm: 4, smartFillAngleDegrees: 30 };
  private paintFilamentId: FilamentId | undefined;
  private paintMode: 'paint' | 'erase' = 'paint';
  private paintChannel: PaintChannel = 'color';
  /** Assigned state for the non-colour channels, e.g. support `enforce`. */
  private paintChannelValue: Record<Exclude<PaintChannel, 'color'>, JsonValue> = { ...DEFAULT_CHANNEL_VALUE };

  private get paintService(): PaintStrokeService {
    if (!this.paintServiceInstance) this.paintServiceInstance = this.canonicalProject.createPaintStrokeService();
    return this.paintServiceInstance;
  }

  /**
   * Painted-facet total of one channel (the active paint channel by default),
   * for diagnostics, automation, and end-to-end verification.
   */
  public getPaintedFacetCount(channel?: PaintChannel, plateId?: PlateId): number {
    const target = channel ?? PAINT_TOOL_CHANNELS[this.tool] ?? this.paintChannel;
    let total = 0;
    for (const snapshot of this.canonicalProject
      .getFacetOverlayByVolume(target, plateId ?? this.activePlateId)
      .values()) {
      if (snapshot.refinement) total += facetRefinementAssignedLeafCount(snapshot.refinement);
      else for (const assignment of snapshot.assignments) total += assignment.triangles.length;
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
    readonly channel: PaintChannel;
    readonly channelState: JsonValue;
  } {
    return Object.freeze({
      settings: Object.freeze({ ...this.paintSettings }),
      ...(this.paintFilamentId ? { filamentId: this.paintFilamentId } : {}),
      mode: this.paintMode,
      active: this.tool in PAINT_TOOL_CHANNELS,
      channel: this.paintChannel,
      channelState:
        this.paintChannel === 'color'
          ? (this.paintFilamentId ?? null)
          : this.paintChannelValue[this.paintChannel as Exclude<PaintChannel, 'color'>],
    });
  }

  /** Select the facet channel the next stroke authors. */
  public setPaintChannel(channel: PaintChannel): void {
    this.paintChannel = channel;
    if (channel !== 'color' && this.paintMode === 'paint') {
      this.paintChannelValue[channel as Exclude<PaintChannel, 'color'>] ??=
        DEFAULT_CHANNEL_VALUE[channel as Exclude<PaintChannel, 'color'>];
    }
    this.refreshPaintOverlays();
    this.onPaintStateChanged?.();
  }

  /** Choose the assigned state for a non-colour channel (enforce/block, ...). */
  public setPaintChannelState(state: JsonValue): void {
    if (this.paintChannel === 'color') return;
    this.paintChannelValue[this.paintChannel as Exclude<PaintChannel, 'color'>] = state;
    this.paintMode = 'paint';
    this.setStatus(`Paint ${channelLabel(this.paintChannel)}: ${String(state)}`);
    this.onPaintStateChanged?.();
  }

  /** Value the next stroke assigns, or undefined when erasing. */
  private activePaintValue(): JsonValue | undefined {
    if (this.paintMode === 'erase') return undefined;
    if (this.paintChannel === 'color') return this.paintFilamentId;
    return this.paintChannelValue[this.paintChannel as Exclude<PaintChannel, 'color'>];
  }

  /** Choose the stable filament a stroke assigns; `undefined` erases. */
  public setPaintFilament(filamentId: FilamentId | undefined): void {
    if (filamentId) {
      const entry = this.getPaintPalette(true).entries.find(
        (candidate: PaintPalette['entries'][number]) => candidate.filamentId === filamentId,
      );
      if (!entry) {
        this.setStatus(t('workspace.orcaWorkspace.thatFilamentIsNotIn', 'That filament is not in this project.'));
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
      this.setStatus(t('workspace.orcaWorkspace.paintColourEraseToDefault', 'Paint colour: erase to default'));
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
      this.setStatus(`Select a model to erase its ${channelLabel(this.paintChannel)} painting.`);
      return 0;
    }
    let cleared = 0;
    for (const volumeId of volumes) {
      const result = this.paintService.clearVolume(volumeId, this.paintChannel);
      if (result.status === 'applied') cleared += 1;
    }
    this.refreshPaintOverlays();
    this.setStatus(
      cleared > 0
        ? `Erased ${channelLabel(this.paintChannel)} painting on ${cleared} part(s).`
        : 'Nothing was painted.',
    );
    return cleared;
  }

  // ---------------------------------------------------------------------
  // Smart Paint (P4.9). The assistant only proposes; every mutation below
  // goes through the same canonical paint service manual strokes use.
  // ---------------------------------------------------------------------

  private smartPaintSessionInstance: AiPaintSession | null = null;
  private smartPaintConsent: { geometry: boolean; image: boolean } = { geometry: false, image: false };
  private smartPaintPrompt = '';
  private smartPaintImageBase64: string | undefined;
  private smartPaintBusy = false;
  private smartPaintError: string | undefined;
  public onSmartPaintStateChanged: (() => void) | null = null;

  private get smartPaintSession(): AiPaintSession {
    if (!this.smartPaintSessionInstance) {
      this.smartPaintSessionInstance = this.canonicalProject.createAiPaintSession(new LazyGeminiAiPaintPort());
    }
    return this.smartPaintSessionInstance;
  }

  /** Everything a Smart Paint surface renders; no value is invented here. */
  public getSmartPaintSnapshot(): SmartPaintSnapshot {
    const volumes = this.paintableSelectedVolumes();
    const preview = this.smartPaintSessionInstance?.current;
    return Object.freeze({
      providerId: GEMINI_PAINT_PROVIDER_ID,
      ...(volumes.length === 1
        ? {}
        : {
            unavailableReason:
              volumes.length === 0
                ? 'Select one model part to use Smart Paint.'
                : `Smart Paint works on one part at a time; ${volumes.length} are selected.`,
          }),
      channel: this.paintChannel,
      consent: Object.freeze({ ...this.smartPaintConsent }),
      prompt: this.smartPaintPrompt,
      imageAttached: this.smartPaintImageBase64 !== undefined,
      busy: this.smartPaintBusy,
      ...(this.smartPaintError ? { error: this.smartPaintError } : {}),
      ...(preview
        ? {
            preview: Object.freeze({
              channel: preview.channel,
              coverage: preview.coverage,
              confidence: preview.confidence,
              unassignedFacetCount: preview.unassignedTriangleCount,
              assignable: preview.assignable,
              regions: Object.freeze(
                preview.regions.map((region) =>
                  Object.freeze({
                    id: region.id,
                    label: region.label,
                    confidence: region.confidence,
                    coverage: region.coverage,
                    facetCount: region.triangleIndices.length,
                    value: (region.value ?? null) as string | boolean | null,
                  }),
                ),
              ),
            }),
          }
        : {}),
    });
  }

  public setSmartPaintConsent(next: { geometry?: boolean; image?: boolean }): void {
    this.smartPaintConsent = {
      geometry: next.geometry ?? this.smartPaintConsent.geometry,
      image: next.image ?? this.smartPaintConsent.image,
    };
    this.onSmartPaintStateChanged?.();
  }

  public setSmartPaintPrompt(prompt: string): void {
    this.smartPaintPrompt = prompt;
    this.onSmartPaintStateChanged?.();
  }

  public attachSmartPaintImage(imageBase64: string | null): void {
    this.smartPaintImageBase64 = imageBase64 ?? undefined;
    if (imageBase64 === null) this.smartPaintConsent = { ...this.smartPaintConsent, image: false };
    this.onSmartPaintStateChanged?.();
  }

  /** Ask the assistant. Canonical state is untouched on every outcome. */
  public async requestSmartPaint(): Promise<void> {
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length !== 1) {
      this.smartPaintError = 'Select exactly one model part before asking the assistant.';
      this.onSmartPaintStateChanged?.();
      return;
    }
    this.smartPaintBusy = true;
    this.smartPaintError = undefined;
    this.onSmartPaintStateChanged?.();
    try {
      const outcome = await this.smartPaintSession.request({
        volumeId: volumes[0],
        channel: this.paintChannel,
        prompt: this.smartPaintPrompt,
        ...(this.smartPaintImageBase64 !== undefined ? { imageBase64: this.smartPaintImageBase64 } : {}),
        consent: {
          ...this.smartPaintConsent,
          providerId: GEMINI_PAINT_PROVIDER_ID,
          grantedAt: new Date().toISOString(),
        },
      });
      if (outcome.status === 'failed') {
        this.smartPaintError = outcome.message;
        this.setStatus(`Smart Paint: ${outcome.message}`);
      } else if (outcome.status === 'cancelled') {
        this.setStatus(
          t('workspace.orcaWorkspace.smartPaintWasCancelledNothing', 'Smart Paint was cancelled; nothing changed.'),
        );
      } else {
        this.setStatus(
          `Smart Paint proposed ${outcome.preview.regions.length} region(s). Choose a destination, then apply.`,
        );
      }
    } finally {
      this.smartPaintBusy = false;
      this.refreshSmartPaintPreview();
      this.onSmartPaintStateChanged?.();
    }
  }

  public assignSmartPaintRegion(regionId: string, value: string | boolean | null): void {
    if (!this.smartPaintSessionInstance?.current) return;
    this.smartPaintSessionInstance.assignRegion(regionId, (value ?? undefined) as never);
    this.refreshSmartPaintPreview();
    this.onSmartPaintStateChanged?.();
  }

  /** Drop the mask. There is nothing to unwind, because nothing was applied. */
  public cancelSmartPaint(): void {
    this.smartPaintSessionInstance?.cancel();
    this.smartPaintError = undefined;
    this.clearPaintPreview();
    this.setStatus(
      t('workspace.orcaWorkspace.smartPaintMaskDiscardedThe', 'Smart Paint mask discarded; the project is unchanged.'),
    );
    this.onSmartPaintStateChanged?.();
  }

  /** Commit the corrected mask as exactly one undoable command. */
  public applySmartPaint(): void {
    const session = this.smartPaintSessionInstance;
    if (!session?.current) return;
    const outcome = session.apply();
    switch (outcome.status) {
      case 'applied':
        this.setStatus(`Smart Paint applied to ${outcome.facetCount} facet(s). Undo restores the previous painting.`);
        break;
      case 'stale':
        this.smartPaintError = 'The project changed while the mask was open; ask again before applying.';
        this.setStatus(this.smartPaintError);
        break;
      case 'cancelled':
        this.setStatus(
          t('workspace.orcaWorkspace.smartPaintWasCancelledNothing2', 'Smart Paint was cancelled; nothing changed.'),
        );
        break;
      default:
        this.setStatus(
          t(
            'workspace.orcaWorkspace.chooseADestinationForAt',
            'Choose a destination for at least one region before applying.',
          ),
        );
    }
    this.clearPaintPreview();
    this.refreshPaintOverlays();
    this.refreshSmartPaintPreview();
    this.onSmartPaintStateChanged?.();
  }

  /** Draw the current mask over the model, using each region's destination. */
  private refreshSmartPaintPreview(): void {
    const preview = this.smartPaintSessionInstance?.current;
    if (!preview) {
      this.clearPaintPreview();
      return;
    }
    const target = this.paintTargets().find((record) => record.volumeId === preview.volumeId);
    if (!target) {
      this.clearPaintPreview();
      return;
    }
    const colors = channelOverlayColors(preview.channel, paintPaletteColors(this.getPaintPalette(true)));
    const assignments: { triangles: number[]; value: string }[] = [];
    const colorByKey = new Map<string, string>();
    for (const region of preview.regions) {
      if (region.triangleIndices.length === 0) continue;
      const key = `smart:${region.id}`;
      // An unassigned region still previews, in neutral white, so the operator
      // can see what the assistant found before choosing a destination.
      colorByKey.set(key, region.value === undefined ? '#ffffff' : (colors.get(String(region.value)) ?? '#ffffff'));
      assignments.push({ triangles: [...region.triangleIndices], value: key });
    }
    if (assignments.length === 0) {
      this.clearPaintPreview();
      return;
    }
    this.clearPaintPreview();
    const geometry = this.buildPaintOverlayGeometry(target.display, assignments, colorByKey);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, PAINT_PREVIEW_MATERIAL.clone());
    mesh.name = 'smart-paint-preview';
    mesh.raycast = () => {};
    mesh.renderOrder = 3;
    target.display.add(mesh);
    this.paintPreviewOverlay = mesh;
  }

  // ---------------------------------------------------------------------
  // Measure (P5.3.1). Picks resolve to canonical surface features in world
  // millimetres; nothing here mutates the project.
  // ---------------------------------------------------------------------

  private measureExtractors = new Map<string, SurfaceFeatureExtractor>();
  private measurePicks: { feature: SurfaceFeature; instanceId?: InstanceId }[] = [];
  public onMeasureStateChanged: (() => void) | null = null;

  /** Activate the measurement tool and start a fresh pair of picks. */
  public measureTool(): void {
    this.setTool('measure');
    this.measurePicks = [];
    this.setStatus(
      t(
        'workspace.orcaWorkspace.measureClickTwoFeaturesA',
        'Measure: click two features (a face, edge, corner, or hole).',
      ),
    );
    this.onMeasureStateChanged?.();
  }

  public clearMeasureSelection(): void {
    this.measurePicks = [];
    this.setStatus(t('workspace.orcaWorkspace.measurementCleared', 'Measurement cleared.'));
    this.onMeasureStateChanged?.();
  }

  public getMeasureSnapshot(): MeasureSnapshot {
    const active = this.tool === 'measure';
    const picks = this.measurePicks.map(({ feature }) => ({
      kind: feature.kind,
      summary: describeSurfaceFeature(feature),
      ...(feature.kind === 'circle' ? { diameterMm: feature.radius * 2 } : {}),
    }));
    if (this.measurePicks.length < 2) {
      return Object.freeze({
        active,
        picks: Object.freeze(picks),
        hint: active
          ? this.measurePicks.length === 0
            ? 'Click the first feature to measure from.'
            : 'Click the second feature to measure to.'
          : 'Choose the Measure tool, then click two features.',
      });
    }
    const result = measureSurfaceFeatures(this.measurePicks[0].feature, this.measurePicks[1].feature);
    const distance = result.distanceStrict ?? result.distanceInfinite;
    // Drawn as well as reported. Upstream annotates the model, and until now
    // the answer existed only in a DOM panel — which is also the reason the
    // measure actions were withheld from XR.
    this.drawMeasureAnnotation(distance ?? null);
    return Object.freeze({
      active,
      picks: Object.freeze(picks),
      ...(distance ? { distanceMm: distance.distance } : {}),
      ...(distance ? { distanceKind: result.distanceStrict ? ('strict' as const) : ('infinite' as const) } : {}),
      ...(result.distanceXyz
        ? { distanceXyzMm: Object.freeze([...result.distanceXyz] as [number, number, number]) }
        : {}),
      ...(result.angle ? { angleDeg: (result.angle.angle * 180) / Math.PI } : {}),
      ...(result.unsupported === 'non-parallel-circle-pair'
        ? {
            unsupportedReason:
              'Two circles in non-parallel planes need the engine’s polynomial solver, which this build does not carry.',
          }
        : {}),
      hint: 'Click another feature to start a new measurement.',
    });
  }

  /** Scene group holding the current measurement's line and label. */
  private measureAnnotation: THREE.Group | null = null;

  /**
   * Draw the measurement on the model (P5.3.1).
   *
   * A line between the two points the engine actually measured between, and the
   * distance beside it. The endpoints come from the measurement result rather
   * than from the picked features, because those differ: a point-to-plane
   * distance is measured to the *foot* of the perpendicular, and drawing to the
   * plane's origin instead would show a line that is not the length reported
   * next to it.
   *
   * Removed and rebuilt on every call rather than updated, because a stale
   * annotation left beside a new number is worse than none.
   */
  private drawMeasureAnnotation(
    distance: { readonly distance: number; readonly from: Vec3; readonly to: Vec3 } | null,
  ): void {
    if (this.measureAnnotation) {
      this.workspace.remove(this.measureAnnotation);
      this.measureAnnotation.traverse((node) => {
        if (node instanceof THREE.Line) node.geometry.dispose();
        if (node instanceof THREE.Sprite) {
          const material = node.material as THREE.SpriteMaterial;
          material.map?.dispose();
          material.dispose();
        }
      });
      this.measureAnnotation = null;
    }
    if (!distance) return;

    const scale = CURRENT_THREE_WORLD_UNITS_PER_MM;
    const from = new THREE.Vector3(distance.from[0] * scale, distance.from[1] * scale, distance.from[2] * scale);
    const to = new THREE.Vector3(distance.to[0] * scale, distance.to[1] * scale, distance.to[2] * scale);
    const group = new THREE.Group();
    group.name = 'measureAnnotation';
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from, to]),
      new THREE.LineBasicMaterial({ color: 0xffc107, depthTest: false, transparent: true }),
    );
    // Drawn over the model on purpose: a dimension hidden inside the geometry
    // it describes is a dimension nobody can read.
    line.renderOrder = 3;
    line.raycast = () => {};
    group.add(line);

    const label = this.makeLabelSprite(`${Number(distance.distance.toFixed(3))} mm`);
    label.position.copy(from.clone().add(to).multiplyScalar(0.5));
    label.renderOrder = 4;
    group.add(label);
    this.workspace.add(group);
    this.measureAnnotation = group;
  }

  /**
   * Which pinned assembly alignments the two picks allow. The second pick's
   * instance is the one that would move, so a pair on one instance offers
   * nothing to align.
   */
  public getAssemblySnapshot(): AssemblySnapshot {
    if (this.measurePicks.length < 2) {
      return Object.freeze({
        available: Object.freeze({ ...EMPTY_ASSEMBLY_AVAILABILITY }),
        movable: false,
        hint: 'Pick two faces — the second one moves.',
      });
    }
    const [first, second] = this.measurePicks;
    const availability = inspectAssemblyActions(first.feature, second.feature);
    const movable = Boolean(second.instanceId) && second.instanceId !== first.instanceId;
    return Object.freeze({
      available: availability,
      movable,
      hint: movable
        ? 'Choose an alignment; it commits as one undoable move.'
        : 'Pick two faces on different models to align them.',
    });
  }

  /** Commit one pinned alignment as a single undoable instance transform. */
  public applyAssemblyAlignment(kind: AssemblyAlignmentKind, parameter?: number): boolean {
    if (this.measurePicks.length < 2) {
      this.setStatus(t('workspace.orcaWorkspace.pickTwoFacesBeforeAligning', 'Pick two faces before aligning.'));
      return false;
    }
    const [first, second] = this.measurePicks;
    const target = second.instanceId;
    if (!target || target === first.instanceId) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.assemblyAlignmentNeedsTwoFaces',
          'Assembly alignment needs two faces on different models.',
        ),
      );
      return false;
    }
    const current = this.canonicalProject.getInstanceTransform(target);
    if (!current) {
      this.setStatus(t('workspace.orcaWorkspace.theModelToAlignIs', 'The model to align is no longer on this plate.'));
      return false;
    }
    try {
      const plan = planAssemblyAlignment({
        kind,
        first: first.feature,
        second: second.feature,
        movingTransform: current,
        ...(parameter !== undefined ? { parameter } : {}),
      });
      if (plan.noop) {
        this.setStatus(
          t('workspace.orcaWorkspace.thoseFacesAreAlreadyAligned', 'Those faces are already aligned; nothing moved.'),
        );
        return false;
      }
      this.canonicalProject.setInstanceTransform(target, plan.transform);
      this.recomputePreflight();
      // The picks describe where the faces *were*; keep them honest.
      this.measurePicks = [];
      this.setStatus(`Applied ${kind.replaceAll('-', ' ')}. Undo restores the previous placement.`);
      this.onMeasureStateChanged?.();
      return true;
    } catch (error) {
      this.setStatus(`Alignment failed: ${(error as Error).message}`);
      this.onMeasureStateChanged?.();
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Brim ears (P5.3.6). Each placement is one undoable canonical command.
  // ---------------------------------------------------------------------

  private brimEarRadiusMm = 5;
  public onBrimEarStateChanged: (() => void) | null = null;

  /**
   * Adopt the filaments a connected printer reports as loaded. The caller
   * supplies the slots it read, so this stays testable and the transport stays
   * out of the workspace.
   */
  public syncFilamentsFromPrinter(
    slots: readonly {
      slotIndex: number;
      colorHex: string;
      material: string;
      subType?: string;
      vendor: string;
    }[],
  ): boolean {
    if (slots.length === 0) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.thePrinterReportedNoLoaded',
          'The printer reported no loaded filament slots; nothing was changed.',
        ),
      );
      return false;
    }
    try {
      const summary = this.canonicalProject.syncPhysicalFilamentsFromPrinter(
        slots.map((slot) => ({
          toolId: slot.slotIndex,
          color: slot.colorHex,
          material: slot.material,
          ...(slot.subType ? { subType: slot.subType } : {}),
          ...(slot.vendor ? { vendor: slot.vendor } : {}),
        })),
      );
      // A tool the printer did not report is kept, not deleted: objects may be
      // assigned to it, and an empty slot is not a reason to strip that.
      const extra =
        summary.extra.length > 0
          ? ` ${summary.extra.length} project tool(s) are not loaded in the printer and were kept.`
          : '';
      const changed = summary.applied.length + summary.added.length;
      if (changed === 0) {
        this.setStatus(`Project filaments already match the printer.${extra}`);
        return false;
      }
      // The canonical filaments now say what the printer reported, but on a
      // catalog-driven profile the *bound filament preset* is what supplies the
      // material the slice is checked against, and it still names whatever the
      // profile defaulted to. Leaving the two disagreeing reported the machine's
      // own filament as unsupported ("PLA is not supported on tool 1"), and the
      // next profile touch would have overwritten the sync outright, because
      // `applyLiveSlicingConfiguration` rebuilds canonical filaments from the
      // palette and the head presets.
      const rebound = this.adoptPrinterFilamentPresets(slots);
      this.refreshPaintOverlays();
      this.recomputePreflight();
      this.onProfileChanged?.();
      const parts = [
        summary.applied.length > 0 ? `updated ${summary.applied.length}` : '',
        summary.added.length > 0 ? `added ${summary.added.length}` : '',
      ].filter(Boolean);
      const unmatched =
        rebound.unmatched.length > 0
          ? ` No filament preset for ${rebound.unmatched
              .map((entry) => `${entry.material} on tool ${entry.toolId + 1}`)
              .join(', ')} is available for this printer and process, so ${
              rebound.unmatched.length === 1 ? 'that tool keeps' : 'those tools keep'
            } the previous preset — pick one, or the slice will refuse the mismatch.`
          : '';
      // Rebinding a preset is its own canonical change, so the sync is no longer
      // a single undo step and saying otherwise would be wrong.
      const undo =
        rebound.rebound.length > 0
          ? ` Tool ${rebound.rebound.map((toolId) => toolId + 1).join(', ')} also moved to a matching filament preset; undo steps back through both changes.`
          : ' Undo restores the previous palette.';
      this.setStatus(`Synced filaments from the printer: ${parts.join(' and ')}.${undo}${extra}${unmatched}`);
      return true;
    } catch (error) {
      this.setStatus(`Filament sync failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Point each reported tool at a filament preset that actually declares the
   * material the printer says is loaded, and adopt its colour.
   *
   * Only the catalog-driven path needs this: an imported project's embedded
   * filament configuration is its own preflight authority, and the canonical
   * sync already updated `filament_type` there. A material with no compatible
   * preset is reported rather than silently bound to something else.
   */
  private adoptPrinterFilamentPresets(
    slots: readonly { slotIndex: number; colorHex: string; material: string; subType?: string; vendor?: string }[],
  ): {
    rebound: number[];
    unmatched: Array<{ toolId: number; material: string }>;
  } {
    const rebound: number[] = [];
    const unmatched: Array<{ toolId: number; material: string }> = [];
    const profile = this.profile;
    if (!profile || this.importedProjectOwnsSlicingConfiguration) return { rebound, unmatched };

    const candidates = this.filamentPresetCandidates(profile);
    const nextPresetIds = this.headFilaments.map((selection) => selection.presetId);
    let changed = false;
    for (const slot of slots) {
      const toolId = slot.slotIndex;
      if (toolId < 0 || toolId >= this.headFilaments.length) continue;
      if (slot.colorHex) this.palette.setColor(toolId, slot.colorHex);
      const reported: ReportedFilamentSlot = {
        material: slot.material.trim(),
        ...(slot.subType?.trim() ? { subType: slot.subType.trim() } : {}),
        ...(slot.vendor?.trim() ? { vendor: slot.vendor.trim() } : {}),
      };
      if (!reported.material) continue;
      // A preset the machine's own facts already describe is the operator's to
      // keep: an unreported grade must not drag a deliberate Silk choice back
      // to the plain preset. Only a preset the report contradicts is rebound.
      const bound = candidates.find((candidate) => candidate.presetId === nextPresetIds[toolId]);
      if (bound && filamentPresetAgreesWithSlot(bound, reported)) continue;
      const match = matchFilamentPreset(candidates, reported);
      if (!match) {
        unmatched.push({ toolId, material: slot.material });
        continue;
      }
      if (nextPresetIds[toolId] === match.presetId) continue;
      nextPresetIds[toolId] = match.presetId;
      rebound.push(toolId);
      changed = true;
    }
    if (changed) this.selectProfilePresets({ filamentPresetIds: nextPresetIds });
    else this.applyLiveSlicingConfiguration();
    return { rebound, unmatched };
  }

  /** Every filament preset the active printer and process can actually use. */
  private filamentPresetCandidates(profile: SlicerProfile): FilamentPresetCandidate<WorkspacePresetId>[] {
    if (!profile.machinePresetId || !profile.processPresetId) return [];
    const candidates: FilamentPresetCandidate<WorkspacePresetId>[] = [];
    for (const candidate of this.catalog.profiles) {
      if (
        candidate.machinePresetId !== profile.machinePresetId ||
        candidate.processPresetId !== profile.processPresetId ||
        !candidate.filamentPresetId
      ) {
        continue;
      }
      const material = unambiguousProfileScalar(candidate.config['filament_type'])?.trim();
      if (!material) continue;
      candidates.push({
        presetId: candidate.filamentPresetId as WorkspacePresetId,
        presetName: candidate.filamentPresetName ?? candidate.filamentName,
        material,
        ...(candidate.filamentVendor ? { vendor: candidate.filamentVendor } : {}),
      });
    }
    return candidates;
  }

  private embossFont?: { name: string; source: GlyphOutlineSource };
  private embossRecipe: EmbossTextConfiguration = {
    text: 'Text',
    styleName: '',
    fontDescriptor: '',
    fontDescriptorType: 'file_name',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: DEFAULT_EMBOSS_PROJECTION,
  };
  public onEmbossStateChanged: (() => void) | null = null;

  public embossTool(): void {
    this.setTool('emboss');
    this.setStatus(
      this.embossFont
        ? 'Emboss: type the text, then add it to the selected part.'
        : 'Emboss: choose a .ttf font file first — the browser cannot read your installed fonts.',
    );
    this.onEmbossStateChanged?.();
  }

  /**
   * Load a font the operator chose. Nothing is fetched: a browser cannot list
   * installed fonts and the app CSP forbids requesting one, so the bytes always
   * come from a file the operator picked.
   */
  public loadEmbossFont(name: string, bytes: Uint8Array): boolean {
    try {
      const source = readTrueTypeOutlines(bytes, this.embossRecipe.font.collection);
      this.embossFont = { name, source };
      this.embossRecipe = {
        ...this.embossRecipe,
        styleName: this.embossRecipe.styleName || name,
        fontDescriptor: name,
        fontDescriptorType: 'file_name',
      };
      this.setStatus(`Loaded ${name} for embossing.`);
      this.onEmbossStateChanged?.();
      return true;
    } catch (error) {
      this.setStatus(`Could not read that font: ${(error as Error).message}`);
      this.onEmbossStateChanged?.();
      return false;
    }
  }

  /** Merge a partial recipe change without losing the rest of the settings. */
  public setEmbossRecipe(patch: EmbossRecipePatch): void {
    const { font, projection, ...rest } = patch;
    this.embossRecipe = {
      ...this.embossRecipe,
      ...rest,
      font: { ...this.embossRecipe.font, ...(font ?? {}) },
      projection: { ...this.embossRecipe.projection, ...(projection ?? {}) },
    };
    this.onEmbossStateChanged?.();
  }

  public getEmbossSnapshot(): EmbossSnapshot {
    const objectId = this.brimEarTargetObject();
    const volumeId = this.embossTargetVolume();
    return Object.freeze({
      active: this.tool === 'emboss',
      ...(objectId ? { objectId } : {}),
      ...(volumeId ? { volumeId } : {}),
      ...(this.embossFont ? { fontName: this.embossFont.name } : {}),
      configuration: Object.freeze({ ...this.embossRecipe }),
      hint: !this.embossFont
        ? 'Choose a .ttf font file; the browser cannot read the fonts installed on this machine.'
        : volumeId
          ? 'Editing the selected text re-cuts its mesh; undo restores the previous cut.'
          : objectId
            ? 'Adds the text as a new part of the selected model.'
            : 'Select one model part to add the text to.',
    });
  }

  /** Add the current recipe to the selected object, or re-cut a selected text part. */
  public applyEmboss(): boolean {
    const font = this.embossFont;
    if (!font) {
      this.setStatus(t('workspace.orcaWorkspace.chooseATtfFontFile', 'Choose a .ttf font file before embossing.'));
      return false;
    }
    const volumeId = this.embossTargetVolume();
    try {
      const mesh = volumeId
        ? this.canonicalProject.editEmbossText(volumeId, this.embossRecipe, font.source)
        : this.addEmbossToSelectedObject(font.source);
      if (!mesh) return false;
      const notes: string[] = [];
      if (mesh.missingCodePoints.length > 0) {
        notes.push(
          `${font.name} has no glyph for ${mesh.missingCodePoints
            .map((point) => String.fromCodePoint(point))
            .join(' ')}`,
        );
      }
      // An open mesh still prints, but it prints wrong; say so rather than let
      // the slicer quietly repair it into something the operator did not ask for.
      if (mesh.openEdgeCount > 0) notes.push(`${mesh.openEdgeCount} edges did not close`);
      this.setStatus(
        notes.length > 0
          ? `Embossed the text — ${notes.join('; ')}.`
          : `Embossed the text as ${mesh.triangleCount} triangles.`,
      );
      this.onEmbossStateChanged?.();
      return true;
    } catch (error) {
      this.setStatus(`Emboss failed: ${(error as Error).message}`);
      return false;
    }
  }

  private addEmbossToSelectedObject(source: GlyphOutlineSource): EmbossedMesh | undefined {
    const objectId = this.brimEarTargetObject();
    if (!objectId) {
      this.setStatus(
        t('workspace.orcaWorkspace.selectOneModelPartTo', 'Select one model part to add embossed text to.'),
      );
      return undefined;
    }
    return this.canonicalProject.addEmbossText(objectId, this.embossRecipe, source).mesh;
  }

  /** The selected volume, when it is itself embossed text an edit would re-cut. */
  private embossTargetVolume(): VolumeId | undefined {
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length !== 1) return undefined;
    return this.canonicalProject.getEmbossText(volumes[0]) ? volumes[0] : undefined;
  }

  private svgDrawing?: { name: string; source: string };
  private svgDepthMm = 2;
  private svgWidthMm?: number;
  public onSvgStateChanged: (() => void) | null = null;

  /**
   * Ask the shell to build, preview, and export a diagnostics bundle.
   *
   * The workspace owns the facts, not the file: the shell decides how to show
   * the privacy preview and how to hand over a download, because both differ
   * between DOM and XR and neither belongs in canonical logic.
   */
  public onRequestDiagnosticsExport: (() => Promise<void> | void) | null = null;

  public exportDiagnostics(): void {
    if (!this.onRequestDiagnosticsExport) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.diagnosticsExportIsUnavailableIn',
          'Diagnostics export is unavailable in this shell.',
        ),
      );
      return;
    }
    void this.onRequestDiagnosticsExport();
  }

  /** The project's shape, with no geometry: counts and names only. */
  public diagnosticsProjectSummary(): ProjectSummaryInput {
    return this.canonicalProject.diagnosticsProjectSummary();
  }

  public svgPartTool(): void {
    this.setTool('svg');
    this.setStatus(
      this.svgDrawing
        ? 'SVG part: set the size, then add it to the selected part.'
        : 'SVG part: choose an .svg file to cut.',
    );
    this.onSvgStateChanged?.();
  }

  /** Load a drawing the operator picked. Nothing is fetched. */
  public loadSvgDrawing(name: string, source: string): boolean {
    try {
      const shapes = readSvgShapes(source);
      this.svgDrawing = { name, source };
      const notes = shapes.unsupported.length > 0 ? ` ${shapes.unsupported.length} part(s) of it cannot be cut.` : '';
      this.setStatus(`Loaded ${name} at ${shapes.sizeMm[0].toFixed(1)} x ${shapes.sizeMm[1].toFixed(1)} mm.${notes}`);
      this.onSvgStateChanged?.();
      return true;
    } catch (error) {
      this.svgDrawing = undefined;
      this.setStatus(`Could not read that drawing: ${(error as Error).message}`);
      this.onSvgStateChanged?.();
      return false;
    }
  }

  public setSvgPartSize(patch: { depthMm?: number; widthMm?: number }): void {
    if (patch.depthMm !== undefined) this.svgDepthMm = patch.depthMm;
    if (patch.widthMm !== undefined) this.svgWidthMm = patch.widthMm > 0 ? patch.widthMm : undefined;
    this.onSvgStateChanged?.();
  }

  public getSvgPartSnapshot(): SvgPartSnapshot {
    const objectId = this.brimEarTargetObject();
    const volumeId = this.svgTargetVolume();
    let unsupported: readonly { element: string; detail: string }[] = [];
    if (this.svgDrawing) {
      try {
        unsupported = readSvgShapes(this.svgDrawing.source).unsupported.map((entry) => ({
          element: entry.element,
          detail: entry.detail,
        }));
      } catch {
        unsupported = [];
      }
    }
    return Object.freeze({
      active: this.tool === 'svg',
      ...(objectId ? { objectId } : {}),
      ...(volumeId ? { volumeId } : {}),
      ...(this.svgDrawing ? { fileName: this.svgDrawing.name } : {}),
      depthMm: this.svgDepthMm,
      ...(this.svgWidthMm !== undefined ? { widthMm: this.svgWidthMm } : {}),
      unsupported: Object.freeze(unsupported),
      hint: !this.svgDrawing
        ? 'Choose an .svg file; its filled shapes become a solid part.'
        : volumeId
          ? 'Changing the size re-cuts the selected part; undo restores it.'
          : objectId
            ? 'Adds the drawing as a new part of the selected model.'
            : 'Select one model part to add the drawing to.',
    });
  }

  /** Cut the loaded drawing into the selection, or re-cut a selected SVG part. */
  public applySvgPart(): boolean {
    const drawing = this.svgDrawing;
    if (!drawing) {
      this.setStatus(t('workspace.orcaWorkspace.chooseAnSvgFileBefore', 'Choose an .svg file before adding a part.'));
      return false;
    }
    const options = {
      fileName: drawing.name,
      depthMm: this.svgDepthMm,
      ...(this.svgWidthMm !== undefined ? { widthMm: this.svgWidthMm } : {}),
    };
    try {
      const volumeId = this.svgTargetVolume();
      let prepared;
      if (volumeId) {
        prepared = this.canonicalProject.editSvgPart(volumeId, drawing.source, options);
      } else {
        const objectId = this.brimEarTargetObject();
        if (!objectId) {
          this.setStatus(
            t('workspace.orcaWorkspace.selectOneModelPartTo2', 'Select one model part to add the drawing to.'),
          );
          return false;
        }
        prepared = this.canonicalProject.addSvgPart(objectId, drawing.source, options).prepared;
      }
      // Anything the drawing asked for that a solid cannot express is named
      // rather than quietly missing from the result.
      const notes = prepared.unsupported.length > 0 ? ` Not cut: ${prepared.unsupported[0].detail}` : '';
      const open = prepared.mesh.openEdgeCount > 0 ? ` ${prepared.mesh.openEdgeCount} edges did not close.` : '';
      this.setStatus(
        `Cut ${drawing.name} at ${prepared.sizeMm[0].toFixed(1)} x ${prepared.sizeMm[1].toFixed(1)} mm.${notes}${open}`,
      );
      this.onSvgStateChanged?.();
      return true;
    } catch (error) {
      this.setStatus(`SVG part failed: ${(error as Error).message}`);
      return false;
    }
  }

  private svgTargetVolume(): VolumeId | undefined {
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length !== 1) return undefined;
    return this.canonicalProject.getSvgPart(volumes[0]) ? volumes[0] : undefined;
  }

  /**
   * One call for both halves of an ear change: the panel and the model.
   *
   * They are wired together rather than side by side deliberately — a preview
   * that can be updated independently of the list is a preview that will
   * eventually disagree with it, and the whole point of this one is to be
   * believed.
   */
  private notifyBrimEarChange(): void {
    this.refreshBrimEarPreview();
    this.onBrimEarStateChanged?.();
  }

  public brimEarsTool(): void {
    this.setTool('brim_ears');
    this.setStatus(
      t('workspace.orcaWorkspace.brimEarsClickTheModel', 'Brim ears: click the model where an ear should sit.'),
    );
    this.notifyBrimEarChange();
  }

  public setBrimEarRadius(radiusMm: number): void {
    if (!Number.isFinite(radiusMm) || radiusMm < BRIM_EAR_MIN_RADIUS_MM || radiusMm > BRIM_EAR_MAX_RADIUS_MM) {
      this.setStatus(`A brim ear radius must be between ${BRIM_EAR_MIN_RADIUS_MM} and ${BRIM_EAR_MAX_RADIUS_MM} mm.`);
      return;
    }
    this.brimEarRadiusMm = radiusMm;
    this.notifyBrimEarChange();
  }

  public getBrimEarSnapshot(): BrimEarSnapshot {
    const objectId = this.brimEarTargetObject();
    const ears = objectId ? this.canonicalProject.getBrimEars(objectId) : Object.freeze([]);
    const stranded = this.strandedBrimEars(objectId);
    return Object.freeze({
      active: this.tool === 'brim_ears',
      ...(objectId ? { objectId } : {}),
      radiusMm: this.brimEarRadiusMm,
      ears,
      stranded,
      hint: objectId
        ? 'Click the model to place an ear; each placement undoes on its own.'
        : 'Select one model part to place brim ears on it.',
      ...(stranded.length > 0
        ? {
            warning:
              stranded.length === 1
                ? 'One ear does not reach the part and will hold nothing down.'
                : `${stranded.length} ears do not reach the part and will hold nothing down.`,
          }
        : {}),
    });
  }

  /**
   * Which of this object's ears reach neither the part nor an ear that does.
   *
   * The pinned gizmo paints these red (`GLGizmoBrimEars::find_single`), and the
   * reason to port it is that nothing else ever says so: a stranded ear slices
   * cleanly, prints a small island of brim, and holds nothing. Silence is the
   * failure mode this whole feature keeps producing.
   */
  private strandedBrimEars(objectId: ObjectId | undefined): readonly number[] {
    if (!objectId) return Object.freeze([]);
    const ears = this.canonicalProject.getBrimEars(objectId);
    if (ears.length === 0) return Object.freeze([]);
    const target = this.paintTargets().find((entry) => entry.objectId === objectId);
    const positions = target?.display.geometry.getAttribute('position');
    if (!positions) return Object.freeze([]);
    const outline = brimEarOutline(
      positions.array as Float32Array,
      target?.display.geometry.getIndex()?.array as Uint32Array | undefined,
    );
    if (!outline) return Object.freeze([]);
    return findDisconnectedBrimEars(
      ears.map((ear) => ({ x: ear.positionMm[0], y: ear.positionMm[1], radiusMm: ear.headFrontRadiusMm })),
      outline.loops,
    );
  }

  /**
   * Draw each placed ear as the pinned flat disc, on the model, in the pinned
   * colours — grey where it will work, red where it will not.
   *
   * The discs are children of the part's own display mesh, so they inherit its
   * transform for free and cannot drift out of step with it. Their scale is
   * then divided back out by the part's world scale, which is the pinned
   * `instance_scaling_matrix_inverse`: an ear is a fixed number of millimetres
   * on the bed, so a marker that grew with a scaled-up model would be lying
   * about the size of the thing it stands for.
   *
   * Shown only while the tool is active, as upstream shows it only while the
   * gizmo is open.
   */
  private refreshBrimEarPreview(): void {
    const objectId = this.brimEarTargetObject();
    const stranded = new Set(this.tool === 'brim_ears' ? this.strandedBrimEars(objectId) : []);
    for (const target of this.paintTargets()) {
      const existing = target.display.getObjectByName(BRIM_EAR_PREVIEW_NAME);
      if (existing) {
        target.display.remove(existing);
        existing.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            (node.material as THREE.Material).dispose();
          }
        });
      }
      if (this.tool !== 'brim_ears' || target.objectId !== objectId) continue;
      const ears = this.canonicalProject.getBrimEars(target.objectId);
      if (ears.length === 0) continue;

      target.display.updateWorldMatrix(true, false);
      const worldScale = new THREE.Vector3();
      target.display.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
      const group = new THREE.Group();
      group.name = BRIM_EAR_PREVIEW_NAME;
      group.raycast = () => {};
      ears.forEach((ear, index) => {
        const paint = stranded.has(index) ? BRIM_EAR_COLORS.error : BRIM_EAR_COLORS.default;
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(ear.headFrontRadiusMm, ear.headFrontRadiusMm, BRIM_EAR_DISC_HEIGHT_MM, 32),
          new THREE.MeshBasicMaterial({
            color: paint.color,
            transparent: paint.opacity < 1,
            opacity: paint.opacity,
            depthWrite: false,
          }),
        );
        // Three's cylinder stands on Y; an ear lies flat on the bed's XY.
        disc.rotation.x = Math.PI / 2;
        disc.position.set(ear.positionMm[0], ear.positionMm[1], ear.positionMm[2]);
        // Scale is applied before rotation, so it is in the cylinder's own
        // frame: its Y is the height axis, which the rotation sends to world Z.
        // Hence the y/z swap — compensating the wrong parent axis would leave
        // the disc the one thing on screen that is not the size it claims.
        const inverse = (value: number): number => (value === 0 ? 1 : 1 / value);
        disc.scale.set(inverse(worldScale.x), inverse(worldScale.z), inverse(worldScale.y));
        disc.raycast = () => {};
        disc.renderOrder = 2;
        group.add(disc);
      });
      target.display.add(group);
    }
  }

  /**
   * Place ears on every corner of the selected part that would peel (P5.3.6).
   *
   * The detection reads the display mesh's own geometry, which is the space
   * ears are stored in — the same space `placeBrimEar` converts a click into —
   * so a detected point and a clicked one mean the same thing.
   */
  public autoPlaceBrimEars(): boolean {
    const objectId = this.brimEarTargetObject();
    if (!objectId) {
      this.setStatus(
        t('workspace.orcaWorkspace.selectOneModelPartBefore', 'Select one model part before placing brim ears on it.'),
      );
      return false;
    }
    const target = this.paintTargets().find((record) => record.objectId === objectId);
    const geometry = (target?.display as THREE.Mesh | undefined)?.geometry;
    const position = geometry?.getAttribute('position');
    if (!position) {
      this.setStatus(
        t('workspace.orcaWorkspace.thatPartHasNoGeometry', 'That part has no geometry to read corners from.'),
      );
      return false;
    }
    const detected = detectBrimEars(
      position.array as Float32Array,
      geometry?.index ? (geometry.index.array as Uint32Array) : undefined,
      { ...DEFAULT_BRIM_EAR_DETECTION, headFrontRadiusMm: this.brimEarRadiusMm },
    );
    if (detected.ears.length === 0) {
      this.setStatus(`No ears placed. ${detected.reason ?? ''}`.trim());
      return false;
    }
    try {
      this.canonicalProject.addBrimEars(
        objectId,
        detected.ears.map((ear) => ear.point),
      );
    } catch (error) {
      this.setStatus(`Brim ears: ${(error as Error).message}`);
      return false;
    }
    this.setStatus(
      `Placed ${detected.ears.length} brim ear${detected.ears.length === 1 ? '' : 's'} on the corners that would lift; one undo removes them all.`,
    );
    // Open the tool so the discs are on the model. In the DOM shell the panel
    // already shows the result, but in a headset the scene is the only report
    // there is — placing eight ears and showing nothing would be a false
    // success, and this action is reachable in XR precisely because it is not.
    if (this.tool !== 'brim_ears') this.setTool('brim_ears');
    this.notifyBrimEarChange();
    return true;
  }

  public clearBrimEars(): boolean {
    const objectId = this.brimEarTargetObject();
    if (!objectId) {
      this.setStatus(
        t('workspace.orcaWorkspace.selectOneModelPartBefore2', 'Select one model part before clearing its brim ears.'),
      );
      return false;
    }
    if (this.canonicalProject.getBrimEars(objectId).length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.thatPartHasNoBrim', 'That part has no brim ears.'));
      return false;
    }
    this.canonicalProject.clearBrimEars(objectId);
    this.setStatus(t('workspace.orcaWorkspace.clearedTheBrimEarsUndo', 'Cleared the brim ears; undo restores them.'));
    this.notifyBrimEarChange();
    return true;
  }

  public removeBrimEar(index: number): boolean {
    const objectId = this.brimEarTargetObject();
    if (!objectId) return false;
    try {
      this.canonicalProject.removeBrimEar(objectId, index);
      this.setStatus(t('workspace.orcaWorkspace.removedABrimEar', 'Removed a brim ear.'));
      this.notifyBrimEarChange();
      return true;
    } catch (error) {
      this.setStatus(`Brim ear: ${(error as Error).message}`);
      return false;
    }
  }

  /** The single object brim ears apply to, or undefined when it is ambiguous. */
  private brimEarTargetObject(): ObjectId | undefined {
    const volumes = new Set(this.paintableSelectedVolumes());
    const objects = new Set(
      this.paintTargets()
        .filter((record) => volumes.has(record.volumeId))
        .map((record) => record.objectId),
    );
    return objects.size === 1 ? [...objects][0] : undefined;
  }

  /** Place one ear where the ray meets the model, in object-local millimetres. */
  private placeBrimEar(raycaster: THREE.Raycaster): boolean {
    const objectId = this.brimEarTargetObject();
    if (!objectId) {
      this.setStatus(
        t('workspace.orcaWorkspace.selectOneModelPartBefore3', 'Select one model part before placing brim ears.'),
      );
      return false;
    }
    for (const target of this.paintTargets()) {
      if (target.objectId !== objectId) continue;
      const [hit] = raycaster.intersectObject(target.display, false);
      if (!hit) continue;
      const local = target.display.worldToLocal(hit.point.clone());
      // An ear is a first-layer feature, so it takes the part's base height
      // rather than wherever on the model the ray landed: the pinned engine
      // discards any ear whose transformed world Z is above the bed
      // (`Brim.cpp:867`), which silently dropped every ear placed up a wall.
      const baseZ = partBaseZ(target.display) ?? local.z;
      try {
        this.canonicalProject.addBrimEar(objectId, {
          positionMm: [local.x, local.y, baseZ],
          headFrontRadiusMm: this.brimEarRadiusMm,
        });
        this.setStatus(`Placed a ${this.brimEarRadiusMm} mm brim ear.`);
        this.notifyBrimEarChange();
        return true;
      } catch (error) {
        this.setStatus(`Brim ear: ${(error as Error).message}`);
        return false;
      }
    }
    this.setStatus(
      t('workspace.orcaWorkspace.clickTheSelectedModelTo', 'Click the selected model to place a brim ear.'),
    );
    return false;
  }

  /** Resolve a ray to a canonical surface feature in world millimetres. */
  private pickMeasureFeature(raycaster: THREE.Raycaster): boolean {
    for (const target of this.paintTargets()) {
      const [hit] = raycaster.intersectObject(target.display, false);
      if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) continue;
      try {
        const extractor = this.measureExtractorFor(target.volumeId);
        if (!extractor) continue;
        const local = target.display.worldToLocal(hit.point.clone());
        const localFeature = extractor.featureAt(hit.faceIndex, [local.x, local.y, local.z]);
        target.display.updateWorldMatrix(true, false);
        const m = target.display.matrixWorld.elements;
        // Three stores column-major; the measure port takes row-major.
        const worldFeature = transformSurfaceFeature(localFeature, [
          m[0],
          m[4],
          m[8],
          m[12],
          m[1],
          m[5],
          m[9],
          m[13],
          m[2],
          m[6],
          m[10],
          m[14],
          m[3],
          m[7],
          m[11],
          m[15],
        ]);
        if (!worldFeature) {
          this.setStatus(
            t(
              'workspace.orcaWorkspace.thatHoleIsScaledUnevenly',
              'That hole is scaled unevenly, so it has no single radius to measure.',
            ),
          );
          this.onMeasureStateChanged?.();
          return false;
        }
        // A third pick starts a new measurement rather than silently replacing one.
        if (this.measurePicks.length >= 2) this.measurePicks = [];
        const instanceId = this.projectedModels(this.activePlateId).find(
          (entry) => entry.volumeId === target.volumeId,
        )?.instanceId;
        this.measurePicks.push({ feature: worldFeature, ...(instanceId ? { instanceId } : {}) });
        this.setStatus(`Measure: picked ${describeSurfaceFeature(worldFeature)}.`);
        this.onMeasureStateChanged?.();
        return true;
      } catch (error) {
        this.setStatus(`Measure failed: ${(error as Error).message}`);
        return false;
      }
    }
    this.setStatus(t('workspace.orcaWorkspace.clickAModelSurfaceTo', 'Click a model surface to measure it.'));
    return false;
  }

  private measureExtractorFor(volumeId: VolumeId): SurfaceFeatureExtractor | undefined {
    const mesh = this.canonicalProject.getVolumeMesh(volumeId);
    if (!mesh) return undefined;
    const key = `${volumeId}:${mesh.triangles.length}:${mesh.vertices.length}`;
    const cached = this.measureExtractors.get(key);
    if (cached) return cached;
    const extractor = new SurfaceFeatureExtractor(mesh);
    this.measureExtractors.set(key, extractor);
    return extractor;
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
      const value = this.activePaintValue();
      this.paintStroke = {
        volumeId: target.volumeId,
        display: target.display,
        triangles: new Set<number>(),
        channel: this.paintChannel,
        mode: this.paintMode,
        ...(value !== undefined ? { value } : {}),
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
        channel: stroke.channel,
        ...(stroke.value !== undefined ? { value: stroke.value as never } : {}),
        mode: stroke.mode,
        ...(stroke.refinement ? { refinement: stroke.refinement as never } : {}),
        ...(stroke.guard ? { guard: stroke.guard } : {}),
      });
      for (const triangle of preview.triangleIndices) stroke.triangles.add(triangle);
      if (preview.refinementAfter) stroke.refinement = preview.refinementAfter;
      stroke.guard ??= preview.guard;
      stroke.previousLocal = local;
      this.renderPaintPreview(
        stroke.display,
        stroke.triangles,
        preview.refinementAfter,
        preview.topologyRevision,
        preview.triangleCount,
        stroke.channel,
        stroke.value,
      );
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
      const result = stroke.refinement
        ? this.paintService.commitRefinement({
            volumeId: stroke.volumeId,
            channel: stroke.channel,
            encoding: stroke.refinement as never,
            mode: stroke.mode,
            ...(stroke.guard ? { guard: stroke.guard } : {}),
          })
        : this.paintService.commitTriangles({
            volumeId: stroke.volumeId,
            triangleIndices: [...stroke.triangles].sort((left, right) => left - right),
            channel: stroke.channel,
            ...(stroke.value !== undefined ? { value: stroke.value as never } : {}),
            mode: stroke.mode,
            ...(stroke.guard ? { guard: stroke.guard } : {}),
          });
      if (result.status === 'applied') {
        const label = channelLabel(stroke.channel);
        this.setStatus(stroke.mode === 'erase' ? `Erased ${label} facets.` : `Painted ${label} facets.`);
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
    // The visible overlay is the channel the active tool authors; Prepare keeps
    // showing colour so filament intent stays visible outside painting.
    const channel = PAINT_TOOL_CHANNELS[this.tool] ?? 'color';
    const facets = this.canonicalProject.getFacetOverlayByVolume(channel, this.activePlateId);
    const colors = channelOverlayColors(channel, paintPaletteColors(this.getPaintPalette(true)));
    const live = new Set<THREE.Mesh>();
    for (const target of this.paintTargets()) {
      const snapshot = facets.get(target.volumeId);
      const existing = this.paintOverlays.get(target.display);
      if (!snapshot) {
        if (existing) this.disposeOverlay(target.display, existing);
        continue;
      }
      live.add(target.display);
      const geometry = this.buildPaintOverlayGeometry(
        target.display,
        snapshot.assignments,
        colors,
        snapshot.refinement,
        snapshot.topologyRevision,
        snapshot.triangleCount,
        channel,
      );
      if (!geometry) {
        if (existing) this.disposeOverlay(target.display, existing);
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
        this.paintOverlays.set(target.display, target.volumeId, overlay);
      }
    }
    this.paintOverlays.prune(live, (overlay) => this.disposeOverlayResource(overlay));
  }

  private disposeOverlay(display: THREE.Mesh, overlay: THREE.Mesh): void {
    this.paintOverlays.delete(display);
    this.disposeOverlayResource(overlay);
  }

  private disposeOverlayResource(overlay: THREE.Mesh): void {
    overlay.removeFromParent();
    overlay.geometry.dispose();
    (overlay.material as THREE.Material).dispose();
  }

  private buildPaintOverlayGeometry(
    display: THREE.Mesh,
    assignments: readonly { triangles: number[]; value: JsonValue }[],
    colors: ReadonlyMap<string, string>,
    refinement?: FacetRefinementEncoding,
    topologyRevision = 0,
    triangleCount?: number,
    channel: PaintChannel = this.paintChannel,
  ): THREE.BufferGeometry | null {
    const source = display.geometry;
    const position = source.getAttribute('position');
    const index = source.getIndex();
    if (!position || !index) return null;
    const painted: Array<{ vertices: readonly [number, number, number]; color: THREE.Color }> = [];
    let renderVertices: readonly Vec3[] | undefined;
    if (refinement) {
      const sourceMesh = {
        vertices: Array.from(
          { length: position.count },
          (_, vertex) => [position.getX(vertex), position.getY(vertex), position.getZ(vertex)] as const,
        ),
        triangles: Array.from(
          { length: index.count / 3 },
          (_, triangle) =>
            [index.getX(triangle * 3), index.getX(triangle * 3 + 1), index.getX(triangle * 3 + 2)] as const,
        ),
      };
      const channelAssignments: FacetAnnotations = {
        topologyRevision,
        color: [],
        support: [],
        seam: [],
        fuzzySkin: [],
        brim: [],
        refinement: { [channel]: refinement },
      } as FacetAnnotations;
      channelAssignments[channel] = assignments as never;
      const materialized = materializeFacetRefinement({
        mesh: sourceMesh,
        annotations: channelAssignments,
        channel,
        guard: { topologyRevision, triangleCount: triangleCount ?? sourceMesh.triangles.length },
        refinement,
      });
      renderVertices = materialized.vertices;
      for (const leaf of materialized.leaves) {
        if (leaf.state.kind !== 'assigned') continue;
        painted.push({
          vertices: leaf.vertexIndices,
          color: new THREE.Color(colors.get(String(leaf.state.value)) ?? '#ffffff'),
        });
      }
    } else {
      renderVertices = Array.from(
        { length: position.count },
        (_, vertex) => [position.getX(vertex), position.getY(vertex), position.getZ(vertex)] as const,
      );
      for (const assignment of assignments) {
        const color = new THREE.Color(colors.get(String(assignment.value)) ?? '#ffffff');
        for (const triangle of assignment.triangles) {
          painted.push({
            vertices: [index.getX(triangle * 3), index.getX(triangle * 3 + 1), index.getX(triangle * 3 + 2)],
            color,
          });
        }
      }
    }
    if (painted.length === 0) return null;
    const positions = new Float32Array(painted.length * 9);
    const vertexColors = new Float32Array(painted.length * 9);
    painted.forEach(({ vertices, color }, slot) => {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = renderVertices![vertices[corner]];
        const offset = slot * 9 + corner * 3;
        positions[offset] = vertex[0];
        positions[offset + 1] = vertex[1];
        positions[offset + 2] = vertex[2];
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
  private renderPaintPreview(
    display: THREE.Mesh,
    triangles: ReadonlySet<number>,
    refinement?: FacetRefinedRootSet,
    topologyRevision = 0,
    triangleCount?: number,
    channel: PaintChannel = this.paintChannel,
    value: JsonValue | undefined = this.activePaintValue(),
  ): void {
    this.clearPaintPreview();
    if (triangles.size === 0) return;
    let geometry: THREE.BufferGeometry | null;
    if (refinement) {
      const canonicalOverlay = this.paintOverlays.get(display);
      if (canonicalOverlay) {
        canonicalOverlay.visible = false;
        this.paintPreviewHiddenOverlay = canonicalOverlay;
      }
      // The in-flight tree is the dense working form; the overlay wants the
      // same split the canonical store would take.
      const collapsed = collapseFacetRefinementRoots(refinement.roots);
      geometry = this.buildPaintOverlayGeometry(
        display,
        collapsed.assignments,
        channelOverlayColors(channel, paintPaletteColors(this.getPaintPalette(true))),
        collapsed.encoding,
        topologyRevision,
        triangleCount,
        channel,
      );
    } else {
      const previewColor =
        value === undefined
          ? '#ffffff'
          : (channelOverlayColors(channel, paintPaletteColors(this.getPaintPalette(true))).get(String(value)) ??
            '#ffffff');
      geometry = this.buildPaintOverlayGeometry(
        display,
        [{ triangles: [...triangles], value: 'preview' }],
        new Map([['preview', previewColor]]),
      );
    }
    if (!geometry) return;
    const preview = new THREE.Mesh(geometry, PAINT_PREVIEW_MATERIAL.clone());
    preview.name = 'paint-preview';
    preview.raycast = () => {};
    preview.renderOrder = 3;
    display.add(preview);
    this.paintPreviewOverlay = preview;
  }

  private clearPaintPreview(): void {
    if (this.paintPreviewHiddenOverlay) {
      this.paintPreviewHiddenOverlay.visible = true;
      this.paintPreviewHiddenOverlay = null;
    }
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
      this.setStatus(
        t('workspace.orcaWorkspace.the16SlotFilamentLimit', 'The 16-slot filament limit has been reached.'),
      );
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

  /** Read-only counters for simulator/headset input-lifecycle evidence. */
  public getXrInputLifecycleSnapshot(): SceneGestureSnapshot {
    return this.sceneGestureGuard.snapshot();
  }

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

    // A trigger press on an armed printer control owns the whole gesture: it
    // must not also paint or manipulate through the card behind it.
    if (this.beginPrinterHold(event.target)) {
      this.sceneGestureGuard.begin(event.target, true);
      return;
    }

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
    if (this.printerHoldController !== null && (!event || event.target === this.printerHoldController)) {
      this.endPrinterHold();
    }
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

  /**
   * Compose the operator's installation and authored presets into the profile
   * corpus (P6.4). Installed once, then re-run on every library change.
   *
   * Composition is applied to the *fetched* corpus every time rather than to
   * the last composed one, so uninstalling a printer restores it instead of
   * narrowing the catalog one step further with each edit.
   */
  public installCatalogComposer(compose: (catalog: unknown) => unknown): void {
    this.catalog.compose = compose;
    if (this.catalog.rawCatalog !== undefined) this.recomposeProfileCatalog();
  }

  /** The exact profile corpus as fetched, for a shell that builds a library over it. */
  public getRawProfileCatalog(): unknown {
    return this.catalog.rawCatalog;
  }

  /**
   * Recompile the corpus after a library change, and re-resolve the selection.
   * A printer the operator just uninstalled is no longer in the compiled
   * profiles, so holding on to it would leave the shell slicing against a
   * machine its own picker no longer offers.
   */
  public recomposeProfileCatalog(): void {
    if (!this.catalog.recompose()) return;
    // Re-point at the *new* object for the same triple rather than keeping the
    // one compiled before. Exact preset attestation is decided by identity
    // (`catalog.profiles.includes`), so a surviving-but-stale object would
    // silently drop this project out of exact-profile preflight.
    const current = this.profile;
    if (current) {
      this.profile = this.catalog.profiles.find((candidate) => candidate.id === current.id) ?? null;
    }
    this.applyCatalogDefaultProfile();
    this.onProfileChanged?.();
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
    const slicing = this.canonicalProject.getSlicingConfiguration();
    const toolCount = slicing.printer.toolCount;
    // An imported project slices as authored, so its own embedded printer and
    // filament configuration is the attested target; a catalog selection must
    // still resolve exact presets.
    if (this.importedProjectOwnsSlicingConfiguration && !this.profile) {
      const projectConfig = engineWireConfig(slicing.config as Readonly<Record<string, unknown>>);
      const physical = slicing.filaments.physical.map((filament) => ({
        toolId: filament.toolId,
        material: filament.material,
        config: engineWireConfig(filament.config as Readonly<Record<string, unknown>>),
      }));
      return new LiveProfileSlicePreflight(
        deriveLiveProfilePreflightConstraints({
          source: 'authored-project',
          primaryProfile: authoredProjectProfile(projectConfig),
          filamentProfiles: authoredFilamentProfiles(projectConfig, physical, toolCount),
          toolCount,
        }),
      );
    }
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

    this.showXrSurfaces();
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
    if (this.previewScrubberCard) this.previewScrubberCard.hide();
  }

  onSimulatorStarted() {
    this.needsRecenter = true;
    // Reviewing the immersive shell on a desktop is opt-in, and it has to be:
    // the simulator runs in the ordinary flat app as well, so revealing the XR
    // cards here put the headset's action desk and tool rail on top of the
    // desktop UI. `?xrui=1` is for looking at the spatial layout without a
    // headset; everything else gets the flat shell it asked for.
    if (xrUiReviewRequested()) this.showXrSurfaces();
  }

  /** Reveal the cards a session starts with. Opt-in surfaces stay closed. */
  private showXrSurfaces() {
    if (this.topStripCard) this.topStripCard.show();
    if (this.leftToolbarCard) this.leftToolbarCard.show();
    if (this.bottomBarCard) this.bottomBarCard.show();
    // Menu and profile are opened deliberately; showing them on entry buries
    // the plate under panels nobody asked for.
    if (this.rightSidebarCard) this.rightSidebarCard.hide();
    if (this.profileCard) this.profileCard.hide();
    if (this.previewScrubberCard) {
      if (this.previewOn) this.previewScrubberCard.show();
      else this.previewScrubberCard.hide();
    }
  }

  update(_time: number, _frame: XRFrame) {
    // A hold has to show its own progress or it is indistinguishable from a
    // control that ignored the press.
    if (this.printerHoldController !== null) {
      const state = this.printerHold.poll();
      if (state.phase === 'holding') this.paintPrinterHold(state.command, state.progress);
    }
    this.renderNavigator();
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

    // Every card is placed by `ui/xr/XrLayout`, which expresses the
    // arrangement as angles around the head rather than as metres beside the
    // plate, and turns each surface to face the operator. Placing them here by
    // hand is what produced a row of parallel panels read at a glancing angle,
    // overlapping each other while the rest of the room stayed empty.
    const head = { position: cam.getWorldPosition(new THREE.Vector3()), forward: fwd };
    this.placeXrSurface(this.topStripCard, 'menu', head);
    this.placeXrSurface(this.leftToolbarCard, 'tools', head);
    this.placeXrSurface(this.profileCard, 'inspector', head);
    this.placeXrSurface(this.rightSidebarCard, 'sheet', head);
    this.placeXrSurface(this.printerStatusCard, 'status', head);
    this.placeXrSurface(this.bottomBarCard, 'actions', head);
    this.placeXrSurface(this.sliceModalCard, 'progress', head);
    this.placeXrSurface(this.previewScrubberCard, 'scrubber', head);
  }

  /** Move one card onto its layout surface around `head`. */
  private placeXrSurface(
    card: { position: THREE.Vector3; quaternion: THREE.Quaternion; updateMatrixWorld(force?: boolean): void } | null,
    id: XrSurfaceId,
    head: { position: THREE.Vector3; forward: THREE.Vector3 },
  ): void {
    if (!card) return;
    const { position, quaternion } = surfaceTransform(xrSurface(id), head);
    card.position.copy(position);
    card.quaternion.copy(quaternion);
    card.updateMatrixWorld(true);
  }

  /**
   * Card geometry for a layout surface, with metres and layout pixels in
   * agreement. They were not: a 1.0 m strip declared 1000 px at 0.0012 m/px,
   * so uikit laid out 1.2 m of content inside a 1.0 m card and everything in
   * it came out crushed.
   */
  private xrCardGeometry(id: XrSurfaceId): { sizeX: number; sizeY: number; pixelSize: number; width: number } {
    const surface = xrSurface(id);
    return {
      sizeX: surface.sizeX,
      sizeY: surface.sizeY,
      pixelSize: XR_PIXEL_SIZE,
      width: Math.round(surface.sizeX / XR_PIXEL_SIZE),
    };
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

  /**
   * Dress the plate for the surface it is being seen on, and rebuild it.
   * Cheap and idempotent: the geometry is a box, a grid and a few rings.
   */
  setPlateAppearance(appearance: PlateAppearance): void {
    if (this.plateAppearance === appearance) return;
    this.plateAppearance = appearance;
    this.rebuildPlate();
  }

  /** (Re)build plate/grid/grab-bar sized to the active profile's bed. */
  private rebuildPlate() {
    this.plateParts.clear();
    const sx = this.bedMm.x * MM * WORKSPACE_SCALE;
    const sz = this.bedMm.y * MM * WORKSPACE_SCALE;
    const maxDim = Math.max(sx, sz);
    const skin = PLATE_SKINS[this.plateAppearance];

    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(sx, 0.006, sz),
      new THREE.MeshStandardMaterial({
        color: skin.plate,
        roughness: skin.roughness,
        metalness: skin.metalness,
        transparent: true,
        opacity: skin.opacity,
      }),
    );
    plate.name = 'plate';
    plate.position.set(0, -0.003, 0);
    this.plateParts.add(plate);

    const grid = new THREE.GridHelper(maxDim, 10, skin.gridMajor, skin.gridMinor);
    grid.position.set(0, 0.0002, 0);
    grid.scale.set(sx / maxDim, 1, sz / maxDim);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = skin.gridOpacity;
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

    // The rings and the bar are grab affordances: they say the whole workspace
    // can be picked up and moved, which is true in a headset and meaningless
    // behind a mouse. A desktop window gets the bed alone.
    if (skin.grabAffordances) {
      const rBase = maxDim * 0.6;
      this.plateParts.add(createRing(rBase * 0.5, 0xff8a3d, 0.5, -0.01));
      this.plateParts.add(createRing(rBase * 0.75, 0xffb74d, 0.55, -0.02));
      this.plateParts.add(createRing(rBase, 0xff6d00, 0.7, -0.03));
    }

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.01, 32),
      new THREE.MeshBasicMaterial({ color: skin.origin, transparent: true, opacity: 0.8 }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.0003;
    dot.raycast = () => {};
    this.plateParts.add(dot);

    if (skin.grabAffordances) {
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
    }
    (this.workspace as unknown as { draggable: boolean }).draggable = skin.grabAffordances;
  }

  /** Effective prime/purge tower on the active plate (null if none/disabled). */
  public get activePlateWipeTower(): { enabled: boolean; xMm: number; yMm: number; widthMm: number } | null {
    try {
      const summary = this.canonicalProject.getSummary();
      const activePlate = summary.plates.find((plate) => plate.id === this.activePlateId);
      const tower = activePlate?.wipeTower;
      if (!tower || !tower.enabled) {
        return this.projectPrimeTower?.enabled ? this.projectPrimeTower : null;
      }
      const config = this.canonicalProject.getSlicingConfiguration().config;
      const widthMm = Number(config.prime_tower_width ?? config.wipe_tower_width) || 60;
      return {
        enabled: tower.enabled,
        xMm: tower.positionMm[0],
        yMm: tower.positionMm[1],
        widthMm,
      };
    } catch {
      return this.projectPrimeTower?.enabled ? this.projectPrimeTower : null;
    }
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
    const pt = this.activePlateWipeTower;
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
  /** Injected by the live typed printer composition root to query loaded filament slots directly. */
  onRequestPrinterFilamentQuery:
    | (() => Promise<
        | readonly {
            slotIndex: number;
            colorHex: string;
            material: string;
            subType?: string;
            vendor: string;
          }[]
        | null
      >)
    | null = null;
  /** Injected by the live typed printer composition root; owns confirmation. */
  onRequestPrintSubmission: ((intent: PrintJobIntent) => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root; owns confirmation. */
  onRequestPrintJobCommand:
    ((command: PrintJobCommand, options?: { readonly preconfirmed?: boolean }) => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root; owns confirmation. */
  onRequestPrinterStorage: ((operation: PrinterStorageOperation) => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root; owns confirmation. */
  onRequestPrinterConsole: ((operation: PrinterConsoleOperation) => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root. */
  onRequestPrintHistory: ((start: number) => Promise<void>) | null = null;
  /** Injected by the live typed printer composition root. */
  onRequestPrinterCamera: ((uid?: string) => Promise<void>) | null = null;
  /** Injected by the shell that owns the calibration ledger (P8.5). */
  onRequestCalibrationHistory: ((operation: CalibrationHistoryOperation) => Promise<void>) | null = null;
  /** Injected by the shell that owns preset persistence (P6.4). */
  onRequestPresetLibrary: ((operation: PresetLibraryOperation) => Promise<void>) | null = null;
  /** Injected by the shell that owns the compact printer status surface (P9.7). */
  onTogglePrinterStatusBar: (() => void) | null = null;
  /** Live status for the spatial card; the shell owns the connection (P9.7). */
  onReadPrinterStatus: (() => { summary: PrinterStatusSummary; actions: readonly GuardedPrinterAction[] }) | null =
    null;
  /** Run one guarded lifecycle command that completed its hold in XR (P9.7). */
  onRunPrinterStatusCommand: ((command: PrintJobCommand) => Promise<void>) | null = null;
  /** Re-open a session the spatial card reports as lost (P9.7). */
  onReconnectPrinter: (() => Promise<void>) | null = null;

  public async testPrinterConnection(): Promise<void> {
    if (!this.onRequestPrinterConnectionTest) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.printerConnectionIsUnavailableIn',
          'Printer connection is unavailable in this shell.',
        ),
      );
      return;
    }
    await this.onRequestPrinterConnectionTest();
  }

  public async inspectPrinterFilaments(): Promise<void> {
    if (!this.onRequestPrinterFilamentInspection) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.printerFilamentInspectionIsUnavailable',
          'Printer filament inspection is unavailable in this shell.',
        ),
      );
      return;
    }
    await this.onRequestPrinterFilamentInspection();
  }

  /**
   * Hand the guarded artifact for the active plate to the shell's print
   * submission flow. Only a revalidated artifact is offered, so a project edited
   * after slicing can never be sent as if it were current.
   */
  public async sendToPrinter(): Promise<void> {
    if (!this.onRequestPrintSubmission) {
      this.setStatus(
        t('workspace.orcaWorkspace.sendingToAPrinterIs', 'Sending to a printer is unavailable in this shell.'),
      );
      return;
    }
    const gcode = this.getLastGcode();
    if (!gcode) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.sliceTheActivePlateBefore',
          'Slice the active plate before sending it to the printer.',
        ),
      );
      return;
    }
    const summary = this.canonicalProject.getSummary();
    const plate = summary.plates.find((candidate) => candidate.id === summary.activePlateId);
    const plateName = plate?.name ?? 'Plate';
    await this.onRequestPrintSubmission({
      filename: `${summary.projectName}_${plateName}.gcode`,
      gcode,
      plateName,
      usage: summarizeGcodeToolUsage(gcode),
    });
  }

  /**
   * Ask the shell to run one printer lifecycle command. The workspace holds no
   * printer state of its own: the shell owns the connection, the live snapshot
   * the operator is looking at, and any confirmation the command needs.
   */
  public async controlPrintJob(command: PrintJobCommand, options?: { readonly preconfirmed?: boolean }): Promise<void> {
    if (!this.onRequestPrintJobCommand) {
      this.setStatus(
        t('workspace.orcaWorkspace.printerControlsAreUnavailableIn', 'Printer controls are unavailable in this shell.'),
      );
      return;
    }
    await this.onRequestPrintJobCommand(command, options);
  }

  /**
   * Ask the shell to act on a file that is already on the printer (P9.5).
   *
   * The workspace does not browse the machine itself for the same reason it
   * does not hold a socket: the file list belongs to the connection, and a
   * cached copy would let a delete act on something the printer no longer has.
   */
  public async operatePrinterStorage(operation: PrinterStorageOperation): Promise<void> {
    if (!this.onRequestPrinterStorage) {
      this.setStatus(
        t('workspace.orcaWorkspace.printerStorageIsUnavailableIn', 'Printer storage is unavailable in this shell.'),
      );
      return;
    }
    await this.onRequestPrinterStorage(operation);
  }

  /**
   * Ask the shell to run one console command or macro (P9.6).
   *
   * The workspace deliberately does not classify the command itself: what a
   * command does depends on what the machine is doing right now, and only the
   * connection knows that.
   */
  public async operatePrinterConsole(operation: PrinterConsoleOperation): Promise<void> {
    if (!this.onRequestPrinterConsole) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.thePrinterConsoleIsUnavailable',
          'The printer console is unavailable in this shell.',
        ),
      );
      return;
    }
    await this.onRequestPrinterConsole(operation);
  }

  /** Ask the shell for one page of the printer's own job history (P9.6). */
  public async loadPrintHistory(start = 0): Promise<void> {
    if (!this.onRequestPrintHistory) {
      this.setStatus(
        t('workspace.orcaWorkspace.printHistoryIsUnavailableIn', 'Print history is unavailable in this shell.'),
      );
      return;
    }
    await this.onRequestPrintHistory(start);
  }

  /** Discover the printer's cameras, optionally selecting one (P9.6). */
  public async viewPrinterCamera(uid?: string): Promise<void> {
    if (!this.onRequestPrinterCamera) {
      this.setStatus(
        t('workspace.orcaWorkspace.printerCamerasAreUnavailableIn', 'Printer cameras are unavailable in this shell.'),
      );
      return;
    }
    await this.onRequestPrinterCamera(uid);
  }

  /**
   * Ask the shell to change which printers are installed, or which presets the
   * operator has authored (P6.4).
   *
   * The workspace consumes the composed catalog but never owns it: the library
   * has to outlive a reload, which means storage, and storage belongs to the
   * shell for the same reason the printer socket does.
   */
  /**
   * Show or hide the glanceable printer status (P9.7). The surface follows the
   * live job on its own; this only overrides whether it is on screen, so an
   * operator can pin it while preparing or dismiss it while it is idle.
   */
  public togglePrinterStatusBar(): void {
    if (!this.onTogglePrinterStatusBar) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.thePrinterStatusSurfaceIs',
          'The printer status surface is unavailable in this shell.',
        ),
      );
      return;
    }
    this.onTogglePrinterStatusBar();
  }

  /**
   * Ask the shell to change the calibration ledger (P8.5).
   *
   * The workspace does not hold the ledger for the same reason it does not hold
   * the preset library: a record has to outlive the project it was measured in,
   * which means storage, and storage belongs to the shell.
   */
  public async operateCalibrationHistory(operation: CalibrationHistoryOperation): Promise<void> {
    if (!this.onRequestCalibrationHistory) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.calibrationHistoryIsUnavailableIn',
          'Calibration history is unavailable in this shell.',
        ),
      );
      return;
    }
    await this.onRequestCalibrationHistory(operation);
  }

  public async operatePresetLibrary(operation: PresetLibraryOperation): Promise<void> {
    if (!this.onRequestPresetLibrary) {
      this.setStatus(
        t('workspace.orcaWorkspace.printerAndPresetSetupIs', 'Printer and preset setup is unavailable in this shell.'),
      );
      return;
    }
    await this.onRequestPresetLibrary(operation);
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
      this.setStatus(t('workspace.orcaWorkspace.noActiveProfileToExport', 'No active profile to export.'));
      return;
    }
    if (this.onDownloadFile) this.onDownloadFile('orcaxr_config.json', json, 'application/json');
    this.setStatus(t('workspace.orcaWorkspace.exportedConfig', 'Exported config.'));
  }

  /** Apply an imported config bundle over the current profile (File → Import Config). */
  public importConfig(text: string): boolean {
    const b = parseConfigJson(text);
    if (!b) {
      this.setStatus(t('workspace.orcaWorkspace.notAValidConfigFile', 'Not a valid config file.'));
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
  /** Injected by the shell; owns a live, searchable help surface. */
  public onShowHelpSearch: (() => void) | null = null;

  /** Injected by main.ts: opens the language picker (P10.4). */
  public onShowLanguagePicker: (() => void) | null = null;

  public showLanguagePicker(): void {
    if (this.onShowLanguagePicker) this.onShowLanguagePicker();
    else
      this.setStatus(
        t(
          'workspace.orcaWorkspace.languageSelectionIsUnavailableIn',
          'Language selection is unavailable in this shell.',
        ),
      );
  }

  public showHelpSearch(): void {
    if (this.onShowHelpSearch) this.onShowHelpSearch();
    else
      this.setStatus(
        t('workspace.orcaWorkspace.helpSearchIsUnavailableIn', 'Help search is unavailable in this shell.'),
      );
  }

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
            this.setStatus(t('workspace.orcaWorkspace.importCancelled', 'Import cancelled.'));
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
      this.refreshSelectionOutlines();
      const last = added[added.length - 1];
      if (last) this.selectModel(last);
      this.recomputePreflight();
      this.warmSlicerAfterFirstModel();
      const objects = new Set(added.map((entry) => entry.objectId)).size;
      this.setStatus(
        `Imported ${name} — ${objects} object${objects === 1 ? '' : 's'}.` + this.describeImportRepairs(preview),
      );
      return objects;
    } finally {
      this.projectImportInProgress = false;
    }
  }

  /**
   * Import only the geometry of a 3MF into the open project. Plates, project
   * settings, the source filament library, and custom G-code are reported as
   * dropped in the same transactional preview the model importer uses.
   */
  public async importProjectGeometry(name: string, bytes: ArrayBuffer | Uint8Array): Promise<number> {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (source.byteLength === 0) throw new Error(`${name} is empty.`);
    if (this.projectImportInProgress) throw new Error('Another import preview is already open.');
    this.projectImportInProgress = true;
    try {
      const before = new Set(this.projectedModels().map((entry) => entry.instanceId));
      const prepared = await this.canonicalProject.prepareGeometryImport(
        source,
        { filename: name },
        { bedSizeMm: [this.bedMm.x, this.bedMm.y] },
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
        const confirm = this.onProjectImportPreview;
        if (!confirm) throw new Error('Geometry import needs an explicit confirmation surface.');
        const decision = await confirm(preview);
        if (!decision) {
          this.setStatus(t('workspace.orcaWorkspace.importCancelled2', 'Import cancelled.'));
          return 0;
        }
        prepared.confirm(decision);
        committed = true;
      } finally {
        if (!committed) prepared.cancel('geometry import did not commit');
      }

      const added = this.projectedModels().filter((entry) => !before.has(entry.instanceId));
      const last = added[added.length - 1];
      if (last) this.selectModel(last);
      this.recomputePreflight();
      this.warmSlicerAfterFirstModel();
      const objects = new Set(added.map((entry) => entry.objectId)).size;
      this.setStatus(`Imported geometry from ${name} — ${objects} object${objects === 1 ? '' : 's'}.`);
      return objects;
    } finally {
      this.projectImportInProgress = false;
    }
  }

  /**
   * One intake for every supported file, routed by content signature: a 3MF
   * opens as a project (or merges as geometry when asked), mesh containers
   * merge as models, and G-code opens read-only in the viewer.
   */
  public async openFile(
    name: string,
    bytes: ArrayBuffer | Uint8Array,
    options: { threeMfMode?: 'project' | 'geometry' } = {},
  ): Promise<'project' | 'geometry' | 'model' | 'gcode' | 'cancelled'> {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let detection;
    try {
      detection = detectModelFormat(source, name);
    } catch (error) {
      // G-code and unknown containers still get a precise message below.
      if (/\.(gcode|gco|g)$/i.test(name)) {
        return this.openGcodeForPreview(new TextDecoder('utf-8', { fatal: false }).decode(source), name)
          ? 'gcode'
          : 'cancelled';
      }
      throw error;
    }
    if (detection.format === 'gcode') {
      return this.openGcodeForPreview(new TextDecoder('utf-8', { fatal: false }).decode(source), name)
        ? 'gcode'
        : 'cancelled';
    }
    if (detection.format === 'project-3mf') {
      if (options.threeMfMode === 'geometry') {
        return (await this.importProjectGeometry(name, source)) > 0 ? 'geometry' : 'cancelled';
      }
      const owned = new ArrayBuffer(source.byteLength);
      new Uint8Array(owned).set(source);
      return (await this.openProject(owned, name)) ? 'project' : 'cancelled';
    }
    return (await this.importModelFile(name, source)) > 0 ? 'model' : 'cancelled';
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

  /**
   * Drop a stock primitive on the bed (printer-frame Z-up).
   *
   * The shapes live in `project/objects/primitives.ts` so their dimensions can
   * be measured without a browser; this only places what that module built.
   */
  public addPrimitive(kind: PrimitiveKind) {
    this.loadModelFromGeometry(primitiveGeometry(kind), primitiveFileName(kind));
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
      | 'flow_yolo_perfectionist'
      | 'pressure_advance'
      | 'retraction'
      | 'max_flow'
      | 'vfa'
      | 'tolerance'
      | 'input_shaping_frequency'
      | 'input_shaping_damping'
      | 'junction_deviation',
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
      case 'flow_yolo_perfectionist':
        geo = gen.generateFlowYoloPerfectionist();
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
      case 'input_shaping_frequency':
        geo = gen.generateInputShapingFrequency();
        break;
      case 'input_shaping_damping':
        geo = gen.generateInputShapingDamping();
        break;
      case 'junction_deviation':
        geo = gen.generateJunctionDeviation();
        break;
    }
    // The operator's project is put aside rather than added to (P8.3). A
    // calibration is a separate errand: it prints a test object, gets measured,
    // and is thrown away, and doing that in the middle of someone's plate
    // leaves them to notice and undo it. Opening a session is idempotent, so
    // adding a second calibration replaces the first rather than nesting.
    const opened = this.canonicalProject.beginCalibrationSession();
    this.loadModelFromGeometry(geo.toNonIndexed(), filename);
    this.setStatus(
      opened
        ? `Added calibration ${kind}. Your project is held aside — finish or discard the calibration to get it back.`
        : `Added calibration ${kind}.`,
    );
    this.onCalibrationSessionChanged?.();
  }

  /**
   * The printer, nozzle, filament, and process facts a calibration is compiled
   * against, read from the live project (P8.3).
   *
   * Every field comes from the canonical config rather than a default, because
   * the compiler uses these to decide what will fit on the bed and what
   * temperatures are safe — a plausible-looking stand-in would produce a
   * preview of a machine the operator does not have. Where the config genuinely
   * does not carry a value, the fallback is the conservative one: a smaller
   * bed, a narrower temperature window, a slower machine. A calibration refused
   * for not fitting is a nuisance; one accepted because the bed was assumed
   * larger than it is crashes a toolhead.
   */
  public calibrationPrerequisites(): CalibrationJobPrerequisites {
    const config = this.canonicalProject.getSlicingConfiguration().config as Record<string, unknown>;
    const num = (key: string, fallback: number): number => {
      const raw = config[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const text = (key: string, fallback: string): string => {
      const raw = config[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === 'string' && value.length > 0 ? value : fallback;
    };
    const nozzleDiameterMm = num('nozzle_diameter', 0.4);
    const layerHeightMm = num('layer_height', 0.2);
    return {
      printer: {
        id: `printer:${text('printer_model', 'unknown')}`,
        manufacturer: text('printer_vendor', 'Unknown'),
        model: text('printer_model', 'Unknown'),
        bedWidthMm: this.bedMm.x,
        bedDepthMm: this.bedMm.y,
        buildHeightMm: num('printable_height', 100),
        maxPrintSpeedMmPerS: num('machine_max_speed_x', 200),
        maxAccelerationMmPerS2: num('machine_max_acceleration_x', 1000),
      },
      nozzle: {
        diameterMm: nozzleDiameterMm,
        minTemperatureC: num('nozzle_temperature_range_low', 170),
        maxTemperatureC: num('nozzle_temperature_range_high', 300),
        // Upstream's own guidance, and the reason this is derived rather than
        // read: no config key states a maximum layer height.
        maxLayerHeightMm: nozzleDiameterMm * 0.8,
      },
      filament: {
        id: `filament:${text('filament_settings_id', 'unknown')}`,
        name: text('filament_settings_id', 'Unknown filament'),
        material: text('filament_type', 'PLA'),
        minTemperatureC: num('nozzle_temperature_range_low', 190),
        maxTemperatureC: num('nozzle_temperature_range_high', 240),
        flowRatio: num('filament_flow_ratio', 1),
        maxVolumetricSpeedMm3PerS: num('filament_max_volumetric_speed', 12),
        retractionLengthMm: num('retraction_length', 0.8),
      },
      process: {
        id: `process:${text('print_settings_id', 'unknown')}`,
        layerHeightMm,
        firstLayerHeightMm: num('initial_layer_print_height', layerHeightMm),
        lineWidthMm: num('line_width', nozzleDiameterMm * 1.125),
        outerWallSpeedMmPerS: num('outer_wall_speed', 60),
        defaultAccelerationMmPerS2: num('default_acceleration', 1000),
        xyHoleCompensationMm: num('xy_hole_compensation', 0),
        xyContourCompensationMm: num('xy_contour_compensation', 0),
      },
      firmware: {
        flavor: 'klipper',
        nozzleTemperature: true,
        pressureAdvance: true,
        inputShaping: true,
        junctionDeviation: false,
        maxInputShapingFrequencyHz: 500,
      },
    };
  }

  // --- Calibration parameters (P8.3) -----------------------------------
  /**
   * The workflow being configured and the edits typed into it.
   *
   * Held here rather than in the shell so the same state is reachable from the
   * DOM panel, from an XR surface, and from an MCP tool. A panel that owns its
   * own field values is a panel only that panel can drive, which is the rule
   * this project sets against itself: every action an operator can take must be
   * an action the registry can take.
   */
  private calibrationWorkflowId = 'temperature-tower';
  private calibrationEdits: Record<string, string> = {};
  /**
   * Build a complete pressure-advance sweep program (P8.2, P8.3).
   *
   * The two sweeps are generated G-code rather than sliced projects, and a
   * generated program still has to prepare the machine. Rather than write a
   * preamble — the U1's is 5,623 characters of template — this borrows the one
   * the engine already produced for a real slice, which is why a sliced project
   * is the precondition rather than an inconvenience.
   *
   * Returns the program, or a reason it could not be built. Never returns a
   * partial program: an operator who receives a file expects to be able to
   * print it.
   */
  public buildCalibrationSweepProgram():
    { readonly gcode: string; readonly filename: string } | { readonly reason: string } {
    const donor = this.getLastGcode();
    if (!donor) {
      return {
        reason:
          'Slice any project on this printer first. The sweep borrows your machine’s own start sequence from a real slice, ' +
          'because writing one by hand would skip bed levelling and nozzle cleaning.',
      };
    }
    const workflow = this.calibrationWorkflowId;
    try {
      const preview = this.calibrationFormPreview;
      const plan = preview?.plan ?? null;
      if (!plan) return { reason: 'The calibration parameters do not compile, so there is nothing to build.' };
      const config = this.canonicalProject.getSlicingConfiguration().config as Record<string, unknown>;
      const num = (key: string, fallback: number): number => {
        const raw = config[key];
        const value = Array.isArray(raw) ? raw[0] : raw;
        const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const body = pressureAdvanceLineProgram(plan, {
        layerHeightMm: num('initial_layer_print_height', 0.2),
        lineWidthMm: num('line_width', 0.42),
        filamentDiameterMm: num('filament_diameter', 1.75),
        printFeedMmPerMin: num('initial_layer_speed', 50) * 60,
        travelFeedMmPerMin: num('travel_speed', 200) * 60,
      });
      const program = wrapInMachineEnvelope(body.body, extractMachineEnvelope(donor));
      return { gcode: program, filename: `${workflow}.gcode` };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Place a single-gauge calibration from its upstream resource (P8.2).
   *
   * `tolerance-extension` looked like six pieces needing six settings, and it
   * is not. Its six effects carry no engine overrides at all, and the plan's
   * required envelope — 57.937 × 14.401 × 6.401 mm — is the gauge's own
   * bounding box plus a fit margin, measured at 57.936 × 14.400 × 6.400. Six
   * copies of a 57.9 mm part cannot sit at the 38.6 mm spacing the effects
   * give; they would overlap by nineteen millimetres. The effects are the
   * *reading key* for one gauge whose clearances are cut into the geometry, and
   * the sheet from `calibrationInstructions` is where they belong.
   *
   * So this places it once. The envelope check is what keeps that honest: if a
   * future plan really did want several copies, its envelope would be wider
   * than one gauge and this refuses rather than quietly printing a single part
   * where six were meant.
   */
  public async placeSingleGaugeCalibration(
    plan: CalibrationJobPlan,
    geometry: THREE.BufferGeometry,
  ): Promise<{ readonly placed: number } | { readonly reason: string }> {
    if (plan.effects.some((effect) => effect.engineOverrides.length > 0)) {
      return { reason: `${plan.definitionId} has per-piece settings, so it is not a single-gauge calibration.` };
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return { reason: 'The gauge has no geometry to place.' };
    const size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
    const envelope = plan.geometry.requiredEnvelopeMm;
    // A millimetre of slack: the plan's envelope carries a small fit margin,
    // and the comparison is about "one copy or several", not about precision.
    const matchesOneCopy = size.every((value, index) => Math.abs(value - envelope[index]) < 1);
    if (!matchesOneCopy) {
      return {
        reason:
          `${plan.definitionId} wants an envelope of ${envelope.join(' × ')} mm but the gauge is ` +
          `${size.map((value) => value.toFixed(3)).join(' × ')} mm, so this is not one copy of it.`,
      };
    }
    this.canonicalProject.importBufferGeometry(geometry, { name: plan.label });
    return { placed: 1 };
  }

  /**
   * Load and place the calibration geometry a workflow needs (P8.2, P8.3).
   *
   * The bytes go through `loadCalibrationResource`, so a resource that is not
   * the audited one refuses the whole placement rather than being printed. That
   * matters here more than it looks: the compiler's bed-fit numbers were
   * audited from those exact bytes, and different geometry under the same name
   * would place a calibration off the plate with nothing complaining.
   *
   * Only the single-gauge shape is handled. The flow families come through
   * `applyFlowCalibrationResource`, and the line sweeps are generated programs
   * rather than placements — asking this to cover them would mean one function
   * pretending three different mechanisms are one.
   */
  public async placeCalibrationGeometry(): Promise<{ readonly placed: number } | { readonly reason: string }> {
    const preview = this.calibrationFormPreview;
    const plan = preview?.plan ?? null;
    if (!plan) return { reason: 'The calibration parameters do not compile, so there is nothing to place.' };
    const resource = (plan.geometry.resources as readonly any[]).find((entry) => entry.role === 'model');
    if (!resource) return { reason: `${plan.definitionId} names no model resource to place.` };
    let bytes: Uint8Array;
    try {
      bytes = await loadCalibrationResource(resource);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    const geometry = new STLLoader().parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const opened = this.canonicalProject.beginCalibrationSession();
    const result = await this.placeSingleGaugeCalibration(plan, geometry);
    if ('reason' in result) {
      // A refused placement must not leave the operator inside an empty
      // calibration session they did not ask for.
      if (opened) this.canonicalProject.cancelCalibrationSession();
      return result;
    }
    this.setStatus(`Placed ${plan.label}. ${opened ? 'Your project is held aside.' : ''}`.trim());
    this.onCalibrationSessionChanged?.();
    return result;
  }

  // --- Exploded assembly view (P5.3.2) ---------------------------------
  /** 1 is assembled; above that the parts move apart. View state only. */
  private explosionFactor = 1;
  public onExplosionChanged: (() => void) | null = null;

  public getExplosionFactor(): number {
    return this.explosionFactor;
  }

  /**
   * Move the rendered parts apart without moving the project (P5.3.2).
   *
   * The acceptance is explicit that explosion is a view-only projection which
   * never mutates canonical placement, so this writes to the *display* objects
   * and nothing else — the offsets are applied to the Three group each instance
   * projects into, and the canonical transform behind it is untouched. That is
   * why the factor is workspace state rather than a command: an exploded view
   * that entered undo history would be an edit pretending to be a camera.
   *
   * `projectExplosion` returns offsets that are exactly zero at factor 1, so
   * assembling again restores the projected positions rather than approximating
   * them back.
   */
  public setExplosionFactor(factor: number): boolean {
    if (!Number.isFinite(factor) || factor < 1) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.anExplosionFactorMustBe',
          'An explosion factor must be at least 1, where 1 is fully assembled.',
        ),
      );
      return false;
    }
    this.explosionFactor = factor;
    this.applyExplosion();
    this.onExplosionChanged?.();
    return true;
  }

  /** Re-place every rendered instance for the current factor. */
  private applyExplosion(): void {
    const entries = this.models.filter((entry) => entry.viewer.parent);
    if (entries.length === 0) return;
    const inputs = entries.map((entry) => {
      const base = this.explosionBaseline.get(entry.instanceId) ?? entry.viewer.position.clone();
      this.explosionBaseline.set(entry.instanceId, base);
      return { id: String(entry.instanceId), centerMm: [base.x, base.y, base.z] as Vec3 };
    });
    const offsets = new Map(projectExplosion(inputs, this.explosionFactor).map((o) => [o.id, o.offsetMm]));
    for (const entry of entries) {
      const base = this.explosionBaseline.get(entry.instanceId);
      const offset = offsets.get(String(entry.instanceId));
      if (!base || !offset) continue;
      entry.viewer.position.set(base.x + offset[0], base.y + offset[1], base.z + offset[2]);
    }
  }

  /**
   * Where each instance sits when assembled.
   *
   * Held separately so repeated factor changes compose from the assembled
   * positions rather than from the last exploded ones, which would drift the
   * parts further apart on every adjustment.
   */
  private readonly explosionBaseline = new Map<InstanceId, THREE.Vector3>();

  public onCalibrationParametersChanged: (() => void) | null = null;

  public getCalibrationWorkflowId(): string {
    return this.calibrationWorkflowId;
  }

  public getCalibrationEdits(): Readonly<Record<string, string>> {
    return { ...this.calibrationEdits };
  }

  /** Choose which calibration the parameter surface is configuring. */
  public setCalibrationWorkflow(id: string): boolean {
    // Not validated here on purpose. The pinned definitions are the authority
    // on which calibrations exist, and `buildCalibrationForm` already reports
    // an unknown one as `unknown-definition`. Importing the inventory to check
    // it a second time pulled the whole generated catalog into the main chunk
    // — 54 KB every visitor pays for a check that was already being made.
    if (this.calibrationWorkflowId === id) return true;
    this.calibrationWorkflowId = id;
    // Edits belong to the calibration they were typed for: two definitions can
    // share a parameter key and mean different things by it, so carrying them
    // across would apply one workflow's numbers to another's parameters.
    this.calibrationEdits = {};
    this.onCalibrationParametersChanged?.();
    return true;
  }

  /** Set one parameter, as text — parsing belongs to the form, not here. */
  public setCalibrationParameter(key: string, text: string): boolean {
    if (key.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.aCalibrationParameterNeedsA', 'A calibration parameter needs a name.'));
      return false;
    }
    this.calibrationEdits = { ...this.calibrationEdits, [key]: text };
    this.onCalibrationParametersChanged?.();
    return true;
  }

  /** Put the definition's own defaults back. */
  public resetCalibrationParameters(): boolean {
    if (Object.keys(this.calibrationEdits).length === 0) return false;
    this.calibrationEdits = {};
    this.onCalibrationParametersChanged?.();
    return true;
  }

  public onCalibrationSessionChanged: (() => void) | null = null;

  /** Whether a calibration currently owns the editor instead of the project. */
  public get calibrationSessionOpen(): boolean {
    return this.canonicalProject.calibrationSessionOpen;
  }

  /** Give the operator their project back, exactly as it was. */
  public discardCalibrationSession(): boolean {
    if (!this.canonicalProject.cancelCalibrationSession()) {
      this.setStatus(t('workspace.orcaWorkspace.thereIsNoCalibrationTo', 'There is no calibration to discard.'));
      return false;
    }
    // Same refresh the New Project path performs after a wholesale canonical
    // reset: the scene, the toolpath preview, and every surface that caches a
    // published result have to follow the state rather than the other way round.
    this.clearToolpathPreview();
    this.publishedGcode = null;
    this.onDownloadReady?.(false);
    this.onSelectionChanged?.(false);
    this.onPlatesChanged?.();
    this.setStatus(
      t(
        'workspace.orcaWorkspace.calibrationDiscardedYourProjectIs',
        'Calibration discarded; your project is back exactly as it was.',
      ),
    );
    this.onCalibrationSessionChanged?.();
    return true;
  }

  /** Keep the calibration as the project, and let the held one go. */
  public keepCalibrationSession(): boolean {
    if (!this.canonicalProject.keepCalibrationSession()) {
      this.setStatus(t('workspace.orcaWorkspace.thereIsNoCalibrationTo2', 'There is no calibration to keep.'));
      return false;
    }
    this.setStatus(
      t(
        'workspace.orcaWorkspace.keptTheCalibrationAsYour',
        'Kept the calibration as your project; the held one was discarded.',
      ),
    );
    this.onCalibrationSessionChanged?.();
    return true;
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
      this.setStatus(t('workspace.orcaWorkspace.plateDeleted', 'Plate deleted.'));
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
    this.setStatus(t('workspace.orcaWorkspace.reorderedBuildPlates', 'Reordered build plates.'));
    this.onPlatesChanged?.();
  }

  public setPlatePrintable(id: PlateId, printable: boolean, expectedRevision?: number): void {
    this.canonicalProject.setPlatePrintable(id, printable, expectedRevision);
    this.revalidatePublishedGcode();
    this.setStatus(printable ? 'Included build plate in print output.' : 'Excluded build plate from print output.');
    this.onPlatesChanged?.();
  }

  // --- Simplify preview (P5.3.5) --------------------------------------
  /** Decimations computed and shown, but not yet installed. */
  private simplifyPreview: {
    readonly prepared: readonly PreparedSimplify[];
    readonly restore: readonly { readonly display: THREE.Mesh; readonly geometry: THREE.BufferGeometry }[];
    readonly configuration: SimplifyConfiguration;
  } | null = null;
  public onSimplifyStateChanged: (() => void) | null = null;

  /**
   * Decimate every selected part and show the result, without committing.
   *
   * The pinned gizmo previews before it applies, and the reason is not
   * decoration: decimation is the one edit that cannot be inspected after the
   * fact, because the thing it removed is gone. What is drawn here is the exact
   * mesh {@link applySimplifyPreview} will install — the same prepared object,
   * not a second run of the same settings — so the Accept clause's "the preview
   * matches the applied result" holds by construction.
   *
   * Canonical state is untouched until apply, so cancel is a restore of the
   * display and nothing else.
   */
  public previewSimplify(configuration: SimplifyConfiguration): boolean {
    this.cancelSimplifyPreview();
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToSimplify', 'Select a model to simplify.'));
      return false;
    }
    const prepared: PreparedSimplify[] = [];
    try {
      for (const volumeId of volumes) {
        const result = this.canonicalProject.prepareSimplifyVolume(volumeId, configuration);
        if (result) prepared.push(result);
      }
    } catch (error) {
      this.setStatus(`Simplify failed: ${(error as Error).message}`);
      return false;
    }
    if (prepared.length === 0) {
      this.setStatus(
        configuration.useCount ? 'Nothing to simplify at that ratio.' : 'Nothing to simplify within that error limit.',
      );
      this.onSimplifyStateChanged?.();
      return false;
    }

    const byVolume = new Map(prepared.map((entry) => [entry.volumeId, entry]));
    const restore: { display: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
    for (const target of this.paintTargets()) {
      const entry = byVolume.get(target.volumeId);
      if (!entry) continue;
      restore.push({ display: target.display, geometry: target.display.geometry });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([...entry.positions], 3));
      geometry.setIndex([...entry.indices]);
      geometry.computeVertexNormals();
      target.display.geometry = geometry;
    }
    this.simplifyPreview = { prepared, restore, configuration };
    const before = prepared.reduce((sum, entry) => sum + entry.beforeTriangles, 0);
    const after = prepared.reduce((sum, entry) => sum + entry.afterTriangles, 0);
    this.setStatus(`Simplify preview: ${before} → ${after} triangles. Apply keeps it; cancel restores the model.`);
    this.onSimplifyStateChanged?.();
    return true;
  }

  /** Install exactly what the preview drew, as one undoable run. */
  public applySimplifyPreview(): boolean {
    const session = this.simplifyPreview;
    if (!session) {
      this.setStatus(t('workspace.orcaWorkspace.thereIsNoSimplifyPreview', 'There is no simplify preview to apply.'));
      return false;
    }
    let before = 0;
    let after = 0;
    try {
      for (const entry of session.prepared) {
        const result = this.canonicalProject.applyPreparedSimplify(entry);
        before += result.beforeTriangles;
        after += result.afterTriangles;
      }
    } catch (error) {
      // The guard refused, which means the part moved on under the preview.
      // Restore what the operator was looking at rather than leaving a stale
      // mesh on screen claiming to be the model.
      this.cancelSimplifyPreview();
      this.setStatus(`Simplify failed: ${(error as Error).message}`);
      return false;
    }
    this.simplifyPreview = null;
    this.refreshPaintOverlays();
    this.recomputePreflight();
    this.setStatus(
      `Simplified ${session.prepared.length} part(s): ${before} → ${after} triangles. ` +
        'Painting was reset; undo restores both.',
    );
    this.onSimplifyStateChanged?.();
    return true;
  }

  /** Put the original meshes back on screen; canonical state never moved. */
  public cancelSimplifyPreview(): boolean {
    const session = this.simplifyPreview;
    if (!session) return false;
    for (const entry of session.restore) {
      const previewed = entry.display.geometry;
      entry.display.geometry = entry.geometry;
      if (previewed !== entry.geometry) previewed.dispose();
    }
    this.simplifyPreview = null;
    this.onSimplifyStateChanged?.();
    return true;
  }

  /** Read-only view a simplify surface renders. */
  public getSimplifySnapshot(): {
    readonly previewing: boolean;
    readonly parts: number;
    readonly beforeTriangles: number;
    readonly afterTriangles: number;
    readonly stoppedOnError: boolean;
    readonly configuration: SimplifyConfiguration | null;
  } {
    const session = this.simplifyPreview;
    return Object.freeze({
      previewing: session !== null,
      parts: session?.prepared.length ?? 0,
      beforeTriangles: session?.prepared.reduce((sum, entry) => sum + entry.beforeTriangles, 0) ?? 0,
      afterTriangles: session?.prepared.reduce((sum, entry) => sum + entry.afterTriangles, 0) ?? 0,
      stoppedOnError: session?.prepared.some((entry) => entry.stoppedOnError) ?? false,
      configuration: session?.configuration ?? null,
    });
  }

  /** Projection-only simplification is forbidden until a canonical topology command owns it. */
  /**
   * Decimate every selected part. Each volume installs through the guarded
   * topology command, so the whole run is undoable and a failure on one part
   * leaves the rest — and the project — exactly as they were.
   */
  public simplifySelected(decimateRatio = 50): boolean {
    const volumes = this.paintableSelectedVolumes();
    if (volumes.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToSimplify2', 'Select a model to simplify.'));
      return false;
    }
    let before = 0;
    let after = 0;
    let changed = 0;
    for (const volumeId of volumes) {
      try {
        const result = this.canonicalProject.simplifyVolume(volumeId, {
          useCount: true,
          decimateRatio,
          maxError: SIMPLIFY_DEFAULT_MAX_ERROR,
        });
        before += result.beforeTriangles;
        after += result.afterTriangles;
        if (result.afterTriangles < result.beforeTriangles) changed += 1;
      } catch (error) {
        this.setStatus(`Simplify failed: ${(error as Error).message}`);
        return false;
      }
    }
    if (changed === 0) {
      this.setStatus(t('workspace.orcaWorkspace.nothingToSimplifyAtThat', 'Nothing to simplify at that ratio.'));
      return false;
    }
    this.refreshPaintOverlays();
    this.recomputePreflight();
    this.setStatus(
      `Simplified ${changed} part(s): ${before} → ${after} triangles. Painting was reset; undo restores both.`,
    );
    return true;
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
    const source = this.canonicalProject.createCanonicalSliceSource();
    // Per-plate artifacts are one guarded set: drift invalidates all of them.
    if (this.publishedPlateGcode && !source.isCurrent(this.publishedPlateGcode.guard)) {
      this.publishedPlateGcode = null;
    }
    const published = this.publishedGcode;
    if (!published) return null;
    const gcode = source.isCurrent(published.guard) ? published.gcode : null;
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

  /** One node's overrides, its chain, and the resolved config (P6.5). */
  public getScopedOverrideSnapshot(target: ScopedOverrideTarget): ScopedOverrideSnapshot {
    return this.canonicalProject.getScopedOverrideSnapshot(target);
  }

  /** Every node a scoped edit can address, in containment order. */
  /** The settings target the current selection names, for a panel that follows it. */
  public scopedOverrideTargetIdForSelection(): string | null {
    return this.canonicalProject.scopedOverrideTargetIdForSelection();
  }

  public listScopedOverrideTargets(): readonly ScopedOverrideTargetOption[] {
    return this.canonicalProject.listScopedOverrideTargets();
  }

  /**
   * Replace one node's in-scope overrides. Any scope changes what the engine
   * will produce, so a published G-code artifact stops being current here just
   * as it does for a project-wide change.
   */
  public setScopedOverrides(
    target: ScopedOverrideTarget,
    overrides: Readonly<ConfigMap>,
    guard: ScopedOverrideGuard,
  ): ScopedOverrideSnapshot {
    const result = this.canonicalProject.setScopedOverrides(target, overrides, guard);
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
   * Warm the local engine's DOWNLOAD after import has settled — never its
   * instance.
   *
   * This used to call `slicer.load()`, which instantiates the module: a 256 MB
   * shared heap plus a preallocated pool of ten Web Workers, committed 1.2 s
   * after every single import, in the same renderer process that is holding the
   * model the operator just opened. Nothing had asked to slice yet, and on the
   * primary route nothing would have used that instance anyway — FullSpectrum
   * project slices run on `sliceWorker`, which builds its own second instance,
   * so a warmed main-thread module was a quarter-gigabyte of resident memory
   * standing by for the fallback path. When the renderer lost that bet the tab
   * was killed and reloaded, and the model went with it.
   *
   * Fetching the ~15 MB of wasm is the part that actually made a first Slice
   * feel slow, and `prefetchEngine` warms exactly that at no heap cost. The
   * module is instantiated on Slice, deduplicated as before, now from bytes
   * that are already local. An external slicer has no browser WASM cost and
   * intentionally skips this path.
   */
  private warmSlicerAfterFirstModel() {
    if (this.slicerWarmupQueued || SlicerClient.useExternalSlicer()) return;
    this.slicerWarmupQueued = true;
    window.setTimeout(() => {
      this.slicer.prefetchEngine().catch((e) => {
        console.warn('[slicer] engine prefetch failed; Slice will fetch it directly:', e);
        this.slicerWarmupQueued = false;
      });
    }, 1200);
  }

  /**
   * Build/replace the toolpath preview from G-code. Colour, filtering, and the
   * layer window all come from the bounded rich model and preview projection,
   * so the viewer never invents metadata the source does not carry.
   */
  private showToolpathPreview(
    gcode: string,
    source: GcodePreviewSessionSource = { kind: 'slice', name: 'plate' },
  ): boolean {
    this.clearToolpathPreview();
    try {
      this.previewSession = GcodePreviewSession.fromGcode(gcode, source);
    } catch (error) {
      this.setStatus(`Could not read the G-code: ${(error as Error).message}`);
      return false;
    }
    // Read the engine's own totals once, from the artifact now on screen.
    this.previewSummary = summarizeGcodeArtifact(gcode);
    return this.renderPreviewProjection();
  }

  /** Redraw the active preview session; returns false when nothing is drawn. */
  private renderPreviewProjection(): boolean {
    const session = this.previewSession;
    if (!session) return false;
    try {
      if (!this.previewSurface) {
        this.previewSurface = this.previewSurfaceFactory({
          parent: this.workspace,
          worldUnitsPerMm: MM * WORKSPACE_SCALE,
          originOffsetMm: [-this.bedMm.x / 2, -this.bedMm.y / 2, 0],
        });
      }
      const projection = session.project();
      if (projection.status !== 'ready') {
        const missing = projection.missingMetadata.map((entry) => entry.message).join(' ');
        return this.deactivatePreviewRendering(
          `${projection.mode.label} needs data this G-code does not carry. ${missing}`.trim(),
        );
      }
      const result = this.previewSurface.render(session.model, projection);
      if (result.segmentCount === 0) {
        return this.deactivatePreviewRendering(
          'Preview has no drawable moves in the current layer and move filters. Widen the range or enable a move class and try again.',
        );
      }
      this.previewUnsupportedReason = null;
      this.previewOn = true;
      this.previewSurface.setVisible(true);
      // Ghost the models so the toolpath reads clearly.
      for (const model of this.models) model.viewer.visible = false;
      this.onPreviewStateChanged?.();
      return true;
    } catch (error) {
      return this.deactivatePreviewRendering(previewRenderFailureMessage(error));
    }
  }

  private deactivatePreviewRendering(reason: string): false {
    this.previewSurface?.clear();
    this.previewSurface?.setVisible(false);
    this.previewOn = false;
    this.previewUnsupportedReason = reason;
    for (const model of this.models) model.viewer.visible = true;
    this.setStatus(reason);
    this.onPreviewStateChanged?.();
    return false;
  }

  private clearToolpathPreview() {
    this.previewSurface?.clear();
    this.previewSurface?.setVisible(false);
    this.previewSession = null;
    this.previewSummary = null;
    this.previewOn = false;
    this.previewUnsupportedReason = null;
    for (const m of this.models) m.viewer.visible = true;
    this.onPreviewStateChanged?.();
  }

  /** Read-only preview state for DOM/XR surfaces and automation. */
  public getPreviewState(): {
    readonly active: boolean;
    readonly source?: GcodePreviewSessionSource;
    readonly view?: GcodePreviewViewState;
    readonly layerBounds?: readonly [number, number];
    readonly modes: typeof GCODE_PREVIEW_MODES;
    readonly moveFilters: typeof GCODE_PREVIEW_MOVE_FILTERS;
    readonly legend: readonly { id: string; label: string; code: string; accessibleLabel: string; color: string }[];
    readonly range?: { min: number; max: number; unit: string; scale: string };
    readonly unsupportedReason?: string;
    readonly limitations: readonly string[];
    readonly layerLabel?: string;
    /** Top Z of the layer the viewer is showing; the height an authored event uses. */
    readonly layerTopZMm?: number;
    /** Events the artifact itself contains, in print order. */
    readonly ticks: readonly {
      readonly id: string;
      readonly kind: 'tool-change' | 'color-change' | 'pause' | 'custom';
      readonly label: string;
      readonly layer: number;
      readonly zMm: number;
    }[];
    /** Totals the engine wrote into this artifact; absent when it stated none. */
    readonly summary?: GcodeArtifactSummary;
  } {
    const session = this.previewSession;
    const base = { modes: GCODE_PREVIEW_MODES, moveFilters: GCODE_PREVIEW_MOVE_FILTERS };
    if (!session) return { active: false, legend: [], limitations: [], ticks: [], ...base };
    const projection = session.project();
    const inspection = session.inspect();
    const unsupportedReason =
      this.previewUnsupportedReason ??
      (projection.status === 'unsupported'
        ? projection.missingMetadata.map((entry) => entry.message).join(' ')
        : undefined);
    const legend =
      projection.status === 'ready'
        ? projection.legend.map((entry) => ({
            id: entry.id,
            label: entry.label,
            code: entry.code,
            accessibleLabel: entry.accessibleLabel,
            color: rgbaToHex(entry.color),
          }))
        : [];
    return {
      active: this.previewOn,
      source: session.source,
      view: session.getView(),
      layerBounds: session.layerBounds,
      ...base,
      legend,
      ...(projection.status === 'ready' && projection.range
        ? {
            range: {
              min: projection.range.min,
              max: projection.range.max,
              unit: projection.range.unit,
              scale: projection.range.scale,
            },
          }
        : {}),
      ...(unsupportedReason ? { unsupportedReason } : {}),
      limitations: [
        // First, because on a streamed print it explains what the viewer is
        // actually looking at.
        ...(session.windowNotice() ? [session.windowNotice()!] : []),
        ...projection.limitations.map((entry) => entry.message),
        ...inspection.limitations.map((entry) => entry.message),
      ],
      ...(inspection.layerSelection
        ? {
            layerLabel: inspection.layerSelection.accessibleLabel,
            layerTopZMm: inspection.layerSelection.lastZMm,
          }
        : {}),
      ...(this.previewSummary && !this.previewSummary.empty ? { summary: this.previewSummary } : {}),
      // Report each event at the height its layer prints at. The record's own Z
      // is wherever the toolhead happened to be when the marker was emitted —
      // usually the previous layer, since the Z move follows the layer change.
      ticks: inspection.ticks.map((tick) => ({
        id: tick.id,
        kind: tick.kind,
        label: tick.label,
        layer: tick.layer,
        zMm: layerPrintZ(inspection.layers, tick.layer) ?? tick.zMm,
      })),
    };
  }

  /** Apply a bounded preview view change and redraw. */
  public updatePreviewView(patch: GcodePreviewViewPatch): boolean {
    if (!this.previewSession) {
      this.setStatus(
        t('workspace.orcaWorkspace.sliceOrOpenGCode', 'Slice or open G-code before changing the preview.'),
      );
      return false;
    }
    try {
      this.previewSession.updateView(patch);
    } catch (error) {
      this.setStatus(`Preview: ${(error as Error).message}`);
      return false;
    }
    return this.renderPreviewProjection();
  }

  /** Open a standalone G-code artifact in the viewer without touching the project. */
  public openGcodeForPreview(gcode: string, name: string): boolean {
    if (!gcode.trim()) {
      this.setStatus(`${name} is empty.`);
      return false;
    }
    if (!this.showToolpathPreview(gcode, { kind: 'file', name })) return false;
    const session = this.previewSession;
    if (!session) return false;
    const layers = session.layerBounds;
    this.setStatus(`Viewing ${name} — layers ${layers[0]}–${layers[1]}.`);
    return true;
  }

  /** Toggle between toolpath preview and model view (panel + tests). */
  togglePreview(): boolean {
    if (this.previewOn) {
      this.clearToolpathPreview();
      this.setStatus(t('workspace.orcaWorkspace.modelView', 'model view'));
      return true;
    } else {
      const gcode = this.getLastGcode();
      if (!gcode) {
        this.setStatus(
          this.publishedGcode
            ? 'project changed — slice again to preview current toolpaths'
            : 'slice first to preview toolpaths',
        );
        return false;
      }
      if (!this.showToolpathPreview(gcode)) return false;
      this.setStatus(t('workspace.orcaWorkspace.toolpathPreview', 'toolpath preview'));
      return true;
    }
  }

  /** Apply one stepper increment of the active tool to the target model. */
  nudgeSelected(dir: -1 | 1) {
    const selected = this.selectedModel;
    const instance = selected ? this.canonicalProject.getInstance(selected.instanceId) : undefined;
    if (!selected || !instance) {
      this.setStatus(t('workspace.orcaWorkspace.noModel', 'no model'));
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
   * The headset's half of one-press filament assignment.
   *
   * The flat shell puts a chip bar under a model the moment it is selected;
   * this is the same canonical action on the Profiles card, so a selection made
   * with a controller ray can be given a filament without leaving the headset
   * for the inspector's confirming selector. Both surfaces read the same
   * revision-guarded snapshot and both invoke `objects_assign_filament`, so
   * neither can drift into a second assignment path.
   */
  private refreshXrSelectionFilaments(): void {
    const panel = this.xrSelectionFilamentContainer;
    if (!panel) return;
    for (const child of [...panel.children]) {
      try {
        panel.remove(child);
      } catch {
        /* already detached */
      }
    }
    if (this.disposed) return;
    const snapshot = this.getFilamentAssignmentSnapshot();
    // Nothing assignable is not a message here either — the row simply is not
    // part of the card.
    if (snapshot.scopes.length === 0 || snapshot.unsupportedSelection.length > 0) return;

    const label =
      snapshot.scopes.length === 1
        ? snapshot.scopes[0].label
        : `${snapshot.scopes.length} ${t('workspace.orcaWorkspace.selectedScopes', 'selected')}`;
    panel.add(
      new UIText(t('workspace.orcaWorkspace.filamentForSelection', 'FILAMENT FOR SELECTION').toUpperCase(), {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#8a94a0',
      }),
    );
    panel.add(new UIText(label, { fontSize: 14, color: '#ffffff' }));

    const current = uniformLocalFilament(snapshot);
    const row = new UIPanel({ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' });
    for (const option of [
      ...snapshot.options.filter((candidate) => candidate.kind === 'physical'),
      ...snapshot.options.filter((candidate) => candidate.kind === 'mixed'),
    ]) {
      if (!option.enabled) continue;
      const swatch = new UIPanel({
        width: 35,
        height: 35,
        cornerRadius: 4,
        fillColor: option.color,
        strokeWidth: 2,
        strokeColor: current === option.id ? '#ffffff' : '#444444',
        onClick: () => {
          this.assignSelectionFilamentFromXr(option.id);
          return true;
        },
      });
      row.add(swatch);
    }
    const clear = new UIPanel({
      height: 35,
      paddingLeft: 10,
      paddingRight: 10,
      justifyContent: 'center',
      alignItems: 'center',
      cornerRadius: 4,
      fillColor: '#ffffff14',
      strokeWidth: 2,
      strokeColor: current === null ? '#ffffff' : '#444444',
      onClick: () => {
        this.assignSelectionFilamentFromXr(null);
        return true;
      },
    });
    clear.add(new UIText(t('workspace.orcaWorkspace.defaultFilament', 'Default'), { fontSize: 12, color: '#ffffff' }));
    row.add(clear);
    panel.add(row);
  }

  /** One press in XR, through the same registry action the flat shell uses. */
  private assignSelectionFilamentFromXr(filamentId: FilamentId | null): void {
    const context = this.actionContext;
    if (!context) return;
    const snapshot = this.getFilamentAssignmentSnapshot();
    if (snapshot.scopes.length === 0 || snapshot.unsupportedSelection.length > 0) return;
    void this.actionRegistry
      .invoke('objects_assign_filament', 'xr-inspector', context, context.ui.get(), {
        objectsFilamentAssignment: {
          entities: snapshot.scopes.map((scope) => scope.entity),
          filamentId,
          sourceRevision: snapshot.sourceRevision,
          sourceHash: snapshot.sourceHash,
        },
      })
      .then(() => this.refreshXrSelectionFilaments());
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
  private toolButtons: XrActionHandle<UIPanel, XRImage>[] = [];
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
  /** The spatial printer status card (P9.7) and everything it repaints. */
  private printerStatusCard: ReturnType<UICore['createCard']> | null = null;
  private printerStatusHeadline: UIText | null = null;
  private printerStatusDetail: UIText | null = null;
  private printerStatusRecovery: UIText | null = null;
  private printerStatusProgressFill: UIPanel | null = null;
  private printerStatusControls: UIPanel | null = null;
  private printerStatusHoldNote: UIText | null = null;
  private printerStatusHoldFills = new Map<PrintJobCommand, UIPanel>();
  private printerStatusActions: readonly GuardedPrinterAction[] = [];
  /** The control a ray is currently over; a trigger press starts its hold. */
  private printerHoldTarget: GuardedPrinterAction | null = null;
  private printerHoldController: unknown = null;
  private readonly printerHold = new HoldToConfirm();
  // Design's top HUD strip (wordmark + mode switch) and bottom action bar.
  private topStripCard: UICard | null = null;
  private bottomBarCard: UICard | null = null;
  private previewScrubberCard: UICard | null = null;
  private previewScrubberRender: XrPreviewScrubberRender<any, any> | null = null;
  private xrMode: XrWorkspace = 'prepare';
  private xrModeButtons: { mode: XrWorkspace; btn: UIPanel; label: UIText }[] = [];

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
    build('printer status', () => this.addPrinterStatusPanel());
    build('bottom bar', () => this.addBottomBar());
    build('slice progress', () => this.addSliceModal());
    build('preview scrubber', () => this.addPreviewScrubber());
    this.refreshToolButtons();
  }

  /** Top-centre HUD strip: wordmark + dropdown menu bar + Prepare/Paint/Preview
   *  mode switch + Exit. Mirrors the imported design's "MENU STRIP" zone: the
   *  menus open a single dropdown panel (addActionPanel) one section at a time,
   *  instead of the old always-open, floor-length action list. */
  private addTopStrip() {
    const card = this.uiCore.createCard({
      name: 'TopStrip',
      ...this.xrCardGeometry('menu'),
      position: new THREE.Vector3(0, PLATE_Y + 0.65, PLATE_Z - 0.1),
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

    // Two rows, because the flat shell has two: a menu strip over a tab strip.
    // One row could not hold a launcher, four workspaces, Slice, Print and the
    // session controls without shrinking every one of them to a target that has
    // to be aimed at.
    const shell = new UIPanel({
      width: '100%',
      flexDirection: 'column',
      alignItems: 'stretch',
      fillColor: '#0d141cE6',
      cornerRadius: 14,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      gap: 6,
      strokeWidth: 1,
      strokeColor: '#FF6D0066',
    });
    card.add(shell);
    const root = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 8 });
    shell.add(root);
    const tabRow = new UIPanel({ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 8 });
    shell.add(tabRow);

    // One launcher, not eight text targets in a ribbon. Seven menu sections
    // rendered as 15 px labels across a strip made every one of them a ~1°
    // target that had to be aimed at, and left no room for anything else on
    // the only surface above the plate. The sections now open as full-width
    // rows in the sheet, where they are read and pressed comfortably.
    this.menuBarButtons = [];
    const menuBtn = new UIPanel({
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 10,
      paddingBottom: 10,
      cornerRadius: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      fillColor: '#ffffff14',
      strokeWidth: 1,
      strokeColor: '#ffffff1a',
      justifyContent: 'center',
      onClick: () => {
        this.toggleMenu(XR_MENU_ROOT);
        return true;
      },
      onHoverEnter: () => {
        menuBtn.setFillColor('#ffffff26');
      },
      onHoverExit: () => {
        menuBtn.setFillColor('#ffffff14');
      },
    });
    menuBtn.add(new XRImage(xrIcon('slice_group'), { color: '#ffffff', width: 20, height: 20, flexShrink: 0 }));
    const menuLabel = new UIText('Menu', { fontSize: 17, fontWeight: 'bold', color: '#ffffff' });
    menuBtn.add(menuLabel);
    root.add(menuBtn);
    this.menuBarButtons.push({ id: XR_MENU_ROOT, btn: menuBtn, label: menuLabel });

    root.add(new UIPanel({ flexGrow: 1 })); // spacer pushes mode switch + exit right

    const track = new UIPanel({
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      fillColor: '#0000004d',
      cornerRadius: 10,
      padding: 4,
    });
    const modes: { mode: XrWorkspace; label: string }[] = [
      { mode: 'prepare', label: 'Prepare' },
      { mode: 'preview', label: 'Preview' },
      { mode: 'device', label: 'Device' },
      { mode: 'project', label: 'Project' },
    ];
    this.xrModeButtons = [];
    for (const m of modes) {
      const btn = new UIPanel({
        paddingLeft: 11,
        paddingRight: 11,
        paddingTop: 7,
        paddingBottom: 7,
        cornerRadius: 8,
        fillColor: '#00000000',
        justifyContent: 'center',
        alignItems: 'center',
        onClick: () => {
          this.setXrMode(m.mode);
          return true;
        },
      });
      const label = new UIText(m.label, { fontSize: 14, fontWeight: 'bold', color: '#ffffff' });
      btn.add(label);
      track.add(btn);
      this.xrModeButtons.push({ mode: m.mode, btn, label });
    }
    tabRow.add(track);

    tabRow.add(new UIPanel({ flexGrow: 1 }));
    // `Slice` and `Print` sit at the end of the tab strip, which is where the
    // flat shell puts them. They are the same registry actions the action desk
    // below runs — a second place to reach them, not a second path.
    for (const id of ['slice_active_plate', 'send_to_printer'] as const) {
      const action = this.actionRegistry.get(id);
      if (!action) continue;
      const primary = id === 'slice_active_plate';
      const btn = new UIPanel({
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 7,
        paddingBottom: 7,
        cornerRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        fillColor: primary ? '#ffb74d' : '#ffffff14',
        strokeWidth: primary ? 0 : 1,
        strokeColor: '#ffffff1a',
        justifyContent: 'center',
        onClick: () => {
          if (this.actionContext) {
            void this.actionRegistry.invoke(
              action,
              primary ? 'xr-primary' : 'xr-menu',
              this.actionContext,
              this.actionContext.ui.get(),
            );
          }
          return true;
        },
      });
      btn.add(
        new XRImage(xrIcon(action.icon), {
          color: primary ? '#000000' : '#ffffff',
          width: 16,
          height: 16,
          flexShrink: 0,
        }),
      );
      btn.add(
        new UIText(primary ? 'Slice' : 'Print', {
          fontSize: 14,
          fontWeight: 'bold',
          color: primary ? '#000000' : '#ffffff',
          flexShrink: 0,
        }),
      );
      tabRow.add(btn);
    }

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
      this.setStatus(t('workspace.orcaWorkspace.recenteringWorkspace', 'Recentering workspace…'));
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
    if (c) {
      // The sheet has its own place in the layout — centred, at reading
      // distance, in front of the work it is about to act on. Hanging it off
      // the strip's transform put it wherever the strip happened to be.
      const cam = xb.core.camera;
      const forward = new THREE.Vector3();
      cam.getWorldDirection(forward);
      this.placeXrSurface(c, 'sheet', { position: cam.getWorldPosition(new THREE.Vector3()), forward });
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
      // The strip carries one launcher, so it reads as active whenever any
      // section of the sheet is open — not only its own.
      const active = m.id === this.openMenuSection || (m.id === XR_MENU_ROOT && this.openMenuSection !== null);
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
    if (id === 'xr-device-workspace' || id === `${XR_CARD_PREFIX}printer`) {
      if (this.menuPanelTitle) this.menuPanelTitle.setText('Printer & Device');
      this.populateXrDeviceWorkspace(root);
      return;
    }
    if (id === 'xr-project-workspace' || id === `${XR_CARD_PREFIX}project`) {
      if (this.menuPanelTitle) this.menuPanelTitle.setText('Project & Calibration');
      this.populateXrProjectWorkspace(root);
      return;
    }
    if (id === 'xr-print-submission') {
      if (this.menuPanelTitle) this.menuPanelTitle.setText('Print Submission');
      this.populateXrPrintSubmission(root);
      return;
    }
    const sec = MENU_SECTIONS.find((s) => String(s.id) === id);
    if (this.menuPanelTitle) {
      this.menuPanelTitle.setText(id === XR_PANELS_SECTION_ID ? 'Panels' : sec ? sec.label : 'Menu');
    }
    const reg = this.actionRegistry;
    if (id === XR_MENU_ROOT) {
      this.populateMenuSections(root);
      return;
    }
    const card = XR_CARDS.find((entry) => entry.id === id);
    if (card) {
      if (this.menuPanelTitle) this.menuPanelTitle.setText(card.label);
      this.populateXrCard(root, card);
      return;
    }
    if (id === XR_PANELS_SECTION_ID) {
      this.populateXrPanelsSection(root);
      return;
    }
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
    for (const { action: a, surface } of entries) root.add(this.buildXrMenuRow(a, surface));
  }

  /**
   * The sheet's front page: one row per menu section, sized to be read and
   * pressed rather than aimed at. Sections with nothing in them are left out,
   * so the list never offers a dead end.
   */
  private populateMenuSections(root: UIPanel): void {
    const reg = this.actionRegistry;
    const inspector = reg.forSurface('xr-inspector');
    // The sidebar's cards first, then the menu bar's sections — the same two
    // groups of things the flat shell offers, in the same order it offers them.
    const cards = XR_CARDS.filter((card) => inspector.some((action) => card.groups.includes(action.group)));
    const sections: { id: string; label: string }[] = [
      ...cards,
      ...MENU_SECTIONS,
      ...(inspector.length > 0 ? [{ id: XR_PANELS_SECTION_ID, label: 'All panels' }] : []),
    ];
    for (const sec of sections) {
      const hasMenuItems =
        sec.id === XR_PANELS_SECTION_ID ||
        sec.id.startsWith(XR_CARD_PREFIX) ||
        reg.forSurface('xr-menu').some((x) => String(x.menuSection) === sec.id);
      const hasToolOverflow =
        sec.id === 'tools' && reg.forSurface('xr-toolbar').some((action) => !xrToolRailActions([action]).length);
      if (!hasMenuItems && !hasToolOverflow) continue;
      root.add(
        this.buildXrSheetRow(
          XR_SECTION_ICONS[sec.id] ?? XR_CARDS.find((c) => c.id === sec.id)?.icon ?? 'chevron_right',
          sec.label,
          () => {
            this.openMenuSection = sec.id;
            this.populateMenuPanel(sec.id);
            this.refreshMenuBar();
          },
        ),
      );
    }
  }

  /**
   * One sidebar card's contents: every inspector action whose group the card
   * claims, gated exactly as the DOM gates it. The rows are the same rows the
   * menu uses, so an action looks and behaves the same wherever it is reached.
   */
  private populateXrCard(root: UIPanel, card: { label: string; groups: readonly string[] }): void {
    const actions = this.actionRegistry.forSurface('xr-inspector').filter((a) => card.groups.includes(a.group));
    if (actions.length === 0) {
      root.add(
        new UIText(t('workspace.orcaWorkspace.nothingHereYet', 'Nothing here yet.'), {
          fontSize: 15,
          color: '#8a94a0',
        }),
      );
      return;
    }
    for (const action of actions) root.add(this.buildXrMenuRow(action, 'xr-inspector'));
  }

  /**
   * One row of the sheet: icon, label, and a press.
   *
   * Every list in the sheet is built through here. A second hand-written row —
   * same properties, near enough — laid out to 35,000 px tall and painted as a
   * featureless slab, so "near enough" is not a thing that can be eyeballed
   * against a flexbox engine.
   */
  private buildXrSheetRow(icon: string, label: string, onPress: () => void): UIPanel {
    const rest = '#ffffff12';
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
      fillColor: rest,
      strokeWidth: 1,
      strokeColor: '#ffffff12',
      onClick: () => {
        onPress();
        return true;
      },
      onHoverEnter: () => {
        btn.setFillColor('#ffffff24');
      },
      onHoverExit: () => {
        btn.setFillColor(rest);
      },
    });
    btn.add(new XRImage(xrIcon(icon), { color: '#dfe4ea', width: 20, height: 20, flexShrink: 0 }));
    btn.add(new UIText(label, { fontSize: 17, color: '#eef2f6', flexGrow: 1, flexShrink: 1 }));
    return btn;
  }

  /** One menu row, gated exactly as the DOM gates the same action. */
  private buildXrMenuRow(a: Action, surface: ActionSurface): UIPanel {
    const reg = this.actionRegistry;
    {
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
      return btn;
    }
  }

  /**
   * Everything the DOM shell keeps in its inspector, grouped so a long list
   * stays navigable in a headset. Rows are gated by the same capability and
   * selection state the DOM uses, so an action disabled on a screen is
   * disabled here for the same stated reason.
   */
  private populateXrPanelsSection(root: UIPanel): void {
    const reg = this.actionRegistry;
    this.addXrContextSection(root);
    const byGroup = new Map<string, Action[]>();
    for (const action of reg.forSurface('xr-inspector')) {
      const bucket = byGroup.get(action.group) ?? [];
      bucket.push(action);
      byGroup.set(action.group, bucket);
    }
    for (const group of GROUPS) {
      const actions = byGroup.get(group.id);
      if (!actions || actions.length === 0) continue;
      root.add(
        new UIText(group.label.toUpperCase(), {
          fontSize: 11,
          fontWeight: 'bold',
          color: '#8a94a0',
          paddingTop: 8,
        }),
      );
      for (const action of actions) root.add(this.buildXrMenuRow(action, 'xr-inspector'));
      // The calibration group is the one whose actions are not enough on their
      // own: `calib_configure` needs a *value*, and a menu row cannot supply
      // one. The steppers below are that missing half.
      if (group.id === 'calibration') this.addXrCalibrationParameters(root);
      if (group.id === 'scene') this.addXrSceneSteppers(root);
      if (group.id === 'advanced') this.addXrScopedSettings(root);
    }
  }

  /**
   * The right-click menu, for a shell with no right button (P11.2).
   *
   * The catalog's context targets are a placement, not a second list, so the
   * headset offers exactly what the scene's right-click offers for the same
   * kind of node — chosen by what is selected rather than by what a pointer is
   * over, because that is the addressing a headset actually has here. It leads
   * the Panels section for the same reason a context menu leads a right-click:
   * it is the answer to "what can I do with *this*".
   */
  private addXrContextSection(root: UIPanel): void {
    const target: ContextTarget =
      this.canonicalProject.getSummary().selectedInstanceIds.length > 0 ? 'object' : 'plate';
    const actions = this.actionRegistry.forContext(target, 'xr-context');
    if (actions.length === 0) return;
    root.add(
      new UIText(target === 'object' ? 'SELECTED MODEL' : 'THIS PLATE', {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#8a94a0',
      }),
    );
    for (const action of actions) root.add(this.buildXrMenuRow(action, 'xr-context'));
  }

  /**
   * Calibration parameters as steppers, which is how a headset does numbers.
   *
   * Several actions across this registry are withheld from XR with the same
   * sentence — "no in-headset number entry exists yet" — and that was true. A
   * text field needs a keyboard nobody wants in a headset, but a calibration
   * parameter does not need free text: the pinned definition carries a `step`
   * and a `range`, so the only values worth reaching are the ones a decrement
   * and an increment walk through. Bounds come from the definition rather than
   * from this surface, so a stepper cannot offer a value the compiler would
   * refuse.
   *
   * Choices cycle and booleans toggle for the same reason: the definition
   * enumerates them, so there is nothing to type.
   */
  private addXrCalibrationParameters(root: UIPanel): void {
    const preview = this.calibrationFormPreview;
    if (!preview) return;
    for (const field of preview.fields) {
      if (!field.editable) continue;
      const row = new UIPanel({
        width: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        cornerRadius: 9,
        fillColor: '#ffffff08',
      });
      const unit = field.unit ? ` ${field.unit}` : '';
      const value = new UIText(`${field.text}${unit}`, { fontSize: 15, color: '#eef2f6', flexShrink: 0 });
      row.add(new UIText(field.label, { fontSize: 15, color: '#c7ced6', flexGrow: 1, flexShrink: 1 }));
      row.add(this.xrStepButton('−', () => this.stepCalibrationField(field, -1)));
      row.add(value);
      row.add(this.xrStepButton('+', () => this.stepCalibrationField(field, 1)));
      root.add(row);
    }
  }

  /**
   * The numeric settings a scene tool needs, as steppers.
   *
   * Same reasoning as the calibration parameters: these were withheld from XR
   * because they are typed into a DOM field, and a bounded number does not have
   * to be typed. Only settings whose limits are known are offered — a stepper
   * with no bounds is a text field with extra steps, and would let a headset
   * reach a value the DOM would have refused.
   *
   * The emboss recipe is deliberately absent: its blocker is *text*, not a
   * number, and no stepper solves that.
   */
  private addXrSceneSteppers(root: UIPanel): void {
    const ears = this.getBrimEarSnapshot();
    if (ears.objectId) {
      root.add(
        this.xrStepperRow('Brim ear radius', `${ears.radiusMm}`, 'mm', (direction) => {
          const next = Math.min(
            BRIM_EAR_MAX_RADIUS_MM,
            Math.max(BRIM_EAR_MIN_RADIUS_MM, Number((ears.radiusMm + direction * 0.5).toFixed(1))),
          );
          this.setBrimEarRadius(next);
        }),
      );
    }
    const svg = this.getSvgPartSnapshot();
    if (svg.active) {
      root.add(
        this.xrStepperRow('SVG depth', `${svg.depthMm}`, 'mm', (direction) => {
          // Depth is what makes the drawing solid, so it may not reach zero:
          // a zero-depth part is geometry the slicer will silently discard.
          const next = Math.min(50, Math.max(0.2, Number((svg.depthMm + direction * 0.2).toFixed(1))));
          this.setSvgPartSize({ depthMm: next });
        }),
      );
      if (svg.widthMm !== undefined) {
        root.add(
          this.xrStepperRow('SVG width', `${svg.widthMm}`, 'mm', (direction) => {
            const next = Math.min(300, Math.max(1, Number((svg.widthMm! + direction * 1).toFixed(1))));
            this.setSvgPartSize({ widthMm: next });
          }),
        );
      }
    }
  }

  /**
   * Scoped overrides in the headset (P6.5).
   *
   * P6.5 asks for one draft and one validation across desktop, touch and XR,
   * and XR was the surface that had nothing: every route into a setting ended
   * at a text field. `settings_apply_scoped` already appears in this panel as a
   * row, and — exactly like `calib_configure` — a row cannot supply a *value*.
   * These steppers are that missing half.
   *
   * Nothing about which settings exist is decided here, and nothing about how
   * they are drawn either. The controller runs the same query the DOM panel
   * runs and applies through the same adapter; the renderer draws through the
   * mockable UI adapter, so both halves are asserted without a headset.
   */
  private addXrScopedSettings(root: UIPanel): void {
    const port = this.scopedSettingsPort;
    const render = renderXrScopedSettings(xrBlocksUiAdapter, root, port ? port.getView() : null, {
      onCycleTarget: (direction) => port?.cycleTarget(direction),
      onStep: (fieldId, direction) => port?.step(fieldId, direction),
    });
    this.xrScopedValueTexts = render.values;
    this.xrScopedSignature = render.signature;
  }

  /** The scoped-settings engine; installed by the shell that owns the catalog. */
  private scopedSettingsPort: ScopedStepperSurface | null = null;
  private xrScopedValueTexts: ReadonlyMap<string, { node: UIText; unit: string }> = new Map();
  private xrScopedSignature = '';

  public setScopedSettingsPort(port: ScopedStepperSurface | null): void {
    this.scopedSettingsPort = port;
    this.refreshXrScopedSettings();
  }

  /** The rows the headset is showing; the automation seam an e2e run drives. */
  public getScopedSettingsView(): ScopedStepperView | null {
    return this.scopedSettingsPort?.getView() ?? null;
  }

  /** Edit a named node, the way selecting a model does; the automation seam. */
  public selectScopedSettingsTarget(targetId: string): void {
    this.scopedSettingsPort?.selectTarget(targetId);
  }

  /** One press, addressed the way the rendered row addresses it. */
  public stepScopedSetting(fieldId: string, direction: 1 | -1): void {
    this.scopedSettingsPort?.step(fieldId, direction);
  }

  /**
   * Bring the open panel up to date after a press or an outside edit.
   *
   * A press changes one number, and rebuilding forty rows of spatial panels to
   * show it costs a visible hitch — so the common case writes the new text into
   * the row that already exists. The panel is rebuilt only when the *shape*
   * changed: a different node, a different row set, a message that appeared.
   */
  public refreshXrScopedSettings(): void {
    if (this.openMenuSection !== XR_PANELS_SECTION_ID) return;
    const view = this.scopedSettingsPort?.getView() ?? null;
    if (xrScopedSettingsSignature(view) !== this.xrScopedSignature) {
      this.populateMenuPanel(XR_PANELS_SECTION_ID);
      return;
    }
    for (const row of view?.rows ?? []) {
      const bound = this.xrScopedValueTexts.get(row.fieldId);
      if (bound) bound.node.setText(`${row.value}${bound.unit}`);
    }
  }

  /** One labelled value between a decrement and an increment. */
  private xrStepperRow(label: string, value: string, unit: string, onStep: (direction: 1 | -1) => void): UIPanel {
    const row = new UIPanel({
      width: '100%',
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      cornerRadius: 9,
      fillColor: '#ffffff08',
    });
    row.add(new UIText(label, { fontSize: 15, color: '#c7ced6', flexGrow: 1, flexShrink: 1 }));
    row.add(
      this.xrStepButton('−', () => {
        onStep(-1);
        if (this.openMenuSection !== null) this.populateMenuPanel(this.openMenuSection);
      }),
    );
    row.add(new UIText(`${value} ${unit}`, { fontSize: 15, color: '#eef2f6', flexShrink: 0 }));
    row.add(
      this.xrStepButton('+', () => {
        onStep(1);
        if (this.openMenuSection !== null) this.populateMenuPanel(this.openMenuSection);
      }),
    );
    return row;
  }

  private xrStepButton(label: string, onPress: () => void): UIPanel {
    const button = new UIPanel({
      paddingLeft: 14,
      paddingRight: 14,
      paddingTop: 6,
      paddingBottom: 6,
      cornerRadius: 8,
      fillColor: '#ffffff14',
      flexShrink: 0,
      onClick: () => {
        onPress();
        return true;
      },
      onHoverEnter: () => button.setFillColor('#ffffff28'),
      onHoverExit: () => button.setFillColor('#ffffff14'),
    });
    button.add(new UIText(label, { fontSize: 17, color: '#eef2f6' }));
    return button;
  }

  /** The form the XR surface renders; set by the shell that owns the catalog. */
  private calibrationFormPreview: CalibrationFormPreview | null = null;

  public setCalibrationFormPreview(preview: CalibrationFormPreview | null): void {
    this.calibrationFormPreview = preview;
  }

  /** One press of a stepper; the arithmetic lives with the form it edits. */
  private stepCalibrationField(field: CalibrationFormField, direction: 1 | -1): void {
    const next = stepCalibrationValue(field, direction);
    if (next !== null) this.setCalibrationParameter(field.key, next);
    // Re-render the open section so the value beside the stepper is the value
    // that was just set. Without this the number lags a press behind, which
    // reads as the control not working.
    if (this.openMenuSection !== null) this.populateMenuPanel(this.openMenuSection);
  }

  private populateXrDeviceWorkspace(root: UIPanel): void {
    const statusData = this.onReadPrinterStatus?.();
    const summary = statusData?.summary;
    const telemetry = {
      hotendTempC: 0,
      hotendTargetC: 0,
      bedTempC: 0,
      bedTargetC: 0,
      state: (summary?.tone === 'active'
        ? 'printing'
        : summary?.tone === 'attention'
          ? 'paused'
          : summary?.tone === 'danger'
            ? 'error'
            : 'idle') as any,
      stateMessage: summary?.headline,
      progressPercent: typeof summary?.progress === 'number' ? Math.round(summary.progress * 100) : undefined,
    };

    renderXrDeviceWorkspace(xrBlocksUiAdapter, root, {
      printerName: this.profile?.displayName ?? 'Snapmaker U1',
      telemetry,
      onPausePrint: () => {
        void this.controlPrintJob('pause');
      },
      onResumePrint: () => {
        void this.controlPrintJob('resume');
      },
      onCancelPrint: () => {
        void this.controlPrintJob('cancel');
      },
      onEmergencyStop: () => {
        void this.controlPrintJob('emergency-stop');
      },
      onClose: () => {
        if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
      },
    });
  }

  private populateXrProjectWorkspace(root: UIPanel): void {
    const summary = this.canonicalProject.getSummary();
    const recents = recentProjectsStore.list().map((r) => ({
      name: r.name,
      modelCount: r.modelCount ?? 1,
      modifiedDate: r.openedAt ? new Date(r.openedAt).toLocaleDateString() : 'Recent',
    }));

    renderXrProjectWorkspace(xrBlocksUiAdapter, root, {
      projectName: summary.projectName,
      plateCount: summary.plates.length,
      modelCount: summary.objectCount,
      isDirty: summary.dirty,
      recentProjects: recents,
      onOpenProject: () => {
        if (this.actionContext) {
          const action = this.actionRegistry.get('file_open_project');
          if (action)
            void this.actionRegistry.invoke(action, 'xr-menu', this.actionContext, this.actionContext.ui.get());
        }
      },
      onSaveProject: () => {
        if (this.actionContext) {
          const action = this.actionRegistry.get('file_save_project');
          if (action)
            void this.actionRegistry.invoke(action, 'xr-menu', this.actionContext, this.actionContext.ui.get());
        }
      },
      onExport3mf: () => {
        if (this.actionContext) {
          const action = this.actionRegistry.get('file_export_3mf');
          if (action)
            void this.actionRegistry.invoke(action, 'xr-menu', this.actionContext, this.actionContext.ui.get());
        }
      },
      onSelectCalibrationWorkflow: (workflowId) => {
        if (this.actionContext) {
          const action = this.actionRegistry.get(workflowId);
          if (action) {
            void this.actionRegistry.invoke(action, 'xr-menu', this.actionContext, this.actionContext.ui.get());
            if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
          }
        }
      },
      onClose: () => {
        if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
      },
    });
  }

  private printSubmissionResolve:
    ((decision: { choice: 'upload-and-print' | 'upload-only' | 'cancel'; overwrite: boolean }) => void) | null = null;
  private pendingPrintInput: any = null;

  public askXrPrintSubmission(
    input: any,
  ): Promise<{ choice: 'upload-and-print' | 'upload-only' | 'cancel'; overwrite: boolean }> {
    this.pendingPrintInput = input;
    return new Promise((resolve) => {
      this.printSubmissionResolve = resolve;
      this.toggleMenu('xr-print-submission');
    });
  }

  private populateXrPrintSubmission(root: UIPanel): void {
    const input = this.pendingPrintInput;
    if (!input) return;

    const toolSlots = input.toolSummary
      ? [
          {
            toolNumber: 1,
            toolName: 'Extruder T1',
            toolColor: '#ff6d00',
            toolType: 'PLA',
            mappedPrinterSlot: 1,
          },
        ]
      : [];

    renderXrPrintSubmissionDialog(xrBlocksUiAdapter, root, {
      printerName: input.endpointLabel || 'Snapmaker U1',
      availablePrinters: [input.endpointLabel || 'Snapmaker U1'],
      plateName: input.plateName || 'Plate 1',
      nozzleMm: Number(this.headNozzles[0] ?? '0.4'),
      bedType: this.profile?.displayName ?? 'Smooth PEI',
      estimatedDurationFormatted: input.estimatedDurationFormatted ?? '1h 15m',
      estimatedWeightGrams: input.estimatedWeightGrams ?? 35,
      estimatedCostFormatted: input.estimatedCostFormatted,
      toolSlots,
      readyToPrint: (input.blockers?.length ?? 0) === 0,
      blockedReason: input.blockers?.[0],
      onSendAndPrint: () => {
        this.printSubmissionResolve?.({ choice: 'upload-and-print', overwrite: true });
        this.printSubmissionResolve = null;
        this.pendingPrintInput = null;
        if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
      },
      onSendOnly: () => {
        this.printSubmissionResolve?.({ choice: 'upload-only', overwrite: true });
        this.printSubmissionResolve = null;
        this.pendingPrintInput = null;
        if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
      },
      onCancel: () => {
        this.printSubmissionResolve?.({ choice: 'cancel', overwrite: false });
        this.printSubmissionResolve = null;
        this.pendingPrintInput = null;
        if (this.openMenuSection !== null) this.toggleMenu(this.openMenuSection);
      },
    });
  }

  private addPreviewScrubber() {
    const card = this.uiCore.createCard({
      name: 'PreviewScrubber',
      ...this.xrCardGeometry('scrubber'),
      position: new THREE.Vector3(0, PLATE_Y - 0.1, PLATE_Z + 0.2),
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
    this.previewScrubberCard = card;

    const root = new UIPanel({
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      fillColor: '#00000000',
    });
    card.add(root);

    const state = this.getPreviewState();
    this.previewScrubberRender = renderXrPreviewScrubber(xrBlocksUiAdapter, root, state as any, {
      onUpdateView: (patch) => {
        this.updatePreviewView(patch);
        this.refreshXrPreviewScrubber();
      },
      onAuthorEvent: (type, topZMm) => {
        const summary = this.canonicalProject.getSummary();
        this.mutateLayerEvent({
          expectedRevision: summary.revision,
          sourceHash: summary.projectHash,
          operation: 'add',
          type,
          topZMm,
        });
      },
    });
  }

  public refreshXrPreviewScrubber() {
    if (!this.previewScrubberCard || !this.previewScrubberRender) return;
    const state = this.getPreviewState();
    if (this.previewOn && state.active) {
      this.previewScrubberCard.show();
      this.previewScrubberRender.refresh(state as any);
    } else {
      this.previewScrubberCard.hide();
    }
  }

  private setXrMode(mode: XrWorkspace) {
    this.xrMode = mode;
    if (this.actionContext) {
      if (mode === 'device' || mode === 'project') {
        // Device and Project are pages on a screen and sheets in a headset —
        // the same content, reached from the same tab, without disturbing what
        // the plate is showing. That is exactly what the flat shell does: its
        // pages leave the mode alone.
        this.toggleMenu(mode === 'device' ? 'xr-device-workspace' : 'xr-project-workspace');
      } else if (mode === 'preview') {
        this.actionContext.setMode('preview');
        if (!this.previewOn) this.actionContext.togglePreview();
        this.refreshXrPreviewScrubber();
      } else {
        if (this.previewOn) this.actionContext.togglePreview();
        this.actionContext.setMode('prepare');
        this.refreshXrPreviewScrubber();
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
      ...this.xrCardGeometry('actions'),
      position: new THREE.Vector3(0, PLATE_Y - 0.25, PLATE_Z + 0.15),
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
        // Sized to the desk it sits on: five verbs share 400 layout px, so the
        // padding is what gives and the label stays on one line.
        flexGrow: 1,
        flexShrink: 1,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 11,
        paddingBottom: 11,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
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
        width: 18,
        height: 18,
        flexShrink: 0,
      });
      btn.add(icon);
      btn.add(
        new UIText(a.label, {
          fontSize: 14,
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
      ...this.xrCardGeometry('progress'),
      position: new THREE.Vector3(0, PLATE_Y + 0.35, PLATE_Z + 0.3),
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
      ...this.xrCardGeometry('tools'),
      position: new THREE.Vector3(-0.85, PLATE_Y + 0.15, PLATE_Z + 0.1),
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
      const h = renderXrActionButton(a, runAction, xrBlocksUiAdapter, {
        size: 54,
        iconSize: 28,
        enabled: this.actionContext
          ? this.actionRegistry.availability(a, 'xr-toolbar', this.actionContext.ui.get()).state === 'enabled'
          : false,
        onHoverExit: () => this.refreshToolButtons(),
      });
      root.add(h.btn);
      this.toolButtons.push(h);
    }

    // Keep only the two high-frequency object actions beside the modal tools.
    // The rest of the toolbar catalogue remains reachable via the top menu,
    // avoiding a floor-length, overflowing rail in XR.
    root.add(divider());
    for (const a of toolbar) {
      if (a.tool || !['drop_to_bed', 'delete_models'].includes(a.id)) continue;
      const h = renderXrActionButton(a, runAction, xrBlocksUiAdapter, {
        size: 54,
        iconSize: 28,
        danger: a.id === 'delete_models',
        enabled: this.actionContext
          ? this.actionRegistry.availability(a, 'xr-toolbar', this.actionContext.ui.get()).state === 'enabled'
          : false,
      });
      root.add(h.btn);
      this.toolButtons.push(h);
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
      ...this.xrCardGeometry('sheet'),
      position: new THREE.Vector3(0, PLATE_Y + 0.25, PLATE_Z + 0.1),
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
      ...this.xrCardGeometry('inspector'),
      position: new THREE.Vector3(0.95, PLATE_Y + 0.15, PLATE_Z + 0.1),
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
    this.xrSelectionFilamentContainer = new UIPanel({ width: '100%', flexDirection: 'column', gap: 8 });
    root.add(this.xrSelectionFilamentContainer);
    this.refreshXrProfileValues();
    this.refreshXrSelectionFilaments();
  }

  /**
   * The spatial printer status card (P9.7).
   *
   * It renders exactly what the phone bar renders — the same summary, the same
   * guarded actions — because both come from `PrinterStatusSummary`. What
   * differs is only the gesture: a controller ray hovers a control and the
   * trigger is *held*, which is why the hold lives in a shared state machine
   * rather than in either shell.
   */
  private addPrinterStatusPanel() {
    const card = this.uiCore.createCard({
      name: 'PrinterStatusPanel',
      ...this.xrCardGeometry('status'),
      position: new THREE.Vector3(-0.95, PLATE_Y + 0.3, PLATE_Z + 0.1),
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
    this.printerStatusCard = card;

    const root = new UIPanel({
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      fillColor: '#0d141cF2',
      cornerRadius: 18,
      padding: 18,
      gap: 8,
      strokeWidth: 1,
      strokeColor: '#ffffff14',
    });
    card.add(root);

    this.printerStatusHeadline = new UIText('Printer', { fontSize: 22, fontWeight: 'bold', color: '#ffffff' });
    root.add(this.printerStatusHeadline);
    this.printerStatusDetail = new UIText('', { fontSize: 14, color: '#a0aab5' });
    root.add(this.printerStatusDetail);

    const track = new UIPanel({ width: '100%', height: 6, cornerRadius: 3, fillColor: '#ffffff1f' });
    this.printerStatusProgressFill = new UIPanel({
      width: '0%',
      height: '100%',
      cornerRadius: 3,
      fillColor: '#4fc3f7',
    });
    track.add(this.printerStatusProgressFill);
    root.add(track);

    this.printerStatusRecovery = new UIText('', { fontSize: 13, color: '#ffb74d' });
    root.add(this.printerStatusRecovery);

    this.printerStatusControls = new UIPanel({ width: '100%', flexDirection: 'row', gap: 8 });
    root.add(this.printerStatusControls);

    this.printerStatusHoldNote = new UIText('', { fontSize: 12, color: '#a0aab5' });
    root.add(this.printerStatusHoldNote);

    this.refreshPrinterStatusCard();
  }

  /** Repaint the spatial card from the shell's live status (P9.7). */
  public refreshPrinterStatusCard(): void {
    const card = this.printerStatusCard;
    if (!card) return;
    const live = this.onReadPrinterStatus?.();
    if (!live) {
      card.visible = false;
      return;
    }
    const { summary, actions } = live;
    // Same rule as the phone bar: present itself when something is happening,
    // and get out of the way of the plate when nothing is.
    if (summary.present) card.show();
    else card.hide();
    if (!summary.present) {
      this.printerHold.cancel();
      this.printerHoldTarget = null;
      return;
    }

    this.printerStatusHeadline?.setText(summary.headline);
    this.printerStatusDetail?.setText(summary.detail);
    this.printerStatusRecovery?.setText(
      summary.recovery
        ? summary.recovery.retryInS === undefined
          ? summary.recovery.message
          : `${summary.recovery.message} Next try in ${summary.recovery.retryInS} s.`
        : '',
    );
    if (this.printerStatusProgressFill) {
      this.printerStatusProgressFill.setProperties({ width: `${Math.round((summary.progress ?? 0) * 100)}%` });
    }
    if (!sameGuardedActions(this.printerStatusActions, actions)) {
      this.printerStatusActions = actions;
      this.rebuildPrinterStatusControls(actions);
    }
  }

  private rebuildPrinterStatusControls(actions: readonly GuardedPrinterAction[]): void {
    const host = this.printerStatusControls;
    if (!host) return;
    for (const child of [...host.children]) host.remove(child);
    this.printerStatusHoldFills.clear();
    for (const action of actions) {
      if (action.command === 'firmware-restart') continue;
      const btn = new UIPanel({
        flexGrow: 1,
        minHeight: 46,
        justifyContent: 'center',
        alignItems: 'center',
        cornerRadius: 8,
        fillColor: action.enabled ? '#ffffff14' : '#ffffff08',
        strokeWidth: 1,
        strokeColor: action.destructive ? '#ff525259' : '#ffffff1a',
        onHoverEnter: () => {
          // Hover arms the hold; the trigger press in onSelectStart begins it.
          this.printerHoldTarget = action.enabled ? action : null;
          btn.setFillColor(action.enabled ? '#ffffff26' : '#ffffff08');
        },
        onHoverExit: () => {
          if (this.printerHoldTarget?.command === action.command) {
            this.printerHoldTarget = null;
            this.abandonPrinterHold(action);
          }
          btn.setFillColor(action.enabled ? '#ffffff14' : '#ffffff08');
        },
      });
      const fill = new UIPanel({
        width: '0%',
        height: '100%',
        cornerRadius: 8,
        fillColor: action.destructive ? '#ff525233' : '#4fc3f733',
      });
      btn.add(fill);
      this.printerStatusHoldFills.set(action.command, fill);
      btn.add(
        new UIText(action.holdMs > 0 ? `Hold · ${action.label}` : action.label, {
          fontSize: 13,
          fontWeight: 'bold',
          color: action.enabled ? (action.destructive ? '#ff8a80' : '#ffffff') : '#8a94a0',
        }),
      );
      host.add(btn);
    }
  }

  /** Begin a hold when the trigger goes down on an armed control (P9.7). */
  private beginPrinterHold(controller: unknown): boolean {
    const target = this.printerHoldTarget;
    if (!target) return false;
    this.printerHoldController = controller;
    this.printerHold.press(target);
    this.printerStatusHoldNote?.setText(
      target.holdMs > 0 ? (target.confirmation ?? `Keep holding to ${target.label.toLowerCase()}.`) : '',
    );
    return true;
  }

  /** Release the hold; only a satisfied one runs anything (P9.7). */
  private endPrinterHold(): void {
    const target = this.printerHoldTarget;
    const released = this.printerHold.release();
    this.printerHoldController = null;
    this.paintPrinterHold(undefined, 0);
    if (released.command) {
      this.printerStatusHoldNote?.setText('');
      void this.onRunPrinterStatusCommand?.(released.command);
      return;
    }
    if (target && target.holdMs > 0) {
      this.printerStatusHoldNote?.setText(`${target.label} needs a longer hold — nothing was sent.`);
    }
  }

  private abandonPrinterHold(action: GuardedPrinterAction): void {
    if (this.printerHold.poll().phase !== 'holding') return;
    this.printerHold.cancel();
    this.printerHoldController = null;
    this.paintPrinterHold(undefined, 0);
    if (action.holdMs > 0) this.printerStatusHoldNote?.setText(`${action.label} cancelled — nothing was sent.`);
  }

  private paintPrinterHold(command: PrintJobCommand | undefined, progress: number): void {
    for (const [key, fill] of this.printerStatusHoldFills) {
      fill.setProperties({ width: key === command ? `${Math.round(progress * 100)}%` : '0%' });
    }
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
    // Before any of the early returns below: leaving the brim-ear tool has to
    // take its discs with it, and every path out of it lands here.
    this.refreshBrimEarPreview();
    const channel = PAINT_TOOL_CHANNELS[tool];
    if (channel) {
      this.paintChannel = channel;
      if (channel === 'color' && !this.paintFilamentId && this.paintMode === 'paint') {
        const first = this.getPaintPalette().entries.find((entry: PaintPalette['entries'][number]) => entry.filamentId);
        if (first?.filamentId) this.paintFilamentId = first.filamentId;
      }
      this.refreshPaintOverlays();
      this.onPaintStateChanged?.();
      this.setStatus(`Paint ${channelLabel(channel)}: drag across a model, Escape cancels.`);
      return;
    }
    if (tool === 'lay_on_face') {
      this.setStatus(
        t('workspace.orcaWorkspace.layFlatClickTheFacet', 'Lay flat: click the facet that should rest on the bed.'),
      );
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
    this.setStatus(
      t(
        'workspace.orcaWorkspace.autoOrientIsUnavailableUntil',
        'Auto-orient is unavailable until its analysis commits a canonical transform.',
      ),
    );
  }

  /** Stable instance IDs the transform actions operate on. */
  private selectedInstanceIdsForTransform(): InstanceId[] {
    const summary = this.canonicalProject.getSummary();
    return [...summary.selectedInstanceIds];
  }

  /** Add one shared instance of the selected model (upstream "Add instance"). */
  public addInstanceToSelection(): boolean {
    const duplicate = this.canonicalProject.duplicateSelectedInstance();
    if (!duplicate) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToAdd', 'Select a model to add another instance.'));
      return false;
    }
    this.recomputePreflight();
    this.setStatus(
      t('workspace.orcaWorkspace.addedAnInstanceArrangeOr', 'Added an instance — arrange or move it into place.'),
    );
    return true;
  }

  /** Fill the plate's free space with copies of the selected instance. */
  public fillPlateWithSelection(): number {
    const primary = this.canonicalProject.getSummary().selectedInstanceIds.at(-1);
    if (!primary) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToFill', 'Select a model to fill the plate with.'));
      return 0;
    }
    try {
      const result = this.canonicalProject.fillPlateWithInstances(primary, {
        bedSizeMm: [this.bedMm.x, this.bedMm.y],
        ...(this.wipeTowerExclusion() ? { exclusions: [this.wipeTowerExclusion() as ArrangeRegion] } : {}),
      });
      this.recomputePreflight();
      this.setStatus(
        result.created === 0
          ? 'The plate has no free space for another copy.'
          : result.withheld > 0
            ? `Added ${result.created} copies; ${result.withheld} more slots were left free by the copy limit.`
            : `Filled the plate with ${result.created} more copies.`,
      );
      return result.created;
    } catch (error) {
      this.setStatus(`Fill bed failed: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Mirror the selection across one printer axis (Edit → Mirror). */
  public mirrorSelected(axis: 'x' | 'y' | 'z'): boolean {
    const instances = this.selectedInstanceIdsForTransform();
    if (instances.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToMirror', 'Select a model to mirror.'));
      return false;
    }
    try {
      this.canonicalProject.mirrorInstances(instances, axis);
      this.recomputePreflight();
      this.setStatus(`Mirrored ${instances.length} model(s) on ${axis.toUpperCase()}.`);
      return true;
    } catch (error) {
      this.setStatus(`Mirror failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Clear rotation, scale, or both on the selection. */
  public resetSelectedTransform(target: 'rotation' | 'scale' | 'both'): boolean {
    const instances = this.selectedInstanceIdsForTransform();
    if (instances.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToReset', 'Select a model to reset.'));
      return false;
    }
    try {
      this.canonicalProject.resetInstanceTransforms(instances, target);
      this.recomputePreflight();
      this.setStatus(`Reset ${target === 'both' ? 'rotation and scale' : target} on ${instances.length} model(s).`);
      return true;
    } catch (error) {
      this.setStatus(`Reset failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Lay the facet under this ray on the bed. The facet normal is taken in
   * volume space and composed with the canonical volume transform, so the
   * canonical command never reads back a rendered matrix.
   */
  private layPickedFacetOnBed(raycaster: THREE.Raycaster): boolean {
    for (const target of this.paintTargets()) {
      const [hit] = raycaster.intersectObject(target.display, false);
      if (!hit?.face) continue;
      const instance = this.projectedModels(this.activePlateId).find(
        (entry) => entry.volumeId === target.volumeId,
      )?.instanceId;
      if (!instance) continue;
      const volume = this.canonicalProject.getVolumeTransform(target.volumeId);
      const normal = volume
        ? rotateVector([hit.face.normal.x, hit.face.normal.y, hit.face.normal.z], volume.rotation)
        : ([hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] as Vec3);
      try {
        this.canonicalProject.layInstanceOnFace(instance, normal);
        this.recomputePreflight();
        this.setStatus(t('workspace.orcaWorkspace.laidTheChosenFacetOn', 'Laid the chosen facet on the bed.'));
        return true;
      } catch (error) {
        this.setStatus(`Lay flat failed: ${(error as Error).message}`);
        return false;
      }
    }
    this.setStatus(t('workspace.orcaWorkspace.clickAModelFacetTo', 'Click a model facet to lay it flat.'));
    return false;
  }

  /**
   * Scale the selection to fill the printable volume, then place it on the bed.
   *
   * The build height comes from the live profile rather than a constant: a
   * factor computed against an assumed 100 mm ceiling would confidently scale a
   * model into the gantry of a shorter machine.
   */
  public scaleSelectionToFitPrintVolume(): boolean {
    let instances = this.selectedInstanceIdsForTransform();
    if (instances.length === 0) instances = this.projectedModels(this.activePlateId).map((entry) => entry.instanceId);
    if (instances.length === 0) {
      this.setStatus(
        t('workspace.orcaWorkspace.addAModelBeforeScaling', 'Add a model before scaling to the build volume.'),
      );
      return false;
    }
    const config = this.canonicalProject.getSlicingConfiguration().config as Record<string, unknown>;
    const raw = config['printable_height'];
    const height = Number.parseFloat(String(Array.isArray(raw) ? raw[0] : (raw ?? '')));
    if (!Number.isFinite(height) || height <= 0) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.thisPrinterProfileStatesNo',
          'This printer profile states no printable height, so a fitting scale cannot be computed.',
        ),
      );
      return false;
    }
    try {
      const changed = this.canonicalProject.scaleInstancesToFitPrintVolume(instances, {
        x: this.bedMm.x,
        y: this.bedMm.y,
        z: height,
      });
      this.recomputePreflight();
      this.setStatus(
        changed === 0
          ? 'The selection already fills the build volume.'
          : `Scaled ${changed} model(s) to the build volume.`,
      );
      return true;
    } catch (error) {
      this.setStatus(`Scale to build volume failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Include or exclude the selection from the print (P2.2, P11.2).
   *
   * A toggle rather than two actions, because upstream's menu entry is one
   * checkbox: the selection's current state decides the direction, and a mixed
   * selection is made printable rather than being half-flipped.
   */
  public toggleSelectedPrintable(): boolean {
    const instances = this.selectedInstanceIdsForTransform();
    if (instances.length === 0) {
      this.setStatus(
        t('workspace.orcaWorkspace.selectAModelBeforeChanging', 'Select a model before changing whether it prints.'),
      );
      return false;
    }
    try {
      const printable = !this.canonicalProject.areInstancesPrintable(instances);
      const changed = this.canonicalProject.setInstancePrintable(instances, printable);
      this.recomputePreflight();
      this.setStatus(
        changed === 0
          ? 'No change: the selection is already in that state.'
          : `${printable ? 'Included' : 'Excluded'} ${changed} model(s) ${printable ? 'in' : 'from'} the print.`,
      );
      return true;
    } catch (error) {
      this.setStatus(`Printable toggle failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Centre the selection (or the whole plate) on the printable area. */
  public centerSelectedOnPlate(): boolean {
    let instances = this.selectedInstanceIdsForTransform();
    if (instances.length === 0) instances = this.projectedModels(this.activePlateId).map((entry) => entry.instanceId);
    if (instances.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.addAModelBeforeCentring', 'Add a model before centring the plate.'));
      return false;
    }
    try {
      this.canonicalProject.centerInstancesOnPlate(instances, [this.bedMm.x, this.bedMm.y]);
      this.recomputePreflight();
      this.setStatus(`Centred ${instances.length} model(s) on the plate.`);
      return true;
    } catch (error) {
      this.setStatus(`Centre failed: ${(error as Error).message}`);
      return false;
    }
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
    for (const handle of this.toolButtons) {
      const { action } = handle;
      const enabled = state ? this.actionRegistry.availability(action, 'xr-toolbar', state).state === 'enabled' : false;
      const active = enabled && Boolean(action.tool) && this.tool === action.tool;
      handle.setEnabled(enabled);
      handle.setSelected(active);
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
    // by profile display names (notably ·, ×, —, –). Keep DOM status text intact
    // but feed the immersive card a supported, equally legible equivalent.
    const xrText = text
      .replaceAll('·', '-')
      .replaceAll('×', 'x')
      .replaceAll('…', '...')
      .replaceAll('—', '-')
      .replaceAll('–', '-');
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
    this.refreshXrSelectionFilaments();
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
      this.setStatus(t('workspace.orcaWorkspace.undidTheLastProjectEdit', 'Undid the last project edit.'));
    }
    return changed;
  }

  public redo(): boolean {
    const changed = this.canonicalProject.redo();
    if (changed) {
      this.syncTransformProxy();
      this.revalidatePublishedGcode();
      this.setStatus(t('workspace.orcaWorkspace.redidTheProjectEdit', 'Redid the project edit.'));
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
    this.setStatus(
      t(
        'workspace.orcaWorkspace.deleteAllIsUnavailableUntil',
        'Delete All is unavailable until it is one canonical transaction.',
      ),
    );
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
        this.setStatus(
          t(
            'workspace.orcaWorkspace.newProjectCancelledTheCurrent',
            'New Project cancelled; the current project was not changed.',
          ),
        );
        return false;
      }
    }
    this.canonicalProject.resetProject();
    this.clearToolpathPreview();
    this.publishedGcode = null;
    this.onDownloadReady?.(false);
    this.onSelectionChanged?.(false);
    this.onPlatesChanged?.();
    this.setStatus(t('workspace.orcaWorkspace.startedANewProject', 'Started a new project.'));
    return true;
  }

  /**
   * Clone the selected model onto the same plate, offset so the copy isn't
   * hidden under the original. Mirrors Orca's Edit → Clone selected.
   */
  public cloneSelectedModel() {
    if (!this.selectedModel) {
      this.setStatus(t('workspace.orcaWorkspace.selectAModelToClone', 'Select a model to clone first.'));
      return;
    }
    this.canonicalProject.duplicateSelectedInstance();
    this.setStatus(
      t('workspace.orcaWorkspace.modelClonedUseTheMove', 'Model cloned — use the Move tool to reposition the copy.'),
    );
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
    this.setStatus(
      t(
        'workspace.orcaWorkspace.cutIsUnavailableUntilTopology',
        'Cut is unavailable until topology and annotations commit atomically.',
      ),
    );
  }
  // --- Edit clipboard (canonical implementation pending) ----------------
  public get hasClipboard(): boolean {
    return false;
  }

  public copySelectedModel(): boolean {
    this.setStatus(
      t(
        'workspace.orcaWorkspace.copyIsUnavailableUntilThe',
        'Copy is unavailable until the canonical clipboard preserves full object semantics.',
      ),
    );
    return false;
  }

  public cutSelectedModel(): boolean {
    this.setStatus(
      t(
        'workspace.orcaWorkspace.cutIsUnavailableUntilThe',
        'Cut is unavailable until the canonical clipboard preserves full object semantics.',
      ),
    );
    return false;
  }

  public pasteClipboard() {
    this.setStatus(
      t(
        'workspace.orcaWorkspace.pasteIsUnavailableUntilThe',
        'Paste is unavailable until the canonical clipboard preserves full object semantics.',
      ),
    );
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

  // --- Selection outline (Orca View → Show Selected Outline) ----------
  private outlineOn = false;

  /**
   * A silhouette, drawn as an inverted hull: the same geometry, scaled a hair
   * along its own normals, with front faces culled so only the rim shows past
   * the model. This needs no post-processing pass, which matters because the
   * XR renderer owns its own pipeline and a second pass there is not ours to
   * add.
   *
   * It deliberately draws a *silhouette* rather than a bounding box: a box says
   * where a model roughly is, which the transform gizmo already says, while an
   * outline says which model is selected when two overlap.
   */
  private applyOutline(entry: ProjectedModelEntry, on: boolean): void {
    const existing = entry.viewer.getObjectByName('selectionOutline') as THREE.Mesh | undefined;
    if (!on) {
      if (!existing) return;
      entry.viewer.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
      return;
    }
    if (existing) return;
    const source = entry.viewer.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined;
    if (!source?.geometry) return;
    const outline = new THREE.Mesh(
      source.geometry,
      new THREE.MeshBasicMaterial({
        color: 0xff9800,
        side: THREE.BackSide,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    outline.name = 'selectionOutline';
    outline.raycast = () => {}; // never intercept the model grab raycast
    outline.renderOrder = -1;
    outline.position.copy(source.position);
    outline.quaternion.copy(source.quaternion);
    outline.scale.copy(source.scale).multiplyScalar(1.02);
    entry.viewer.add(outline);
  }

  /** Refresh outlines so exactly the selected instances carry one. */
  private refreshSelectionOutlines(): void {
    if (!this.outlineOn) return;
    const selected = new Set(this.canonicalProject.getSummary().selectedInstanceIds);
    for (const entry of this.models) this.applyOutline(entry, selected.has(entry.instanceId));
  }

  /** Toggle the selection outline (Orca View → Show Selected Outline). */
  public toggleSelectionOutline(): boolean {
    this.outlineOn = !this.outlineOn;
    if (this.outlineOn) this.refreshSelectionOutlines();
    else for (const entry of this.models) this.applyOutline(entry, false);
    this.setStatus(`Selection outline ${this.outlineOn ? 'on' : 'off'}.`);
    return this.outlineOn;
  }

  /** True while outlines are drawn; read by the DOM shell's checked state. */
  public isSelectionOutlineOn(): boolean {
    return this.outlineOn;
  }

  // --- Orientation navigator (Orca View → Show 3D Navigator) -----------
  private navigatorOn = false;
  private navigatorScene: THREE.Scene | null = null;
  private navigatorCamera: THREE.PerspectiveCamera | null = null;

  /**
   * A corner axis triad that mirrors the main camera's orientation, drawn in a
   * scissored viewport after the main pass. It reports orientation rather than
   * accepting clicks: a click target this small is a miss on a touch screen and
   * a fight with a controller ray, and the named camera actions already cover
   * "put me on the front".
   */
  private buildNavigator(): void {
    if (this.navigatorScene) return;
    const scene = new THREE.Scene();
    const axes = new THREE.AxesHelper(1);
    (axes.material as THREE.Material).depthTest = false;
    scene.add(axes);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.navigatorScene = scene;
    this.navigatorCamera = camera;
  }

  /** Draw the navigator, if it is on. Called after the main render pass. */
  private renderNavigator(): void {
    const renderer = xb.core.renderer;
    if (!this.navigatorOn || renderer.xr.isPresenting) return;
    this.buildNavigator();
    const scene = this.navigatorScene;
    const camera = this.navigatorCamera;
    if (!scene || !camera) return;
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const extent = Math.round(Math.min(120, Math.min(size.x, size.y) * 0.22));
    if (extent < 24) return;
    // The triad shows the *main* camera's orientation, so it is placed on a
    // fixed radius along that camera's own view direction.
    const direction = new THREE.Vector3();
    xb.core.camera.getWorldDirection(direction);
    camera.position.copy(direction.multiplyScalar(-3));
    camera.up.copy(xb.core.camera.up);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    const margin = 12;
    renderer.setScissorTest(true);
    renderer.setViewport(size.x - extent - margin, margin, extent, extent);
    renderer.setScissor(size.x - extent - margin, margin, extent, extent);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
  }

  /** Toggle the orientation navigator (Orca View → Show 3D Navigator). */
  public toggleNavigator(): boolean {
    this.navigatorOn = !this.navigatorOn;
    this.setStatus(`3D navigator ${this.navigatorOn ? 'on' : 'off'}.`);
    return this.navigatorOn;
  }

  public isNavigatorOn(): boolean {
    return this.navigatorOn;
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
      this.setStatus(t('workspace.orcaWorkspace.printableBoxOff', 'Printable box off.'));
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
    this.setStatus(t('workspace.orcaWorkspace.printableBoxOn', 'Printable box on.'));
    return true;
  }

  /**
   * Arrange the active plate's printable instances in one canonical command.
   * The wipe tower, when the project places one, is an exclusion zone so a
   * rearranged plate never collides with it.
   */
  public arrangePlate(): number {
    const summary = this.canonicalProject.getSummary();
    const plate = summary.plates.find((candidate) => candidate.active);
    if (!plate || plate.instanceCount === 0) {
      this.setStatus(t('workspace.orcaWorkspace.addAModelBeforeArranging', 'Add a model before arranging the plate.'));
      return 0;
    }
    try {
      const result = this.canonicalProject.arrangePlate(this.activePlateId, {
        bedSizeMm: [this.bedMm.x, this.bedMm.y],
        ...(this.wipeTowerExclusion() ? { exclusions: [this.wipeTowerExclusion() as ArrangeRegion] } : {}),
      });
      const moved = result.placements.length;
      const unplaced = result.unplacedInstanceIds.length;
      this.recomputePreflight();
      this.setStatus(
        unplaced > 0
          ? `Arranged ${moved} model(s); ${unplaced} did not fit on this plate.`
          : moved > 0
            ? `Arranged ${moved} model(s).`
            : 'The plate is already arranged.',
      );
      return moved;
    } catch (error) {
      this.setStatus(`Arrange failed: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Footprint the project's prime/purge tower reserves, when it has one. */
  private wipeTowerExclusion(): ArrangeRegion | undefined {
    const tower = this.activePlateWipeTower;
    if (!tower?.enabled) return undefined;
    return {
      minX: tower.xMm,
      minY: tower.yMm,
      maxX: tower.xMm + tower.widthMm,
      maxY: tower.yMm + tower.widthMm,
    };
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

  public exportAllObjectsAsStls() {
    const summary = this.canonicalProject.getSummary();
    const selected = summary.selectedInstanceIds.filter(
      (instanceId) => this.canonicalProject.getInstance(instanceId)?.plateId === summary.activePlateId,
    );
    const instanceIds = selected.length > 0 ? selected : undefined;
    try {
      const exported = this.canonicalProject.exportCanonicalAllStls(instanceIds);
      this.onDownloadFile?.(exported.suggestedFilename, ownedArrayBuffer(exported.bytes), exported.mediaType);
      this.setStatus(t('workspace.orcaWorkspace.exportedAllStls', 'Exported all models as separate STL files.'));
    } catch (error) {
      this.setStatus(t('workspace.orcaWorkspace.stlExportFailed', 'STL export failed.'));
      throw error;
    }
  }

  public convertInstanceToIndependentObject(instanceId?: InstanceId): void {
    const targetId = instanceId ?? this.canonicalProject.getSummary().selectedInstanceIds[0];
    if (!targetId) return;
    try {
      this.canonicalProject.convertInstanceToIndependentObject(targetId);
      this.setStatus(t('workspace.orcaWorkspace.convertedToIndependent', 'Set instance as independent object.'));
    } catch {
      this.setStatus(t('workspace.orcaWorkspace.setAsIndependentFailed', 'Set as independent object failed.'));
    }
  }

  public remapFilaments(sourceIds: readonly FilamentId[], destinationId: FilamentId): void {
    try {
      this.canonicalProject.remapFilaments(sourceIds, destinationId);
      this.setStatus(t('workspace.orcaWorkspace.filamentsRemapped', 'Filaments remapped.'));
    } catch (error) {
      this.setStatus(t('workspace.orcaWorkspace.filamentRemapFailed', 'Filament remap failed.'));
      throw error;
    }
  }

  public planRecreateModelColors(options?: RecreateModelColorsOptions): RecreateModelColorsPlan {
    return this.canonicalProject.planRecreateModelColors(options);
  }

  public async recreateModelColors(options?: RecreateModelColorsOptions): Promise<boolean> {
    try {
      let effectiveOptions = options;
      if (
        !effectiveOptions?.printerSlots &&
        !effectiveOptions?.candidatePhysicalFilaments &&
        this.onRequestPrinterFilamentQuery
      ) {
        try {
          const slots = await this.onRequestPrinterFilamentQuery();
          if (slots && slots.length > 0) {
            effectiveOptions = {
              ...effectiveOptions,
              printerSlots: slots.map((s) => ({
                toolId: s.slotIndex,
                color: s.colorHex,
                material: s.material,
                ...(s.subType ? { subType: s.subType } : {}),
                ...(s.vendor ? { vendor: s.vendor } : {}),
              })),
            };
          }
        } catch {
          // If printer query fails or printer is offline, plan against project physical filaments
        }
      }

      const plan = this.canonicalProject.planRecreateModelColors(effectiveOptions);
      if (plan.matches.length === 0) {
        this.setStatus(
          t('workspace.orcaWorkspace.noColorsToRecreate', 'No model colors to match; add a model to the plate first.'),
        );
        return false;
      }

      let overrides: ReadonlyMap<string, FilamentId> | undefined;
      if (typeof document !== 'undefined' && document.body) {
        const result = await askRecreateModelColors(plan, this.getVirtualFilamentLibrarySnapshot());
        if (!result.confirmed) {
          this.setStatus(t('workspace.orcaWorkspace.recreateColorsCancelled', 'Recreate model colors cancelled.'));
          return false;
        }
        overrides = result.overrides;
      }

      const applied = this.canonicalProject.recreateModelColors(plan, overrides);
      if (applied) {
        if (plan.printerSlotsToAdopt && plan.printerSlotsToAdopt.length > 0) {
          this.adoptPrinterFilamentPresets(
            plan.printerSlotsToAdopt.map((slot) => ({
              slotIndex: slot.toolId,
              colorHex: slot.color,
              material: slot.material,
              ...(slot.subType ? { subType: slot.subType } : {}),
              ...(slot.vendor ? { vendor: slot.vendor } : {}),
            })),
          );
          this.refreshPaintOverlays();
          this.recomputePreflight();
          this.onProfileChanged?.();
        }
        this.setStatus(
          t('workspace.orcaWorkspace.recreateColorsApplied', 'Recreated model colors with available filaments.'),
        );
      }
      return applied;
    } catch (error) {
      this.setStatus(t('workspace.orcaWorkspace.recreateColorsFailed', 'Recreating model colors failed.'));
      throw error;
    }
  }

  public build3mfBytes(): Uint8Array | null {
    this.setStatus(
      t(
        'workspace.orcaWorkspace.geometryOnly3MFExportIs',
        'Geometry-only 3MF export is unavailable; use canonical project save.',
      ),
    );
    return null;
  }

  public exportPlate3mf() {
    this.setStatus(
      t(
        'workspace.orcaWorkspace.geometryOnly3MFExportIs2',
        'Geometry-only 3MF export is unavailable; use canonical project save.',
      ),
    );
  }
  // --- Save / Open Project (Orca File → Save / Open Project) -----------
  /** Save the project as a downloadable OrcaXR .3mf (File → Save Project). */
  public async saveProject(): Promise<void> {
    if (this.canonicalProject.getSummary().objectCount === 0) {
      this.setStatus(t('workspace.orcaWorkspace.nothingToSaveAddA', 'Nothing to save — add a model first.'));
      return;
    }
    try {
      const saved = await this.canonicalProject.saveCanonical3mf();
      this.onDownloadFile?.(saved.suggestedFilename, ownedArrayBuffer(saved.bytes), saved.mediaType);
      const summary = this.canonicalProject.getSummary();
      recentProjectsStore.add({
        name: saved.suggestedFilename,
        storageOrigin: 'local-file',
        sizeBytes: saved.bytes.byteLength,
        plateCount: summary.plates.length,
        modelCount: summary.objectCount,
      });
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
      // The preview exists to put a decision in front of the operator. There
      // are exactly three: a blocked import they must read, notices that lose
      // or reinterpret what they authored, and replacing work that is already
      // open. Opening a project into an EMPTY workspace is none of those — it
      // is just opening the file they picked — so it goes straight through.
      // Anything the importer repaired on the way in is reported afterwards.
      const replacesOpenWork = this.modelCount > 0;
      const needsDecision = preview.blocked || preview.requiredAcknowledgementIds.length > 0 || replacesOpenWork;
      let committed = false;
      try {
        const decision = needsDecision
          ? await confirm(preview)
          : ({ confirmed: true, acknowledgedNoticeIds: [] } as ImportCommitConfirmation);
        if (preview.blocked) {
          const errors = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          throw new Error(
            `The project import preview is blocked by ${errors.length || 1} unresolved problem${errors.length === 1 ? '' : 's'}.`,
          );
        }
        if (!decision) {
          this.setStatus(t('workspace.orcaWorkspace.projectOpenCancelled', 'Project open cancelled.'));
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
      recentProjectsStore.add({
        name: filename,
        storageOrigin: 'imported-archive',
        sizeBytes: bytes.byteLength,
        plateCount: summary.plates.length,
        modelCount: summary.objectCount,
      });
      this.setStatus(
        `Opened ${summary.projectName} — ${summary.objectCount} model${summary.objectCount === 1 ? '' : 's'}, ${summary.plates.length} plate${summary.plates.length === 1 ? '' : 's'}.` +
          this.describeImportRepairs(preview),
      );
      return true;
    } finally {
      this.projectImportInProgress = false;
      this.applyCatalogDefaultProfile();
    }
  }

  /**
   * One clause describing what the importer fixed on the way in, or '' when it
   * fixed nothing. Repairs no longer interrupt the open (see `openProject`), so
   * this is how they stay visible: the operator is told what happened, and undo
   * steps back through the whole import as one command if they disagree.
   */
  private describeImportRepairs(preview: ProjectImportPreview): string {
    const repaired = preview.repairs.length;
    const dropped = preview.droppedFields.length;
    if (repaired === 0 && dropped === 0) return '';
    const parts: string[] = [];
    if (repaired > 0) parts.push(`repaired ${repaired} item${repaired === 1 ? '' : 's'}`);
    if (dropped > 0) parts.push(`dropped ${dropped} unsupported field${dropped === 1 ? '' : 's'}`);
    return ` Automatically ${parts.join(' and ')} — undo to step back.`;
  }

  public listRecentProjects() {
    return recentProjectsStore.list();
  }

  public openRecentProject(id?: string): void {
    const list = recentProjectsStore.list();
    if (list.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.noRecentProjectsFound', 'No recent projects found.'));
      return;
    }
    const entry = id ? list.find((item) => item.id === id) : list[0];
    if (!entry) {
      this.setStatus(t('workspace.orcaWorkspace.recentProjectNotFound', 'Recent project not found.'));
      return;
    }
    this.setStatus(
      t(
        'workspace.orcaWorkspace.selectedRecentProjectUseOpen',
        'Selected recent project: {name}. Use Open Project to choose its file.',
        { name: entry.name },
      ),
    );
  }

  /**
   * Decide where canonical work may run. The browser engine is verified by
   * `verify:artifacts`, so it is always allowed. An external server is allowed
   * once it proves which engine it runs — matching WASM artifacts, or the
   * pinned Snapmaker Orca commit with the pinned patch set for a CLI build.
   * Otherwise the operator is told precisely what failed instead of getting a
   * blanket refusal, and nothing leaves the browser.
   */
  private async resolveCanonicalSliceRoute(): Promise<SlicerClientProjectRoute | null> {
    if (!SlicerClient.useExternalSlicer()) return { kind: 'browser-wasm' };
    const attestation = await SlicerClient.attestExternalEngine();
    if (!attestation.attested) {
      this.setStatus(
        `slice failed: the external slicer is not an attested engine route. ${attestation.reason} Disable the external slicer to use the verified browser engine.`,
      );
      return null;
    }
    return SlicerClient.captureProjectRoute();
  }

  public async sliceNow() {
    if (this.activeCanonicalSlicer) return;
    const activePlate = this.canonicalProject.getSummary().plates.find((plate) => plate.id === this.activePlateId);
    if (!activePlate || activePlate.instanceCount === 0) {
      this.setStatus(t('workspace.orcaWorkspace.noModelsToSlice', 'No models to slice.'));
      return;
    }
    const route = await this.resolveCanonicalSliceRoute();
    if (!route) return;
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
      // Prefer the engine's own total: counting layer-change markers misses
      // the layers it counts differently, and two disagreeing layer counts in
      // one UI is worse than either.
      const layers =
        summarizeGcodeArtifact(gcode).layerCount ?? (gcode.match(/; CHANGE_LAYER|;LAYER_CHANGE/g) ?? []).length;
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

  /**
   * Slice every printable plate in one canonical job and retain a per-plate
   * result. Each plate keeps its own G-code, output hash, and warnings; the
   * active plate's result also feeds the existing preview/download path, and
   * any project drift discards the whole set rather than publishing a mix.
   */
  public async sliceAllPlates(): Promise<number> {
    if (this.activeCanonicalSlicer) return 0;
    const summary = this.canonicalProject.getSummary();
    const printable = summary.plates.filter((plate) => plate.printable && plate.instanceCount > 0);
    if (printable.length === 0) {
      this.setStatus(t('workspace.orcaWorkspace.noPrintablePlateHasModels', 'No printable plate has models to slice.'));
      return 0;
    }
    const route = await this.resolveCanonicalSliceRoute();
    if (!route) return 0;
    const startedAt = performance.now();
    const slicer = new CanonicalWorkspaceSlicer({
      workspace: this.canonicalProject,
      client: this.slicer,
      route,
      maxThreads: 4,
      preflight: this.createLiveProfilePreflight(),
    });
    this.activeCanonicalSlicer = slicer;
    const unsubscribe = slicer.subscribe((status) => this.renderCanonicalSliceStatus(status));
    try {
      this.markPublishedGcodeStale();
      this.onSliceStateChanged?.(true);
      this.sliceModalCard?.show();
      const result = await slicer.startAllPlates().completion;
      if (result.plates.length === 0) throw new Error('The canonical slicer returned no plate output.');
      const guard = {
        sourceRevision: result.sourceRevision,
        sourceHash: result.sourceHash,
        sourceAssetHash: result.sourceAssetHash,
      };
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const plates = new Map<PlateId, { gcode: string; byteLength: number; warnings: readonly string[] }>();
      for (const plate of result.plates) {
        plates.set(plate.plateId, {
          gcode: decoder.decode(plate.gcode),
          byteLength: plate.gcode.byteLength,
          warnings: plate.warnings,
        });
      }
      this.publishedPlateGcode = { plates, guard };
      const active = plates.get(this.activePlateId) ?? [...plates.values()][0];
      this.publishedGcode = active ? { gcode: active.gcode, guard } : null;
      if (!this.revalidatePublishedGcode()) {
        this.publishedPlateGcode = null;
        throw new Error('The project changed while slicing; the stale results were discarded. Slice again.');
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      const totalBytes = [...plates.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
      const warningCount = result.warnings.length;
      this.setStatus(
        `SLICED ${plates.size} plate(s) in ${elapsedMs} ms\n${(totalBytes / 1024).toFixed(0)} KB total` +
          (warningCount > 0 ? `, ${warningCount} warning(s)` : ''),
      );
      if (active) this.showToolpathPreview(active.gcode);
      return plates.size;
    } catch (error) {
      if (error instanceof SlicePreflightError) this.publishPreflightResult(error.result);
      this.setStatus(`slice failed: ${(error as Error).message}`);
      this.revalidatePublishedGcode();
      return 0;
    } finally {
      unsubscribe();
      slicer.dispose();
      if (this.activeCanonicalSlicer === slicer) this.activeCanonicalSlicer = null;
      this.onSliceStateChanged?.(false);
      this.sliceModalCard?.hide();
    }
  }

  /** Per-plate results retained by the last all-plate slice, if still valid. */
  public getPlateSliceResults(): readonly {
    plateId: PlateId;
    name: string;
    byteLength: number;
    warnings: readonly string[];
  }[] {
    const published = this.publishedPlateGcode;
    if (!published) return [];
    const names = new Map(this.canonicalProject.getSummary().plates.map((plate) => [plate.id, plate.name]));
    return [...published.plates.entries()].map(([plateId, entry]) => ({
      plateId,
      name: names.get(plateId) ?? 'Plate',
      byteLength: entry.byteLength,
      warnings: entry.warnings,
    }));
  }

  /** Download each retained plate result as its own named artifact. */
  public downloadAllPlateGcode(): number {
    const published = this.publishedPlateGcode;
    if (!published || published.plates.size === 0) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.sliceAllPlatesBeforeDownloading',
          'Slice all plates before downloading their G-code.',
        ),
      );
      return 0;
    }
    if (!this.revalidatePublishedGcode()) {
      this.setStatus(
        t(
          'workspace.orcaWorkspace.theProjectChangedSinceThe',
          'The project changed since the last slice; slice again before downloading.',
        ),
      );
      return 0;
    }
    const names = new Map(this.canonicalProject.getSummary().plates.map((plate) => [plate.id, plate.name]));
    let downloaded = 0;
    for (const [plateId, entry] of published.plates) {
      const label = (names.get(plateId) ?? 'plate').replace(/[^A-Za-z0-9._-]+/g, '_');
      this.onDownloadFile?.(`${label}.gcode`, entry.gcode, 'text/plain');
      downloaded += 1;
    }
    this.setStatus(`Downloaded ${downloaded} plate G-code file(s).`);
    return downloaded;
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

  /**
   * Auto-position the wipe tower on the active plate using Chebyshev clearance scoring.
   * Commits the updated position through canonical plate commands.
   */
  public autoPlaceWipeTower(plateId: PlateId = this.activePlateId): WipeTowerPick | undefined {
    try {
      const pick = this.canonicalProject.autoPlaceWipeTower(plateId, {
        bedSizeMm: [this.bedMm.x, this.bedMm.y],
      });
      this.rebuildWipeTowerGhost();
      this.recomputePreflight();
      this.setStatus(t('workspace.orcaWorkspace.autoPlacedWipeTower', 'Auto-placed wipe tower.'));
      return pick;
    } catch {
      this.setStatus(t('workspace.orcaWorkspace.autoPlaceWipeTowerFailed', 'Auto-place wipe tower failed.'));
      return undefined;
    }
  }

  /** Toggle wipe-tower auto-positioning (Section 1 pre-flight). */
  public setWipeTowerAuto(on: boolean): void {
    this.wipeTowerAuto = on;
    if (on) {
      this.autoPlaceWipeTower(this.activePlateId);
    }
    this.setStatus(
      on
        ? t('workspace.orcaWorkspace.wipeTowerAutoEnabled', 'Auto-position wipe tower enabled.')
        : t('workspace.orcaWorkspace.wipeTowerAutoDisabled', 'Auto-position wipe tower disabled.'),
    );
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
    this.setStatus(
      t(
        'workspace.orcaWorkspace.repairIsUnavailableUntilTopology',
        'Repair is unavailable until topology and annotations commit atomically.',
      ),
    );
  }

  public async booleanModels(op: 'UNION' | 'A_NOT_B' | 'INTERSECTION'): Promise<void> {
    this.setStatus(`Boolean ${op} is unavailable until topology and annotations commit atomically.`);
  }

  /**
   * Open the Smart Paint flow. The assistant is not called here: consent, the
   * prompt, and an explicit apply all happen in the panel, so activating the
   * tool never sends anything.
   */
  async smartPaint(): Promise<void> {
    this.smartPaintError = undefined;
    this.setStatus(
      this.paintableSelectedVolumes().length === 1
        ? 'Smart Paint: allow what may be sent, describe the regions, then ask the assistant.'
        : 'Select one model part to use Smart Paint.',
    );
    this.onSmartPaintStateChanged?.();
  }

  /** The same flow with a reference image; the image needs its own consent. */
  async smartPaintImage(): Promise<void> {
    this.smartPaintError = undefined;
    this.setStatus(
      this.smartPaintImageBase64 === undefined
        ? 'Attach a reference image, allow sending it, then ask the assistant.'
        : 'Smart Paint: allow sending the attached image, then ask the assistant.',
    );
    this.onSmartPaintStateChanged?.();
  }
}

/**
 * Present an imported project's embedded configuration as the preflight
 * target. Nothing is invented: the project's own effective config supplies the
 * build volume and nozzle map, and each physical filament contributes only the
 * fields it actually declares. Canonical values are projected to the same
 * engine wire strings a catalog profile carries.
 */
function authoredProjectProfile(config: Record<string, string>): SlicerProfile {
  return {
    id: 'authored-project',
    displayName: 'Imported project',
    machineName: config['printer_settings_id'] ?? 'Imported printer',
    processName: config['print_settings_id'] ?? 'Imported process',
    filamentName: config['filament_settings_id'] ?? 'Imported filament',
    config,
  };
}

function authoredFilamentProfiles(
  projectConfig: Record<string, string>,
  physical: readonly { toolId: number; config: Record<string, string>; material: string }[],
  toolCount: number,
): readonly (SlicerProfile | undefined)[] {
  const byTool = new Map(physical.map((filament) => [filament.toolId, filament]));
  return Object.freeze(
    Array.from({ length: toolCount }, (_unused, toolId) => {
      const filament = byTool.get(toolId);
      if (!filament) return undefined;
      // Project-level filament vectors already carry per-tool values; the
      // per-filament config overrides them where the project set one.
      const config: Record<string, string> = {
        ...projectFilamentConfig(projectConfig, toolId),
        ...filament.config,
      };
      if (filament.material && config['filament_type'] === undefined) config['filament_type'] = filament.material;
      return {
        id: `authored-project-filament-${toolId}`,
        displayName: `Imported filament ${toolId + 1}`,
        machineName: projectConfig['printer_settings_id'] ?? 'Imported printer',
        processName: projectConfig['print_settings_id'] ?? 'Imported process',
        filamentName: `Imported filament ${toolId + 1}`,
        config,
      } satisfies SlicerProfile;
    }),
  );
}

/** Per-tool slice of the project's filament vectors, when it declares them. */
function projectFilamentConfig(config: Record<string, string>, toolId: number): Record<string, string> {
  const perTool: Record<string, string> = {};
  for (const key of ['filament_type', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high']) {
    const value = config[key];
    if (value === undefined) continue;
    const parts = value.includes(';') ? value.split(';') : value.includes(',') ? value.split(',') : [value];
    const entry = parts.length === 1 ? parts[0] : parts[toolId];
    if (entry !== undefined && entry !== '') perTool[key] = entry.trim();
  }
  return perTool;
}

/** Canonical config values projected to their engine wire strings. */
function engineWireConfig(config: Readonly<Record<string, unknown>>): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    wire[key] = Array.isArray(value)
      ? serializePrintConfigArray(key, value as readonly unknown[])
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  }
  return wire;
}

/** The lowest local Z of a part's own geometry — where a brim ear belongs. */
function partBaseZ(display: THREE.Object3D): number | undefined {
  const geometry = (display as THREE.Mesh).geometry;
  if (!geometry) return undefined;
  geometry.computeBoundingBox();
  return geometry.boundingBox?.min.z;
}

/**
 * Whether two guarded action lists would render the same controls. Rebuilding
 * the row on every status tick would re-create the panels a ray is currently
 * hovering, which drops the hold mid-gesture.
 */
function sameGuardedActions(left: readonly GuardedPrinterAction[], right: readonly GuardedPrinterAction[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((action, index) => {
    const other = right[index];
    return (
      action.command === other.command &&
      action.enabled === other.enabled &&
      action.label === other.label &&
      action.holdMs === other.holdMs
    );
  });
}
