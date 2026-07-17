import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import {
  isStableEntityId,
  type InstanceId,
  type LayerRangeId,
  type ObjectId,
  type PlateId,
  type VolumeId,
} from '../domain/ids';
import type { JsonValue, ProjectInstance, ProjectObject, ProjectState, Transform } from '../domain/model';
import { findInstance, findObject } from '../domain/selectors';
import type { CommandBusPort } from '../history/commandBus';
import type { CommandContext, ProjectCommand } from '../history/command';
import type { SelectionRef, SelectionSnapshot } from '../selection';

abstract class ObjectLifecycleCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  abstract apply(context: CommandContext): void;
  abstract revert(context: CommandContext): void;
}

export class RenameObjectCommand extends ObjectLifecycleCommand {
  readonly type = 'rename-object';
  readonly label: string;
  private previousName?: string;

  constructor(
    private readonly objectId: ObjectId,
    private readonly nextName: string,
  ) {
    super();
    if (!nextName.trim()) throw new Error('Object name cannot be empty');
    this.nextName = nextName.trim();
    this.label = `Rename object to ${this.nextName}`;
  }

  isNoop(context: CommandContext): boolean {
    const found = requireObject(context.project.getSnapshot().state, this.objectId);
    return found.object.name === this.nextName;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireObject(state, this.objectId);
    this.previousName = found.object.name;
    found.object.name = this.nextName;
    replaceProject(context, state, this.type);
  }

  revert(context: CommandContext): void {
    if (this.previousName === undefined) throw new Error('RenameObjectCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    requireObject(state, this.objectId).object.name = this.previousName;
    replaceProject(context, state, `revert:${this.type}`);
  }
}

export class RenameInstanceCommand extends ObjectLifecycleCommand {
  readonly type = 'rename-instance';
  readonly label: string;
  private previousName?: string;
  private applied = false;

  constructor(
    private readonly instanceId: InstanceId,
    private readonly nextName: string,
  ) {
    super();
    if (!nextName.trim()) throw new Error('Instance name cannot be empty');
    this.nextName = nextName.trim();
    this.label = `Rename instance to ${this.nextName}`;
  }

  isNoop(context: CommandContext): boolean {
    return requireInstance(context.project.getSnapshot().state, this.instanceId).instance.name === this.nextName;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireInstance(state, this.instanceId);
    this.previousName = found.instance.name;
    this.applied = true;
    found.instance.name = this.nextName;
    replaceProject(context, state, this.type);
  }

  revert(context: CommandContext): void {
    if (!this.applied) throw new Error('RenameInstanceCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const instance = requireInstance(state, this.instanceId).instance;
    if (this.previousName === undefined) delete instance.name;
    else instance.name = this.previousName;
    replaceProject(context, state, `revert:${this.type}`);
  }
}

export class SetInstancePrintableCommand extends ObjectLifecycleCommand {
  readonly type = 'set-instance-printable';
  readonly label: string;
  private previous?: boolean;

  constructor(
    private readonly instanceId: InstanceId,
    private readonly printable: boolean,
  ) {
    super();
    this.label = printable ? 'Mark instance printable' : 'Mark instance unprintable';
  }

  isNoop(context: CommandContext): boolean {
    return requireInstance(context.project.getSnapshot().state, this.instanceId).instance.printable === this.printable;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const instance = requireInstance(state, this.instanceId).instance;
    this.previous = instance.printable;
    instance.printable = this.printable;
    replaceProject(context, state, this.type);
  }

  revert(context: CommandContext): void {
    if (this.previous === undefined) throw new Error('SetInstancePrintableCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    requireInstance(state, this.instanceId).instance.printable = this.previous;
    replaceProject(context, state, `revert:${this.type}`);
  }
}

export class DeleteObjectCommand extends ObjectLifecycleCommand {
  readonly type = 'delete-object';
  readonly label = 'Delete object';
  private removed?: ProjectObject;
  private plateId?: PlateId;
  private sourceIndex = -1;

  constructor(private readonly objectId: ObjectId) {
    super();
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireObject(state, this.objectId);
    const beforeSelection = context.selection.getSnapshot();
    this.plateId = found.plate.id;
    this.sourceIndex = found.plate.objects.findIndex((object) => object.id === this.objectId);
    this.removed = cloneJson(found.object);
    const removedRefs = objectSelectionKeys(found.object);
    found.plate.objects.splice(this.sourceIndex, 1);
    const fallback = nearestObjectSelection(found.plate.objects, this.sourceIndex) ?? {
      kind: 'plate' as const,
      id: found.plate.id,
    };
    replaceProject(context, state, this.type);
    repairSelectionAfterDelete(context, state, beforeSelection, removedRefs, fallback);
  }

