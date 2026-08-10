import * as THREE from 'three';

import { BbsProjectImportWorkerClient } from '../import/BbsProjectImportWorkerClient';
import { InMemoryAssetRepository, type AssetPayload } from '../project/assets';
import {
  AddObjectWithAssetCommand,
  AddPlateCommand,
  DeletePlateCommand,
  DuplicatePlateCommand,
  RenamePlateCommand,
  ReorderPlatesCommand,
  ReplaceProjectCommand,
  SetActivePlateCommand,
  SetInstanceTransformCommand,
  SetPlatePrintableCommand,
} from '../project/commands';
import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from '../project/domain/canonical';
import { facetAnnotationsHaveAssignments } from '../project/domain/facetRefinement';
import type { EmbossTextConfiguration, EmbossedMesh, GlyphOutlineSource } from '../project/objects/emboss';
import type { EmbossSvgPart } from '../project/domain/model';
import {
  AddSvgPartCommand,
  EditSvgPartCommand,
  prepareSvgPart,
  svgVolumeIdentity,
  type PreparedSvgPart,
} from '../project/objects/svgCommands';
import {
  AddEmbossTextCommand,
  EditEmbossTextCommand,
  embossVolumeIdentity,
  prepareEmbossedVolume,
} from '../project/objects/embossCommands';
import type {
  AssetId,
  CustomGcodeId,
  FilamentId,
  IdSource,
  InstanceId,
  LayerRangeId,
  MixedFilamentId,
  ObjectId,
  PhysicalFilamentId,
  PlateId,
  ProjectId,
  VolumeId,
} from '../project/domain/ids';
import { entityId } from '../project/domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
  type ConfigMap,
  type CustomGcodeLayerEvent,
  type LayerEventType,
  type MixedFilament,
  type PhysicalFilament,
  type ProjectObject,
  type ProjectState,
  type Transform,
  type VolumeRole,
} from '../project/domain/model';
import {
  findInstance,
  findLayerRange,
  findObject,
  findPlate,
  findVolume,
  resolveFilament,
} from '../project/domain/selectors';
import { assertValidProjectState } from '../project/domain/validation';
import {
  AddLayerEventCommand,
  DeleteLayerEventCommand,
  EditLayerEventCommand,
  plateLayerEvents,
  type LayerEventPatch,
} from '../project/layerEventCommands';
import {
  SetFilamentAssignmentsCommand,
  SyncPhysicalFilamentsFromPrinterCommand,
  type PrinterFilamentSyncSummary,
  type FilamentAssignmentChange,
  type PrinterFilamentSlotFacts,
} from '../project/filaments/commands';
import {
  allocateFullSpectrumAutoPairIdentity,
  ReconcileFullSpectrumAutoPairsCommand,
  reconcileFullSpectrumAutoPairFilaments,
  StaleFullSpectrumAutoPairReconciliationError,
  type FullSpectrumAutoPairGenerationPreferences,
  type FullSpectrumAutoPairReconciliation,
  type FullSpectrumAutoPairReconciliationGuard,
} from '../project/filaments/autoPairReconciliation';
import {
  createFullSpectrumMixedFilament,
  fullSpectrumStableNumericId,
  replaceFullSpectrumMixedFilament,
  type FullSpectrumRecipeDraft,
} from '../project/filaments/fullSpectrumRecipe';
import {
  AddMixedFilamentCommand,
  EditMixedFilamentCommand,
  findFilamentDependentPaths,
  RemoveMixedFilamentCommand,
  SetMixedFilamentEnabledCommand,
  TombstoneMixedFilamentCommand,
} from '../project/filaments/mixedCommands';
import type { CommandHistorySnapshot } from '../project/history/commandBus';
import { PreparedProjectImport, ProjectImportCoordinator } from '../project/import/ProjectImportCoordinator';
import { ModelImportParser, type ModelImportPlacement } from '../project/import/ModelImportParser';
import type { BrimEarPoint, JsonValue, TriangleAssignments, Vec3 } from '../project/domain/model';
import type { FacetRefinementEncoding } from '../project/domain/model';
import type { FacetAnnotationChannel, FacetSelectionMesh } from '../project/annotations';
import { GeometryMergeParser } from '../project/import/GeometryMergeParser';
import { AiPaintSession, type AiPaintPort } from '../project/painting/AiPaintSession';
import { PaintStrokeService } from '../project/painting/PaintStrokeService';
import { projectPaintPalette, type PaintPalette, type PaintPaletteOptions } from '../project/painting/paintPalette';
import {
  ImportCancellationController,
  type ProjectImportParserPort,
  type ProjectImportSource,
} from '../project/import/types';
import { decodeIndexedMeshAsset, encodeIndexedMeshAsset } from '../project/meshCodec';
import { ReplaceVolumeMeshCommand, type MeshTopologyReplacementGuard } from '../project/objects/topologyCommands';
import { AddBrimEarCommand, ClearBrimEarsCommand, RemoveBrimEarCommand } from '../project/objects/brimEarCommands';
import {
  DEFAULT_SIMPLIFY_CONFIGURATION,
  simplifyMesh,
  type SimplifyConfiguration,
  type SimplifyOptions,
} from '../project/objects/simplify';
import {
  CreateInstanceCommand,
  createInstancesAtTransforms,
  DeleteInstanceCommand,
  DeleteObjectCommand,
  DuplicateObjectCommand,
  RenameObjectCommand,
  RenameVolumeCommand,
} from '../project/objects/commands';
import { computeCanonicalInstanceBounds, type CanonicalBounds3 } from '../project/objects/bounds';
import { exportCanonicalInstancesAsBinaryStl } from '../project/objects/stlExport';
import { SetInstanceTransformsCommand, type InstanceTransformChange } from '../project/objects/transformCommands';
import {
  centerInstancesOnPlate,
  layInstanceOnFace,
  mirrorInstances,
  resetInstanceRotations,
  resetInstanceScales,
  type MirrorAxis,
} from '../project/objects/transformOperations';
import {
  arrangementTransformChanges,
  planBedFill,
  planPlateArrangement,
  type ArrangeConstraints,
  type ArrangeResult,
} from '../project/objects/arrange';
import {
  AddLayerRangeCommand,
  DeleteLayerRangeCommand,
  EditLayerRangeBoundsCommand,
  inspectLayerRangeMerge,
  MergeLayerRangesCommand,
  SplitLayerRangeCommand,
} from '../project/objects/layerRangeCommands';
import { projectObjectsTree } from '../project/objects/projection';
import {
  ConvertVolumeRoleCommand,
  inspectVolumeRoleConversion,
  ORCA_VOLUME_ROLE_ORDER,
  type VolumeRoleConversionDecision,
} from '../project/objects/semanticVolumeCommands';
import { captureVolumeSplitGuard, type PreparedVolumeSplitPart } from '../project/objects/splitCommands';
import { prepareVolumeSplitParts } from '../project/objects/splitPreparation';
import {
  captureObjectVolumeSeparationGuard,
  commitPreparedVolumeSplitToObjects,
  SeparateObjectVolumesCommand,
  type SeparatedObjectIdentity,
} from '../project/objects/splitToObjectsCommands';
import type { ObjectTreeEntityRef, ObjectTreeProjection, ObjectTreeSelectionSnapshot } from '../project/objects/types';
import type {
  CancellationToken,
  ProjectProjectionHealthSnapshot,
  ProjectSerializerPort,
  SerializedProject,
} from '../project/ports';
import { Bbs3mfProjectSerializer } from '../project/serialization/Bbs3mfProjectSerializer';
import type { SelectionRef, SelectionSnapshot } from '../project/selection';
import {
  applyProjectSettingsOverrides,
  projectSettingsOverrideSnapshot,
  SetProjectSettingsOverridesCommand,
  StaleProjectSettingsOverrideError,
  type ProjectSettingsOverrideGuard,
  type ProjectSettingsOverrideSnapshot,
  type ProjectSettingsOverrideUpdate,
} from '../project/settingsOverrides';
import {
  SetScopedOverridesCommand,
  StaleScopedOverrideError,
  projectScopeUpdate,
  scopedOverrideSnapshot,
  scopedOverrideTargets,
  type ScopedOverrideGuard,
  type ScopedOverrideSnapshot,
  type ScopedOverrideTarget,
  type ScopedOverrideTargetOption,
} from '../project/scopedOverrides';
import { EditorSession, UnhealthyProjectProjectionError } from '../project/session';
import { StoreProjectSliceSource } from '../project/slicing/source';
import type { CanonicalProjectSliceGuard, CanonicalProjectSliceSourcePort } from '../project/slicing/types';
import {
  ThreeProjectSurface,
  type ThreePrinterSpaceMapping,
  type ThreeProjectProjectionStatus,
} from '../project/surfaces/ThreeProjectSurface';

const STAGING_ASSET_ID = entityId<'asset'>('import:orcaxr:canonical-workspace-staging');
const MAX_UI_NAME_LENGTH = 160;
const MAX_PLATE_NAME_LENGTH = 120;
const MAX_FILENAME_LENGTH = 255;
const MAX_GESTURE_ID_LENGTH = 96;
const CORE_FACET_ATTRIBUTES_KEY = 'https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes';

/**
 * Residual browser limitation: connected-component discovery is synchronous.
 * Keep the live seam conservatively bounded until it moves behind a worker.
 */
export const CANONICAL_SPLIT_TO_OBJECTS_SYNC_TRIANGLE_CAP = 50_000;

export type CanonicalWorkspaceClock = () => Date | string;

export interface CanonicalWorkspaceControllerOptions {
  readonly idSource: IdSource;
  readonly clock: CanonicalWorkspaceClock;
  readonly parent: THREE.Object3D;
  readonly mapping: ThreePrinterSpaceMapping;
  readonly projectName?: string;
  readonly firstPlateName?: string;
  readonly toolCount?: number;
  /** Authoritative engine/project config; never inferred from the render mapping. */
  readonly initialProjectConfig?: ConfigMap;
  /** Browser worker by default; injectable for deterministic/headless tests. */
  readonly projectImportParser?: ProjectImportParserPort;
  /**
   * Explicit persisted opt-in corresponding to pinned
   * `auto_generate_gradients`; absent is fail-closed/off.
   */
  readonly fullSpectrumAutoPairPreferences?: FullSpectrumAutoPairGenerationPreferences;
  /**
   * Test/embedding seam that may only lower the production synchronous cap.
   * Raising the cap requires replacing the preparation path with a worker.
   */
  readonly splitToObjectsSynchronousTriangleLimit?: number;
  readonly history?: {
    readonly maxEntries?: number;
    readonly maxEstimatedBytes?: number;
  };
}

export interface CanonicalPlateSummary {
  readonly id: PlateId;
  readonly name: string;
  readonly order: number;
  readonly active: boolean;
  readonly printable: boolean;
  readonly objectCount: number;
  readonly instanceCount: number;
  readonly modelVolumeCount: number;
}

export interface CanonicalWorkspaceSummary {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly revision: number;
  readonly projectHash: string;
  readonly activePlateId: PlateId;
  readonly selectedInstanceIds: readonly InstanceId[];
  readonly primaryInstanceId?: InstanceId;
  readonly plates: readonly CanonicalPlateSummary[];
  readonly objectCount: number;
  readonly instanceCount: number;
  readonly modelVolumeCount: number;
  readonly assetCount: number;
  readonly history: CommandHistorySnapshot;
  readonly dirty: boolean;
  readonly projectionHealth: ProjectProjectionHealthSnapshot;
  readonly sceneProjection: CanonicalSceneProjectionSummary;
}

export type CanonicalSceneProjectionSummary =
  | { readonly state: 'idle' | 'disposed' }
  | { readonly state: 'ready'; readonly sourceRevision: number; readonly sourceHash: string }
  | {
      readonly state: 'failed';
      readonly code: string;
      readonly sourceRevision: number;
      readonly sourceHash: string;
      readonly message: string;
    };

export type CanonicalWorkspaceChangeSource = 'initial' | 'project' | 'selection' | 'history' | 'projection-health';

export interface CanonicalWorkspaceChange {
  readonly current: CanonicalWorkspaceSummary;
  readonly previous?: CanonicalWorkspaceSummary;
  readonly sources: readonly CanonicalWorkspaceChangeSource[];
}

export type CanonicalWorkspaceSubscriber = (change: CanonicalWorkspaceChange) => void;

export interface CanonicalInstanceSummary {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly instanceId: InstanceId;
  readonly name: string;
  readonly printable: boolean;
  readonly transform: Transform;
}

export interface CanonicalDropToBedResult {
  readonly instances: readonly {
    readonly instanceId: InstanceId;
    readonly minZBeforeMm: number;
    readonly deltaZMm: number;
  }[];
}

export interface CanonicalStlExport {
  readonly bytes: Uint8Array;
  readonly mediaType: 'model/stl';
  readonly suggestedFilename: string;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly triangleCount: number;
  readonly instanceCount: number;
}

export type CanonicalInstanceDeletionSummary =
  | {
      readonly scope: 'instance';
      readonly instanceId: InstanceId;
      readonly objectId: ObjectId;
    }
  | {
      readonly scope: 'object';
      readonly instanceId: InstanceId;
      readonly objectId: ObjectId;
    };

export interface CanonicalInstanceDuplicationSummary extends CanonicalInstanceSummary {
  readonly sourceInstanceId: InstanceId;
}

export interface CanonicalObjectDuplicationSummary {
  readonly sourceObjectId: ObjectId;
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly name: string;
  readonly volumeIds: readonly VolumeId[];
  readonly instanceIds: readonly InstanceId[];
  readonly layerRangeIds: readonly LayerRangeId[];
  readonly primaryInstanceId?: InstanceId;
}

export interface CanonicalSplitToObjectsGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
  readonly selectionFingerprint: string;
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly primaryInstanceId: InstanceId;
}

/** Immutable, exact scope a composition root must show before destructive promotion. */
export interface CanonicalSplitToObjectsConfirmation {
  readonly guard: CanonicalSplitToObjectsGuard;
  readonly objectName: string;
  readonly strategy: 'existing-volumes' | 'connected-components';
  readonly volumeCount: number;
  readonly triangleCount: number;
  readonly affectedInstanceIds: readonly InstanceId[];
}

export interface CanonicalSplitToObjectsResult {
  readonly sourceObjectId: ObjectId;
  readonly strategy: CanonicalSplitToObjectsConfirmation['strategy'];
  readonly objectIds: readonly ObjectId[];
  readonly instanceIds: readonly InstanceId[];
  readonly volumeIds: readonly VolumeId[];
  readonly assetIds: readonly AssetId[];
}

export class StaleCanonicalSplitToObjectsError extends Error {
  constructor() {
    super('Split to Objects confirmation is stale; reselect the model and review the affected instances again');
    this.name = 'StaleCanonicalSplitToObjectsError';
  }
}

export class CanonicalSplitToObjectsTriangleLimitError extends Error {
  constructor(
    readonly triangleCount: number,
    readonly limit: number,
  ) {
    super(
      `Split to Objects is limited to ${limit.toLocaleString('en-US')} triangles while connected-component analysis remains synchronous; this model has ${triangleCount.toLocaleString('en-US')}`,
    );
    this.name = 'CanonicalSplitToObjectsTriangleLimitError';
  }
}

export type CanonicalObjectEntityRef = ObjectTreeEntityRef;

export interface CanonicalObjectsTreeSelection extends ObjectTreeSelectionSnapshot {
  readonly refs: readonly ObjectTreeEntityRef[];
  readonly primary?: ObjectTreeEntityRef;
}

/** Caller-owned, revision-bound projection of the canonical Objects hierarchy. */
export interface CanonicalObjectsTreeSnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly projection: ObjectTreeProjection;
  readonly selection: CanonicalObjectsTreeSelection;
}

