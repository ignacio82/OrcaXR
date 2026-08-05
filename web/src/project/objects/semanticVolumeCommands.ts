import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import type { ObjectId, VolumeId } from '../domain/ids';
import type { ProjectState, ProjectVolume, VolumeRole } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';

/** Snapmaker Orca v2.3.4 `ModelVolumeType` ordinal order. */
export const ORCA_VOLUME_ROLE_ORDER: readonly VolumeRole[] = [
  'model',
  'negative-volume',
  'parameter-modifier',
  'support-blocker',
  'support-enforcer',
];

export type VolumeRoleConversionBlockCode =
  'unknown-volume' | 'unsupported-role' | 'last-model-volume' | 'facet-annotations' | 'filament-assignment';

export type VolumeRoleConversionDecision =
  { allowed: true; noop: boolean } | { allowed: false; code: VolumeRoleConversionBlockCode; reason: string };

export class VolumeRoleConversionError extends Error {
  override readonly name = 'VolumeRoleConversionError';

  constructor(
    readonly code: VolumeRoleConversionBlockCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Inspect a role conversion without mutating the project. Incompatible local
 * data is never discarded implicitly; callers can explain the blocked state
 * and offer the appropriate explicit cleanup command instead.
 */
export function inspectVolumeRoleConversion(
  state: ProjectState,
  volumeId: VolumeId,
  nextRole: string,
): VolumeRoleConversionDecision {
  if (!isVolumeRole(nextRole)) {
    return {
      allowed: false,
      code: 'unsupported-role',
      reason: `Volume role ${JSON.stringify(nextRole)} is not supported by Snapmaker Orca v2.3.4`,
    };
  }
  const found = findVolume(state, volumeId);
  if (!found) {
    return {
      allowed: false,
      code: 'unknown-volume',
      reason: `Unknown volume ${volumeId}`,
    };
  }
  if (found.volume.role === nextRole) return { allowed: true, noop: true };

  if (
    found.volume.role === 'model' &&
    nextRole !== 'model' &&
    found.object.volumes.filter((volume) => volume.role === 'model').length === 1
  ) {
    return {
      allowed: false,
      code: 'last-model-volume',
      reason: 'The last model part on an object cannot be converted to a non-model role',
    };
  }
  if (nextRole !== 'model' && hasFacetAssignments(found.volume)) {
    return {
      allowed: false,
      code: 'facet-annotations',
      reason: 'Clear facet paint annotations before converting this model part to a non-model role',
    };
  }
  if (!roleSupportsLocalFilament(nextRole) && found.volume.filamentId) {
    return {
      allowed: false,
      code: 'filament-assignment',
      reason: `Clear the local filament assignment before converting this volume to ${nextRole}`,
    };
  }
  return { allowed: true, noop: false };
}

/** Change one volume role and reproduce the engine's stable full-role sort. */
export class ConvertVolumeRoleCommand implements ProjectCommand {
  readonly type = 'convert-volume-role';
  readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previousVolumes?: ProjectVolume[];
  private objectId?: ObjectId;

  constructor(
    private readonly volumeId: VolumeId,
    private readonly nextRole: VolumeRole,
  ) {
    if (!isVolumeRole(nextRole)) {
      throw new VolumeRoleConversionError(
        'unsupported-role',
        `Volume role ${JSON.stringify(nextRole)} is not supported by Snapmaker Orca v2.3.4`,
      );
    }
    this.label = `Convert volume to ${roleLabel(nextRole)}`;
  }

  isNoop(context: CommandContext): boolean {
    const decision = inspectVolumeRoleConversion(context.project.getSnapshot().state, this.volumeId, this.nextRole);
    assertConversionAllowed(decision);
    return decision.noop;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const decision = inspectVolumeRoleConversion(state, this.volumeId, this.nextRole);
    assertConversionAllowed(decision);
    const found = findVolume(state, this.volumeId);
    if (!found) throw new Error(`Unknown volume ${this.volumeId}`);

    this.objectId = found.object.id;
    this.previousVolumes = cloneJson(found.object.volumes);
    found.volume.role = this.nextRole;
    found.object.volumes.sort(compareVolumeRoles);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.objectId || !this.previousVolumes) {
      throw new Error('ConvertVolumeRoleCommand has not been applied');
    }
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = state.plates.flatMap((plate) => plate.objects).find((object) => object.id === this.objectId);
    if (!found) throw new Error(`Unknown object ${this.objectId}`);
    found.volumes = cloneJson(this.previousVolumes);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return this.previousVolumes ? canonicalStringify(this.previousVolumes).length : 1;
  }
}

function isVolumeRole(value: string): value is VolumeRole {
  return ORCA_VOLUME_ROLE_ORDER.some((role) => role === value);
}

function assertConversionAllowed(
  decision: VolumeRoleConversionDecision,
): asserts decision is Extract<VolumeRoleConversionDecision, { allowed: true }> {
  if (!decision.allowed) throw new VolumeRoleConversionError(decision.code, decision.reason);
}

function hasFacetAssignments(volume: ProjectVolume): boolean {
  const { annotations } = volume;
  return (
    annotations.color.length > 0 ||
    annotations.support.length > 0 ||
    annotations.seam.length > 0 ||
    annotations.fuzzySkin.length > 0 ||
    annotations.brim.length > 0
  );
}

function roleSupportsLocalFilament(role: VolumeRole): boolean {
  return role === 'model' || role === 'parameter-modifier';
}

function compareVolumeRoles(left: ProjectVolume, right: ProjectVolume): number {
  return ORCA_VOLUME_ROLE_ORDER.indexOf(left.role) - ORCA_VOLUME_ROLE_ORDER.indexOf(right.role);
}

function roleLabel(role: VolumeRole): string {
  switch (role) {
    case 'model':
      return 'part';
    case 'negative-volume':
      return 'negative part';
    case 'parameter-modifier':
      return 'modifier';
    case 'support-blocker':
      return 'support blocker';
    case 'support-enforcer':
      return 'support enforcer';
  }
}
