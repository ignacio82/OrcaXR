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
  type FacetRefinementSplit,
  type FacetRefinementSplitNode,
  type FacetRefinementState,
  type JsonValue,
  type TriangleAssignments,
} from './model';

export type FacetRefinementChannel = keyof FacetAnnotationRefinements;

/**
 * A selector result: one root per source facet, dense and transient.
 *
 * This is the working form refined selection and painting operate on. Canonical
 * state never stores it — see `collapseFacetRefinementRoots`, which splits it
 * into sparse whole-facet assignments plus the subdivided facets alone.
 */
export interface FacetRefinedRootSet<T extends JsonValue = JsonValue> {
  readonly version: number;
  readonly roots: readonly FacetRefinementNode<T>[];
}

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
  if (!hasExactKeys(candidate, ['version', 'triangleCount', 'splits'])) {
    issues.push({
      code: 'invalid-facet-refinement-fields',
      path,
      message: 'Facet refinement encodings may contain only version, triangleCount, and splits',
    });
  }
  if (candidate.version !== ORCA_REFINEMENT_ENCODING_VERSION) {
    issues.push({
      code: 'invalid-facet-refinement-version',
      path: `${path}.version`,
      message: `Facet refinement version must be ${ORCA_REFINEMENT_ENCODING_VERSION}`,
    });
  }
  if (candidate.triangleCount !== options.triangleCount) {
    issues.push({
      code: 'invalid-facet-refinement-triangle-count',
      path: `${path}.triangleCount`,
      message: 'Facet refinement must declare the source mesh triangle count',
    });
  }
  if (!Array.isArray(candidate.splits)) {
    issues.push({
      code: 'invalid-facet-refinement-splits',
      path: `${path}.splits`,
      message: 'Facet refinement splits must be an array',
    });
    return issues;
  }
  const nodeBudget = refinementNodeBudget(options.triangleCount);

  // Only the subdivided facets can conflict with a whole-facet assignment, and
  // there are far fewer of them than there are assignments: a painted model
  // carries hundreds of thousands of assigned facets and a few thousand
  // subdivided ones, so the small side is the one worth indexing.
  const splitTriangles = new Set<number>();
  for (const entry of candidate.splits as readonly unknown[]) {
    if (isRecord(entry) && typeof entry.triangle === 'number') splitTriangles.add(entry.triangle);
  }
  const assignedSplitTriangles = new Set<number>();
  if (splitTriangles.size > 0) {
    for (const assignment of assignments) {
      for (const triangle of assignment.triangles) {
        if (splitTriangles.has(triangle)) assignedSplitTriangles.add(triangle);
      }
    }
  }

  // Ascending, in range, and without repeats: a split list that could name the
  // same facet twice would have two competing answers for one facet.
  let previousTriangle = -1;
  for (let index = 0; index < candidate.splits.length; index += 1) {
    const entry: unknown = candidate.splits[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ['triangle', 'node'])) {
      issues.push({
        code: 'invalid-facet-refinement-split-entry',
        path: `${path}.splits[${index}]`,
        message: 'Each refinement split must contain only a triangle and its node',
      });
      continue;
    }
    const triangle = entry.triangle;
    if (
      typeof triangle !== 'number' ||
      !Number.isInteger(triangle) ||
      triangle < 0 ||
      triangle >= options.triangleCount
    ) {
      issues.push({
        code: 'invalid-facet-refinement-split-triangle',
        path: `${path}.splits[${index}].triangle`,
        message: 'A refinement split must name a source facet of this mesh',
      });
      continue;
    }
    if (triangle <= previousTriangle) {
      issues.push({
        code: 'invalid-facet-refinement-split-order',
        path: `${path}.splits[${index}].triangle`,
        message: 'Refinement splits must be ordered by ascending source facet without repeats',
      });
    }
    previousTriangle = triangle;
  }

  const seen = new Set<object>();
  const stack: Array<{ node: unknown; sourceTriangle: number; nodePath: string; depth: number }> = candidate.splits
    .map((entry: unknown, index: number) => ({
      node: isRecord(entry) ? entry.node : entry,
      sourceTriangle: isRecord(entry) && typeof entry.triangle === 'number' ? entry.triangle : -1,
      nodePath: `${path}.splits[${index}].node`,
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
      }
      if (entry.depth === 0) {
        // An unsubdivided facet is described entirely by its sparse
        // assignment, so storing a leaf here would be a second, silently
        // divergent copy of the same fact.
        issues.push({
          code: 'invalid-facet-refinement-split',
          path: entry.nodePath,
          message: 'A stored refinement entry must subdivide its source facet',
        });
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
      assignedSplitTriangles.has(entry.sourceTriangle)
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
  if (!hasSplit && options.requireSplit !== false) {
    issues.push({
      code: 'redundant-facet-refinement',
      path,
      message: 'Persisted facet refinement must contain at least one subdivided source facet',
    });
  }
  if (issues.length === 0) {
    const nodes = (candidate.splits as readonly FacetRefinementSplit[]).map((entry) => entry.node);
    if (hasCollapsibleFacetSplit(nodes)) {
      issues.push({
        code: 'noncanonical-facet-refinement',
        path,
        message: 'Homogeneous refined children must be collapsed recursively',
      });
    }
  }
  return issues;
}

/**
 * Expand a channel back to one root per source facet.
 *
 * Only code that genuinely walks every facet — a refined painting session, the
 * BBS writer — should call this, and only for as long as it needs it. It is
 * the expensive representation the canonical store deliberately no longer
 * holds, so keeping the result alive re-creates the problem sparse storage
 * exists to solve.
 */
export function expandFacetRefinementRoots<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T> | undefined,
  assignments: readonly TriangleAssignments<T>[],
  triangleCount: number,
): FacetRefinementNode<T>[] {
  const roots: FacetRefinementNode<T>[] = new Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    roots[triangle] = { kind: 'leaf', state: { kind: 'unpainted' } };
  }
  for (const assignment of assignments) {
    for (const triangle of assignment.triangles) {
      if (triangle >= 0 && triangle < triangleCount) {
        roots[triangle] = { kind: 'leaf', state: { kind: 'assigned', value: cloneJson(assignment.value) } };
      }
    }
  }
  for (const split of encoding?.splits ?? []) {
    if (split.triangle >= 0 && split.triangle < triangleCount) roots[split.triangle] = cloneNode(split.node);
  }
  return roots;
}

