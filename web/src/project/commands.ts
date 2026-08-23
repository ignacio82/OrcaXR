import { canonicalStringify, cloneProjectState, deepFreeze } from './domain/canonical';
import {
  isStableEntityId,
  type CustomGcodeId,
  type InstanceId,
  type LayerRangeId,
  type ObjectId,
  type PlateId,
  type ThumbnailId,
  type VolumeId,
} from './domain/ids';
import type {
  CustomGcode,
  ProjectObject,
  ProjectPlate,
  ProjectState,
  ProjectThumbnail,
  Transform,
  WipeTowerState,
} from './domain/model';
import { findInstance } from './domain/selectors';
import type { CommandContext, ProjectCommand } from './history/command';
import type { AssetPayload } from './assets';

abstract class ProjectDataCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  abstract apply(context: CommandContext): void;
  abstract revert(context: CommandContext): void;
}

/** Pinned Snapmaker Orca plate limit. Commands enforce it below every UI. */
export const MAX_PROJECT_PLATES = 36;

export class ReplaceProjectCommand extends ProjectDataCommand {
  readonly type = 'replace-project';
  private readonly next: ProjectState;
  private previous?: ProjectState;

  constructor(
    next: ProjectState,
    readonly label = 'Replace project',
  ) {
    super();
    // Frozen, so the store can adopt it without a second defensive copy and so
    // its validation and fingerprint survive to whatever reads it next.
    this.next = deepFreeze(cloneProjectState(next));
  }

  apply(context: CommandContext): void {
    // The committed state is already immutable; copying it to remember it
    // defends against nothing and, on a large project, is what made undo as
    // expensive as the edit it reverses.
    this.previous = context.project.getSnapshot().state;
    context.project.replaceState(this.next, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.prune(this.next);
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('ReplaceProjectCommand has not been applied');
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.prune(this.previous);
  }

  estimateBytes(): number {
    return canonicalStringify(this.next).length + (this.previous ? canonicalStringify(this.previous).length : 0);
  }
}

export class RenameProjectCommand extends ProjectDataCommand {
  readonly type = 'rename-project';
  readonly label: string;
  private previousName?: string;

