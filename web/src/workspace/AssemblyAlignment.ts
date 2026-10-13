/**
 * The workspace's assembly flow over the Measure tool's two picks (P5.3.2):
 * which pinned alignments the pair allows and what the panel says about them,
 * and what one alignment does — refused with the workspace's words, nothing
 * when the faces already agree, or the second pick's instance moved to the
 * planned transform, which the workspace commits as one undoable
 * `setInstanceTransform`. `OrcaWorkspace` runs it; the cross-platform corpus
 * (`assembly-vectors.mjs`) runs the same steps over the production controller
 * so the Android app's flow can be checked against it.
 */
import { t } from '../l10n/t';
import type { InstanceId } from '../project/domain/ids';
import type { Transform } from '../project/domain/model';
import {
  inspectAssemblyActions,
  planAssemblyAlignment,
  type AssemblyAlignmentKind,
  type AssemblyAvailability,
} from '../project/objects/assembly';
import type { SurfaceFeature } from '../project/objects/measure';

/** One Measure pick: the feature in printer millimetres and the instance the ray met. */
export interface AssemblyPick {
  readonly feature: SurfaceFeature;
  readonly instanceId?: InstanceId;
}

/** Read-only view an assembly surface renders. */
export interface AssemblySnapshot {
  readonly available: AssemblyAvailability;
  /** True when the second pick belongs to a different, movable instance. */
  readonly movable: boolean;
  readonly hint: string;
}

const NOTHING_AVAILABLE: AssemblyAvailability = Object.freeze({
  canSetToParallel: false,
  canSetToCenterCoincidence: false,
  canReverseFeature1: false,
  canReverseFeature2: false,
  canRotateAroundFaceCenter: false,
  hasParallelDistance: false,
  parallelDistanceMm: 0,
  angleRadians: 0,
});

/** The panel's hints, before two picks, for a pair that can move and one that cannot. */
export const ASSEMBLY_HINTS = Object.freeze({
  pick: 'Pick two faces — the second one moves.',
  choose: 'Choose an alignment; it commits as one undoable move.',
  differentModels: 'Pick two faces on different models to align them.',
});

/**
 * Which pinned alignments the two picks allow. The second pick's instance is
 * the one that would move, so a pair on one instance offers nothing to align.
 */
export function assemblySnapshot(picks: readonly AssemblyPick[]): AssemblySnapshot {
  if (picks.length < 2) {
    return Object.freeze({
      available: Object.freeze({ ...NOTHING_AVAILABLE }),
      movable: false,
      hint: ASSEMBLY_HINTS.pick,
    });
  }
  const [first, second] = picks;
  const available = inspectAssemblyActions(first.feature, second.feature);
  const movable = Boolean(second.instanceId) && second.instanceId !== first.instanceId;
  return Object.freeze({
    available,
    movable,
    hint: movable ? ASSEMBLY_HINTS.choose : ASSEMBLY_HINTS.differentModels,
  });
}

/** What one alignment does, with the workspace's status for it. */
export type AssemblyAlignmentStep =
  /** Not attempted: fewer than two picks, both on one model, or the model to move gone. */
  | { readonly outcome: 'refused'; readonly status: string }
  /** Planned, but the faces already agree: nothing moves and nothing is recorded. */
  | { readonly outcome: 'aligned'; readonly status: string }
  /** The second pick's instance moves to [transform]; [status] is said once it is committed. */
  | {
      readonly outcome: 'move';
      readonly instanceId: InstanceId;
      readonly transform: Transform;
      readonly status: string;
    }
  /** The pinned plan refused the pair or the parameter. */
  | { readonly outcome: 'failed'; readonly status: string };

/** The status a failed alignment reports. */
export function assemblyFailedStatus(message: string): string {
  return `Alignment failed: ${message}`;
}

/**
 * Plan alignment [kind] (with its [parameter]: a gap in millimetres, a turn
 * in degrees) for the two [picks]; [transformOf] reads an instance's current
 * transform. Nothing is mutated: the caller commits a `move`.
 */
export function planAssemblyStep(
  picks: readonly AssemblyPick[],
  kind: AssemblyAlignmentKind,
  parameter: number | undefined,
  transformOf: (instanceId: InstanceId) => Transform | undefined,
): AssemblyAlignmentStep {
  if (picks.length < 2) {
    return {
      outcome: 'refused',
      status: t('workspace.orcaWorkspace.pickTwoFacesBeforeAligning', 'Pick two faces before aligning.'),
    };
  }
  const [first, second] = picks;
  const target = second.instanceId;
  if (!target || target === first.instanceId) {
    return {
      outcome: 'refused',
      status: t(
        'workspace.orcaWorkspace.assemblyAlignmentNeedsTwoFaces',
        'Assembly alignment needs two faces on different models.',
      ),
    };
  }
  const current = transformOf(target);
  if (!current) {
    return {
      outcome: 'refused',
      status: t('workspace.orcaWorkspace.theModelToAlignIs', 'The model to align is no longer on this plate.'),
    };
  }
  let plan;
  try {
    plan = planAssemblyAlignment({
      kind,
      first: first.feature,
      second: second.feature,
      movingTransform: current,
      ...(parameter !== undefined ? { parameter } : {}),
    });
  } catch (error) {
    return { outcome: 'failed', status: assemblyFailedStatus((error as Error).message) };
  }
  if (plan.noop) {
    return {
      outcome: 'aligned',
      status: t(
        'workspace.orcaWorkspace.thoseFacesAreAlreadyAligned',
        'Those faces are already aligned; nothing moved.',
      ),
    };
  }
  return {
    outcome: 'move',
    instanceId: target,
    transform: plan.transform,
    status: `Applied ${kind.replaceAll('-', ' ')}. Undo restores the previous placement.`,
  };
}
