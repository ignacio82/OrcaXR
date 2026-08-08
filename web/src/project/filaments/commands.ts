import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import {
  facetAssignmentsFromRefinement,
  facetRefinementHasSplits,
  remapFacetRefinementValues,
} from '../domain/facetRefinement';
import type { FilamentId, LayerRangeId, ObjectId, PhysicalFilamentId, VolumeId } from '../domain/ids';
import type { MixedFilament, ProjectState } from '../domain/model';
import { findLayerRange, findObject, findVolume } from '../domain/selectors';
import { assertValidProjectState } from '../domain/validation';
import type { CommandContext, ProjectCommand } from '../history/command';

export type FilamentAssignmentTarget =
  | { kind: 'object'; objectId: ObjectId }
  | { kind: 'volume'; objectId: ObjectId; volumeId: VolumeId }
  | { kind: 'layer-range'; objectId: ObjectId; layerRangeId: LayerRangeId };

export interface FilamentAssignmentChange {
  target: FilamentAssignmentTarget;
  /** null explicitly clears the local value so child scopes inherit. */
  filamentId: FilamentId | null;
}

abstract class SnapshotFilamentCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previous?: ProjectState;
  private next?: ProjectState;

  protected abstract mutate(state: ProjectState): void;

  isNoop(context: CommandContext): boolean {
    const current = context.project.getSnapshot().state;
    const next = this.buildNext(current);
    return canonicalStringify(current) === canonicalStringify(next);
  }

  apply(context: CommandContext): void {
    const current = cloneProjectState(context.project.getSnapshot().state);
    const next = this.buildNext(current);
    this.previous = current;
    this.next = next;
    context.project.replaceState(next, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error(`${this.constructor.name} has not been applied`);
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return (
      (this.previous ? canonicalStringify(this.previous).length : 0) +
      (this.next ? canonicalStringify(this.next).length : 1)
    );
  }

  private buildNext(current: ProjectState): ProjectState {
    const next = cloneProjectState(current);
    this.mutate(next);
    assertValidProjectState(next);
    return next;
  }
}

/** One atomic command for homogeneous or heterogeneous assignment scopes. */
export class SetFilamentAssignmentsCommand extends SnapshotFilamentCommand {
  readonly type: string;
  readonly label: string;
  private readonly assignments: FilamentAssignmentChange[];

  constructor(assignments: readonly FilamentAssignmentChange[], options: { type?: string; label?: string } = {}) {
    super();
    this.assignments = assignments.map((assignment) => cloneJson(assignment));
    const keys = this.assignments.map((assignment) => assignmentTargetKey(assignment.target));
    if (new Set(keys).size !== keys.length) throw new Error('Batch contains duplicate filament assignment targets');
    this.type = options.type ?? 'set-filament-assignments';
    this.label =
      options.label ?? (assignments.length === 1 ? 'Assign filament' : `Assign ${assignments.length} scopes`);
  }

  protected mutate(state: ProjectState): void {
    const destinationIds = new Set(
      this.assignments.flatMap((assignment) => (assignment.filamentId ? [assignment.filamentId] : [])),
    );
    destinationIds.forEach((id) => requireEnabledFilament(state, id));
    for (const assignment of this.assignments) applyAssignment(state, assignment);
  }
}

export class SetObjectFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'object', objectId }, filamentId }], {
      type: 'set-object-filament',
      label: filamentId ? 'Assign object filament' : 'Clear object filament',
    });
  }
}

export class SetVolumeFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, volumeId: VolumeId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'volume', objectId, volumeId }, filamentId }], {
      type: 'set-volume-filament',
      label: filamentId ? 'Assign volume filament' : 'Inherit object filament',
    });
  }
}

export class SetLayerRangeFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, layerRangeId: LayerRangeId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'layer-range', objectId, layerRangeId }, filamentId }], {
      type: 'set-layer-range-filament',
      label: filamentId ? 'Assign layer-range filament' : 'Inherit object filament',
    });
  }
}

/**
 * Rewrite one or more source filament IDs to one enabled destination without
 * deleting the source definitions. Mixed component collisions are coalesced.
 */
export class RemapFilamentsCommand extends SnapshotFilamentCommand {
  readonly type = 'remap-filaments';
  readonly label: string;
  private readonly sourceIds: FilamentId[];

