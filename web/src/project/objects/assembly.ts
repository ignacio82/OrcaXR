/**
 * Canonical assembly alignment and explosion (P5.3.2).
 *
 * A port of the pinned assembly half of `GLGizmoMeasure`/`GLGizmoAssembly` at
 * `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`, plus `Measure::get_assembly_action`.
 * Every alignment here is a pure function from two picked surface features to a
 * canonical instance-transform delta, so the caller commits it through the same
 * guarded transform command a drag uses and it undoes as one entry.
 *
 * Explosion is deliberately *not* an alignment: upstream draws an exploded view
 * without moving anything, so `projectExplosion` returns view-only offsets and
 * has no canonical effect at all.
 */

import type { Quaternion, Transform, Vec3 } from '../domain/model';
import type { SurfaceFeature } from './measure';
import { multiplyQuaternions, quaternionBetween, rotateVector } from './transformOperations';

export const PINNED_ASSEMBLY_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  availability: 'src/libslic3r/Measure.cpp',
  transforms: 'src/slic3r/GUI/Gizmos/GLGizmoMeasure.cpp',
  gizmo: 'src/slic3r/GUI/Gizmos/GLGizmoAssembly.cpp',
});

/**
 * Pinned guard in `set_to_parallel`: a pair already within this of the target
 * alignment is left alone rather than nudged by a rounding-sized rotation.
 */
export const ASSEMBLY_ALIGNMENT_EPSILON = 1e-3;

export type AssemblyAlignmentKind =
  'parallel' | 'center-coincidence' | 'parallel-distance' | 'reverse-rotation' | 'around-face-center';

/** Port of `Measure::get_assembly_action`; only plane pairs are actionable. */
export interface AssemblyAvailability {
  readonly canSetToParallel: boolean;
  readonly canSetToCenterCoincidence: boolean;
  readonly canReverseFeature1: boolean;
  readonly canReverseFeature2: boolean;
  readonly canRotateAroundFaceCenter: boolean;
  readonly hasParallelDistance: boolean;
  /** Signed distance along feature 1's normal; only when the planes are parallel. */
  readonly parallelDistanceMm: number;
  /** Radians between the planes; zero when they are already parallel. */
  readonly angleRadians: number;
}

const NOTHING_AVAILABLE: AssemblyAvailability = Object.freeze({
  canSetToParallel: false,
  canSetToCenterCoincidence: false,
  canReverseFeature1: false,
  canReverseFeature2: false,
  canRotateAroundFaceCenter: false,
  hasParallelDistance: false,
  parallelDistanceMm: 0,
  angleRadians: 0,
});

export class AssemblyError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported-feature-pair' | 'unavailable-action' | 'invalid-parameter' | 'degenerate-axis',
  ) {
    super(message);
    this.name = 'AssemblyError';
  }
}

/**
 * Which alignments the pinned gizmo offers for this pair. Upstream enables the
 * whole set only for two planes; anything else offers nothing, and this port
 * says so rather than inventing an approximation for edges or circles.
 */
export function inspectAssemblyActions(first: SurfaceFeature, second: SurfaceFeature): AssemblyAvailability {
  if (first.kind !== 'plane') return NOTHING_AVAILABLE;
  if (second.kind !== 'plane') {
    // Upstream still allows reversing feature 1 once it is a plane.
    return Object.freeze({ ...NOTHING_AVAILABLE, canReverseFeature1: true });
  }
  const n1 = unit(first.normal);
  const n2 = unit(second.normal);
  if (areParallel(n1, n2)) {
    const projected = projectPointToPlane(second.origin, first.origin, n1);
    const offset = subtract(second.origin, projected);
    const magnitude = length(offset);
    return Object.freeze({
      canSetToParallel: false,
      canSetToCenterCoincidence: true,
      canReverseFeature1: true,
      canReverseFeature2: true,
      canRotateAroundFaceCenter: true,
      hasParallelDistance: true,
      parallelDistanceMm: dot(offset, n1) < 0 ? -magnitude : magnitude,
      angleRadians: 0,
    });
  }
  return Object.freeze({
    canSetToParallel: true,
    canSetToCenterCoincidence: true,
    canReverseFeature1: true,
    canReverseFeature2: true,
    canRotateAroundFaceCenter: false,
    hasParallelDistance: false,
    parallelDistanceMm: 0,
    angleRadians: Math.acos(clamp(dot(n2, negate(n1)), -1, 1)),
  });
}

export interface AssemblyAlignmentRequest {
  readonly kind: AssemblyAlignmentKind;
  /** Feature picked first; it stays put for every alignment except a reverse of itself. */
  readonly first: SurfaceFeature;
  readonly second: SurfaceFeature;
  /** World transform of the instance the moving feature belongs to. */
  readonly movingTransform: Transform;
  /** Required by `parallel-distance` (mm) and `around-face-center` (degrees). */
  readonly parameter?: number;
  /** `reverse-rotation` only: which picked feature's own instance turns over. */
  readonly reverseFeature?: 1 | 2;
}

