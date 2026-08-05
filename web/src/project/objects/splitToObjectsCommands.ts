import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type InstanceId, type ObjectId, type PlateId, type VolumeId } from '../domain/ids';
import type { ProjectInstance, ProjectObject, ProjectState, ProjectVolume, Transform, Vec3 } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import { findObject, findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import type { CommandBus } from '../history/commandBus';
import { selectionKey, type SelectionRef, type SelectionSnapshot } from '../selection';
import { SplitVolumeToPartsCommand, type PreparedVolumeSplitPart, type VolumeSplitGuard } from './splitCommands';

export interface ObjectVolumeSeparationGuard {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly objectFingerprint: string;
}

export interface SeparatedObjectIdentity {
  /** Existing volume identity that moves into the generated object. */
  readonly sourceVolumeId: VolumeId;
  readonly objectId: ObjectId;
  /** One fresh identity for every source instance, in source order. */
  readonly instanceIds: readonly InstanceId[];
}

/**
 * Capture the complete source object before a synchronous split-to-objects
 * commit. Object metadata, transforms, and instance order all affect the
 * promoted outputs and therefore participate in the stale guard.
 */
export function captureObjectVolumeSeparationGuard(
  state: ProjectState,
  objectId: ObjectId,
): ObjectVolumeSeparationGuard {
  const found = findObject(state, objectId);
  if (!found) throw new Error(`Unknown object ${objectId}`);
  return {
    plateId: found.plate.id,
    objectId,
    objectFingerprint: canonicalStringify(found.object),
  };
}

/**
 * Promote each model volume into one object without changing mesh bytes.
 *
 * This is the pinned multi-volume branch of `ModelObject::split`: object
 * configuration is overlaid by the volume configuration, volume-local
 * translation is transferred through every instance's linear transform, and
 * the promoted volume keeps rotation/scale with zero translation. Canonical
 * volume IDs and annotations remain stable because no topology changes.
 */
export class SeparateObjectVolumesCommand implements ProjectCommand {
  readonly type = 'separate-object-volumes';
  readonly label = 'Split to objects';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly guard: ObjectVolumeSeparationGuard;
  private readonly identities: readonly SeparatedObjectIdentity[];
  private before?: ProjectState;
  private after?: ProjectState;
  private beforeSelection?: SelectionSnapshot;
  private afterSelection?: SelectionSnapshot;

  constructor(guard: ObjectVolumeSeparationGuard, identities: readonly SeparatedObjectIdentity[]) {
    assertGuard(guard);
    this.guard = { ...guard };
    this.identities = identities.map((identity) => ({
      sourceVolumeId: identity.sourceVolumeId,
      objectId: identity.objectId,
      instanceIds: [...identity.instanceIds],
    }));
  }

  apply(context: CommandContext): void {
    const current = cloneProjectState(context.project.getSnapshot().state);
    if (this.before && this.after && this.afterSelection) {
      if (canonicalStringify(current) !== canonicalStringify(this.before)) {
        throw new Error(`Split-to-objects source ${this.guard.objectId} changed before redo`);
      }
      context.project.replaceState(this.after, {
        reason: this.type,
        dirtyCategories: this.dirtyCategories,
      });
      context.selection.restore(this.afterSelection);
      return;
    }

    const found = requireGuardedObject(current, this.guard);
    validateSourceObject(found.object);
    validateIdentities(current, found.object, this.identities);
    const sourceObject = cloneJson(found.object);
    const generated = sourceObject.volumes.map((volume, index) =>
      promotedObject(sourceObject, volume, this.identities[index]),
    );
    found.plate.objects.splice(found.objectIndex, 1, ...generated.map(cloneJson));
    assertValidProjectState(current);

    const selectionBefore = context.selection.getSnapshot();
    const selectionAfter = remapSeparatedSelection(selectionBefore, sourceObject, generated);
    this.before = cloneProjectState(context.project.getSnapshot().state);
    this.after = cloneProjectState(current);
    this.beforeSelection = selectionBefore;
    this.afterSelection = selectionAfter;

    context.project.replaceState(current, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.restore(selectionAfter);
  }

  revert(context: CommandContext): void {
    if (!this.before || !this.after || !this.beforeSelection) {
      throw new Error('SeparateObjectVolumesCommand has not been applied');
    }
    if (canonicalStringify(context.project.getSnapshot().state) !== canonicalStringify(this.after)) {
      throw new Error(`Generated split objects for ${this.guard.objectId} changed before undo`);
    }
    context.project.replaceState(this.before, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.restore(this.beforeSelection);
  }

  estimateBytes(): number {
    return Math.max(
      1,
      canonicalStringify(this.guard).length +
        canonicalStringify(this.identities).length +
        (this.before ? canonicalStringify(this.before).length : 0) +
        (this.after ? canonicalStringify(this.after).length : 0),
    );
  }
}

/**
 * Commit the pinned single-volume branch as one history transaction: first
 * install a lossless shared-edge component split, then promote those volumes
 * into independent objects. Components below the pinned three-facet threshold
 * are rejected explicitly instead of being silently discarded.
 */
export function commitPreparedVolumeSplitToObjects(
  commands: CommandBus,
  guard: VolumeSplitGuard,
  parts: readonly PreparedVolumeSplitPart[],
  identities: readonly SeparatedObjectIdentity[],
): void {
  const before = commands.context.project.getSnapshot().state;
  const found = findVolume(before, guard.volumeId);
  if (!found) throw new Error(`Unknown split-to-objects source volume ${guard.volumeId}`);
  if (found.object.volumes.length !== 1) {
    throw new Error('Prepared component split-to-objects requires an object with exactly one volume');
  }
  const undersized = parts.find((part) => part.sourceTriangleIndices.length < 3);
  if (undersized) {
    throw new Error(
      `Split-to-objects component for ${undersized.volumeId} has fewer than three facets; refusing the pinned lossy discard`,
    );
  }

  commands.transaction('Split to objects', () => {
    commands.execute(new SplitVolumeToPartsCommand(guard, parts), { coalesce: false });
    const splitState = commands.context.project.getSnapshot().state;
    const splitObject = findVolume(splitState, parts[0].volumeId)?.object;
    if (!splitObject) throw new Error('Prepared split-to-objects output is missing after component commit');
    commands.execute(
      new SeparateObjectVolumesCommand(captureObjectVolumeSeparationGuard(splitState, splitObject.id), identities),
      { coalesce: false },
    );
  });
}

function requireGuardedObject(
  state: ProjectState,
  guard: ObjectVolumeSeparationGuard,
): { plate: ProjectState['plates'][number]; object: ProjectObject; objectIndex: number } {
  const plate = state.plates.find((candidate) => candidate.id === guard.plateId);
  const objectIndex = plate?.objects.findIndex((candidate) => candidate.id === guard.objectId) ?? -1;
  const object = objectIndex >= 0 ? plate!.objects[objectIndex] : undefined;
  if (!plate || !object || canonicalStringify(object) !== guard.objectFingerprint) {
    throw new Error(`Split-to-objects source ${guard.objectId} is stale`);
  }
  return { plate, object, objectIndex };
}

function validateSourceObject(object: ProjectObject): void {
  if (object.volumes.length < 2) throw new Error('Split to objects requires at least two model volumes');
  if (object.volumes.some((volume) => volume.role !== 'model')) {
    throw new Error('Split to objects refuses to discard modifier or negative volumes');
  }
  if (object.volumes.some((volume) => volume.source.triangleCount < 3)) {
    throw new Error('Split to objects refuses the pinned lossy discard of volumes below three facets');
  }
  if (object.layerRanges.length > 0) {
    throw new Error('Split to objects requires an explicit layer-range distribution before promotion');
  }
  if (object.extensionData && Object.keys(object.extensionData).length > 0) {
    throw new Error('Split to objects requires an explicit object-extension distribution before promotion');
  }
}

function validateIdentities(
  state: ProjectState,
  object: ProjectObject,
  identities: readonly SeparatedObjectIdentity[],
): void {
  if (identities.length !== object.volumes.length) {
    throw new Error('Split-to-objects identities must cover every source volume in order');
  }
  const existing = collectStableIds(state);
  const generated = new Set<string>();
  identities.forEach((identity, index) => {
    if (identity.sourceVolumeId !== object.volumes[index].id) {
      throw new Error('Split-to-objects volume identities must follow canonical source order');
    }
    if (!isStableEntityId(identity.objectId) || existing.has(identity.objectId) || generated.has(identity.objectId)) {
      throw new Error(`Generated split object ID ${identity.objectId} is not fresh and stable`);
    }
    generated.add(identity.objectId);
    if (identity.instanceIds.length !== object.instances.length) {
      throw new Error(`Generated split object ${identity.objectId} must clone every source instance`);
    }
    identity.instanceIds.forEach((instanceId) => {
      if (!isStableEntityId(instanceId) || existing.has(instanceId) || generated.has(instanceId)) {
        throw new Error(`Generated split instance ID ${instanceId} is not fresh and stable`);
      }
      generated.add(instanceId);
    });
  });
}

function promotedObject(
  source: ProjectObject,
  sourceVolume: ProjectVolume,
  identity: SeparatedObjectIdentity,
): ProjectObject {
  const volume = cloneJson(sourceVolume);
  const offset = [...volume.transform.translationMm] as Vec3;
  volume.transform = {
    ...cloneJson(volume.transform),
    translationMm: [0, 0, 0],
  };
  volume.config = {};
  delete volume.filamentId;

  const object: ProjectObject = {
    id: identity.objectId,
    name: sourceVolume.name,
    config: {
      ...cloneJson(source.config),
      ...cloneJson(sourceVolume.config),
    },
    volumes: [volume],
    instances: source.instances.map((instance, index) =>
      promotedInstance(instance, identity.instanceIds[index], offset),
    ),
    layerRanges: [],
  };
  const filamentId = sourceVolume.filamentId ?? source.filamentId;
  if (filamentId) object.filamentId = filamentId;
  return object;
}

function promotedInstance(source: ProjectInstance, id: InstanceId, volumeOffset: Vec3): ProjectInstance {
  const instance = cloneJson(source);
  instance.id = id;
  const delta = applyLinearTransform(volumeOffset, source.transform);
  instance.transform.translationMm = [
    source.transform.translationMm[0] + delta[0],
    source.transform.translationMm[1] + delta[1],
    source.transform.translationMm[2] + delta[2],
  ];
  return instance;
}

function applyLinearTransform(point: Vec3, transform: Transform): Vec3 {
  return rotateVector(transform.rotation, [
    point[0] * transform.scale[0],
    point[1] * transform.scale[1],
    point[2] * transform.scale[2],
  ]);
}

function rotateVector(quaternion: readonly [number, number, number, number], vector: Vec3): Vec3 {
  const length = Math.hypot(...quaternion);
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new Error('Split-to-objects instance rotation must be finite and non-zero');
  }
  const [x, y, z, w] = quaternion.map((value) => value / length);
  const uv: Vec3 = [y * vector[2] - z * vector[1], z * vector[0] - x * vector[2], x * vector[1] - y * vector[0]];
  const uuv: Vec3 = [y * uv[2] - z * uv[1], z * uv[0] - x * uv[2], x * uv[1] - y * uv[0]];
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}

function remapSeparatedSelection(
  before: SelectionSnapshot,
  source: ProjectObject,
  generated: readonly ProjectObject[],
): SelectionSnapshot {
  const objectRefs = generated.map((object): SelectionRef => ({ kind: 'object', id: object.id }));
  const instancesBySource = new Map<InstanceId, SelectionRef[]>();
  source.instances.forEach((instance, instanceIndex) => {
    instancesBySource.set(
      instance.id,
      generated.map((object): SelectionRef => ({ kind: 'instance', id: object.instances[instanceIndex].id })),
    );
  });
  const map = (ref: SelectionRef): SelectionRef[] => {
    if (ref.kind === 'object' && ref.id === source.id) return objectRefs;
    if (ref.kind === 'instance') return instancesBySource.get(ref.id) ?? [ref];
    return [ref];
  };
  const refs = deduplicateSelection(before.refs.flatMap(map));
  const mappedPrimary = before.primary ? map(before.primary)[0] : refs.at(-1);
  return {
    refs,
    ...(mappedPrimary ? { primary: mappedPrimary } : {}),
  };
}

function deduplicateSelection(refs: readonly SelectionRef[]): SelectionRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = selectionKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectStableIds(state: ProjectState): Set<string> {
  const ids = new Set<string>();
  ids.add(state.id);
  for (const filament of [...state.filaments.physical, ...state.filaments.mixed]) ids.add(filament.id);
  for (const plate of state.plates) {
    ids.add(plate.id);
    for (const object of plate.objects) {
      ids.add(object.id);
      for (const volume of object.volumes) ids.add(volume.id);
      for (const instance of object.instances) ids.add(instance.id);
      for (const range of object.layerRanges) ids.add(range.id);
    }
  }
  for (const code of state.customGcode) ids.add(code.id);
  for (const thumbnail of state.thumbnails) ids.add(thumbnail.id);
  return ids;
}

function assertGuard(guard: ObjectVolumeSeparationGuard): void {
  if (!isStableEntityId(guard.plateId) || !isStableEntityId(guard.objectId) || !guard.objectFingerprint) {
    throw new Error('Split-to-objects guard is malformed');
  }
}
