/**
 * Automatic brim-ear placement (parity P5.3.6).
 *
 * The pinned gizmo places ears without being told where: it takes the object's
 * first-layer outline, finds the corners sharp enough to peel, and drops an ear
 * on each one, thinning them so two ears never land on top of each other.
 *
 * Three decisions shape this port.
 *
 * The outline comes from the mesh, not from a bounding box. An ear exists to
 * hold down a *corner*, so the shape that matters is the footprint the first
 * layer actually prints — a plus-shaped part has eight outward corners and a
 * box has four, and a bounding box would say four for both.
 *
 * Only outward corners qualify. An inward corner of a concave outline is
 * material on both sides; it does not peel, and an ear there wastes plastic and
 * is harder to remove than the part. The turn direction against the outline's
 * own winding is what separates the two.
 *
 * A corner the mesh reports twice is one corner. Tessellation, coplanar
 * triangles, and numerical noise all produce near-duplicate outline vertices,
 * so detected points are thinned by `detectionRadiusMm` — keeping the sharper
 * of any two that collide, because that is the one more likely to lift.
 */

import type { BrimEarPoint, Vec3 } from '../domain/model';

export interface BrimEarDetectionOptions {
  /**
   * Maximum interior angle, in degrees, that still counts as a corner. The
   * pinned default is 125°: a right angle peels, a gentle curve does not.
   */
  readonly maxAngleDeg: number;
  /** Ears closer together than this are thinned to one. */
  readonly detectionRadiusMm: number;
  /** Radius written onto each placed ear. */
  readonly headFrontRadiusMm: number;
  /** Height above the object's base to sample the outline at. */
  readonly sampleHeightMm?: number;
}

export const DEFAULT_BRIM_EAR_DETECTION: BrimEarDetectionOptions = Object.freeze({
  maxAngleDeg: 125,
  detectionRadiusMm: 1,
  headFrontRadiusMm: 5,
  sampleHeightMm: 0.2,
});

export interface DetectedBrimEar {
  readonly point: BrimEarPoint;
  /** Interior angle at the corner, in degrees; smaller is sharper. */
  readonly angleDeg: number;
}

export interface BrimEarDetectionResult {
  readonly ears: readonly DetectedBrimEar[];
  /** Why nothing was placed, when nothing was. */
  readonly reason?: string;
}

/** A closed 2-D outline in object-local millimetres, in XY. */
export type OutlinePolygon = readonly (readonly [number, number])[];

/**
 * Cut the mesh with a horizontal plane and assemble the closed loops.
 *
 * Only the loops matter, not their triangulation, so this walks the segments
 * each crossed triangle contributes and chains them end to end. Segments are
 * keyed on rounded endpoints because two triangles sharing an edge produce the
 * same point through different arithmetic.
 */
