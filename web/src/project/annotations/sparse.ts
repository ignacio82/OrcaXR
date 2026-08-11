import { canonicalStringify, cloneJson, compareCanonicalText } from '../domain/canonical';
import type { FacetAnnotations, JsonValue, TriangleAssignments } from '../domain/model';
import { normalizeFacetRefinementEncoding, validateFacetRefinementChannel } from '../domain/facetRefinement';
import type {
  FacetAnnotationChannel,
  FacetAnnotationIssue,
  FacetAnnotationValidationOptions,
  FacetAnnotationValue,
  FacetStrokeOperation,
  TriangleRange,
} from './types';
import { FacetAnnotationValidationError } from './types';

const CHANNELS: readonly FacetAnnotationChannel[] = ['color', 'support', 'seam', 'fuzzySkin', 'brim'];

export function normalizeTriangleRanges(ranges: readonly TriangleRange[], triangleCount: number): TriangleRange[] {
  const issues: FacetAnnotationIssue[] = [];
  const sorted = ranges
    .map((range, index) => {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.endExclusive) ||
        range.start < 0 ||
        range.endExclusive <= range.start ||
        range.endExclusive > triangleCount
      ) {
        issues.push({
          code: 'invalid-triangle-range',
          path: `ranges[${index}]`,
          message: `Expected 0 <= start < endExclusive <= ${triangleCount}`,
        });
      }
      return { start: range.start, endExclusive: range.endExclusive };
    })
    .sort((left, right) => left.start - right.start || left.endExclusive - right.endExclusive);
  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);
  const merged: TriangleRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.endExclusive) {
      previous.endExclusive = Math.max(previous.endExclusive, range.endExclusive);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function triangleRangesFromIndices(triangles: readonly number[], triangleCount: number): TriangleRange[] {
  const sorted = [...triangles].sort((left, right) => left - right);
  const ranges: TriangleRange[] = [];
  let previous = -1;
  for (const triangle of sorted) {
    if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) {
      throw new FacetAnnotationValidationError([
        {
          code: 'facet-index-out-of-range',
          path: 'triangles',
          message: `Triangle ${triangle} must be in [0, ${triangleCount - 1}]`,
        },
      ]);
    }
    if (triangle === previous) continue;
    const range = ranges.at(-1);
    if (range && range.endExclusive === triangle) range.endExclusive += 1;
    else ranges.push({ start: triangle, endExclusive: triangle + 1 });
    previous = triangle;
  }
  return ranges;
}

