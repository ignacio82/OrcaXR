import {
  ORCA_REFINEMENT_ENCODING_VERSION,
  ORCA_REFINEMENT_MAX_DEPTH,
  ORCA_REFINEMENT_MAX_NODES,
  type FacetAnnotations,
  type FacetRefinementEncoding,
  type FacetRefinementNode,
  type FacetRefinementState,
  type JsonValue,
  type TriangleAssignments,
  type Vec3,
} from '../domain/model';
import { canonicalStringify, cloneJson, deepFreeze } from '../domain/canonical';
import { triangleRangesFromIndices, validateFacetAnnotations } from './sparse';
import {
  FacetAnnotationValidationError,
  StaleFacetAnnotationResultError,
  type FacetAnnotationChannel,
  type FacetAnnotationIssue,
  type TriangleRange,
} from './types';

/**
 * Snapmaker Orca v2.3.4 uses the libslic3r-wide epsilon at the smart-fill
 * angle boundary (`TriangleSelector.cpp`, bucket_fill_select_triangles).
 */
export const ORCA_TRIANGLE_SELECTOR_EPSILON = 1e-4;
export const ORCA_SMART_FILL_ANGLE_MIN_DEGREES = 0;
export const ORCA_SMART_FILL_ANGLE_MAX_DEGREES = 90;
export const ORCA_BRUSH_RADIUS_MIN_MM = 0.4;
export const ORCA_BRUSH_RADIUS_MAX_MM = 8;
export const ORCA_HEIGHT_RANGE_MIN_MM = 0.1;
export const ORCA_HEIGHT_RANGE_MAX_MM = 8;
export const ORCA_GAP_AREA_MIN_MM2 = 0;
export const ORCA_GAP_AREA_MAX_MM2 = 5;
export const ORCA_GAP_AREA_STEP_MM2 = 0.2;
export const ORCA_OVERHANG_ANGLE_MIN_DEGREES = 0;
export const ORCA_OVERHANG_ANGLE_MAX_DEGREES = 90;
export { ORCA_REFINEMENT_ENCODING_VERSION, ORCA_REFINEMENT_MAX_DEPTH, ORCA_REFINEMENT_MAX_NODES };
export type { FacetRefinementEncoding, FacetRefinementNode };

export type FacetTriangle = readonly [number, number, number];

/** Structural subset shared by decoded canonical mesh assets and paint tools. */
export interface FacetSelectionMesh {
  readonly vertices: readonly Vec3[];
  readonly triangles: readonly FacetTriangle[];
}

/**
 * Volume-local form of TriangleSelector::ClippingPlane. A point is clipped
 * only when `normal dot point - offset > 0`; points on the plane remain live.
 */
export interface FacetClippingPlane {
  readonly normal: Vec3;
  readonly offset: number;
}

/**
 * Row-major affine transform plus the exact absolute scale decomposition used
 * by `Geometry::Transformation::get_scaling_factor()`. Keeping the factors
 * explicit avoids silently approximating Orca's polar decomposition.
 */
export interface FacetSelectionTransform {
  readonly linear: readonly [Vec3, Vec3, Vec3];
  readonly translation: Vec3;
  readonly scalingFactors: Vec3;
}

export const IDENTITY_FACET_SELECTION_TRANSFORM: FacetSelectionTransform = Object.freeze({
  linear: Object.freeze([
    Object.freeze([1, 0, 0]) as Vec3,
    Object.freeze([0, 1, 0]) as Vec3,
    Object.freeze([0, 0, 1]) as Vec3,
  ]) as readonly [Vec3, Vec3, Vec3],
  translation: Object.freeze([0, 0, 0]) as Vec3,
  scalingFactors: Object.freeze([1, 1, 1]) as Vec3,
});

export interface FacetBrushGeometry {
  /** Current ray hit in volume-local mesh coordinates. */
  readonly center: Vec3;
  /**
   * Previous ray hit for one dragged segment. When present, Circle resolves to
   * upstream Capsule2D and Sphere resolves to Capsule3D; `seedTriangle` is the
   * facet hit at this first point.
   */
  readonly previousCenter?: Vec3;
  /** Camera/ray origin in volume-local mesh coordinates. */
  readonly cameraPosition: Vec3;
  /** Pinned UI radius measured in world millimetres. */
  readonly radiusMm: number;
  /**
   * Reproduce TriangleSelector's adaptive recursive edge subdivision. Omission
   * preserves the source-facet selection contract.
   */
  readonly triangleSplitting?: boolean;
}

export type FacetRegionTool =
  | {
      readonly kind: 'triangle';
      /** Required to resolve a leaf when `refinement` has split this root. */
      readonly hit?: Vec3;
    }
  | ({ readonly kind: 'circle' } & FacetBrushGeometry)
  | ({ readonly kind: 'sphere' } & FacetBrushGeometry)
  | {
      readonly kind: 'heightRange';
      /** Plate/world Z at the ray hit. */
      readonly startZMm: number;
      readonly heightMm: number;
      readonly triangleSplitting?: boolean;
    }
  | {
      readonly kind: 'fill';
      /** Required to resolve a leaf when `refinement` has split this root. */
      readonly hit?: Vec3;
      readonly edgeDetection:
        | false
        | {
            readonly maxAdjacentAngleDegrees: number;
          };
    }
  | {
      readonly kind: 'gapFill';
      /** Strict upper bound for a connected patch's volume-local area. */
      readonly maxAreaMm2: number;
      /**
       * Assigned states in pinned EnforcerBlockerType order. Unpainted/default
       * is implicit state zero and therefore always wins over an assigned
       * neighbor. Color callers pass the displayed filament-ID order.
       */
      readonly stateOrder: readonly JsonValue[];
    };

export interface FacetRefinedLeafReference {
  readonly sourceTriangle: number;
  readonly path: readonly number[];
}

export interface FacetRefinedLeaf extends FacetRefinedLeafReference {
  readonly vertexIndices: FacetTriangle;
  readonly state: FacetRegionState;
  readonly selected: boolean;
}

export interface FacetRefinedSelection {
  /** Present only when this operation computed a new adaptive edge limit. */
  readonly edgeLimitMm?: number;
  /** Source vertices first, followed by deterministic shared midpoint order. */
  readonly vertices: readonly Vec3[];
  readonly encoding: FacetRefinementEncoding;
  /**
   * Depth-first root/child order, including unselected leaves. The encoding
   * preserves pre-commit states while these flags identify the paint target;
   * the commit layer applies its target state and collapses homogeneous child
   * sets just like `remove_useless_children()`.
   */
  readonly leaves: readonly FacetRefinedLeaf[];
}

export interface FacetRefinedStateUpdate extends FacetRefinedLeafReference {
  readonly target: FacetRegionState;
}

export interface FacetRegionSelectionRequest<Channel extends FacetAnnotationChannel> {
  readonly mesh: FacetSelectionMesh;
  readonly annotations: FacetAnnotations;
  readonly channel: Channel;
  readonly guard: {
    readonly topologyRevision: number;
    readonly triangleCount: number;
  };
  readonly seedTriangle: number;
  readonly tool: FacetRegionTool;
  readonly clippingPlane?: FacetClippingPlane;
  readonly transform?: FacetSelectionTransform;
  /** Prior per-leaf topology/state for this channel. */
  readonly refinement?: FacetRefinementEncoding;
  /**
   * Pinned `highlight_by_angle_deg` gate. Zero (and omission) disable it.
   * The color-painter path applies it to Circle, Sphere, and Height Range.
   */
  readonly highlightByAngleDegrees?: number;
}

export interface FacetRegionSelection {
  readonly triangleIndices: readonly number[];
  readonly ranges: readonly TriangleRange[];
  /**
   * Present only for Gap Fill. Replacements are disjoint and all targets are
   * resolved from the same pre-operation annotation snapshot. The top-level
   * indices/ranges are their union for preview/invalidation, not one paint
   * target; apply these replacements individually.
   */
  readonly gapFillReplacements?: readonly FacetGapFillReplacement[];
  /**
   * Present when refinement was supplied or adaptive splitting was requested.
   * Top-level indices/ranges are the source-root union; use selected leaves for
   * a partial refined commit.
   */
  readonly refinement?: FacetRefinedSelection;
}

export interface FacetRefinementMaterializationRequest<Channel extends FacetAnnotationChannel> {
  readonly mesh: FacetSelectionMesh;
  readonly annotations: FacetAnnotations;
  readonly channel: Channel;
  readonly guard: { readonly topologyRevision: number; readonly triangleCount: number };
  readonly refinement: FacetRefinementEncoding;
}

export type FacetRegionState = FacetRefinementState;

export interface FacetGapFillReplacement {
  readonly areaMm2: number;
  readonly source: FacetRegionState;
  readonly target: FacetRegionState;
  readonly triangleIndices: readonly number[];
  readonly ranges: readonly TriangleRange[];
  readonly refinedLeaves?: readonly FacetRefinedLeafReference[];
}

export type OrcaFaceNeighbors = readonly (readonly [number, number, number])[];

export type PainterDragAxisFilter = 'none' | 'vertical' | 'horizontal';
export type PainterScreenPoint = readonly [number, number];

/** Exact screen-space vertical/horizontal drag constraint from GLGizmoPainterBase. */
export function constrainPainterDragPoint(
  previous: PainterScreenPoint,
  current: PainterScreenPoint,
  filter: PainterDragAxisFilter,
): PainterScreenPoint {
  if ([...previous, ...current].some((coordinate) => !Number.isFinite(coordinate))) {
    throw new FacetAnnotationValidationError([
      {
        code: 'invalid-painter-screen-point',
        path: 'screenPoint',
        message: 'Painter screen points must be finite',
      },
    ]);
  }
  switch (filter) {
    case 'vertical':
      return Object.freeze([previous[0], current[1]]);
    case 'horizontal':
      return Object.freeze([current[0], previous[1]]);
    case 'none':
      return Object.freeze([...current]) as PainterScreenPoint;
  }
}

/**
 * Reproduce `its_face_neighbors` from the pinned Snapmaker Orca revision.
 *
 * Connectivity is topological, not positional: two faces must share the same
 * vertex indices in opposite winding order. At a non-manifold edge, upstream
 * deterministically pairs the first still-unpaired later face.
 */
export function buildOrcaFaceNeighbors(mesh: FacetSelectionMesh): OrcaFaceNeighbors {
  validateMesh(mesh);
  return buildValidatedOrcaFaceNeighbors(mesh);
}

/**
 * Select source facets, or explicitly encoded refined leaves, with the pinned
 * Circle, Sphere, Triangle, Height Range, Fill, or Gap Fill geometry.
 *
 * Circle/Sphere reproduce the upstream single-point and dragged Capsule2D/3D
 * vertex, cursor-ray, and edge tests plus connected propagation; only Circle
 * culls back-facing neighbors. Upstream applies clipping to vertex containment
 * but not its ray/edge tests. Height Range scans every source facet in
 * transformed plate/world Z and likewise does not consult clipping. Circle,
 * Sphere, and Height Range optionally apply the strict upstream overhang-only
 * gate to inverse-transpose transformed face normals; translation is
 * irrelevant. Fill is state-aware bucket fill: it
 * crosses oriented shared edges only while the neighbor has the seed facet's
 * current value (including unpainted), survives the optional smart-angle
 * boundary, and rejects clipped neighbors without dropping the seed. Gap Fill
 * globally snapshots same-state connected components, ignores clipping and
 * transforms, then reports every strict-area fragment's remap to its lowest
 * ordered adjacent state.
 *
 * Without refinement, returned ranges plug directly into
 * `commitFacetAnnotationStroke`; that command's captured guard rejects an
 * async result after project drift. With refinement, source ranges are only
 * the invalidation/preview union and callers commit the selected leaf paths.
 */
export function selectFacetRegion<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
): FacetRegionSelection {
  validateRequest(request);

  if (
    request.annotations.topologyRevision !== request.guard.topologyRevision ||
    request.mesh.triangles.length !== request.guard.triangleCount
  ) {
    throw new StaleFacetAnnotationResultError('topology');
  }

  const annotationIssues = validateFacetAnnotations(request.annotations, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
  });
  if (annotationIssues.length > 0) throw new FacetAnnotationValidationError(annotationIssues);

  if (usesRefinedSelection(request)) return selectRefinedFacetRegion(request);

  const tool = request.tool;
  switch (tool.kind) {
    case 'triangle':
      return selectionFromIndices([request.seedTriangle], request.guard.triangleCount);
    case 'circle':
    case 'sphere':
      return selectBrushRegion(request, tool);
    case 'heightRange':
      return selectHeightRange(request, tool);
    case 'gapFill':
      return selectGapFill(request, tool);
    case 'fill':
      break;
  }

  const neighbors = buildValidatedOrcaFaceNeighbors(request.mesh);
  const states = facetStates(
    request.annotations[request.channel] as readonly TriangleAssignments<JsonValue>[],
    request.guard.triangleCount,
  );
  const normals = tool.edgeDetection
    ? request.mesh.triangles.map((triangle) => orcaFaceNormal(request.mesh.vertices, triangle))
    : undefined;
  const angleLimit = tool.edgeDetection
    ? orcaCosDegrees(tool.edgeDetection.maxAdjacentAngleDegrees) - ORCA_TRIANGLE_SELECTOR_EPSILON
    : undefined;

  const visited = new Uint8Array(request.guard.triangleCount);
  const selected = new Uint8Array(request.guard.triangleCount);
  const queue: number[] = [request.seedTriangle];
  let head = 0;
  const seedState = states[request.seedTriangle];

  while (head < queue.length) {
    const current = queue[head++];
    if (visited[current] !== 0) continue;

    selected[current] = 1;
    for (const neighbor of neighbors[current]) {
      if (
        neighbor < 0 ||
        visited[neighbor] !== 0 ||
        states[neighbor] !== seedState ||
        isFacetClipped(request.mesh, neighbor, request.clippingPlane)
      ) {
        continue;
      }

      if (normals && angleLimit !== undefined) {
        const dot = clamp(orcaDot(normals[neighbor], normals[current]), 0, 1);
        if (dot < angleLimit) continue;
      }
      queue.push(neighbor);
    }
    visited[current] = 1;
  }

  const indices: number[] = [];
  selected.forEach((value, index) => {
    if (value !== 0) indices.push(index);
  });
  return selectionFromIndices(indices, request.guard.triangleCount);
}

/** Reconstruct every persisted refined leaf for a derived render overlay. */
export function materializeFacetRefinement<Channel extends FacetAnnotationChannel>(
  request: FacetRefinementMaterializationRequest<Channel>,
): FacetRefinedSelection {
  const internal: FacetRegionSelectionRequest<Channel> = {
    ...request,
    seedTriangle: 0,
    tool: { kind: 'triangle' },
  };
  validateRequest(internal);
  if (
    request.annotations.topologyRevision !== request.guard.topologyRevision ||
    request.mesh.triangles.length !== request.guard.triangleCount
  ) {
    throw new StaleFacetAnnotationResultError('topology');
  }
  const annotationIssues = validateFacetAnnotations(request.annotations, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
  });
  if (annotationIssues.length > 0) throw new FacetAnnotationValidationError(annotationIssues);
  return freezeRefinedSelection(buildRefinementWorkspace(internal), new Set<number>(), undefined);
}