export type CanonicalFilamentAssignableEntityRef = Extract<
  ObjectTreeEntityRef,
  { kind: 'object' | 'volume' | 'layer-range' }
>;

export interface CanonicalFilamentOption {
  readonly id: FilamentId;
  readonly kind: 'physical' | 'mixed';
  readonly name: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly material?: string;
  readonly presetId?: string;
  readonly toolId?: number;
  readonly distributionMode?: MixedFilament['distribution']['mode'];
  readonly recipe: readonly {
    /** Recipes always reference stable physical-head IDs, never virtual rows. */
    readonly filamentId: PhysicalFilamentId;
    readonly name: string;
    readonly color: string;
    readonly weight: number;
  }[];
  readonly warnings: readonly string[];
}

export interface CanonicalFilamentAssignmentScope {
  readonly entity: CanonicalFilamentAssignableEntityRef;
  readonly objectId: ObjectId;
  readonly label: string;
  readonly localFilamentId?: FilamentId;
  readonly inheritedFilamentId?: FilamentId;
  readonly effectiveFilamentId?: FilamentId;
}

export interface CanonicalFilamentAssignmentSnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly scopes: readonly CanonicalFilamentAssignmentScope[];
  readonly unsupportedSelection: readonly ObjectTreeEntityRef[];
  readonly options: readonly CanonicalFilamentOption[];
}

export interface CanonicalFilamentAssignmentGuard {
  readonly sourceRevision: number;
  readonly sourceHash: string;
}

export interface CanonicalVirtualFilamentLibrarySnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  /** Current one-based transient engine order paired with stable physical IDs. */
  readonly physical: readonly {
    readonly id: PhysicalFilamentId;
    readonly engineToolId: number;
    readonly name: string;
    readonly material: string;
    readonly color: string;
    readonly enabled: boolean;
  }[];
  readonly mixed: readonly {
    readonly filament: Immutable<MixedFilament>;
    readonly dependencyPaths: readonly string[];
    readonly hasExactFullSpectrumState: boolean;
  }[];
}

export interface CanonicalVirtualFilamentMutationGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
}

export type CanonicalAutoPairReconciliationGuard = FullSpectrumAutoPairReconciliationGuard;

export interface CanonicalAutoPairReconciliationConfirmation {
  /** Must exactly match the current library; confirmations are never transferable across counts. */
  readonly confirmedPhysicalCount: number;
}

interface CanonicalAutoPairReconciliationResultBase {
  readonly changed: boolean;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly physicalCount: number;
  readonly projectedPairCount: number;
  readonly createdRowIds: readonly MixedFilamentId[];
  readonly droppedRowIds: readonly MixedFilamentId[];
}

export type CanonicalAutoPairReconciliationResult =
  | (CanonicalAutoPairReconciliationResultBase & { readonly status: 'disabled'; readonly changed: false })
  | (CanonicalAutoPairReconciliationResultBase & {
      readonly status: 'confirmation-required';
      readonly changed: false;
    })
  | (CanonicalAutoPairReconciliationResultBase & { readonly status: 'unchanged'; readonly changed: false })
  | (CanonicalAutoPairReconciliationResultBase & { readonly status: 'reconciled'; readonly changed: true });

export interface CanonicalAutoPairPolicySnapshot {
  readonly enabled: boolean;
  readonly physicalCount: number;
  readonly projectedPairCount: number;
  readonly confirmationRequired: boolean;
}

export class FullSpectrumAutoPairConfirmationMismatchError extends Error {
  override readonly name = 'FullSpectrumAutoPairConfirmationMismatchError';

  constructor(
    readonly confirmedPhysicalCount: number,
    readonly currentPhysicalCount: number,
  ) {
    super(
      `Automatic pair confirmation targets ${confirmedPhysicalCount} physical filaments, but the current library has ${currentPhysicalCount}`,
    );
  }
}

export type CanonicalVirtualFilamentMutationRequest = CanonicalVirtualFilamentMutationGuard &
  (
    | { readonly operation: 'add'; readonly draft: FullSpectrumRecipeDraft; readonly requestedId?: MixedFilamentId }
    | {
        readonly operation: 'edit';
        readonly filamentId: MixedFilamentId;
        readonly draft: FullSpectrumRecipeDraft;
      }
    | {
        readonly operation: 'duplicate';
        readonly sourceFilamentId: MixedFilamentId;
        readonly draft: FullSpectrumRecipeDraft;
        readonly requestedDuplicateId?: MixedFilamentId;
      }
    | { readonly operation: 'set-enabled'; readonly filamentId: MixedFilamentId; readonly enabled: boolean }
    | { readonly operation: 'delete'; readonly filamentId: MixedFilamentId }
  );

export interface CanonicalLayerEventRow {
  readonly id: CustomGcodeId;
  readonly event: CustomGcodeLayerEvent;
  /** Body the engine emits; only a custom event has one. */
  readonly code: string;
}

export interface CanonicalLayerEventSnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly plateId: PlateId;
  /** Events on the active plate, in print order. */
  readonly events: readonly CanonicalLayerEventRow[];
}

export type CanonicalLayerEventMutationRequest = Readonly<{
  expectedRevision: number;
  sourceHash: string;
}> &
  (
    | {
        readonly operation: 'add';
        readonly type: LayerEventType;
        readonly topZMm: number;
        readonly toolIndex?: number;
        readonly filamentId?: FilamentId;
        readonly color?: string;
        readonly message?: string;
        readonly code?: string;
      }
    | { readonly operation: 'edit'; readonly id: CustomGcodeId; readonly patch: LayerEventPatch }
    | { readonly operation: 'delete'; readonly id: CustomGcodeId }
  );

export class StaleCanonicalLayerEventMutationError extends Error {
  override readonly name = 'StaleCanonicalLayerEventMutationError';

  constructor() {
    super('Layer-event operation was prepared for a stale canonical project revision');
  }
}

export class StaleCanonicalVirtualFilamentMutationError extends Error {
  constructor() {
    super('Virtual filament operation was prepared for a stale canonical project revision');
    this.name = 'StaleCanonicalVirtualFilamentMutationError';
  }
}

export { StaleFullSpectrumAutoPairReconciliationError };

export class StaleCanonicalFilamentAssignmentError extends Error {
  constructor() {
    super('Filament assignment was prepared for a stale canonical project revision');
    this.name = 'StaleCanonicalFilamentAssignmentError';
  }
}

export class StaleCanonicalPlateMutationError extends Error {
  constructor() {
    super('Plate operation was prepared for a stale canonical project revision');
    this.name = 'StaleCanonicalPlateMutationError';
  }
}

export class StaleCanonicalSemanticObjectMutationError extends Error {
  constructor() {
    super('Semantic object edit was prepared for a stale canonical project revision');
    this.name = 'StaleCanonicalSemanticObjectMutationError';
  }
}

export interface CanonicalSemanticObjectMutationGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
  readonly objectId: ObjectId;
}

export interface CanonicalSemanticVolumeRoleRequest extends CanonicalSemanticObjectMutationGuard {
  readonly volumeId: VolumeId;
  readonly nextRole: VolumeRole;
}

export type CanonicalSemanticLayerRangeRequest = CanonicalSemanticObjectMutationGuard &
  (
    | {
        readonly operation: 'add';
        readonly layerRangeId: LayerRangeId;
        readonly minZMm: number;
        readonly maxZMm: number;
      }
    | {
        readonly operation: 'edit';
        readonly layerRangeId: LayerRangeId;
        readonly minZMm: number;
        readonly maxZMm: number;
      }
    | {
        readonly operation: 'split';
        readonly layerRangeId: LayerRangeId;
        readonly splitZMm: number;
        readonly upperRangeId: LayerRangeId;
      }
    | {
        readonly operation: 'merge';
        readonly firstRangeId: LayerRangeId;
        readonly secondRangeId: LayerRangeId;
      }
    | { readonly operation: 'delete'; readonly layerRangeId: LayerRangeId }
  );

export interface CanonicalSemanticObjectEditorSnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly objectId: ObjectId;
  readonly objectName: string;
  readonly selectedVolume?: {
    readonly id: VolumeId;
    readonly name: string;
    readonly role: VolumeRole;
    readonly roleDecisions: readonly {
      readonly role: VolumeRole;
      readonly decision: VolumeRoleConversionDecision;
    }[];
  };
  readonly layerRanges: readonly {
    readonly id: LayerRangeId;
    readonly minZMm: number;
    readonly maxZMm: number;
  }[];
  readonly selectedLayerRange?: {
    readonly id: LayerRangeId;
    readonly mergePrevious:
      | { readonly allowed: true; readonly otherRangeId: LayerRangeId }
      | { readonly allowed: false; readonly reason: string; readonly otherRangeId?: LayerRangeId };
    readonly mergeNext:
      | { readonly allowed: true; readonly otherRangeId: LayerRangeId }
      | { readonly allowed: false; readonly reason: string; readonly otherRangeId?: LayerRangeId };
  };
}

type Immutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

/** Caller-owned profile/config material; cloned before validation and commit. */
export type CanonicalSlicingConfiguration = Immutable<{
  printer: ProjectState['printer'];
  /** Inherited/base profile config before canonical project setting overrides. */
  config: ConfigMap;
  /** Omit to preserve canonical overrides; include a complete map to replace them. */
  settingsOverrides?: ConfigMap;
  filaments: {
    physical: PhysicalFilament[];
    mixed: MixedFilament[];
  };
}>;

export interface ImportBufferGeometryOptions {
  readonly plateId?: PlateId;
  readonly name?: string;
  readonly sourceFilename?: string;
  readonly transform?: Transform;
}

export interface ImportedCanonicalModel {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly volumeId: VolumeId;
  readonly instanceId: InstanceId;
  readonly assetId: AssetId;
  readonly reusedAsset: boolean;
}

/**
 * Store-first composition seam for the legacy workspace migration. Three.js is
 * a one-way projection: callers may pass stable IDs back into this controller,
 * but scene transforms are never read as canonical mutations.
 */
export class CanonicalWorkspaceController {
  readonly surface: ThreeProjectSurface;

  private readonly assets: InMemoryAssetRepository;
  private readonly session: EditorSession;
  private readonly subscribers = new Set<CanonicalWorkspaceSubscriber>();
  private readonly sourceUnsubscribers: Array<() => void> = [];
  private readonly importCoordinator: ProjectImportCoordinator;
  private readonly importCancellations = new Set<ImportCancellationController>();
  private autoPairGenerationEnabled: boolean;
  private readonly confirmedAutoPairPhysicalCounts = new Set<number>();
  private readonly pendingChangeSources = new Set<Exclude<CanonicalWorkspaceChangeSource, 'initial'>>();
  private readonly splitToObjectsSynchronousTriangleLimit: number;
  private lastPublishedSummary: CanonicalWorkspaceSummary;
  private notificationScheduled = false;
  private transformSequence = 0;
  private disposed = false;

  static createEmpty(options: CanonicalWorkspaceControllerOptions): CanonicalWorkspaceController {
    return new CanonicalWorkspaceController(options);
  }

  constructor(private readonly options: CanonicalWorkspaceControllerOptions) {
    const splitTriangleLimit =
      options.splitToObjectsSynchronousTriangleLimit ?? CANONICAL_SPLIT_TO_OBJECTS_SYNC_TRIANGLE_CAP;
    if (
      !Number.isSafeInteger(splitTriangleLimit) ||
      splitTriangleLimit < 1 ||
      splitTriangleLimit > CANONICAL_SPLIT_TO_OBJECTS_SYNC_TRIANGLE_CAP
    ) {
      throw new Error(
        `Split-to-objects synchronous triangle limit must be an integer from 1 to ${CANONICAL_SPLIT_TO_OBJECTS_SYNC_TRIANGLE_CAP}`,
      );
    }
    this.splitToObjectsSynchronousTriangleLimit = splitTriangleLimit;
    this.autoPairGenerationEnabled = options.fullSpectrumAutoPairPreferences?.enabled === true;
    const now = readClock(options.clock);
    const initialState = createEmptyProject({
      idSource: options.idSource,
      now,
      name: boundedName(options.projectName, 'Untitled project'),
      firstPlateName: boundedName(options.firstPlateName, 'Plate 1'),
      toolCount: options.toolCount,
    });
    if (options.initialProjectConfig) initialState.config = cloneJson(options.initialProjectConfig);
    const reconciledInitialState = this.withReconciledAutoPairs(initialState);
    const serializer = this.reconcilingSerializer(new Bbs3mfProjectSerializer());
    this.assets = new InMemoryAssetRepository();
    this.session = new EditorSession({
      initialState: reconciledInitialState,
      assets: this.assets,
      serializer,
      history: options.history,
    });
    const parser = options.projectImportParser ?? new BbsProjectImportWorkerClient();
    this.importCoordinator = new ProjectImportCoordinator({
      parser: {
        parse: async (request) => {
          const parsed = await parser.parse(request);
          return { ...parsed, state: this.withReconciledAutoPairs(parsed.state) };
        },
      },
      commands: this.session.commands,
      now: () => readClock(options.clock),
    });
    try {
      this.surface = new ThreeProjectSurface({
        parent: options.parent,
        assets: this.assets,
        mapping: options.mapping,
      });
      this.session.attachSurface(this.surface);
      this.lastPublishedSummary = this.buildSummary();
      this.sourceUnsubscribers.push(
        this.session.project.subscribe(() => this.scheduleChange('project')),
        this.session.selection.subscribe(() => this.scheduleChange('selection')),
        this.session.commands.subscribeHistory(() => this.scheduleChange('history')),
        this.session.subscribeProjectionHealth(() => this.scheduleChange('projection-health')),
      );
    } catch (error) {
      this.session.dispose();
      throw error;
    }
  }

  getSummary(): CanonicalWorkspaceSummary {
    this.assertActive();
    return this.buildSummary();
  }

  /**
   * Publish immutable, internally consistent summaries. Synchronous command
   * project/selection/history emissions are collapsed into one microtask so a
   * UI never observes a half-updated command boundary.
   */
  subscribe(subscriber: CanonicalWorkspaceSubscriber, options: { emitCurrent?: boolean } = {}): () => void {
    this.assertActive();
    if (this.pendingChangeSources.size > 0) this.publishPendingChange();
    this.subscribers.add(subscriber);
    if (options.emitCurrent ?? true) {
      safelyNotify(subscriber, {
        current: this.lastPublishedSummary,
        sources: Object.freeze(['initial']),
      });
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.subscribers.delete(subscriber);
    };
  }

  private buildSummary(): CanonicalWorkspaceSummary {
    const project = this.session.project.getSnapshot();
    const selection = this.session.selection.getSnapshot();
    const history = this.session.commands.getHistorySnapshot();
    const plates = [...project.state.plates]
      .sort((left, right) => left.order - right.order)
      .map((plate): CanonicalPlateSummary => {
        const objects = plate.objects;
        return Object.freeze({
          id: plate.id,
          name: plate.name,
          order: plate.order,
          active: plate.id === project.state.activePlateId,
          printable: plate.printable,
          objectCount: objects.length,
          instanceCount: objects.reduce((count, object) => count + object.instances.length, 0),
          modelVolumeCount: objects.reduce(
            (count, object) => count + object.volumes.filter((volume) => volume.role === 'model').length,
            0,
          ),
        });
      });
    const selectedInstanceIds = selection.refs.flatMap((ref) => (ref.kind === 'instance' ? [ref.id] : []));
    const primaryInstanceId = selection.primary?.kind === 'instance' ? selection.primary.id : undefined;
    const objectCount = plates.reduce((count, plate) => count + plate.objectCount, 0);
    const instanceCount = plates.reduce((count, plate) => count + plate.instanceCount, 0);
    const modelVolumeCount = plates.reduce((count, plate) => count + plate.modelVolumeCount, 0);
    const frozenHistory = Object.freeze({
      ...history,
      dirtyCategories: Object.freeze([...history.dirtyCategories]),
    });
    return Object.freeze({
      projectId: project.state.id,
      projectName: project.state.name,
      revision: project.revision,
      projectHash: project.hash,
      activePlateId: project.state.activePlateId,
      selectedInstanceIds: Object.freeze([...selectedInstanceIds]),
      ...(primaryInstanceId ? { primaryInstanceId } : {}),
      plates: Object.freeze(plates),
      objectCount,
      instanceCount,
      modelVolumeCount,
      assetCount: project.state.sourceAssets.length,
      history: frozenHistory,
      dirty: history.dirtyCategories.length > 0,
      projectionHealth: this.session.getProjectionHealthSnapshot(),
      sceneProjection: summarizeSceneProjection(this.surface.getProjectionStatus()),
    });
  }

