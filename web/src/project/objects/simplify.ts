/**
 * Canonical mesh simplification (P5.3.5).
 *
 * Quadric-error-metric edge collapse, matching the pinned
 * `libslic3r/QuadricEdgeCollapse.cpp` and the `GLGizmoSimplify` control
 * semantics at `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`: either decimate to a
 * wanted triangle count derived from a percentage, or collapse until the next
 * best edge would exceed a maximum quadric error.
 *
 * Deliberate deviation, documented rather than hidden: upstream drives its
 * collapse order through a bespoke mutable mini-heap whose tie-breaking depends
 * on internal heap layout. This port uses a binary heap with lazy invalidation
 * and an explicit deterministic tie-break on (error, triangle index), so the
 * same mesh always decimates the same way. The quadric maths, the error
 * threshold, the wanted-count derivation, and the refusal to collapse an edge
 * that would flip a face are the pinned behaviour.
 */

import type { FacetSelectionMesh } from '../annotations';
import type { Vec3 } from '../domain/model';

export const PINNED_SIMPLIFY_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  algorithm: 'src/libslic3r/QuadricEdgeCollapse.cpp',
  controls: 'src/slic3r/GUI/Gizmos/GLGizmoSimplify.cpp',
});

/** Pinned `GLGizmoSimplify::Configuration` defaults. */
export const SIMPLIFY_DEFAULT_DECIMATE_RATIO = 50;
export const SIMPLIFY_DEFAULT_MAX_ERROR = 1;

export interface SimplifyConfiguration {
  /** Pinned `use_count`: drive by triangle count instead of quadric error. */
  readonly useCount: boolean;
  /** Percent of triangles to remove, `0..100`; only read when `useCount`. */
  readonly decimateRatio: number;
  /** Maximum quadric error; only read when `useCount` is false. */
  readonly maxError: number;
}

export const DEFAULT_SIMPLIFY_CONFIGURATION: SimplifyConfiguration = Object.freeze({
  useCount: true,
  decimateRatio: SIMPLIFY_DEFAULT_DECIMATE_RATIO,
  maxError: SIMPLIFY_DEFAULT_MAX_ERROR,
});

export interface SimplifyResult {
  readonly vertices: readonly Vec3[];
  readonly triangles: readonly (readonly [number, number, number])[];
  /** Triangle count before decimation, for an honest before/after readout. */
  readonly sourceTriangleCount: number;
  /** Largest collapse error actually accepted. */
  readonly maxAppliedError: number;
  /** True when the run stopped because the next edge exceeded `maxError`. */
  readonly stoppedOnError: boolean;
}

export class SimplifyError extends Error {
  constructor(
    message: string,
    readonly code: 'degenerate-mesh' | 'invalid-configuration' | 'cancelled',
  ) {
    super(message);
    this.name = 'SimplifyError';
  }
}

export interface SimplifyOptions {
  /** Called with `0..100`; throwing from it cancels the run. */
  readonly onProgress?: (percent: number) => void;
  readonly isCancelled?: () => boolean;
}

/**
 * Pinned `Configuration::fix_count_by_ratio`: a ratio of 0 keeps everything and
 * 100 asks for nothing, with the rounding upstream applies in between.
 */
export function wantedTriangleCount(triangleCount: number, decimateRatio: number): number {
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 0) {
    throw new SimplifyError('Triangle count must be a non-negative integer', 'invalid-configuration');
  }
  if (!Number.isFinite(decimateRatio)) {
    throw new SimplifyError('Decimate ratio must be finite', 'invalid-configuration');
  }
  if (decimateRatio <= 0) return triangleCount;
  if (decimateRatio >= 100) return 0;
  return Math.round((triangleCount * (100 - decimateRatio)) / 100);
}

export function assertSimplifyConfiguration(configuration: SimplifyConfiguration): void {
  if (!Number.isFinite(configuration.decimateRatio)) {
    throw new SimplifyError('Decimate ratio must be finite', 'invalid-configuration');
  }
  if (!configuration.useCount && !(configuration.maxError > 0)) {
    // Pinned: a non-positive maximal error decimates nothing at all.
    throw new SimplifyError('Maximum error must be greater than zero', 'invalid-configuration');
  }
}

/** Symmetric 4x4 quadric stored as the pinned 10 upper-triangular terms. */
type Quadric = Float64Array;

function planeQuadric(normal: Vec3, offset: number): Quadric {
  const [a, b, c] = normal;
  const d = offset;
  return Float64Array.from([a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d]);
}

function addQuadric(target: Quadric, source: Quadric): void {
  for (let index = 0; index < 10; index += 1) target[index] += source[index];
}

function quadricError(q: Quadric, p: Vec3): number {
  const [x, y, z] = p;
  return (
    q[0] * x * x +
    2 * q[1] * x * y +
    2 * q[2] * x * z +
    2 * q[3] * x +
    q[4] * y * y +
    2 * q[5] * y * z +
    2 * q[6] * y +
    q[7] * z * z +
    2 * q[8] * z +
    q[9]
  );
}