/**
 * Split a dense per-facet root list into the two things canonical state keeps:
 * sparse whole-facet assignments, and the subdivided facets alone.
 */
export function collapseFacetRefinementRoots<T extends JsonValue>(
  roots: readonly FacetRefinementNode<T>[],
): { assignments: TriangleAssignments<T>[]; encoding: FacetRefinementEncoding<T> | undefined } {
  const groups = new Map<string, TriangleAssignments<T>>();
  const splits: FacetRefinementSplit<T>[] = [];
  for (let triangle = 0; triangle < roots.length; triangle += 1) {
    const normalized = normalizeNode(roots[triangle]);
    if (normalized.kind === 'split') {
      splits.push({ triangle, node: normalized });
      continue;
    }
    if (normalized.state.kind !== 'assigned') continue;
    const key = canonicalStringify(normalized.state.value);
    const group = groups.get(key) ?? { value: cloneJson(normalized.state.value), triangles: [] };
    group.triangles.push(triangle);
    groups.set(key, group);
  }
  const assignments = [...groups.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([, assignment]) => assignment);
  return {
    assignments,
    encoding:
      splits.length === 0
        ? undefined
        : { version: ORCA_REFINEMENT_ENCODING_VERSION, triangleCount: roots.length, splits },
  };
}

/**
 * Remap every value of one channel, across both of its halves.
 *
 * Remapping can make a subdivided facet uniform — paint two of its children the
 * same colour and it is no longer subdivided. That facet's value then belongs
 * in the whole-facet assignments; dropping the collapsed split without moving
 * its value there would silently unpaint the facet.
 */
export function remapFacetChannelValues<T extends JsonValue>(
  assignments: readonly TriangleAssignments<T>[],
  encoding: FacetRefinementEncoding<T> | undefined,
  remap: (value: T) => T,
): { assignments: TriangleAssignments<T>[]; encoding: FacetRefinementEncoding<T> | undefined } {
  const valueByTriangle = new Map<number, T>();
  for (const assignment of assignments) {
    const value = remap(assignment.value);
    for (const triangle of assignment.triangles) valueByTriangle.set(triangle, value);
  }
  const splits: FacetRefinementSplit<T>[] = [];
  for (const split of encoding?.splits ?? []) {
    const mapped = normalizeNode(
      mapNodeStates<T, T>(split.node, (state) =>
        state.kind === 'unpainted' ? state : { kind: 'assigned', value: cloneJson(remap(state.value)) },
      ),
    );
    if (mapped.kind === 'split') {
      splits.push({ triangle: split.triangle, node: mapped });
    } else if (mapped.state.kind === 'assigned') {
      valueByTriangle.set(split.triangle, mapped.state.value);
    } else {
      valueByTriangle.delete(split.triangle);
    }
  }
  return {
    assignments: groupTriangleAssignments(valueByTriangle),
    encoding:
      splits.length === 0
        ? undefined
        : {
            version: ORCA_REFINEMENT_ENCODING_VERSION,
            triangleCount: encoding?.triangleCount ?? 0,
            splits: splits.sort((left, right) => left.triangle - right.triangle),
          },
  };
}

