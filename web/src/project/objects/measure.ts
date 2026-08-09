/**
 * Canonical surface-feature measurement (P5.3.1).
 *
 * A port of the pinned `libslic3r/Measure.cpp` at
 * `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`: mesh facets are clustered into
 * planes by identical normals, each plane's border is walked, borders resolve
 * to circles and edges, and any two features measure to a distance and/or an
 * angle. Everything here is UI-free and reads only immutable mesh data, so the
 * same numbers serve the DOM readout, automation, and tests.
 *
 * Two deliberate deviations from the pinned source, both documented rather than
 * hidden:
 *
 * 1. Upstream fits circles with `Geometry::circle_ransac`, which draws samples
 *    from a default-seeded `std::mt19937` through `std::sample`. That ordering
 *    is implementation-defined, so bit-exact replication is not achievable in
 *    another language or even across C++ standard libraries. This port uses an
 *    exact algebraic (Kåsa) least-squares fit over every border point, which is
 *    deterministic and lands on the same circle for a real circular border. The
 *    error metric and the pinned `0.05` acceptance threshold are unchanged.
 * 2. Circle-to-circle distance between circles whose planes are not parallel
 *    needs upstream's degree-8 polynomial root finder. This port reports that
 *    pair as explicitly unsupported instead of approximating it.
 */

import type { FacetSelectionMesh, FacetTriangle } from '../annotations';
import type { Vec3 } from '../domain/model';

export const PINNED_MEASURE_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  measure: 'src/libslic3r/Measure.cpp',
  measureModel: 'src/libslic3r/Measure.hpp',
  circleFit: 'src/libslic3r/Geometry/Circle.cpp',
});

/** Pinned `libslic3r.h` EPSILON, used by `are_parallel`/`are_perpendicular`. */
export const MEASURE_EPSILON = 1e-4;

/** Pinned `is_same_normal` component tolerance in `update_planes`. */
const SAME_NORMAL_TOLERANCE = 0.001;

/** Pinned circle-fit acceptance in `extract_features`. */
const CIRCLE_FIT_MAX_ERROR = 0.05;

/** Pinned `feature_hover_limit`: how close a pick must be to claim a feature. */
export const FEATURE_HOVER_LIMIT_MM = 0.5;

/**
 * Pinned `SurfaceFeatureType` values. The numeric order is load-bearing:
 * `get_measurement` swaps its operands so the lower type is always first.
 */
export const SURFACE_FEATURE_ORDER = Object.freeze({
  point: 1,
  edge: 2,
  circle: 4,
  plane: 8,
});

export type SurfaceFeature =
  | { readonly kind: 'point'; readonly point: Vec3 }
  | { readonly kind: 'edge'; readonly from: Vec3; readonly to: Vec3; readonly extraPoint?: Vec3 }
  | { readonly kind: 'circle'; readonly center: Vec3; readonly normal: Vec3; readonly radius: number }
  | { readonly kind: 'plane'; readonly index: number; readonly normal: Vec3; readonly origin: Vec3 };