/**
 * Apply one paint/erase target to the leaves selected by a refined tool result.
 *
 * The selector intentionally preserves pre-stroke states so previews are
 * read-only. This commit helper performs the complementary state transition,
 * removes homogeneous child sets recursively (the pinned
 * `remove_useless_children()` behavior), and returns a detached frozen
 * encoding. Newly created adaptive splits therefore disappear when the target
 * already matches every selected leaf.
 */
export function applyFacetRefinedSelection(
  channel: FacetAnnotationChannel,
  selection: FacetRefinedSelection,
  target: FacetRegionState,
): FacetRefinementEncoding {
  return applyFacetRefinedStateUpdates(
    channel,
    selection,
    selection.leaves
      .filter((leaf) => leaf.selected)
      .map((leaf) => ({
        sourceTriangle: leaf.sourceTriangle,
        path: leaf.path,
        target,
      })),
  );
}

/**
 * Apply disjoint per-leaf targets, as required by refined Gap Fill, then
 * collapse every now-homogeneous branch. Update references are stable
 * `(sourceTriangle, path)` keys and must resolve to leaves in the supplied
 * selector result.
 */
export function applyFacetRefinedStateUpdates(
  channel: FacetAnnotationChannel,
  selection: FacetRefinedSelection,
  updates: readonly FacetRefinedStateUpdate[],
): FacetRefinementEncoding {
  const encodedLeaves = validateRefinedCommitSelection(channel, selection);
  const available = new Set(encodedLeaves.map((leaf) => refinedLeafKey(leaf.sourceTriangle, leaf.path)));
  const targets = new Map<string, FacetRegionState>();
  const issues: FacetAnnotationIssue[] = [];

  updates.forEach((update, updateIndex) => {
    const path = `updates[${updateIndex}]`;
    if (
      !Number.isSafeInteger(update.sourceTriangle) ||
      update.sourceTriangle < 0 ||
      update.sourceTriangle >= selection.encoding.roots.length ||
      !Array.isArray(update.path) ||
      update.path.some((child) => !Number.isSafeInteger(child) || child < 0 || child > 3)
    ) {
      issues.push({
        code: 'invalid-refined-leaf-reference',
        path,
        message: 'Refined leaf references require an in-range source triangle and child path',
      });
      return;
    }
    if (!isValidRefinementState(channel, update.target)) {
      issues.push({
        code: 'invalid-facet-refinement-state',
        path: `${path}.target`,
        message: `Refined leaf target is invalid for the ${channel} channel`,
      });
      return;
    }
    const key = refinedLeafKey(update.sourceTriangle, update.path);
    if (!available.has(key)) {
      issues.push({
        code: 'missing-refined-leaf',
        path,
        message: 'Refined leaf update does not resolve to a leaf in this selector result',
      });
      return;
    }
    if (targets.has(key)) {
      issues.push({
        code: 'duplicate-refined-leaf-update',
        path,
        message: 'A refined leaf may be updated at most once per commit',
      });
      return;
    }
    targets.set(key, cloneRefinementState(update.target));
  });

  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);

  const roots = selection.encoding.roots.map((root, sourceTriangle) =>
    applyRefinedNodeUpdates(root, sourceTriangle, [], targets),
  );
  return deepFreeze({
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots,
  });
}

function applyRefinedNodeUpdates(
  node: FacetRefinementNode,
  sourceTriangle: number,
  path: readonly number[],
  targets: ReadonlyMap<string, FacetRegionState>,
): FacetRefinementNode {
  if (node.kind === 'leaf') {
    return {
      kind: 'leaf',
      state: cloneRefinementState(targets.get(refinedLeafKey(sourceTriangle, path)) ?? node.state),
    };
  }
  const children = node.children.map((child, childIndex) =>
    applyRefinedNodeUpdates(child, sourceTriangle, [...path, childIndex], targets),
  );
  const first = children[0];
  if (
    first.kind === 'leaf' &&
    children.every(
      (child) => child.kind === 'leaf' && canonicalStringify(child.state) === canonicalStringify(first.state),
    )
  ) {
    return {
      kind: 'leaf',
      state: cloneRefinementState(first.state),
    };
  }
  return {
    kind: 'split',
    splitSides: node.splitSides,
    specialSide: node.specialSide,
    children,
  };
}