export interface AssemblyAlignmentPlan {
  readonly kind: AssemblyAlignmentKind;
  /** Transform to commit for the moving instance. */
  readonly transform: Transform;
  /** True when the pair already satisfies the alignment, so nothing moves. */
  readonly noop: boolean;
}

/**
 * Compute the canonical transform an alignment produces. Nothing is mutated;
 * the caller decides whether to commit, so cancel is free.
 */
export function planAssemblyAlignment(request: AssemblyAlignmentRequest): AssemblyAlignmentPlan {
  const availability = inspectAssemblyActions(request.first, request.second);
  const { first, second } = request;
  if (first.kind !== 'plane') {
    throw new AssemblyError('Assembly alignment needs a plane as the first feature', 'unsupported-feature-pair');
  }

  switch (request.kind) {
    case 'parallel':
      if (!availability.canSetToParallel) {
        throw new AssemblyError('These planes are already parallel', 'unavailable-action');
      }
      return alignNormals(request, first, requirePlane(second), false);

    case 'center-coincidence': {
      if (!availability.canSetToCenterCoincidence) {
        throw new AssemblyError('Centre coincidence needs two picked planes', 'unavailable-action');
      }
      // Upstream turns the faces to anti-parallel first, then closes the gap.
      const rotated = alignNormals(request, first, requirePlane(second), true);
      const movedOrigin = applyDelta(requirePlane(second).origin, request.movingTransform, rotated.transform);
      const displacement = subtract(first.origin, movedOrigin);
      return Object.freeze({
        kind: request.kind,
        transform: translate(rotated.transform, displacement),
        noop: rotated.noop && length(displacement) <= ASSEMBLY_ALIGNMENT_EPSILON,
      });
    }

    case 'parallel-distance': {
      if (!availability.hasParallelDistance) {
        throw new AssemblyError('A parallel distance needs two parallel planes', 'unavailable-action');
      }
      const distance = request.parameter;
      if (distance === undefined || !Number.isFinite(distance)) {
        throw new AssemblyError('A parallel distance must be a finite number of millimetres', 'invalid-parameter');
      }
      const plane2 = requirePlane(second);
      const normal1 = unit(first.normal);
      const projected = projectPointToPlane(plane2.origin, first.origin, normal1);
      const target = add(projected, multiply(normal1, distance));
      const displacement = subtract(target, plane2.origin);
      return Object.freeze({
        kind: request.kind,
        transform: translate(request.movingTransform, displacement),
        noop: length(displacement) <= ASSEMBLY_ALIGNMENT_EPSILON,
      });
    }

    case 'reverse-rotation': {
      const which = request.reverseFeature ?? 2;
      const target = which === 1 ? first : requirePlane(second);
      // Pinned: a half turn about any in-plane axis through the face centre.
      const axis = inPlaneAxis(unit(target.normal));
      if (length(axis) < 0.1) {
        throw new AssemblyError('This plane has no usable in-plane axis to turn about', 'degenerate-axis');
      }
      return Object.freeze({
        kind: request.kind,
        transform: rotateAboutPoint(request.movingTransform, target.origin, axis, Math.PI),
        noop: false,
      });
    }

    case 'around-face-center': {
      if (!availability.canRotateAroundFaceCenter) {
        throw new AssemblyError('Rotating around the face centre needs two parallel planes', 'unavailable-action');
      }
      const degrees = request.parameter;
      if (degrees === undefined || !Number.isFinite(degrees)) {
        throw new AssemblyError('A face-centre rotation must be a finite number of degrees', 'invalid-parameter');
      }
      const plane2 = requirePlane(second);
      const radians = (degrees * Math.PI) / 180;
      return Object.freeze({
        kind: request.kind,
        transform: rotateAboutPoint(request.movingTransform, plane2.origin, unit(plane2.normal), radians),
        noop: Math.abs(Math.sin(radians / 2)) <= ASSEMBLY_ALIGNMENT_EPSILON,
      });
    }
  }
}

function alignNormals(
  request: AssemblyAlignmentRequest,
  first: Extract<SurfaceFeature, { kind: 'plane' }>,
  second: Extract<SurfaceFeature, { kind: 'plane' }>,
  antiParallel: boolean,
): AssemblyAlignmentPlan {
  const n1 = unit(first.normal);
  const n2 = unit(second.normal);
  const alignment = dot(n1, n2);
  // Pinned `set_to_parallel`: the target is always -normal1. The
  // `is_anti_parallel` flag changes only the guard — anti-parallel skips a pair
  // that already faces, plain parallel skips a pair that already points the
  // same way — so both land on the same rotation when they do act.
  const already = antiParallel
    ? alignment <= -1 + ASSEMBLY_ALIGNMENT_EPSILON
    : alignment >= 1 - ASSEMBLY_ALIGNMENT_EPSILON;
  if (already) {
    return Object.freeze({ kind: request.kind, transform: request.movingTransform, noop: true });
  }
  const delta = quaternionBetween(n2, negate(n1));
  return Object.freeze({
    kind: request.kind,
    transform: Object.freeze({
      translationMm: request.movingTransform.translationMm,
      rotation: multiplyQuaternions(delta, request.movingTransform.rotation),
      scale: request.movingTransform.scale,
    }),
    noop: false,
  });
}

