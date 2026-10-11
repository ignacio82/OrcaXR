/**
 * Where a painted part sits on the bed, so the painter measures its brush in
 * the bed's millimetres as the person sees it, as Orca's painter gizmo does
 * (`GLGizmoPainterBase`: the selector's transform is the instance's matrix
 * after the volume's, and Height Range starts at the hit's bed Z).
 *
 * The placement is the instance's and the part's canonical transforms. Their
 * product (composed and multiplied as three.js composes the workspace's
 * display meshes) is the facet selection transform: its linear part and
 * translation, and as scaling factors the matrix's singular values, largest
 * first — the stretch along its principal axes. The selector divides the
 * brush radius by them only when they agree (a uniform scale under any
 * rotation or mirror), selecting in the part's own millimetres; otherwise it
 * moves the brush centres and the camera onto the bed and selects there with
 * the radius as given. Either way the sphere is a ball of that radius in bed
 * millimetres (an ellipsoid in a non-uniformly scaled part's own
 * coordinates), the circle a cylinder of that radius along the view on the
 * bed, and the band a slab of bed Z from the hit's bed Z. Orca reads uniformity
 * off the diagonal of the polar decomposition's scale factor instead, which a
 * non-uniform scale under a rotated part can make look uniform; the singular
 * values never do, so the brush is the size the person set on every placement.
 *
 * The singular values are the square roots of the eigenvalues of `LᵀL`, found
 * by cyclic Jacobi rotations (square roots and the four basic operations only,
 * so every host computes the same bits). The Rust core places hits the same
 * way (`orcaxr_project::facets::paint_tool`).
 */
import type { FacetSelectionTransform } from '../annotations/FacetRegionSelection';
import type { Transform, Vec3 } from '../domain/model';
import { composeTransform, multiplyMatrices } from '../picking';

/** The instance a hit met and the part inside it, by their canonical transforms. */
export interface PaintPlacement {
  readonly instance: Transform;
  readonly volume: Transform;
}

/** A hit placed on the bed: the selector's transform and the hit's bed Z. */
export interface PlacedPaintHit {
  readonly transform: FacetSelectionTransform;
  readonly plateZMm: number;
}

/** Sweeps of Jacobi rotations at most; a 3×3 converges in far fewer. */
const JACOBI_SWEEPS = 64;
const PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/**
 * The selector's transform for [placement] and the bed Z of [localPoint] under
 * it (Orca's `float((trafo * Vec3d(hit)).z())`), or nothing for a placement
 * that is not finite and invertible.
 */
export function placePaintHit(placement: PaintPlacement, localPoint: Vec3): PlacedPaintHit | undefined {
  const m = multiplyMatrices(composeTransform(placement.instance), composeTransform(placement.volume));
  const linear: [Vec3, Vec3, Vec3] = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const translation: Vec3 = [m[12], m[13], m[14]];
  if (!m.every((value) => Number.isFinite(value))) return undefined;
  const scalingFactors = singularValues(linear);
  if (!scalingFactors.every((value) => value > 0 && Number.isFinite(value))) return undefined;
  const [x, y, z] = localPoint.map(Math.fround);
  const plateZMm = Math.fround(linear[2][0] * x + linear[2][1] * y + linear[2][2] * z + translation[2]);
  return { transform: { linear, translation, scalingFactors }, plateZMm };
}

/** The singular values of [linear], largest first. */
function singularValues(linear: readonly [Vec3, Vec3, Vec3]): Vec3 {
  const a = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => linear[0][i] * linear[0][j] + linear[1][i] * linear[1][j] + linear[2][i] * linear[2][j]),
  );
  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
    if (a[0][1] === 0 && a[0][2] === 0 && a[1][2] === 0) break;
    for (const [p, q] of PAIRS) {
      const apq = a[p][q];
      if (apq === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      a[p][q] = 0;
      a[q][p] = 0;
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]].map((value) => (value > 0 ? Math.sqrt(value) : 0));
  values.sort((first, second) => second - first);
  return [values[0], values[1], values[2]];
}