function groupTriangleAssignments<T extends JsonValue>(
  valueByTriangle: ReadonlyMap<number, T>,
): TriangleAssignments<T>[] {
  const groups = new Map<string, TriangleAssignments<T>>();
  for (const triangle of [...valueByTriangle.keys()].sort((left, right) => left - right)) {
    const value = valueByTriangle.get(triangle)!;
    const key = canonicalStringify(value);
    const group = groups.get(key) ?? { value: cloneJson(value), triangles: [] };
    group.triangles.push(triangle);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([, assignment]) => assignment);
}

function mapNodeStates<T extends JsonValue, U extends JsonValue>(
  node: FacetRefinementNode<T>,
  map: (state: FacetRefinementState<T>) => FacetRefinementState<U>,
): FacetRefinementNode<U> {
  return node.kind === 'leaf'
    ? { kind: 'leaf', state: cloneState(map(node.state)) }
    : {
        kind: 'split',
        splitSides: node.splitSides,
        specialSide: node.specialSide,
        children: node.children.map((child) => mapNodeStates(child, map)),
      };
}

/**
 * Collapse homogeneous branches and clone a selector result for canonical
 * storage. A split that collapses entirely to a leaf is dropped — use
 * `remapFacetChannelValues` when the collapsed value still has to be kept.
 */
export function normalizeFacetRefinementEncoding<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
): FacetRefinementEncoding<T> {
  const splits: FacetRefinementSplit<T>[] = [];
  for (const split of encoding.splits) {
    const normalized = normalizeNode(split.node);
    // A branch that collapses to a single leaf is no longer a subdivision, and
    // the whole-facet value it collapsed to belongs in the sparse assignments.
    if (normalized.kind === 'split') splits.push({ triangle: split.triangle, node: normalized });
  }
  splits.sort((left, right) => left.triangle - right.triangle);
  return {
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    triangleCount: encoding.triangleCount,
    splits,
  };
}

export function facetRefinementHasSplits(encoding: FacetRefinementEncoding): boolean {
  return encoding.splits.length > 0;
}

/** The subdivision tree of one source facet, when it has one. */
export function facetRefinementSplitAt<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T> | undefined,
  triangle: number,
): FacetRefinementSplitNode<T> | undefined {
  return encoding?.splits.find((split) => split.triangle === triangle)?.node;
}

/** Drop the subdivision of every source facet a whole-facet stroke covered. */
export function replaceFacetRefinementRoots<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  triangles: ReadonlySet<number>,
): FacetRefinementEncoding<T> {
  return normalizeFacetRefinementEncoding({
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    triangleCount: encoding.triangleCount,
    splits: encoding.splits.filter((split) => !triangles.has(split.triangle)),
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
    triangleCount: encoding.triangleCount,
    splits: encoding.splits.map((split) => ({
      triangle: split.triangle,
      // A split's children are mapped, but the split itself stays a split;
      // `normalizeFacetRefinementEncoding` drops it if mapping made it uniform.
      node: mapNode(split.node) as FacetRefinementSplitNode<U>,
    })),
  });
}

export function visitFacetRefinementAssignedValues<T extends JsonValue>(
  encoding: FacetRefinementEncoding<T>,
  visitor: (value: T, path: string) => void,
): void {
  const stack: Array<{ node: FacetRefinementNode<T>; path: string }> = encoding.splits
    .map((split, index) => ({ node: split.node as FacetRefinementNode<T>, path: `splits[${index}].node` }))
    .reverse();
  const seen = new Set<object>();
  const budget = refinementNodeBudget(encoding.triangleCount);
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

function cloneNode<T extends JsonValue>(node: FacetRefinementNode<T>): FacetRefinementNode<T> {
  return node.kind === 'leaf'
    ? { kind: 'leaf', state: cloneState(node.state) }
    : {
        kind: 'split',
        splitSides: node.splitSides,
        specialSide: node.specialSide,
        children: node.children.map(cloneNode),
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