export interface DistanceAndPoints {
  readonly distance: number;
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface AngleAndEdges {
  /** Radians. */
  readonly angle: number;
  readonly center: Vec3;
  readonly radius: number;
  readonly coplanar: boolean;
}

export interface MeasurementResult {
  readonly angle?: AngleAndEdges;
  /** Distance to the infinite line/plane the feature lies on. */
  readonly distanceInfinite?: DistanceAndPoints;
  /** Distance to the bounded feature itself. */
  readonly distanceStrict?: DistanceAndPoints;
  /** Axis-aligned component distances, only where upstream provides them. */
  readonly distanceXyz?: Vec3;
  /**
   * Set when the pinned implementation computes a value this port does not.
   * The readout shows the reason instead of a number.
   */
  readonly unsupported?: 'non-parallel-circle-pair';
}

export class MeasureError extends Error {
  constructor(
    message: string,
    readonly code: 'degenerate-mesh' | 'unknown-face' | 'invalid-feature',
  ) {
    super(message);
    this.name = 'MeasureError';
  }
}

// ---------------------------------------------------------------------------
// Vector helpers. Kept local and explicit so the port reads like the source.
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function squaredNorm(a: Vec3): number {
  return dot(a, a);
}

function normalized(a: Vec3): Vec3 {
  const length = norm(a);
  if (!Number.isFinite(length) || length === 0) return [0, 0, 0];
  return [a[0] / length, a[1] / length, a[2] / length];
}

function isApproxVec3(a: Vec3, b: Vec3, tolerance = MEASURE_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance && Math.abs(a[2] - b[2]) < tolerance;
}

function isApprox(a: number, b: number, tolerance = MEASURE_EPSILON): boolean {
  return Math.abs(a - b) < tolerance;
}

/** Pinned `are_parallel`. */
export function areParallel(a: Vec3, b: Vec3): boolean {
  return Math.abs(Math.abs(dot(a, b)) - 1) < MEASURE_EPSILON;
}

/** Pinned `are_perpendicular`. */
export function arePerpendicular(a: Vec3, b: Vec3): boolean {
  return Math.abs(dot(a, b)) < MEASURE_EPSILON;
}

/** Distance from a point to the infinite plane through `origin` with `normal`. */
function planeSignedDistance(normal: Vec3, origin: Vec3, point: Vec3): number {
  return dot(normalized(normal), sub(point, origin));
}

function planeProjection(normal: Vec3, origin: Vec3, point: Vec3): Vec3 {
  const unit = normalized(normal);
  return sub(point, scale(unit, dot(unit, sub(point, origin))));
}

function lineProjection(from: Vec3, direction: Vec3, point: Vec3): Vec3 {
  const unit = normalized(direction);
  return add(from, scale(unit, dot(unit, sub(point, from))));
}

/** Any unit vector orthogonal to `v`; mirrors `get_orthogonal(n, true)`. */
function orthogonalUnit(v: Vec3): Vec3 {
  const axis: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalized(cross(v, axis));
}

// ---------------------------------------------------------------------------
// Measurement — port of `get_measurement`.
// ---------------------------------------------------------------------------

function featureOrder(feature: SurfaceFeature): number {
  return SURFACE_FEATURE_ORDER[feature.kind];
}

/**
 * Port of the pinned `get_measurement`. Operands are swapped so the
 * lower-ordered feature is first, exactly as upstream does, and the resulting
 * from/to points are swapped back at the end.
 */
export function measureSurfaceFeatures(a: SurfaceFeature, b: SurfaceFeature): MeasurementResult {
  const swap = featureOrder(a) > featureOrder(b);
  const f1 = swap ? b : a;
  const f2 = swap ? a : b;
  const result = measureOrdered(f1, f2);
  if (!swap) return Object.freeze(result);
  return Object.freeze({
    ...result,
    ...(result.distanceInfinite ? { distanceInfinite: swapEnds(result.distanceInfinite) } : {}),
    ...(result.distanceStrict ? { distanceStrict: swapEnds(result.distanceStrict) } : {}),
  });
}

function swapEnds(value: DistanceAndPoints): DistanceAndPoints {
  return { distance: value.distance, from: value.to, to: value.from };
}

function measureOrdered(f1: SurfaceFeature, f2: SurfaceFeature): MeasurementResult {
  if (f1.kind === 'point') {
    if (f2.kind === 'point') {
      const diff = sub(f2.point, f1.point);
      return {
        distanceStrict: { distance: norm(diff), from: f1.point, to: f2.point },
        distanceXyz: diff,
      };
    }
    if (f2.kind === 'edge') return pointToEdge(f1.point, f2);
    if (f2.kind === 'circle') return pointToCircle(f1.point, f2);
    return {
      distanceInfinite: {
        distance: Math.abs(planeSignedDistance(f2.normal, f2.origin, f1.point)),
        from: f1.point,
        to: planeProjection(f2.normal, f2.origin, f1.point),
      },
    };
  }

  if (f1.kind === 'edge') {
    if (f2.kind === 'edge') return edgeToEdge(f1, f2);
    if (f2.kind === 'circle') return edgeToCircle(f1, f2);
    if (f2.kind === 'plane') return edgeToPlane(f1, f2);
    throw new MeasureError('Feature pairs are ordered before measuring', 'invalid-feature');
  }

  if (f1.kind === 'circle') {
    if (f2.kind === 'circle') return circleToCircle(f1, f2);
    if (f2.kind === 'plane') return circleToPlane(f1, f2);
    throw new MeasureError('Feature pairs are ordered before measuring', 'invalid-feature');
  }

  // plane / plane
  if (f2.kind !== 'plane') throw new MeasureError('Unordered plane comparison', 'invalid-feature');
  if (areParallel(normalized(f1.normal), normalized(f2.normal))) {
    return {
      distanceInfinite: {
        distance: Math.abs(planeSignedDistance(f2.normal, f2.origin, f1.origin)),
        from: f1.origin,
        to: planeProjection(f2.normal, f2.origin, f1.origin),
      },
    };
  }
  const angle = anglePlanePlane(f1, f2);
  return angle ? { angle } : {};
}

function pointToEdge(point: Vec3, edge: Extract<SurfaceFeature, { kind: 'edge' }>): MeasurementResult {
  const direction = sub(edge.to, edge.from);
  const projection = lineProjection(edge.from, direction, point);
  const distanceInfiniteValue = norm(sub(point, projection));
  const lengthSq = squaredNorm(direction);
  const startSq = squaredNorm(sub(projection, edge.from));
  const endSq = squaredNorm(sub(projection, edge.to));
  const strict: DistanceAndPoints =
    startSq < lengthSq && endSq < lengthSq
      ? { distance: distanceInfiniteValue, from: point, to: projection }
      : {
          distance: Math.sqrt(Math.min(startSq, endSq) + distanceInfiniteValue * distanceInfiniteValue),
          from: point,
          to: startSq < endSq ? edge.from : edge.to,
        };
  return {
    distanceStrict: strict,
    distanceInfinite: { distance: distanceInfiniteValue, from: point, to: projection },
  };
}

function pointToCircle(point: Vec3, circle: Extract<SurfaceFeature, { kind: 'circle' }>): MeasurementResult {
  const projection = planeProjection(circle.normal, circle.center, point);
  if (isApproxVec3(projection, circle.center)) {
    const onCircle = add(circle.center, scale(orthogonalUnit(normalized(circle.normal)), circle.radius));
    return { distanceStrict: { distance: circle.radius, from: circle.center, to: onCircle } };
  }
  const radial = sub(projection, circle.center);
  const distance = Math.sqrt((norm(radial) - circle.radius) ** 2 + squaredNorm(sub(point, projection)));
  const onCircle = add(circle.center, scale(normalized(radial), circle.radius));
  return { distanceStrict: { distance, from: point, to: onCircle } };
}

function edgeToEdge(
  e1: Extract<SurfaceFeature, { kind: 'edge' }>,
  e2: Extract<SurfaceFeature, { kind: 'edge' }>,
): MeasurementResult {
  const candidates: DistanceAndPoints[] = [
    { distance: norm(sub(e2.from, e1.from)), from: e1.from, to: e2.from },
    { distance: norm(sub(e2.to, e1.from)), from: e1.from, to: e2.to },
    { distance: norm(sub(e2.from, e1.to)), from: e1.to, to: e2.from },
    { distance: norm(sub(e2.to, e1.to)), from: e1.to, to: e2.to },
  ];
  // Upstream only accepts a point-to-edge candidate whose foot lies strictly
  // inside the target edge.
  const addPointEdge = (v: Vec3, edge: Extract<SurfaceFeature, { kind: 'edge' }>): void => {
    const strict = pointToEdge(v, edge).distanceStrict;
    if (!strict) return;
    const span = sub(edge.to, edge.from);
    const toFoot = sub(strict.to, edge.from);
    if (dot(toFoot, span) >= 0 && norm(toFoot) < norm(span)) {
      candidates.push({ distance: strict.distance, from: v, to: strict.to });
    }
  };
  addPointEdge(e1.from, e2);
  addPointEdge(e1.to, e2);
  addPointEdge(e2.from, e1);
  addPointEdge(e2.to, e1);

  const nearest = candidates.reduce((best, item) => (item.distance < best.distance ? item : best));
  const angle = angleEdgeEdge(e1, e2);
  return { distanceInfinite: nearest, ...(angle ? { angle } : {}) };
}

function edgeToCircle(
  edge: Extract<SurfaceFeature, { kind: 'edge' }>,
  circle: Extract<SurfaceFeature, { kind: 'circle' }>,
): MeasurementResult {
  const span = sub(edge.to, edge.from);
  const unit = normalized(span);
  const candidates: DistanceAndPoints[] = [];
  const first = pointToCircle(edge.from, circle).distanceStrict;
  const second = pointToCircle(edge.to, circle).distanceStrict;
  if (first) candidates.push(first);
  if (second) candidates.push(second);

  // Where the edge crosses the plane through the circle centre perpendicular to
  // the edge, upstream also considers the intersection point.
  const denominator = dot(unit, unit);
  if (Math.abs(denominator) > 0) {
    const t = dot(unit, sub(circle.center, edge.from)) / denominator;
    const intersection = add(edge.from, scale(unit, t));
    const toIntersection = sub(intersection, edge.from);
    if (dot(toIntersection, span) >= 0 && norm(toIntersection) < norm(span)) {
      const strict = pointToCircle(intersection, circle).distanceStrict;
      if (strict) candidates.push(strict);
    }
  }
  if (candidates.length === 0) return {};
  const nearest = candidates.reduce((best, item) => (item.distance < best.distance ? item : best));
  return { distanceInfinite: nearest };
}

function edgeToPlane(
  edge: Extract<SurfaceFeature, { kind: 'edge' }>,
  plane: Extract<SurfaceFeature, { kind: 'plane' }>,
): MeasurementResult {
  const unit = normalized(sub(edge.to, edge.from));
  const planeNormal = normalized(plane.normal);
  const angle = angleEdgePlane(edge, plane);
  if (!arePerpendicular(unit, planeNormal)) {
    return angle ? { angle } : {};
  }
  const candidates: DistanceAndPoints[] = [
    {
      distance: Math.abs(planeSignedDistance(plane.normal, plane.origin, edge.from)),
      from: edge.from,
      to: planeProjection(plane.normal, plane.origin, edge.from),
    },
    {
      distance: Math.abs(planeSignedDistance(plane.normal, plane.origin, edge.to)),
      from: edge.to,
      to: planeProjection(plane.normal, plane.origin, edge.to),
    },
  ];
  const nearest = candidates.reduce((best, item) => (item.distance < best.distance ? item : best));
  return { distanceInfinite: nearest, ...(angle ? { angle } : {}) };
}

function circleToCircle(
  c1: Extract<SurfaceFeature, { kind: 'circle' }>,
  c2: Extract<SurfaceFeature, { kind: 'circle' }>,
): MeasurementResult {
  const n1 = normalized(c1.normal);
  const n2 = normalized(c2.normal);
  if (!areParallel(n1, n2)) {
    // Upstream solves a degree-8 polynomial here; this port refuses rather than
    // approximating. See the module comment.
    return { unsupported: 'non-parallel-circle-pair' };
  }
  const axisOffset = sub(c2.center, c1.center);
  const along = dot(n1, axisOffset);
  const radial = sub(axisOffset, scale(n1, along));
  const radialLength = norm(radial);
  if (radialLength < MEASURE_EPSILON) {
    // Coaxial: the closest points differ by the radii and the axial offset.
    const direction = orthogonalUnit(n1);
    const from = add(c1.center, scale(direction, c1.radius));
    const to = add(c2.center, scale(direction, c2.radius));
    return { distanceInfinite: { distance: norm(sub(to, from)), from, to } };
  }
  const direction = normalized(radial);
  const from = add(c1.center, scale(direction, c1.radius));
  const to = sub(c2.center, scale(direction, c2.radius));
  return { distanceInfinite: { distance: norm(sub(to, from)), from, to } };
}

function circleToPlane(
  circle: Extract<SurfaceFeature, { kind: 'circle' }>,
  plane: Extract<SurfaceFeature, { kind: 'plane' }>,
): MeasurementResult {
  const circleNormal = normalized(circle.normal);
  const planeNormal = normalized(plane.normal);
  if (!areParallel(circleNormal, planeNormal)) {
    return {
      distanceInfinite: {
        distance: Math.abs(planeSignedDistance(plane.normal, plane.origin, circle.center)),
        from: circle.center,
        to: planeProjection(plane.normal, plane.origin, circle.center),
      },
    };
  }
  const distance = Math.abs(planeSignedDistance(plane.normal, plane.origin, circle.center));
  if (distance < MEASURE_EPSILON) {
    return { distanceStrict: { distance: 0, from: circle.center, to: plane.origin } };
  }
  return {
    distanceInfinite: {
      distance,
      from: circle.center,
      to: planeProjection(plane.normal, plane.origin, circle.center),
    },
  };
}

function angleEdgeEdge(
  e1: Extract<SurfaceFeature, { kind: 'edge' }>,
  e2: Extract<SurfaceFeature, { kind: 'edge' }>,
): AngleAndEdges | undefined {
  const u1 = normalized(sub(e1.to, e1.from));
  const u2 = normalized(sub(e2.to, e2.from));
  if (areParallel(u1, u2)) return undefined;
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.abs(dot(u1, u2)))));
  const center = scale(add(e1.from, e2.from), 0.5);
  const coplanar = Math.abs(dot(normalized(cross(u1, u2)), sub(e2.from, e1.from))) < MEASURE_EPSILON;
  return {
    angle: Math.PI / 2 - angle > 0 ? Math.acos(Math.min(1, Math.max(-1, dot(u1, u2)))) : angle,
    center,
    radius: 0,
    coplanar,
  };
}