  getInstance(instanceId: InstanceId): CanonicalInstanceSummary | undefined {
    this.assertActive();
    const found = findInstance(this.session.project.getSnapshot().state, instanceId);
    if (!found) return undefined;
    return Object.freeze({
      plateId: found.plate.id,
      objectId: found.object.id,
      instanceId: found.instance.id,
      name: found.instance.name ?? found.object.name,
      printable: found.plate.printable && found.instance.printable,
      transform: freezeTransform(found.instance.transform),
    });
  }

  /** Read-only canonical geometry bounds for an exact stable-ID instance set. */
  getInstanceBounds(instanceIds: readonly InstanceId[]): CanonicalBounds3 {
    this.assertActive();
    return computeCanonicalInstanceBounds(this.session.project.getSnapshot().state, this.assets, instanceIds);
  }

  /**
   * Derive the complete Objects hierarchy from the current canonical graph.
   * The returned rows carry stable entity IDs and cannot mutate project state.
   */
  getObjectsTree(): CanonicalObjectsTreeSnapshot {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const selection = freezeObjectsTreeSelection(this.session.selection.getSnapshot());
    return Object.freeze({
      sourceRevision: project.revision,
      sourceHash: project.hash,
      projection: projectObjectsTree(project.state),
      selection,
    });
  }

  /** Project the selected object's semantic roles and height ranges without exposing mutable state. */
  getSemanticObjectEditorSnapshot(): CanonicalSemanticObjectEditorSnapshot | undefined {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const primary = this.session.selection.getSnapshot().primary;
    if (!primary) return undefined;
    const context = semanticSelectionContext(project.state, primary);
    if (!context) return undefined;
    const { object, selectedVolumeId, selectedLayerRangeId } = context;
    const selectedVolume = selectedVolumeId
      ? object.volumes.find((volume) => volume.id === selectedVolumeId)
      : undefined;
    const layerRanges = [...object.layerRanges]
      .sort(
        (left, right) => left.minZMm - right.minZMm || left.maxZMm - right.maxZMm || left.id.localeCompare(right.id),
      )
      .map((range) => ({ id: range.id, minZMm: range.minZMm, maxZMm: range.maxZMm }));
    const selectedIndex = selectedLayerRangeId
      ? layerRanges.findIndex((range) => range.id === selectedLayerRangeId)
      : -1;
    const mergeDecision = (otherIndex: number, direction: 'previous' | 'next') => {
      const other = layerRanges[otherIndex];
      if (!selectedLayerRangeId || !other) {
        return { allowed: false as const, reason: `There is no ${direction} height range.` };
      }
      const inspection = inspectLayerRangeMerge(project.state, object.id, selectedLayerRangeId, other.id);
      return inspection.allowed
        ? { allowed: true as const, otherRangeId: other.id }
        : { allowed: false as const, reason: inspection.reason, otherRangeId: other.id };
    };
    return deepFreeze({
      sourceRevision: project.revision,
      sourceHash: project.hash,
      objectId: object.id,
      objectName: object.name,
      ...(selectedVolume
        ? {
            selectedVolume: {
              id: selectedVolume.id,
              name: selectedVolume.name,
              role: selectedVolume.role,
              roleDecisions: ORCA_VOLUME_ROLE_ORDER.map((role) => ({
                role,
                decision: inspectVolumeRoleConversion(project.state, selectedVolume.id, role),
              })),
            },
          }
        : {}),
      layerRanges,
      ...(selectedIndex >= 0 && selectedLayerRangeId
        ? {
            selectedLayerRange: {
              id: selectedLayerRangeId,
              mergePrevious: mergeDecision(selectedIndex - 1, 'previous'),
              mergeNext: mergeDecision(selectedIndex + 1, 'next'),
            },
          }
        : {}),
    });
  }

  /** Allocate a stable range ID before a guarded add/split request is submitted. */
  createLayerRangeId(): LayerRangeId {
    this.assertActive();
    return this.options.idSource.next('layer-range');
  }

  convertSemanticVolumeRole(request: CanonicalSemanticVolumeRoleRequest): void {
    const state = this.assertSemanticObjectMutationGuard(request);
    const found = findVolume(state, request.volumeId);
    if (!found || found.object.id !== request.objectId) {
      throw new Error(`Volume ${request.volumeId} is not owned by object ${request.objectId}`);
    }
    this.session.execute(new ConvertVolumeRoleCommand(request.volumeId, request.nextRole));
  }

  editSemanticLayerRange(request: CanonicalSemanticLayerRangeRequest): void {
    const state = this.assertSemanticObjectMutationGuard(request);
    const object = findObject(state, request.objectId)?.object;
    if (!object) throw new Error(`Unknown object ${request.objectId}`);
    const requireOwned = (rangeId: LayerRangeId): void => {
      if (!object.layerRanges.some((range) => range.id === rangeId)) {
        throw new Error(`Layer range ${rangeId} is not owned by object ${request.objectId}`);
      }
    };
    switch (request.operation) {
      case 'add':
        this.session.execute(
          new AddLayerRangeCommand(request.objectId, {
            id: request.layerRangeId,
            minZMm: request.minZMm,
            maxZMm: request.maxZMm,
            config: {},
          }),
        );
        return;
      case 'edit':
        requireOwned(request.layerRangeId);
        this.session.execute(
          new EditLayerRangeBoundsCommand(request.objectId, request.layerRangeId, {
            minZMm: request.minZMm,
            maxZMm: request.maxZMm,
          }),
        );
        return;
      case 'split':
        requireOwned(request.layerRangeId);
        this.session.execute(
          new SplitLayerRangeCommand(request.objectId, request.layerRangeId, request.splitZMm, request.upperRangeId),
        );
        return;
      case 'merge':
        requireOwned(request.firstRangeId);
        requireOwned(request.secondRangeId);
        this.session.execute(
          new MergeLayerRangesCommand(request.objectId, request.firstRangeId, request.secondRangeId),
        );
        return;
      case 'delete':
        requireOwned(request.layerRangeId);
        this.session.execute(new DeleteLayerRangeCommand(request.objectId, request.layerRangeId));
    }
  }

  /**
   * Resolve assignable Objects-tree scopes and stable filament definitions
   * against one immutable project revision. Unsupported selected rows remain
   * explicit so a UI cannot silently apply to only part of a selection.
   */
  getFilamentAssignmentSnapshot(refs?: readonly ObjectTreeEntityRef[]): CanonicalFilamentAssignmentSnapshot {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const requestedRefs = refs ?? freezeObjectsTreeSelection(this.session.selection.getSnapshot()).refs;
    const scopes: CanonicalFilamentAssignmentScope[] = [];
    const unsupportedSelection: ObjectTreeEntityRef[] = [];
    const seen = new Set<string>();
    for (const ref of requestedRefs) {
      const key = objectTreeEntityKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const scope = resolveFilamentAssignmentScope(project.state, ref);
      if (scope) scopes.push(scope);
      else unsupportedSelection.push(Object.freeze({ ...ref }));
    }
    return Object.freeze({
      sourceRevision: project.revision,
      sourceHash: project.hash,
      scopes: Object.freeze(scopes),
      unsupportedSelection: Object.freeze(unsupportedSelection),
      options: canonicalFilamentOptions(project.state),
    });
  }

  /**
   * Assign or inherit one stable filament ID across heterogeneous canonical
   * scopes as exactly one history command. The caller must submit the guard
   * from the snapshot it displayed; stale UI decisions fail without mutation.
   */
  setFilamentAssignments(
    entities: readonly CanonicalFilamentAssignableEntityRef[],
    filamentId: FilamentId | null,
    guard: CanonicalFilamentAssignmentGuard,
  ): boolean {
    this.assertActive();
    const before = this.session.project.getSnapshot();
    if (before.revision !== guard.sourceRevision || before.hash !== guard.sourceHash) {
      throw new StaleCanonicalFilamentAssignmentError();
    }
    if (entities.length === 0) throw new Error('Filament assignment requires at least one assignable scope');
    if (filamentId) {
      const destination = [...before.state.filaments.physical, ...before.state.filaments.mixed].find(
        (candidate) => candidate.id === filamentId,
      );
      if (!destination) throw new Error(`Unknown filament ${filamentId}`);
      if (!destination.enabled) throw new Error(`Destination filament ${filamentId} is disabled`);
    }
    const assignments = entities.map((entity) => filamentAssignmentChange(before.state, entity, filamentId));
    this.session.execute(new SetFilamentAssignmentsCommand(assignments));
    return this.session.project.getSnapshot().revision !== before.revision;
  }

  /** Revision-bound layer events for the active plate, in print order. */
  getLayerEventSnapshot(): CanonicalLayerEventSnapshot {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    return deepFreeze({
      sourceRevision: project.revision,
      sourceHash: project.hash,
      plateId: project.state.activePlateId,
      events: plateLayerEvents(project.state, project.state.activePlateId).map((entry) => ({
        id: entry.id,
        event: cloneJson(entry.layerEvent!),
        code: entry.code,
      })),
    });
  }

