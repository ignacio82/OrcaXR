/**
 * The height-range editor's model, without a DOM.
 *
 * The semantic object editor lists an object's height ranges in height order,
 * offers a merge with the range below or above the selected one only when the
 * merge command would accept it, checks typed bounds and split heights before
 * anything is submitted, and names each operation while it runs and once it is
 * done. Native hosts run the same rules in the shared core
 * (`orcaxr_project::layer_range_editor`), replaying this file's answers.
 */
import { compareCanonicalText } from '../domain/canonical';
import type { LayerRangeId, ObjectId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { findObject } from '../domain/selectors';
import { inspectLayerRangeMerge } from './layerRangeCommands';

export interface LayerRangeEditorRange {
  readonly id: LayerRangeId;
  readonly minZMm: number;
  readonly maxZMm: number;
}

export type LayerRangeEditorMergeDecision =
  | { readonly allowed: true; readonly otherRangeId: LayerRangeId }
  | { readonly allowed: false; readonly reason: string; readonly otherRangeId?: LayerRangeId };

export interface LayerRangeEditorSelection {
  readonly id: LayerRangeId;
  /** The merge command's decision for the range below. */
  readonly mergePrevious: LayerRangeEditorMergeDecision;
  /** The merge command's decision for the range above. */
  readonly mergeNext: LayerRangeEditorMergeDecision;
}

/** One object's height ranges as the editor shows them. */
export interface LayerRangeEditorProjection {
  readonly objectId: ObjectId;
  readonly objectName: string;
  readonly layerRanges: readonly LayerRangeEditorRange[];
  readonly selectedLayerRange?: LayerRangeEditorSelection;
}

export type LayerRangeEditorDirection = 'previous' | 'next';

/**
 * [objectId]'s ranges by height, and — when [selectedLayerRangeId] is one of
 * them — what merging it with each neighbour would do.
 */
export function layerRangeEditorProjection(
  state: ProjectState,
  objectId: ObjectId,
  selectedLayerRangeId?: LayerRangeId,
): LayerRangeEditorProjection | undefined {
  const object = findObject(state, objectId)?.object;
  if (!object) return undefined;
  const layerRanges = orderLayerRanges(object.layerRanges).map((range) => ({
    id: range.id,
    minZMm: range.minZMm,
    maxZMm: range.maxZMm,
  }));
  const selectedIndex = selectedLayerRangeId ? layerRanges.findIndex((range) => range.id === selectedLayerRangeId) : -1;
  const mergeDecision = (otherIndex: number, direction: LayerRangeEditorDirection): LayerRangeEditorMergeDecision => {
    const other = layerRanges[otherIndex];
    if (!selectedLayerRangeId || !other) {
      return { allowed: false, reason: `There is no ${direction} height range.` };
    }
    const inspection = inspectLayerRangeMerge(state, object.id, selectedLayerRangeId, other.id);
    return inspection.allowed
      ? { allowed: true, otherRangeId: other.id }
      : { allowed: false, reason: inspection.reason, otherRangeId: other.id };
  };
  return {
    objectId: object.id,
    objectName: object.name,
    layerRanges,
    ...(selectedIndex >= 0 && selectedLayerRangeId
      ? {
          selectedLayerRange: {
            id: selectedLayerRangeId,
            mergePrevious: mergeDecision(selectedIndex - 1, 'previous'),
            mergeNext: mergeDecision(selectedIndex + 1, 'next'),
          },
        }
      : {}),
  };
}

/** Lower bound, then upper bound, then UTF-16 ID — the commands' own order. */
export function orderLayerRanges<T extends LayerRangeEditorRange>(ranges: readonly T[]): T[] {
  return [...ranges].sort(
    (left, right) =>
      left.minZMm - right.minZMm || left.maxZMm - right.maxZMm || compareCanonicalText(left.id, right.id),
  );
}

export interface LayerRangeBoundsValidation {
  readonly valid: boolean;
  readonly message: string;
  readonly minZMm?: number;
  readonly maxZMm?: number;
}

/**
 * Typed bounds for a new range, or for [excludedId]'s new bounds: finite,
 * `0 ≤ minimum < maximum`, and clear of every other range.
 */
export function validateLayerRangeBounds(
  rawMin: string,
  rawMax: string,
  ranges: readonly LayerRangeEditorRange[],
  excludedId?: LayerRangeId,
): LayerRangeBoundsValidation {
  const minZMm = parseLayerRangeInput(rawMin);
  const maxZMm = parseLayerRangeInput(rawMax);
  if (minZMm === undefined || maxZMm === undefined) {
    return { valid: false, message: 'Enter finite minimum and maximum Z values.' };
  }
  if (minZMm < 0 || maxZMm <= minZMm) {
    return { valid: false, message: 'Bounds must satisfy 0 ≤ minimum Z < maximum Z.' };
  }
  const overlap = ranges.find((range) => range.id !== excludedId && minZMm < range.maxZMm && range.minZMm < maxZMm);
  if (overlap) {
    return {
      valid: false,
      message: `${formatLayerRangeBounds(minZMm, maxZMm)} overlaps existing ${formatLayerRangeBounds(overlap.minZMm, overlap.maxZMm)}.`,
    };
  }
  return { valid: true, message: '', minZMm, maxZMm };
}

/** A typed split height strictly inside [selected], or why it is not. */
export function validateLayerRangeSplit(
  raw: string,
  selected: LayerRangeEditorRange,
): { readonly valid: true; readonly splitZMm: number } | { readonly valid: false; readonly message: string } {
  const splitZMm = parseLayerRangeInput(raw);
  return splitZMm !== undefined && splitZMm > selected.minZMm && splitZMm < selected.maxZMm
    ? { valid: true, splitZMm }
    : {
        valid: false,
        message: `Split height must be strictly inside ${formatLayerRangeBounds(selected.minZMm, selected.maxZMm)}.`,
      };
}

/** `Number` of a typed height; blank or non-finite text is no height. */
export function parseLayerRangeInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Why an allowed merge with the [direction] neighbour does not match what
 * the editor lists, so it is refused rather than submitted.
 */
export function inspectAllowedLayerRangeMerge(
  selectedId: LayerRangeId,
  otherId: LayerRangeId,
  ordered: readonly LayerRangeEditorRange[],
  direction: LayerRangeEditorDirection,
): string | undefined {
  const selectedIndex = ordered.findIndex((range) => range.id === selectedId);
  const expectedIndex = direction === 'previous' ? selectedIndex - 1 : selectedIndex + 1;
  const otherIndex = ordered.findIndex((range) => range.id === otherId);
  if (selectedIndex < 0 || otherIndex !== expectedIndex) {
    return `The declared ${direction} merge target is not the adjacent canonical range.`;
  }
  const lower = ordered[Math.min(selectedIndex, otherIndex)];
  const upper = ordered[Math.max(selectedIndex, otherIndex)];
  if (!lower || !upper || lower.maxZMm !== upper.minZMm) {
    return `The ${direction} range does not touch the selected range.`;
  }
  return undefined;
}

/** What one operation says while it runs and once the project took it. */
export type LayerRangeEditorOperation =
  | { readonly kind: 'add'; readonly minZMm: number; readonly maxZMm: number }
  | {
      readonly kind: 'edit';
      readonly fromMinZMm: number;
      readonly fromMaxZMm: number;
      readonly minZMm: number;
      readonly maxZMm: number;
    }
  | { readonly kind: 'split'; readonly splitZMm: number }
  | { readonly kind: 'merge'; readonly direction: LayerRangeEditorDirection }
  | { readonly kind: 'delete' };

export function layerRangeOperationMessages(operation: LayerRangeEditorOperation): {
  readonly pending: string;
  readonly success: string;
} {
  switch (operation.kind) {
    case 'add': {
      const bounds = formatLayerRangeBounds(operation.minZMm, operation.maxZMm);
      return { pending: `Adding ${bounds}…`, success: `Added ${bounds}.` };
    }
    case 'edit':
      return {
        pending: `Editing ${formatLayerRangeBounds(operation.fromMinZMm, operation.fromMaxZMm)}…`,
        success: `Updated range boundaries to ${formatLayerRangeBounds(operation.minZMm, operation.maxZMm)}.`,
      };
    case 'split':
      return {
        pending: `Splitting range at ${formatLayerRangeMm(operation.splitZMm)}…`,
        success: `Split range at ${formatLayerRangeMm(operation.splitZMm)}.`,
      };
    case 'merge':
      return {
        pending: `Merging with the ${operation.direction} range…`,
        success: `Merged with the ${operation.direction} range.`,
      };
    case 'delete':
      return { pending: 'Deleting selected range…', success: 'Deleted selected range.' };
  }
}

export function formatLayerRangeBounds(minZMm: number, maxZMm: number): string {
  return `${formatLayerRangeMm(minZMm)}–${formatLayerRangeMm(maxZMm)}`;
}

/** A height in millimetres with at most four decimals, as `en-US` writes it without grouping. */
export function formatLayerRangeMm(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4, useGrouping: false }).format(value)} mm`;
}