  constructor(
    sourceIds: readonly FilamentId[],
    private readonly destinationId: FilamentId,
  ) {
    super();
    if (sourceIds.length === 0) throw new Error('Filament remap requires at least one source');
    if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Filament remap sources must be unique');
    if (sourceIds.includes(destinationId)) throw new Error('Filament remap cannot map a source to itself');
    this.sourceIds = [...sourceIds];
    this.label = sourceIds.length === 1 ? 'Remap filament' : `Remap ${sourceIds.length} filaments`;
  }

  protected mutate(state: ProjectState): void {
    requireEnabledFilament(state, this.destinationId);
    this.sourceIds.forEach((id) => requireFilament(state, id));
    const destinationIsPhysical = state.filaments.physical.some((filament) => filament.id === this.destinationId);
    const remapsRecipeComponent = state.filaments.mixed.some((filament) =>
      filament.components.some((component) => this.sourceIds.includes(component.filamentId)),
    );
    if (!destinationIsPhysical && remapsRecipeComponent) {
      throw new Error(
        'Mixed-filament recipe components can only be remapped to a physical filament in Snapmaker v2.3.4',
      );
    }
    const replacements = new Map<FilamentId, FilamentId>(
      this.sourceIds.map((sourceId) => [sourceId, this.destinationId]),
    );

    for (const plate of state.plates) {
      if (plate.wipeTower?.filamentId) {
        plate.wipeTower.filamentId = replacements.get(plate.wipeTower.filamentId) ?? plate.wipeTower.filamentId;
      }
      for (const object of plate.objects) {
        if (object.filamentId) object.filamentId = replacements.get(object.filamentId) ?? object.filamentId;
        for (const volume of object.volumes) {
          if (volume.filamentId) volume.filamentId = replacements.get(volume.filamentId) ?? volume.filamentId;
          const colorRefinement = volume.annotations.refinement?.color;
          if (colorRefinement) {
            const remapped = remapFacetRefinementValues(colorRefinement, (value) => replacements.get(value) ?? value);
            volume.annotations.color = facetAssignmentsFromRefinement(remapped);
            if (facetRefinementHasSplits(remapped)) volume.annotations.refinement!.color = remapped;
            else {
              delete volume.annotations.refinement!.color;
              if (Object.keys(volume.annotations.refinement!).length === 0) delete volume.annotations.refinement;
            }
          } else {
            volume.annotations.color = remapFacetColors(volume.annotations.color, replacements);
          }
        }
        for (const range of object.layerRanges) {
          if (range.filamentId) range.filamentId = replacements.get(range.filamentId) ?? range.filamentId;
        }
      }
    }
    state.filaments.mixed.forEach((filament) => remapMixedComponents(filament, replacements));
  }
}

function remapFacetColors(
  assignments: ProjectState['plates'][number]['objects'][number]['volumes'][number]['annotations']['color'],
  replacements: ReadonlyMap<FilamentId, FilamentId>,
) {
  if (!assignments.some((assignment) => replacements.has(assignment.value))) return assignments;
  const trianglesByFilament = new Map<FilamentId, Set<number>>();
  for (const assignment of assignments) {
    const filamentId = replacements.get(assignment.value) ?? assignment.value;
    const triangles = trianglesByFilament.get(filamentId) ?? new Set<number>();
    assignment.triangles.forEach((triangle) => triangles.add(triangle));
    trianglesByFilament.set(filamentId, triangles);
  }
  return [...trianglesByFilament.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, triangles]) => ({ value, triangles: [...triangles].sort((left, right) => left - right) }));
}

/**
 * Reversible tombstone semantics. Definitions and all stable references stay
 * present because canonical deletion is unsafe without a reference/GC policy.
 */
export class SetFilamentEnabledCommand extends SnapshotFilamentCommand {
  readonly type = 'set-filament-enabled';
  readonly label: string;

  constructor(
    private readonly filamentId: FilamentId,
    private readonly enabled: boolean,
    private readonly reason = 'user',
  ) {
    super();
    this.label = enabled ? 'Enable filament' : 'Disable filament';
  }

