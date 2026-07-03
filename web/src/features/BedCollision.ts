/**
 * Bed collision / overflow detection — web port of the Android
 * `BedCollision.kt` (Roadmap A6 full mesh-vs-bed check).
 *
 * The naive bbox-extent check misses two real cases: a model whose extent
 * fits but is positioned past the bed polygon, and a rotated model whose
 * AABB grows even though most of its footprint is inside the bed. So we
 * walk every transformed vertex and report the exact off-bed triangle set
 * plus the worst signed overflow per axis, matching the Kotlin math.
 *
 * Positions are printer-space (mm), 9 floats per triangle (non-indexed),
 * X/Y in the bed plane. Z is intentionally NOT checked — libslic3r drops
 * the model to z=0 before G-code emission.
 */

export interface BedCollisionOff {
  kind: 'off';
  offendingTriCount: number;
  totalTriCount: number;
  offendingTriIndices: number[];
  overflowX: boolean;
  overflowY: boolean;
  /** Worst signed overflow (mm). Negative = past the −X/−Y edge. */
  worstOverflowXmm: number;
  worstOverflowYmm: number;
}
export interface BedCollisionOk { kind: 'ok'; }
export type BedCollisionResult = BedCollisionOk | BedCollisionOff;

/**
 * Walk [positions] and report any triangle with a vertex outside the
 * printable polygon `[-bedXmm/2, bedXmm/2] × [-bedYmm/2, bedYmm/2]`.
 *
 * When [recenterToBed] is true (default) the XY bbox center is subtracted
 * first — matching the JNI's auto-center pre-slice pass, so a single
 * model's absolute XY translate is irrelevant; only the rotated silhouette
 * vs the bed matters. Pass false for a pre-centered multi-model group.
 */
export function detectBedCollision(
  positions: ArrayLike<number>,
  bedXmm: number,
  bedYmm: number,
  recenterToBed = true,
): BedCollisionResult {
  const triCount = Math.floor(positions.length / 9);
  if (triCount === 0) return { kind: 'ok' };
  const halfX = bedXmm / 2;
  const halfY = bedYmm / 2;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = recenterToBed ? (minX + maxX) / 2 : 0;
  const cy = recenterToBed ? (minY + maxY) / 2 : 0;

  // Quick reject: recentered AABB entirely inside the bed polygon.
  if (minX - cx >= -halfX && maxX - cx <= halfX && minY - cy >= -halfY && maxY - cy <= halfY) {
    return { kind: 'ok' };
  }

  const offending: number[] = [];
  let overflowX = false, overflowY = false, worstX = 0, worstY = 0;
  let triIdx = 0;
  for (let i = 0; i < positions.length; i += 9) {
    let triHit = false;
    for (let v = 0; v < 3; v++) {
      const x = positions[i + v * 3] - cx;
      const y = positions[i + v * 3 + 1] - cy;
      if (x < -halfX) {
        triHit = true; overflowX = true;
        const over = x + halfX; // negative
        if (Math.abs(over) > Math.abs(worstX)) worstX = over;
      } else if (x > halfX) {
        triHit = true; overflowX = true;
        const over = x - halfX; // positive
        if (Math.abs(over) > Math.abs(worstX)) worstX = over;
      }
      if (y < -halfY) {
        triHit = true; overflowY = true;
        const over = y + halfY;
        if (Math.abs(over) > Math.abs(worstY)) worstY = over;
      } else if (y > halfY) {
        triHit = true; overflowY = true;
        const over = y - halfY;
        if (Math.abs(over) > Math.abs(worstY)) worstY = over;
      }
    }
    if (triHit) offending.push(triIdx);
    triIdx++;
  }
  if (offending.length === 0) return { kind: 'ok' };
  return {
    kind: 'off',
    offendingTriCount: offending.length,
    totalTriCount: triCount,
    offendingTriIndices: offending,
    overflowX,
    overflowY,
    worstOverflowXmm: worstX,
    worstOverflowYmm: worstY,
  };
}

/** Human-readable banner text for an off-bed result (matches the app's badge). */
export function bedCollisionBanner(r: BedCollisionResult): string | null {
  if (r.kind === 'ok') return null;
  const parts: string[] = [];
  if (r.overflowX) parts.push(`X ${r.worstOverflowXmm > 0 ? '+' : ''}${r.worstOverflowXmm.toFixed(1)} mm`);
  if (r.overflowY) parts.push(`Y ${r.worstOverflowYmm > 0 ? '+' : ''}${r.worstOverflowYmm.toFixed(1)} mm`);
  return `${r.offendingTriCount} of ${r.totalTriCount} triangles off-bed` +
    (parts.length ? ` — worst overflow ${parts.join(', ')}` : '');
}