function angleEdgePlane(
  edge: Extract<SurfaceFeature, { kind: 'edge' }>,
  plane: Extract<SurfaceFeature, { kind: 'plane' }>,
): AngleAndEdges | undefined {
  const unit = normalized(sub(edge.to, edge.from));
  const planeNormal = normalized(plane.normal);
  if (arePerpendicular(unit, planeNormal)) return undefined;
  // The angle between an edge and a plane is the complement of the angle
  // between the edge and the plane's normal.
  const toNormal = Math.acos(Math.min(1, Math.max(-1, Math.abs(dot(unit, planeNormal)))));
  return { angle: Math.PI / 2 - toNormal, center: edge.from, radius: 0, coplanar: false };
}

function anglePlanePlane(
  p1: Extract<SurfaceFeature, { kind: 'plane' }>,
  p2: Extract<SurfaceFeature, { kind: 'plane' }>,
): AngleAndEdges | undefined {
  const n1 = normalized(p1.normal);
  const n2 = normalized(p2.normal);
  if (areParallel(n1, n2)) return undefined;
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.abs(dot(n1, n2)))));
  return { angle: Math.PI - angle, center: p1.origin, radius: 0, coplanar: false };
}

/**
 * Row-major 4x4 world transform for a picked volume, matching the pinned
 * `world_tran` argument of `Measuring::get_feature`.
 */
