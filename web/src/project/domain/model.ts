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

/** Plain printer-space transform. Translation is always millimetres. */
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

export interface FacetAnnotations {
  /** Must equal the owning mesh reference's topologyRevision. */
  topologyRevision: number;
  color: TriangleAssignments<FilamentId>[];
  support: TriangleAssignments<'enforce' | 'block'>[];
  seam: TriangleAssignments<'prefer' | 'avoid'>[];
  fuzzySkin: TriangleAssignments<boolean>[];
  brim: TriangleAssignments<boolean>[];
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

export interface ProjectObject {
  id: ObjectId;
  name: string;
  config: ConfigMap;
  /** Missing means no project-level material default has been chosen. */
  filamentId?: FilamentId;
  volumes: ProjectVolume[];
  instances: ProjectInstance[];
  layerRanges: LayerRange[];
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
  weight: number;
}

export type MixedDistribution =
  | { mode: 'ratio' }
  | { mode: 'cycle'; cycleLengthMm: number }
  | { mode: 'match'; targetColor: string }
  | {
      mode: 'gradient';
      startZMm: number;
      endZMm: number;
      startWeights: number[];
      endWeights: number[];
    };

export interface MixedFilament {
  id: MixedFilamentId;
  name: string;
  displayColor: string;
  components: MixedComponent[];
  distribution: MixedDistribution;
  config: ConfigMap;
  enabled: boolean;
  extensionData?: Record<string, JsonValue>;
}

export interface CustomGcode {
  id: CustomGcodeId;
  scope: 'project' | 'plate';
  plateId?: PlateId;
  trigger: 'before-plate' | 'after-plate' | 'before-layer' | 'after-layer' | 'tool-change';
  code: string;
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
