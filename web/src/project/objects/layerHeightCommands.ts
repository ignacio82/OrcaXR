/**
 * Editing an object's variable layer-height profile (P5.9).
 *
 * Every entry point is one undoable command over the canonical profile, so a
 * stroke of the height editor, an adaptive regeneration, and a reset all sit in
 * history the same way and all invalidate the slice the same way.
 */

import { cloneJson, cloneProjectState } from '../domain/canonical';
import type { ObjectId } from '../domain/ids';
import type { ProjectObject, ProjectState } from '../domain/model';
import type { CommandContext, ProjectCommand } from '../history/command';
import {
  adaptiveLayerHeightProfile,
  adjustLayerHeightProfile,
  baseLayerHeightProfile,
  smoothHeightProfile,
  type AdaptiveMesh,
  type HeightProfileSmoothing,
  type LayerHeightEditAction,
  type LayerHeightSlicingParameters,
} from './layerHeightProfile';

/** Base class: every profile edit is a whole-profile replacement. */
abstract class LayerHeightProfileCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;

  private previous?: number[];
  private hadProfile = false;

  constructor(protected readonly objectId: ObjectId) {}

  /** The profile this command wants, or undefined to clear it. */
  protected abstract nextProfile(object: ProjectObject, state: ProjectState): number[] | undefined;

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.objectId);
    this.hadProfile = object.layerHeightProfile !== undefined;
    this.previous = object.layerHeightProfile ? [...object.layerHeightProfile] : undefined;

    const next = this.nextProfile(object, state);
    if (next === undefined) delete object.layerHeightProfile;
    else object.layerHeightProfile = [...next];
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.objectId);
    // Restoring "absent" matters: an object that never had a profile must not
    // come back carrying a flat one, or every save would grow a profile the
    // operator never authored.
    if (this.hadProfile && this.previous) object.layerHeightProfile = [...this.previous];
    else delete object.layerHeightProfile;
    context.project.replaceState(state, { reason: `${this.type}:undo`, dirtyCategories: this.dirtyCategories });
  }
}

/** One stroke of the manual height editor. */
export class AdjustLayerHeightProfileCommand extends LayerHeightProfileCommand {
  readonly type = 'adjust-layer-height-profile';
  readonly label = 'Edit layer height';

  constructor(
    objectId: ObjectId,
    private readonly parameters: LayerHeightSlicingParameters,
    private readonly request: {
      readonly zMm: number;
      readonly thicknessDeltaMm: number;
      readonly bandWidthMm: number;
      readonly action: LayerHeightEditAction;
    },
  ) {
    super(objectId);
  }

  protected nextProfile(object: ProjectObject): number[] {
    const current = object.layerHeightProfile ?? baseLayerHeightProfile(this.parameters);
    return adjustLayerHeightProfile(current, this.parameters, this.request);
  }
}

/** Regenerate the whole profile from the object's geometry. */
export class AdaptiveLayerHeightProfileCommand extends LayerHeightProfileCommand {
  readonly type = 'adaptive-layer-height-profile';
  readonly label = 'Adaptive layer height';

  constructor(
    objectId: ObjectId,
    private readonly parameters: LayerHeightSlicingParameters,
    private readonly mesh: AdaptiveMesh,
    private readonly qualityFactor: number,
  ) {
    super(objectId);
  }

  protected nextProfile(): number[] {
    return adaptiveLayerHeightProfile(this.mesh, this.parameters, this.qualityFactor);
  }
}

/** Smooth the whole profile with the pinned biased Gaussian. */
export class SmoothLayerHeightProfileCommand extends LayerHeightProfileCommand {
  readonly type = 'smooth-layer-height-profile';
  readonly label = 'Smooth layer height';

  constructor(
    objectId: ObjectId,
    private readonly parameters: LayerHeightSlicingParameters,
    private readonly smoothing: HeightProfileSmoothing,
  ) {
    super(objectId);
  }

  protected nextProfile(object: ProjectObject): number[] {
    const current = object.layerHeightProfile ?? baseLayerHeightProfile(this.parameters);
    return smoothHeightProfile(current, this.parameters, this.smoothing);
  }
}

/**
 * Drop the profile entirely.
 *
 * Clearing rather than writing a flat one, so the object goes back to plain
 * base-height slicing and the exported 3MF carries no profile at all.
 */
export class ResetLayerHeightProfileCommand extends LayerHeightProfileCommand {
  readonly type = 'reset-layer-height-profile';
  readonly label = 'Reset layer height';

  protected nextProfile(): undefined {
    return undefined;
  }
}

function requireObject(state: ProjectState, objectId: ObjectId): ProjectObject {
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Object ${objectId} is not in this project`);
  return object;
}

/** Deep-clone helper kept local so the commands never alias caller state. */
export function cloneLayerHeightProfile(profile: readonly number[] | undefined): number[] | undefined {
  return profile ? cloneJson([...profile]) : undefined;
}
