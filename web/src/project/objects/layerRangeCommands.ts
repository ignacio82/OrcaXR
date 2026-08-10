import { canonicalStringify, cloneJson, cloneProjectState, compareCanonicalText } from '../domain/canonical';
import { isStableEntityId, type LayerRangeId, type ObjectId } from '../domain/ids';
import type { LayerRange, ProjectObject, ProjectState } from '../domain/model';
import { findObject } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { selectionKey, type SelectionRef, type SelectionSnapshot } from '../selection';

export interface LayerRangeBoundsPatch {
  minZMm?: number;
  maxZMm?: number;
}

export type LayerRangeMergeInspection =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Inspect the exact merge rule used by MergeLayerRangesCommand without mutation. */
export function inspectLayerRangeMerge(
  state: ProjectState,
  objectId: ObjectId,
  firstRangeId: LayerRangeId,
  secondRangeId: LayerRangeId,
): LayerRangeMergeInspection {
  const found = findObject(state, objectId);
  if (!found) return { allowed: false, reason: `Unknown object ${objectId}` };
  return inspectOwnedLayerRangeMerge(found.object, firstRangeId, secondRangeId);
}

abstract class LayerRangeLifecycleCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previousRanges?: LayerRange[];
  private nextRanges?: LayerRange[];

  constructor(protected readonly objectId: ObjectId) {}

  protected abstract mutate(state: ProjectState, object: ProjectObject): void;

  protected afterApply(
    _context: CommandContext,
    _state: ProjectState,
    _beforeSelection: SelectionSnapshot,
    _previousRanges: readonly LayerRange[],
  ): void {}

  isNoop(context: CommandContext): boolean {
    const current = context.project.getSnapshot().state;
    const next = cloneProjectState(current);
    const object = requireObject(next, this.objectId);
    this.mutate(next, object);
    sortLayerRanges(object.layerRanges);
    return (
      canonicalStringify(requireObject(current, this.objectId).layerRanges) === canonicalStringify(object.layerRanges)
    );
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.objectId);
    const beforeSelection = context.selection.getSnapshot();
    const previousRanges = cloneJson(object.layerRanges);
    this.mutate(state, object);
    sortLayerRanges(object.layerRanges);

    this.previousRanges = previousRanges;
    this.nextRanges = cloneJson(object.layerRanges);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    this.afterApply(context, state, beforeSelection, previousRanges);
  }

  revert(context: CommandContext): void {
    if (!this.previousRanges) throw new Error(`${this.constructor.name} has not been applied`);
    const state = cloneProjectState(context.project.getSnapshot().state);
    requireObject(state, this.objectId).layerRanges = cloneJson(this.previousRanges);
    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return (
      (this.previousRanges ? canonicalStringify(this.previousRanges).length : 0) +
      (this.nextRanges ? canonicalStringify(this.nextRanges).length : 1)
    );
  }
}

export class AddLayerRangeCommand extends LayerRangeLifecycleCommand {
  readonly type = 'add-layer-range';
  readonly label = 'Add layer range';
  private readonly range: LayerRange;

  constructor(objectId: ObjectId, range: LayerRange) {
    super(objectId);
    assertStableRangeId(range.id);
    assertValidLayerRangeBounds(range.minZMm, range.maxZMm);
    this.range = cloneJson(range);
  }

  protected mutate(state: ProjectState, object: ProjectObject): void {
    assertEntityIdAvailable(state, this.range.id);
    assertDoesNotOverlap(object, this.range);
    object.layerRanges.push(cloneJson(this.range));
  }

  protected override afterApply(context: CommandContext): void {
    context.selection.set([{ kind: 'layer-range', id: this.range.id }]);
  }
}

/** Edit only range boundaries; settings and filament assignments use their scoped commands. */
export class EditLayerRangeBoundsCommand extends LayerRangeLifecycleCommand {
  readonly type = 'edit-layer-range-bounds';
  readonly label = 'Edit layer range';
  private readonly patch: LayerRangeBoundsPatch;

  constructor(
    objectId: ObjectId,
    private readonly layerRangeId: LayerRangeId,
    patch: LayerRangeBoundsPatch,
  ) {
    super(objectId);
    const unsupported = Object.keys(patch).filter((key) => key !== 'minZMm' && key !== 'maxZMm');
    if (unsupported.length > 0) {
      throw new Error(`Layer-range boundary edit does not support fields: ${unsupported.join(', ')}`);
    }
    this.patch = cloneJson(patch);
  }

