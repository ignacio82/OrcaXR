import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type FilamentId, type MixedFilamentId, type PhysicalFilamentId } from '../domain/ids';
import type { ConfigMap, MixedComponent, MixedDistribution, MixedFilament, ProjectState } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import type { CommandContext, ProjectCommand } from '../history/command';

abstract class MixedSnapshotCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previous?: ProjectState;
  private next?: ProjectState;

  protected abstract mutate(state: ProjectState): void;

  isNoop(context: CommandContext): boolean {
    const current = context.project.getSnapshot().state;
    return canonicalStringify(current) === canonicalStringify(this.buildNext(current));
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

export class AddMixedFilamentCommand extends MixedSnapshotCommand {
  readonly type = 'add-mixed-filament';
  readonly label: string;
  private readonly filament: MixedFilament;

  constructor(filament: MixedFilament) {
    super();
    this.filament = cloneJson(filament);
    this.label = `Add ${filament.name}`;
  }

  protected mutate(state: ProjectState): void {
    assertNewMixedId(state, this.filament.id);
    validateNewRecipeComponents(state, this.filament.components);
    validateRecipeShape(this.filament);
    state.filaments.mixed.push(cloneJson(this.filament));
  }
}

export interface EditMixedFilamentPatch {
  name?: string;
  displayColor?: string;
  components?: readonly MixedComponent[];
  distribution?: MixedDistribution;
  config?: ConfigMap;
}

export class EditMixedFilamentCommand extends MixedSnapshotCommand {
  readonly type = 'edit-mixed-filament';
  readonly label = 'Edit mixed filament';
  private readonly patch: EditMixedFilamentPatch;

  constructor(
    private readonly filamentId: MixedFilamentId,
    patch: EditMixedFilamentPatch,
  ) {
    super();
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('Mixed filament name cannot be empty');
    if (patch.displayColor !== undefined && !patch.displayColor.trim()) {
      throw new Error('Mixed filament display color cannot be empty');
    }
    this.patch = cloneJson(patch);
    if (this.patch.name) this.patch.name = this.patch.name.trim();
    if (this.patch.displayColor) this.patch.displayColor = this.patch.displayColor.trim();
  }

  protected mutate(state: ProjectState): void {
    const filament = requireMixedFilament(state, this.filamentId);
    if (this.patch.components) {
      validateNewRecipeComponents(state, this.patch.components);
      filament.components = this.patch.components.map((component) => cloneJson(component));
    }
    if (this.patch.name !== undefined) filament.name = this.patch.name;
    if (this.patch.displayColor !== undefined) filament.displayColor = this.patch.displayColor;
    if (this.patch.distribution !== undefined) filament.distribution = cloneJson(this.patch.distribution);
    if (this.patch.config !== undefined) filament.config = cloneJson(this.patch.config);
    validateRecipeShape(filament);
  }
}

export class RenameMixedFilamentCommand extends EditMixedFilamentCommand {
  constructor(filamentId: MixedFilamentId, name: string) {
    super(filamentId, { name });
  }
}

export class SetMixedFilamentDistributionCommand extends EditMixedFilamentCommand {
  constructor(filamentId: MixedFilamentId, distribution: MixedDistribution) {
    super(filamentId, { distribution });
  }
}

export class SetMixedFilamentComponentsCommand extends EditMixedFilamentCommand {
  constructor(filamentId: MixedFilamentId, components: readonly MixedComponent[]) {
    super(filamentId, { components });
  }
}

export class DuplicateMixedFilamentCommand extends MixedSnapshotCommand {
  readonly type = 'duplicate-mixed-filament';
  readonly label = 'Duplicate mixed filament';

  constructor(
    private readonly sourceId: MixedFilamentId,
    private readonly duplicateId: MixedFilamentId,
    private readonly duplicateName?: string,
  ) {
    super();
    if (duplicateName !== undefined && !duplicateName.trim()) {
      throw new Error('Duplicate mixed filament name cannot be empty');
    }
  }

  protected mutate(state: ProjectState): void {
    const source = requireMixedFilament(state, this.sourceId);
    assertNewMixedId(state, this.duplicateId);
    validateNewRecipeComponents(state, source.components);
    validateRecipeShape(source);
    const duplicate = cloneJson(source);
    duplicate.id = this.duplicateId;
    duplicate.name = this.duplicateName?.trim() ?? `${source.name} copy`;
    const sourceIndex = state.filaments.mixed.findIndex((candidate) => candidate.id === source.id);
    state.filaments.mixed.splice(sourceIndex + 1, 0, duplicate);
  }
}

export class SetMixedFilamentEnabledCommand extends MixedSnapshotCommand {
  readonly type = 'set-mixed-filament-enabled';
  readonly label: string;

  constructor(
    private readonly filamentId: MixedFilamentId,
    private readonly enabled: boolean,
    private readonly reason = 'user',
  ) {
    super();
    this.label = enabled ? 'Enable mixed filament' : 'Disable mixed filament';
  }

  protected mutate(state: ProjectState): void {
    const filament = requireMixedFilament(state, this.filamentId);
    if (this.enabled) {
      validateNewRecipeComponents(state, filament.components);
      validateRecipeShape(filament);
    }
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

export class DisableMixedFilamentCommand extends SetMixedFilamentEnabledCommand {
  constructor(filamentId: MixedFilamentId, reason = 'user') {
    super(filamentId, false, reason);
  }
}

export class EnableMixedFilamentCommand extends SetMixedFilamentEnabledCommand {
  constructor(filamentId: MixedFilamentId) {
    super(filamentId, true);
  }
}

export class MixedFilamentInUseError extends Error {
  constructor(
    readonly filamentId: MixedFilamentId,
    readonly dependentPaths: readonly string[],
  ) {
    super(`Mixed filament ${filamentId} is still referenced by: ${dependentPaths.join(', ')}`);
    this.name = 'MixedFilamentInUseError';
  }
}

/** Remove only after a complete canonical dependency scan proves safety. */
export class RemoveMixedFilamentCommand implements ProjectCommand {
  readonly type = 'remove-mixed-filament';
  readonly label = 'Remove mixed filament';
  readonly dirtyCategories = ['projectData'] as const;
  private previous?: ProjectState;
  private removed?: MixedFilament;
  private sourceIndex = -1;

  constructor(private readonly filamentId: MixedFilamentId) {}

  apply(context: CommandContext): void {
    const previous = cloneProjectState(context.project.getSnapshot().state);
    const next = cloneProjectState(previous);
    const filament = requireMixedFilament(next, this.filamentId);
    const dependentPaths = findFilamentDependentPaths(next, this.filamentId);
    if (dependentPaths.length > 0) throw new MixedFilamentInUseError(this.filamentId, dependentPaths);
    this.previous = previous;
    this.removed = cloneJson(filament);
    this.sourceIndex = next.filaments.mixed.findIndex((candidate) => candidate.id === this.filamentId);
    next.filaments.mixed.splice(this.sourceIndex, 1);
    assertValidProjectState(next);
    context.project.replaceState(next, { reason: this.type, dirtyCategories: this.dirtyCategories });
    context.selection.prune(next);
  }

  revert(context: CommandContext): void {
    if (!this.previous || !this.removed || this.sourceIndex < 0) {
      throw new Error('RemoveMixedFilamentCommand has not been applied');
    }
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return this.previous ? canonicalStringify(this.previous).length : 1;
  }
}

/** Exact, deterministic canonical dependency paths used by safe removal UX. */
export function findFilamentDependentPaths(state: ProjectState, filamentId: FilamentId): string[] {
  const paths: string[] = [];
  state.plates.forEach((plate, plateIndex) => {
    if (plate.wipeTower?.filamentId === filamentId) {
      paths.push(`plates[${plateIndex}].wipeTower.filamentId`);
    }
    plate.objects.forEach((object, objectIndex) => {
      const objectPath = `plates[${plateIndex}].objects[${objectIndex}]`;
      if (object.filamentId === filamentId) paths.push(`${objectPath}.filamentId`);
      object.volumes.forEach((volume, volumeIndex) => {
        const volumePath = `${objectPath}.volumes[${volumeIndex}]`;
        if (volume.filamentId === filamentId) paths.push(`${volumePath}.filamentId`);
        volume.annotations.color.forEach((assignment, assignmentIndex) => {
          if (assignment.value === filamentId) {
            paths.push(`${volumePath}.annotations.color[${assignmentIndex}].value`);
          }
        });
      });
      object.layerRanges.forEach((range, rangeIndex) => {
        if (range.filamentId === filamentId) {
          paths.push(`${objectPath}.layerRanges[${rangeIndex}].filamentId`);
        }
      });
    });
  });
  state.filaments.mixed.forEach((filament, filamentIndex) => {
    filament.components.forEach((component, componentIndex) => {
      if (component.filamentId === filamentId) {
        paths.push(`filaments.mixed[${filamentIndex}].components[${componentIndex}].filamentId`);
      }
    });
  });
  return paths.sort();
}

function validateNewRecipeComponents(state: ProjectState, components: readonly MixedComponent[]): void {
  const seen = new Set<PhysicalFilamentId>();
  for (const component of components) {
    if (seen.has(component.filamentId)) {
      throw new Error(`Mixed filament component ${component.filamentId} is duplicated`);
    }
    seen.add(component.filamentId);
    const filament = state.filaments.physical.find((candidate) => candidate.id === component.filamentId);
    if (!filament) throw new Error(`Unknown mixed filament component ${component.filamentId}`);
    if (!filament.enabled) throw new Error(`Mixed filament component ${component.filamentId} is disabled`);
  }
}

function validateRecipeShape(filament: MixedFilament): void {
  if (!filament.name.trim()) throw new Error('Mixed filament name cannot be empty');
  if (!filament.displayColor.trim()) throw new Error('Mixed filament display color cannot be empty');
  const distribution = filament.distribution;
  if (distribution.mode === 'cycle') {
    if (!Number.isFinite(distribution.cycleLengthMm) || distribution.cycleLengthMm <= 0) {
      throw new Error('Mixed filament cycle length must be greater than zero');
    }
    return;
  }
  if (distribution.mode === 'match') {
    if (!distribution.targetColor.trim()) throw new Error('Mixed filament match target color cannot be empty');
    return;
  }
  if (distribution.mode !== 'gradient') return;
  if (
    !Number.isFinite(distribution.startZMm) ||
    !Number.isFinite(distribution.endZMm) ||
    distribution.startZMm < 0 ||
    distribution.endZMm <= distribution.startZMm
  ) {
    throw new Error('Mixed filament gradient range must satisfy 0 <= startZMm < endZMm');
  }
  if (
    distribution.startWeights.length !== filament.components.length ||
    distribution.endWeights.length !== filament.components.length
  ) {
    throw new Error('Mixed filament gradient weights must match component count');
  }
  for (const [endpoint, weights] of [
    ['start', distribution.startWeights],
    ['end', distribution.endWeights],
  ] as const) {
    if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      throw new Error(`Mixed filament gradient ${endpoint} weights must be finite and non-negative`);
    }
    if (weights.every((weight) => weight === 0)) {
      throw new Error(`Mixed filament gradient ${endpoint} weights need at least one positive value`);
    }
  }
}

function assertNewMixedId(state: ProjectState, id: MixedFilamentId): void {
  if (!isStableEntityId(id)) throw new Error(`Mixed filament ID ${id} is not stable`);
  if (collectProjectIds(state).has(id)) throw new Error(`Mixed filament ID ${id} already exists in the project`);
}

function collectProjectIds(state: ProjectState): Set<string> {
  const ids = new Set<string>([state.id]);
  state.plates.forEach((plate) => {
    ids.add(plate.id);
    plate.objects.forEach((object) => {
      ids.add(object.id);
      object.volumes.forEach((volume) => ids.add(volume.id));
      object.instances.forEach((instance) => ids.add(instance.id));
      object.layerRanges.forEach((range) => ids.add(range.id));
    });
  });
  state.filaments.physical.forEach((filament) => ids.add(filament.id));
  state.filaments.mixed.forEach((filament) => ids.add(filament.id));
  state.sourceAssets.forEach((asset) => ids.add(asset.id));
  state.customGcode.forEach((entry) => ids.add(entry.id));
  state.thumbnails.forEach((thumbnail) => ids.add(thumbnail.id));
  state.extensionBlobs.forEach((blob) => ids.add(blob.id));
  return ids;
}

function requireMixedFilament(state: ProjectState, id: MixedFilamentId): MixedFilament {
  const filament = state.filaments.mixed.find((candidate) => candidate.id === id);
  if (!filament) throw new Error(`Unknown mixed filament ${id}`);
  return filament;
}