  /** One guarded add/edit/delete of a layer event on the active plate. */
  mutateLayerEvent(request: CanonicalLayerEventMutationRequest): CustomGcodeId | undefined {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new Error('Expected layer-event revision must be a non-negative safe integer');
    }
    if (project.revision !== request.expectedRevision || project.hash !== request.sourceHash) {
      throw new StaleCanonicalLayerEventMutationError();
    }
    switch (request.operation) {
      case 'add': {
        const id = this.options.idSource.next('custom-gcode');
        this.session.execute(
          new AddLayerEventCommand({
            id,
            plateId: project.state.activePlateId,
            type: request.type,
            topZMm: request.topZMm,
            ...(request.toolIndex !== undefined ? { toolIndex: request.toolIndex } : {}),
            ...(request.filamentId !== undefined ? { filamentId: request.filamentId } : {}),
            ...(request.color !== undefined ? { color: request.color } : {}),
            ...(request.message !== undefined ? { message: request.message } : {}),
            ...(request.code !== undefined ? { code: request.code } : {}),
          }),
        );
        return id;
      }
      case 'edit':
        this.session.execute(new EditLayerEventCommand(request.id, request.patch));
        return request.id;
      case 'delete':
        this.session.execute(new DeleteLayerEventCommand(request.id));
        return undefined;
    }
  }

  /** Immutable FullSpectrum library state; deleted tombstones stay canonical but are hidden from authoring rows. */
  getVirtualFilamentLibrarySnapshot(): CanonicalVirtualFilamentLibrarySnapshot {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    return deepFreeze({
      sourceRevision: project.revision,
      sourceHash: project.hash,
      physical: project.state.filaments.physical.map((filament, index) => ({
        id: filament.id,
        engineToolId: index + 1,
        name: filament.name,
        material: filament.material,
        color: filament.color,
        enabled: filament.enabled,
      })),
      mixed: project.state.filaments.mixed
        .filter((filament) => !filament.fullSpectrum?.deleted)
        .map((filament) => ({
          filament: cloneJson(filament),
          dependencyPaths: findFilamentDependentPaths(project.state, filament.id),
          hasExactFullSpectrumState: filament.fullSpectrum !== undefined,
        })),
    });
  }

  createMixedFilamentId(): MixedFilamentId {
    this.assertActive();
    return this.options.idSource.next('mixed-filament');
  }

  /**
   * Restore the pinned C(N,2) base section for exactly the guarded canonical
   * revision. Missing identities are allocated before one reversible command;
   * stale or already-reconciled calls neither allocate nor add history.
   */
  reconcileFullSpectrumAutoPairs(
    guard: CanonicalAutoPairReconciliationGuard,
    confirmation?: CanonicalAutoPairReconciliationConfirmation,
  ): CanonicalAutoPairReconciliationResult {
    this.assertActive();
    const before = this.session.project.getSnapshot();
    if (before.revision !== guard.expectedRevision || before.hash !== guard.sourceHash) {
      throw new StaleFullSpectrumAutoPairReconciliationError();
    }
    const physicalCount = before.state.filaments.physical.length;
    const projectedPairCount = (physicalCount * (physicalCount - 1)) / 2;
    const blockedResult = (status: 'disabled' | 'confirmation-required'): CanonicalAutoPairReconciliationResult =>
      Object.freeze({
        status,
        changed: false,
        sourceRevision: before.revision,
        sourceHash: before.hash,
        physicalCount,
        projectedPairCount,
        createdRowIds: Object.freeze([]),
        droppedRowIds: Object.freeze([]),
      });
    if (!this.autoPairGenerationEnabled) return blockedResult('disabled');
    if (confirmation) {
      if (
        !Number.isSafeInteger(confirmation.confirmedPhysicalCount) ||
        confirmation.confirmedPhysicalCount !== physicalCount
      ) {
        throw new FullSpectrumAutoPairConfirmationMismatchError(confirmation.confirmedPhysicalCount, physicalCount);
      }
      this.confirmedAutoPairPhysicalCounts.add(physicalCount);
    }
    if (this.autoPairConfirmationRequired(physicalCount)) {
      return blockedResult('confirmation-required');
    }
    const reconciliation = this.reconcileAutoPairFilaments(
      before.state.filaments.physical,
      before.state.filaments.mixed,
    );
    if (reconciliation.changed) {
      this.session.execute(new ReconcileFullSpectrumAutoPairsCommand(guard, reconciliation.filaments), {
        coalesce: false,
      });
    }
    const after = this.session.project.getSnapshot();
    return Object.freeze({
      status: reconciliation.changed ? 'reconciled' : 'unchanged',
      changed: reconciliation.changed,
      sourceRevision: after.revision,
      sourceHash: after.hash,
      physicalCount,
      projectedPairCount,
      createdRowIds: Object.freeze([...reconciliation.createdRowIds]),
      droppedRowIds: Object.freeze([...reconciliation.droppedRowIds]),
    }) as CanonicalAutoPairReconciliationResult;
  }

  getFullSpectrumAutoPairPolicySnapshot(): CanonicalAutoPairPolicySnapshot {
    this.assertActive();
    const physicalCount = this.session.project.getSnapshot().state.filaments.physical.length;
    return Object.freeze({
      enabled: this.autoPairGenerationEnabled,
      physicalCount,
      projectedPairCount: (physicalCount * (physicalCount - 1)) / 2,
      confirmationRequired: this.autoPairGenerationEnabled && this.autoPairConfirmationRequired(physicalCount),
    });
  }

  /**
   * Update the explicit app preference and immediately reconcile the current
   * guarded library when the pinned confirmation policy permits it.
   *
   * Turning the preference off deliberately leaves imported, profile-authored,
   * custom, and generated rows byte-semantically intact.
   */
  setFullSpectrumAutoPairGenerationEnabled(
    enabled: boolean,
    confirmation?: CanonicalAutoPairReconciliationConfirmation,
  ): CanonicalAutoPairReconciliationResult {
    this.assertActive();
    if (enabled !== true && enabled !== false) {
      throw new Error('Automatic FullSpectrum pair preference must be boolean');
    }
    const current = this.session.project.getSnapshot();
    const previous = this.autoPairGenerationEnabled;
    this.autoPairGenerationEnabled = enabled;
    try {
      return this.reconcileFullSpectrumAutoPairs(
        { expectedRevision: current.revision, sourceHash: current.hash },
        confirmation,
      );
    } catch (error) {
      this.autoPairGenerationEnabled = previous;
      throw error;
    }
  }

  mutateVirtualFilament(request: CanonicalVirtualFilamentMutationRequest):
    | { readonly operation: 'add' | 'duplicate'; readonly filamentId: MixedFilamentId }
    | { readonly operation: 'edit' | 'set-enabled' }
    | {
        readonly operation: 'delete';
        readonly outcome: 'removed' | 'tombstoned';
        readonly dependencyPaths: readonly string[];
      } {
    const guard = { expectedRevision: request.expectedRevision, sourceHash: request.sourceHash };
    switch (request.operation) {
      case 'add':
        return {
          operation: 'add',
          filamentId: this.addVirtualFilament(request.draft, guard, request.requestedId),
        };
      case 'edit':
        this.editVirtualFilament(request.filamentId, request.draft, guard);
        return { operation: 'edit' };
      case 'duplicate':
        return {
          operation: 'duplicate',
          filamentId: this.duplicateVirtualFilament(
            request.sourceFilamentId,
            request.draft,
            guard,
            request.requestedDuplicateId,
          ),
        };
      case 'set-enabled':
        this.setVirtualFilamentEnabled(request.filamentId, request.enabled, guard);
        return { operation: 'set-enabled' };
      case 'delete':
        return { operation: 'delete', ...this.deleteVirtualFilament(request.filamentId, guard) };
    }
  }

  addVirtualFilament(
    draft: FullSpectrumRecipeDraft,
    guard: CanonicalVirtualFilamentMutationGuard,
    requestedId?: MixedFilamentId,
  ): MixedFilamentId {
    const state = this.assertVirtualFilamentMutationGuard(guard);
    const id = requestedId ?? this.options.idSource.next('mixed-filament');
    const filament = createFullSpectrumMixedFilament(id, state.filaments.physical, draft);
    this.session.execute(new AddMixedFilamentCommand(filament));
    return id;
  }

  editVirtualFilament(
    filamentId: MixedFilamentId,
    draft: FullSpectrumRecipeDraft,
    guard: CanonicalVirtualFilamentMutationGuard,
  ): void {
    const state = this.assertVirtualFilamentMutationGuard(guard);
    const current = state.filaments.mixed.find((filament) => filament.id === filamentId);
    if (!current) throw new Error(`Unknown mixed filament ${filamentId}`);
    const replacement = replaceFullSpectrumMixedFilament(current, state.filaments.physical, draft);
    this.session.transaction('Edit mixed filament', () => {
      this.session.execute(
        new EditMixedFilamentCommand(filamentId, {
          name: replacement.name,
          displayColor: replacement.displayColor,
          components: replacement.components,
          distribution: replacement.distribution,
          fullSpectrum: replacement.fullSpectrum,
        }),
      );
      this.reconcileCurrentAutoPairs();
    });
  }

  duplicateVirtualFilament(
    sourceFilamentId: MixedFilamentId,
    draft: FullSpectrumRecipeDraft,
    guard: CanonicalVirtualFilamentMutationGuard,
    requestedDuplicateId?: MixedFilamentId,
  ): MixedFilamentId {
    const state = this.assertVirtualFilamentMutationGuard(guard);
    if (!state.filaments.mixed.some((filament) => filament.id === sourceFilamentId)) {
      throw new Error(`Unknown mixed filament ${sourceFilamentId}`);
    }
    const duplicateId = requestedDuplicateId ?? this.options.idSource.next('mixed-filament');
    const duplicate = createFullSpectrumMixedFilament(duplicateId, state.filaments.physical, draft);
    this.session.execute(new AddMixedFilamentCommand(duplicate));
    return duplicateId;
  }

  setVirtualFilamentEnabled(
    filamentId: MixedFilamentId,
    enabled: boolean,
    guard: CanonicalVirtualFilamentMutationGuard,
  ): void {
    const state = this.assertVirtualFilamentMutationGuard(guard);
    if (!state.filaments.mixed.some((filament) => filament.id === filamentId)) {
      throw new Error(`Unknown mixed filament ${filamentId}`);
    }
    this.session.execute(new SetMixedFilamentEnabledCommand(filamentId, enabled, 'virtual-filament-library'));
  }

  deleteVirtualFilament(
    filamentId: MixedFilamentId,
    guard: CanonicalVirtualFilamentMutationGuard,
  ): { readonly outcome: 'removed' | 'tombstoned'; readonly dependencyPaths: readonly string[] } {
    const state = this.assertVirtualFilamentMutationGuard(guard);
    const filament = state.filaments.mixed.find((candidate) => candidate.id === filamentId);
    if (!filament) throw new Error(`Unknown mixed filament ${filamentId}`);
    const dependencyPaths = findFilamentDependentPaths(state, filamentId);
    if (dependencyPaths.length > 0 || filament.fullSpectrum?.originAuto) {
      this.session.transaction('Delete mixed filament', () => {
        this.session.execute(
          new TombstoneMixedFilamentCommand(
            filamentId,
            dependencyPaths.length > 0 ? 'delete-with-canonical-dependencies' : 'delete-auto-pair',
          ),
        );
        if (filament.fullSpectrum?.originAuto) this.reconcileCurrentAutoPairs();
      });
      return { outcome: 'tombstoned', dependencyPaths: Object.freeze(dependencyPaths) };
    }
    this.session.execute(new RemoveMixedFilamentCommand(filamentId));
    return { outcome: 'removed', dependencyPaths: Object.freeze([]) };
  }

  addPlate(name?: string, options: { activate?: boolean } = {}): PlateId {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const id = this.options.idSource.next('plate');
    const plateName = boundedName(
      name,
      nextAvailableName(
        'Plate',
        state.plates.map((plate) => plate.name),
      ),
    );
    const order = Math.max(-1, ...state.plates.map((plate) => plate.order)) + 1;
    this.session.execute(
      new AddPlateCommand(
        {
          id,
          name: plateName,
          order,
          printable: true,
          config: {},
          objects: [],
        },
        options.activate ?? true,
      ),
    );
    return id;
  }

  /** Start a clean project while retaining the selected base profile and physical tools. */
  resetProject(): void {
    this.assertActive();
    const current = this.session.project.getSnapshot().state;
    const baseConfig = cloneJson(current.settingsBaseConfig ?? current.config);
    const next = createEmptyProject({
      idSource: this.options.idSource,
      now: readClock(this.options.clock),
      name: 'Untitled project',
      firstPlateName: 'Plate 1',
      toolCount: current.printer.toolCount,
    });
    next.printer = cloneJson(current.printer);
    next.settingsBaseConfig = baseConfig;
    next.settingsOverrides = {};
    next.config = cloneJson(baseConfig);
    next.filaments.physical = cloneJson(current.filaments.physical);
    next.filaments.mixed = [];
    this.session.reset(this.withReconciledAutoPairs(next));
  }

  /**
   * Duplicate one complete canonical plate graph in a single undo boundary.
   * Immutable assets remain shared while every independently editable entity
   * and every plate-scoped metadata row receives a freshly injected ID.
   */
  duplicatePlate(sourcePlateId: PlateId, expectedRevision?: number): PlateId {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    const state = this.session.project.getSnapshot().state;
    const source = findPlate(state, sourcePlateId);
    if (!source) throw new Error(`Unknown plate ${sourcePlateId}`);
    const plateId = this.options.idSource.next('plate');
    this.session.execute(
      new DuplicatePlateCommand(sourcePlateId, {
        plateId,
        objects: source.objects.map((object) => ({
          objectId: this.options.idSource.next('object'),
          volumeIds: object.volumes.map(() => this.options.idSource.next('volume')),
          instanceIds: object.instances.map(() => this.options.idSource.next('instance')),
          layerRangeIds: object.layerRanges.map(() => this.options.idSource.next('layer-range')),
        })),
        customGcodeIds: state.customGcode
          .filter((entry) => entry.scope === 'plate' && entry.plateId === sourcePlateId)
          .map(() => this.options.idSource.next('custom-gcode')),
        thumbnailIds: state.thumbnails
          .filter((thumbnail) => thumbnail.plateId === sourcePlateId)
          .map(() => this.options.idSource.next('thumbnail')),
      }),
    );
    return plateId;
  }

  deletePlate(plateId: PlateId, expectedRevision?: number): void {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    const state = this.session.project.getSnapshot().state;
    if (!findPlate(state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    if (state.plates.length <= 1) throw new Error('Cannot delete the last plate');
    this.session.execute(new DeletePlateCommand(plateId));
  }

  activatePlate(plateId: PlateId, expectedRevision?: number): void {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    const state = this.session.project.getSnapshot().state;
    if (!findPlate(state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    if (state.activePlateId === plateId) return;
    this.session.execute(new SetActivePlateCommand(plateId));
  }

  renamePlate(plateId: PlateId, name: string, expectedRevision?: number): void {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    if (!findPlate(this.session.project.getSnapshot().state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    this.session.execute(
      new RenamePlateCommand(plateId, requireBoundedText(name, 'Plate name', MAX_PLATE_NAME_LENGTH)),
    );
  }

  reorderPlates(orderedPlateIds: readonly PlateId[], expectedRevision?: number): void {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    this.session.execute(new ReorderPlatesCommand(orderedPlateIds));
  }

  setPlatePrintable(plateId: PlateId, printable: boolean, expectedRevision?: number): void {
    this.assertActive();
    this.assertPlateMutationRevision(expectedRevision);
    if (!findPlate(this.session.project.getSnapshot().state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    this.session.execute(new SetPlatePrintableCommand(plateId, printable));
  }

  /** Replace base project/profile config while preserving explicit project overrides. */
  setProjectConfig(config: ConfigMap): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const baseConfig = cloneJson(config);
    const effectiveConfig = applyProjectSettingsOverrides(baseConfig, state.settingsOverrides ?? {});
    if (
      canonicalStringify(state.settingsBaseConfig ?? state.config) === canonicalStringify(baseConfig) &&
      canonicalStringify(state.config) === canonicalStringify(effectiveConfig)
    ) {
      return;
    }
    const next = cloneProjectState(state);
    if (state.settingsBaseConfig !== undefined || state.settingsOverrides !== undefined) {
      next.settingsBaseConfig = baseConfig;
    }
    next.config = effectiveConfig;
    this.session.execute(new ReplaceProjectCommand(next, 'Update project configuration'));
  }

  /** Return a deeply frozen revision/hash-bound settings adapter snapshot. */
  getProjectSettingsOverrideSnapshot(): ProjectSettingsOverrideSnapshot {
    this.assertActive();
    return projectSettingsOverrideSnapshot(this.session.project.getSnapshot());
  }

  /** Atomically replace the explicit override map and its complete effective config. */
  setProjectSettingsOverrides(
    update: ProjectSettingsOverrideUpdate,
    guard: ProjectSettingsOverrideGuard,
  ): ProjectSettingsOverrideSnapshot {
    this.assertActive();
    const before = this.session.project.getSnapshot();
    if (before.revision !== guard.sourceRevision || before.hash !== guard.sourceHash) {
      throw new StaleProjectSettingsOverrideError();
    }
    this.session.execute(new SetProjectSettingsOverridesCommand(guard, update));
    return projectSettingsOverrideSnapshot(this.session.project.getSnapshot());
  }

  /**
   * One node's own overrides, the chain above it, and what the chain resolves
   * to (P6.5). Every scope answers the same question through this one call, so
   * no surface has to know that the project stores a base/override pair while
   * the other four store overrides alone.
   */
  getScopedOverrideSnapshot(target: ScopedOverrideTarget): ScopedOverrideSnapshot {
    this.assertActive();
    return scopedOverrideSnapshot(this.session.project.getSnapshot(), target);
  }

  /** Every node a scoped edit can address, in containment order. */
  listScopedOverrideTargets(): readonly ScopedOverrideTargetOption[] {
    this.assertActive();
    return scopedOverrideTargets(this.session.project.getSnapshot().state);
  }

  /** Replace one node's in-scope overrides as a single reversible command. */
  setScopedOverrides(
    target: ScopedOverrideTarget,
    overrides: Readonly<ConfigMap>,
    guard: ScopedOverrideGuard,
  ): ScopedOverrideSnapshot {
    this.assertActive();
    const before = this.session.project.getSnapshot();
    if (before.revision !== guard.sourceRevision || before.hash !== guard.sourceHash) {
      throw new StaleScopedOverrideError();
    }
    if (target.scope === 'project') {
      const update = projectScopeUpdate(before, overrides);
      this.session.execute(
        new SetProjectSettingsOverridesCommand(guard, {
          inheritedConfig: update.inheritedConfig,
          overrides: update.overrides,
        }),
      );
    } else {
      this.session.execute(new SetScopedOverridesCommand(guard, target, overrides));
    }
    return scopedOverrideSnapshot(this.session.project.getSnapshot(), target);
  }

  /**
   * Colour-painting service bound to this session's history and assets. The
   * caller owns input, cursors, and rendering; every facet mutation still
   * lands as one guarded canonical command.
   */
  createPaintStrokeService(): PaintStrokeService {
    this.assertActive();
    return new PaintStrokeService({ commands: this.session.commands, assets: this.assets });
  }

  /**
   * Smart Paint session over the same command bus and assets as manual
   * painting, so an assistant's mask commits through exactly one canonical
   * path and undoes as one entry.
   */
  createAiPaintSession(port: AiPaintPort): AiPaintSession {
    this.assertActive();
    return new AiPaintSession({
      commands: this.session.commands,
      assets: this.assets,
      strokes: this.createPaintStrokeService(),
      port,
    });
  }

  /** Palette projection for paint surfaces; entries carry stable IDs only. */
  getPaintPalette(options: PaintPaletteOptions = {}): PaintPalette {
    this.assertActive();
    return projectPaintPalette(this.session.project.getSnapshot().state, options);
  }

  /** Painted colour facets per volume, for derived overlays and legends. */
  getColorFacetsByVolume(plateId?: PlateId): ReadonlyMap<VolumeId, readonly TriangleAssignments<FilamentId>[]> {
    return this.getFacetsByVolume('color', plateId) as ReadonlyMap<
      VolumeId,
      readonly TriangleAssignments<FilamentId>[]
    >;
  }

  /** Painted facets of one channel per volume, for derived overlays. */
  getFacetsByVolume(
    channel: FacetAnnotationChannel,
    plateId?: PlateId,
  ): ReadonlyMap<VolumeId, readonly TriangleAssignments<JsonValue>[]> {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const facets = new Map<VolumeId, readonly TriangleAssignments<JsonValue>[]>();
    for (const plate of state.plates) {
      if (plateId && plate.id !== plateId) continue;
      for (const object of plate.objects) {
        for (const volume of object.volumes) {
          const assignments = volume.annotations[channel];
          if (assignments.length === 0) continue;
          facets.set(volume.id, cloneJson(assignments) as TriangleAssignments<JsonValue>[]);
        }
      }
    }
    return facets;
  }

  /** Sparse roots plus optional refined leaves for reopen-safe derived overlays. */
  getFacetOverlayByVolume(
    channel: FacetAnnotationChannel,
    plateId?: PlateId,
  ): ReadonlyMap<
    VolumeId,
    {
      readonly assignments: readonly TriangleAssignments<JsonValue>[];
      readonly refinement?: FacetRefinementEncoding;
      readonly topologyRevision: number;
      readonly triangleCount: number;
    }
  > {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const facets = new Map<
      VolumeId,
      {
        readonly assignments: readonly TriangleAssignments<JsonValue>[];
        readonly refinement?: FacetRefinementEncoding;
        readonly topologyRevision: number;
        readonly triangleCount: number;
      }
    >();
    for (const plate of state.plates) {
      if (plateId && plate.id !== plateId) continue;
      for (const object of plate.objects) {
        for (const volume of object.volumes) {
          const assignments = volume.annotations[channel] as TriangleAssignments<JsonValue>[];
          const refinement = volume.annotations.refinement?.[channel] as FacetRefinementEncoding | undefined;
          if (assignments.length === 0 && !refinement) continue;
          facets.set(volume.id, {
            assignments: cloneJson(assignments),
            ...(refinement ? { refinement: cloneJson(refinement) } : {}),
            topologyRevision: volume.source.topologyRevision,
            triangleCount: volume.source.triangleCount,
          });
        }
      }
    }
    return facets;
  }

  /** Return a caller-safe snapshot without exposing the canonical ProjectState. */
  getSlicingConfiguration(): CanonicalSlicingConfiguration {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    return deepFreeze(
      cloneJson({
        printer: state.printer,
        config: state.settingsBaseConfig ?? state.config,
        ...(state.settingsOverrides !== undefined ? { settingsOverrides: state.settingsOverrides } : {}),
        filaments: state.filaments,
      }),
    ) as CanonicalSlicingConfiguration;
  }

  /**
   * Apply a profile as one reversible command. Omitting settingsOverrides
   * preserves the canonical explicit map and overlays it on config; including
   * a complete map deliberately replaces it. Opening/importing never calls
   * this method. No bed shape is inferred from the render mapping.
   */
  setSlicingConfiguration(configuration: CanonicalSlicingConfiguration): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const submitsOverrides = Object.prototype.hasOwnProperty.call(configuration, 'settingsOverrides');
    if (submitsOverrides && configuration.settingsOverrides === undefined) {
      throw new Error('Submitted project setting overrides must be a complete JSON object');
    }
    const settingsOverrides = cloneJson(
      submitsOverrides ? configuration.settingsOverrides! : (state.settingsOverrides ?? {}),
    ) as ConfigMap;
    const baseConfig = cloneJson(configuration.config) as ConfigMap;
    const requested = {
      printer: cloneJson(configuration.printer) as ProjectState['printer'],
      baseConfig,
      config: applyProjectSettingsOverrides(baseConfig, settingsOverrides),
      settingsOverrides,
      filaments: {
        physical: cloneJson(configuration.filaments.physical) as PhysicalFilament[],
        mixed: cloneJson(configuration.filaments.mixed) as MixedFilament[],
      },
    };
    if (
      canonicalStringify({
        printer: state.printer,
        baseConfig: state.settingsBaseConfig ?? state.config,
        config: state.config,
        settingsOverrides: state.settingsOverrides ?? {},
        filaments: state.filaments,
      }) === canonicalStringify(requested)
    ) {
      return;
    }
    const next = cloneProjectState(state);
    next.printer = requested.printer;
    next.config = requested.config;
    if (submitsOverrides || state.settingsBaseConfig !== undefined || state.settingsOverrides !== undefined) {
      next.settingsBaseConfig = requested.baseConfig;
    }
    if (submitsOverrides) next.settingsOverrides = requested.settingsOverrides;
    next.filaments = requested.filaments;
    const reconciled = this.withReconciledAutoPairs(next);
    assertValidProjectState(reconciled);
    this.session.execute(new ReplaceProjectCommand(reconciled, 'Update slicing configuration'));
  }

  importBufferGeometry(
    geometry: THREE.BufferGeometry,
    options: ImportBufferGeometryOptions = {},
  ): ImportedCanonicalModel {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const plateId = options.plateId ?? state.activePlateId;
    const plate = findPlate(state, plateId);
    if (!plate) throw new Error(`Unknown plate ${plateId}`);
    const transform = cloneAndValidateTransform(options.transform ?? identityTransform());
    const mesh = extractTriangleMesh(geometry);
    const sourceFilename = boundedFilename(options.sourceFilename);
    const modelName = boundedName(
      options.name ?? geometry.name,
      nextAvailableName(
        'Model',
        plate.objects.map((object) => object.name),
      ),
    );
    const staged = encodeIndexedMeshAsset({
      id: STAGING_ASSET_ID,
      positions: mesh.positions,
      indices: mesh.indices,
    });
    const duplicate = findReusableMeshAsset(this.assets.list(), staged);
    const asset = duplicate
      ? reusableMeshAsset(duplicate, staged)
      : encodeIndexedMeshAsset({
          id: this.options.idSource.next('asset'),
          positions: mesh.positions,
          indices: mesh.indices,
          sourceFilename,
          provenance: { source: 'import', importedAt: readClock(this.options.clock) },
        });
    const objectId = this.options.idSource.next('object');
    const volumeId = this.options.idSource.next('volume');
    const instanceId = this.options.idSource.next('instance');
    const triangleCount = asset.descriptor.mesh?.triangleCount;
    if (triangleCount === undefined) throw new Error('Canonical mesh asset has no topology descriptor');
    const object: ProjectObject = {
      id: objectId,
      name: modelName,
      config: {},
      volumes: [
        {
          id: volumeId,
          name: modelName,
          role: 'model',
          source: {
            assetId: asset.descriptor.id,
            topologyRevision: 0,
            triangleCount,
          },
          transform: identityTransform(),
          config: {},
          annotations: emptyFacetAnnotations(),
        },
      ],
      instances: [
        {
          id: instanceId,
          name: modelName,
          transform,
          printable: true,
        },
      ],
      layerRanges: [],
    };
    this.session.execute(new AddObjectWithAssetCommand(plateId, object, asset));
    return Object.freeze({
      plateId,
      objectId,
      volumeId,
      instanceId,
      assetId: asset.descriptor.id,
      reusedAsset: Boolean(duplicate),
    });
  }

  /** Replace canonical selection with any independently selectable Objects-tree entities. */
  setObjectsTreeSelection(
    refs: readonly ObjectTreeEntityRef[],
    primary: ObjectTreeEntityRef | undefined = refs.at(-1),
  ): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    for (const ref of refs) assertObjectsTreeEntityExists(state, ref);
    if (primary) assertObjectsTreeEntityExists(state, primary);
    this.session.selection.set(
      refs.map((ref) => ({ ...ref })),
      primary ? { ...primary } : undefined,
    );
  }

  /** Compatibility alias for callers that treat the complete tree as the Objects selection. */
  setObjectSelection(
    refs: readonly ObjectTreeEntityRef[],
    primary: ObjectTreeEntityRef | undefined = refs.at(-1),
  ): void {
    this.setObjectsTreeSelection(refs, primary);
  }

  selectPlate(plateId: PlateId): void {
    this.setObjectsTreeSelection([{ kind: 'plate', id: plateId }]);
  }

  selectObject(objectId: ObjectId): void {
    this.setObjectsTreeSelection([{ kind: 'object', id: objectId }]);
  }

  selectVolume(volumeId: VolumeId): void {
    this.setObjectsTreeSelection([{ kind: 'volume', id: volumeId }]);
  }

  selectInstance(instanceId: InstanceId): void {
    this.setObjectsTreeSelection([{ kind: 'instance', id: instanceId }]);
  }

  selectLayerRange(layerRangeId: LayerRangeId): void {
    this.setObjectsTreeSelection([{ kind: 'layer-range', id: layerRangeId }]);
  }

  renameObject(objectId: ObjectId, name: string): void {
    this.assertActive();
    if (!findObject(this.session.project.getSnapshot().state, objectId)) throw new Error(`Unknown object ${objectId}`);
    this.session.execute(
      new RenameObjectCommand(objectId, requireBoundedText(name, 'Object name', MAX_UI_NAME_LENGTH)),
    );
  }

  renameVolume(volumeId: VolumeId, name: string): void {
    this.assertActive();
    if (!findVolume(this.session.project.getSnapshot().state, volumeId)) throw new Error(`Unknown volume ${volumeId}`);
    this.session.execute(
      new RenameVolumeCommand(volumeId, requireBoundedText(name, 'Volume name', MAX_UI_NAME_LENGTH)),
    );
  }

  clearSelection(): void {
    this.assertActive();
    this.session.selection.clear();
  }

  /**
   * Delete exactly one placement. Canonical objects may not be left with zero
   * placements, so deleting their final instance removes the owning object as
   * the same single history boundary.
   */
  deleteInstance(instanceId: InstanceId): CanonicalInstanceDeletionSummary {
    this.assertActive();
    const found = findInstance(this.session.project.getSnapshot().state, instanceId);
    if (!found) throw new Error(`Unknown instance ${instanceId}`);
    const objectId = found.object.id;
    const scope = found.object.instances.length === 1 ? 'object' : 'instance';
    this.session.execute(
      scope === 'object' ? new DeleteObjectCommand(objectId) : new DeleteInstanceCommand(instanceId),
    );
    return Object.freeze({ scope, instanceId, objectId }) as CanonicalInstanceDeletionSummary;
  }

  /** Delete the primary selected instance; ambiguous/non-instance selection is a no-op. */
  deleteSelectedInstance(): CanonicalInstanceDeletionSummary | undefined {
    this.assertActive();
    const primary = this.session.selection.getSnapshot().primary;
    return primary?.kind === 'instance' ? this.deleteInstance(primary.id) : undefined;
  }

  /** Duplicate only the primary selected placement, retaining its object and immutable assets. */
  duplicateSelectedInstance(): CanonicalInstanceDuplicationSummary | undefined {
    this.assertActive();
    const primary = this.session.selection.getSnapshot().primary;
    if (primary?.kind !== 'instance') return undefined;
    const found = findInstance(this.session.project.getSnapshot().state, primary.id);
    if (!found) throw new Error(`Unknown selected instance ${primary.id}`);
    const instanceId = this.options.idSource.next('instance');
    this.session.execute(
      new CreateInstanceCommand(found.object.id, {
        id: instanceId,
        ...(found.instance.name !== undefined ? { name: found.instance.name } : {}),
        transform: cloneAndValidateTransform(found.instance.transform),
        printable: found.instance.printable,
        ...(found.instance.extensionData ? { extensionData: cloneJson(found.instance.extensionData) } : {}),
      }),
    );
    const duplicate = this.getInstance(instanceId);
    if (!duplicate) throw new Error(`Duplicated instance ${instanceId} is missing`);
    return Object.freeze({ ...duplicate, sourceInstanceId: primary.id });
  }

  /**
   * Duplicate the independently editable object graph owning the primary
   * object/instance selection. Mesh assets remain shared and every editable
   * entity receives a fresh injected stable ID.
   */
  duplicateSelectedObject(): CanonicalObjectDuplicationSummary | undefined {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const primary = this.session.selection.getSnapshot().primary;
    const selected =
      primary?.kind === 'object'
        ? findObject(state, primary.id)
        : primary?.kind === 'instance'
          ? findInstance(state, primary.id)
          : undefined;
    if (!selected) return undefined;
    const sourceObject = selected.object;
    const objectId = this.options.idSource.next('object');
    const volumeIds = sourceObject.volumes.map(() => this.options.idSource.next('volume'));
    const instanceIds = sourceObject.instances.map(() => this.options.idSource.next('instance'));
    const layerRangeIds = sourceObject.layerRanges.map(() => this.options.idSource.next('layer-range'));
    this.session.execute(
      new DuplicateObjectCommand(sourceObject.id, {
        objectId,
        volumeIds,
        instanceIds,
        layerRangeIds,
      }),
    );
    const duplicated = findObject(this.session.project.getSnapshot().state, objectId);
    if (!duplicated) throw new Error(`Duplicated object ${objectId} is missing`);
    const primaryInstanceId = instanceIds[0];
    return Object.freeze({
      sourceObjectId: sourceObject.id,
      plateId: duplicated.plate.id,
      objectId,
      name: duplicated.object.name,
      volumeIds: Object.freeze([...volumeIds]),
      instanceIds: Object.freeze([...instanceIds]),
      layerRangeIds: Object.freeze([...layerRangeIds]),
      ...(primaryInstanceId ? { primaryInstanceId } : {}),
    });
  }

  /**
   * Capture the exact canonical object and every placement that a live
   * Split-to-Objects request will replace. The returned guard must be reviewed
   * by a composition-root confirmation surface and submitted unchanged.
   */
  getSplitToObjectsConfirmation(): CanonicalSplitToObjectsConfirmation {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const selection = this.session.selection.getSnapshot();
    const primary = selection.primary;
    if (primary?.kind !== 'instance') {
      throw new Error('Split to Objects requires a primary selected model instance');
    }
    const found = findInstance(project.state, primary.id);
    if (!found) throw new Error(`Selected instance ${primary.id} is no longer in the canonical project`);
    assertSplitToObjectsSource(found.object, this.splitToObjectsSynchronousTriangleLimit);
    const strategy = found.object.volumes.length > 1 ? 'existing-volumes' : 'connected-components';
    return deepFreeze({
      guard: {
        expectedRevision: project.revision,
        sourceHash: project.hash,
        selectionFingerprint: canonicalStringify(selection),
        plateId: found.plate.id,
        objectId: found.object.id,
        primaryInstanceId: primary.id,
      },
      objectName: found.object.name,
      strategy,
      volumeCount: found.object.volumes.length,
      triangleCount: found.object.volumes.reduce((total, volume) => total + volume.source.triangleCount, 0),
      affectedInstanceIds: found.object.instances.map((instance) => instance.id),
    });
  }

  /**
   * Commit the previously confirmed scope as one undo boundary.
   *
   * Existing multi-volume objects take the metadata-only promotion path.
   * Single-volume objects first stage bounded shared-edge connectivity and
   * immutable component assets without mutation, then atomically install and
   * promote them through the pinned command transaction.
   */
  splitSelectedToObjects(guard: CanonicalSplitToObjectsGuard): CanonicalSplitToObjectsResult {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const selection = this.session.selection.getSnapshot();
    if (
      !Number.isSafeInteger(guard.expectedRevision) ||
      guard.expectedRevision < 0 ||
      project.revision !== guard.expectedRevision ||
      project.hash !== guard.sourceHash ||
      canonicalStringify(selection) !== guard.selectionFingerprint
    ) {
      throw new StaleCanonicalSplitToObjectsError();
    }
    const primary = selection.primary;
    if (primary?.kind !== 'instance' || primary.id !== guard.primaryInstanceId) {
      throw new StaleCanonicalSplitToObjectsError();
    }
    const found = findInstance(project.state, primary.id);
    if (!found || found.plate.id !== guard.plateId || found.object.id !== guard.objectId) {
      throw new StaleCanonicalSplitToObjectsError();
    }
    const sourceObject = found.object;
    assertSplitToObjectsSource(sourceObject, this.splitToObjectsSynchronousTriangleLimit);

    if (sourceObject.volumes.length > 1) {
      const identities = this.allocateSeparatedObjectIdentities(
        sourceObject.volumes.map((volume) => volume.id),
        sourceObject.instances.length,
      );
      this.session.execute(
        new SeparateObjectVolumesCommand(
          captureObjectVolumeSeparationGuard(project.state, sourceObject.id),
          identities,
        ),
        { coalesce: false },
      );
      return splitToObjectsResult(sourceObject.id, 'existing-volumes', identities, []);
    }

    const sourceVolume = sourceObject.volumes[0];
    const sourceDescriptors = project.state.sourceAssets.filter(
      (descriptor) => descriptor.id === sourceVolume.source.assetId,
    );
    if (sourceDescriptors.length !== 1) {
      throw new Error(`Split source asset ${sourceVolume.source.assetId} is not declared exactly once`);
    }
    const sourceAsset = this.assets.get(sourceVolume.source.assetId);
    if (!sourceAsset) throw new Error(`Split source asset ${sourceVolume.source.assetId} is missing`);
    if (canonicalStringify(sourceAsset.descriptor) !== canonicalStringify(sourceDescriptors[0])) {
      throw new Error(`Split source asset ${sourceVolume.source.assetId} differs from its canonical descriptor`);
    }

    const volumeGuard = captureVolumeSplitGuard(project.state, sourceVolume.id);
    const generatedAssetIds = new Map<string, AssetId>();
    const stagedParts = prepareVolumeSplitParts({
      sourceAsset,
      sourceTransform: sourceVolume.transform,
      idsForPart: ({ geometryDigest }) => {
        let assetId = generatedAssetIds.get(geometryDigest);
        if (!assetId) {
          assetId = this.options.idSource.next('asset');
          generatedAssetIds.set(geometryDigest, assetId);
        }
        return {
          volumeId: this.options.idSource.next('volume'),
          assetId,
        };
      },
    });

    // A project may already own the exact immutable component bytes. Reuse
    // that canonical payload rather than letting the commit reject a duplicate
    // digest; ordinary outputs still retain their freshly injected asset IDs.
    const reusableAssets = new Map<string, AssetPayload>();
    for (const descriptor of project.state.sourceAssets) {
      if (descriptor.id === sourceVolume.source.assetId || reusableAssets.has(descriptor.digest)) continue;
      const payload = this.assets.get(descriptor.id);
      if (payload && canonicalStringify(payload.descriptor) === canonicalStringify(descriptor)) {
        reusableAssets.set(descriptor.digest, payload);
      }
    }
    const parts = stagedParts.map((part) => {
      const reusable = reusableAssets.get(part.asset.descriptor.digest);
      return reusable ? { ...part, asset: reusable } : part;
    });
    const refreshed = this.session.project.getSnapshot();
    if (
      refreshed.revision !== guard.expectedRevision ||
      refreshed.hash !== guard.sourceHash ||
      canonicalStringify(this.session.selection.getSnapshot()) !== guard.selectionFingerprint
    ) {
      throw new StaleCanonicalSplitToObjectsError();
    }
    const identities = this.allocateSeparatedObjectIdentities(
      parts.map((part) => part.volumeId),
      sourceObject.instances.length,
    );
    commitPreparedVolumeSplitToObjects(this.session.commands, volumeGuard, parts, identities);
    return splitToObjectsResult(sourceObject.id, 'connected-components', identities, parts);
  }

  private allocateSeparatedObjectIdentities(
    volumeIds: readonly VolumeId[],
    instanceCount: number,
  ): SeparatedObjectIdentity[] {
    return volumeIds.map((sourceVolumeId) => ({
      sourceVolumeId,
      objectId: this.options.idSource.next('object'),
      instanceIds: Array.from({ length: instanceCount }, () => this.options.idSource.next('instance')),
    }));
  }

  setInstanceTransform(instanceId: InstanceId, transform: Transform, gestureId?: string): void {
    this.assertActive();
    if (!findInstance(this.session.project.getSnapshot().state, instanceId)) {
      throw new Error(`Unknown instance ${instanceId}`);
    }
    this.transformSequence += 1;
    const boundedGestureId = gestureId
      ? requireBoundedText(gestureId, 'Transform gesture ID', MAX_GESTURE_ID_LENGTH)
      : `single:${this.transformSequence}`;
    this.session.execute(
      new SetInstanceTransformCommand(instanceId, cloneAndValidateTransform(transform), boundedGestureId),
    );
  }

  /** Transform an exact stable-ID instance set as one coalescible history boundary. */
  setInstanceTransforms(changes: readonly InstanceTransformChange[], gestureId?: string): void {
    this.assertActive();
    if (changes.length === 0) throw new Error('A batch transform requires at least one instance');
    const state = this.session.project.getSnapshot().state;
    const prepared = changes.map((change) => {
      if (!findInstance(state, change.instanceId)) throw new Error(`Unknown instance ${change.instanceId}`);
      return {
        instanceId: change.instanceId,
        transform: cloneAndValidateTransform(change.transform),
      };
    });
    this.transformSequence += 1;
    const boundedGestureId = gestureId
      ? requireBoundedText(gestureId, 'Transform gesture ID', MAX_GESTURE_ID_LENGTH)
      : `batch:${this.transformSequence}`;
    this.session.execute(new SetInstanceTransformsCommand(prepared, boundedGestureId));
  }

  /**
   * Match pinned Selection::ensure_on_bed: derive each selected instance's
   * model-part minimum Z from canonical mesh bytes and translate every
   * instance independently to Z=0 in one reversible history boundary.
   */
  dropInstancesToBed(instanceIds: readonly InstanceId[]): CanonicalDropToBedResult {
    this.assertActive();
    if (instanceIds.length === 0) throw new Error('Drop to bed requires at least one instance');
    const state = this.session.project.getSnapshot().state;
    const seen = new Set<InstanceId>();
    const results: Array<CanonicalDropToBedResult['instances'][number]> = [];
    const changes: InstanceTransformChange[] = [];
    for (const instanceId of instanceIds) {
      if (seen.has(instanceId)) throw new Error(`Drop to bed contains duplicate instance ${instanceId}`);
      seen.add(instanceId);
      const found = findInstance(state, instanceId);
      if (!found) throw new Error(`Unknown instance ${instanceId}`);
      const bounds = computeCanonicalInstanceBounds(state, this.assets, [instanceId], {
        volumeRoles: ['model'],
      });
      const minZBeforeMm = bounds.min[2];
      const deltaZMm = minZBeforeMm === 0 ? 0 : -minZBeforeMm;
      results.push(Object.freeze({ instanceId, minZBeforeMm, deltaZMm }));
      changes.push({
        instanceId,
        transform: {
          ...found.instance.transform,
          translationMm: [
            found.instance.transform.translationMm[0],
            found.instance.transform.translationMm[1],
            found.instance.transform.translationMm[2] + deltaZMm,
          ],
        },
      });
    }
    this.setInstanceTransforms(changes);
    return Object.freeze({ instances: Object.freeze(results) });
  }

  /**
   * Arrange one plate's printable instances as a single reversible command.
   * Placement comes from canonical bounds, so locked instances, exclusion
   * zones, and the printable area are honoured without reading the scene.
   */
  arrangePlate(plateId: PlateId, constraints: ArrangeConstraints): ArrangeResult {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const result = planPlateArrangement(state, this.assets, plateId, constraints);
    const changes = arrangementTransformChanges(result);
    if (changes.length > 0) this.setInstanceTransforms(changes, `arrange:${plateId}`);
    return result;
  }

  /**
   * Fill the plate's free space with shared copies of one instance in a single
   * undoable transaction. Existing instances never move, and the copy cap is
   * reported so the surface can explain a partial fill.
   */
  fillPlateWithInstances(
    instanceId: InstanceId,
    constraints: ArrangeConstraints,
    maxNewInstances?: number,
  ): { created: number; withheld: number } {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const found = findInstance(state, instanceId);
    if (!found) throw new Error(`Unknown instance ${instanceId}`);
    const plate = state.plates.find((candidate) => candidate.objects.some((object) => object.id === found.object.id));
    if (!plate) throw new Error(`Instance ${instanceId} has no owning plate`);
    const plan = planBedFill(
      state,
      this.assets,
      plate.id,
      { instanceId, ...(maxNewInstances !== undefined ? { maxNewInstances } : {}) },
      constraints,
    );
    if (plan.placements.length === 0) return { created: 0, withheld: plan.withheldSlotCount };
    createInstancesAtTransforms(
      this.session.commands,
      found.object.id,
      plan.placements.map((placement) => ({
        id: this.options.idSource.next('instance'),
        transform: placement.transform,
        printable: found.instance.printable,
        ...(found.instance.name !== undefined ? { name: found.instance.name } : {}),
      })),
    );
    return { created: plan.placements.length, withheld: plan.withheldSlotCount };
  }

  /** Canonical transform of one instance, for read-only surfaces. */
  getInstanceTransform(instanceId: InstanceId): Transform | undefined {
    this.assertActive();
    const found = findInstance(this.session.project.getSnapshot().state, instanceId);
    return found ? cloneJson(found.instance.transform) : undefined;
  }

  /**
   * Immutable decoded mesh of one volume, for read-only geometry tools such as
   * measurement. It never caches into canonical state.
   */
  getVolumeMesh(volumeId: VolumeId): FacetSelectionMesh | undefined {
    this.assertActive();
    const found = findVolume(this.session.project.getSnapshot().state, volumeId);
    if (!found) return undefined;
    const payload = this.assets.get(found.volume.source.assetId);
    if (!payload) return undefined;
    const decoded = decodeIndexedMeshAsset(payload);
    return { vertices: decoded.vertices, triangles: decoded.triangles };
  }

  /**
   * Decimate one volume and install the result through the guarded topology
   * command, so the whole change — new mesh, invalidated facet channels, asset
   * ownership — is one undoable entry. Staging happens before the command runs,
   * and a cancelled or failed run never touches canonical state.
   */
  simplifyVolume(
    volumeId: VolumeId,
    configuration: SimplifyConfiguration = DEFAULT_SIMPLIFY_CONFIGURATION,
    options: SimplifyOptions = {},
  ): { readonly beforeTriangles: number; readonly afterTriangles: number; readonly maxError: number } {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const found = findVolume(state, volumeId);
    if (!found) throw new Error(`Unknown volume ${volumeId}`);
    const payload = this.assets.get(found.volume.source.assetId);
    if (!payload) throw new Error(`Volume ${volumeId} has no stored mesh asset`);

    const guard: MeshTopologyReplacementGuard = {
      volumeId,
      assetId: found.volume.source.assetId,
      assetDigest: payload.descriptor.digest,
      topologyRevision: found.volume.source.topologyRevision,
      triangleCount: found.volume.source.triangleCount,
    };
    const decoded = decodeIndexedMeshAsset(payload);
    const simplified = simplifyMesh(
      { vertices: decoded.vertices, triangles: decoded.triangles },
      configuration,
      options,
    );
    if (simplified.triangles.length >= simplified.sourceTriangleCount) {
      return {
        beforeTriangles: simplified.sourceTriangleCount,
        afterTriangles: simplified.sourceTriangleCount,
        maxError: 0,
      };
    }

    const positions: number[] = [];
    for (const vertex of simplified.vertices) positions.push(vertex[0], vertex[1], vertex[2]);
    const indices: number[] = [];
    for (const triangle of simplified.triangles) indices.push(triangle[0], triangle[1], triangle[2]);
    const encoded = encodeIndexedMeshAsset({
      id: this.options.idSource.next('asset'),
      positions,
      indices,
      ...(payload.descriptor.sourceFilename ? { sourceFilename: payload.descriptor.sourceFilename } : {}),
    });
    this.session.commands.execute(new ReplaceVolumeMeshCommand(guard, encoded));
    return {
      beforeTriangles: simplified.sourceTriangleCount,
      afterTriangles: simplified.triangles.length,
      maxError: simplified.maxAppliedError,
    };
  }

  /**
   * Adopt the filaments a connected printer reports as loaded, as one undoable
   * command. Returns which tools changed and which reported slots had no
   * canonical tool, so the caller can report both honestly.
   */
  syncPhysicalFilamentsFromPrinter(slots: readonly PrinterFilamentSlotFacts[]): PrinterFilamentSyncSummary {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    // The id source is what lets a reported slot with no canonical tool be
    // adopted rather than merely counted.
    const summary = SyncPhysicalFilamentsFromPrinterCommand.describe(state, slots, true);
    if (summary.applied.length > 0 || summary.added.length > 0) {
      this.session.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(slots, this.options.idSource));
    }
    return summary;
  }

  /** Place one brim ear in object-local millimetres, as one undoable command. */
  addBrimEar(objectId: ObjectId, point: BrimEarPoint): void {
    this.assertActive();
    this.session.commands.execute(new AddBrimEarCommand(objectId, point));
  }

  removeBrimEar(objectId: ObjectId, index: number): void {
    this.assertActive();
    this.session.commands.execute(new RemoveBrimEarCommand(objectId, index));
  }

  clearBrimEars(objectId: ObjectId): void {
    this.assertActive();
    this.session.commands.execute(new ClearBrimEarsCommand(objectId));
  }

  /** Ears currently placed on one object, for a readout or an overlay. */
  getBrimEars(objectId: ObjectId): readonly BrimEarPoint[] {
    this.assertActive();
    for (const plate of this.session.project.getSnapshot().state.plates) {
      const object = plate.objects.find((candidate) => candidate.id === objectId);
      if (object) return cloneJson(object.brimEars ?? []);
    }
    return [];
  }

  /**
   * Cut embossed text and add it to an object, as one undoable command.
   *
   * The font is a `GlyphOutlineSource` the caller supplies, because a browser
   * cannot enumerate installed fonts and the app CSP forbids fetching one.
   */
  addEmbossText(
    objectId: ObjectId,
    configuration: EmbossTextConfiguration,
    font: GlyphOutlineSource,
    transform: Transform = identityTransform(),
  ): { volumeId: VolumeId; mesh: EmbossedMesh } {
    this.assertActive();
    const identity = embossVolumeIdentity(this.options.idSource);
    const prepared = prepareEmbossedVolume(configuration, font, identity.assetId);
    this.session.commands.execute(
      new AddEmbossTextCommand(
        { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform },
        configuration,
        prepared,
      ),
    );
    return { volumeId: identity.volumeId, mesh: prepared.mesh };
  }

  /** Re-cut an existing embossed volume from an edited recipe. */
  editEmbossText(volumeId: VolumeId, configuration: EmbossTextConfiguration, font: GlyphOutlineSource): EmbossedMesh {
    this.assertActive();
    const prepared = prepareEmbossedVolume(configuration, font, embossVolumeIdentity(this.options.idSource).assetId);
    this.session.commands.execute(new EditEmbossTextCommand(volumeId, configuration, prepared));
    return prepared.mesh;
  }

  /**
   * Cut a drawing into a part and add it, as one undoable command.
   *
   * The SVG's own bytes are returned so the caller can keep them beside the
   * project; without them a reopened part could be re-placed but never re-cut.
   */
  addSvgPart(
    objectId: ObjectId,
    source: string,
    options: {
      readonly fileName: string;
      readonly depthMm: number;
      readonly widthMm?: number;
      readonly sourcePath?: string;
    },
    transform: Transform = identityTransform(),
  ): { volumeId: VolumeId; prepared: PreparedSvgPart } {
    this.assertActive();
    const identity = svgVolumeIdentity(this.options.idSource);
    const prepared = prepareSvgPart(source, {
      ...options,
      volumeId: identity.volumeId,
      assetId: identity.assetId,
      drawingAssetId: identity.drawingAssetId,
    });
    const name = options.fileName.replace(/\.svg$/i, '') || 'SVG part';
    this.session.commands.execute(
      new AddSvgPartCommand(
        { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform },
        prepared,
        name,
      ),
    );
    return { volumeId: identity.volumeId, prepared };
  }

  /** Re-cut an existing SVG part from changed width or depth. */
  editSvgPart(
    volumeId: VolumeId,
    source: string,
    options: {
      readonly fileName: string;
      readonly depthMm: number;
      readonly widthMm?: number;
      readonly sourcePath?: string;
    },
  ): PreparedSvgPart {
    this.assertActive();
    const next = svgVolumeIdentity(this.options.idSource);
    const prepared = prepareSvgPart(source, {
      ...options,
      volumeId,
      assetId: next.assetId,
      drawingAssetId: next.drawingAssetId,
    });
    this.session.commands.execute(new EditSvgPartCommand(volumeId, prepared));
    return prepared;
  }

  /**
   * The project's shape for a diagnostics bundle: counts and names, never
   * geometry. Lives here because the controller owns canonical state, and a
   * support bundle must not become a reason to expose it more widely.
   */
  diagnosticsProjectSummary(): {
    plateCount: number;
    objectCount: number;
    volumeCount: number;
    triangleCount: number;
    physicalFilamentCount: number;
    mixedFilamentCount: number;
    paintedVolumeCount: number;
    objectNames: string[];
  } {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const objects = state.plates.flatMap((plate) => plate.objects);
    const volumes = objects.flatMap((object) => object.volumes);
    return {
      plateCount: state.plates.length,
      objectCount: objects.length,
      volumeCount: volumes.length,
      triangleCount: volumes.reduce((total, volume) => total + volume.source.triangleCount, 0),
      physicalFilamentCount: state.filaments.physical.length,
      mixedFilamentCount: state.filaments.mixed.length,
      paintedVolumeCount: volumes.filter((volume) => volume.annotations.color.length > 0).length,
      objectNames: objects.map((object) => object.name),
    };
  }

  /** The drawing parameters on one volume, when it is an SVG part. */
  getSvgPart(volumeId: VolumeId): EmbossSvgPart | undefined {
    this.assertActive();
    const found = findVolume(this.session.project.getSnapshot().state, volumeId);
    return found?.volume.embossSvg ? cloneJson(found.volume.embossSvg) : undefined;
  }

  /** The recipe on one volume, when it is embossed text. */
  getEmbossText(volumeId: VolumeId): EmbossTextConfiguration | undefined {
    this.assertActive();
    const found = findVolume(this.session.project.getSnapshot().state, volumeId);
    return found?.volume.embossText ? cloneJson(found.volume.embossText) : undefined;
  }

  /** Canonical transform of one volume, for surfaces that resolve facet data. */
  getVolumeTransform(volumeId: VolumeId): Transform | undefined {
    this.assertActive();
    const found = findVolume(this.session.project.getSnapshot().state, volumeId);
    return found ? cloneJson(found.volume.transform) : undefined;
  }

  /** Mirror an exact instance selection across one axis in one command. */
  mirrorInstances(instanceIds: readonly InstanceId[], axis: MirrorAxis): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    this.setInstanceTransforms(mirrorInstances(state, instanceIds, axis), `mirror:${axis}`);
  }

  /** Clear rotation, scale, or both for an exact instance selection. */
  resetInstanceTransforms(instanceIds: readonly InstanceId[], target: 'rotation' | 'scale' | 'both'): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    const changes =
      target === 'rotation'
        ? resetInstanceRotations(state, instanceIds)
        : target === 'scale'
          ? resetInstanceScales(state, instanceIds)
          : mergeChanges(resetInstanceRotations(state, instanceIds), resetInstanceScales(state, instanceIds));
    this.setInstanceTransforms(changes, `reset:${target}`);
  }

  /** Centre an exact instance selection on the printable area. */
  centerInstancesOnPlate(instanceIds: readonly InstanceId[], bedSizeMm: readonly [number, number]): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    this.setInstanceTransforms(centerInstancesOnPlate(state, this.assets, instanceIds, bedSizeMm), 'center');
  }

  /** Rotate one instance so a chosen facet rests on the bed. */
  layInstanceOnFace(instanceId: InstanceId, localNormal: Vec3): void {
    this.assertActive();
    const state = this.session.project.getSnapshot().state;
    this.setInstanceTransforms(layInstanceOnFace(state, this.assets, { instanceId, localNormal }), 'lay-on-face');
  }

  undo(): boolean {
    this.assertActive();
    return this.session.undo();
  }

  redo(): boolean {
    this.assertActive();
    return this.session.redo();
  }

  /** Merge exact canonical instances into a caller-owned binary STL artifact. */
  exportCanonicalStl(instanceIds: readonly InstanceId[]): CanonicalStlExport {
    this.assertActive();
    const project = this.session.project.getSnapshot();
    const exported = exportCanonicalInstancesAsBinaryStl(project.state, this.assets, instanceIds);
    const single = instanceIds.length === 1 ? findInstance(project.state, instanceIds[0]) : undefined;
    return Object.freeze({
      bytes: exported.bytes,
      mediaType: 'model/stl',
      suggestedFilename: suggestedStlFilename(single?.instance.name ?? single?.object.name ?? project.state.name),
      sourceRevision: project.revision,
      sourceHash: project.hash,
      triangleCount: exported.triangleCount,
      instanceCount: exported.instanceCount,
    });
  }

  saveCanonical3mf(cancellation?: CancellationToken): Promise<SerializedProject> {
    this.assertActive();
    return this.session.save(cancellation);
  }

  openCanonical3mf(bytes: Uint8Array, cancellation?: CancellationToken): Promise<string[]> {
    this.assertActive();
    return this.session.open(bytes, cancellation);
  }

  /** Worker parse -> immutable preview -> explicit one-command replace. */
  async prepareCanonical3mfImport(
    bytes: Uint8Array,
    source: ProjectImportSource,
    cancellation?: CancellationToken,
  ): Promise<PreparedProjectImport> {
    this.assertActive();
    const lifecycle = new ImportCancellationController();
    this.importCancellations.add(lifecycle);
    try {
      const prepared = await this.importCoordinator.prepare(
        {
          bytes,
          source,
          mode: 'replace',
          cancellation: combinedCancellation(lifecycle.token, cancellation),
        },
        () => this.importCancellations.delete(lifecycle),
      );
      if (this.disposed) {
        prepared.cancel('canonical workspace disposed');
        throw new Error('CanonicalWorkspaceController is disposed');
      }
      // Keep the lifecycle token while the immutable preview is live. Its
      // confirm/cancel settlement releases the token; disposal still aborts
      // every genuinely outstanding preview.
      return prepared;
    } catch (error) {
      this.importCancellations.delete(lifecycle);
      throw error;
    }
  }

  /**
   * Decode an STL/OBJ/AMF/ZIP model source and stage it as a merge import.
   * The same transactional preview/confirm contract as project import applies,
   * so a cancelled or malformed model never mutates canonical state, and the
   * commit remains one undoable command.
   */
  async prepareModelImport(
    bytes: Uint8Array,
    source: ProjectImportSource,
    options: { placement?: ModelImportPlacement; cancellation?: CancellationToken } = {},
  ): Promise<PreparedProjectImport> {
    this.assertActive();
    const lifecycle = new ImportCancellationController();
    this.importCancellations.add(lifecycle);
    const parser = new ModelImportParser({
      idSource: this.options.idSource,
      clock: () => readClock(this.options.clock),
      placement: options.placement,
    });
    const coordinator = new ProjectImportCoordinator({
      parser: {
        parse: async (request) => {
          const parsed = await parser.parse(request);
          return { ...parsed, state: this.withReconciledAutoPairs(parsed.state) };
        },
      },
      commands: this.session.commands,
      now: () => readClock(this.options.clock),
    });
    try {
      const prepared = await coordinator.prepare(
        {
          bytes,
          source,
          mode: 'merge',
          cancellation: combinedCancellation(lifecycle.token, options.cancellation),
        },
        () => this.importCancellations.delete(lifecycle),
      );
      if (this.disposed) {
        prepared.cancel('canonical workspace disposed');
        throw new Error('CanonicalWorkspaceController is disposed');
      }
      return prepared;
    } catch (error) {
      this.importCancellations.delete(lifecycle);
      throw error;
    }
  }

  /**
   * Stage a 3MF's geometry as a merge import: its objects join the open
   * project while plates, settings, filaments, and custom G-code are reported
   * as deliberately dropped. Same transactional preview/confirm contract.
   */
  async prepareGeometryImport(
    bytes: Uint8Array,
    source: ProjectImportSource,
    options: { bedSizeMm?: readonly [number, number]; cancellation?: CancellationToken } = {},
  ): Promise<PreparedProjectImport> {
    this.assertActive();
    const lifecycle = new ImportCancellationController();
    this.importCancellations.add(lifecycle);
    const parser = new GeometryMergeParser({
      idSource: this.options.idSource,
      clock: () => readClock(this.options.clock),
      ...(options.bedSizeMm ? { bedSizeMm: options.bedSizeMm } : {}),
    });
    const coordinator = new ProjectImportCoordinator({
      parser: {
        parse: async (request) => {
          const parsed = await parser.parse(request);
          return { ...parsed, state: this.withReconciledAutoPairs(parsed.state) };
        },
      },
      commands: this.session.commands,
      now: () => readClock(this.options.clock),
    });
    try {
      const prepared = await coordinator.prepare(
        {
          bytes,
          source,
          mode: 'merge',
          cancellation: combinedCancellation(lifecycle.token, options.cancellation),
        },
        () => this.importCancellations.delete(lifecycle),
      );
      if (this.disposed) {
        prepared.cancel('canonical workspace disposed');
        throw new Error('CanonicalWorkspaceController is disposed');
      }
      return prepared;
    } catch (error) {
      this.importCancellations.delete(lifecycle);
      throw error;
    }
  }

  /**
   * Exposes only the immutable canonical snapshot/guard needed by the slice
   * coordinator. A failed Three projection invalidates both capture and every
   * in-flight freshness check, so invisible render drift cannot publish G-code.
   */
  createCanonicalSliceSource(): CanonicalProjectSliceSourcePort {
    this.assertActive();
    const source = new StoreProjectSliceSource(this.session.project, this.assets);
    return Object.freeze({
      capture: () => {
        this.assertActive();
        const health = this.session.getProjectionHealthSnapshot();
        if (!health.healthy) throw new UnhealthyProjectProjectionError('slice', health);
        return source.capture();
      },
      isCurrent: (guard: CanonicalProjectSliceGuard) => {
        if (this.disposed || !this.session.getProjectionHealthSnapshot().healthy) return false;
        return source.isCurrent(guard);
      },
    });
  }

  setPrinterSpaceMapping(mapping: ThreePrinterSpaceMapping): void {
    this.assertActive();
    this.surface.setPrinterSpaceMapping(mapping);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancellation of this.importCancellations) cancellation.cancel('canonical workspace disposed');
    this.importCancellations.clear();
    for (const unsubscribe of this.sourceUnsubscribers.splice(0)) unsubscribe();
    this.pendingChangeSources.clear();
    this.subscribers.clear();
    this.session.dispose();
  }

  private reconcileCurrentAutoPairs(): FullSpectrumAutoPairReconciliation | undefined {
    const current = this.session.project.getSnapshot();
    if (!this.autoPairGenerationAllowed(current.state.filaments.physical.length)) return undefined;
    const reconciliation = this.reconcileAutoPairFilaments(
      current.state.filaments.physical,
      current.state.filaments.mixed,
    );
    if (reconciliation.changed) {
      this.session.execute(
        new ReconcileFullSpectrumAutoPairsCommand(
          { expectedRevision: current.revision, sourceHash: current.hash },
          reconciliation.filaments,
        ),
        { coalesce: false },
      );
    }
    return reconciliation;
  }

  private reconcileAutoPairFilaments(
    physical: readonly PhysicalFilament[],
    mixed: readonly MixedFilament[],
  ): FullSpectrumAutoPairReconciliation {
    return reconcileFullSpectrumAutoPairFilaments(
      physical,
      mixed,
      allocateFullSpectrumAutoPairIdentity(
        () => this.options.idSource.next('mixed-filament'),
        fullSpectrumStableNumericId,
      ),
    );
  }

  private withReconciledAutoPairs(state: ProjectState): ProjectState {
    if (!this.autoPairGenerationAllowed(state.filaments.physical.length)) return state;
    const reconciliation = this.reconcileAutoPairFilaments(state.filaments.physical, state.filaments.mixed);
    if (!reconciliation.changed) return state;
    const next = cloneProjectState(state);
    next.filaments.mixed = reconciliation.filaments.map((filament) => cloneJson(filament));
    assertValidProjectState(next);
    return next;
  }

  private autoPairGenerationAllowed(physicalCount: number): boolean {
    return this.autoPairGenerationEnabled && !this.autoPairConfirmationRequired(physicalCount);
  }

  private autoPairConfirmationRequired(physicalCount: number): boolean {
    return physicalCount > 4 && !this.confirmedAutoPairPhysicalCounts.has(physicalCount);
  }

  private reconcilingSerializer(serializer: ProjectSerializerPort): ProjectSerializerPort {
    return {
      serialize: (snapshot, cancellation) => serializer.serialize(snapshot, cancellation),
      deserialize: async (bytes, cancellation) => {
        const parsed = await serializer.deserialize(bytes, cancellation);
        return { ...parsed, state: this.withReconciledAutoPairs(parsed.state) };
      },
    };
  }

  private scheduleChange(source: Exclude<CanonicalWorkspaceChangeSource, 'initial'>): void {
    if (this.disposed) return;
    this.pendingChangeSources.add(source);
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => this.publishPendingChange());
  }

  private publishPendingChange(): void {
    this.notificationScheduled = false;
    if (this.disposed || this.pendingChangeSources.size === 0) return;
    const sources = Object.freeze([...this.pendingChangeSources]);
    this.pendingChangeSources.clear();
    const previous = this.lastPublishedSummary;
    const current = this.buildSummary();
    this.lastPublishedSummary = current;
    const change: CanonicalWorkspaceChange = Object.freeze({ current, previous, sources });
    for (const subscriber of [...this.subscribers]) safelyNotify(subscriber, change);
  }

  private assertSemanticObjectMutationGuard(guard: CanonicalSemanticObjectMutationGuard): ProjectState {
    if (!Number.isSafeInteger(guard.expectedRevision) || guard.expectedRevision < 0) {
      throw new Error('Expected semantic-object revision must be a non-negative safe integer');
    }
    if (!guard.sourceHash.trim()) throw new Error('Semantic-object source hash cannot be empty');
    const project = this.session.project.getSnapshot();
    if (project.revision !== guard.expectedRevision || project.hash !== guard.sourceHash) {
      throw new StaleCanonicalSemanticObjectMutationError();
    }
    if (!findObject(project.state, guard.objectId)) throw new Error(`Unknown object ${guard.objectId}`);
    return project.state;
  }

  private assertVirtualFilamentMutationGuard(guard: CanonicalVirtualFilamentMutationGuard): ProjectState {
    if (!Number.isSafeInteger(guard.expectedRevision) || guard.expectedRevision < 0) {
      throw new Error('Expected virtual-filament revision must be a non-negative safe integer');
    }
    if (!guard.sourceHash.trim()) throw new Error('Virtual-filament source hash cannot be empty');
    const project = this.session.project.getSnapshot();
    if (project.revision !== guard.expectedRevision || project.hash !== guard.sourceHash) {
      throw new StaleCanonicalVirtualFilamentMutationError();
    }
    return project.state;
  }

  private assertPlateMutationRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Expected plate revision must be a non-negative safe integer');
    }
    if (this.session.project.getSnapshot().revision !== expectedRevision) {
      throw new StaleCanonicalPlateMutationError();
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('CanonicalWorkspaceController is disposed');
  }
}