export function validateFacetAnnotations(
  annotations: FacetAnnotations,
  options: FacetAnnotationValidationOptions,
): FacetAnnotationIssue[] {
  const issues: FacetAnnotationIssue[] = [];
  if (annotations.topologyRevision !== options.topologyRevision) {
    issues.push({
      code: 'stale-annotation-topology',
      path: 'topologyRevision',
      message: `Expected topology revision ${options.topologyRevision}`,
    });
  }
  for (const channel of CHANNELS) {
    const assignments = annotations[channel] as readonly TriangleAssignments<JsonValue>[];
    // A painted volume holds hundreds of thousands of triangle indices per
    // channel, and this runs on every canonical commit. The index bitmap and
    // the deferred path strings below keep the common all-valid case free of
    // per-triangle allocation.
    const bounded = Number.isSafeInteger(options.triangleCount) && options.triangleCount >= 0;
    const seenFlags = bounded ? new Uint8Array(options.triangleCount) : undefined;
    const seen = seenFlags ? undefined : new Set<number>();
    for (let assignmentIndex = 0; assignmentIndex < assignments.length; assignmentIndex += 1) {
      const assignment = assignments[assignmentIndex];
      if (!validChannelValue(channel, assignment.value, options.filamentIds)) {
        issues.push({
          code: 'invalid-facet-value',
          path: `${channel}[${assignmentIndex}].value`,
          message: `Invalid ${channel} annotation value`,
        });
      }
      const triangles = assignment.triangles;
      for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
        const triangle = triangles[triangleIndex];
        if (!Number.isInteger(triangle) || triangle < 0 || triangle >= options.triangleCount) {
          issues.push({
            code: 'facet-index-out-of-range',
            path: `${channel}[${assignmentIndex}].triangles[${triangleIndex}]`,
            message: `Triangle must be in [0, ${options.triangleCount - 1}]`,
          });
          if (seen) seen.add(triangle);
          continue;
        }
        if (seenFlags ? seenFlags[triangle] === 1 : seen!.has(triangle)) {
          issues.push({
            code: 'duplicate-facet-assignment',
            path: `${channel}[${assignmentIndex}].triangles[${triangleIndex}]`,
            message: `Triangle ${triangle} is assigned twice in ${channel}`,
          });
        }
        if (seenFlags) seenFlags[triangle] = 1;
        else seen!.add(triangle);
      }
    }
  }
  const refinement = annotations.refinement as unknown;
  if (refinement !== undefined) {
    if (typeof refinement !== 'object' || refinement === null || Array.isArray(refinement)) {
      issues.push({
        code: 'invalid-facet-refinements',
        path: 'refinement',
        message: 'Facet refinements must be a per-channel object',
      });
    } else {
      const keys = Object.keys(refinement);
      if (keys.length === 0) {
        issues.push({
          code: 'empty-facet-refinements',
          path: 'refinement',
          message: 'Empty facet refinements must be omitted',
        });
      }
      keys
        .filter((key) => !(CHANNELS as readonly string[]).includes(key))
        .forEach((key) =>
          issues.push({
            code: 'unknown-facet-refinement-channel',
            path: `refinement.${key}`,
            message: `Unknown facet refinement channel ${key}`,
          }),
        );
      for (const channel of CHANNELS) {
        const candidate = (refinement as Record<string, unknown>)[channel];
        if (candidate === undefined) continue;
        issues.push(
          ...validateFacetRefinementChannel(
            channel,
            candidate,
            annotations[channel] as readonly TriangleAssignments<JsonValue>[],
            {
              triangleCount: options.triangleCount,
              ...(options.filamentIds ? { filamentIds: options.filamentIds } : {}),
              path: `refinement.${channel}`,
            },
          ),
        );
      }
    }
  }
  return issues;
}

export function normalizeFacetAnnotations(
  annotations: FacetAnnotations,
  options: FacetAnnotationValidationOptions,
): FacetAnnotations {
  const issues = validateFacetAnnotations(annotations, options);
  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);
  const refinement = annotations.refinement;
  return {
    topologyRevision: annotations.topologyRevision,
    color: normalizeChannel(annotations.color),
    support: normalizeChannel(annotations.support),
    seam: normalizeChannel(annotations.seam),
    fuzzySkin: normalizeChannel(annotations.fuzzySkin),
    brim: normalizeChannel(annotations.brim),
    ...(refinement
      ? {
          refinement: {
            ...(refinement.color ? { color: normalizeFacetRefinementEncoding(refinement.color) } : {}),
            ...(refinement.support ? { support: normalizeFacetRefinementEncoding(refinement.support) } : {}),
            ...(refinement.seam ? { seam: normalizeFacetRefinementEncoding(refinement.seam) } : {}),
            ...(refinement.fuzzySkin ? { fuzzySkin: normalizeFacetRefinementEncoding(refinement.fuzzySkin) } : {}),
            ...(refinement.brim ? { brim: normalizeFacetRefinementEncoding(refinement.brim) } : {}),
          },
        }
      : {}),
  };
}

export function normalizeFacetChannel<Channel extends FacetAnnotationChannel>(
  assignments: FacetAnnotations[Channel],
): FacetAnnotations[Channel] {
  return normalizeChannel(assignments as readonly TriangleAssignments<JsonValue>[]) as FacetAnnotations[Channel];
}

