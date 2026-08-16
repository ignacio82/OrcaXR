/**
 * What a placed brim ear will actually do, before the slice says so (P5.3.6).
 *
 * The pinned gizmo draws each ear as a flat disc on the model and colours the
 * useless ones red. That second half is the part worth porting: an ear whose
 * disc does not reach the part prints a small island of brim attached to
 * nothing, holds nothing down, and produces no error anywhere — the same shape
 * of silent uselessness as the Z bug that made every placed ear vanish.
 * `GLGizmoBrimEars::find_single` is where upstream decides this, and this is
 * that decision.
 *
 * Upstream's method: build a polygon per ear, then repeatedly absorb into the
 * first-layer outline any ear polygon that overlaps it, unioning as it goes,
 * until a pass absorbs nothing. What is left over is disconnected. The
 * absorption is transitive on purpose — a chain of overlapping ears reaching
 * the part is anchored, because the brim they print is one connected region.
 */

import { sliceMeshOutline } from './brimEarDetection';
import type { OutlinePolygon } from './brimEarDetection';

/** A placed ear reduced to what the connectivity test needs. */
export interface BrimEarDisc {
  /** Object-local millimetres, in the plane the outline was cut in. */
  readonly x: number;
  readonly y: number;
  readonly radiusMm: number;
}

/**
 * The pinned render colours (`GLGizmoBrimEars.cpp:13-16`), as the renderer
 * wants them. Hover and error are translucent upstream and stay so here.
 */
export const BRIM_EAR_COLORS = Object.freeze({
  default: Object.freeze({ color: 0xb3b3b3, opacity: 1 }),
  selected: Object.freeze({ color: 0x008080, opacity: 1 }),
  error: Object.freeze({ color: 0xff4d4d, opacity: 0.5 }),
  hover: Object.freeze({ color: 0xb3b3b3, opacity: 0.5 }),
});

/**
 * Disc height, matching the pinned `scale_transform({radius, radius, .2})`.
 * A marker, not a model of the ear: upstream draws a flat cylinder so the disc
 * reads as an annotation on the surface rather than as geometry to be printed.
 */
export const BRIM_EAR_DISC_HEIGHT_MM = 0.2;

function distanceToSegmentSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Ray casting, counting crossings of the half-line to +x. */
function pointInPolygon(x: number, y: number, loop: OutlinePolygon): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Does a disc reach the outline at all — overlapping it, or sitting inside it?
 *
 * The disc is treated as a true circle rather than upstream's regular polygon
 * approximation of one. That is a deliberate difference and it only ever moves
 * the answer toward the truth: the inscribed polygon is strictly smaller than
 * the circle the slicer will actually lay down, so upstream can call an ear
 * disconnected when its printed brim would in fact touch. Every loop counts,
 * holes included, since a disc that reaches a hole's rim still reaches
 * material.
 */
export function discTouchesOutline(disc: BrimEarDisc, loops: readonly OutlinePolygon[]): boolean {
  const radiusSquared = disc.radiusMm * disc.radiusMm;
  for (const loop of loops) {
    if (loop.length === 0) continue;
    if (pointInPolygon(disc.x, disc.y, loop)) return true;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
      const [ax, ay] = loop[j];
      const [bx, by] = loop[i];
      if (distanceToSegmentSquared(disc.x, disc.y, ax, ay, bx, by) <= radiusSquared) return true;
    }
  }
  return false;
}

function discsOverlap(a: BrimEarDisc, b: BrimEarDisc): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const reach = a.radiusMm + b.radiusMm;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * The indices of ears that reach neither the part nor anything anchored to it.
 *
 * Upstream unions each absorbed ear into the accumulated outline and retests
 * against the union. This grows the anchored set pairwise instead, which gives
 * the same answer: a union of overlapping shapes covers no ground that none of
 * its members covers, so "overlaps the union" and "overlaps some member" select
 * the same ears. The loop runs to a fixed point either way.
 */
export function findDisconnectedBrimEars(
  discs: readonly BrimEarDisc[],
  loops: readonly OutlinePolygon[],
): readonly number[] {
  const anchored = discs.map((disc) => discTouchesOutline(disc, loops));
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < discs.length; i += 1) {
      if (anchored[i]) continue;
      for (let j = 0; j < discs.length; j += 1) {
        if (i === j || !anchored[j]) continue;
        if (discsOverlap(discs[i], discs[j])) {
          anchored[i] = true;
          grew = true;
          break;
        }
      }
    }
  }
  const disconnected: number[] = [];
  for (let i = 0; i < anchored.length; i += 1) if (!anchored[i]) disconnected.push(i);
  return Object.freeze(disconnected);
}

/**
 * The first-layer outline an ear has to reach, cut just above the base.
 *
 * Deliberately the same cut height the automatic detector uses: an ear placed
 * on a corner the detector found must not then be reported as missing the part,
 * and the cheapest way to guarantee that is to ask both questions of one
 * outline.
 */
export function brimEarOutline(
  positions: Float32Array | readonly number[],
  indices: Uint32Array | readonly number[] | undefined,
  sampleHeightMm = 0.2,
): { readonly loops: readonly OutlinePolygon[]; readonly baseZ: number } | null {
  if (positions.length < 9) return null;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 2; index < positions.length; index += 3) {
    minZ = Math.min(minZ, positions[index]);
    maxZ = Math.max(maxZ, positions[index]);
  }
  if (!(maxZ > minZ)) return null;
  const z = minZ + Math.min(sampleHeightMm, (maxZ - minZ) / 2);
  return { loops: sliceMeshOutline(positions, indices, z), baseZ: minZ };
}