  revert(context: CommandContext): void {
    if (!this.removed || !this.plateId || this.sourceIndex < 0) {
      throw new Error('DeleteObjectCommand has not been applied');
    }
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (findObject(state, this.objectId)) throw new Error(`Object ${this.objectId} already exists`);
    const plate = state.plates.find((candidate) => candidate.id === this.plateId);
    if (!plate) throw new Error(`Unknown plate ${this.plateId}`);
    plate.objects.splice(this.sourceIndex, 0, cloneJson(this.removed));
    replaceProject(context, state, `revert:${this.type}`);
  }

  estimateBytes(): number {
    return this.removed ? canonicalStringify(this.removed).length : 1;
  }
}

export interface IndependentObjectIds {
  objectId: ObjectId;
  volumeIds: readonly VolumeId[];
  instanceIds: readonly InstanceId[];
  layerRangeIds: readonly LayerRangeId[];
}

export interface DuplicateObjectOptions {
  destinationPlateId?: PlateId;
  name?: string;
}

/**
 * Clone an object as an independently editable graph while retaining immutable
 * mesh asset references. All stable IDs are injected by the caller.
 */
export class DuplicateObjectCommand extends ObjectLifecycleCommand {
  readonly type = 'duplicate-object';
  readonly label = 'Duplicate object';
  private duplicate?: ProjectObject;
  private resolvedDestinationId?: PlateId;
  private insertionIndex = -1;
  private readonly ids: IndependentObjectIds;
  private readonly options: DuplicateObjectOptions;

  constructor(
    private readonly sourceObjectId: ObjectId,
    ids: IndependentObjectIds,
    options: DuplicateObjectOptions = {},
  ) {
    super();
    this.ids = {
      objectId: ids.objectId,
      volumeIds: [...ids.volumeIds],
      instanceIds: [...ids.instanceIds],
      layerRangeIds: [...ids.layerRangeIds],
    };
    if (options.name !== undefined && !options.name.trim()) throw new Error('Duplicate object name cannot be empty');
    this.options = { ...options, ...(options.name ? { name: options.name.trim() } : {}) };
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const source = requireObject(state, this.sourceObjectId);
    const destinationId = this.options.destinationPlateId ?? source.plate.id;
    const destination = state.plates.find((plate) => plate.id === destinationId);
    if (!destination) throw new Error(`Unknown destination plate ${destinationId}`);

    if (!this.duplicate) this.duplicate = buildIndependentDuplicate(state, source.object, this.ids, this.options.name);
    else assertIdsAvailable(state, allObjectIds(this.duplicate));
    this.resolvedDestinationId = destinationId;
    this.insertionIndex =
      destination.id === source.plate.id
        ? source.plate.objects.findIndex((object) => object.id === source.object.id) + 1
        : destination.objects.length;
    destination.objects.splice(this.insertionIndex, 0, cloneJson(this.duplicate));
    replaceProject(context, state, this.type);
    const firstInstance = this.duplicate.instances[0];
    context.selection.set(
      firstInstance ? [{ kind: 'instance', id: firstInstance.id }] : [{ kind: 'object', id: this.duplicate.id }],
    );
  }

  revert(context: CommandContext): void {
    if (!this.duplicate || !this.resolvedDestinationId || this.insertionIndex < 0) {
      throw new Error('DuplicateObjectCommand has not been applied');
    }
    const state = cloneProjectState(context.project.getSnapshot().state);
    const destination = state.plates.find((plate) => plate.id === this.resolvedDestinationId);
    if (!destination) throw new Error(`Unknown destination plate ${this.resolvedDestinationId}`);
    const index = destination.objects.findIndex((object) => object.id === this.duplicate!.id);
    if (index < 0) throw new Error(`Duplicated object ${this.duplicate.id} is missing`);
    destination.objects.splice(index, 1);
    replaceProject(context, state, `revert:${this.type}`);
  }