function assertSplitToObjectsSource(object: ProjectObject, synchronousTriangleLimit: number): void {
  if (object.volumes.length === 0) throw new Error('Split to Objects requires at least one model volume');
  if (object.volumes.some((volume) => volume.role !== 'model')) {
    throw new Error('Split to Objects cannot discard modifier, negative, support-enforcer, or support-blocker volumes');
  }
  if (object.volumes.some((volume) => volume.source.triangleCount < 3)) {
    throw new Error('Split to Objects cannot preserve volumes or connected components below three facets');
  }
  if (object.layerRanges.length > 0) {
    throw new Error('Split to Objects requires an explicit layer-range distribution before promotion');
  }
  if (object.extensionData && Object.keys(object.extensionData).length > 0) {
    throw new Error('Split to Objects requires an explicit object-extension distribution before promotion');
  }
  if (object.volumes.length !== 1) return;

  const volume = object.volumes[0];
  if (volume.source.triangleCount > synchronousTriangleLimit) {
    throw new CanonicalSplitToObjectsTriangleLimitError(volume.source.triangleCount, synchronousTriangleLimit);
  }
  if (facetAnnotationsHaveAssignments(volume.annotations)) {
    throw new Error(
      'Split to Objects cannot yet remap painted facet annotations onto connected components; clear or preserve them explicitly first',
    );
  }
  if (Object.prototype.hasOwnProperty.call(volume.extensionData ?? {}, CORE_FACET_ATTRIBUTES_KEY)) {
    throw new Error(
      'Split to Objects cannot preserve opaque triangle-indexed 3MF extension metadata without an explicit facet map',
    );
  }
}