  constructor(private readonly nextName: string) {
    super();
    if (!nextName.trim()) throw new Error('Project name cannot be empty');
    this.label = `Rename project to ${nextName}`;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    this.previousName = state.name;
    state.name = this.nextName;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (this.previousName === undefined) throw new Error('RenameProjectCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    state.name = this.previousName;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class AddPlateCommand extends ProjectDataCommand {
  readonly type = 'add-plate';
  readonly label: string;
  private readonly plate: ProjectPlate;
  private previousActivePlateId?: PlateId;

  constructor(
    plate: ProjectPlate,
    private readonly activate = true,
  ) {
    super();
    this.plate = cloneProjectStateFragment(plate);
    this.label = `Add ${plate.name}`;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (state.plates.length >= MAX_PROJECT_PLATES) {
      throw new Error(`A project cannot contain more than ${MAX_PROJECT_PLATES} plates`);
    }
    if (state.plates.some((plate) => plate.id === this.plate.id)) {
      throw new Error(`Plate ${this.plate.id} already exists`);
    }
    this.previousActivePlateId = state.activePlateId;
    state.plates.push(cloneProjectStateFragment(this.plate));
    state.plates.sort((a, b) => a.order - b.order);
    if (this.activate) state.activePlateId = this.plate.id;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    if (this.activate) context.selection.set([{ kind: 'plate', id: this.plate.id }]);
  }

  revert(context: CommandContext): void {
    if (!this.previousActivePlateId) throw new Error('AddPlateCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    state.plates = state.plates.filter((plate) => plate.id !== this.plate.id);
    state.activePlateId = this.previousActivePlateId;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export interface DuplicatePlateObjectIds {
  readonly objectId: ObjectId;
  readonly volumeIds: readonly VolumeId[];
  readonly instanceIds: readonly InstanceId[];
  readonly layerRangeIds: readonly LayerRangeId[];
}

/** Every independently editable entity ID is allocated before command execution. */
export interface DuplicatePlateIds {
  readonly plateId: PlateId;
  readonly objects: readonly DuplicatePlateObjectIds[];
  /** Omit to leave plate-scoped custom G-code uncloned; when present the count must match exactly. */
  readonly customGcodeIds?: readonly CustomGcodeId[];
  /** Omit to leave plate thumbnails uncloned; when present the count must match exactly. */
  readonly thumbnailIds?: readonly ThumbnailId[];
}

export interface DuplicatePlateOptions {
  readonly name?: string;
}

interface PreparedPlateDuplicate {
  readonly sourceFingerprint: string;
  readonly plate: ProjectPlate;
  readonly customGcode: readonly CustomGcode[];
  readonly thumbnails: readonly ProjectThumbnail[];
}

/**
 * Clone one plate into an independently editable graph while retaining every
 * immutable source-asset reference. The caller injects all fresh stable IDs.
 */
export class DuplicatePlateCommand extends ProjectDataCommand {
  readonly type = 'duplicate-plate';
  readonly label = 'Duplicate plate';
  private readonly ids: DuplicatePlateIds;
  private readonly name?: string;
  private prepared?: PreparedPlateDuplicate;
  private previous?: ProjectState;

  constructor(
    private readonly sourcePlateId: PlateId,
    ids: DuplicatePlateIds,
    options: DuplicatePlateOptions = {},
  ) {
    super();
    this.ids = {
      plateId: ids.plateId,
      objects: ids.objects.map((object) => ({
        objectId: object.objectId,
        volumeIds: [...object.volumeIds],
        instanceIds: [...object.instanceIds],
        layerRangeIds: [...object.layerRangeIds],
      })),
      ...(ids.customGcodeIds !== undefined ? { customGcodeIds: [...ids.customGcodeIds] } : {}),
      ...(ids.thumbnailIds !== undefined ? { thumbnailIds: [...ids.thumbnailIds] } : {}),
    };
    if (options.name !== undefined) {
      if (!options.name.trim()) throw new Error('Duplicate plate name cannot be empty');
      this.name = options.name.trim();
    }
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (state.plates.length >= MAX_PROJECT_PLATES) {
      throw new Error(`A project cannot contain more than ${MAX_PROJECT_PLATES} plates`);
    }
    const source = findPlateOrThrow(state, this.sourcePlateId);
    const sourceFingerprint = fingerprintPlateScope(state, this.sourcePlateId);
    if (this.prepared && this.prepared.sourceFingerprint !== sourceFingerprint) {
      throw new Error(`Source plate ${this.sourcePlateId} changed after its duplicate was prepared`);
    }
    const prepared = this.prepared ?? preparePlateDuplicate(state, source, this.ids, this.name, sourceFingerprint);
    assertInjectedIdsAvailable(state, preparedDuplicateIds(prepared));

    const previous = cloneProjectState(state);
    const sourceBytes = canonicalStringify(source);
    insertPreparedPlate(state, this.sourcePlateId, prepared.plate);
    state.customGcode = insertPlateScopedCustomGcode(state.customGcode, this.sourcePlateId, prepared.customGcode);
    state.thumbnails = insertPlateScopedThumbnails(state.thumbnails, this.sourcePlateId, prepared.thumbnails);
    state.activePlateId = prepared.plate.id;
    if (canonicalStringify(findPlateOrThrow(state, this.sourcePlateId)) !== sourceBytes) {
      throw new Error(`Source plate ${this.sourcePlateId} changed while preparing its duplicate`);
    }

    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    context.selection.set([{ kind: 'plate', id: prepared.plate.id }]);
    this.previous = previous;
    this.prepared = prepared;
  }

  revert(context: CommandContext): void {
    if (!this.previous || !this.prepared) throw new Error('DuplicatePlateCommand has not been applied');
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.prune(this.previous);
  }

  estimateBytes(): number {
    return (
      (this.previous ? canonicalStringify(this.previous).length : 0) +
      (this.prepared ? canonicalStringify(this.prepared).length : 1)
    );
  }
}

/** Delete one plate together with metadata whose declared scope is that plate. */
export class DeletePlateCommand extends ProjectDataCommand {
  readonly type = 'delete-plate';
  readonly label = 'Delete plate';
  private previous?: ProjectState;

  constructor(private readonly plateId: PlateId) {
    super();
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (state.plates.length <= 1) throw new Error('Cannot delete the last plate');
    const ordered = [...state.plates].sort((left, right) => left.order - right.order);
    const index = ordered.findIndex((plate) => plate.id === this.plateId);
    if (index < 0) throw new Error(`Unknown plate ${this.plateId}`);

    this.previous = cloneProjectState(state);
    ordered.splice(index, 1);
    ordered.forEach((plate, order) => {
      plate.order = order;
    });
    state.plates = ordered;
    state.customGcode = state.customGcode.filter((entry) => entry.plateId !== this.plateId);
    state.thumbnails = state.thumbnails.filter((thumbnail) => thumbnail.plateId !== this.plateId);
    if (state.activePlateId === this.plateId) {
      state.activePlateId = ordered[Math.min(index, ordered.length - 1)].id;
    }

    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    context.selection.prune(state);
    if (context.selection.getSnapshot().refs.length === 0) {
      context.selection.set([{ kind: 'plate', id: state.activePlateId }]);
    }
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('DeletePlateCommand has not been applied');
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.prune(this.previous);
  }

  estimateBytes(): number {
    return this.previous ? canonicalStringify(this.previous).length : 1;
  }
}

export class SetActivePlateCommand extends ProjectDataCommand {
  readonly type = 'set-active-plate';
  readonly label = 'Change active plate';
  private previous?: PlateId;

  constructor(private readonly plateId: PlateId) {
    super();
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (!state.plates.some((plate) => plate.id === this.plateId)) {
      throw new Error(`Unknown plate ${this.plateId}`);
    }
    this.previous = state.activePlateId;
    state.activePlateId = this.plateId;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    context.selection.set([{ kind: 'plate', id: this.plateId }]);
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('SetActivePlateCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    state.activePlateId = this.previous;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class RenamePlateCommand extends ProjectDataCommand {
  readonly type = 'rename-plate';
  readonly label: string;
  private previousName?: string;

  constructor(
    private readonly plateId: PlateId,
    private readonly nextName: string,
  ) {
    super();
    if (!nextName.trim()) throw new Error('Plate name cannot be empty');
    this.label = `Rename plate to ${nextName}`;
  }

  isNoop(context: CommandContext): boolean {
    return findPlateOrThrow(context.project.getSnapshot().state, this.plateId).name === this.nextName;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = findPlateOrThrow(state, this.plateId);
    this.previousName = plate.name;
    plate.name = this.nextName;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (this.previousName === undefined) throw new Error('RenamePlateCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    findPlateOrThrow(state, this.plateId).name = this.previousName;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class SetPlatePrintableCommand extends ProjectDataCommand {
  readonly type = 'set-plate-printable';
  readonly label: string;
  private previousPrintable?: boolean;

  constructor(
    private readonly plateId: PlateId,
    private readonly printable: boolean,
  ) {
    super();
    this.label = printable ? 'Include plate in printing' : 'Exclude plate from printing';
  }

  isNoop(context: CommandContext): boolean {
    return findPlateOrThrow(context.project.getSnapshot().state, this.plateId).printable === this.printable;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = findPlateOrThrow(state, this.plateId);
    this.previousPrintable = plate.printable;
    plate.printable = this.printable;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (this.previousPrintable === undefined) throw new Error('SetPlatePrintableCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    findPlateOrThrow(state, this.plateId).printable = this.previousPrintable;
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class SetPlateWipeTowerCommand extends ProjectDataCommand {
  readonly type = 'set-plate-wipe-tower';
  readonly label: string;
  private readonly nextWipeTower?: WipeTowerState;
  private previousWipeTower?: WipeTowerState;

  constructor(
    private readonly plateId: PlateId,
    wipeTower?: WipeTowerState,
    label?: string,
  ) {
    super();
    this.nextWipeTower = wipeTower ? cloneProjectStateFragment(wipeTower) : undefined;
    this.label = label ?? (wipeTower?.enabled ? 'Auto-place wipe tower' : 'Update wipe tower');
  }

  isNoop(context: CommandContext): boolean {
    const plate = findPlateOrThrow(context.project.getSnapshot().state, this.plateId);
    return canonicalStringify(plate.wipeTower ?? null) === canonicalStringify(this.nextWipeTower ?? null);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = findPlateOrThrow(state, this.plateId);
    this.previousWipeTower = plate.wipeTower ? cloneProjectStateFragment(plate.wipeTower) : undefined;
    if (this.nextWipeTower) {
      plate.wipeTower = cloneProjectStateFragment(this.nextWipeTower);
    } else {
      delete plate.wipeTower;
    }
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = findPlateOrThrow(state, this.plateId);
    if (this.previousWipeTower) {
      plate.wipeTower = cloneProjectStateFragment(this.previousWipeTower);
    } else {
      delete plate.wipeTower;
    }
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return 128;
  }
}

export class ReorderPlatesCommand extends ProjectDataCommand {
  readonly type = 'reorder-plates';
  readonly label = 'Reorder plates';
  private readonly orderedPlateIds: readonly PlateId[];
  private previousOrder?: readonly PlateId[];

  constructor(orderedPlateIds: readonly PlateId[]) {
    super();
    if (new Set(orderedPlateIds).size !== orderedPlateIds.length) {
      throw new Error('Plate order cannot contain duplicate IDs');
    }
    this.orderedPlateIds = Object.freeze([...orderedPlateIds]);
  }

  isNoop(context: CommandContext): boolean {
    const state = context.project.getSnapshot().state;
    assertPlatePermutation(state, this.orderedPlateIds);
    return orderedPlateIds(state).every((id, index) => id === this.orderedPlateIds[index]);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    assertPlatePermutation(state, this.orderedPlateIds);
    this.previousOrder = orderedPlateIds(state);
    applyPlateOrder(state, this.orderedPlateIds);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previousOrder) throw new Error('ReorderPlatesCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    assertPlatePermutation(state, this.previousOrder);
    applyPlateOrder(state, this.previousOrder);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class AddObjectCommand extends ProjectDataCommand {
  readonly type = 'add-object';
  readonly label: string;
  private readonly object: ProjectObject;

  constructor(
    private readonly plateId: PlateId,
    object: ProjectObject,
  ) {
    super();
    this.object = cloneProjectStateFragment(object);
    this.label = `Add ${object.name}`;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = state.plates.find((candidate) => candidate.id === this.plateId);
    if (!plate) throw new Error(`Unknown plate ${this.plateId}`);
    if (state.plates.some((candidate) => candidate.objects.some((entry) => entry.id === this.object.id))) {
      throw new Error(`Object ${this.object.id} already exists`);
    }
    plate.objects.push(cloneProjectStateFragment(this.object));
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    const firstInstance = this.object.instances[0];
    context.selection.set(
      firstInstance ? [{ kind: 'instance', id: firstInstance.id }] : [{ kind: 'object', id: this.object.id }],
    );
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = state.plates.find((candidate) => candidate.id === this.plateId);
    if (!plate) throw new Error(`Unknown plate ${this.plateId}`);
    if (!plate.objects.some((entry) => entry.id === this.object.id)) {
      throw new Error(`Object ${this.object.id} is already absent`);
    }
    plate.objects = plate.objects.filter((entry) => entry.id !== this.object.id);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

/**
 * Add an object and its immutable mesh payload through one atomic command.
 * Callers must remap digest duplicates to the existing stable asset ID before
 * construction; the command rejects ambiguous duplicate IDs instead of
 * silently creating a second canonical asset.
 */
export class AddObjectWithAssetCommand extends ProjectDataCommand {
  readonly type = 'add-object-with-asset';
  readonly label: string;
  private readonly object: ProjectObject;
  private readonly asset: AssetPayload;
  private insertedAsset = false;

  constructor(
    private readonly plateId: PlateId,
    object: ProjectObject,
    asset: AssetPayload,
  ) {
    super();
    this.object = cloneProjectStateFragment(object);
    this.asset = {
      descriptor: cloneProjectStateFragment(asset.descriptor),
      bytes: asset.bytes.slice(),
    };
    if (!object.volumes.some((volume) => volume.source.assetId === asset.descriptor.id)) {
      throw new Error(`Object ${object.id} does not reference asset ${asset.descriptor.id}`);
    }
    this.label = `Add ${object.name}`;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = state.plates.find((candidate) => candidate.id === this.plateId);
    if (!plate) throw new Error(`Unknown plate ${this.plateId}`);
    if (state.plates.some((candidate) => candidate.objects.some((entry) => entry.id === this.object.id))) {
      throw new Error(`Object ${this.object.id} already exists`);
    }

    const descriptor = state.sourceAssets.find((entry) => entry.id === this.asset.descriptor.id);
    const repositoryEntry = context.assets.get(this.asset.descriptor.id);
    if (Boolean(descriptor) !== Boolean(repositoryEntry)) {
      throw new Error(`Asset ${this.asset.descriptor.id} is not declared consistently in the canonical bundle`);
    }

    const inserting = !descriptor;
    if (descriptor) {
      if (canonicalStringify(descriptor) !== canonicalStringify(this.asset.descriptor)) {
        throw new Error(`Asset ${this.asset.descriptor.id} metadata does not match its canonical declaration`);
      }
      context.assets.put(this.asset.descriptor, this.asset.bytes);
    } else {
      const duplicate = state.sourceAssets.find((entry) => entry.digest === this.asset.descriptor.digest);
      if (duplicate) {
        throw new Error(`Asset digest already exists as ${duplicate.id}; remap the object before adding it`);
      }
      const repositoryDuplicate = context.assets.findByDigest(this.asset.descriptor.digest);
      if (repositoryDuplicate) {
        throw new Error(`Asset ${repositoryDuplicate.descriptor.id} exists outside the declared project bundle`);
      }
      context.assets.put(this.asset.descriptor, this.asset.bytes);
      state.sourceAssets.push(cloneProjectStateFragment(this.asset.descriptor));
    }

    plate.objects.push(cloneProjectStateFragment(this.object));
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    this.insertedAsset = inserting;
    const firstInstance = this.object.instances[0];
    context.selection.set(
      firstInstance ? [{ kind: 'instance', id: firstInstance.id }] : [{ kind: 'object', id: this.object.id }],
    );
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const plate = state.plates.find((candidate) => candidate.id === this.plateId);
    if (!plate) throw new Error(`Unknown plate ${this.plateId}`);
    const objectIndex = plate.objects.findIndex((entry) => entry.id === this.object.id);
    if (objectIndex < 0) throw new Error(`Object ${this.object.id} is already absent`);
    plate.objects.splice(objectIndex, 1);

    const removeOwnedAsset = this.insertedAsset && !projectReferencesAsset(state, this.asset.descriptor.id);
    if (removeOwnedAsset) {
      state.sourceAssets = state.sourceAssets.filter((entry) => entry.id !== this.asset.descriptor.id);
    }
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    if (removeOwnedAsset) context.assets.remove(this.asset.descriptor.id);
  }

  estimateBytes(): number {
    return canonicalStringify(this.object).length + this.asset.bytes.byteLength;
  }
}

export class MoveObjectToPlateCommand extends ProjectDataCommand {
  readonly type = 'move-object-to-plate';
  readonly label = 'Move object to plate';
  private sourcePlateId?: PlateId;
  private sourceIndex = -1;

  constructor(
    private readonly objectId: ObjectId,
    private readonly destinationPlateId: PlateId,
  ) {
    super();
  }

  isNoop(context: CommandContext): boolean {
    const state = context.project.getSnapshot().state;
    const source = state.plates.find((plate) => plate.objects.some((object) => object.id === this.objectId));
    const destination = state.plates.find((plate) => plate.id === this.destinationPlateId);
    if (!source || !destination) throw new Error('Object source or destination plate is missing');
    return source.id === destination.id;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const source = state.plates.find((plate) => plate.objects.some((object) => object.id === this.objectId));
    const destination = state.plates.find((plate) => plate.id === this.destinationPlateId);
    if (!source || !destination) throw new Error('Object source or destination plate is missing');
    this.sourcePlateId = source.id;
    this.sourceIndex = source.objects.findIndex((object) => object.id === this.objectId);
    const [object] = source.objects.splice(this.sourceIndex, 1);
    destination.objects.push(object);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.sourcePlateId || this.sourceIndex < 0) {
      throw new Error('MoveObjectToPlateCommand has not been applied');
    }
    const state = cloneProjectState(context.project.getSnapshot().state);
    const source = state.plates.find((plate) => plate.id === this.sourcePlateId);
    const destination = state.plates.find((plate) => plate.id === this.destinationPlateId);
    if (!source || !destination) throw new Error('Object source or destination plate is missing');
    const destinationIndex = destination.objects.findIndex((object) => object.id === this.objectId);
    if (destinationIndex < 0) throw new Error(`Object ${this.objectId} is missing from destination`);
    const [object] = destination.objects.splice(destinationIndex, 1);
    source.objects.splice(this.sourceIndex, 0, object);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export class SetInstanceTransformCommand extends ProjectDataCommand {
  readonly type = 'set-instance-transform';
  readonly label = 'Transform instance';
  readonly coalesceKey: string;
  private readonly nextTransform: Transform;
  private previousTransform?: Transform;

  constructor(
    private readonly instanceId: InstanceId,
    nextTransform: Transform,
    private readonly gestureId = 'default',
  ) {
    super();
    this.nextTransform = cloneProjectStateFragment(nextTransform);
    this.coalesceKey = `${this.type}:${instanceId}:${gestureId}`;
  }

  isNoop(context: CommandContext): boolean {
    const found = findInstance(context.project.getSnapshot().state, this.instanceId);
    if (!found) throw new Error(`Unknown instance ${this.instanceId}`);
    return canonicalStringify(found.instance.transform) === canonicalStringify(this.nextTransform);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findInstance(state, this.instanceId);
    if (!found) throw new Error(`Unknown instance ${this.instanceId}`);
    this.previousTransform = cloneProjectStateFragment(found.instance.transform);
    found.instance.transform = cloneProjectStateFragment(this.nextTransform);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previousTransform) throw new Error('SetInstanceTransformCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findInstance(state, this.instanceId);
    if (!found) throw new Error(`Unknown instance ${this.instanceId}`);
    found.instance.transform = cloneProjectStateFragment(this.previousTransform);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  mergeWith(next: ProjectCommand): ProjectCommand | undefined {
    if (!(next instanceof SetInstanceTransformCommand) || next.coalesceKey !== this.coalesceKey) {
      return undefined;
    }
    const merged = new SetInstanceTransformCommand(this.instanceId, next.nextTransform, this.gestureId);
    // Preserve the beginning of the gesture; apply() will refresh it on redo.
    merged.previousTransform = this.previousTransform ? cloneProjectStateFragment(this.previousTransform) : undefined;
    return merged;
  }

  estimateBytes(): number {
    return 256;
  }
}

function findPlateOrThrow(state: ProjectState, plateId: PlateId): ProjectPlate {
  const plate = state.plates.find((candidate) => candidate.id === plateId);
  if (!plate) throw new Error(`Unknown plate ${plateId}`);
  return plate;
}

function preparePlateDuplicate(
  state: ProjectState,
  source: ProjectPlate,
  ids: DuplicatePlateIds,
  name: string | undefined,
  sourceFingerprint: string,
): PreparedPlateDuplicate {
  if (!source.name.trim()) throw new Error(`Source plate ${source.id} has an empty name and cannot be duplicated`);
  if (ids.objects.length !== source.objects.length) {
    throw new Error(
      `Duplicate plate ID plan has ${ids.objects.length} object mappings; source plate requires ${source.objects.length}`,
    );
  }
  source.objects.forEach((object, index) => {
    const injected = ids.objects[index];
    if (!injected) throw new Error(`Duplicate plate ID plan is missing object mapping ${index}`);
    assertExactInjectedIdCount('volume', object.volumes.length, injected.volumeIds.length, index);
    assertExactInjectedIdCount('instance', object.instances.length, injected.instanceIds.length, index);
    assertExactInjectedIdCount('layer-range', object.layerRanges.length, injected.layerRangeIds.length, index);
  });

  const sourceCustomGcode = state.customGcode.filter((entry) => entry.scope === 'plate' && entry.plateId === source.id);
  const sourceThumbnails = state.thumbnails.filter((thumbnail) => thumbnail.plateId === source.id);
  if (ids.customGcodeIds !== undefined && ids.customGcodeIds.length !== sourceCustomGcode.length) {
    throw new Error(
      `Duplicate plate ID plan has ${ids.customGcodeIds.length} custom G-code IDs; source plate requires ${sourceCustomGcode.length}`,
    );
  }
  if (ids.thumbnailIds !== undefined && ids.thumbnailIds.length !== sourceThumbnails.length) {
    throw new Error(
      `Duplicate plate ID plan has ${ids.thumbnailIds.length} thumbnail IDs; source plate requires ${sourceThumbnails.length}`,
    );
  }

  const injectedIds = duplicatePlatePlanIds(ids);
  assertInjectedIdsAvailable(state, injectedIds);
  const duplicate = cloneProjectStateFragment(source);
  duplicate.id = ids.plateId;
  duplicate.name = name ?? `${source.name} copy`;
  duplicate.objects.forEach((object, index) => {
    const injected = ids.objects[index]!;
    object.id = injected.objectId;
    object.volumes.forEach((volume, volumeIndex) => {
      volume.id = injected.volumeIds[volumeIndex]!;
    });
    object.instances.forEach((instance, instanceIndex) => {
      instance.id = injected.instanceIds[instanceIndex]!;
    });
    object.layerRanges.forEach((range, rangeIndex) => {
      range.id = injected.layerRangeIds[rangeIndex]!;
    });
  });

  const customGcode = ids.customGcodeIds
    ? sourceCustomGcode.map((entry, index) => ({
        ...cloneProjectStateFragment(entry),
        id: ids.customGcodeIds![index]!,
        plateId: ids.plateId,
      }))
    : [];
  const thumbnails = ids.thumbnailIds
    ? sourceThumbnails.map((thumbnail, index) => ({
        ...cloneProjectStateFragment(thumbnail),
        id: ids.thumbnailIds![index]!,
        plateId: ids.plateId,
      }))
    : [];
  return {
    sourceFingerprint,
    plate: duplicate,
    customGcode,
    thumbnails,
  };
}

function assertExactInjectedIdCount(kind: string, expected: number, actual: number, objectIndex: number): void {
  if (actual !== expected) {
    throw new Error(
      `Duplicate plate ID plan has ${actual} ${kind} IDs for object ${objectIndex}; source object requires ${expected}`,
    );
  }
}

function fingerprintPlateScope(state: ProjectState, plateId: PlateId): string {
  return canonicalStringify({
    plate: findPlateOrThrow(state, plateId),
    customGcode: state.customGcode.filter((entry) => entry.scope === 'plate' && entry.plateId === plateId),
    thumbnails: state.thumbnails.filter((thumbnail) => thumbnail.plateId === plateId),
  });
}

function duplicatePlatePlanIds(ids: DuplicatePlateIds): string[] {
  return [
    ids.plateId,
    ...ids.objects.flatMap((object) => [
      object.objectId,
      ...object.volumeIds,
      ...object.instanceIds,
      ...object.layerRangeIds,
    ]),
    ...(ids.customGcodeIds ?? []),
    ...(ids.thumbnailIds ?? []),
  ];
}

function preparedDuplicateIds(prepared: PreparedPlateDuplicate): string[] {
  return [
    prepared.plate.id,
    ...prepared.plate.objects.flatMap((object) => [
      object.id,
      ...object.volumes.map((volume) => volume.id),
      ...object.instances.map((instance) => instance.id),
      ...object.layerRanges.map((range) => range.id),
    ]),
    ...prepared.customGcode.map((entry) => entry.id),
    ...prepared.thumbnails.map((thumbnail) => thumbnail.id),
  ];
}

function assertInjectedIdsAvailable(state: ProjectState, ids: readonly string[]): void {
  const existing = collectCanonicalEntityIds(state);
  const injected = new Set<string>();
  for (const id of ids) {
    if (!isStableEntityId(id)) throw new Error(`Injected ID ${id} is not stable`);
    if (existing.has(id)) throw new Error(`Injected ID ${id} already exists in the project`);
    if (injected.has(id)) throw new Error(`Injected ID ${id} is duplicated within the plate duplicate`);
    injected.add(id);
  }
}

function collectCanonicalEntityIds(state: ProjectState): Set<string> {
  const ids = new Set<string>([state.id]);
  for (const plate of state.plates) {
    ids.add(plate.id);
    for (const object of plate.objects) {
      ids.add(object.id);
      object.volumes.forEach((volume) => ids.add(volume.id));
      object.instances.forEach((instance) => ids.add(instance.id));
      object.layerRanges.forEach((range) => ids.add(range.id));
    }
  }
  state.filaments.physical.forEach((filament) => ids.add(filament.id));
  state.filaments.mixed.forEach((filament) => ids.add(filament.id));
  state.sourceAssets.forEach((asset) => ids.add(asset.id));
  state.customGcode.forEach((entry) => ids.add(entry.id));
  state.thumbnails.forEach((thumbnail) => ids.add(thumbnail.id));
  state.extensionBlobs.forEach((blob) => ids.add(blob.id));
  return ids;
}

function insertPreparedPlate(state: ProjectState, sourcePlateId: PlateId, prepared: ProjectPlate): void {
  const ordered = [...state.plates].sort((left, right) => left.order - right.order);
  const sourceIndex = ordered.findIndex((plate) => plate.id === sourcePlateId);
  if (sourceIndex < 0) throw new Error(`Unknown plate ${sourcePlateId}`);
  ordered.splice(sourceIndex + 1, 0, cloneProjectStateFragment(prepared));
  ordered.forEach((plate, index) => {
    plate.order = index;
  });
  state.plates = ordered;
}

function insertPlateScopedCustomGcode(
  entries: readonly CustomGcode[],
  sourcePlateId: PlateId,
  clones: readonly CustomGcode[],
): CustomGcode[] {
  if (clones.length === 0) return entries.map(cloneProjectStateFragment);
  const result: CustomGcode[] = [];
  let cloneIndex = 0;
  for (const entry of entries) {
    result.push(cloneProjectStateFragment(entry));
    if (entry.scope === 'plate' && entry.plateId === sourcePlateId) {
      const clone = clones[cloneIndex];
      if (!clone) throw new Error('Prepared plate duplicate is missing a custom G-code clone');
      result.push(cloneProjectStateFragment(clone));
      cloneIndex += 1;
    }
  }
  if (cloneIndex !== clones.length) throw new Error('Prepared plate duplicate has excess custom G-code clones');
  return result;
}

function insertPlateScopedThumbnails(
  entries: readonly ProjectThumbnail[],
  sourcePlateId: PlateId,
  clones: readonly ProjectThumbnail[],
): ProjectThumbnail[] {
  if (clones.length === 0) return entries.map(cloneProjectStateFragment);
  const result: ProjectThumbnail[] = [];
  let cloneIndex = 0;
  for (const entry of entries) {
    result.push(cloneProjectStateFragment(entry));
    if (entry.plateId === sourcePlateId) {
      const clone = clones[cloneIndex];
      if (!clone) throw new Error('Prepared plate duplicate is missing a thumbnail clone');
      result.push(cloneProjectStateFragment(clone));
      cloneIndex += 1;
    }
  }
  if (cloneIndex !== clones.length) throw new Error('Prepared plate duplicate has excess thumbnail clones');
  return result;
}

function orderedPlateIds(state: ProjectState): PlateId[] {
  return [...state.plates].sort((left, right) => left.order - right.order).map((plate) => plate.id);
}

function assertPlatePermutation(state: ProjectState, order: readonly PlateId[]): void {
  const expected = new Set(state.plates.map((plate) => plate.id));
  if (order.length !== expected.size || order.some((plateId) => !expected.has(plateId))) {
    throw new Error('Plate order must contain every project plate exactly once');
  }
}

function applyPlateOrder(state: ProjectState, order: readonly PlateId[]): void {
  const byId = new Map(state.plates.map((plate) => [plate.id, plate]));
  state.plates = order.map((plateId, index) => {
    const plate = byId.get(plateId);
    if (!plate) throw new Error(`Unknown plate ${plateId}`);
    plate.order = index;
    return plate;
  });
}

function cloneProjectStateFragment<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneProjectStateFragment) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneProjectStateFragment(child)])) as T;
}

function projectReferencesAsset(state: ProjectState, assetId: string): boolean {
  return (
    state.plates.some((plate) =>
      plate.objects.some((object) => object.volumes.some((volume) => volume.source.assetId === assetId)),
    ) ||
    state.thumbnails.some((thumbnail) => thumbnail.assetId === assetId) ||
    state.extensionBlobs.some((blob) => blob.assetId === assetId)
  );
}