export type FeatureWorldTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Move a volume-local feature into world millimetres so two picks on different
 * instances measure in one frame. A circle under a non-uniform scale has no
 * single radius, so it is refused rather than given an averaged one.
 */
export function transformSurfaceFeature(
  feature: SurfaceFeature,
  matrix: FeatureWorldTransform,
): SurfaceFeature | undefined {
  const transformPoint = (p: Vec3): Vec3 => [
    matrix[0] * p[0] + matrix[1] * p[1] + matrix[2] * p[2] + matrix[3],
    matrix[4] * p[0] + matrix[5] * p[1] + matrix[6] * p[2] + matrix[7],
    matrix[8] * p[0] + matrix[9] * p[1] + matrix[10] * p[2] + matrix[11],
  ];
  const transformDirection = (v: Vec3): Vec3 =>
    normalized([
      matrix[0] * v[0] + matrix[1] * v[1] + matrix[2] * v[2],
      matrix[4] * v[0] + matrix[5] * v[1] + matrix[6] * v[2],
      matrix[8] * v[0] + matrix[9] * v[1] + matrix[10] * v[2],
    ]);

  switch (feature.kind) {
    case 'point':
      return { kind: 'point', point: transformPoint(feature.point) };
    case 'edge':
      return {
        kind: 'edge',
        from: transformPoint(feature.from),
        to: transformPoint(feature.to),
        ...(feature.extraPoint ? { extraPoint: transformPoint(feature.extraPoint) } : {}),
      };
    case 'plane':
      return {
        kind: 'plane',
        index: feature.index,
        normal: transformDirection(feature.normal),
        origin: transformPoint(feature.origin),
      };
    case 'circle': {
      const scales = columnScales(matrix);
      if (!isApprox(scales[0], scales[1], MEASURE_EPSILON) || !isApprox(scales[1], scales[2], MEASURE_EPSILON)) {
        // A non-uniformly scaled circle is an ellipse; there is no radius to report.
        return undefined;
      }
      return {
        kind: 'circle',
        center: transformPoint(feature.center),
        normal: transformDirection(feature.normal),
        radius: feature.radius * scales[0],
      };
    }
  }
}

