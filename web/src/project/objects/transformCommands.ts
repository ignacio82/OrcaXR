import { canonicalStringify, cloneProjectState, compareCanonicalText } from '../domain/canonical';
import type { InstanceId } from '../domain/ids';
import type { Transform } from '../domain/model';
import { findInstance } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';

export interface InstanceTransformChange {
  readonly instanceId: InstanceId;
  readonly transform: Transform;
}

/**
 * Transform an exact stable-ID instance set as one history boundary.
 *
 * The command is intentionally delta-agnostic: DOM, touch, and XR adapters may
 * derive their own world/local pivot math, but only complete canonical
 * transforms cross this boundary. A shared gesture ID coalesces streamed
 * previews while preserving the transforms from the beginning of the gesture.
 */
export class SetInstanceTransformsCommand implements ProjectCommand {
  readonly type = 'set-instance-transforms';
  readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  readonly coalesceKey: string;
  private readonly changes: readonly InstanceTransformChange[];
  private previous?: readonly InstanceTransformChange[];

  constructor(
    changes: readonly InstanceTransformChange[],
    private readonly gestureId = 'default',
  ) {
    if (changes.length === 0) throw new Error('A batch transform requires at least one instance');
    if (!gestureId) throw new Error('A batch transform gesture ID cannot be empty');
    const ids = new Set<InstanceId>();
    this.changes = Object.freeze(
      [...changes]
        .map((change) => {
          if (ids.has(change.instanceId)) {
            throw new Error(`Batch transform contains duplicate instance ${change.instanceId}`);
          }
          ids.add(change.instanceId);
          return Object.freeze({
            instanceId: change.instanceId,
            transform: cloneTransform(change.transform),
          });
        })
        .sort((left, right) => compareCanonicalText(left.instanceId, right.instanceId)),
    );
    this.label = this.changes.length === 1 ? 'Transform instance' : `Transform ${this.changes.length} instances`;
    this.coalesceKey = canonicalStringify([this.type, gestureId, this.changes.map((change) => change.instanceId)]);
  }

  isNoop(context: CommandContext): boolean {
    const state = context.project.getSnapshot().state;
    return this.changes.every((change) => {
      const found = findInstance(state, change.instanceId);
      if (!found) throw new Error(`Unknown instance ${change.instanceId}`);
      return canonicalStringify(found.instance.transform) === canonicalStringify(change.transform);
    });
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const previous: InstanceTransformChange[] = [];
    for (const change of this.changes) {
      const found = findInstance(state, change.instanceId);
      if (!found) throw new Error(`Unknown instance ${change.instanceId}`);
      previous.push({
        instanceId: change.instanceId,
        transform: cloneTransform(found.instance.transform),
      });
      found.instance.transform = cloneTransform(change.transform);
    }
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    this.previous = Object.freeze(previous.map(freezeChange));
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('SetInstanceTransformsCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    for (const change of this.previous) {
      const found = findInstance(state, change.instanceId);
      if (!found) throw new Error(`Unknown instance ${change.instanceId}`);
      found.instance.transform = cloneTransform(change.transform);
    }
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  mergeWith(next: ProjectCommand): ProjectCommand | undefined {
    if (!(next instanceof SetInstanceTransformsCommand) || next.coalesceKey !== this.coalesceKey) {
      return undefined;
    }
    const merged = new SetInstanceTransformsCommand(next.changes, this.gestureId);
    merged.previous = this.previous?.map(freezeChange);
    return merged;
  }

  estimateBytes(): number {
    return canonicalStringify(this.changes).length + (this.previous ? canonicalStringify(this.previous).length : 1);
  }
}

function cloneTransform(transform: Transform): Transform {
  return {
    translationMm: [...transform.translationMm],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function freezeChange(change: InstanceTransformChange): InstanceTransformChange {
  return Object.freeze({
    instanceId: change.instanceId,
    transform: Object.freeze({
      translationMm: Object.freeze([...change.transform.translationMm]),
      rotation: Object.freeze([...change.transform.rotation]),
      scale: Object.freeze([...change.transform.scale]),
    }) as Transform,
  });
}