function splitToObjectsResult(
  sourceObjectId: ObjectId,
  strategy: CanonicalSplitToObjectsConfirmation['strategy'],
  identities: readonly SeparatedObjectIdentity[],
  parts: readonly PreparedVolumeSplitPart[],
): CanonicalSplitToObjectsResult {
  return deepFreeze({
    sourceObjectId,
    strategy,
    objectIds: identities.map((identity) => identity.objectId),
    instanceIds: identities.flatMap((identity) => identity.instanceIds),
    volumeIds: identities.map((identity) => identity.sourceVolumeId),
    assetIds: [...new Set(parts.map((part) => part.asset.descriptor.id))],
  });
}

function extractTriangleMesh(geometry: THREE.BufferGeometry): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const position = geometry.getAttribute('position');
  if (!position || position.itemSize < 3) throw new Error('BufferGeometry needs an xyz position attribute');
  if (!Number.isSafeInteger(position.count) || position.count < 3) {
    throw new Error('BufferGeometry needs at least three vertices');
  }
  const index = geometry.getIndex();
  const indexCount = index?.count ?? position.count;
  if (!Number.isSafeInteger(indexCount) || indexCount < 3 || indexCount % 3 !== 0) {
    throw new Error('BufferGeometry must contain complete triangles');
  }
  if (
    geometry.drawRange.start !== 0 ||
    (geometry.drawRange.count !== Number.POSITIVE_INFINITY && geometry.drawRange.count !== indexCount)
  ) {
    throw new Error('BufferGeometry draw ranges must cover the complete triangle topology');
  }

  const positions = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3;
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    if (![x, y, z].every(Number.isFinite)) throw new Error('BufferGeometry positions must be finite');
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
  }

  const indices = new Uint32Array(indexCount);
  for (let cursor = 0; cursor < indexCount; cursor += 1) {
    const vertex = index ? index.getX(cursor) : cursor;
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= position.count || vertex > 0xffff_ffff) {
      throw new Error(`BufferGeometry index ${vertex} is outside the position attribute`);
    }
    indices[cursor] = vertex;
  }
  return { positions, indices };
}