/**
 * Optimal collapse position: solve the 3x3 quadric system, falling back to the
 * best of the two endpoints and their midpoint when it is singular — exactly
 * the fallback order the pinned implementation uses.
 */
function optimalPosition(q: Quadric, a: Vec3, b: Vec3): { position: Vec3; error: number } {
  const m11 = q[0];
  const m12 = q[1];
  const m13 = q[2];
  const m22 = q[4];
  const m23 = q[5];
  const m33 = q[7];
  const determinant = m11 * (m22 * m33 - m23 * m23) - m12 * (m12 * m33 - m23 * m13) + m13 * (m12 * m23 - m22 * m13);
  if (Math.abs(determinant) > 1e-12) {
    const bx = -q[3];
    const by = -q[6];
    const bz = -q[8];
    const position: Vec3 = [
      (bx * (m22 * m33 - m23 * m23) - m12 * (by * m33 - m23 * bz) + m13 * (by * m23 - m22 * bz)) / determinant,
      (m11 * (by * m33 - bz * m23) - bx * (m12 * m33 - m23 * m13) + m13 * (m12 * bz - by * m13)) / determinant,
      (m11 * (m22 * bz - by * m23) - m12 * (m12 * bz - by * m13) + bx * (m12 * m23 - m22 * m13)) / determinant,
    ];
    return { position, error: Math.max(0, quadricError(q, position)) };
  }
  const midpoint: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let best = { position: a, error: Math.max(0, quadricError(q, a)) };
  for (const candidate of [b, midpoint]) {
    const error = Math.max(0, quadricError(q, candidate));
    if (error < best.error) best = { position: candidate, error };
  }
  return best;
}

interface Candidate {
  readonly a: number;
  readonly b: number;
  readonly error: number;
  readonly position: Vec3;
  /** Snapshot of both endpoints' versions; a stale entry is skipped. */
  readonly versionA: number;
  readonly versionB: number;
}

/**
 * Decimate a mesh. The source is never mutated: the caller installs the result
 * through the guarded topology-replacement command, which is what invalidates
 * facet annotations and makes the change undoable.
 */
export function simplifyMesh(
  mesh: FacetSelectionMesh,
  configuration: SimplifyConfiguration = DEFAULT_SIMPLIFY_CONFIGURATION,
  options: SimplifyOptions = {},
): SimplifyResult {
  assertSimplifyConfiguration(configuration);
  const sourceTriangleCount = mesh.triangles.length;
  if (sourceTriangleCount === 0) {
    throw new SimplifyError('A mesh with no facets cannot be simplified', 'degenerate-mesh');
  }

  const target = configuration.useCount ? wantedTriangleCount(sourceTriangleCount, configuration.decimateRatio) : 0;
  const maxError = configuration.useCount ? Number.POSITIVE_INFINITY : configuration.maxError;
  // Pinned: asking for at least the current count is a no-op.
  if (configuration.useCount && target >= sourceTriangleCount) {
    return frozenResult(mesh.vertices, mesh.triangles, sourceTriangleCount, 0, false);
  }

  const vertices: Vec3[] = mesh.vertices.map((vertex) => [vertex[0], vertex[1], vertex[2]]);
  const triangles: [number, number, number][] = mesh.triangles.map((triangle) => [
    triangle[0],
    triangle[1],
    triangle[2],
  ]);
  const removedTriangle = new Uint8Array(triangles.length);
  const removedVertex = new Uint8Array(vertices.length);
  const version = new Int32Array(vertices.length);

  // Per-vertex quadric from every incident face plane.
  const quadrics: Quadric[] = vertices.map(() => new Float64Array(10));
  const incident: Set<number>[] = vertices.map(() => new Set<number>());
  for (const [index, triangle] of triangles.entries()) {
    const normal = faceNormal(vertices, triangle);
    if (!normal) continue;
    const offset = -(
      normal[0] * vertices[triangle[0]][0] +
      normal[1] * vertices[triangle[0]][1] +
      normal[2] * vertices[triangle[0]][2]
    );
    const q = planeQuadric(normal, offset);
    for (const vertex of triangle) {
      addQuadric(quadrics[vertex], q);
      incident[vertex].add(index);
    }
  }

  const heap: Candidate[] = [];
  const pushEdge = (a: number, b: number): void => {
    if (a === b || removedVertex[a] || removedVertex[b]) return;
    const combined = new Float64Array(quadrics[a]);
    addQuadric(combined, quadrics[b]);
    const { position, error } = optimalPosition(combined, vertices[a], vertices[b]);
    heapPush(heap, { a, b, error, position, versionA: version[a], versionB: version[b] });
  };
  for (const triangle of triangles) {
    for (let side = 0; side < 3; side += 1) {
      const a = triangle[side];
      const b = triangle[(side + 1) % 3];
      if (a < b) pushEdge(a, b);
    }
  }

  let liveTriangles = triangles.length;
  let maxApplied = 0;
  let stoppedOnError = false;
  let iterations = 0;
  const reduceBy = Math.max(1, liveTriangles - target);

  while (liveTriangles > target && heap.length > 0) {
    iterations += 1;
    if (iterations % 256 === 0) {
      if (options.isCancelled?.()) throw new SimplifyError('Simplification was cancelled', 'cancelled');
      options.onProgress?.(Math.min(99, Math.round(((triangles.length - liveTriangles) / reduceBy) * 100)));
    }
    const candidate = heapPop(heap) as Candidate;
    if (removedVertex[candidate.a] || removedVertex[candidate.b]) continue;
    if (candidate.versionA !== version[candidate.a] || candidate.versionB !== version[candidate.b]) continue;
    if (candidate.error >= maxError) {
      stoppedOnError = true;
      break;
    }

    const { a, b, position } = candidate;
    // Refuse a collapse that would flip a surviving face, as upstream does.
    if (wouldFlip(vertices, triangles, removedTriangle, incident, a, b, position)) continue;

    // Collapse b into a.
    vertices[a] = position;
    addQuadric(quadrics[a], quadrics[b]);
    removedVertex[b] = 1;
    version[a] += 1;

    for (const index of incident[b]) {
      if (removedTriangle[index]) continue;
      const triangle = triangles[index];
      for (let side = 0; side < 3; side += 1) if (triangle[side] === b) triangle[side] = a;
      if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[0] === triangle[2]) {
        removedTriangle[index] = 1;
        liveTriangles -= 1;
        continue;
      }
      incident[a].add(index);
    }
    incident[b].clear();
    maxApplied = Math.max(maxApplied, candidate.error);

    // Re-price every edge still touching the merged vertex.
    const neighbours = new Set<number>();
    for (const index of incident[a]) {
      if (removedTriangle[index]) continue;
      for (const vertex of triangles[index]) if (vertex !== a && !removedVertex[vertex]) neighbours.add(vertex);
    }
    for (const neighbour of neighbours) {
      version[neighbour] += 1;
      pushEdge(Math.min(a, neighbour), Math.max(a, neighbour));
    }
  }
  options.onProgress?.(100);

  // Compact, preserving the surviving order so results stay deterministic.
  const remap = new Int32Array(vertices.length).fill(-1);
  const outVertices: Vec3[] = [];
  const outTriangles: [number, number, number][] = [];
  for (const [index, triangle] of triangles.entries()) {
    if (removedTriangle[index]) continue;
    const mapped = triangle.map((vertex) => {
      if (remap[vertex] < 0) {
        remap[vertex] = outVertices.length;
        outVertices.push(vertices[vertex]);
      }
      return remap[vertex];
    }) as [number, number, number];
    outTriangles.push(mapped);
  }
  if (outTriangles.length === 0) {
    throw new SimplifyError('Simplification would remove every facet', 'degenerate-mesh');
  }
  return frozenResult(outVertices, outTriangles, sourceTriangleCount, maxApplied, stoppedOnError);
}

