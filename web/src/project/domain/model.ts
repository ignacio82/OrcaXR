import type {
  AssetId,
  CustomGcodeId,
  ExtensionBlobId,
  FilamentId,
  IdSource,
  InstanceId,
  LayerRangeId,
  MixedFilamentId,
  ObjectId,
  PhysicalFilamentId,
  PlateId,
  ProjectId,
  ThumbnailId,
  VolumeId,
} from './ids';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ConfigMap = Record<string, JsonValue>;

export type DirtyCategory = 'projectData' | 'presets' | 'printerDevice';

export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];

/**
 * Plain plate-local printer-space transform in millimetres: X/Y use the
 * active bed's corner origin and Z uses the bed plane. BBS core build items
 * may add a virtual multi-plate grid origin only at the serialization edge.
 */
export interface Transform {
  translationMm: Vec3;
  rotation: Quaternion;
  scale: Vec3;
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  translationMm: Object.freeze([0, 0, 0]) as Vec3,
  rotation: Object.freeze([0, 0, 0, 1]) as Quaternion,
  scale: Object.freeze([1, 1, 1]) as Vec3,
});

export type MeshComponentType = 'float32' | 'uint16' | 'uint32';

export interface BufferViewDescriptor {
  byteOffset: number;
  byteLength: number;
  componentType: MeshComponentType;
  componentCount: 1 | 2 | 3 | 4;
  count: number;
  byteStride?: number;
}

export interface IndexedMeshDescriptor {
  positions: BufferViewDescriptor;
  indices?: BufferViewDescriptor;
  triangleCount: number;
}

export type SourceAssetKind = 'mesh' | 'archive' | 'thumbnail' | 'extension';

export interface SourceAssetDescriptor {
  id: AssetId;
  kind: SourceAssetKind;
  digest: string;
  byteLength: number;
  mediaType: string;
  sourceFilename?: string;
  provenance?: {
    source: 'import' | 'generated' | 'recovered';
    uri?: string;
    importedAt?: string;
  };
  mesh?: IndexedMeshDescriptor;
}

export type VolumeRole = 'model' | 'parameter-modifier' | 'negative-volume' | 'support-enforcer' | 'support-blocker';

export interface TriangleAssignments<T extends JsonValue> {
  triangles: number[];
  value: T;
}

/** Stable version of Orca's per-source-facet TriangleSelector tree. */
export const ORCA_REFINEMENT_ENCODING_VERSION = 1;
export const ORCA_REFINEMENT_MAX_DEPTH = 64;
export const ORCA_REFINEMENT_MAX_NODES = 1_000_000;

export type FacetRefinementState<T extends JsonValue = JsonValue> =
  { readonly kind: 'unpainted' } | { readonly kind: 'assigned'; readonly value: T };

export type FacetRefinementNode<T extends JsonValue = JsonValue> =
  | { readonly kind: 'leaf'; readonly state: FacetRefinementState<T> }
  | {
      readonly kind: 'split';
      readonly splitSides: 1 | 2 | 3;
      readonly specialSide: 0 | 1 | 2;
      /** Pinned child order; the length is exactly `splitSides + 1`. */
      readonly children: readonly FacetRefinementNode<T>[];
    };

/** Root order is source-triangle order; child paths are stable refined-facet IDs. */
export interface FacetRefinementEncoding<T extends JsonValue = JsonValue> {
  readonly version: typeof ORCA_REFINEMENT_ENCODING_VERSION;
  readonly roots: readonly FacetRefinementNode<T>[];
}

export interface FacetAnnotationRefinements {
  color?: FacetRefinementEncoding<FilamentId>;
  support?: FacetRefinementEncoding<'enforce' | 'block'>;
  seam?: FacetRefinementEncoding<'prefer' | 'avoid'>;
  fuzzySkin?: FacetRefinementEncoding<true>;
  brim?: FacetRefinementEncoding<boolean>;
}

export interface FacetAnnotations {
  /** Must equal the owning mesh reference's topologyRevision. */
  topologyRevision: number;
  color: TriangleAssignments<FilamentId>[];
  support: TriangleAssignments<'enforce' | 'block'>[];
  seam: TriangleAssignments<'prefer' | 'avoid'>[];
  fuzzySkin: TriangleAssignments<true>[];
  brim: TriangleAssignments<boolean>[];
  /** Present only for channels with at least one subdivided source facet. */
  refinement?: FacetAnnotationRefinements;
}

