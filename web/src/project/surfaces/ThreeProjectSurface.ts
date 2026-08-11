import * as THREE from 'three';

import { contentDigest, type AssetPayload, type AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { AssetId, InstanceId, ObjectId, PlateId, VolumeId } from '../domain/ids';
import type { ProjectObject, ProjectState, ProjectVolume, Transform, Vec3 } from '../domain/model';
import { resolveFilament } from '../domain/selectors';
import { assertValidProjectState } from '../domain/validation';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { EditorSurfacePort } from '../ports';
import { selectionKey, type SelectionRef, type SelectionSnapshot } from '../selection';
import type { ProjectSnapshot } from '../store';

/**
 * Display colour for one volume: the stable filament it resolves to, projected
 * exactly as the palette does — a physical tool's own colour, or a mixed
 * recipe's stored display colour. An unassigned volume returns undefined so the
 * caller keeps the neutral material instead of inventing a colour.
 */
function resolveVolumeFilamentColor(
  state: ProjectState,
  object: ProjectObject,
  volume: ProjectVolume,
): string | undefined {
  const filamentId = resolveFilament(object, volume).effective;
  if (!filamentId) return undefined;
  const physical = state.filaments.physical.find((filament) => filament.id === filamentId);
  if (physical) return physical.color;
  const mixed = state.filaments.mixed.find((filament) => filament.id === filamentId);
  return mixed?.displayColor;
}

/** The live workspace's current 1 mm -> 1.75 mm-world visual magnification. */
export const CURRENT_THREE_WORLD_UNITS_PER_MM = 0.00175;

/**
 * Canonical printer coordinates are right-handed, Z-up millimetres with the
 * origin at the front-left bed corner. Three workspace coordinates are Y-up,
 * centered on the bed, with printer +Y pointing toward Three -Z.
 */
export interface ThreePrinterSpaceMapping {
  readonly bedSizeMm: readonly [widthMm: number, depthMm: number];
  readonly worldUnitsPerMm: number;
}

export interface ThreeProjectEntityUserData {
  readonly kind: 'instance' | 'volume';
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly instanceId: InstanceId;
  readonly volumeId?: VolumeId;
  readonly role?: ProjectVolume['role'];
  readonly printable: boolean;
  selected: boolean;
  primary: boolean;
}

export const THREE_PROJECT_ENTITY_USER_DATA_KEY = 'orcaxrProjectEntity';

export type ThreeProjectProjectionFailureCode =
  | 'surface-disposed'
  | 'invalid-project'
  | 'missing-asset'
  | 'asset-mismatch'
  | 'asset-cache-collision'
  | 'invalid-mesh'
  | 'projection-stale';

export interface ThreeProjectProjectionFailure {
  readonly code: ThreeProjectProjectionFailureCode;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly message: string;
  readonly cause?: unknown;
}

export type ThreeProjectProjectionStatus =
  | { readonly state: 'idle' }
  | {
      readonly state: 'ready';
      readonly sourceRevision: number;
      readonly sourceHash: string;
    }
  | ({ readonly state: 'failed' } & ThreeProjectProjectionFailure)
  | { readonly state: 'disposed' };

export class ThreeProjectProjectionError extends Error implements ThreeProjectProjectionFailure {
  readonly code: ThreeProjectProjectionFailureCode;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  override readonly cause?: unknown;

  constructor(failure: ThreeProjectProjectionFailure) {
    super(failure.message, failure.cause === undefined ? undefined : { cause: failure.cause });
    this.name = 'ThreeProjectProjectionError';
    this.code = failure.code;
    this.sourceRevision = failure.sourceRevision;
    this.sourceHash = failure.sourceHash;
    this.cause = failure.cause;
  }
}

export interface ThreeProjectSurfaceOptions {
  /** Parent owned by the renderer. The surface owns only the child root it adds. */
  readonly parent: THREE.Object3D;
  readonly assets: AssetRepository;
  readonly mapping: ThreePrinterSpaceMapping;
  /** Shared by every projected mesh. A supplied material remains caller-owned by default. */
  readonly material?: THREE.Material;
  readonly ownsMaterial?: boolean;
  /** Receives the same durable failure that renderProject throws. */
  readonly onProjectionError?: (failure: ThreeProjectProjectionFailure) => void;
}

interface GeometryEntry {
  readonly assetId: AssetId;
  readonly digest: string;
  readonly descriptorLayout: string;
  readonly actualContentDigest: string;
  readonly geometry: THREE.BufferGeometry;
  /**
   * The exact payload object whose bytes produced `actualContentDigest`.
   *
   * The repository is immutable by contract, so while it still hands back this
   * same object the content behind the cached geometry is provably unchanged
   * and the collision check below costs a reference comparison instead of
   * re-hashing tens of megabytes on every projection.
   */
  verifiedPayload: AssetPayload | undefined;
  references: number;
}

interface PlannedVolume {
  readonly volume: ProjectVolume;
  readonly geometry: GeometryEntry;
  /**
   * Display colour of the filament this volume resolves to, or undefined when
   * nothing is assigned. Never a guess: an unassigned volume keeps the neutral
   * base material rather than borrowing another tool's colour.
   */
  readonly filamentColor?: string;
}

interface PlannedInstance {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly instanceId: InstanceId;
  readonly name: string;
  readonly transform: Transform;
  readonly printable: boolean;
  readonly visible: boolean;
  readonly volumes: readonly PlannedVolume[];
}

interface ProjectionPlan {
  readonly instances: readonly PlannedInstance[];
  readonly newGeometryEntries: readonly GeometryEntry[];
}

interface MeshRecord {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  geometry: GeometryEntry;
}

interface InstanceRecord {
  readonly group: THREE.Group;
  readonly meshes: Map<VolumeId, MeshRecord>;
}

class ProjectionBuildError extends Error {
  constructor(
    readonly code: Exclude<ThreeProjectProjectionFailureCode, 'surface-disposed' | 'projection-stale'>,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/**
 * Convert a printer-space point to the Three coordinates used by the current
 * workspace, relative to the configured parent object.
 */
export function printerMmToThreePosition(
  pointMm: Vec3,
  mapping: ThreePrinterSpaceMapping,
): readonly [number, number, number] {
  assertValidMapping(mapping);
  const [widthMm, depthMm] = mapping.bedSizeMm;
  const scale = mapping.worldUnitsPerMm;
  return [(pointMm[0] - widthMm / 2) * scale, pointMm[2] * scale, (depthMm / 2 - pointMm[1]) * scale];
}

export function getThreeProjectEntity(object: THREE.Object3D): ThreeProjectEntityUserData | undefined {
  return object.userData[THREE_PROJECT_ENTITY_USER_DATA_KEY] as ThreeProjectEntityUserData | undefined;
}

/**
 * A one-way canonical store -> Three scene projection. It never derives or
 * writes canonical state from mutable scene objects.
 */
export class ThreeProjectSurface implements EditorSurfacePort {
  readonly projectionLabel = 'Three project scene';
  readonly root = new THREE.Group();

  private readonly instances = new Map<InstanceId, InstanceRecord>();
  private readonly geometryByAsset = new Map<AssetId, Map<string, GeometryEntry>>();
  private readonly material: THREE.Material;
  private readonly ownsMaterial: boolean;
  /** One material per distinct assigned filament colour, owned by this surface. */
  private readonly filamentMaterials = new Map<string, THREE.Material>();
  private mapping: ThreePrinterSpaceMapping;
  private selection: SelectionSnapshot = { refs: [] };
  private status: ThreeProjectProjectionStatus = { state: 'idle' };
  private lastError: ThreeProjectProjectionError | undefined;
  private disposed = false;

  constructor(private readonly options: ThreeProjectSurfaceOptions) {
    assertValidMapping(options.mapping);
    this.mapping = cloneMapping(options.mapping);
    this.material =
      options.material ?? new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.72, metalness: 0.04 });
    this.ownsMaterial = options.material ? (options.ownsMaterial ?? false) : true;
    this.root.name = 'canonical-project-printer-space';
    this.applyMapping();
    options.parent.add(this.root);
  }

  /**
   * Material for one volume. A caller-supplied material always wins, so tests
   * and specialised surfaces keep full control; otherwise each assigned
   * filament colour gets its own cached material and unassigned volumes keep
   * the neutral base.
   */
  private materialFor(filamentColor: string | undefined): THREE.Material {
    if (this.options.material || !filamentColor) return this.material;
    const cached = this.filamentMaterials.get(filamentColor);
    if (cached) return cached;
    const base = this.material as THREE.MeshStandardMaterial;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(filamentColor),
      roughness: base.roughness ?? 0.72,
      metalness: base.metalness ?? 0.04,
    });
    this.filamentMaterials.set(filamentColor, material);
    return material;
  }

  renderProject(snapshot: ProjectSnapshot): void {
    if (this.disposed) {
      throw this.fail(snapshot, 'surface-disposed', 'Cannot project into a disposed Three project surface');
    }
    try {
      const plan = this.buildPlan(snapshot.state);
      this.commitPlan(plan);
      this.status = {
        state: 'ready',
        sourceRevision: snapshot.revision,
        sourceHash: snapshot.hash,
      };
      this.lastError = undefined;
    } catch (cause) {
      if (cause instanceof ThreeProjectProjectionError) throw cause;
      const buildFailure = cause instanceof ProjectionBuildError ? cause : undefined;
      throw this.fail(
        snapshot,
        buildFailure?.code ?? 'invalid-project',
        buildFailure?.message ?? 'Canonical project could not be projected into Three.js',
        buildFailure?.cause ?? cause,
      );
    }
  }

  renderSelection(snapshot: SelectionSnapshot): void {
    if (this.disposed) throw new Error('Cannot render selection into a disposed Three project surface');
    this.selection = cloneSelection(snapshot);
    this.applySelection();
  }

  /** Change bed/profile visualization without touching canonical transforms. */
  setPrinterSpaceMapping(mapping: ThreePrinterSpaceMapping): void {
    if (this.disposed) throw new Error('Cannot configure a disposed Three project surface');
    assertValidMapping(mapping);
    this.mapping = cloneMapping(mapping);
    this.applyMapping();
  }

  getPrinterSpaceMapping(): ThreePrinterSpaceMapping {
    return cloneMapping(this.mapping);
  }

  getProjectionStatus(): ThreeProjectProjectionStatus {
    return { ...this.status };
  }

  /**
   * Composition roots call this before save/slice/publish. A scene left at an
   * older good snapshot after a failed projection is intentionally not current.
   */
  assertProjectionCurrent(snapshot: ProjectSnapshot): void {
    if (
      this.status.state === 'ready' &&
      this.status.sourceRevision === snapshot.revision &&
      this.status.sourceHash === snapshot.hash
    ) {
      return;
    }
    if (
      this.lastError &&
      this.lastError.sourceRevision === snapshot.revision &&
      this.lastError.sourceHash === snapshot.hash
    ) {
      throw this.lastError;
    }
    throw new ThreeProjectProjectionError({
      code: this.disposed ? 'surface-disposed' : 'projection-stale',
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
      message: this.disposed
        ? 'Three project surface is disposed'
        : 'Three project surface does not represent the requested canonical snapshot',
    });
  }

  getInstanceGroup(instanceId: InstanceId): THREE.Group | undefined {
    return this.instances.get(instanceId)?.group;
  }

  getVolumeMesh(
    instanceId: InstanceId,
    volumeId: VolumeId,
  ): THREE.Mesh<THREE.BufferGeometry, THREE.Material> | undefined {
    return this.instances.get(instanceId)?.meshes.get(volumeId)?.mesh;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const record of this.instances.values()) {
      record.group.clear();
    }
    this.root.clear();
    this.instances.clear();
    for (const byDigest of this.geometryByAsset.values()) {
      for (const entry of byDigest.values()) entry.geometry.dispose();
    }
    this.geometryByAsset.clear();
    if (this.ownsMaterial) this.material.dispose();
    for (const material of this.filamentMaterials.values()) material.dispose();
    this.filamentMaterials.clear();
    this.status = { state: 'disposed' };
    this.lastError = undefined;
  }

  private buildPlan(state: ProjectState): ProjectionPlan {
    try {
      assertValidProjectState(state);
    } catch (cause) {
      throw new ProjectionBuildError('invalid-project', 'Canonical project state is invalid', cause);
    }

    const descriptors = new Map(state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
    const resolvedAssets = new Map<AssetId, GeometryEntry>();
    const newGeometryEntries: GeometryEntry[] = [];
    const instances: PlannedInstance[] = [];

    try {
      for (const plate of [...state.plates].sort((left, right) => left.order - right.order)) {
        for (const object of plate.objects) {
          const volumes = object.volumes.map((volume): PlannedVolume => {
            let geometry = resolvedAssets.get(volume.source.assetId);
            if (!geometry) {
              const descriptor = descriptors.get(volume.source.assetId);
              if (!descriptor) {
                throw new ProjectionBuildError(
                  'missing-asset',
                  `Volume ${volume.id} references missing asset descriptor ${volume.source.assetId}`,
                );
              }
              geometry = this.resolveGeometry(descriptor.id, descriptor, newGeometryEntries);
              resolvedAssets.set(descriptor.id, geometry);
            }
            if (geometry.geometry.getIndex()!.count / 3 !== volume.source.triangleCount) {
              throw new ProjectionBuildError(
                'invalid-mesh',
                `Volume ${volume.id} triangle count differs from decoded asset ${volume.source.assetId}`,
              );
            }
            const filamentColor = resolveVolumeFilamentColor(state, object, volume);
            return { volume, geometry, ...(filamentColor ? { filamentColor } : {}) };
          });
          for (const instance of object.instances) {
            instances.push({
              plateId: plate.id,
              objectId: object.id,
              instanceId: instance.id,
              name: instance.name ?? object.name,
              transform: instance.transform,
              printable: plate.printable && instance.printable,
              visible: plate.id === state.activePlateId,
              volumes,
            });
          }
        }
      }
      return { instances, newGeometryEntries };
    } catch (cause) {
      // Entries created for an uncommitted plan are not in the shared cache
      // and must not survive a later missing/malformed asset failure.
      for (const entry of newGeometryEntries) entry.geometry.dispose();
      throw cause;
    }
  }

  private resolveGeometry(
    assetId: AssetId,
    descriptor: ProjectState['sourceAssets'][number],
    newEntries: GeometryEntry[],
  ): GeometryEntry {
    // Read-only, and deliberately not a copy: a projection runs on every
    // canonical change, and copying a multi-million-triangle mesh just to
    // confirm it is the one already on the GPU is pure latency.
    const payload = this.options.assets.peek(assetId);
    if (!payload) throw new ProjectionBuildError('missing-asset', `Asset bytes are missing for ${assetId}`);
    const cached = this.geometryByAsset.get(assetId)?.get(descriptor.digest);
    if (cached && cached.verifiedPayload === payload) {
      // Same repository object as the one already verified, so the descriptor
      // comparison and the content hash can only reach the same answers.
      return cached;
    }
    if (canonicalStringify(payload.descriptor) !== canonicalStringify(descriptor)) {
      throw new ProjectionBuildError(
        'asset-mismatch',
        `Asset repository metadata does not match canonical descriptor ${assetId}`,
      );
    }

    const descriptorLayout = geometryDescriptorLayout(payload);
    const actualContentDigest = contentDigest(payload.bytes);
    if (cached) {
      if (cached.descriptorLayout !== descriptorLayout || cached.actualContentDigest !== actualContentDigest) {
        throw new ProjectionBuildError(
          'asset-cache-collision',
          `Asset ${assetId} reused digest ${descriptor.digest} for different mesh content`,
        );
      }
      cached.verifiedPayload = payload;
      return cached;
    }

    let geometry: THREE.BufferGeometry;
    try {
      const decoded = decodeIndexedMeshAsset(payload);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(decoded.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.userData = Object.freeze({
        assetId,
        digest: descriptor.digest,
      });
    } catch (cause) {
      throw new ProjectionBuildError('invalid-mesh', `Asset ${assetId} is not a valid indexed mesh`, cause);
    }
    const entry: GeometryEntry = {
      assetId,
      digest: descriptor.digest,
      descriptorLayout,
      actualContentDigest,
      geometry,
      verifiedPayload: payload,
      references: 0,
    };
    newEntries.push(entry);
    return entry;
  }

  private commitPlan(plan: ProjectionPlan): void {
    for (const entry of plan.newGeometryEntries) {
      let byDigest = this.geometryByAsset.get(entry.assetId);
      if (!byDigest) {
        byDigest = new Map();
        this.geometryByAsset.set(entry.assetId, byDigest);
      }
      byDigest.set(entry.digest, entry);
    }

    const plannedIds = new Set(plan.instances.map((instance) => instance.instanceId));
    for (const [instanceId, record] of [...this.instances]) {
      if (plannedIds.has(instanceId)) continue;
      record.group.removeFromParent();
      record.group.clear();
      this.instances.delete(instanceId);
    }

    for (const planned of plan.instances) this.reconcileInstance(planned);

    const order = new Map(plan.instances.map((instance, index) => [instance.instanceId, index]));
    this.root.children.sort((left, right) => {
      const leftId = getThreeProjectEntity(left)?.instanceId;
      const rightId = getThreeProjectEntity(right)?.instanceId;
      return (
        (leftId === undefined ? Number.MAX_SAFE_INTEGER : (order.get(leftId) ?? Number.MAX_SAFE_INTEGER)) -
        (rightId === undefined ? Number.MAX_SAFE_INTEGER : (order.get(rightId) ?? Number.MAX_SAFE_INTEGER))
      );
    });

    const referenceCounts = new Map<GeometryEntry, number>();
    for (const planned of plan.instances) {
      for (const volume of planned.volumes) {
        referenceCounts.set(volume.geometry, (referenceCounts.get(volume.geometry) ?? 0) + 1);
      }
    }
    for (const [assetId, byDigest] of [...this.geometryByAsset]) {
      for (const [digest, entry] of [...byDigest]) {
        entry.references = referenceCounts.get(entry) ?? 0;
        if (entry.references === 0) {
          entry.geometry.dispose();
          byDigest.delete(digest);
        }
      }
      if (byDigest.size === 0) this.geometryByAsset.delete(assetId);
    }
    this.applySelection();
    this.root.updateMatrixWorld(true);
  }

  private reconcileInstance(planned: PlannedInstance): void {
    let record = this.instances.get(planned.instanceId);
    if (!record) {
      const group = new THREE.Group();
      record = { group, meshes: new Map() };
      this.instances.set(planned.instanceId, record);
      this.root.add(group);
    }
    const { group, meshes } = record;
    group.name = `canonical-instance:${planned.name}`;
    group.visible = planned.visible;
    applyCanonicalTransform(group, planned.transform);
    setEntityData(group, {
      kind: 'instance',
      plateId: planned.plateId,
      objectId: planned.objectId,
      instanceId: planned.instanceId,
      printable: planned.printable,
      selected: false,
      primary: false,
    });

    const plannedVolumeIds = new Set(planned.volumes.map(({ volume }) => volume.id));
    for (const [volumeId, meshRecord] of [...meshes]) {
      if (plannedVolumeIds.has(volumeId)) continue;
      meshRecord.mesh.removeFromParent();
      meshes.delete(volumeId);
    }

    for (const { volume, geometry, filamentColor } of planned.volumes) {
      const material = this.materialFor(filamentColor);
      let meshRecord = meshes.get(volume.id);
      if (!meshRecord) {
        const mesh = new THREE.Mesh(geometry.geometry, material);
        meshRecord = { mesh, geometry };
        meshes.set(volume.id, meshRecord);
        group.add(mesh);
      } else {
        if (meshRecord.geometry !== geometry) {
          meshRecord.mesh.geometry = geometry.geometry;
          meshRecord.geometry = geometry;
        }
        if (meshRecord.mesh.material !== material) meshRecord.mesh.material = material;
      }
      const { mesh } = meshRecord;
      mesh.name = `canonical-volume:${volume.name}`;
      applyCanonicalTransform(mesh, volume.transform);
      setEntityData(mesh, {
        kind: 'volume',
        plateId: planned.plateId,
        objectId: planned.objectId,
        instanceId: planned.instanceId,
        volumeId: volume.id,
        role: volume.role,
        printable: planned.printable,
        selected: false,
        primary: false,
      });
    }

    const volumeOrder = new Map(planned.volumes.map(({ volume }, index) => [volume.id, index]));
    group.children.sort((left, right) => {
      const leftId = getThreeProjectEntity(left)?.volumeId;
      const rightId = getThreeProjectEntity(right)?.volumeId;
      return (
        (leftId === undefined ? Number.MAX_SAFE_INTEGER : (volumeOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER)) -
        (rightId === undefined ? Number.MAX_SAFE_INTEGER : (volumeOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER))
      );
    });
  }

  private applySelection(): void {
    const selected = new Set(this.selection.refs.map(selectionKey));
    const primary = this.selection.primary ? selectionKey(this.selection.primary) : undefined;
    for (const record of this.instances.values()) {
      const groupData = getThreeProjectEntity(record.group)!;
      groupData.selected = entityMatchesSelection(groupData, selected, false);
      groupData.primary = entityMatchesPrimary(groupData, primary, false);
      for (const meshRecord of record.meshes.values()) {
        const meshData = getThreeProjectEntity(meshRecord.mesh)!;
        meshData.selected = entityMatchesSelection(meshData, selected, true);
        meshData.primary = entityMatchesPrimary(meshData, primary, true);
      }
    }
  }

  private applyMapping(): void {
    const [widthMm, depthMm] = this.mapping.bedSizeMm;
    const scale = this.mapping.worldUnitsPerMm;
    this.root.position.set((-widthMm / 2) * scale, 0, (depthMm / 2) * scale);
    this.root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    this.root.scale.setScalar(scale);
    this.root.updateMatrix();
    this.root.updateMatrixWorld(true);
    this.root.userData.orcaxrPrinterSpace = Object.freeze({
      coordinateSystem: 'right-handed-z-up-bed-corner-mm',
      threeMapping: 'x=(X-width/2)*scale,y=Z*scale,z=(depth/2-Y)*scale',
      bedSizeMm: Object.freeze([...this.mapping.bedSizeMm]),
      worldUnitsPerMm: scale,
    });
  }

  private fail(
    snapshot: ProjectSnapshot,
    code: ThreeProjectProjectionFailureCode,
    message: string,
    cause?: unknown,
  ): ThreeProjectProjectionError {
    const error = new ThreeProjectProjectionError({
      code,
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
      message,
      ...(cause === undefined ? {} : { cause }),
    });
    this.lastError = error;
    this.status = {
      state: 'failed',
      code,
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
      message,
      ...(cause === undefined ? {} : { cause }),
    };
    try {
      this.options.onProjectionError?.(error);
    } catch {
      // Reporting is observational and cannot replace the projection failure.
    }
    return error;
  }
}

function geometryDescriptorLayout(payload: AssetPayload): string {
  return canonicalStringify({
    kind: payload.descriptor.kind,
    byteLength: payload.descriptor.byteLength,
    mesh: payload.descriptor.mesh,
  });
}

function applyCanonicalTransform(target: THREE.Object3D, transform: Transform): void {
  target.position.fromArray(transform.translationMm);
  target.quaternion.fromArray(transform.rotation).normalize();
  target.scale.fromArray(transform.scale);
  target.updateMatrix();
  target.matrixWorldNeedsUpdate = true;
}

function setEntityData(object: THREE.Object3D, data: ThreeProjectEntityUserData): void {
  object.userData[THREE_PROJECT_ENTITY_USER_DATA_KEY] = data;
}

function entityMatchesSelection(
  data: ThreeProjectEntityUserData,
  selected: ReadonlySet<string>,
  includeVolume: boolean,
): boolean {
  return selectionKeysForEntity(data, includeVolume).some((key) => selected.has(key));
}

function entityMatchesPrimary(
  data: ThreeProjectEntityUserData,
  primary: string | undefined,
  includeVolume: boolean,
): boolean {
  return primary !== undefined && selectionKeysForEntity(data, includeVolume).includes(primary);
}

function selectionKeysForEntity(data: ThreeProjectEntityUserData, includeVolume: boolean): string[] {
  const refs: SelectionRef[] = [
    { kind: 'project' },
    { kind: 'plate', id: data.plateId },
    { kind: 'object', id: data.objectId },
    { kind: 'instance', id: data.instanceId },
  ];
  if (includeVolume && data.volumeId) refs.push({ kind: 'volume', id: data.volumeId });
  return refs.map(selectionKey);
}

function cloneSelection(snapshot: SelectionSnapshot): SelectionSnapshot {
  return {
    refs: snapshot.refs.map((ref) => ({ ...ref })),
    ...(snapshot.primary ? { primary: { ...snapshot.primary } } : {}),
  };
}

function cloneMapping(mapping: ThreePrinterSpaceMapping): ThreePrinterSpaceMapping {
  return {
    bedSizeMm: [mapping.bedSizeMm[0], mapping.bedSizeMm[1]],
    worldUnitsPerMm: mapping.worldUnitsPerMm,
  };
}

function assertValidMapping(mapping: ThreePrinterSpaceMapping): void {
  const [widthMm, depthMm] = mapping.bedSizeMm;
  if (![widthMm, depthMm, mapping.worldUnitsPerMm].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Three printer-space mapping requires positive finite bed dimensions and scale');
  }
}