function frozenResult(
  vertices: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
  sourceTriangleCount: number,
  maxAppliedError: number,
  stoppedOnError: boolean,
): SimplifyResult {
  return Object.freeze({
    vertices: Object.freeze(vertices.map((vertex) => Object.freeze([...vertex]) as unknown as Vec3)),
    triangles: Object.freeze(triangles.map((triangle) => Object.freeze([...triangle]) as [number, number, number])),
    sourceTriangleCount,
    maxAppliedError,
    stoppedOnError,
  });
}

function wouldFlip(
  vertices: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
  removedTriangle: Uint8Array,
  incident: readonly Set<number>[],
  a: number,
  b: number,
  position: Vec3,
): boolean {
  for (const vertex of [a, b]) {
    for (const index of incident[vertex]) {
      if (removedTriangle[index]) continue;
      const triangle = triangles[index];
      // A face using both endpoints disappears in the collapse, so it cannot flip.
      if (triangle.includes(a) && triangle.includes(b)) continue;
      const before = faceNormal(vertices, triangle);
      if (!before) continue;
      const moved = triangle.map((corner) => (corner === a || corner === b ? position : vertices[corner])) as [
        Vec3,
        Vec3,
        Vec3,
      ];
      const after = normalOf(moved[0], moved[1], moved[2]);
      if (!after) return true;
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) return true;
    }
  }
  return false;
}

function faceNormal(vertices: readonly Vec3[], triangle: readonly [number, number, number]): Vec3 | undefined {
  return normalOf(vertices[triangle[0]], vertices[triangle[1]], vertices[triangle[2]]);
}

function normalOf(a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const size = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(size) || size === 0) return undefined;
  return [nx / size, ny / size, nz / size];
}

/** Deterministic ordering: lowest error first, then the lower vertex pair. */
function candidateBefore(left: Candidate, right: Candidate): boolean {
  if (left.error !== right.error) return left.error < right.error;
  if (left.a !== right.a) return left.a < right.a;
  return left.b < right.b;
}

function heapPush(heap: Candidate[], candidate: Candidate): void {
  heap.push(candidate);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!candidateBefore(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapPop(heap: Candidate[]): Candidate | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop() as Candidate;
  if (heap.length === 0) return top;
  heap[0] = last;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && candidateBefore(heap[left], heap[smallest])) smallest = left;
    if (right < heap.length && candidateBefore(heap[right], heap[smallest])) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
  return top;
}