export interface MeshSourceRef {
  assetId: AssetId;
  topologyRevision: number;
  triangleCount: number;
}

export interface ProjectVolume {
  id: VolumeId;
  name: string;
  role: VolumeRole;
  source: MeshSourceRef;
  transform: Transform;
  config: ConfigMap;
  /** Missing means inherit from the object. */
  filamentId?: FilamentId;
  annotations: FacetAnnotations;
  extensionData?: Record<string, JsonValue>;
}

export interface ProjectInstance {
  id: InstanceId;
  name?: string;
  transform: Transform;
  printable: boolean;
  extensionData?: Record<string, JsonValue>;
}

export interface LayerRange {
  id: LayerRangeId;
  minZMm: number;
  maxZMm: number;
  config: ConfigMap;
  filamentId?: FilamentId;
}

/**
 * One pinned `BrimPoint`: a placed brim "mouse ear" in object-local
 * millimetres with its own front radius.
 */
export interface BrimEarPoint {
  positionMm: Vec3;
  headFrontRadiusMm: number;
}

export interface ProjectObject {
  id: ObjectId;
  name: string;
  config: ConfigMap;
  /** Missing means no project-level material default has been chosen. */
  filamentId?: FilamentId;
  volumes: ProjectVolume[];
  instances: ProjectInstance[];
  layerRanges: LayerRange[];
  /** Pinned `ModelObject::brim_points`; absent means none were placed. */
  brimEars?: BrimEarPoint[];
  extensionData?: Record<string, JsonValue>;
}

export interface WipeTowerState {
  enabled: boolean;
  positionMm: readonly [number, number];
  rotationDeg: number;
  filamentId?: FilamentId;
}

export interface ProjectPlate {
  id: PlateId;
  name: string;
  order: number;
  printable: boolean;
  config: ConfigMap;
  objects: ProjectObject[];
  wipeTower?: WipeTowerState;
  extensionData?: Record<string, JsonValue>;
}

export interface PhysicalFilament {
  id: PhysicalFilamentId;
  name: string;
  toolId: number;
  presetId?: string;
  presetHash?: string;
  material: string;
  vendor?: string;
  color: string;
  nozzleDiameterMm?: number;
  config: ConfigMap;
  enabled: boolean;
  extensionData?: Record<string, JsonValue>;
}

export interface MixedComponent {
  /** Snapmaker v2.3.4 recipes resolve only to physical heads, never another virtual row. */
  filamentId: PhysicalFilamentId;
  /** Zero is valid at the Ratio endpoints; at least one recipe component must remain positive. */
  weight: number;
}

export type MixedDistribution =
  | { mode: 'ratio' }
  | { mode: 'cycle'; cycleLengthMm?: number }
  | { mode: 'match'; targetColor: string }
  | {
      mode: 'gradient';
      /** Legacy OrcaXR range metadata; the pinned row applies its gradient over the effective Z domain. */
      startZMm?: number;
      endZMm?: number;
      startWeights: number[];
      endWeights: number[];
    };

/**
 * Stable-ID form of every field persisted by Snapmaker Orca v2.3.4's
 * `MixedFilamentManager`. Physical row numbers are deliberately absent: the
 * BBS/slicer adapter derives them from the current physical-tool order.
 */
export interface FullSpectrumRecipeState {
  schemaVersion: 1;
  /** Unsigned 64-bit decimal text; JSON numbers cannot represent every upstream stable ID. */
  upstreamStableId: string;
  /** -1 is the upstream legacy/unknown value; authored rows use 0..3. */
  uiMode: -1 | 0 | 1 | 2 | 3;
  componentAId: PhysicalFilamentId;
  componentBId: PhysicalFilamentId;
  ratioA: number;
  ratioB: number;
  mixBPercent: number;
  /** Exact comma-separated perimeter groups represented with stable physical IDs. */
  manualPatternGroups: PhysicalFilamentId[][];
  gradientComponentIds: PhysicalFilamentId[];
  gradientComponentWeights: number[];
  /** Pointillisme is compiled out in the pinned engine and must remain false. */
  pointillismAllFilaments: false;
  distributionMode: 0 | 2;
  localZMaxSublayers: number;
  gradientEnabled: boolean;
  gradientStart: number;
  gradientEnd: number;
  componentASurfaceOffsetMm: number;
  componentBSurfaceOffsetMm: number;
  deleted: boolean;
  custom: boolean;
  originAuto: boolean;
}