  protected mutate(_state: ProjectState, object: ProjectObject): void {
    const range = requireOwnedLayerRange(object, this.layerRangeId);
    const hasMinZ = Object.prototype.hasOwnProperty.call(this.patch, 'minZMm');
    const hasMaxZ = Object.prototype.hasOwnProperty.call(this.patch, 'maxZMm');
    const candidate: LayerRange = {
      ...cloneJson(range),
      minZMm: hasMinZ ? (this.patch.minZMm as number) : range.minZMm,
      maxZMm: hasMaxZ ? (this.patch.maxZMm as number) : range.maxZMm,
    };
    assertValidLayerRangeBounds(candidate.minZMm, candidate.maxZMm);
    assertDoesNotOverlap(object, candidate, new Set([this.layerRangeId]));
    range.minZMm = candidate.minZMm;
    range.maxZMm = candidate.maxZMm;
  }
}

export class SplitLayerRangeCommand extends LayerRangeLifecycleCommand {
  readonly type = 'split-layer-range';
  readonly label = 'Split layer range';

  constructor(
    objectId: ObjectId,
    private readonly layerRangeId: LayerRangeId,
    private readonly splitZMm: number,
    private readonly upperRangeId: LayerRangeId,
  ) {
    super(objectId);
    assertStableRangeId(upperRangeId);
    if (!Number.isFinite(splitZMm)) throw new Error('Layer-range split height must be finite');
  }

  protected mutate(state: ProjectState, object: ProjectObject): void {
    const lower = requireOwnedLayerRange(object, this.layerRangeId);
    if (this.splitZMm <= lower.minZMm || this.splitZMm >= lower.maxZMm) {
      throw new Error(
        `Layer-range split height ${this.splitZMm} must be strictly inside [${lower.minZMm}, ${lower.maxZMm}]`,
      );
    }
    assertEntityIdAvailable(state, this.upperRangeId);
    const upper: LayerRange = {
      ...cloneJson(lower),
      id: this.upperRangeId,
      minZMm: this.splitZMm,
    };
    lower.maxZMm = this.splitZMm;
    object.layerRanges.push(upper);
  }

  protected override afterApply(context: CommandContext): void {
    context.selection.set([{ kind: 'layer-range', id: this.upperRangeId }]);
  }
}

/**
 * Merge touching ranges only when doing so cannot change effective settings.
 * The lower range keeps its stable ID; merging across a gap or choosing among
 * conflicting settings remains an explicit unsupported decision.
 */
export class MergeLayerRangesCommand extends LayerRangeLifecycleCommand {
  readonly type = 'merge-layer-ranges';
  readonly label = 'Merge layer ranges';

  constructor(
    objectId: ObjectId,
    private readonly firstRangeId: LayerRangeId,
    private readonly secondRangeId: LayerRangeId,
  ) {
    super(objectId);
    if (firstRangeId === secondRangeId) throw new Error('Merging layer ranges requires two distinct ranges');
  }

  protected mutate(_state: ProjectState, object: ProjectObject): void {
    const first = requireOwnedLayerRange(object, this.firstRangeId);
    const second = requireOwnedLayerRange(object, this.secondRangeId);
    const inspection = inspectOwnedLayerRangeMerge(object, this.firstRangeId, this.secondRangeId);
    if (!inspection.allowed) throw new Error(inspection.reason);
    const [lower, upper] = orderedPair(first, second);
    lower.maxZMm = upper.maxZMm;
    object.layerRanges.splice(object.layerRanges.indexOf(upper), 1);
  }

  protected override afterApply(
    context: CommandContext,
    state: ProjectState,
    beforeSelection: SelectionSnapshot,
    previousRanges: readonly LayerRange[],
  ): void {
    const first = requireLayerRange(previousRanges, this.firstRangeId);
    const second = requireLayerRange(previousRanges, this.secondRangeId);
    const [retained, removed] = orderedPair(first, second);
    repairSelectionAfterRemoval(context, state, beforeSelection, removed.id, { kind: 'layer-range', id: retained.id });
  }
}

export class DeleteLayerRangeCommand extends LayerRangeLifecycleCommand {
  readonly type = 'delete-layer-range';
  readonly label = 'Delete layer range';

  constructor(
    objectId: ObjectId,
    private readonly layerRangeId: LayerRangeId,
  ) {
    super(objectId);
  }

  protected mutate(_state: ProjectState, object: ProjectObject): void {
    const range = requireOwnedLayerRange(object, this.layerRangeId);
    object.layerRanges.splice(object.layerRanges.indexOf(range), 1);
  }

  protected override afterApply(
    context: CommandContext,
    state: ProjectState,
    beforeSelection: SelectionSnapshot,
    previousRanges: readonly LayerRange[],
  ): void {
    const orderedBefore = [...previousRanges].sort(compareLayerRanges);
    const removedIndex = orderedBefore.findIndex((range) => range.id === this.layerRangeId);
    const remaining = requireObject(state, this.objectId).layerRanges;
    const neighbor = remaining[Math.min(removedIndex, remaining.length - 1)];
    const fallback: SelectionRef = neighbor
      ? { kind: 'layer-range', id: neighbor.id }
      : { kind: 'object', id: this.objectId };
    repairSelectionAfterRemoval(context, state, beforeSelection, this.layerRangeId, fallback);
  }
}