function findReusableMeshAsset(candidates: readonly AssetPayload[], staged: AssetPayload): AssetPayload | undefined {
  const digestMatches = candidates
    .filter((candidate) => candidate.descriptor.digest === staged.descriptor.digest)
    .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  if (digestMatches.length === 0) return undefined;
  const compatible = digestMatches.find((candidate) => meshAssetsMatch(candidate, staged));
  if (compatible) return compatible;
  return reusableMeshAsset(digestMatches[0], staged);
}

function reusableMeshAsset(existing: AssetPayload, staged: AssetPayload): AssetPayload {
  if (existing.descriptor.kind !== 'mesh' || !existing.descriptor.mesh) {
    throw new Error(`Asset digest ${staged.descriptor.digest} is already owned by a non-mesh asset`);
  }
  if (!meshAssetsMatch(existing, staged)) {
    throw new Error(`Asset digest ${staged.descriptor.digest} does not identify the same mesh topology`);
  }
  return existing;
}

function meshAssetsMatch(left: AssetPayload, right: AssetPayload): boolean {
  return (
    left.descriptor.kind === 'mesh' &&
    right.descriptor.kind === 'mesh' &&
    left.descriptor.mesh !== undefined &&
    right.descriptor.mesh !== undefined &&
    canonicalStringify(left.descriptor.mesh) === canonicalStringify(right.descriptor.mesh) &&
    left.bytes.byteLength === right.bytes.byteLength &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}

function cloneAndValidateTransform(transform: Transform): Transform {
  const clone: Transform = {
    translationMm: [...transform.translationMm] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number],
  };
  if (
    clone.translationMm.length !== 3 ||
    clone.rotation.length !== 4 ||
    clone.scale.length !== 3 ||
    [...clone.translationMm, ...clone.rotation, ...clone.scale].some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Instance transform must contain finite translation, rotation, and scale values');
  }
  if (clone.scale.some((value) => Math.abs(value) < 1e-12)) {
    throw new Error('Instance transform scale cannot contain zero');
  }
  const quaternionNorm = clone.rotation.reduce((total, value) => total + value * value, 0);
  if (quaternionNorm < 1e-12) throw new Error('Instance transform rotation cannot be zero');
  return clone;
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    translationMm: Object.freeze([...transform.translationMm]) as Transform['translationMm'],
    rotation: Object.freeze([...transform.rotation]) as Transform['rotation'],
    scale: Object.freeze([...transform.scale]) as Transform['scale'],
  });
}