function columnScales(matrix: FeatureWorldTransform): Vec3 {
  return [
    Math.hypot(matrix[0], matrix[4], matrix[8]),
    Math.hypot(matrix[1], matrix[5], matrix[9]),
    Math.hypot(matrix[2], matrix[6], matrix[10]),
  ];
}

/** One-line readout label; never invents a value the feature does not carry. */
export function describeSurfaceFeature(feature: SurfaceFeature): string {
  const mm = (value: number): string => `${Number(value.toFixed(3))}`;
  switch (feature.kind) {
    case 'point':
      return `point (${feature.point.map(mm).join(', ')}) mm`;
    case 'edge':
      return `edge ${mm(Math.hypot(...sub(feature.to, feature.from)))} mm long`;
    case 'circle':
      return `circle ⌀${mm(feature.radius * 2)} mm`;
    case 'plane':
      return `plane facing (${feature.normal.map((value) => Number(value.toFixed(3))).join(', ')})`;
  }
}

// ---------------------------------------------------------------------------
// Feature extraction — port of `MeasuringImpl`.
// ---------------------------------------------------------------------------

interface PlaneData {
  readonly facets: number[];
  normal: Vec3;
  borders: Vec3[][];
  features?: SurfaceFeature[];
}

/**
 * Builds the pinned plane/border/feature decomposition once per mesh and picks
 * the feature nearest a ray hit, exactly as `Measuring::get_feature` does.
 */