  estimateBytes(): number {
    return this.duplicate ? canonicalStringify(this.duplicate).length : 1;
  }
}

export class CreateInstanceCommand extends ObjectLifecycleCommand {
  readonly type = 'create-instance';
  readonly label = 'Create instance';
  private readonly instance: ProjectInstance;
  private resolvedIndex = -1;

  constructor(
    private readonly objectId: ObjectId,
    instance: ProjectInstance,
    private readonly insertionIndex?: number,
  ) {
    super();
    this.instance = cloneJson(instance);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.objectId).object;
    assertIdsAvailable(state, [this.instance.id]);
    const index = this.insertionIndex ?? object.instances.length;
    if (!Number.isInteger(index) || index < 0 || index > object.instances.length) {
      throw new Error(`Instance insertion index ${index} is outside [0, ${object.instances.length}]`);
    }
    this.resolvedIndex = index;
    object.instances.splice(index, 0, cloneJson(this.instance));
    replaceProject(context, state, this.type);
    context.selection.set([{ kind: 'instance', id: this.instance.id }]);
  }

  revert(context: CommandContext): void {
    if (this.resolvedIndex < 0) throw new Error('CreateInstanceCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.objectId).object;
    const index = object.instances.findIndex((instance) => instance.id === this.instance.id);
    if (index < 0) throw new Error(`Instance ${this.instance.id} is already absent`);
    object.instances.splice(index, 1);
    replaceProject(context, state, `revert:${this.type}`);
  }

  estimateBytes(): number {
    return canonicalStringify(this.instance).length;
  }
}

export class DeleteInstanceCommand extends ObjectLifecycleCommand {
  readonly type = 'delete-instance';
  readonly label = 'Delete instance';
  private removed?: ProjectInstance;
  private objectId?: ObjectId;
  private sourceIndex = -1;

  constructor(private readonly instanceId: InstanceId) {
    super();
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireInstance(state, this.instanceId);
    if (found.object.instances.length <= 1) {
      throw new Error('Cannot delete the last instance; delete the object instead');
    }
    const beforeSelection = context.selection.getSnapshot();
    this.objectId = found.object.id;
    this.sourceIndex = found.object.instances.findIndex((instance) => instance.id === this.instanceId);
    this.removed = cloneJson(found.instance);
    found.object.instances.splice(this.sourceIndex, 1);
    const neighbor = found.object.instances[Math.min(this.sourceIndex, found.object.instances.length - 1)];
    const fallback: SelectionRef = neighbor
      ? { kind: 'instance', id: neighbor.id }
      : { kind: 'object', id: found.object.id };
    replaceProject(context, state, this.type);
    repairSelectionAfterDelete(context, state, beforeSelection, new Set([`instance:${this.instanceId}`]), fallback);
  }

  revert(context: CommandContext): void {
    if (!this.removed || !this.objectId || this.sourceIndex < 0) {
      throw new Error('DeleteInstanceCommand has not been applied');
    }
    const state = cloneProjectState(context.project.getSnapshot().state);
    if (findInstance(state, this.instanceId)) throw new Error(`Instance ${this.instanceId} already exists`);
    requireObject(state, this.objectId).object.instances.splice(this.sourceIndex, 0, cloneJson(this.removed));
    replaceProject(context, state, `revert:${this.type}`);
  }