export function sliceMeshOutline(
  positions: Float32Array | readonly number[],
  indices: Uint32Array | readonly number[] | undefined,
  z: number,
): readonly OutlinePolygon[] {
  const triangleCount = indices ? indices.length / 3 : positions.length / 9;
  const segments: [readonly [number, number], readonly [number, number]][] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const corner = (slot: number): readonly [number, number, number] => {
      const index = indices ? Number(indices[triangle * 3 + slot]) : triangle * 3 + slot;
      return [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
    };
    const crossing: [number, number][] = [];
    const vertices = [corner(0), corner(1), corner(2)];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = vertices[edge];
      const b = vertices[(edge + 1) % 3];
      // A vertex exactly on the plane is counted once, through the edge that
      // leaves it, so a shared vertex does not produce a duplicate crossing.
      if ((a[2] < z && b[2] >= z) || (b[2] < z && a[2] >= z)) {
        const t = (z - a[2]) / (b[2] - a[2]);
        crossing.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (crossing.length === 2) segments.push([crossing[0], crossing[1]]);
  }
  return chainSegments(segments);
}

const KEY_SCALE = 1e4;
function key(point: readonly [number, number]): string {
  return `${Math.round(point[0] * KEY_SCALE)},${Math.round(point[1] * KEY_SCALE)}`;
}

function chainSegments(
  segments: readonly [readonly [number, number], readonly [number, number]][],
): readonly OutlinePolygon[] {
  const byStart = new Map<string, [readonly [number, number], readonly [number, number]][]>();
  for (const segment of segments) {
    const bucket = byStart.get(key(segment[0])) ?? [];
    bucket.push(segment);
    byStart.set(key(segment[0]), bucket);
  }
  const used = new Set<[readonly [number, number], readonly [number, number]]>();
  const loops: OutlinePolygon[] = [];
  for (const segment of segments) {
    if (used.has(segment)) continue;
    const loop: (readonly [number, number])[] = [segment[0]];
    let current = segment;
    used.add(current);
    for (let guard = 0; guard < segments.length + 1; guard += 1) {
      loop.push(current[1]);
      const next = (byStart.get(key(current[1])) ?? []).find((candidate) => !used.has(candidate));
      if (!next) break;
      used.add(next);
      current = next;
      if (key(current[1]) === key(loop[0])) break;
    }
    // Two points cannot enclose anything; a stray chain is dropped rather than
    // reported as an outline.
    if (loop.length < 4) continue;
    const closed = dropCollinear(loop.slice(0, -1));
    if (closed.length >= 3) loops.push(Object.freeze(closed));
  }
  return Object.freeze(loops);
}

/**
 * Drop points that lie on the straight run between their neighbours.
 *
 * A quad wall is two triangles, so cutting it yields two collinear segments and
 * a midpoint that is an artefact of the tessellation rather than a feature of
 * the shape. A caller asking for an outline wants the shape.
 */
function dropCollinear(loop: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const kept: (readonly [number, number])[] = [];
  for (let index = 0; index < loop.length; index += 1) {
    const previous = loop[(index - 1 + loop.length) % loop.length];
    const current = loop[index];
    const next = loop[(index + 1) % loop.length];
    const cross =
      (current[0] - previous[0]) * (next[1] - current[1]) - (current[1] - previous[1]) * (next[0] - current[0]);
    const scale = Math.max(1, Math.hypot(next[0] - previous[0], next[1] - previous[1]));
    if (Math.abs(cross) <= 1e-9 * scale) continue;
    kept.push(current);
  }
  return kept.length >= 3 ? kept : [...loop];
}

/** Twice the signed area; positive is counter-clockwise. */
export function signedArea(polygon: OutlinePolygon): number {
  let total = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total / 2;
}

/**
 * Corners of one outline that are sharp enough, and turn outward, to peel.
 *
 * The interior angle is measured between the two edges meeting at the vertex;
 * the cross product against the polygon's winding says whether that angle is
 * inside the material or outside it.
 */
export function detectOutlineCorners(
  polygon: OutlinePolygon,
  maxAngleDeg: number,
): readonly { readonly point: readonly [number, number]; readonly angleDeg: number }[] {
  if (polygon.length < 3) return Object.freeze([]);
  const winding = Math.sign(signedArea(polygon)) || 1;
  const corners: { point: readonly [number, number]; angleDeg: number }[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const incoming: [number, number] = [current[0] - previous[0], current[1] - previous[1]];
    const outgoing: [number, number] = [next[0] - current[0], next[1] - current[1]];
    const incomingLength = Math.hypot(incoming[0], incoming[1]);
    const outgoingLength = Math.hypot(outgoing[0], outgoing[1]);
    if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue;

    const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    // A left turn on a counter-clockwise outline is convex; on a clockwise one
    // the sense flips, so the winding decides rather than the sign alone.
    if (cross * winding <= 0) continue;

    const dot = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (incomingLength * outgoingLength);
    const turnDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    const interiorDeg = 180 - turnDeg;
    if (interiorDeg > maxAngleDeg) continue;
    corners.push({ point: current, angleDeg: interiorDeg });
  }
  return Object.freeze(corners);
}

/**
 * Place ears automatically on one object's mesh.
 *
 * `positions` are object-local millimetres, Z up, with the object's own base at
 * `minZ`; the outline is sampled just above it because a slice exactly at the
 * base plane hits coplanar bottom facets and produces no crossings at all.
 */
export function detectBrimEars(
  positions: Float32Array | readonly number[],
  indices: Uint32Array | readonly number[] | undefined,
  options: BrimEarDetectionOptions = DEFAULT_BRIM_EAR_DETECTION,
): BrimEarDetectionResult {
  if (positions.length < 9) return Object.freeze({ ears: Object.freeze([]), reason: 'The object has no geometry.' });
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 2; index < positions.length; index += 3) {
    minZ = Math.min(minZ, positions[index]);
    maxZ = Math.max(maxZ, positions[index]);
  }
  const sampleHeight = options.sampleHeightMm ?? DEFAULT_BRIM_EAR_DETECTION.sampleHeightMm ?? 0.2;
  if (!(maxZ > minZ)) {
    return Object.freeze({ ears: Object.freeze([]), reason: 'The object is flat; there is no first layer to hold.' });
  }
  const z = minZ + Math.min(sampleHeight, (maxZ - minZ) / 2);

  const loops = sliceMeshOutline(positions, indices, z);
  if (loops.length === 0) {
    return Object.freeze({ ears: Object.freeze([]), reason: 'No closed outline could be read from the first layer.' });
  }

  const detected: DetectedBrimEar[] = [];
  for (const loop of loops) {
    for (const corner of detectOutlineCorners(loop, options.maxAngleDeg)) {
      detected.push({
        point: {
          positionMm: [corner.point[0], corner.point[1], minZ] as Vec3,
          headFrontRadiusMm: options.headFrontRadiusMm,
        },
        angleDeg: corner.angleDeg,
      });
    }
  }
  if (detected.length === 0) {
    return Object.freeze({
      ears: Object.freeze([]),
      reason: `No corner is sharper than ${options.maxAngleDeg}°; this outline has nothing that peels.`,
    });
  }
  return Object.freeze({ ears: thinBrimEars(detected, options.detectionRadiusMm) });
}

/**
 * Keep the sharpest of any cluster within `radiusMm`.
 *
 * Sorting by angle first is what makes the survivor the sharpest rather than
 * whichever the mesh happened to list first, and it makes the result
 * independent of triangle order.
 */
export function thinBrimEars(ears: readonly DetectedBrimEar[], radiusMm: number): readonly DetectedBrimEar[] {
  const ordered = [...ears].sort(
    (left, right) =>
      left.angleDeg - right.angleDeg ||
      left.point.positionMm[0] - right.point.positionMm[0] ||
      left.point.positionMm[1] - right.point.positionMm[1],
  );
  const kept: DetectedBrimEar[] = [];
  for (const candidate of ordered) {
    const collides = kept.some(
      (existing) =>
        Math.hypot(
          existing.point.positionMm[0] - candidate.point.positionMm[0],
          existing.point.positionMm[1] - candidate.point.positionMm[1],
        ) < radiusMm,
    );
    if (!collides) kept.push(candidate);
  }
  return Object.freeze(kept);
}