export class SurfaceFeatureExtractor {
  private readonly faceToPlane: Int32Array;
  private readonly planes: PlaneData[] = [];
  private readonly faceNormals: Vec3[];
  private readonly neighbours: Int32Array;

  constructor(private readonly mesh: FacetSelectionMesh) {
    if (mesh.triangles.length === 0) {
      throw new MeasureError('A mesh with no facets has nothing to measure', 'degenerate-mesh');
    }
    this.faceNormals = mesh.triangles.map((triangle) => faceNormal(mesh, triangle));
    this.neighbours = buildFaceNeighbours(mesh);
    this.faceToPlane = new Int32Array(mesh.triangles.length).fill(-1);
    this.buildPlanes();
  }

  get planeCount(): number {
    return this.planes.length;
  }

  /** Facet indices of one detected plane, ascending, as upstream stores them. */
  planeFacets(index: number): readonly number[] {
    const plane = this.planes[index];
    if (!plane) throw new MeasureError(`Plane ${index} does not exist`, 'invalid-feature');
    return plane.facets;
  }

  planeFeatures(index: number): readonly SurfaceFeature[] {
    const plane = this.planes[index];
    if (!plane) throw new MeasureError(`Plane ${index} does not exist`, 'invalid-feature');
    return this.extractFeatures(index);
  }

  /**
   * Pinned `get_feature`: the closest feature within `feature_hover_limit`, an
   * edge endpoint when the pick is near one, otherwise the plane itself.
   */
  featureAt(faceIndex: number, point: Vec3, options: { onlyPlane?: boolean } = {}): SurfaceFeature {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= this.faceToPlane.length) {
      throw new MeasureError(`Face ${faceIndex} is not in this mesh`, 'unknown-face');
    }
    const planeIndex = this.faceToPlane[faceIndex];
    const features = this.extractFeatures(planeIndex);
    const planeFeature = features[features.length - 1];