export interface MixedFilament {
  id: MixedFilamentId;
  name: string;
  displayColor: string;
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum?: FullSpectrumRecipeState;
  config: ConfigMap;
  enabled: boolean;
  extensionData?: Record<string, JsonValue>;
}

/**
 * Event kinds the pinned engine understands at a layer boundary
 * (`CustomGCode::Type` in `src/libslic3r/CustomGCode.hpp`). `pause` and
 * `template` take their body from the printer profile; `custom` carries its
 * own; `color-change` and `tool-change` address one tool.
 */
export type LayerEventType = 'color-change' | 'pause' | 'tool-change' | 'template' | 'custom';

/**
 * One authored event bound to an exact print height. The engine applies it to
 * the first layer whose top Z is at or above `topZMm`, so the stored value is
 * the operator's intent rather than a resolved layer index that a layer-height
 * change would silently invalidate.
 */
export interface CustomGcodeLayerEvent {
  type: LayerEventType;
  topZMm: number;
  /** 1-based engine tool for colour/tool changes; absent otherwise. */
  toolIndex?: number;
  /** Stable filament the tool index was derived from, when one applies. */
  filamentId?: FilamentId;
  /** Badge colour the authoring surface shows. */
  color?: string;
  /** Operator-visible message a pause shows on the printer. */
  message?: string;
}

export interface CustomGcode {
  id: CustomGcodeId;
  scope: 'project' | 'plate';
  plateId?: PlateId;
  trigger: 'before-plate' | 'after-plate' | 'before-layer' | 'after-layer' | 'tool-change';
  code: string;
  /** Present when this entry is an authored layer event rather than a hook. */
  layerEvent?: CustomGcodeLayerEvent;
}

export interface ProjectThumbnail {
  id: ThumbnailId;
  assetId: AssetId;
  plateId?: PlateId;
  width: number;
  height: number;
}

export interface ExtensionBlob {
  id: ExtensionBlobId;
  namespace: string;
  path: string;
  assetId: AssetId;
  relationships: string[];
}

export interface ProjectState {
  schemaVersion: 1;
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  printer: {
    profileId?: string;
    profileHash?: string;
    toolCount: number;
  };
  /**
   * Inherited profile/project settings before explicit overrides. Legacy and
   * foreign states omit both settings fields and use `config` as this base.
   */
  settingsBaseConfig?: ConfigMap;
  /** Explicit user-authored project setting overrides. Missing means empty. */
  settingsOverrides?: ConfigMap;
  /** Effective engine configuration (`settingsBaseConfig` plus overrides). */
  config: ConfigMap;
  activePlateId: PlateId;
  plates: ProjectPlate[];
  filaments: {
    physical: PhysicalFilament[];
    mixed: MixedFilament[];
  };
  sourceAssets: SourceAssetDescriptor[];
  customGcode: CustomGcode[];
  thumbnails: ProjectThumbnail[];
  extensionBlobs: ExtensionBlob[];
  extensionData?: Record<string, JsonValue>;
}

export interface EmptyProjectOptions {
  idSource: IdSource;
  now?: string;
  name?: string;
  firstPlateName?: string;
  toolCount?: number;
}

export function createEmptyProject(options: EmptyProjectOptions): ProjectState {
  const now = options.now ?? new Date().toISOString();
  const plateId = options.idSource.next('plate');
  return {
    schemaVersion: 1,
    id: options.idSource.next('project'),
    name: options.name ?? 'Untitled project',
    createdAt: now,
    updatedAt: now,
    printer: { toolCount: options.toolCount ?? 1 },
    config: {},
    activePlateId: plateId,
    plates: [
      {
        id: plateId,
        name: options.firstPlateName ?? 'Plate 1',
        order: 0,
        printable: true,
        config: {},
        objects: [],
      },
    ],
    filaments: { physical: [], mixed: [] },
    sourceAssets: [],
    customGcode: [],
    thumbnails: [],
    extensionBlobs: [],
  };
}

export function emptyFacetAnnotations(topologyRevision = 0): FacetAnnotations {
  return {
    topologyRevision,
    color: [],
    support: [],
    seam: [],
    fuzzySkin: [],
    brim: [],
  };
}

export function identityTransform(): Transform {
  return {
    translationMm: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}