function validateRefinedCommitSelection(
  channel: FacetAnnotationChannel,
  selection: FacetRefinedSelection,
): FacetRefinedLeafReference[] {
  const issues: FacetAnnotationIssue[] = [];
  if (
    typeof selection !== 'object' ||
    selection === null ||
    typeof selection.encoding !== 'object' ||
    selection.encoding === null ||
    selection.encoding.version !== ORCA_REFINEMENT_ENCODING_VERSION ||
    !Array.isArray(selection.encoding.roots) ||
    !Array.isArray(selection.leaves)
  ) {
    throw new FacetAnnotationValidationError([
      {
        code: 'invalid-refined-selection',
        path: 'selection',
        message: 'Refined selection must contain a versioned encoding and leaf list',
      },
    ]);
  }
  if (selection.encoding.roots.length > ORCA_REFINEMENT_MAX_NODES) {
    throw new FacetAnnotationValidationError([
      {
        code: 'facet-refinement-limit-exceeded',
        path: 'selection.encoding.roots',
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_NODES} nodes`,
      },
    ]);
  }

  const encodedLeaves: Array<FacetRefinedLeafReference & { readonly state: FacetRegionState }> = [];
  const seen = new Set<object>();
  const stack: Array<{
    readonly node: unknown;
    readonly sourceTriangle: number;
    readonly path: readonly number[];
    readonly depth: number;
  }> = selection.encoding.roots
    .map((node, sourceTriangle) => ({ node, sourceTriangle, path: [] as readonly number[], depth: 0 }))
    .reverse();
  let nodeCount = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > ORCA_REFINEMENT_MAX_NODES) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path: 'selection.encoding',
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_NODES} nodes`,
      });
      break;
    }
    const node = entry.node;
    const nodePath = `selection.encoding.roots[${entry.sourceTriangle}]${entry.path
      .map((child) => `.children[${child}]`)
      .join('')}`;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      issues.push({
        code: 'invalid-facet-refinement-node',
        path: nodePath,
        message: 'Facet refinement nodes must be objects',
      });
      continue;
    }
    if (seen.has(node)) {
      issues.push({
        code: 'invalid-facet-refinement-tree',
        path: nodePath,
        message: 'Facet refinement must be an acyclic tree without shared nodes',
      });
      continue;
    }
    seen.add(node);
    const record = node as {
      readonly kind?: unknown;
      readonly state?: unknown;
      readonly splitSides?: unknown;
      readonly specialSide?: unknown;
      readonly children?: unknown;
    };
    if (record.kind === 'leaf') {
      if (!isValidRefinementState(channel, record.state)) {
        issues.push({
          code: 'invalid-facet-refinement-state',
          path: `${nodePath}.state`,
          message: `Refined leaf state is invalid for the ${channel} channel`,
        });
      } else {
        encodedLeaves.push({
          sourceTriangle: entry.sourceTriangle,
          path: [...entry.path],
          state: record.state,
        });
      }
      continue;
    }
    const splitSides =
      record.splitSides === 1 || record.splitSides === 2 || record.splitSides === 3 ? record.splitSides : undefined;
    const specialSide =
      record.specialSide === 0 || record.specialSide === 1 || record.specialSide === 2 ? record.specialSide : undefined;
    if (
      record.kind !== 'split' ||
      splitSides === undefined ||
      specialSide === undefined ||
      (splitSides === 3 && specialSide !== 0) ||
      !Array.isArray(record.children) ||
      record.children.length !== splitSides + 1
    ) {
      issues.push({
        code: 'invalid-facet-refinement-split',
        path: nodePath,
        message: 'Refined split topology is invalid',
      });
      continue;
    }
    if (entry.depth >= ORCA_REFINEMENT_MAX_DEPTH) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path: nodePath,
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_DEPTH} split levels`,
      });
      continue;
    }
    for (let childIndex = record.children.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push({
        node: record.children[childIndex],
        sourceTriangle: entry.sourceTriangle,
        path: [...entry.path, childIndex],
        depth: entry.depth + 1,
      });
    }
  }

  if (issues.length === 0 && selection.leaves.length !== encodedLeaves.length) {
    issues.push({
      code: 'invalid-refined-selection-leaves',
      path: 'selection.leaves',
      message: 'Refined selection leaf list must cover every encoded leaf exactly once',
    });
  }
  if (issues.length === 0) {
    selection.leaves.forEach((leaf, index) => {
      const encoded = encodedLeaves[index];
      if (
        !encoded ||
        leaf.sourceTriangle !== encoded.sourceTriangle ||
        canonicalStringify(leaf.path) !== canonicalStringify(encoded.path) ||
        canonicalStringify(leaf.state) !== canonicalStringify(encoded.state) ||
        typeof leaf.selected !== 'boolean'
      ) {
        issues.push({
          code: 'invalid-refined-selection-leaves',
          path: `selection.leaves[${index}]`,
          message: 'Refined selection leaves must match deterministic encoded leaf order and state',
        });
      }
    });
  }
  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);
  return encodedLeaves;
}

function refinedLeafKey(sourceTriangle: number, path: readonly number[]): string {
  return `${sourceTriangle}:${path.join('.')}`;
}

function cloneRefinementState(state: FacetRegionState): FacetRegionState {
  return state.kind === 'unpainted'
    ? Object.freeze({ kind: 'unpainted' })
    : deepFreeze({ kind: 'assigned', value: cloneJson(state.value) });
}

function usesRefinedSelection<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
): boolean {
  if (request.refinement !== undefined) return true;
  return (
    (request.tool.kind === 'circle' || request.tool.kind === 'sphere' || request.tool.kind === 'heightRange') &&
    request.tool.triangleSplitting === true
  );
}

type RefinedNeighborTuple = [number, number, number];
type RefinedSplitCount = 0 | 1 | 2 | 3;
type RefinedSide = 0 | 1 | 2;

interface RefinedTriangle {
  readonly vertices: [number, number, number];
  readonly sourceTriangle: number;
  readonly path: number[];
  state: FacetState;
  splitSides: RefinedSplitCount;
  specialSide: RefinedSide;
  readonly children: number[];
}

interface RefinementWorkspace {
  readonly vertices: Vec3[];
  readonly triangles: RefinedTriangle[];
  readonly roots: number[];
  readonly rootNeighbors: readonly RefinedNeighborTuple[];
}

interface RefinedNeighborTables {
  readonly direct: readonly RefinedNeighborTuple[];
  readonly propagated: readonly RefinedNeighborTuple[];
}

function selectRefinedFacetRegion<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
): FacetRegionSelection {
  const workspace = buildRefinementWorkspace(request);
  const selected = new Set<number>();
  let edgeLimitMm: number | undefined;
  let gapFillReplacements: readonly FacetGapFillReplacement[] | undefined;

  switch (request.tool.kind) {
    case 'triangle': {
      selected.add(resolveRefinedSeed(workspace, request.seedTriangle, request.tool.hit));
      break;
    }
    case 'fill': {
      selectRefinedFill(request, workspace, selected);
      break;
    }
    case 'gapFill': {
      gapFillReplacements = selectRefinedGapFill(request, workspace, selected);
      break;
    }
    case 'circle':
    case 'sphere': {
      const cursor = resolveBrushCursor(request.tool, request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM);
      edgeLimitMm =
        request.tool.triangleSplitting === true ? orcaAdaptiveBrushEdgeLimit(cursor.radiusSquared) : undefined;
      selectRefinedBrush(request, workspace, cursor, edgeLimitMm, selected);
      break;
    }
    case 'heightRange': {
      edgeLimitMm = request.tool.triangleSplitting === true ? Math.fround(0.1) : undefined;
      selectRefinedHeightRange(request, workspace, edgeLimitMm, selected);
      break;
    }
  }

  const selectedRoots = [
    ...new Set([...selected].map((triangle) => workspace.triangles[triangle].sourceTriangle)),
  ].sort((left, right) => left - right);
  const base = selectionFromIndices(selectedRoots, request.guard.triangleCount);
  return Object.freeze({
    ...base,
    ...(gapFillReplacements === undefined ? {} : { gapFillReplacements }),
    refinement: freezeRefinedSelection(workspace, selected, edgeLimitMm),
  });
}

function buildRefinementWorkspace<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
): RefinementWorkspace {
  const sourceStates = facetStates(
    request.annotations[request.channel] as readonly TriangleAssignments<JsonValue>[],
    request.guard.triangleCount,
  );
  const triangles: RefinedTriangle[] = [];
  const roots: number[] = [];
  for (let sourceTriangle = 0; sourceTriangle < request.mesh.triangles.length; sourceTriangle += 1) {
    const triangle = request.mesh.triangles[sourceTriangle];
    roots.push(triangles.length);
    triangles.push({
      vertices: [triangle[0], triangle[1], triangle[2]],
      sourceTriangle,
      path: [],
      state: sourceStates[sourceTriangle],
      splitSides: 0,
      specialSide: 0,
      children: [],
    });
  }
  const workspace: RefinementWorkspace = {
    vertices: request.mesh.vertices.map(floatVector),
    triangles,
    roots,
    rootNeighbors: buildValidatedOrcaFaceNeighbors(request.mesh).map(
      (neighbors) => [...neighbors] as RefinedNeighborTuple,
    ),
  };

  request.refinement?.roots.forEach((node, sourceTriangle) => {
    applyRefinementNode(workspace, roots[sourceTriangle], workspace.rootNeighbors[sourceTriangle], node, 0);
  });
  return workspace;
}

function applyRefinementNode(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  node: FacetRefinementNode,
  depth: number,
): void {
  const triangle = workspace.triangles[triangleIndex];
  if (node.kind === 'leaf') {
    triangle.state = facetStateFromEncoding(node.state);
    return;
  }

  performRefinedSplit(workspace, triangleIndex, neighbors, node.splitSides, node.specialSide, depth);
  node.children.forEach((child, childIndex) => {
    applyRefinementNode(
      workspace,
      triangle.children[childIndex],
      refinedChildNeighbors(workspace, triangleIndex, neighbors, childIndex),
      child,
      depth + 1,
    );
  });
}

function facetStateFromEncoding(state: FacetRegionState): FacetState {
  return state.kind === 'unpainted' ? UNPAINTED : state.value;
}

function performRefinedSplit(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  splitSides: 1 | 2 | 3,
  specialSide: RefinedSide,
  depth: number,
): void {
  if (depth >= ORCA_REFINEMENT_MAX_DEPTH || workspace.triangles.length + splitSides + 1 > ORCA_REFINEMENT_MAX_NODES) {
    throw new FacetAnnotationValidationError([
      {
        code: 'facet-refinement-limit-exceeded',
        path: 'refinement',
        message: `Facet refinement exceeds ${ORCA_REFINEMENT_MAX_DEPTH} levels or ${ORCA_REFINEMENT_MAX_NODES} nodes`,
      },
    ]);
  }

  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides !== 0) return;
  triangle.splitSides = splitSides;
  triangle.specialSide = specialSide;

  const rotated: number[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    rotated.push(triangle.vertices[(specialSide + offset) % 3]);
  }
  const allocate = (edge: number, firstPosition: number, secondPosition: number): number =>
    refinedMidpointOrAllocate(workspace, neighbors[edge], rotated[firstPosition], rotated[secondPosition]);
  const pushChild = (vertices: [number, number, number]): void => {
    const childIndex = workspace.triangles.length;
    const childPathIndex = triangle.children.length;
    workspace.triangles.push({
      vertices,
      sourceTriangle: triangle.sourceTriangle,
      path: [...triangle.path, childPathIndex],
      state: triangle.state,
      splitSides: 0,
      specialSide: 0,
      children: [],
    });
    triangle.children.push(childIndex);
  };

  switch (splitSides) {
    case 1: {
      rotated.splice(2, 0, allocate(refinedNextSide(specialSide), 2, 1));
      pushChild([rotated[0], rotated[1], rotated[2]]);
      pushChild([rotated[2], rotated[3], rotated[0]]);
      break;
    }
    case 2: {
      rotated.splice(1, 0, allocate(specialSide, 1, 0));
      rotated.splice(4, 0, allocate(refinedPreviousSide(specialSide), 0, 3));
      pushChild([rotated[0], rotated[1], rotated[4]]);
      pushChild([rotated[1], rotated[2], rotated[4]]);
      pushChild([rotated[2], rotated[3], rotated[4]]);
      break;
    }
    case 3: {
      rotated.splice(1, 0, allocate(0, 1, 0));
      rotated.splice(3, 0, allocate(1, 3, 2));
      rotated.splice(5, 0, allocate(2, 0, 4));
      pushChild([rotated[0], rotated[1], rotated[5]]);
      pushChild([rotated[1], rotated[2], rotated[3]]);
      pushChild([rotated[3], rotated[4], rotated[5]]);
      pushChild([rotated[1], rotated[3], rotated[5]]);
      break;
    }
  }
}

function refinedMidpointOrAllocate(
  workspace: RefinementWorkspace,
  neighbor: number,
  firstVertex: number,
  secondVertex: number,
): number {
  const existing = refinedTriangleMidpoint(workspace, neighbor, firstVertex, secondVertex);
  if (existing !== -1) return existing;
  const midpoint = orcaVectorScale(
    orcaVectorAdd(workspace.vertices[firstVertex], workspace.vertices[secondVertex]),
    Math.fround(0.5),
  );
  workspace.vertices.push(midpoint);
  return workspace.vertices.length - 1;
}

function refinedTriangleMidpoint(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  firstVertex: number,
  secondVertex: number,
): number {
  if (triangleIndex === -1) return -1;
  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides === 0) return -1;
  const edge = refinedOrientedEdge(triangle, firstVertex, secondVertex);
  if (triangle.splitSides === 1) {
    return edge === refinedNextSide(triangle.specialSide)
      ? workspace.triangles[triangle.children[0]].vertices[2]
      : refinedTriangleMidpoint(
          workspace,
          triangle.children[edge === triangle.specialSide ? 0 : 1],
          firstVertex,
          secondVertex,
        );
  }
  if (triangle.splitSides === 2) {
    if (edge === refinedNextSide(triangle.specialSide)) {
      return refinedTriangleMidpoint(workspace, triangle.children[2], firstVertex, secondVertex);
    }
    return edge === triangle.specialSide
      ? workspace.triangles[triangle.children[0]].vertices[1]
      : workspace.triangles[triangle.children[1]].vertices[2];
  }
  return edge === 0
    ? workspace.triangles[triangle.children[0]].vertices[1]
    : edge === 1
      ? workspace.triangles[triangle.children[1]].vertices[2]
      : workspace.triangles[triangle.children[2]].vertices[2];
}

function refinedNeighborChild(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  firstVertex: number,
  secondVertex: number,
  firstPartition: boolean,
): number {
  if (triangleIndex === -1) return -1;
  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides === 0) return -1;
  const edge = refinedOrientedEdge(triangle, firstVertex, secondVertex);
  if (triangle.splitSides === 1) {
    if (edge !== refinedNextSide(triangle.specialSide)) {
      return refinedNeighborChild(
        workspace,
        triangle.children[edge === triangle.specialSide ? 0 : 1],
        firstVertex,
        secondVertex,
        firstPartition,
      );
    }
    return triangle.children[firstPartition ? 0 : 1];
  }
  if (triangle.splitSides === 2) {
    if (edge === refinedNextSide(triangle.specialSide)) {
      return refinedNeighborChild(workspace, triangle.children[2], firstVertex, secondVertex, firstPartition);
    }
    return triangle.children[edge === triangle.specialSide ? (firstPartition ? 0 : 1) : firstPartition ? 2 : 0];
  }
  const child = edge === 0 ? (firstPartition ? 0 : 1) : edge === 1 ? (firstPartition ? 1 : 2) : firstPartition ? 2 : 0;
  return triangle.children[child];
}

function refinedChildNeighbors(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  childIndex: number,
): RefinedNeighborTuple {
  const triangle = workspace.triangles[triangleIndex];
  const i = triangle.specialSide;
  const j = refinedNextSide(i);
  const k = refinedNextSide(j);
  if (triangle.splitSides === 1) {
    return childIndex === 0
      ? [
          neighbors[i],
          refinedNeighborChild(workspace, neighbors[j], triangle.vertices[k], triangle.vertices[j], false),
          triangle.children[1],
        ]
      : [
          refinedNeighborChild(workspace, neighbors[j], triangle.vertices[k], triangle.vertices[j], true),
          neighbors[k],
          triangle.children[0],
        ];
  }
  if (triangle.splitSides === 2) {
    if (childIndex === 0) {
      return [
        refinedNeighborChild(workspace, neighbors[i], triangle.vertices[j], triangle.vertices[i], false),
        triangle.children[1],
        refinedNeighborChild(workspace, neighbors[k], triangle.vertices[i], triangle.vertices[k], true),
      ];
    }
    if (childIndex === 1) {
      return [
        refinedNeighborChild(workspace, neighbors[i], triangle.vertices[j], triangle.vertices[i], true),
        triangle.children[2],
        triangle.children[0],
      ];
    }
    return [
      neighbors[j],
      refinedNeighborChild(workspace, neighbors[k], triangle.vertices[i], triangle.vertices[k], false),
      triangle.children[1],
    ];
  }
  switch (childIndex) {
    case 0:
      return [
        refinedNeighborChild(workspace, neighbors[0], triangle.vertices[1], triangle.vertices[0], false),
        triangle.children[3],
        refinedNeighborChild(workspace, neighbors[2], triangle.vertices[0], triangle.vertices[2], true),
      ];
    case 1:
      return [
        refinedNeighborChild(workspace, neighbors[0], triangle.vertices[1], triangle.vertices[0], true),
        refinedNeighborChild(workspace, neighbors[1], triangle.vertices[2], triangle.vertices[1], false),
        triangle.children[3],
      ];
    case 2:
      return [
        refinedNeighborChild(workspace, neighbors[1], triangle.vertices[2], triangle.vertices[1], true),
        refinedNeighborChild(workspace, neighbors[2], triangle.vertices[0], triangle.vertices[2], false),
        triangle.children[3],
      ];
    default:
      return [triangle.children[1], triangle.children[2], triangle.children[0]];
  }
}

function refinedChildNeighborsPropagated(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  propagated: RefinedNeighborTuple,
  childIndex: number,
  childNeighbors: RefinedNeighborTuple,
): RefinedNeighborTuple {
  const triangle = workspace.triangles[triangleIndex];
  const output: RefinedNeighborTuple = [...childNeighbors];
  const replace = (outputSide: number, parentSide: number): void => {
    if (output[outputSide] === -1) output[outputSide] = propagated[parentSide];
  };
  const i = triangle.specialSide;
  const j = refinedNextSide(i);
  const k = refinedNextSide(j);
  if (triangle.splitSides === 1) {
    if (childIndex === 0) {
      replace(0, i);
      replace(1, j);
    } else {
      replace(0, j);
      replace(1, k);
    }
  } else if (triangle.splitSides === 2) {
    if (childIndex === 0) {
      replace(0, i);
      replace(2, k);
    } else if (childIndex === 1) {
      replace(0, i);
    } else {
      replace(0, j);
      replace(1, k);
    }
  } else if (childIndex === 0) {
    replace(0, 0);
    replace(2, 2);
  } else if (childIndex === 1) {
    replace(0, 0);
    replace(1, 1);
  } else if (childIndex === 2) {
    replace(0, 1);
    replace(1, 2);
  }
  return output;
}

function refinedNeighborTables(workspace: RefinementWorkspace): RefinedNeighborTables {
  const direct: RefinedNeighborTuple[] = workspace.triangles.map(() => [-1, -1, -1]);
  const propagated: RefinedNeighborTuple[] = workspace.triangles.map(() => [-1, -1, -1]);
  const visit = (triangleIndex: number, neighbors: RefinedNeighborTuple, inherited: RefinedNeighborTuple): void => {
    direct[triangleIndex] = neighbors;
    propagated[triangleIndex] = inherited;
    const triangle = workspace.triangles[triangleIndex];
    triangle.children.forEach((child, childIndex) => {
      const childNeighbors = refinedChildNeighbors(workspace, triangleIndex, neighbors, childIndex);
      visit(
        child,
        childNeighbors,
        refinedChildNeighborsPropagated(workspace, triangleIndex, inherited, childIndex, childNeighbors),
      );
    });
  };
  workspace.roots.forEach((root, sourceTriangle) => {
    const neighbors = workspace.rootNeighbors[sourceTriangle];
    visit(root, neighbors, neighbors);
  });
  return { direct, propagated };
}

function refinedTriangleSubtriangles(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  firstVertex: number,
  secondVertex: number,
): readonly [number, number] {
  if (triangleIndex === -1) return [-1, -1];
  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides === 0) return [-1, -1];
  const edge = refinedOrientedEdge(triangle, firstVertex, secondVertex);
  if (triangle.splitSides === 1) {
    return edge === refinedNextSide(triangle.specialSide)
      ? [triangle.children[0], triangle.children[1]]
      : [triangle.children[edge === triangle.specialSide ? 0 : 1], -1];
  }
  if (triangle.splitSides === 2) {
    return edge === refinedNextSide(triangle.specialSide)
      ? [triangle.children[2], -1]
      : edge === triangle.specialSide
        ? [triangle.children[0], triangle.children[1]]
        : [triangle.children[2], triangle.children[0]];
  }
  return edge === 0
    ? [triangle.children[0], triangle.children[1]]
    : edge === 1
      ? [triangle.children[1], triangle.children[2]]
      : [triangle.children[2], triangle.children[0]];
}

function appendRefinedTouchingSubtriangles(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  firstVertex: number,
  secondVertex: number,
  output: number[],
): void {
  if (triangleIndex === -1) return;
  const touching = refinedTriangleSubtriangles(workspace, triangleIndex, firstVertex, secondVertex);
  const process = (subtriangle: number, firstPartition: boolean): void => {
    if (subtriangle === -1) return;
    if (workspace.triangles[subtriangle].splitSides === 0) {
      output.push(subtriangle);
      return;
    }
    const midpoint = refinedTriangleMidpoint(workspace, triangleIndex, firstVertex, secondVertex);
    if (midpoint === -1) {
      appendRefinedTouchingSubtriangles(workspace, subtriangle, firstVertex, secondVertex, output);
    } else {
      appendRefinedTouchingSubtriangles(
        workspace,
        subtriangle,
        firstPartition ? firstVertex : midpoint,
        firstPartition ? midpoint : secondVertex,
        output,
      );
    }
  };
  process(touching[0], true);
  process(touching[1], false);
}

function allRefinedTouchingTriangles(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  tables: RefinedNeighborTables,
): number[] {
  const triangle = workspace.triangles[triangleIndex];
  const vertices = triangle.vertices;
  const touching: number[] = [];
  appendRefinedTouchingSubtriangles(workspace, tables.direct[triangleIndex][0], vertices[1], vertices[0], touching);
  appendRefinedTouchingSubtriangles(workspace, tables.direct[triangleIndex][1], vertices[2], vertices[1], touching);
  appendRefinedTouchingSubtriangles(workspace, tables.direct[triangleIndex][2], vertices[0], vertices[2], touching);
  for (const neighbor of tables.propagated[triangleIndex]) {
    if (neighbor !== -1 && workspace.triangles[neighbor].splitSides === 0) touching.push(neighbor);
  }
  return touching;
}

function resolveRefinedSeed(workspace: RefinementWorkspace, sourceTriangle: number, hit: Vec3 | undefined): number {
  const root = workspace.roots[sourceTriangle];
  if (workspace.triangles[root].splitSides === 0) return root;
  if (hit === undefined) {
    throw new FacetAnnotationValidationError([
      {
        code: 'missing-refinement-hit',
        path: 'tool.hit',
        message: 'A finite local hit is required to resolve a split seed triangle',
      },
    ]);
  }
  const resolved = resolveRefinedLeafAtHit(workspace, root, workspace.rootNeighbors[sourceTriangle], floatVector(hit));
  if (resolved !== -1) return resolved;
  throw new FacetAnnotationValidationError([
    {
      code: 'invalid-refinement-hit',
      path: 'tool.hit',
      message: 'Refinement hit does not lie in any leaf of the seed triangle',
    },
  ]);
}

function resolveRefinedLeafAtHit(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  hit: Vec3,
): number {
  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides === 0) {
    return pointInsideRefinedTriangle(workspace, triangle, hit) ? triangleIndex : -1;
  }
  for (let childIndex = 0; childIndex < triangle.children.length; childIndex += 1) {
    const child = triangle.children[childIndex];
    if (!pointInsideRefinedTriangle(workspace, workspace.triangles[child], hit)) continue;
    return resolveRefinedLeafAtHit(
      workspace,
      child,
      refinedChildNeighbors(workspace, triangleIndex, neighbors, childIndex),
      hit,
    );
  }
  return -1;
}

function pointInsideRefinedTriangle(workspace: RefinementWorkspace, triangle: RefinedTriangle, hit: Vec3): boolean {
  const first = workspace.vertices[triangle.vertices[0]];
  const second = workspace.vertices[triangle.vertices[1]];
  const third = workspace.vertices[triangle.vertices[2]];
  const zero = orcaVectorSubtract(second, first);
  const one = orcaVectorSubtract(third, first);
  const two = orcaVectorSubtract(hit, first);
  const d00 = orcaDot(zero, zero);
  const d01 = orcaDot(zero, one);
  const d11 = orcaDot(one, one);
  const d20 = orcaDot(two, zero);
  const d21 = orcaDot(two, one);
  const denominator = orcaFloatSubtract(orcaFloatMultiply(d00, d11), orcaFloatMultiply(d01, d01));
  const secondCoordinate = Math.fround(
    orcaFloatSubtract(orcaFloatMultiply(d11, d20), orcaFloatMultiply(d01, d21)) / denominator,
  );
  const thirdCoordinate = Math.fround(
    orcaFloatSubtract(orcaFloatMultiply(d00, d21), orcaFloatMultiply(d01, d20)) / denominator,
  );
  const firstCoordinate = orcaFloatSubtract(orcaFloatSubtract(Math.fround(1), secondCoordinate), thirdCoordinate);
  return [firstCoordinate, secondCoordinate, thirdCoordinate].every((coordinate) => coordinate >= 0 && coordinate <= 1);
}

function selectRefinedFill<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  workspace: RefinementWorkspace,
  selected: Set<number>,
): void {
  const tool = request.tool as Extract<FacetRegionTool, { kind: 'fill' }>;
  const seed = resolveRefinedSeed(workspace, request.seedTriangle, tool.hit);
  const seedState = facetStateKey(workspace.triangles[seed].state);
  const tables = refinedNeighborTables(workspace);
  const normals = tool.edgeDetection
    ? request.mesh.triangles.map((triangle) => orcaFaceNormal(request.mesh.vertices, triangle))
    : undefined;
  const angleLimit = tool.edgeDetection
    ? orcaCosDegrees(tool.edgeDetection.maxAdjacentAngleDegrees) - ORCA_TRIANGLE_SELECTOR_EPSILON
    : undefined;
  const visited = new Uint8Array(workspace.triangles.length);
  const queue = [seed];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    if (visited[current] !== 0) continue;
    selected.add(current);
    for (const neighbor of allRefinedTouchingTriangles(workspace, current, tables)) {
      if (
        neighbor < 0 ||
        visited[neighbor] !== 0 ||
        workspace.triangles[neighbor].splitSides !== 0 ||
        facetStateKey(workspace.triangles[neighbor].state) !== seedState ||
        isRefinedTriangleClipped(workspace, neighbor, request.clippingPlane)
      ) {
        continue;
      }
      if (normals && angleLimit !== undefined) {
        const currentSource = workspace.triangles[current].sourceTriangle;
        const neighborSource = workspace.triangles[neighbor].sourceTriangle;
        const dot = clamp(orcaDot(normals[neighborSource], normals[currentSource]), 0, 1);
        if (dot < angleLimit) continue;
      }
      queue.push(neighbor);
    }
    visited[current] = 1;
  }
}

function selectRefinedGapFill<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  workspace: RefinementWorkspace,
  selected: Set<number>,
): readonly FacetGapFillReplacement[] {
  const tool = request.tool as Extract<FacetRegionTool, { kind: 'gapFill' }>;
  const orderedStates: readonly FacetState[] = [UNPAINTED, ...tool.stateOrder];
  const stateIndices = new Map<string, number>(
    tool.stateOrder.map((state, index) => [facetStateKey(state), index + 1]),
  );
  const tables = refinedNeighborTables(workspace);
  const leaves = refinedLeafIndices(workspace);
  const visited = new Uint8Array(workspace.triangles.length);
  const threshold = Math.fround(tool.maxAreaMm2);
  const replacements: FacetGapFillReplacement[] = [];

  for (const start of leaves) {
    if (visited[start] !== 0) continue;
    const sourceState = workspace.triangles[start].state;
    const sourceKey = facetStateKey(sourceState);
    const sourceIndex = sourceState === UNPAINTED ? 0 : stateIndices.get(sourceKey)!;
    const queue = [start];
    const component: number[] = [];
    const neighborStateIndices = new Set<number>();
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      if (visited[current] !== 0) continue;
      component.push(current);
      for (const neighbor of allRefinedTouchingTriangles(workspace, current, tables)) {
        if (neighbor < 0 || workspace.triangles[neighbor].splitSides !== 0) continue;
        const neighborState = workspace.triangles[neighbor].state;
        const neighborKey = facetStateKey(neighborState);
        const neighborStateIndex = neighborState === UNPAINTED ? 0 : stateIndices.get(neighborKey)!;
        if (neighborKey !== sourceKey) {
          neighborStateIndices.add(neighborStateIndex);
        } else if (visited[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
      visited[current] = 1;
    }

    const areaMm2 = orcaRefinedGapPatchArea(workspace, component);
    if (areaMm2 >= threshold || neighborStateIndices.size === 0) continue;
    const targetIndex = Math.min(...neighborStateIndices);
    component.forEach((triangle) => selected.add(triangle));
    const sourceTriangles = [
      ...new Set(component.map((triangle) => workspace.triangles[triangle].sourceTriangle)),
    ].sort((left, right) => left - right);
    const sourceSelection = selectionFromIndices(sourceTriangles, request.guard.triangleCount);
    replacements.push(
      Object.freeze({
        areaMm2,
        source: freezeFacetRegionState(orderedStates[sourceIndex]),
        target: freezeFacetRegionState(orderedStates[targetIndex]),
        triangleIndices: sourceSelection.triangleIndices,
        ranges: sourceSelection.ranges,
        refinedLeaves: Object.freeze(
          component.map((triangle) => freezeRefinedLeafReference(workspace.triangles[triangle])),
        ),
      }),
    );
  }
  return Object.freeze(replacements);
}

function orcaRefinedGapPatchArea(workspace: RefinementWorkspace, triangles: readonly number[]): number {
  let totalArea = 0;
  for (const triangleIndex of triangles) {
    const [firstIndex, secondIndex, thirdIndex] = workspace.triangles[triangleIndex].vertices;
    const first = workspace.vertices[firstIndex];
    const second = workspace.vertices[secondIndex];
    const third = workspace.vertices[thirdIndex];
    const doubledArea = orcaNorm(orcaCross(orcaVectorSubtract(first, second), orcaVectorSubtract(first, third)));
    totalArea += Math.fround(doubledArea / Math.fround(2));
    if (totalArea >= ORCA_GAP_AREA_MAX_MM2) break;
  }
  return Math.fround(totalArea);
}

function selectRefinedBrush<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  workspace: RefinementWorkspace,
  cursor: ResolvedBrushCursor,
  edgeLimitMm: number | undefined,
  selected: Set<number>,
): void {
  const overhangFilter = resolveOverhangFilter(request);
  const normals =
    cursor.kind === 'circle'
      ? request.mesh.triangles.map((triangle) => orcaFaceNormal(request.mesh.vertices, triangle))
      : undefined;
  const visited = new Uint8Array(request.guard.triangleCount);
  const queue = [request.seedTriangle];
  let head = 0;

  while (head < queue.length) {
    const sourceTriangle = queue[head++];
    if (visited[sourceTriangle] !== 0) continue;
    if (!passesOverhangFilter(request.mesh, sourceTriangle, overhangFilter)) {
      visited[sourceTriangle] = 1;
      continue;
    }
    if (
      selectRefinedCursorTriangle(
        workspace,
        workspace.roots[sourceTriangle],
        workspace.rootNeighbors[sourceTriangle],
        cursor,
        request.clippingPlane,
        edgeLimitMm,
        selected,
        0,
      )
    ) {
      for (const neighbor of workspace.rootNeighbors[sourceTriangle]) {
        if (neighbor < 0 || visited[neighbor] !== 0) continue;
        if (normals && !isCircleFacetVisible(normals[neighbor], cursor)) continue;
        queue.push(neighbor);
      }
    }
    visited[sourceTriangle] = 1;
  }
}

function selectRefinedHeightRange<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  workspace: RefinementWorkspace,
  edgeLimitMm: number | undefined,
  selected: Set<number>,
): void {
  const tool = request.tool as Extract<FacetRegionTool, { kind: 'heightRange' }>;
  const transform = request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM;
  const overhangFilter = resolveOverhangFilter(request);
  const starts: number[] = [];
  workspace.roots.forEach((root, sourceTriangle) => {
    if (heightRangeEdgeIntersects(workspace, root, tool, transform)) starts.push(sourceTriangle);
  });
  const visited = new Uint8Array(request.guard.triangleCount);

  for (const start of starts) {
    if (visited[start] !== 0) continue;
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const sourceTriangle = queue[head++];
      if (visited[sourceTriangle] !== 0) continue;
      if (!passesOverhangFilter(request.mesh, sourceTriangle, overhangFilter)) {
        visited[sourceTriangle] = 1;
        continue;
      }
      if (
        selectRefinedHeightTriangle(
          workspace,
          workspace.roots[sourceTriangle],
          workspace.rootNeighbors[sourceTriangle],
          tool,
          transform,
          edgeLimitMm,
          selected,
          0,
        )
      ) {
        for (const neighbor of workspace.rootNeighbors[sourceTriangle]) {
          if (neighbor >= 0 && visited[neighbor] === 0) queue.push(neighbor);
        }
      }
      visited[sourceTriangle] = 1;
    }
  }
}

function selectRefinedCursorTriangle(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  cursor: ResolvedBrushCursor,
  clippingPlane: FacetClippingPlane | undefined,
  edgeLimitMm: number | undefined,
  selected: Set<number>,
  depth: number,
): boolean {
  const triangle = workspace.triangles[triangleIndex];
  const points = triangle.vertices.map((vertex) => workspace.vertices[vertex]) as [Vec3, Vec3, Vec3];
  const insideCount = points.reduce(
    (count, point) => count + (brushContainsPoint(point, cursor, clippingPlane) ? 1 : 0),
    0,
  );
  if (
    insideCount === 0 &&
    !circlePointerInsideTriangle(points, cursor, cursor.center) &&
    (cursor.secondCenter === undefined || !circlePointerInsideTriangle(points, cursor, cursor.secondCenter)) &&
    !brushEdgesIntersect(points, cursor)
  ) {
    return false;
  }
  if (insideCount === 3) {
    collectRefinedLeaves(workspace, triangleIndex, selected);
    return true;
  }

  if (edgeLimitMm !== undefined && triangle.splitSides === 0) {
    splitRefinedTriangleAtLimit(workspace, triangleIndex, neighbors, cursor, edgeLimitMm, depth);
  } else if (edgeLimitMm === undefined && triangle.splitSides === 0) {
    selected.add(triangleIndex);
  }
  if (triangle.children.length > 0) {
    triangle.children.forEach((child, childIndex) => {
      selectRefinedCursorTriangle(
        workspace,
        child,
        refinedChildNeighbors(workspace, triangleIndex, neighbors, childIndex),
        cursor,
        clippingPlane,
        edgeLimitMm,
        selected,
        depth + 1,
      );
    });
  }
  return true;
}

function selectRefinedHeightTriangle(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  tool: Extract<FacetRegionTool, { kind: 'heightRange' }>,
  transform: FacetSelectionTransform,
  edgeLimitMm: number | undefined,
  selected: Set<number>,
  depth: number,
): boolean {
  const triangle = workspace.triangles[triangleIndex];
  const insideCount = triangle.vertices.reduce(
    (count, vertex) => count + (heightRangeContainsPoint(workspace.vertices[vertex], tool, transform) ? 1 : 0),
    0,
  );
  if (insideCount === 0 && !heightRangeEdgeIntersects(workspace, triangleIndex, tool, transform)) {
    return false;
  }
  if (insideCount === 3) {
    collectRefinedLeaves(workspace, triangleIndex, selected);
    return true;
  }

  if (edgeLimitMm !== undefined && triangle.splitSides === 0) {
    splitRefinedTriangleAtLimit(workspace, triangleIndex, neighbors, undefined, edgeLimitMm, depth, transform);
  } else if (edgeLimitMm === undefined && triangle.splitSides === 0) {
    selected.add(triangleIndex);
  }
  if (triangle.children.length > 0) {
    triangle.children.forEach((child, childIndex) => {
      selectRefinedHeightTriangle(
        workspace,
        child,
        refinedChildNeighbors(workspace, triangleIndex, neighbors, childIndex),
        tool,
        transform,
        edgeLimitMm,
        selected,
        depth + 1,
      );
    });
  }
  return true;
}

function splitRefinedTriangleAtLimit(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  neighbors: RefinedNeighborTuple,
  cursor: ResolvedBrushCursor | undefined,
  edgeLimitMm: number,
  depth: number,
  heightTransform?: FacetSelectionTransform,
): void {
  const triangle = workspace.triangles[triangleIndex];
  const points = triangle.vertices.map((vertex) => {
    const point = workspace.vertices[vertex];
    if (cursor !== undefined) {
      return cursor.uniformScaling ? point : transformPoint(cursor.transform, point);
    }
    return hasUniformFacetScaling(heightTransform!) ? point : transformPoint(heightTransform!, point);
  }) as [Vec3, Vec3, Vec3];
  const sides = [
    orcaSquaredNorm(orcaVectorSubtract(points[2], points[1])),
    orcaSquaredNorm(orcaVectorSubtract(points[0], points[2])),
    orcaSquaredNorm(orcaVectorSubtract(points[1], points[0])),
  ];
  const limitSquared = orcaFloatMultiply(edgeLimitMm, edgeLimitMm);
  const sidesToSplit: RefinedSide[] = [];
  let sideToKeep: RefinedSide = 0;
  sides.forEach((sideSquared, side) => {
    if (sideSquared > limitSquared) sidesToSplit.push(side as RefinedSide);
    else sideToKeep = side as RefinedSide;
  });
  if (sidesToSplit.length === 0) return;
  const splitSides = sidesToSplit.length as 1 | 2 | 3;
  const specialSide = splitSides === 2 ? sideToKeep : sidesToSplit[0];
  performRefinedSplit(workspace, triangleIndex, neighbors, splitSides, specialSide, depth);
}

function brushEdgesIntersect(points: readonly [Vec3, Vec3, Vec3], cursor: ResolvedBrushCursor): boolean {
  const transformed = cursor.uniformScaling
    ? points.map(floatVector)
    : points.map((point) => transformPoint(cursor.transform, point));
  for (let edge = 0; edge < 3; edge += 1) {
    const first = transformed[edge];
    const second = transformed[(edge + 1) % 3];
    const touches =
      cursor.secondCenter === undefined
        ? cursor.kind === 'sphere'
          ? lineTouchesSphere(first, second, cursor.center, cursor.radius)
          : lineTouchesCircle(first, second, cursor.center, cursor)
        : cursor.kind === 'sphere'
          ? lineTouchesCapsule(first, second, cursor.center, cursor.secondCenter, cursor.radius)
          : lineTouchesCircleCapsule(first, second, cursor);
    if (touches) return true;
  }
  return false;
}

function heightRangeContainsPoint(
  point: Vec3,
  tool: Extract<FacetRegionTool, { kind: 'heightRange' }>,
  transform: FacetSelectionTransform,
): boolean {
  const tolerance = Math.fround(0.02);
  const z = transformPoint(transform, point)[2];
  const top = orcaFloatAdd(orcaFloatAdd(tool.startZMm, tool.heightMm), tolerance);
  const bottom = orcaFloatSubtract(tool.startZMm, tolerance);
  return z > bottom && z < top;
}

function heightRangeEdgeIntersects(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  tool: Extract<FacetRegionTool, { kind: 'heightRange' }>,
  transform: FacetSelectionTransform,
): boolean {
  const z = workspace.triangles[triangleIndex].vertices.map(
    (vertex) => transformPoint(transform, workspace.vertices[vertex])[2],
  );
  const top = orcaFloatAdd(orcaFloatAdd(tool.startZMm, tool.heightMm), ORCA_TRIANGLE_SELECTOR_EPSILON);
  const bottom = orcaFloatSubtract(tool.startZMm, ORCA_TRIANGLE_SELECTOR_EPSILON);
  return !((z[0] < bottom && z[1] < bottom && z[2] < bottom) || (z[0] > top && z[1] > top && z[2] > top));
}

function orcaAdaptiveBrushEdgeLimit(radiusSquared: number): number {
  return Math.fround(
    Math.min(Math.fround(Math.fround(Math.sqrt(Math.fround(radiusSquared))) / Math.fround(5)), Math.fround(0.05)),
  );
}

function collectRefinedLeaves(workspace: RefinementWorkspace, triangleIndex: number, selected: Set<number>): void {
  const triangle = workspace.triangles[triangleIndex];
  if (triangle.splitSides === 0) {
    selected.add(triangleIndex);
    return;
  }
  triangle.children.forEach((child) => collectRefinedLeaves(workspace, child, selected));
}

function refinedLeafIndices(workspace: RefinementWorkspace): number[] {
  const leaves: number[] = [];
  const visit = (triangleIndex: number): void => {
    const triangle = workspace.triangles[triangleIndex];
    if (triangle.splitSides === 0) {
      leaves.push(triangleIndex);
    } else {
      triangle.children.forEach(visit);
    }
  };
  workspace.roots.forEach(visit);
  return leaves;
}

function isRefinedTriangleClipped(
  workspace: RefinementWorkspace,
  triangleIndex: number,
  clippingPlane?: FacetClippingPlane,
): boolean {
  if (!clippingPlane) return false;
  return workspace.triangles[triangleIndex].vertices.some((vertex) =>
    isPointClipped(workspace.vertices[vertex], clippingPlane),
  );
}

function facetStateKey(state: FacetState): string {
  return state === UNPAINTED ? 'unpainted' : `assigned:${canonicalStringify(state)}`;
}

function refinedOrientedEdge(triangle: RefinedTriangle, firstVertex: number, secondVertex: number): RefinedSide {
  const edge = triangle.vertices.indexOf(firstVertex);
  if (edge < 0 || triangle.vertices[(edge + 1) % 3] !== secondVertex) {
    throw new FacetAnnotationValidationError([
      {
        code: 'invalid-facet-refinement-topology',
        path: 'refinement',
        message: 'Refined neighbor topology does not share the expected oriented edge',
      },
    ]);
  }
  return edge as RefinedSide;
}

function refinedNextSide(side: number): RefinedSide {
  return ((side + 1) % 3) as RefinedSide;
}

function refinedPreviousSide(side: number): RefinedSide {
  return ((side + 2) % 3) as RefinedSide;
}

function freezeRefinedLeafReference(triangle: RefinedTriangle): FacetRefinedLeafReference {
  return Object.freeze({
    sourceTriangle: triangle.sourceTriangle,
    path: Object.freeze([...triangle.path]),
  });
}

function freezeRefinedSelection(
  workspace: RefinementWorkspace,
  selected: ReadonlySet<number>,
  edgeLimitMm: number | undefined,
): FacetRefinedSelection {
  const encode = (triangleIndex: number): FacetRefinementNode => {
    const triangle = workspace.triangles[triangleIndex];
    if (triangle.splitSides === 0) {
      return Object.freeze({
        kind: 'leaf',
        state: freezeFacetRegionState(triangle.state),
      });
    }
    return Object.freeze({
      kind: 'split',
      splitSides: triangle.splitSides,
      specialSide: triangle.specialSide,
      children: Object.freeze(triangle.children.map(encode)),
    }) as FacetRefinementNode;
  };
  const encoding: FacetRefinementEncoding = Object.freeze({
    version: ORCA_REFINEMENT_ENCODING_VERSION,
    roots: Object.freeze(workspace.roots.map(encode)),
  });
  const leaves = Object.freeze(
    refinedLeafIndices(workspace).map((triangleIndex) => {
      const triangle = workspace.triangles[triangleIndex];
      return Object.freeze({
        ...freezeRefinedLeafReference(triangle),
        vertexIndices: Object.freeze([...triangle.vertices]) as FacetTriangle,
        state: freezeFacetRegionState(triangle.state),
        selected: selected.has(triangleIndex),
      });
    }),
  );
  return Object.freeze({
    ...(edgeLimitMm === undefined ? {} : { edgeLimitMm }),
    vertices: Object.freeze(workspace.vertices.map((vertex) => Object.freeze([...vertex]) as Vec3)),
    encoding,
    leaves,
  });
}

interface ResolvedBrushCursor {
  readonly kind: 'circle' | 'sphere';
  /** Single-point center, or the first/previous center of a swept cursor. */
  readonly center: Vec3;
  /** Second/current center of a swept cursor. */
  readonly secondCenter?: Vec3;
  readonly source: Vec3;
  readonly direction: Vec3;
  readonly radius: number;
  readonly radiusSquared: number;
  readonly uniformScaling: boolean;
  readonly transform: FacetSelectionTransform;
  readonly normalMatrix?: readonly [Vec3, Vec3, Vec3];
}

interface ResolvedOverhangFilter {
  readonly worldNormalZLimit: number;
  readonly normalMatrix: readonly [Vec3, Vec3, Vec3];
}

function resolveOverhangFilter<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
): ResolvedOverhangFilter | undefined {
  const angle = request.highlightByAngleDegrees ?? 0;
  // This equality check, rather than a <= check, is pinned in select_patch().
  if (angle === 0) return undefined;
  const transform = request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM;
  return {
    worldNormalZLimit: Math.fround(-orcaCosDegrees(angle)),
    // Upstream inverts the double trafo_no_translate matrix, then casts it.
    normalMatrix: inverseTransposeDoubleThenFloat(transform.linear),
  };
}

function passesOverhangFilter(
  mesh: FacetSelectionMesh,
  triangleIndex: number,
  filter: ResolvedOverhangFilter | undefined,
): boolean {
  if (!filter) return true;
  const localNormal = orcaFaceNormal(mesh.vertices, mesh.triangles[triangleIndex]);
  const worldNormal = orcaNormalize(multiplyMatrixVector(filter.normalMatrix, localNormal));
  return worldNormal[2] < filter.worldNormalZLimit;
}

function selectBrushRegion<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  tool: Extract<FacetRegionTool, { kind: 'circle' | 'sphere' }>,
): FacetRegionSelection {
  const cursor = resolveBrushCursor(tool, request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM);
  const overhangFilter = resolveOverhangFilter(request);
  const neighbors = buildValidatedOrcaFaceNeighbors(request.mesh);
  const normals =
    cursor.kind === 'circle'
      ? request.mesh.triangles.map((triangle) => orcaFaceNormal(request.mesh.vertices, triangle))
      : undefined;
  const visited = new Uint8Array(request.guard.triangleCount);
  const selected = new Uint8Array(request.guard.triangleCount);
  const queue = [request.seedTriangle];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    if (visited[current] !== 0) continue;
    if (!passesOverhangFilter(request.mesh, current, overhangFilter)) {
      visited[current] = 1;
      continue;
    }
    if (brushIntersectsFacet(request.mesh, current, cursor, request.clippingPlane)) {
      selected[current] = 1;
      for (const neighbor of neighbors[current]) {
        if (neighbor < 0 || visited[neighbor] !== 0) continue;
        if (normals && !isCircleFacetVisible(normals[neighbor], cursor)) continue;
        queue.push(neighbor);
      }
    }
    visited[current] = 1;
  }

  const indices: number[] = [];
  selected.forEach((value, index) => {
    if (value !== 0) indices.push(index);
  });
  return selectionFromIndices(indices, request.guard.triangleCount);
}

function selectHeightRange<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  tool: Extract<FacetRegionTool, { kind: 'heightRange' }>,
): FacetRegionSelection {
  const transform = request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM;
  const overhangFilter = resolveOverhangFilter(request);
  const startZ = Math.fround(tool.startZMm);
  const height = Math.fround(tool.heightMm);
  const bottom = Math.fround(startZ - ORCA_TRIANGLE_SELECTOR_EPSILON);
  const top = Math.fround(Math.fround(startZ + height) + ORCA_TRIANGLE_SELECTOR_EPSILON);
  const indices: number[] = [];

  request.mesh.triangles.forEach((triangle, triangleIndex) => {
    const z = triangle.map((vertex) => transformPoint(transform, request.mesh.vertices[vertex])[2]);
    const whollyBelow = z[0] < bottom && z[1] < bottom && z[2] < bottom;
    const whollyAbove = z[0] > top && z[1] > top && z[2] > top;
    if (!whollyBelow && !whollyAbove && passesOverhangFilter(request.mesh, triangleIndex, overhangFilter)) {
      indices.push(triangleIndex);
    }
  });
  return selectionFromIndices(indices, request.guard.triangleCount);
}

function selectGapFill<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  tool: Extract<FacetRegionTool, { kind: 'gapFill' }>,
): FacetRegionSelection {
  const triangleCount = request.guard.triangleCount;
  const neighbors = buildValidatedOrcaFaceNeighbors(request.mesh);
  const states = facetStates(
    request.annotations[request.channel] as readonly TriangleAssignments<JsonValue>[],
    triangleCount,
  );
  const orderedStates: readonly FacetState[] = [UNPAINTED, ...tool.stateOrder];
  const stateIndices = new Map<string, number>(
    tool.stateOrder.map((state, index) => [canonicalStringify(state), index + 1]),
  );
  const stateIndexByTriangle = states.map((state) =>
    state === UNPAINTED ? 0 : stateIndices.get(canonicalStringify(state))!,
  );
  const threshold = Math.fround(tool.maxAreaMm2);
  const visited = new Uint8Array(triangleCount);
  const replacements: FacetGapFillReplacement[] = [];
  const changed = new Uint8Array(triangleCount);

  for (let start = 0; start < triangleCount; start += 1) {
    if (visited[start] !== 0) continue;

    const sourceIndex = stateIndexByTriangle[start];
    const queue = [start];
    const component: number[] = [];
    const neighborStateIndices = new Set<number>();
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      if (visited[current] !== 0) continue;

      component.push(current);
      for (const neighbor of neighbors[current]) {
        if (neighbor < 0) continue;
        const neighborStateIndex = stateIndexByTriangle[neighbor];
        if (neighborStateIndex !== sourceIndex) {
          // Pinned code records neighbor states before checking visited.
          neighborStateIndices.add(neighborStateIndex);
        } else if (visited[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
      visited[current] = 1;
    }

    const areaMm2 = orcaGapPatchArea(request.mesh, component);
    if (areaMm2 >= threshold || neighborStateIndices.size === 0) continue;

    const targetIndex = Math.min(...neighborStateIndices);
    const componentSelection = selectionFromIndices(component, triangleCount);
    for (const triangle of componentSelection.triangleIndices) changed[triangle] = 1;
    replacements.push(
      Object.freeze({
        areaMm2,
        source: freezeFacetRegionState(orderedStates[sourceIndex]),
        target: freezeFacetRegionState(orderedStates[targetIndex]),
        triangleIndices: componentSelection.triangleIndices,
        ranges: componentSelection.ranges,
      }),
    );
  }

  const changedIndices: number[] = [];
  changed.forEach((value, triangle) => {
    if (value !== 0) changedIndices.push(triangle);
  });
  const selection = selectionFromIndices(changedIndices, triangleCount);
  return Object.freeze({
    ...selection,
    gapFillReplacements: Object.freeze(replacements),
  });
}

function orcaGapPatchArea(mesh: FacetSelectionMesh, triangles: readonly number[]): number {
  let totalArea = 0;
  for (const triangleIndex of triangles) {
    const triangle = mesh.triangles[triangleIndex];
    const first = floatVector(mesh.vertices[triangle[0]]);
    const second = floatVector(mesh.vertices[triangle[1]]);
    const third = floatVector(mesh.vertices[triangle[2]]);
    const doubledArea = orcaNorm(orcaCross(orcaVectorSubtract(first, second), orcaVectorSubtract(first, third)));
    totalArea += Math.fround(doubledArea / Math.fround(2));
    // Upstream caps accumulation at the UI's maximum, not the live threshold.
    if (totalArea >= ORCA_GAP_AREA_MAX_MM2) break;
  }
  return Math.fround(totalArea);
}

function freezeFacetRegionState(state: FacetState): FacetRegionState {
  return state === UNPAINTED ? Object.freeze({ kind: 'unpainted' }) : Object.freeze({ kind: 'assigned', value: state });
}

function resolveBrushCursor(
  tool: Extract<FacetRegionTool, { kind: 'circle' | 'sphere' }>,
  transform: FacetSelectionTransform,
): ResolvedBrushCursor {
  const scale = transform.scalingFactors;
  const uniformScaling = hasUniformFacetScaling(transform);
  const localCenter = floatVector(tool.previousCenter ?? tool.center);
  const localSecondCenter = tool.previousCenter === undefined ? undefined : floatVector(tool.center);
  const localSource = floatVector(tool.cameraPosition);
  const center = uniformScaling ? localCenter : transformPoint(transform, localCenter);
  const secondCenter =
    localSecondCenter === undefined
      ? undefined
      : uniformScaling
        ? localSecondCenter
        : transformPoint(transform, localSecondCenter);
  const source = uniformScaling ? localSource : transformPoint(transform, localSource);
  const radiusInput = Math.fround(tool.radiusMm);
  const scaledRadius = uniformScaling ? radiusInput / scale[0] : radiusInput;
  const radius = Math.fround(scaledRadius);
  const radiusSquared = uniformScaling
    ? Math.fround(scaledRadius * scaledRadius)
    : orcaFloatMultiply(radiusInput, radiusInput);
  return {
    kind: tool.kind,
    center,
    ...(secondCenter === undefined ? {} : { secondCenter }),
    source,
    direction: orcaNormalize(orcaVectorSubtract(center, source)),
    radius,
    radiusSquared,
    uniformScaling,
    transform,
    ...(uniformScaling ? {} : { normalMatrix: inverseTranspose(transform.linear) }),
  };
}

function hasUniformFacetScaling(transform: FacetSelectionTransform): boolean {
  const scale = transform.scalingFactors;
  return (
    Math.abs(scale[0] - scale[1]) < ORCA_TRIANGLE_SELECTOR_EPSILON &&
    Math.abs(scale[1] - scale[2]) < ORCA_TRIANGLE_SELECTOR_EPSILON
  );
}

function brushIntersectsFacet(
  mesh: FacetSelectionMesh,
  triangleIndex: number,
  cursor: ResolvedBrushCursor,
  clippingPlane?: FacetClippingPlane,
): boolean {
  const triangle = mesh.triangles[triangleIndex];
  const localPoints = triangle.map((vertex) => mesh.vertices[vertex]) as [Vec3, Vec3, Vec3];
  if (localPoints.some((point) => brushContainsPoint(point, cursor, clippingPlane))) return true;
  if (circlePointerInsideTriangle(localPoints, cursor, cursor.center)) return true;
  if (cursor.secondCenter !== undefined && circlePointerInsideTriangle(localPoints, cursor, cursor.secondCenter)) {
    return true;
  }
  const points = cursor.uniformScaling
    ? localPoints.map(floatVector)
    : localPoints.map((point) => transformPoint(cursor.transform, point));
  for (let edge = 0; edge < 3; edge += 1) {
    const first = points[edge];
    const second = points[(edge + 1) % 3];
    if (
      cursor.secondCenter === undefined
        ? cursor.kind === 'sphere'
          ? lineTouchesSphere(first, second, cursor.center, cursor.radius)
          : lineTouchesCircle(first, second, cursor.center, cursor)
        : cursor.kind === 'sphere'
          ? lineTouchesCapsule(first, second, cursor.center, cursor.secondCenter, cursor.radius)
          : lineTouchesCircleCapsule(first, second, cursor)
    ) {
      return true;
    }
  }
  return false;
}

function brushContainsPoint(
  localPoint: Vec3,
  cursor: ResolvedBrushCursor,
  clippingPlane?: FacetClippingPlane,
): boolean {
  const point = cursor.uniformScaling ? floatVector(localPoint) : transformPoint(cursor.transform, localPoint);
  const difference = orcaVectorSubtract(cursor.center, point);
  let inside: boolean;
  if (cursor.secondCenter !== undefined) {
    inside = cursor.kind === 'sphere' ? capsuleContainsPoint3d(point, cursor) : capsuleContainsPoint2d(point, cursor);
  } else {
    const distanceSquared =
      cursor.kind === 'sphere'
        ? orcaSquaredNorm(difference)
        : orcaSquaredNorm(
            orcaVectorSubtract(difference, orcaVectorScale(cursor.direction, orcaDot(difference, cursor.direction))),
          );
    inside = distanceSquared < cursor.radiusSquared;
  }
  return inside && !isPointClipped(localPoint, clippingPlane);
}

function capsuleContainsPoint3d(point: Vec3, cursor: ResolvedBrushCursor): boolean {
  const secondCenter = cursor.secondCenter!;
  const firstDifference = orcaVectorSubtract(cursor.center, point);
  const secondDifference = orcaVectorSubtract(secondCenter, point);
  if (
    orcaSquaredNorm(firstDifference) < cursor.radiusSquared ||
    orcaSquaredNorm(secondDifference) < cursor.radiusSquared
  ) {
    return true;
  }

  const centersDifference = orcaVectorSubtract(secondCenter, cursor.center);
  return (
    orcaDot(firstDifference, centersDifference) <= 0 &&
    orcaDot(secondDifference, centersDifference) >= 0 &&
    Math.fround(orcaNorm(orcaCross(firstDifference, centersDifference)) / orcaNorm(centersDifference)) <= cursor.radius
  );
}

function capsuleContainsPoint2d(point: Vec3, cursor: ResolvedBrushCursor): boolean {
  const secondCenter = cursor.secondCenter!;
  const firstDifference = orcaVectorSubtract(cursor.center, point);
  const firstProjected = projectPerpendicular(firstDifference, cursor.direction);
  if (orcaSquaredNorm(firstProjected) < cursor.radiusSquared) return true;

  const secondDifference = orcaVectorSubtract(secondCenter, point);
  const secondProjected = projectPerpendicular(secondDifference, cursor.direction);
  if (orcaSquaredNorm(secondProjected) < cursor.radiusSquared) return true;

  const centersDifference = orcaVectorSubtract(secondCenter, cursor.center);
  const centersProjected = projectPerpendicular(centersDifference, cursor.direction);
  if (orcaDot(firstProjected, centersProjected) > 0 || orcaDot(secondProjected, centersProjected) < 0) {
    return false;
  }

  const rectangleDirection = orcaCross(centersDifference, cursor.direction);
  const centerToRectangle = orcaVectorScale(orcaNormalize(rectangleDirection), cursor.radius);
  const rectangleA = orcaVectorSubtract(cursor.center, centerToRectangle);
  const rectangleD = orcaVectorAdd(cursor.center, centerToRectangle);
  return (
    orcaDot(orcaVectorSubtract(rectangleA, point), rectangleDirection) <= 0 &&
    orcaDot(orcaVectorSubtract(rectangleD, point), rectangleDirection) >= 0
  );
}

function projectPerpendicular(vector: Vec3, direction: Vec3): Vec3 {
  return orcaVectorSubtract(vector, orcaVectorScale(direction, orcaDot(vector, direction)));
}

function circlePointerInsideTriangle(
  points: readonly [Vec3, Vec3, Vec3],
  cursor: ResolvedBrushCursor,
  center: Vec3,
): boolean {
  const transformed = cursor.uniformScaling
    ? points.map(floatVector)
    : points.map((point) => transformPoint(cursor.transform, point));
  const firstRayPoint = orcaVectorAdd(center, cursor.direction);
  const secondRayPoint = orcaVectorSubtract(center, cursor.direction);
  const [first, second, third] = transformed;
  if (
    signedVolumeIsPositive(firstRayPoint, first, second, third) ===
    signedVolumeIsPositive(secondRayPoint, first, second, third)
  ) {
    return false;
  }
  const positive = signedVolumeIsPositive(firstRayPoint, secondRayPoint, first, second);
  return (
    signedVolumeIsPositive(firstRayPoint, secondRayPoint, second, third) === positive &&
    signedVolumeIsPositive(firstRayPoint, secondRayPoint, third, first) === positive
  );
}

function signedVolumeIsPositive(first: Vec3, second: Vec3, third: Vec3, fourth: Vec3): boolean {
  return (
    orcaDot(
      orcaCross(orcaVectorSubtract(second, first), orcaVectorSubtract(third, first)),
      orcaVectorSubtract(fourth, first),
    ) > 0
  );
}

function lineTouchesSphere(first: Vec3, second: Vec3, center: Vec3, radius: number): boolean {
  const radiusSquared = orcaFloatMultiply(radius, radius);
  const lineDirection = orcaVectorSubtract(second, first);
  const originsDifference = orcaVectorSubtract(first, center);
  const firstDistanceSquared = orcaDot(originsDifference, originsDifference);
  if (firstDistanceSquared <= radiusSquared || orcaSquaredNorm(orcaVectorSubtract(second, center)) <= radiusSquared) {
    return true;
  }

  const directionSquared = orcaDot(lineDirection, lineDirection);
  const originDirection = orcaDot(originsDifference, lineDirection);
  const equationC = orcaFloatSubtract(firstDistanceSquared, radiusSquared);
  const discriminant = orcaFloatSubtract(
    orcaFloatMultiply(originDirection, originDirection),
    orcaFloatMultiply(directionSquared, equationC),
  );
  if (discriminant < 0) return false;
  const root = Math.fround(Math.sqrt(discriminant));
  const firstT = Math.fround(orcaFloatSubtract(-originDirection, root) / directionSquared);
  if (firstT >= 0 && firstT <= 1) return true;
  const secondT = Math.fround(orcaFloatAdd(-originDirection, root) / directionSquared);
  return secondT >= 0 && secondT <= 1 && root > 0;
}

function lineTouchesCircle(first: Vec3, second: Vec3, center: Vec3, cursor: ResolvedBrushCursor): boolean {
  const edgeDirection = orcaVectorSubtract(second, first);
  const edgeLength = orcaNorm(edgeDirection);
  const normalized = orcaNormalize(edgeDirection);
  const distanceAlongEdge = orcaDot(orcaVectorSubtract(center, first), normalized);
  const offset = orcaVectorSubtract(orcaVectorAdd(first, orcaVectorScale(normalized, distanceAlongEdge)), center);
  const directionDistance = orcaDot(offset, cursor.direction);
  const projectedDistanceSquared = orcaFloatSubtract(
    orcaSquaredNorm(offset),
    orcaFloatMultiply(directionDistance, directionDistance),
  );
  return projectedDistanceSquared < cursor.radiusSquared && distanceAlongEdge >= 0 && distanceAlongEdge <= edgeLength;
}

function lineTouchesCapsule(first: Vec3, second: Vec3, firstCenter: Vec3, secondCenter: Vec3, radius: number): boolean {
  return (
    lineTouchesSphere(first, second, firstCenter, radius) ||
    lineTouchesSphere(first, second, secondCenter, radius) ||
    lineTouchesFiniteCylinder(first, second, firstCenter, secondCenter, radius)
  );
}

function lineTouchesFiniteCylinder(
  first: Vec3,
  second: Vec3,
  cylinderStart: Vec3,
  cylinderEnd: Vec3,
  radius: number,
): boolean {
  const cylinderDirection = orcaVectorSubtract(cylinderEnd, cylinderStart);
  const pointInsideCylinder = (point: Vec3): boolean => {
    const firstDifference = orcaVectorSubtract(cylinderStart, point);
    const secondDifference = orcaVectorSubtract(cylinderEnd, point);
    return (
      orcaDot(firstDifference, cylinderDirection) <= 0 &&
      orcaDot(secondDifference, cylinderDirection) >= 0 &&
      Math.fround(orcaNorm(orcaCross(firstDifference, cylinderDirection)) / orcaNorm(cylinderDirection)) <= radius
    );
  };
  if (pointInsideCylinder(first) || pointInsideCylinder(second)) return true;

  const originsDifference = orcaVectorSubtract(first, cylinderStart);
  const lineDirection = orcaVectorSubtract(second, first);
  const originCylinder = orcaDot(originsDifference, cylinderDirection);
  const lineCylinder = orcaDot(lineDirection, cylinderDirection);
  const cylinderSquared = orcaDot(cylinderDirection, cylinderDirection);
  const lineSquared = orcaDot(lineDirection, lineDirection);
  const originLine = orcaDot(originsDifference, lineDirection);
  const originSquared = orcaDot(originsDifference, originsDifference);
  const equationA = orcaFloatSubtract(
    orcaFloatMultiply(cylinderSquared, lineSquared),
    orcaFloatMultiply(lineCylinder, lineCylinder),
  );
  const equationB = orcaFloatSubtract(
    orcaFloatMultiply(cylinderSquared, originLine),
    orcaFloatMultiply(lineCylinder, originCylinder),
  );
  const equationC = orcaFloatSubtract(
    orcaFloatMultiply(cylinderSquared, orcaFloatSubtract(originSquared, orcaFloatMultiply(radius, radius))),
    orcaFloatMultiply(originCylinder, originCylinder),
  );
  const discriminant = orcaFloatSubtract(
    orcaFloatMultiply(equationB, equationB),
    orcaFloatMultiply(equationA, equationC),
  );
  if (discriminant < 0) return false;

  const root = Math.fround(Math.sqrt(discriminant));
  const firstT = Math.fround(orcaFloatSubtract(-equationB, root) / equationA);
  if (firstT >= 0 && firstT <= 1) {
    const endcap = orcaFloatAdd(originCylinder, orcaFloatMultiply(firstT, lineCylinder));
    if (endcap >= 0 && endcap <= cylinderSquared) return true;
  }
  const secondT = Math.fround(orcaFloatAdd(-equationB, root) / equationA);
  if (secondT >= 0 && secondT <= 1) {
    const endcap = orcaFloatAdd(originCylinder, orcaFloatMultiply(secondT, lineCylinder));
    if (endcap >= 0 && endcap <= cylinderSquared) return true;
  }
  return false;
}

function lineTouchesCircleCapsule(first: Vec3, second: Vec3, cursor: ResolvedBrushCursor): boolean {
  const secondCenter = cursor.secondCenter!;
  if (
    lineTouchesCircle(first, second, cursor.center, cursor) ||
    lineTouchesCircle(first, second, secondCenter, cursor)
  ) {
    return true;
  }

  const centersDifference = orcaVectorSubtract(secondCenter, cursor.center);
  const rectangleDirection = orcaCross(centersDifference, cursor.direction);
  const centerToRectangle = orcaVectorScale(orcaNormalize(rectangleDirection), cursor.radius);
  const rectangleA = orcaVectorSubtract(cursor.center, centerToRectangle);
  const rectangleD = orcaVectorAdd(cursor.center, centerToRectangle);
  return (
    lineCrossesCapsuleRectangle(
      first,
      second,
      rectangleA,
      orcaVectorSubtract(rectangleD, rectangleA),
      cursor.center,
      secondCenter,
      centersDifference,
    ) ||
    lineCrossesCapsuleRectangle(
      first,
      second,
      rectangleD,
      orcaVectorSubtract(rectangleA, rectangleD),
      cursor.center,
      secondCenter,
      centersDifference,
    )
  );
}

function lineCrossesCapsuleRectangle(
  first: Vec3,
  second: Vec3,
  planeOrigin: Vec3,
  planeNormal: Vec3,
  firstCenter: Vec3,
  secondCenter: Vec3,
  centersDifference: Vec3,
): boolean {
  const intersection = linePlaneIntersection(first, second, planeOrigin, planeNormal);
  if (!intersection) return false;
  const start = orcaDot(firstCenter, centersDifference);
  const position = orcaDot(intersection, centersDifference);
  const end = orcaDot(secondCenter, centersDifference);
  return start <= position && position <= end;
}

function linePlaneIntersection(first: Vec3, second: Vec3, planeOrigin: Vec3, planeNormal: Vec3): Vec3 | undefined {
  const lineDirection = orcaVectorSubtract(second, first);
  const denominator = orcaDot(planeNormal, lineDirection);
  if (denominator === 0) return undefined;
  const planeDistance = orcaDot(planeNormal, planeOrigin);
  const distanceAlongLine = Math.fround(orcaFloatSubtract(planeDistance, orcaDot(planeNormal, first)) / denominator);
  if (distanceAlongLine < 0 || distanceAlongLine > 1) return undefined;
  return orcaVectorAdd(first, orcaVectorScale(lineDirection, distanceAlongLine));
}

function isCircleFacetVisible(normal: Vec3, cursor: ResolvedBrushCursor): boolean {
  const transformed = cursor.normalMatrix === undefined ? normal : multiplyMatrixVector(cursor.normalMatrix, normal);
  return orcaDot(transformed, cursor.direction) < 0;
}

const UNPAINTED = Symbol('unpainted-facet');
type FacetState = JsonValue | typeof UNPAINTED;

function facetStates(assignments: readonly TriangleAssignments<JsonValue>[], triangleCount: number): FacetState[] {
  const states = new Array<FacetState>(triangleCount).fill(UNPAINTED);
  for (const assignment of assignments) {
    for (const triangle of assignment.triangles) states[triangle] = assignment.value;
  }
  return states;
}

function selectionFromIndices(indices: readonly number[], triangleCount: number): FacetRegionSelection {
  const triangleIndices = Object.freeze([...indices]);
  const ranges = Object.freeze(
    triangleRangesFromIndices(triangleIndices, triangleCount).map((range) => Object.freeze(range)),
  );
  return Object.freeze({ triangleIndices, ranges });
}

function validateRequest<Channel extends FacetAnnotationChannel>(request: FacetRegionSelectionRequest<Channel>): void {
  const issues: FacetAnnotationIssue[] = [];
  if (
    !Number.isSafeInteger(request.guard.topologyRevision) ||
    request.guard.topologyRevision < 0 ||
    !Number.isSafeInteger(request.guard.triangleCount) ||
    request.guard.triangleCount < 0
  ) {
    issues.push({
      code: 'invalid-facet-selection-guard',
      path: 'guard',
      message: 'Topology revision and triangle count must be non-negative safe integers',
    });
  }
  if (
    request.tool.kind !== 'gapFill' &&
    (!Number.isSafeInteger(request.seedTriangle) ||
      request.seedTriangle < 0 ||
      request.seedTriangle >= request.guard.triangleCount)
  ) {
    issues.push({
      code: 'invalid-seed-triangle',
      path: 'seedTriangle',
      message: `Seed triangle must be in [0, ${request.guard.triangleCount - 1}]`,
    });
  }
  if (!FACET_ANNOTATION_CHANNELS.has(request.channel)) {
    issues.push({
      code: 'invalid-facet-selection-channel',
      path: 'channel',
      message: 'Facet selection channel is not supported',
    });
  }
  if (
    request.highlightByAngleDegrees !== undefined &&
    (!Number.isFinite(request.highlightByAngleDegrees) ||
      request.highlightByAngleDegrees < ORCA_OVERHANG_ANGLE_MIN_DEGREES ||
      request.highlightByAngleDegrees > ORCA_OVERHANG_ANGLE_MAX_DEGREES)
  ) {
    issues.push({
      code: 'invalid-overhang-highlight-angle',
      path: 'highlightByAngleDegrees',
      message: `Overhang highlight angle must be finite and in [${ORCA_OVERHANG_ANGLE_MIN_DEGREES}, ${ORCA_OVERHANG_ANGLE_MAX_DEGREES}] degrees`,
    });
  }
  validateRefinementEncoding(request, issues);

  switch (request.tool.kind) {
    case 'fill': {
      if (request.tool.hit !== undefined && !isFiniteFloatVector(request.tool.hit)) {
        issues.push({
          code: 'invalid-refinement-hit',
          path: 'tool.hit',
          message: 'Refinement hit must contain three finite float32 coordinates',
        });
      }
      if (!request.tool.edgeDetection) break;
      const angle = request.tool.edgeDetection.maxAdjacentAngleDegrees;
      if (
        !Number.isFinite(angle) ||
        angle < ORCA_SMART_FILL_ANGLE_MIN_DEGREES ||
        angle > ORCA_SMART_FILL_ANGLE_MAX_DEGREES
      ) {
        issues.push({
          code: 'invalid-smart-fill-angle',
          path: 'tool.edgeDetection.maxAdjacentAngleDegrees',
          message: 'Smart-fill angle must be finite and in [0, 90] degrees',
        });
      }
      break;
    }
    case 'circle':
    case 'sphere': {
      if (request.tool.triangleSplitting !== undefined && typeof request.tool.triangleSplitting !== 'boolean') {
        issues.push({
          code: 'invalid-triangle-splitting',
          path: 'tool.triangleSplitting',
          message: 'Triangle splitting must be boolean when provided',
        });
      }
      if (
        !isFiniteFloatVector(request.tool.center) ||
        !isFiniteFloatVector(request.tool.cameraPosition) ||
        (request.tool.previousCenter !== undefined && !isFiniteFloatVector(request.tool.previousCenter))
      ) {
        issues.push({
          code: 'invalid-brush-position',
          path: 'tool',
          message: 'Brush centers and camera position must contain three finite float32 coordinates',
        });
      }
      if (
        !Number.isFinite(request.tool.radiusMm) ||
        request.tool.radiusMm < ORCA_BRUSH_RADIUS_MIN_MM ||
        request.tool.radiusMm > ORCA_BRUSH_RADIUS_MAX_MM
      ) {
        issues.push({
          code: 'invalid-brush-radius',
          path: 'tool.radiusMm',
          message: `Brush radius must be finite and in [${ORCA_BRUSH_RADIUS_MIN_MM}, ${ORCA_BRUSH_RADIUS_MAX_MM}] mm`,
        });
      }
      break;
    }
    case 'heightRange': {
      if (request.tool.triangleSplitting !== undefined && typeof request.tool.triangleSplitting !== 'boolean') {
        issues.push({
          code: 'invalid-triangle-splitting',
          path: 'tool.triangleSplitting',
          message: 'Triangle splitting must be boolean when provided',
        });
      }
      if (!isFiniteFloat(request.tool.startZMm)) {
        issues.push({
          code: 'invalid-height-range-start',
          path: 'tool.startZMm',
          message: 'Height-range start Z must be a finite float32 value',
        });
      }
      if (
        !Number.isFinite(request.tool.heightMm) ||
        request.tool.heightMm < ORCA_HEIGHT_RANGE_MIN_MM ||
        request.tool.heightMm > ORCA_HEIGHT_RANGE_MAX_MM
      ) {
        issues.push({
          code: 'invalid-height-range-height',
          path: 'tool.heightMm',
          message: `Height range must be finite and in [${ORCA_HEIGHT_RANGE_MIN_MM}, ${ORCA_HEIGHT_RANGE_MAX_MM}] mm`,
        });
      }
      if (
        isFiniteFloat(request.tool.startZMm) &&
        Number.isFinite(request.tool.heightMm) &&
        !Number.isFinite(Math.fround(Math.fround(request.tool.startZMm) + Math.fround(request.tool.heightMm)))
      ) {
        issues.push({
          code: 'invalid-height-range-bounds',
          path: 'tool',
          message: 'Height-range bounds must remain finite in float32 arithmetic',
        });
      }
      break;
    }
    case 'gapFill': {
      if (
        !Number.isFinite(request.tool.maxAreaMm2) ||
        request.tool.maxAreaMm2 < ORCA_GAP_AREA_MIN_MM2 ||
        request.tool.maxAreaMm2 > ORCA_GAP_AREA_MAX_MM2
      ) {
        issues.push({
          code: 'invalid-gap-fill-area',
          path: 'tool.maxAreaMm2',
          message: `Gap Fill area must be finite and in [${ORCA_GAP_AREA_MIN_MM2}, ${ORCA_GAP_AREA_MAX_MM2}] mm²`,
        });
      }

      const seenStates = new Set<string>();
      request.tool.stateOrder.forEach((state, stateIndex) => {
        const path = `tool.stateOrder[${stateIndex}]`;
        if (!isFacetChannelValue(request.channel, state)) {
          issues.push({
            code: 'invalid-gap-fill-state',
            path,
            message: `Gap Fill state is invalid for the ${request.channel} channel`,
          });
          return;
        }
        const key = canonicalStringify(state);
        if (seenStates.has(key)) {
          issues.push({
            code: 'duplicate-gap-fill-state',
            path,
            message: 'Gap Fill state order must not contain duplicate values',
          });
        }
        seenStates.add(key);
      });

      if (FACET_ANNOTATION_CHANNELS.has(request.channel)) {
        const assignments = request.annotations[request.channel] as readonly TriangleAssignments<JsonValue>[];
        assignments.forEach((assignment, assignmentIndex) => {
          if (!seenStates.has(canonicalStringify(assignment.value))) {
            issues.push({
              code: 'missing-gap-fill-state',
              path: `${request.channel}[${assignmentIndex}].value`,
              message: 'Every assigned facet state must have a pinned numeric position in tool.stateOrder',
            });
          }
        });
        for (const state of refinementLeafStates(request.refinement)) {
          if (state.kind === 'assigned' && !seenStates.has(canonicalStringify(state.value))) {
            issues.push({
              code: 'missing-gap-fill-state',
              path: 'refinement',
              message: 'Every assigned refined state must have a pinned numeric position in tool.stateOrder',
            });
            break;
          }
        }
      }
      break;
    }
    case 'triangle':
      if (request.tool.hit !== undefined && !isFiniteFloatVector(request.tool.hit)) {
        issues.push({
          code: 'invalid-refinement-hit',
          path: 'tool.hit',
          message: 'Refinement hit must contain three finite float32 coordinates',
        });
      }
      break;
    default:
      issues.push({
        code: 'invalid-facet-region-tool',
        path: 'tool.kind',
        message: `Unsupported facet region tool ${String((request.tool as { kind?: unknown }).kind)}`,
      });
  }

  if (request.clippingPlane) {
    if (
      !isFiniteFloatVector(request.clippingPlane.normal) ||
      !isFiniteFloat(request.clippingPlane.offset) ||
      orcaSquaredNorm(floatVector(request.clippingPlane.normal)) === 0
    ) {
      issues.push({
        code: 'invalid-facet-clipping-plane',
        path: 'clippingPlane',
        message: 'Clipping plane must have a non-zero finite float32 normal and finite float32 offset',
      });
    }
  }

  let transformValid = true;
  if (request.transform) {
    const { linear, translation, scalingFactors } = request.transform;
    transformValid =
      linear.length === 3 &&
      linear.every((row) => isFiniteFloatVector(row)) &&
      isFiniteFloatVector(translation) &&
      scalingFactors.length === 3 &&
      scalingFactors.every((factor) => Number.isFinite(factor) && factor > 0);
    if (transformValid) {
      const determinant = matrixDeterminant(linear);
      transformValid = determinant !== 0 && Number.isFinite(determinant);
      if (transformValid) {
        transformValid = inverseTranspose(linear).every((row) => isFiniteFloatVector(row));
      }
    }
    if (!transformValid) {
      issues.push({
        code: 'invalid-facet-selection-transform',
        path: 'transform',
        message: 'Facet selection transform must be finite, invertible, and have positive scaling factors',
      });
    }
  }

  if (
    (request.tool.kind === 'circle' || request.tool.kind === 'sphere') &&
    isFiniteFloatVector(request.tool.center) &&
    isFiniteFloatVector(request.tool.cameraPosition) &&
    (request.tool.previousCenter === undefined || isFiniteFloatVector(request.tool.previousCenter)) &&
    Number.isFinite(request.tool.radiusMm) &&
    transformValid
  ) {
    const transform = request.transform ?? IDENTITY_FACET_SELECTION_TRANSFORM;
    const scale = transform.scalingFactors;
    const uniformScaling =
      Math.abs(scale[0] - scale[1]) < ORCA_TRIANGLE_SELECTOR_EPSILON &&
      Math.abs(scale[1] - scale[2]) < ORCA_TRIANGLE_SELECTOR_EPSILON;
    const firstCenterInput = request.tool.previousCenter ?? request.tool.center;
    const center = uniformScaling ? floatVector(firstCenterInput) : transformPoint(transform, firstCenterInput);
    const source = uniformScaling
      ? floatVector(request.tool.cameraPosition)
      : transformPoint(transform, request.tool.cameraPosition);
    const directionSquared = orcaSquaredNorm(orcaVectorSubtract(center, source));
    const resolvedRadius = uniformScaling
      ? Math.fround(Math.fround(request.tool.radiusMm) / scale[0])
      : Math.fround(request.tool.radiusMm);
    if (directionSquared === 0 || !Number.isFinite(directionSquared)) {
      issues.push({
        code: 'invalid-brush-direction',
        path: 'tool.cameraPosition',
        message: 'Brush center and camera position must resolve to distinct float32 points',
      });
    }
    if (request.tool.previousCenter !== undefined) {
      const secondCenter = uniformScaling
        ? floatVector(request.tool.center)
        : transformPoint(transform, request.tool.center);
      const sweepSquared = orcaSquaredNorm(orcaVectorSubtract(secondCenter, center));
      if (sweepSquared === 0 || !Number.isFinite(sweepSquared)) {
        issues.push({
          code: 'invalid-brush-sweep',
          path: 'tool.previousCenter',
          message: 'Swept brush centers must resolve to distinct float32 points',
        });
      }
    }
    if (!(resolvedRadius > 0) || !Number.isFinite(resolvedRadius)) {
      issues.push({
        code: 'invalid-resolved-brush-radius',
        path: 'transform.scalingFactors',
        message: 'Brush radius must remain positive and finite after uniform-scale conversion',
      });
    }
  }

  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);
  validateMesh(request.mesh);
}

function validateRefinementEncoding<Channel extends FacetAnnotationChannel>(
  request: FacetRegionSelectionRequest<Channel>,
  issues: FacetAnnotationIssue[],
): void {
  if (request.refinement === undefined) return;
  const candidate = request.refinement as unknown;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    issues.push({
      code: 'invalid-facet-refinement',
      path: 'refinement',
      message: 'Facet refinement must be an encoding object',
    });
    return;
  }
  const encoding = candidate as { readonly version?: unknown; readonly roots?: unknown };
  if (encoding.version !== ORCA_REFINEMENT_ENCODING_VERSION) {
    issues.push({
      code: 'invalid-facet-refinement-version',
      path: 'refinement.version',
      message: `Facet refinement version must be ${ORCA_REFINEMENT_ENCODING_VERSION}`,
    });
  }
  if (!Array.isArray(encoding.roots)) {
    issues.push({
      code: 'invalid-facet-refinement-roots',
      path: 'refinement.roots',
      message: 'Facet refinement roots must be an array',
    });
    return;
  }
  if (encoding.roots.length !== request.guard.triangleCount) {
    issues.push({
      code: 'invalid-facet-refinement-root-count',
      path: 'refinement.roots',
      message: 'Facet refinement must contain exactly one root per source triangle',
    });
  }
  if (encoding.roots.length > ORCA_REFINEMENT_MAX_NODES) {
    issues.push({
      code: 'facet-refinement-limit-exceeded',
      path: 'refinement.roots',
      message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_NODES} nodes`,
    });
    return;
  }

  const seen = new Set<object>();
  const stack: { readonly node: unknown; readonly path: string; readonly depth: number }[] = encoding.roots.map(
    (node, index) => ({
      node,
      path: `refinement.roots[${index}]`,
      depth: 0,
    }),
  );
  let nodeCount = 0;
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > ORCA_REFINEMENT_MAX_NODES) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path: 'refinement',
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_NODES} nodes`,
      });
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      issues.push({
        code: 'invalid-facet-refinement-node',
        path,
        message: 'Facet refinement nodes must be objects',
      });
      continue;
    }
    if (seen.has(node)) {
      issues.push({
        code: 'invalid-facet-refinement-tree',
        path,
        message: 'Facet refinement must be an acyclic tree without shared nodes',
      });
      continue;
    }
    seen.add(node);
    const record = node as {
      readonly kind?: unknown;
      readonly state?: unknown;
      readonly splitSides?: unknown;
      readonly specialSide?: unknown;
      readonly children?: unknown;
    };
    if (record.kind === 'leaf') {
      if (!isValidRefinementState(request.channel, record.state)) {
        issues.push({
          code: 'invalid-facet-refinement-state',
          path: `${path}.state`,
          message: `Refined leaf state is invalid for the ${request.channel} channel`,
        });
      }
      continue;
    }
    if (record.kind !== 'split') {
      issues.push({
        code: 'invalid-facet-refinement-node',
        path: `${path}.kind`,
        message: 'Facet refinement node kind must be leaf or split',
      });
      continue;
    }
    const splitSides =
      record.splitSides === 1 || record.splitSides === 2 || record.splitSides === 3 ? record.splitSides : undefined;
    if (splitSides === undefined) {
      issues.push({
        code: 'invalid-facet-refinement-split',
        path: `${path}.splitSides`,
        message: 'Refined split side count must be 1, 2, or 3',
      });
    }
    const specialSide =
      record.specialSide === 0 || record.specialSide === 1 || record.specialSide === 2 ? record.specialSide : undefined;
    if (specialSide === undefined || (splitSides === 3 && specialSide !== 0)) {
      issues.push({
        code: 'invalid-facet-refinement-special-side',
        path: `${path}.specialSide`,
        message: 'Refined special side must be 0, 1, or 2; a three-side split must use side 0',
      });
    }
    if (!Array.isArray(record.children)) {
      issues.push({
        code: 'invalid-facet-refinement-children',
        path: `${path}.children`,
        message: 'Refined split children must be an array',
      });
      continue;
    }
    if (splitSides === undefined || record.children.length !== splitSides + 1) {
      if (splitSides === undefined) continue;
      issues.push({
        code: 'invalid-facet-refinement-child-count',
        path: `${path}.children`,
        message: 'Refined child count must equal splitSides + 1',
      });
      continue;
    }
    if (depth >= ORCA_REFINEMENT_MAX_DEPTH) {
      issues.push({
        code: 'facet-refinement-limit-exceeded',
        path,
        message: `Facet refinement may contain at most ${ORCA_REFINEMENT_MAX_DEPTH} split levels`,
      });
      continue;
    }
    record.children.forEach((child, childIndex) => {
      stack.push({
        node: child,
        path: `${path}.children[${childIndex}]`,
        depth: depth + 1,
      });
    });
  }
}

function isValidRefinementState(channel: FacetAnnotationChannel, state: unknown): state is FacetRegionState {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return false;
  const record = state as { readonly kind?: unknown; readonly value?: unknown };
  return (
    record.kind === 'unpainted' ||
    (record.kind === 'assigned' && isFacetChannelValue(channel, record.value as JsonValue))
  );
}

function refinementLeafStates(refinement: FacetRefinementEncoding | undefined): FacetRegionState[] {
  if (refinement === undefined || !Array.isArray((refinement as { roots?: unknown }).roots)) {
    return [];
  }
  const states: FacetRegionState[] = [];
  const stack: unknown[] = [...refinement.roots];
  const seen = new Set<object>();
  while (stack.length > 0 && seen.size <= ORCA_REFINEMENT_MAX_NODES) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || Array.isArray(node) || seen.has(node)) continue;
    seen.add(node);
    const record = node as {
      readonly kind?: unknown;
      readonly state?: unknown;
      readonly children?: unknown;
    };
    if (record.kind === 'leaf') {
      if (typeof record.state === 'object' && record.state !== null && !Array.isArray(record.state)) {
        const state = record.state as { readonly kind?: unknown; readonly value?: unknown };
        if (state.kind === 'unpainted') {
          states.push({ kind: 'unpainted' });
        } else if (state.kind === 'assigned') {
          states.push({ kind: 'assigned', value: state.value as JsonValue });
        }
      }
    } else if (record.kind === 'split' && Array.isArray(record.children) && record.children.length <= 4) {
      stack.push(...record.children);
    }
  }
  return states;
}

function validateMesh(mesh: FacetSelectionMesh): void {
  const issues: FacetAnnotationIssue[] = [];
  mesh.vertices.forEach((vertex, index) => {
    if (!isFiniteFloatVector(vertex)) {
      issues.push({
        code: 'invalid-facet-mesh-vertex',
        path: `mesh.vertices[${index}]`,
        message: 'Facet mesh vertices must contain three finite float32 coordinates',
      });
    }
  });
  mesh.triangles.forEach((triangle, triangleIndex) => {
    if (
      triangle.length !== 3 ||
      triangle.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= mesh.vertices.length)
    ) {
      issues.push({
        code: 'invalid-facet-mesh-triangle',
        path: `mesh.triangles[${triangleIndex}]`,
        message: 'Facet mesh triangles must contain three in-range vertex indices',
      });
    }
  });
  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);
}

function buildValidatedOrcaFaceNeighbors(mesh: FacetSelectionMesh): OrcaFaceNeighbors {
  const vertexFaces = Array.from({ length: mesh.vertices.length }, () => [] as number[]);
  mesh.triangles.forEach((triangle, face) => {
    triangle.forEach((vertex) => vertexFaces[vertex].push(face));
  });

  const neighbors: [number, number, number][] = mesh.triangles.map(() => [-1, -1, -1]);
  mesh.triangles.forEach((triangle, face) => {
    for (let edge = 0; edge < 3; edge += 1) {
      if (neighbors[face][edge] !== -1) continue;
      const first = triangle[edge];
      const second = triangle[(edge + 1) % 3];
      for (const otherFace of vertexFaces[first]) {
        if (otherFace <= face) continue;
        const other = mesh.triangles[otherFace];
        const secondIndex = other.indexOf(second);
        if (secondIndex < 0 || other[(secondIndex + 1) % 3] !== first || neighbors[otherFace][secondIndex] !== -1) {
          continue;
        }
        neighbors[face][edge] = otherFace;
        neighbors[otherFace][secondIndex] = face;
        break;
      }
    }
  });
  return Object.freeze(neighbors.map((entry) => Object.freeze(entry)));
}

function isFacetClipped(mesh: FacetSelectionMesh, triangleIndex: number, clippingPlane?: FacetClippingPlane): boolean {
  if (!clippingPlane) return false;
  return mesh.triangles[triangleIndex].some((vertexIndex) => isPointClipped(mesh.vertices[vertexIndex], clippingPlane));
}

const FACET_ANNOTATION_CHANNELS: ReadonlySet<string> = new Set(['color', 'support', 'seam', 'fuzzySkin', 'brim']);

function isFacetChannelValue(channel: FacetAnnotationChannel, value: JsonValue): boolean {
  switch (channel) {
    case 'color':
      return typeof value === 'string';
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

function isFiniteFloat(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function isFiniteFloatVector(vector: readonly number[]): vector is Vec3 {
  return vector.length === 3 && vector.every(isFiniteFloat);
}

function isPointClipped(point: Vec3, clippingPlane?: FacetClippingPlane): boolean {
  return (
    clippingPlane !== undefined &&
    orcaFloatSubtract(orcaDot(floatVector(clippingPlane.normal), floatVector(point)), clippingPlane.offset) > 0
  );
}

function floatVector(vector: Vec3): Vec3 {
  return [Math.fround(vector[0]), Math.fround(vector[1]), Math.fround(vector[2])];
}

function orcaVectorAdd(left: Vec3, right: Vec3): Vec3 {
  return [orcaFloatAdd(left[0], right[0]), orcaFloatAdd(left[1], right[1]), orcaFloatAdd(left[2], right[2])];
}

function orcaVectorSubtract(left: Vec3, right: Vec3): Vec3 {
  return [
    orcaFloatSubtract(left[0], right[0]),
    orcaFloatSubtract(left[1], right[1]),
    orcaFloatSubtract(left[2], right[2]),
  ];
}

function orcaVectorScale(vector: Vec3, scalar: number): Vec3 {
  return [
    orcaFloatMultiply(vector[0], scalar),
    orcaFloatMultiply(vector[1], scalar),
    orcaFloatMultiply(vector[2], scalar),
  ];
}

function orcaCross(left: Vec3, right: Vec3): Vec3 {
  return [
    orcaFloatSubtract(orcaFloatMultiply(left[1], right[2]), orcaFloatMultiply(left[2], right[1])),
    orcaFloatSubtract(orcaFloatMultiply(left[2], right[0]), orcaFloatMultiply(left[0], right[2])),
    orcaFloatSubtract(orcaFloatMultiply(left[0], right[1]), orcaFloatMultiply(left[1], right[0])),
  ];
}

function orcaSquaredNorm(vector: Vec3): number {
  return orcaDot(vector, vector);
}

function orcaNorm(vector: Vec3): number {
  return Math.fround(Math.sqrt(orcaSquaredNorm(vector)));
}

function transformPoint(transform: FacetSelectionTransform, point: Vec3): Vec3 {
  const floatPoint = floatVector(point);
  return [
    orcaFloatAdd(orcaDot(floatVector(transform.linear[0]), floatPoint), transform.translation[0]),
    orcaFloatAdd(orcaDot(floatVector(transform.linear[1]), floatPoint), transform.translation[1]),
    orcaFloatAdd(orcaDot(floatVector(transform.linear[2]), floatPoint), transform.translation[2]),
  ];
}

function multiplyMatrixVector(matrix: readonly [Vec3, Vec3, Vec3], vector: Vec3): Vec3 {
  const float = floatVector(vector);
  return [orcaDot(matrix[0], float), orcaDot(matrix[1], float), orcaDot(matrix[2], float)];
}

function matrixDeterminant(matrix: readonly [Vec3, Vec3, Vec3]): number {
  const [first, second, third] = matrix.map(floatVector) as [Vec3, Vec3, Vec3];
  const cofactors: Vec3 = [
    orcaFloatSubtract(orcaFloatMultiply(second[1], third[2]), orcaFloatMultiply(second[2], third[1])),
    orcaFloatSubtract(orcaFloatMultiply(second[2], third[0]), orcaFloatMultiply(second[0], third[2])),
    orcaFloatSubtract(orcaFloatMultiply(second[0], third[1]), orcaFloatMultiply(second[1], third[0])),
  ];
  return orcaDot(first, cofactors);
}

function inverseTranspose(matrix: readonly [Vec3, Vec3, Vec3]): readonly [Vec3, Vec3, Vec3] {
  const [first, second, third] = matrix.map(floatVector) as [Vec3, Vec3, Vec3];
  const determinant = matrixDeterminant(matrix);
  const divide = (value: number): number => Math.fround(Math.fround(value) / determinant);
  return [
    [
      divide(orcaFloatSubtract(orcaFloatMultiply(second[1], third[2]), orcaFloatMultiply(second[2], third[1]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(second[2], third[0]), orcaFloatMultiply(second[0], third[2]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(second[0], third[1]), orcaFloatMultiply(second[1], third[0]))),
    ],
    [
      divide(orcaFloatSubtract(orcaFloatMultiply(first[2], third[1]), orcaFloatMultiply(first[1], third[2]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(first[0], third[2]), orcaFloatMultiply(first[2], third[0]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(first[1], third[0]), orcaFloatMultiply(first[0], third[1]))),
    ],
    [
      divide(orcaFloatSubtract(orcaFloatMultiply(first[1], second[2]), orcaFloatMultiply(first[2], second[1]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(first[2], second[0]), orcaFloatMultiply(first[0], second[2]))),
      divide(orcaFloatSubtract(orcaFloatMultiply(first[0], second[1]), orcaFloatMultiply(first[1], second[0]))),
    ],
  ];
}

function inverseTransposeDoubleThenFloat(matrix: readonly [Vec3, Vec3, Vec3]): readonly [Vec3, Vec3, Vec3] {
  const [first, second, third] = matrix;
  const cofactors: readonly [Vec3, Vec3, Vec3] = [
    [
      second[1] * third[2] - second[2] * third[1],
      second[2] * third[0] - second[0] * third[2],
      second[0] * third[1] - second[1] * third[0],
    ],
    [
      first[2] * third[1] - first[1] * third[2],
      first[0] * third[2] - first[2] * third[0],
      first[1] * third[0] - first[0] * third[1],
    ],
    [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ],
  ];
  const determinant = first[0] * cofactors[0][0] + first[1] * cofactors[0][1] + first[2] * cofactors[0][2];
  const castRow = (row: Vec3): Vec3 => [
    Math.fround(row[0] / determinant),
    Math.fround(row[1] / determinant),
    Math.fround(row[2] / determinant),
  ];
  return [castRow(cofactors[0]), castRow(cofactors[1]), castRow(cofactors[2])];
}

/**
 * Eigen performs these operations on Vec3f. Explicit fround calls preserve the
 * pinned float32 threshold behavior even when this module runs in JS doubles.
 */
function orcaFaceNormal(vertices: readonly Vec3[], triangle: FacetTriangle): Vec3 {
  const first = vertices[triangle[0]];
  const second = vertices[triangle[1]];
  const third = vertices[triangle[2]];
  const u: Vec3 = [
    orcaFloatSubtract(second[0], first[0]),
    orcaFloatSubtract(second[1], first[1]),
    orcaFloatSubtract(second[2], first[2]),
  ];
  const v: Vec3 = [
    orcaFloatSubtract(third[0], second[0]),
    orcaFloatSubtract(third[1], second[1]),
    orcaFloatSubtract(third[2], second[2]),
  ];
  const cross: Vec3 = [
    orcaFloatSubtract(orcaFloatMultiply(u[1], v[2]), orcaFloatMultiply(u[2], v[1])),
    orcaFloatSubtract(orcaFloatMultiply(u[2], v[0]), orcaFloatMultiply(u[0], v[2])),
    orcaFloatSubtract(orcaFloatMultiply(u[0], v[1]), orcaFloatMultiply(u[1], v[0])),
  ];
  // Upstream's face_normal_normalized calls normalized() twice.
  return orcaNormalize(orcaNormalize(cross));
}

function orcaNormalize(vector: Vec3): Vec3 {
  const squared = orcaFloatAdd(
    orcaFloatAdd(orcaFloatMultiply(vector[0], vector[0]), orcaFloatMultiply(vector[1], vector[1])),
    orcaFloatMultiply(vector[2], vector[2]),
  );
  const length = Math.fround(Math.sqrt(squared));
  return [Math.fround(vector[0] / length), Math.fround(vector[1] / length), Math.fround(vector[2] / length)];
}

function orcaDot(left: Vec3, right: Vec3): number {
  return orcaFloatAdd(
    orcaFloatAdd(orcaFloatMultiply(left[0], right[0]), orcaFloatMultiply(left[1], right[1])),
    orcaFloatMultiply(left[2], right[2]),
  );
}

function orcaCosDegrees(angleDegrees: number): number {
  const radians = Math.fround(orcaFloatMultiply(Math.fround(Math.PI), Math.fround(angleDegrees)) / Math.fround(180));
  return Math.fround(Math.cos(radians));
}

function orcaFloatMultiply(left: number, right: number): number {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function orcaFloatAdd(left: number, right: number): number {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function orcaFloatSubtract(left: number, right: number): number {
  return Math.fround(Math.fround(left) - Math.fround(right));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