    if (!options.onlyPlane) {
      let closest: SurfaceFeature | undefined;
      let minimum = Number.POSITIVE_INFINITY;
      // The last entry is the plane itself; upstream skips it here.
      for (let index = 0; index < features.length - 1; index += 1) {
        const strict = measureSurfaceFeatures(features[index], { kind: 'point', point }).distanceStrict;
        if (!strict) continue;
        if (strict.distance < FEATURE_HOVER_LIMIT_MM && strict.distance < minimum) {
          minimum = strict.distance;
          closest = features[index];
        }
      }
      if (closest) {
        if (closest.kind === 'edge') {
          const lengthSq = squaredNorm(sub(closest.to, closest.from));
          const limitSq = Math.max(0.025 * 0.025, Math.min(0.5 * 0.5, 0.01 * lengthSq));
          if (squaredNorm(sub(point, closest.from)) < limitSq) return { kind: 'point', point: closest.from };
          if (squaredNorm(sub(point, closest.to)) < limitSq) return { kind: 'point', point: closest.to };
        }
        return closest;
      }
    }
    return planeFeature;
  }

  /**
   * Pinned `update_planes`: cluster by identical normal, then walk borders.
   * A neighbour is queued but *not* claimed; it is only claimed when it is
   * popped and its normal still matches the seed, so a differently-oriented
   * neighbour stays free to seed its own plane. Claiming at push time instead
   * would swallow the whole mesh into one plane.
   */
  private buildPlanes(): void {
    const faceCount = this.mesh.triangles.length;
    for (let seed = 0; seed < faceCount; seed += 1) {
      if (this.faceToPlane[seed] !== -1) continue;
      const planeIndex = this.planes.length;
      const seedNormal = this.faceNormals[seed];
      const plane: PlaneData = { facets: [], normal: seedNormal, borders: [] };
      this.planes.push(plane);
      const queue: number[] = [seed];
      const queued = new Set<number>([seed]);
      while (queue.length > 0) {
        const face = queue.pop() as number;
        if (this.faceToPlane[face] !== -1) continue;
        if (!isSameNormal(this.faceNormals[face], seedNormal)) continue;
        this.faceToPlane[face] = planeIndex;
        plane.facets.push(face);
        for (let side = 0; side < 3; side += 1) {
          const neighbour = this.neighbours[face * 3 + side];
          if (neighbour >= 0 && this.faceToPlane[neighbour] === -1 && !queued.has(neighbour)) {
            queued.add(neighbour);
            queue.push(neighbour);
          }
        }
      }
      plane.facets.sort((left, right) => left - right);
    }
    for (let index = 0; index < this.planes.length; index += 1) {
      this.planes[index].borders = this.walkBorders(index);
    }
  }

  /**
   * Walk each plane's boundary loops. Upstream uses a half-edge mesh; the same
   * traversal here follows boundary half-edges by (face, side) and gives up on
   * a broken plane exactly as upstream's `PLANE_FAILURE` does.
   */
  private walkBorders(planeIndex: number): Vec3[][] {
    const plane = this.planes[planeIndex];
    const inPlane = new Set(plane.facets);
    // Directed boundary half-edges, keyed by their source vertex.
    const outgoing = new Map<number, { source: number; target: number }[]>();
    for (const face of plane.facets) {
      const triangle = this.mesh.triangles[face];
      for (let side = 0; side < 3; side += 1) {
        const neighbour = this.neighbours[face * 3 + side];
        if (neighbour >= 0 && inPlane.has(neighbour)) continue;
        const source = triangle[side];
        const target = triangle[(side + 1) % 3];
        const list = outgoing.get(source);
        if (list) list.push({ source, target });
        else outgoing.set(source, [{ source, target }]);
      }
    }

    const borders: Vec3[][] = [];
    const visited = new Set<string>();
    for (const [start, edges] of outgoing) {
      for (const edge of edges) {
        const key = `${edge.source}:${edge.target}`;
        if (visited.has(key)) continue;
        const loop: number[] = [];
        let current = edge;
        let guard = 0;
        while (guard <= plane.facets.length * 3 + 1) {
          guard += 1;
          const currentKey = `${current.source}:${current.target}`;
          if (visited.has(currentKey)) break;
          visited.add(currentKey);
          loop.push(current.source);
          const next = outgoing
            .get(current.target)
            ?.find((candidate) => !visited.has(`${candidate.source}:${candidate.target}`));
          if (!next) {
            // Closed the loop when the next hop is the edge we started from.
            if (current.target === start) break;
            loop.length = 0;
            break;
          }
          current = next;
        }
        if (loop.length > 1) borders.push(loop.map((vertex) => this.mesh.vertices[vertex]));
      }
    }
    return borders;
  }

  /** Pinned `extract_features`, with a deterministic circle fit. */
  private extractFeatures(planeIndex: number): SurfaceFeature[] {
    const plane = this.planes[planeIndex];
    if (plane.features) return plane.features;
    const features: SurfaceFeature[] = [];
    const normal = normalized(plane.normal);

    for (const border of plane.borders) {
      if (border.length <= 1) continue;
      let done = false;
      if (border.length > 4) {
        const fit = fitCircle(border, normal);
        if (fit && fit.error < CIRCLE_FIT_MAX_ERROR) {
          const isPolygon = border.length > 4 && border.length <= 8;
          const lengthsMatch = border.every((point, index) => {
            if (index < 2) return true;
            const a = squaredNorm(sub(point, border[index - 1]));
            const b = squaredNorm(sub(border[index - 1], border[index - 2]));
            return isApprox(a, b, 0.01);
          });
          if (lengthsMatch && (isPolygon || border.length > 8)) {
            if (isPolygon) {
              for (let index = 0; index < border.length; index += 1) {
                features.push({
                  kind: 'edge',
                  from: border[index === 0 ? border.length - 1 : index - 1],
                  to: border[index],
                  extraPoint: fit.center,
                });
              }
            } else {
              features.push({ kind: 'circle', center: fit.center, normal: plane.normal, radius: fit.radius });
            }
            done = true;
          }
        }
      }
      if (!done) {
        for (let index = 1; index < border.length; index += 1) {
          features.push({ kind: 'edge', from: border[index - 1], to: border[index] });
        }
        features.push({ kind: 'edge', from: border[0], to: border[border.length - 1] });
      }
    }

    // The last feature is always the plane itself, exactly as upstream stores it.
    let centre: Vec3 = [0, 0, 0];
    let count = 0;
    for (const border of plane.borders) {
      for (const point of border) {
        centre = add(centre, point);
        count += 1;
      }
    }
    const origin = count > 0 ? scale(centre, 1 / count) : centroidOfPlane(this.mesh, plane.facets);
    features.push({ kind: 'plane', index: planeIndex, normal: plane.normal, origin });
    plane.features = features;
    return features;
  }
}