/** Rotate an instance about a world axis through a world point. */
function rotateAboutPoint(transform: Transform, pivot: Vec3, axis: Vec3, radians: number): Transform {
  const half = radians / 2;
  const sin = Math.sin(half);
  const delta: Quaternion = [axis[0] * sin, axis[1] * sin, axis[2] * sin, Math.cos(half)] as unknown as Quaternion;
  const offset = subtract(transform.translationMm, pivot);
  const rotated = rotateVector(offset, delta);
  return Object.freeze({
    translationMm: add(pivot, rotated),
    rotation: multiplyQuaternions(delta, transform.rotation),
    scale: transform.scale,
  });
}

/**
 * Where a world point attached to `before` ends up under `after`. Both share a
 * scale, so only the rotation difference and the translation matter.
 */
function applyDelta(point: Vec3, before: Transform, after: Transform): Vec3 {
  const local = rotateVector(subtract(point, before.translationMm), conjugate(before.rotation));
  return add(after.translationMm, rotateVector(local, after.rotation));
}

function translate(transform: Transform, displacement: Vec3): Transform {
  return Object.freeze({
    translationMm: add(transform.translationMm, displacement),
    rotation: transform.rotation,
    scale: transform.scale,
  });
}

export interface ExplosionInput {
  readonly id: string;
  /** World centre of the part, used only to pick an outward direction. */
  readonly centerMm: Vec3;
}

export interface ExplosionOffset {
  readonly id: string;
  readonly offsetMm: Vec3;
}

/**
 * View-only exploded layout. Upstream's assembly view never moves canonical
 * geometry, so this returns offsets a renderer applies and nothing else; a
 * factor of 1 leaves every part exactly where it is.
 */
export function projectExplosion(parts: readonly ExplosionInput[], factor: number): readonly ExplosionOffset[] {
  if (!Number.isFinite(factor) || factor < 1) {
    throw new AssemblyError('An explosion factor must be a finite number of at least 1', 'invalid-parameter');
  }
  if (parts.length === 0) return Object.freeze([]);
  let centroid: Vec3 = [0, 0, 0];
  for (const part of parts) centroid = add(centroid, part.centerMm);
  centroid = multiply(centroid, 1 / parts.length);
  return Object.freeze(
    parts.map((part) => {
      const offset = multiply(subtract(part.centerMm, centroid), factor - 1);
      return Object.freeze({
        id: part.id,
        // Normalised away from `-0`. Multiplying a negative distance by zero at
        // factor 1 yields `-0`, which is numerically zero but not `Object.is`
        // zero — so a caller checking "is this assembled" with a strict or
        // deep equality would be told the parts had moved when they had not.
        offsetMm: offset.map((value) => (value === 0 ? 0 : value)) as unknown as Vec3,
      });
    }),
  );
}

// ---------------------------------------------------------------------------

function requirePlane(feature: SurfaceFeature): Extract<SurfaceFeature, { kind: 'plane' }> {
  if (feature.kind !== 'plane') {
    throw new AssemblyError('This alignment needs a plane as the second feature', 'unsupported-feature-pair');
  }
  return feature;
}

/** Pinned `get_one_point_in_plane` direction, reduced to the axis it yields. */
function inPlaneAxis(normal: Vec3): Vec3 {
  const direction: Vec3 = Math.abs(dot(normal, [1, 0, 0])) > 1 - 1e-3 ? [0, 1, 0] : [1, 0, 0];
  return unit(subtract(direction, multiply(normal, dot(direction, normal))));
}

function areParallel(a: Vec3, b: Vec3): boolean {
  return Math.abs(Math.abs(dot(a, b)) - 1) < 1e-4;
}

function projectPointToPlane(point: Vec3, origin: Vec3, normal: Vec3): Vec3 {
  return subtract(point, multiply(normal, dot(subtract(point, origin), normal)));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function multiply(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function unit(a: Vec3): Vec3 {
  const size = length(a);
  if (!Number.isFinite(size) || size === 0) {
    throw new AssemblyError('A plane normal must be non-zero', 'degenerate-axis');
  }
  return [a[0] / size, a[1] / size, a[2] / size];
}

function conjugate(quaternion: Quaternion): Quaternion {
  return [-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]] as unknown as Quaternion;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