function assertStableRangeId(id: LayerRangeId): void {
  if (!isStableEntityId(id)) throw new Error(`Layer-range ID ${id} is not stable`);
}

function assertValidLayerRangeBounds(minZMm: number, maxZMm: number): void {
  if (!Number.isFinite(minZMm) || !Number.isFinite(maxZMm) || minZMm < 0 || maxZMm <= minZMm) {
    throw new Error('Layer range must have finite bounds with 0 <= minZMm < maxZMm');
  }
}

function assertDoesNotOverlap(
  object: ProjectObject,
  candidate: LayerRange,
  excludedIds: ReadonlySet<LayerRangeId> = new Set(),
): void {
  const overlap = object.layerRanges.find(
    (range) => !excludedIds.has(range.id) && candidate.minZMm < range.maxZMm && range.minZMm < candidate.maxZMm,
  );
  if (overlap) {
    throw new Error(
      `Layer range [${candidate.minZMm}, ${candidate.maxZMm}] overlaps [${overlap.minZMm}, ${overlap.maxZMm}]`,
    );
  }
}

function assertEntityIdAvailable(state: ProjectState, id: string): void {
  if (allProjectIds(state).has(id)) throw new Error(`Injected ID ${id} already exists in the project`);
}

function allProjectIds(state: ProjectState): Set<string> {
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

function requireObject(state: ProjectState, objectId: ObjectId): ProjectObject {
  const found = findObject(state, objectId);
  if (!found) throw new Error(`Unknown object ${objectId}`);
  return found.object;
}

function requireOwnedLayerRange(object: ProjectObject, layerRangeId: LayerRangeId): LayerRange {
  const range = object.layerRanges.find((candidate) => candidate.id === layerRangeId);
  if (!range) throw new Error(`Layer range ${layerRangeId} is not owned by object ${object.id}`);
  return range;
}

function requireLayerRange(ranges: readonly LayerRange[], layerRangeId: LayerRangeId): LayerRange {
  const range = ranges.find((candidate) => candidate.id === layerRangeId);
  if (!range) throw new Error(`Unknown layer range ${layerRangeId}`);
  return range;
}

function inspectOwnedLayerRangeMerge(
  object: ProjectObject,
  firstRangeId: LayerRangeId,
  secondRangeId: LayerRangeId,
): LayerRangeMergeInspection {
  if (firstRangeId === secondRangeId) {
    return { allowed: false, reason: 'Merging layer ranges requires two distinct ranges' };
  }
  const first = object.layerRanges.find((range) => range.id === firstRangeId);
  const second = object.layerRanges.find((range) => range.id === secondRangeId);
  if (!first) {
    return { allowed: false, reason: `Layer range ${firstRangeId} is not owned by object ${object.id}` };
  }
  if (!second) {
    return { allowed: false, reason: `Layer range ${secondRangeId} is not owned by object ${object.id}` };
  }
  const [lower, upper] = orderedPair(first, second);
  const ordered = [...object.layerRanges].sort(compareLayerRanges);
  if (ordered.indexOf(upper) !== ordered.indexOf(lower) + 1 || lower.maxZMm !== upper.minZMm) {
    return {
      allowed: false,
      reason: 'Layer ranges can be merged only when they are consecutive and touch without a gap',
    };
  }
  if (canonicalStringify(lower.config) !== canonicalStringify(upper.config)) {
    return {
      allowed: false,
      reason: 'Layer ranges with different settings cannot be merged without an explicit conflict choice',
    };
  }
  if (lower.filamentId !== upper.filamentId) {
    return { allowed: false, reason: 'Layer ranges with different filament assignments cannot be merged' };
  }
  return { allowed: true };
}

function orderedPair(left: LayerRange, right: LayerRange): readonly [LayerRange, LayerRange] {
  return compareLayerRanges(left, right) <= 0 ? [left, right] : [right, left];
}

function sortLayerRanges(ranges: LayerRange[]): void {
  ranges.sort(compareLayerRanges);
}

function compareLayerRanges(left: LayerRange, right: LayerRange): number {
  return left.minZMm - right.minZMm || left.maxZMm - right.maxZMm || compareCanonicalText(left.id, right.id);
}

function repairSelectionAfterRemoval(
  context: CommandContext,
  state: ProjectState,
  before: SelectionSnapshot,
  removedId: LayerRangeId,
  fallback: SelectionRef,
): void {
  const removedKey = `layer-range:${removedId}`;
  const removedWasSelected = before.refs.some((ref) => selectionKey(ref) === removedKey);
  const primaryWasRemoved = before.primary ? selectionKey(before.primary) === removedKey : removedWasSelected;
  context.selection.prune(state);
  if (!primaryWasRemoved) return;
  const after = context.selection.getSnapshot();
  const refs = after.refs.some((ref) => selectionKey(ref) === selectionKey(fallback))
    ? after.refs
    : [...after.refs, fallback];
  context.selection.set(refs, fallback);
}
