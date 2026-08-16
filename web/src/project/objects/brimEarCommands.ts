/**
 * Canonical brim-ear placement commands (P5.3.6).
 *
 * Ears are per-object state that reaches the engine through
 * `Metadata/brim_ear_points.txt`, so placing one is an ordinary undoable
 * project command — not a viewer annotation. Coordinates are object-local
 * millimetres, matching the pinned `ModelObject::brim_points`.
 */

import { cloneJson, cloneProjectState } from '../domain/canonical';
import type { ObjectId } from '../domain/ids';
import type { BrimEarPoint, ProjectObject, ProjectState } from '../domain/model';
import type { CommandContext, ProjectCommand } from '../history/command';

/** Pinned `GLGizmoBrimEars` head-radius bounds, in millimetres. */
export const BRIM_EAR_MIN_RADIUS_MM = 0.1;
export const BRIM_EAR_MAX_RADIUS_MM = 20;

export class BrimEarError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown-object' | 'invalid-point' | 'unknown-ear',
  ) {
    super(message);
    this.name = 'BrimEarError';
  }
}

export function assertBrimEarPoint(point: BrimEarPoint): void {
  if (point.positionMm.length !== 3 || !point.positionMm.every(Number.isFinite)) {
    throw new BrimEarError('A brim ear needs three finite coordinates', 'invalid-point');
  }
  if (
    !Number.isFinite(point.headFrontRadiusMm) ||
    point.headFrontRadiusMm < BRIM_EAR_MIN_RADIUS_MM ||
    point.headFrontRadiusMm > BRIM_EAR_MAX_RADIUS_MM
  ) {
    throw new BrimEarError(
      `A brim ear radius must be between ${BRIM_EAR_MIN_RADIUS_MM} and ${BRIM_EAR_MAX_RADIUS_MM} mm`,
      'invalid-point',
    );
  }
}

function findObject(state: ProjectState, objectId: ObjectId): ProjectObject {
  for (const plate of state.plates) {
    const object = plate.objects.find((candidate) => candidate.id === objectId);
    if (object) return object;
  }
  throw new BrimEarError(`Unknown object ${objectId}`, 'unknown-object');
}

/** Append one ear to an object. */
export class AddBrimEarCommand implements ProjectCommand {
  readonly type = 'add-brim-ear';
  readonly label = 'Place brim ear';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly point: BrimEarPoint;

  constructor(
    private readonly objectId: ObjectId,
    point: BrimEarPoint,
  ) {
    assertBrimEarPoint(point);
    this.point = cloneJson(point);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    object.brimEars = [...(object.brimEars ?? []), cloneJson(this.point)];
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    const remaining = [...(object.brimEars ?? [])];
    remaining.pop();
    if (remaining.length === 0) delete object.brimEars;
    else object.brimEars = remaining;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }
}

/**
 * Place a whole detected set as one entry.
 *
 * Automatic placement finds several corners at once, and eight undo steps for
 * one act is noise: the operator asked for "hold this part down", not for eight
 * separate decisions. Existing ears are kept, so auto-placing after a manual
 * placement adds to it rather than replacing it.
 */
export class AddBrimEarsCommand implements ProjectCommand {
  readonly type = 'add-brim-ears';
  readonly label = 'Place brim ears';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly points: readonly BrimEarPoint[];
  private previous?: readonly BrimEarPoint[];

  constructor(
    private readonly objectId: ObjectId,
    points: readonly BrimEarPoint[],
  ) {
    if (points.length === 0) {
      throw new BrimEarError('Placing no brim ears is not a change', 'unknown-ear');
    }
    for (const point of points) assertBrimEarPoint(point);
    this.points = Object.freeze(points.map((point) => cloneJson(point)));
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    this.previous = object.brimEars ? Object.freeze(object.brimEars.map((point) => cloneJson(point))) : undefined;
    object.brimEars = [...(object.brimEars ?? []), ...this.points.map((point) => cloneJson(point))];
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }

  revert(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    if (this.previous === undefined) delete object.brimEars;
    else object.brimEars = this.previous.map((point) => cloneJson(point));
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }
}

/** Remove one ear by index, so an accidental placement is easy to undo in place. */
export class RemoveBrimEarCommand implements ProjectCommand {
  readonly type = 'remove-brim-ear';
  readonly label = 'Remove brim ear';
  readonly dirtyCategories = ['projectData'] as const;

  private removed?: { index: number; point: BrimEarPoint };

  constructor(
    private readonly objectId: ObjectId,
    private readonly index: number,
  ) {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new BrimEarError('A brim-ear index must be a non-negative integer', 'unknown-ear');
    }
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    const ears = [...(object.brimEars ?? [])];
    if (this.index >= ears.length) {
      throw new BrimEarError(`Object ${this.objectId} has no brim ear at index ${this.index}`, 'unknown-ear');
    }
    this.removed = { index: this.index, point: cloneJson(ears[this.index]) };
    ears.splice(this.index, 1);
    if (ears.length === 0) delete object.brimEars;
    else object.brimEars = ears;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }

  revert(context: CommandContext): void {
    if (!this.removed) return;
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    const ears = [...(object.brimEars ?? [])];
    ears.splice(this.removed.index, 0, cloneJson(this.removed.point));
    object.brimEars = ears;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }
}

/** Clear every ear on one object in a single entry. */
export class ClearBrimEarsCommand implements ProjectCommand {
  readonly type = 'clear-brim-ears';
  readonly label = 'Clear brim ears';
  readonly dirtyCategories = ['projectData'] as const;

  private previous?: BrimEarPoint[];

  constructor(private readonly objectId: ObjectId) {}

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = findObject(state, this.objectId);
    this.previous = cloneJson(object.brimEars ?? []);
    delete object.brimEars;
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }

  revert(context: CommandContext): void {
    if (!this.previous || this.previous.length === 0) return;
    const state = cloneProjectState(context.project.getSnapshot().state);
    findObject(state, this.objectId).brimEars = cloneJson(this.previous);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: ['projectData'] });
  }
}
