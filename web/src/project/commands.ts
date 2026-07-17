import { canonicalStringify, cloneProjectState } from './domain/canonical';
import type { InstanceId, ObjectId, PlateId } from './domain/ids';
import type { ProjectObject, ProjectPlate, ProjectState, Transform } from './domain/model';
import { findInstance } from './domain/selectors';
import type { CommandContext, ProjectCommand } from './history/command';

abstract class ProjectDataCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  abstract apply(context: CommandContext): void;
  abstract revert(context: CommandContext): void;
}

export class ReplaceProjectCommand extends ProjectDataCommand {
  readonly type = 'replace-project';
  private readonly next: ProjectState;
  private previous?: ProjectState;

  constructor(
    next: ProjectState,
    readonly label = 'Replace project',
  ) {
    super();
    this.next = cloneProjectState(next);
  }

  apply(context: CommandContext): void {
    this.previous = cloneProjectState(context.project.getSnapshot().state);
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

function cloneProjectStateFragment<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneProjectStateFragment) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneProjectStateFragment(child)])) as T;
}