function boundedName(value: string | undefined, fallback: string): string {
  return value?.trim() ? requireBoundedText(value, 'Name', MAX_UI_NAME_LENGTH) : fallback;
}

function boundedFilename(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return requireBoundedText(value, 'Source filename', MAX_FILENAME_LENGTH);
}

function requireBoundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  if (normalized.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters`);
  if (Array.from(normalized).some((character) => (character.codePointAt(0) ?? 0) < 0x20)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  return normalized;
}

function nextAvailableName(prefix: string, names: readonly string[]): string {
  const occupied = new Set(names);
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix} ${number}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function readClock(clock: CanonicalWorkspaceClock): string {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Canonical workspace clock returned an invalid timestamp');
  return date.toISOString();
}

/** Later changes win, so a combined reset applies both fields per instance. */
function mergeChanges(
  first: readonly InstanceTransformChange[],
  second: readonly InstanceTransformChange[],
): InstanceTransformChange[] {
  const merged = new Map<string, InstanceTransformChange>();
  for (const change of [...first, ...second]) {
    const previous = merged.get(change.instanceId);
    merged.set(change.instanceId, {
      instanceId: change.instanceId,
      transform: previous ? { ...previous.transform, ...change.transform } : change.transform,
    });
  }
  return [...merged.values()];
}

function combinedCancellation(primary: CancellationToken, secondary?: CancellationToken): CancellationToken {
  return Object.freeze({
    get aborted() {
      return primary.aborted || secondary?.aborted === true;
    },
    get reason() {
      return primary.aborted ? primary.reason : secondary?.reason;
    },
  });
}

function summarizeSceneProjection(status: ThreeProjectProjectionStatus): CanonicalSceneProjectionSummary {
  switch (status.state) {
    case 'idle':
    case 'disposed':
      return Object.freeze({ state: status.state });
    case 'ready':
      return Object.freeze({
        state: status.state,
        sourceRevision: status.sourceRevision,
        sourceHash: status.sourceHash,
      });
    case 'failed':
      return Object.freeze({
        state: status.state,
        code: status.code,
        sourceRevision: status.sourceRevision,
        sourceHash: status.sourceHash,
        message: boundedProjectionMessage(status.message),
      });
  }
}

function boundedProjectionMessage(message: string): string {
  return Array.from(message, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function freezeObjectsTreeSelection(selection: SelectionSnapshot): CanonicalObjectsTreeSelection {
  const refs = selection.refs.filter(isObjectTreeEntityRef).map((ref) => Object.freeze({ ...ref }));
  const primary = selection.primary && isObjectTreeEntityRef(selection.primary) ? selection.primary : undefined;
  return Object.freeze({
    refs: Object.freeze(refs),
    ...(primary ? { primary: Object.freeze({ ...primary }) } : {}),
  });
}

function isObjectTreeEntityRef(ref: SelectionRef): ref is ObjectTreeEntityRef {
  return ref.kind !== 'project' && ref.kind !== 'filament';
}

function semanticSelectionContext(
  state: ProjectState,
  primary: SelectionRef,
):
  | {
      readonly object: ProjectObject;
      readonly selectedVolumeId?: VolumeId;
      readonly selectedLayerRangeId?: LayerRangeId;
    }
  | undefined {
  switch (primary.kind) {
    case 'object': {
      const found = findObject(state, primary.id);
      return found ? { object: found.object } : undefined;
    }
    case 'volume': {
      const found = findVolume(state, primary.id);
      return found ? { object: found.object, selectedVolumeId: found.volume.id } : undefined;
    }
    case 'instance': {
      const found = findInstance(state, primary.id);
      return found ? { object: found.object } : undefined;
    }
    case 'layer-range': {
      const found = findLayerRange(state, primary.id);
      return found ? { object: found.object, selectedLayerRangeId: found.layerRange.id } : undefined;
    }
    case 'plate':
    case 'project':
    case 'filament':
      return undefined;
  }
}

function assertObjectsTreeEntityExists(state: ProjectState, ref: ObjectTreeEntityRef): void {
  const exists =
    ref.kind === 'plate'
      ? findPlate(state, ref.id)
      : ref.kind === 'object'
        ? findObject(state, ref.id)
        : ref.kind === 'volume'
          ? findVolume(state, ref.id)
          : ref.kind === 'instance'
            ? findInstance(state, ref.id)
            : findLayerRange(state, ref.id);
  if (!exists) throw new Error(`Unknown ${ref.kind} ${ref.id}`);
}

function resolveFilamentAssignmentScope(
  state: ProjectState,
  ref: ObjectTreeEntityRef,
): CanonicalFilamentAssignmentScope | undefined {
  switch (ref.kind) {
    case 'object': {
      const found = findObject(state, ref.id);
      if (!found) throw new Error(`Unknown object ${ref.id}`);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: found.object.name,
        localFilamentId: found.object.filamentId,
        effectiveFilamentId: found.object.filamentId,
      });
    }
    case 'volume': {
      const found = findVolume(state, ref.id);
      if (!found) throw new Error(`Unknown volume ${ref.id}`);
      const resolved = resolveFilament(found.object, found.volume);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: `${found.object.name} / ${found.volume.name}`,
        localFilamentId: resolved.local,
        inheritedFilamentId: resolved.inherited,
        effectiveFilamentId: resolved.effective,
      });
    }
    case 'layer-range': {
      const found = findLayerRange(state, ref.id);
      if (!found) throw new Error(`Unknown layer-range ${ref.id}`);
      const resolved = resolveFilament(found.object, found.layerRange);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: `${found.object.name} / ${formatZ(found.layerRange.minZMm)}–${formatZ(found.layerRange.maxZMm)} mm`,
        localFilamentId: resolved.local,
        inheritedFilamentId: resolved.inherited,
        effectiveFilamentId: resolved.effective,
      });
    }
    case 'plate':
    case 'instance':
      return undefined;
  }
}

function freezeFilamentAssignmentScope(scope: CanonicalFilamentAssignmentScope): CanonicalFilamentAssignmentScope {
  return Object.freeze({
    entity: Object.freeze({ ...scope.entity }),
    objectId: scope.objectId,
    label: scope.label,
    ...(scope.localFilamentId ? { localFilamentId: scope.localFilamentId } : {}),
    ...(scope.inheritedFilamentId ? { inheritedFilamentId: scope.inheritedFilamentId } : {}),
    ...(scope.effectiveFilamentId ? { effectiveFilamentId: scope.effectiveFilamentId } : {}),
  });
}

function canonicalFilamentOptions(state: ProjectState): readonly CanonicalFilamentOption[] {
  const physicalById = new Map(state.filaments.physical.map((filament) => [filament.id, filament]));
  const physical = [...state.filaments.physical]
    .sort((left, right) => left.toolId - right.toolId || left.id.localeCompare(right.id))
    .map((filament): CanonicalFilamentOption => {
      const warnings: string[] = [];
      if (!filament.enabled) warnings.push('This physical filament is disabled.');
      if (filament.toolId < 0 || filament.toolId >= state.printer.toolCount) {
        warnings.push(`Tool ${filament.toolId} is outside the printer's configured head range.`);
      }
      if (!filament.presetId) warnings.push('No filament preset snapshot is linked to this head.');
      return Object.freeze({
        id: filament.id,
        kind: 'physical',
        name: filament.name,
        color: filament.color,
        enabled: filament.enabled,
        material: filament.material,
        ...(filament.presetId ? { presetId: filament.presetId } : {}),
        toolId: filament.toolId,
        recipe: Object.freeze([]),
        warnings: Object.freeze(warnings),
      });
    });
  const mixed = [...state.filaments.mixed]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((filament): CanonicalFilamentOption => {
      const warnings: string[] = [];
      if (!filament.enabled) warnings.push('This virtual filament is disabled.');
      const recipe = filament.components.map((component) => {
        const physicalFilament = physicalById.get(component.filamentId);
        if (!physicalFilament) warnings.push(`Recipe component ${component.filamentId} is missing.`);
        else if (!physicalFilament.enabled) warnings.push(`Recipe component ${physicalFilament.name} is disabled.`);
        return Object.freeze({
          filamentId: component.filamentId,
          name: physicalFilament?.name ?? 'Missing physical filament',
          color: physicalFilament?.color ?? '#808080',
          weight: component.weight,
        });
      });
      const materials = [
        ...new Set(
          filament.components.flatMap((component) => {
            const material = physicalById.get(component.filamentId)?.material;
            return material ? [material] : [];
          }),
        ),
      ].sort();
      if (materials.length > 1) {
        warnings.push(`Recipe combines ${materials.join(' and ')}; verify material compatibility before slicing.`);
      }
      return Object.freeze({
        id: filament.id,
        kind: 'mixed',
        name: filament.name,
        color: filament.displayColor,
        enabled: filament.enabled,
        ...(materials.length > 0 ? { material: materials.join(' + ') } : {}),
        distributionMode: filament.distribution.mode,
        recipe: Object.freeze(recipe),
        warnings: Object.freeze(warnings),
      });
    });
  return Object.freeze([...physical, ...mixed]);
}

function filamentAssignmentChange(
  state: ProjectState,
  entity: CanonicalFilamentAssignableEntityRef,
  filamentId: FilamentId | null,
): FilamentAssignmentChange {
  switch (entity.kind) {
    case 'object': {
      const found = findObject(state, entity.id);
      if (!found) throw new Error(`Unknown object ${entity.id}`);
      return { target: { kind: 'object', objectId: found.object.id }, filamentId };
    }
    case 'volume': {
      const found = findVolume(state, entity.id);
      if (!found) throw new Error(`Unknown volume ${entity.id}`);
      return {
        target: { kind: 'volume', objectId: found.object.id, volumeId: found.volume.id },
        filamentId,
      };
    }
    case 'layer-range': {
      const found = findLayerRange(state, entity.id);
      if (!found) throw new Error(`Unknown layer-range ${entity.id}`);
      return {
        target: {
          kind: 'layer-range',
          objectId: found.object.id,
          layerRangeId: found.layerRange.id,
        },
        filamentId,
      };
    }
    default:
      throw new Error(`Unsupported filament assignment scope ${String((entity as ObjectTreeEntityRef).kind)}`);
  }
}

function objectTreeEntityKey(ref: ObjectTreeEntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

function formatZ(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function suggestedStlFilename(name: string): string {
  const withoutControls = [...name].map((character) => (character.codePointAt(0)! <= 0x1f ? '-' : character)).join('');
  const stem = withoutControls
    .normalize('NFKC')
    .replace(/\.stl$/i, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return `${stem || 'OrcaXR-model'}.stl`;
}

function safelyNotify(subscriber: CanonicalWorkspaceSubscriber, change: CanonicalWorkspaceChange): void {
  try {
    subscriber(change);
  } catch {
    // Read-only UI observers cannot veto canonical state or poison peers.
  }
}