function centroidOfPlane(mesh: FacetSelectionMesh, facets: readonly number[]): Vec3 {
  let sum: Vec3 = [0, 0, 0];
  let count = 0;
  for (const face of facets) {
    for (const vertex of mesh.triangles[face]) {
      sum = add(sum, mesh.vertices[vertex]);
      count += 1;
    }
  }
  return count === 0 ? [0, 0, 0] : scale(sum, 1 / count);
}

function faceNormal(mesh: FacetSelectionMesh, triangle: FacetTriangle): Vec3 {
  const a = mesh.vertices[triangle[0]];
  const b = mesh.vertices[triangle[1]];
  const c = mesh.vertices[triangle[2]];
  return normalized(cross(sub(b, a), sub(c, a)));
}

function isSameNormal(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a[0] - b[0]) < SAME_NORMAL_TOLERANCE &&
    Math.abs(a[1] - b[1]) < SAME_NORMAL_TOLERANCE &&
    Math.abs(a[2] - b[2]) < SAME_NORMAL_TOLERANCE
  );
}

/** Flat `face * 3 + side` neighbour table; -1 marks an open edge. */
function buildFaceNeighbours(mesh: FacetSelectionMesh): Int32Array {
  const neighbours = new Int32Array(mesh.triangles.length * 3).fill(-1);
  const byEdge = new Map<string, { face: number; side: number }[]>();
  for (const [face, triangle] of mesh.triangles.entries()) {
    for (let side = 0; side < 3; side += 1) {
      const a = triangle[side];
      const b = triangle[(side + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const list = byEdge.get(key);
      if (list) list.push({ face, side });
      else byEdge.set(key, [{ face, side }]);
    }
  }
  for (const entries of byEdge.values()) {
    // Only manifold edges get a neighbour; upstream treats the rest as open.
    if (entries.length !== 2) continue;
    neighbours[entries[0].face * 3 + entries[0].side] = entries[1].face;
    neighbours[entries[1].face * 3 + entries[1].side] = entries[0].face;
  }
  return neighbours;
}

/**
 * Deterministic algebraic (Kåsa) circle fit in the plane's own frame, plus the
 * pinned maximum-radial-deviation error metric.
 */
function fitCircle(points: readonly Vec3[], normal: Vec3): { center: Vec3; radius: number; error: number } | undefined {
  if (points.length < 3) return undefined;
  const unit = normalized(normal);
  const u = orthogonalUnit(unit);
  const v = cross(unit, u);
  const origin = points[0];
  const planar = points.map((point) => {
    const local = sub(point, origin);
    return { x: dot(local, u), y: dot(local, v) };
  });

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let sumXR = 0;
  let sumYR = 0;
  let sumR = 0;
  for (const { x, y } of planar) {
    const r = x * x + y * y;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    sumXR += x * r;
    sumYR += y * r;
    sumR += r;
  }
  const n = planar.length;
  const a11 = 2 * (sumXX - (sumX * sumX) / n);
  const a12 = 2 * (sumXY - (sumX * sumY) / n);
  const a22 = 2 * (sumYY - (sumY * sumY) / n);
  const b1 = sumXR - (sumX * sumR) / n;
  const b2 = sumYR - (sumY * sumR) / n;
  const determinant = a11 * a22 - a12 * a12;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  const cx = (b1 * a22 - b2 * a12) / determinant;
  const cy = (a11 * b2 - a12 * b1) / determinant;

  let radius = 0;
  for (const { x, y } of planar) radius += Math.hypot(x - cx, y - cy);
  radius /= n;
  let error = 0;
  for (const { x, y } of planar) error = Math.max(error, Math.abs(Math.hypot(x - cx, y - cy) - radius));
  if (!Number.isFinite(radius) || radius <= 0) return undefined;

  const center = add(origin, add(scale(u, cx), scale(v, cy)));
  return { center, radius, error };
}