  estimateBytes(): number {
    return this.removed ? canonicalStringify(this.removed).length : 1;
  }
}

export interface InstancePlacement {
  id: InstanceId;
  transform: Transform;
  name?: string;
  printable?: boolean;
  extensionData?: Record<string, JsonValue>;
}

/** Create duplicate/fill placements as one atomic undo entry. */
export function createInstancesAtTransforms(
  bus: CommandBusPort,
  objectId: ObjectId,
  placements: readonly InstancePlacement[],
  label = placements.length === 1 ? 'Duplicate instance' : `Fill ${placements.length} instances`,
): void {
  bus.transaction(label, () => {
    for (const placement of placements) {
      bus.execute(
        new CreateInstanceCommand(objectId, {
          id: placement.id,
          ...(placement.name ? { name: placement.name } : {}),
          transform: cloneJson(placement.transform),
          printable: placement.printable ?? true,
          ...(placement.extensionData ? { extensionData: cloneJson(placement.extensionData) } : {}),
        }),
      );
    }
  });
}

function buildIndependentDuplicate(
  state: ProjectState,
  source: ProjectObject,
  ids: IndependentObjectIds,
  name?: string,
): ProjectObject {
  if (ids.volumeIds.length !== source.volumes.length) {
    throw new Error(`Expected ${source.volumes.length} volume IDs, received ${ids.volumeIds.length}`);
  }
  if (ids.instanceIds.length !== source.instances.length) {
    throw new Error(`Expected ${source.instances.length} instance IDs, received ${ids.instanceIds.length}`);
  }
  if (ids.layerRangeIds.length !== source.layerRanges.length) {
    throw new Error(`Expected ${source.layerRanges.length} layer-range IDs, received ${ids.layerRangeIds.length}`);
  }
  const newIds = [ids.objectId, ...ids.volumeIds, ...ids.instanceIds, ...ids.layerRangeIds];
  assertIdsAvailable(state, newIds);
  const duplicate = cloneJson(source);
  duplicate.id = ids.objectId;
  duplicate.name = name ?? `${source.name} copy`;
  duplicate.volumes.forEach((volume, index) => {
    volume.id = ids.volumeIds[index];
  });
  duplicate.instances.forEach((instance, index) => {
    instance.id = ids.instanceIds[index];
  });
  duplicate.layerRanges.forEach((range, index) => {
    range.id = ids.layerRangeIds[index];
  });
  return duplicate;
}

function assertIdsAvailable(state: ProjectState, ids: readonly string[]): void {
  const existing = collectProjectIds(state);
  const injected = new Set<string>();
  for (const id of ids) {
    if (!isStableEntityId(id)) throw new Error(`Injected ID ${id} is not stable`);
    if (existing.has(id)) throw new Error(`Injected ID ${id} already exists in the project`);
    if (injected.has(id)) throw new Error(`Injected ID ${id} is duplicated within the operation`);
    injected.add(id);
  }
}

function collectProjectIds(state: ProjectState): Set<string> {
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

function allObjectIds(object: ProjectObject): string[] {
  return [
    object.id,
    ...object.volumes.map((volume) => volume.id),
    ...object.instances.map((instance) => instance.id),
    ...object.layerRanges.map((range) => range.id),
  ];
}

function objectSelectionKeys(object: ProjectObject): Set<string> {
  return new Set([
    `object:${object.id}`,
    ...object.volumes.map((volume) => `volume:${volume.id}`),
    ...object.instances.map((instance) => `instance:${instance.id}`),
    ...object.layerRanges.map((range) => `layer-range:${range.id}`),
  ]);
}

function nearestObjectSelection(objects: readonly ProjectObject[], deletedIndex: number): SelectionRef | undefined {
  const neighbor = objects[Math.min(deletedIndex, objects.length - 1)];
  if (!neighbor) return undefined;
  const instance = neighbor.instances[0];
  return instance ? { kind: 'instance', id: instance.id } : { kind: 'object', id: neighbor.id };
}

function repairSelectionAfterDelete(
  context: CommandContext,
  state: ProjectState,
  before: SelectionSnapshot,
  removedKeys: ReadonlySet<string>,
  fallback: SelectionRef,
): void {
  const wasRemoved = (ref: SelectionRef): boolean => removedKeys.has(selectionRefKey(ref));
  const removedWasSelected = before.refs.some(wasRemoved);
  const primaryWasRemoved = before.primary ? wasRemoved(before.primary) : removedWasSelected;
  context.selection.prune(state);
  if (!primaryWasRemoved) return;
  const after = context.selection.getSnapshot();
  const refs = after.refs.some((ref) => selectionRefKey(ref) === selectionRefKey(fallback))
    ? after.refs
    : [...after.refs, fallback];
  context.selection.set(refs, fallback);
}

function selectionRefKey(ref: SelectionRef): string {
  return ref.kind === 'project' ? 'project' : `${ref.kind}:${ref.id}`;
}

function requireObject(state: ProjectState, id: ObjectId): NonNullable<ReturnType<typeof findObject>> {
  const found = findObject(state, id);
  if (!found) throw new Error(`Unknown object ${id}`);
  return found;
}

function requireInstance(state: ProjectState, id: InstanceId): NonNullable<ReturnType<typeof findInstance>> {
  const found = findInstance(state, id);
  if (!found) throw new Error(`Unknown instance ${id}`);
  return found;
}

function replaceProject(context: CommandContext, state: ProjectState, reason: string): void {
  context.project.replaceState(state, { reason, dirtyCategories: ['projectData'] });
}