  protected mutate(state: ProjectState): void {
    const filament = requireFilament(state, this.filamentId);
    filament.enabled = this.enabled;
    if (this.enabled) {
      if (filament.extensionData?.orcaxrFilamentLifecycle !== undefined) {
        const extensionData = { ...filament.extensionData };
        delete extensionData.orcaxrFilamentLifecycle;
        filament.extensionData = Object.keys(extensionData).length > 0 ? extensionData : undefined;
      }
    } else {
      filament.extensionData = {
        ...filament.extensionData,
        orcaxrFilamentLifecycle: {
          state: 'disabled',
          reason: this.reason,
          semantics: 'tombstone-preserve-references',
        },
      };
    }
  }
}

export class DisableFilamentCommand extends SetFilamentEnabledCommand {
  constructor(filamentId: FilamentId, reason = 'user') {
    super(filamentId, false, reason);
  }
}

function applyAssignment(state: ProjectState, assignment: FilamentAssignmentChange): void {
  const { target, filamentId } = assignment;
  switch (target.kind) {
    case 'object': {
      const found = findObject(state, target.objectId);
      if (!found) throw new Error(`Unknown object ${target.objectId}`);
      if (filamentId) found.object.filamentId = filamentId;
      else delete found.object.filamentId;
      return;
    }
    case 'volume': {
      const found = findVolume(state, target.volumeId);
      if (!found) throw new Error(`Unknown volume ${target.volumeId}`);
      if (found.object.id !== target.objectId) {
        throw new Error(`Volume ${target.volumeId} is not owned by object ${target.objectId}`);
      }
      if (filamentId) found.volume.filamentId = filamentId;
      else delete found.volume.filamentId;
      return;
    }
    case 'layer-range': {
      const found = findLayerRange(state, target.layerRangeId);
      if (!found) throw new Error(`Unknown layer range ${target.layerRangeId}`);
      if (found.object.id !== target.objectId) {
        throw new Error(`Layer range ${target.layerRangeId} is not owned by object ${target.objectId}`);
      }
      if (filamentId) found.layerRange.filamentId = filamentId;
      else delete found.layerRange.filamentId;
    }
  }
}

function remapMixedComponents(filament: MixedFilament, replacements: ReadonlyMap<FilamentId, FilamentId>): void {
  if (!filament.components.some((component) => replacements.has(component.filamentId))) return;
  const gradient = filament.distribution.mode === 'gradient' ? filament.distribution : undefined;
  const groups = new Map<
    PhysicalFilamentId,
    { filamentId: PhysicalFilamentId; weight: number; startWeight: number; endWeight: number }
  >();
  filament.components.forEach((component, index) => {
    const filamentId = (replacements.get(component.filamentId) ?? component.filamentId) as PhysicalFilamentId;
    const existing = groups.get(filamentId);
    const startWeight = gradient?.startWeights[index] ?? 0;
    const endWeight = gradient?.endWeights[index] ?? 0;
    if (existing) {
      existing.weight += component.weight;
      existing.startWeight += startWeight;
      existing.endWeight += endWeight;
    } else {
      groups.set(filamentId, { filamentId, weight: component.weight, startWeight, endWeight });
    }
  });
  const merged = [...groups.values()];
  filament.components = merged.map(({ filamentId, weight }) => ({ filamentId, weight }));
  if (gradient) {
    filament.distribution = {
      ...gradient,
      startWeights: merged.map((component) => component.startWeight),
      endWeights: merged.map((component) => component.endWeight),
    };
  }
}

function requireEnabledFilament(state: ProjectState, id: FilamentId) {
  const filament = requireFilament(state, id);
  if (!filament.enabled) throw new Error(`Destination filament ${id} is disabled`);
  return filament;
}

function requireFilament(state: ProjectState, id: FilamentId) {
  const filament = [...state.filaments.physical, ...state.filaments.mixed].find((candidate) => candidate.id === id);
  if (!filament) throw new Error(`Unknown filament ${id}`);
  return filament;
}

function assignmentTargetKey(target: FilamentAssignmentTarget): string {
  switch (target.kind) {
    case 'object':
      return `object:${target.objectId}`;
    case 'volume':
      return `volume:${target.objectId}:${target.volumeId}`;
    case 'layer-range':
      return `layer-range:${target.objectId}:${target.layerRangeId}`;
  }
}
