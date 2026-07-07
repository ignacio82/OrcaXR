/**
 * MeshCut — bisect a non-indexed triangle soup by a plane (Snapmaker Orca's
 * "Cut"). Triangles fully on one side go to that half; straddling triangles are
 * clipped at the plane; the exposed cross-section is capped so both halves stay
 * watertight for convex sections (a centroid fan over the cut segments — exact
 * for convex cross-sections, the common case; concave sections may cap loosely).
 *
 * Pure array-in / array-out (no THREE), so the clipping math is unit-testable.
 * Plane is n·p = d with n a unit normal; the "positive" half is n·p >= d.
 */

export interface CutResult {
  /** Non-indexed positions of the n·p >= d half (9 floats per triangle). */
  positive: Float32Array;
  /** Non-indexed positions of the n·p <= d half. */
  negative: Float32Array;
  /** True when the plane actually crossed the mesh (both halves non-empty). */
  didCut: boolean;
}

type V3 = [number, number, number];

function lerp(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function cutByPlane(
  positions: ArrayLike<number>,
  nx: number, ny: number, nz: number, d: number,
): CutResult {
  const triCount = Math.floor(positions.length / 9);
  const pos: number[] = [];
  const neg: number[] = [];
  const segs: V3[] = []; // cut-segment endpoints, pairs (p,q)
  const EPS = 1e-6;

  const push = (arr: number[], a: V3, b: V3, c: V3) => { arr.push(...a, ...b, ...c); };

  for (let t = 0; t < triCount; t++) {
    const v: V3[] = [];
    const s: number[] = [];
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 3;
      const p: V3 = [positions[o], positions[o + 1], positions[o + 2]];
      v.push(p);
      s.push(nx * p[0] + ny * p[1] + nz * p[2] - d);
    }
    const nPos = s.filter((x) => x > EPS).length;
    const nNeg = s.filter((x) => x < -EPS).length;

    if (nNeg === 0) { push(pos, v[0], v[1], v[2]); continue; }
    if (nPos === 0) { push(neg, v[0], v[1], v[2]); continue; }

    // Straddling: split so exactly one vertex is alone on its side. Rotate the
    // triangle so index 0 is the lone vertex, preserving winding.
    let lone = 0;
    if (nPos === 1) lone = s.findIndex((x) => x > EPS);
    else lone = s.findIndex((x) => x < -EPS);
    const a = v[lone], b = v[(lone + 1) % 3], c = v[(lone + 2) % 3];
    const sa = s[lone], sb = s[(lone + 1) % 3], sc = s[(lone + 2) % 3];
    // Intersections on edges a→b and a→c.
    const ab = lerp(a, b, sa / (sa - sb));
    const ac = lerp(a, c, sa / (sa - sc));
    segs.push(ab, ac);

    // `a` is alone; {b,c} on the other side. Emit a-tri + the two-tri quad.
    const aSide = sa > 0 ? pos : neg;
    const bSide = sa > 0 ? neg : pos;
    push(aSide, a, ab, ac);
    push(bSide, ab, b, c);
    push(bSide, ab, c, ac);
  }

  // Cap the cross-section: centroid fan over the recorded cut segments.
  if (segs.length >= 2) {
    let cx = 0, cy = 0, cz = 0;
    for (const s of segs) { cx += s[0]; cy += s[1]; cz += s[2]; }
    const c: V3 = [cx / segs.length, cy / segs.length, cz / segs.length];
    for (let i = 0; i < segs.length; i += 2) {
      const p = segs[i], q = segs[i + 1];
      // Opposite winding on the two halves so each cap faces outward.
      push(pos, c, q, p);
      push(neg, c, p, q);
    }
  }

  return {
    positive: new Float32Array(pos),
    negative: new Float32Array(neg),
    didCut: pos.length > 0 && neg.length > 0,
  };
}
