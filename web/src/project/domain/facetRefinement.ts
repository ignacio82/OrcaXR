import { canonicalStringify, cloneJson, compareCanonicalText } from './canonical';
import type { FilamentId } from './ids';
import {
  ORCA_REFINEMENT_ENCODING_VERSION,
  ORCA_REFINEMENT_MAX_DEPTH,
  refinementNodeBudget,
  type FacetAnnotationRefinements,
  type FacetAnnotations,
  type FacetRefinementEncoding,
  type FacetRefinementNode,
  type FacetRefinementState,
  type JsonValue,
  type TriangleAssignments,
} from './model';

export type FacetRefinementChannel = keyof FacetAnnotationRefinements;

export type FacetRefinementChannelValue<Channel extends FacetRefinementChannel> =
  NonNullable<FacetAnnotationRefinements[Channel]> extends FacetRefinementEncoding<infer Value> ? Value : never;

export interface FacetRefinementIssue {
  code: string;
  path: string;
  message: string;
}

export interface FacetRefinementValidationOptions {
  triangleCount: number;
  filamentIds?: ReadonlySet<string>;
  path?: string;
  /** Canonical storage requires a split; transient commit candidates may collapse to source leaves. */
  requireSplit?: boolean;
}

/** Validate one persisted channel tree, including its sparse source-facet projection. */
export function validateFacetRefinementChannel(
  channel: FacetRefinementChannel,
  candidate: unknown,
  assignments: readonly TriangleAssignments<JsonValue>[],
  options: FacetRefinementValidationOptions,
): FacetRefinementIssue[] {
  const path = options.path ?? `refinement.${channel}`;
  const issues: FacetRefinementIssue[] = [];
  if (!isRecord(candidate)) {
    return [{ code: 'invalid-facet-refinement', path, message: 'Facet refinement must be an encoding object' }];
  }
  if (!hasExactKeys(candidate, ['version', 'roots'])) {
    issues.push({
      code: 'invalid-facet-refinement-fields',
      path,
      message: 'Facet refinement encodings may contain only version and roots',
    });
  }
  if (candidate.version !== ORCA_REFINEMENT_ENCODING_VERSION) {
    issues.push({
      code: 'invalid-facet-refinement-version',
      path: `${path}.version`,
      message: `Facet refinement version must be ${ORCA_REFINEMENT_ENCODING_VERSION}`,
    });
  }
  if (!Array.isArray(candidate.roots)) {
    issues.push({
      code: 'invalid-facet-refinement-roots',
      path: `${path}.roots`,
      message: 'Facet refinement roots must be an array',
    });
    return issues;
  }
  if (candidate.roots.length !== options.triangleCount) {
    issues.push({
      code: 'invalid-facet-refinement-root-count',
      path: `${path}.roots`,
      message: 'Facet refinement must contain exactly one root per source triangle',
    });
  }
  // One root per triangle is already required above, so a flat cap on the root
  // count would only be a cap on how many triangles a painted mesh may have.
  const nodeBudget = refinementNodeBudget(options.triangleCount);

  const assignmentByTriangle = new Map<number, JsonValue>();
  for (const assignment of assignments) {
    for (const triangle of assignment.triangles) {
      if (Number.isInteger(triangle) && triangle >= 0 && triangle < options.triangleCount) {
        assignmentByTriangle.set(triangle, assignment.value);
      }
    }
  }

  const seen = new Set<object>();
  const stack: Array<{ node: unknown; sourceTriangle: number; nodePath: string; depth: number }> = candidate.roots
    .map((node, sourceTriangle) => ({
      node,
      sourceTriangle,
      nodePath: `${path}.roots[${sourceTriangle}]`,
      depth: 0,
    }))
    .reverse();
  let nodeCount = 0;
  let hasSplit = false;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > nodeBudget) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path,
        message: `Facet refinement may contain at most ${nodeBudget} nodes`,
      });
      break;
    }
    if (!isRecord(entry.node)) {
      issues.push({
        code: 'invalid-facet-refinement-node',
        path: entry.nodePath,
        message: 'Facet refinement nodes must be objects',
      });
      continue;
    }
    if (seen.has(entry.node)) {
      issues.push({
        code: 'invalid-facet-refinement-tree',
        path: entry.nodePath,
        message: 'Facet refinement must be an acyclic tree without shared nodes',
      });
      continue;
    }
    seen.add(entry.node);

    if (entry.node.kind === 'leaf') {
      if (!hasExactKeys(entry.node, ['kind', 'state'])) {
        issues.push({
          code: 'invalid-facet-refinement-fields',
          path: entry.nodePath,
          message: 'Refined leaf nodes may contain only kind and state',
        });
      }
      if (!validState(channel, entry.node.state, options.filamentIds)) {
        issues.push({
          code: 'invalid-facet-refinement-state',
          path: `${entry.nodePath}.state`,
          message: `Refined leaf state is invalid for the ${channel} channel`,
        });
      } else if (entry.depth === 0 && entry.sourceTriangle < options.triangleCount) {
        const state = entry.node.state as FacetRefinementState;
        const assigned = assignmentByTriangle.get(entry.sourceTriangle);
        const consistent =
          state.kind === 'unpainted'
            ? assigned === undefined
            : assigned !== undefined && canonicalStringify(assigned) === canonicalStringify(state.value);
        if (!consistent) {
          issues.push({
            code: 'inconsistent-facet-refinement-state',
            path: entry.nodePath,
            message: 'Unsplit refinement roots must match the sparse source-facet assignment',
          });
        }
      }
      continue;
    }

    hasSplit = true;
    if (!hasExactKeys(entry.node, ['kind', 'splitSides', 'specialSide', 'children'])) {
      issues.push({
        code: 'invalid-facet-refinement-fields',
        path: entry.nodePath,
        message: 'Refined split nodes contain an unknown field',
      });
    }
    if (
      entry.depth === 0 &&
      entry.sourceTriangle < options.triangleCount &&
      assignmentByTriangle.has(entry.sourceTriangle)
    ) {
      issues.push({
        code: 'inconsistent-facet-refinement-state',
        path: entry.nodePath,
        message: 'A subdivided source facet cannot also have a whole-facet sparse assignment',
      });
    }
    const splitSides =
      entry.node.splitSides === 1 || entry.node.splitSides === 2 || entry.node.splitSides === 3
        ? entry.node.splitSides
        : undefined;
    const specialSide =
      entry.node.specialSide === 0 || entry.node.specialSide === 1 || entry.node.specialSide === 2
        ? entry.node.specialSide
        : undefined;
    if (
      entry.node.kind !== 'split' ||
      splitSides === undefined ||
      specialSide === undefined ||
      (splitSides === 3 && specialSide !== 0) ||
      !Array.isArray(entry.node.children) ||
      entry.node.children.length !== splitSides + 1
    ) {
      issues.push({
        code: 'invalid-facet-refinement-split',
        path: entry.nodePath,
        message: 'Refined split topology is invalid',
      });
      continue;
    }
    if (entry.depth >= ORCA_REFINEMENT_MAX_DEPTH) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path: entry.nodePath,
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_DEPTH} split levels`,
      });
      continue;
    }
    for (let childIndex = entry.node.children.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push({
        node: entry.node.children[childIndex],
        sourceTriangle: entry.sourceTriangle,
        nodePath: `${entry.nodePath}.children[${childIndex}]`,
        depth: entry.depth + 1,
      });
    }
  }
  if (!hasSplit && candidate.roots.length === options.triangleCount && options.requireSplit !== false) {
    issues.push({
      code: 'redundant-facet-refinement',
      path,
      message: 'Persisted facet refinement must contain at least one subdivided source facet',
    });
  }
  if (issues.length === 0) {
    if (hasCollapsibleFacetSplit(candidate.roots as FacetRefinementNode[])) {
      issues.push({
        code: 'noncanonical-facet-refinement',
        path,
        message: 'Homogeneous refined children must be collapsed recursively',
      });
    }
  }
  return issues;
}

export function buildFacetRefinementEncoding<T extends JsonValue>(
  assignments: readonly TriangleAssignments<T>[],
  triangleCount: number,
): FacetRefinementEncoding<T> {
  const valueByTriangle = new Map<number, T>();
  for (const assignment of assignments) {
    for (const triangle of assignment.triangles) valueByTriangle.set(triangle, assignment.value);
  }
  return {
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots: Array.from({ length: triangleCount }, (_, triangle) => {
      const value = valueByTriangle.get(triangle);
      return value === undefined
        ? ({ kind: 'leaf', state: { kind: 'unpainted' } } as const)
        : ({ kind: 'leaf', state: { kind: 'assigned', value: cloneJson(value) } } as const);
    }),
  };
}

/** Collapse homogeneous branches and clone a selector result for canonical storage. */
export function normalizeFacetRefinementEncoding<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
): FacetRefinementEncoding<T> {
  return {
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots: encoding.roots.map((root) => normalizeNode(root)),
  };
}

export function facetRefinementHasSplits(encoding: FacetRefinementEncoding): boolean {
  return encoding.roots.some((root) => root.kind === 'split');
}

/** Sparse compatibility projection: subdivided roots intentionally have no whole-facet value. */
export function facetAssignmentsFromRefinement<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
): TriangleAssignments<T>[] {
  const groups = new Map<string, TriangleAssignments<T>>();
  encoding.roots.forEach((root, triangle) => {
    if (root.kind !== 'leaf' || root.state.kind !== 'assigned') return;
    const key = canonicalStringify(root.state.value);
    const group = groups.get(key) ?? { value: cloneJson(root.state.value), triangles: [] };
    group.triangles.push(triangle);
    groups.set(key, group);
  });
  return [...groups.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([, assignment]) => assignment);
}

/** Replace whole source roots touched by a non-refined stroke. */
export function replaceFacetRefinementRoots<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  triangles: ReadonlySet<number>,
  target: FacetRefinementState<T>,
): FacetRefinementEncoding<T> {
  return normalizeFacetRefinementEncoding({
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots: encoding.roots.map((root, triangle) =>
      triangles.has(triangle) ? { kind: 'leaf', state: cloneState(target) } : root,
    ),
  });
}

export function remapFacetRefinementValues<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  remap: (value: T) => T,
): FacetRefinementEncoding<T> {
  return mapFacetRefinementStates(encoding, (state) =>
    state.kind === 'unpainted' ? state : { kind: 'assigned', value: cloneJson(remap(state.value)) },
  );
}

export function mapFacetRefinementStates<T extends JsonValue, U extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  map: (state: FacetRefinementState<T>) => FacetRefinementState<U>,
): FacetRefinementEncoding<U> {
  const mapNode = (node: FacetRefinementNode<T>): FacetRefinementNode<U> =>
    node.kind === 'leaf'
      ? { kind: 'leaf', state: cloneState(map(node.state)) }
      : {
          kind: 'split',
          splitSides: node.splitSides,
          specialSide: node.specialSide,
          children: node.children.map(mapNode),
        };
  return normalizeFacetRefinementEncoding({
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots: encoding.roots.map(mapNode),
  });
}

export function visitFacetRefinementAssignedValues<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  visitor: (value: T, path: string) => void,
): void {
  const stack: Array<{ node: FacetRefinementNode<T>; path: string }> = encoding.roots
    .map((node, index) => ({ node, path: `roots[${index}]` }))
    .reverse();
  const seen = new Set<object>();
  const budget = refinementNodeBudget(encoding.roots.length);
  while (stack.length > 0 && seen.size < budget) {
    const { node, path } = stack.pop()!;
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'leaf') {
      if (node.state.kind === 'assigned') visitor(node.state.value, `${path}.state.value`);
      continue;
    }
    for (let child = node.children.length - 1; child >= 0; child -= 1) {
      stack.push({ node: node.children[child], path: `${path}.children[${child}]` });
    }
  }
}

export function facetRefinementAssignedLeafCount(encoding: FacetRefinementEncoding): number {
  let count = 0;
  visitFacetRefinementAssignedValues(encoding, () => {
    count += 1;
  });
  return count;
}

export function facetAnnotationsHaveAssignments(annotations: FacetAnnotations): boolean {
  if (
    annotations.color.length > 0 ||
    annotations.support.length > 0 ||
    annotations.seam.length > 0 ||
    annotations.fuzzySkin.length > 0 ||
    annotations.brim.length > 0
  ) {
    return true;
  }
  return Object.keys(annotations.refinement ?? {}).length > 0;
}

function normalizeNode<T extends JsonValue>(node: FacetRefinementNode<T>): FacetRefinementNode<T> {
  if (node.kind === 'leaf') return { kind: 'leaf', state: cloneState(node.state) };
  const children = node.children.map((child) => normalizeNode(child));
  const first = children[0];
  if (
    first?.kind === 'leaf' &&
    children.every(
      (child) => child.kind === 'leaf' && canonicalStringify(child.state) === canonicalStringify(first.state),
    )
  ) {
    return { kind: 'leaf', state: cloneState(first.state) };
  }
  return {
    kind: 'split',
    splitSides: node.splitSides,
    specialSide: node.specialSide,
    children,
  };
}

function cloneState<T extends JsonValue>(state: FacetRefinementState<T>): FacetRefinementState<T> {
  return state.kind === 'unpainted' ? { kind: 'unpainted' } : { kind: 'assigned', value: cloneJson(state.value) };
}

function validState(
  channel: FacetRefinementChannel,
  candidate: unknown,
  filamentIds: ReadonlySet<string> | undefined,
): boolean {
  if (!isRecord(candidate)) return false;
  if (candidate.kind === 'unpainted') return hasExactKeys(candidate, ['kind']);
  if (candidate.kind !== 'assigned' || !hasExactKeys(candidate, ['kind', 'value'])) return false;
  switch (channel) {
    case 'color':
      return typeof candidate.value === 'string' && (!filamentIds || filamentIds.has(candidate.value as FilamentId));
    case 'support':
      return candidate.value === 'enforce' || candidate.value === 'block';
    case 'seam':
      return candidate.value === 'prefer' || candidate.value === 'avoid';
    case 'fuzzySkin':
      return candidate.value === true;
    case 'brim':
      return typeof candidate.value === 'boolean';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function hasCollapsibleFacetSplit(roots: readonly FacetRefinementNode[]): boolean {
  const leafState = new WeakMap<object, string | undefined>();
  const stack: Array<{ node: FacetRefinementNode; visited: boolean }> = roots
    .map((node) => ({ node, visited: false }))
    .reverse();
  let collapsible = false;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.node.kind === 'leaf') {
      leafState.set(entry.node, canonicalStringify(entry.node.state));
      continue;
    }
    if (!entry.visited) {
      stack.push({ node: entry.node, visited: true });
      for (let child = entry.node.children.length - 1; child >= 0; child -= 1) {
        stack.push({ node: entry.node.children[child], visited: false });
      }
      continue;
    }
    const first = leafState.get(entry.node.children[0]);
    const homogeneous = first !== undefined && entry.node.children.every((child) => leafState.get(child) === first);
    if (homogeneous) collapsible = true;
    leafState.set(entry.node, homogeneous ? first : undefined);
  }
  return collapsible;
}