export function applyFacetChannelStroke<Channel extends FacetAnnotationChannel>(
  assignments: FacetAnnotations[Channel],
  operation: FacetStrokeOperation<Channel>,
  triangleCount: number,
): FacetAnnotations[Channel] {
  const normalized = normalizeFacetChannel(assignments);
  if (operation.mode === 'reset') return [] as unknown as FacetAnnotations[Channel];
  const ranges = normalizeTriangleRanges(operation.ranges, triangleCount);
  if (ranges.length === 0) return normalized;
  const retained = normalized
    .map((assignment) => ({
      value: assignment.value,
      triangles: assignment.triangles.filter((triangle) => !rangeContains(ranges, triangle)),
    }))
    .filter((assignment) => assignment.triangles.length > 0) as FacetAnnotations[Channel];
  if (operation.mode === 'erase') return normalizeFacetChannel(retained);

  const valueKey = canonicalStringify(operation.value);
  const target = retained.find((assignment) => canonicalStringify(assignment.value) === valueKey);
  const painted = expandRanges(ranges);
  if (target) target.triangles.push(...painted);
  else {
    (retained as TriangleAssignments<FacetAnnotationValue<Channel>>[]).push({
      value: operation.value,
      triangles: painted,
    });
  }
  return normalizeFacetChannel(retained);
}

export function facetChannelValueAt<Channel extends FacetAnnotationChannel>(
  assignments: FacetAnnotations[Channel],
  triangle: number,
): FacetAnnotationValue<Channel> | undefined {
  for (const assignment of normalizeFacetChannel(assignments)) {
    if (binaryIncludes(assignment.triangles, triangle)) return cloneJson(assignment.value);
  }
  return undefined;
}

export function facetAnnotationsBytes(annotations: FacetAnnotations): string {
  return canonicalStringify(annotations);
}

function normalizeChannel<T extends JsonValue>(
  assignments: readonly TriangleAssignments<T>[],
): TriangleAssignments<T>[] {
  const seen = new Set<number>();
  const groups = new Map<string, TriangleAssignments<T>>();
  for (const assignment of assignments) {
    const key = canonicalStringify(assignment.value);
    const group = groups.get(key) ?? { value: cloneJson(assignment.value), triangles: [] };
    for (const triangle of assignment.triangles) {
      if (seen.has(triangle)) {
        throw new FacetAnnotationValidationError([
          {
            code: 'duplicate-facet-assignment',
            path: 'triangles',
            message: `Triangle ${triangle} is assigned twice`,
          },
        ]);
      }
      seen.add(triangle);
      group.triangles.push(triangle);
    }
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, assignment]) => assignment.triangles.length > 0)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([, assignment]) => ({
      value: assignment.value,
      triangles: assignment.triangles.sort((left, right) => left - right),
    }));
}

function validChannelValue(
  channel: FacetAnnotationChannel,
  value: JsonValue,
  filamentIds?: ReadonlySet<string>,
): boolean {
  switch (channel) {
    case 'color':
      return typeof value === 'string' && (!filamentIds || filamentIds.has(value));
    case 'support':
      return value === 'enforce' || value === 'block';
    case 'seam':
      return value === 'prefer' || value === 'avoid';
    case 'fuzzySkin':
      return value === true;
    case 'brim':
      return typeof value === 'boolean';
  }
}

function rangeContains(ranges: readonly TriangleRange[], triangle: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (triangle < range.start) high = middle - 1;
    else if (triangle >= range.endExclusive) low = middle + 1;
    else return true;
  }
  return false;
}

function expandRanges(ranges: readonly TriangleRange[]): number[] {
  const count = ranges.reduce((total, range) => total + range.endExclusive - range.start, 0);
  const triangles = new Array<number>(count);
  let offset = 0;
  for (const range of ranges) {
    for (let triangle = range.start; triangle < range.endExclusive; triangle += 1) {
      triangles[offset] = triangle;
      offset += 1;
    }
  }
  return triangles;
}

function binaryIncludes(sorted: readonly number[], value: number): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] === value) return true;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}
