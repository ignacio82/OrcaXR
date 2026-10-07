import type { Transform } from '../domain/model';

export function transform3mf(
  transform: Transform,
  translationOffsetMm: { x: number; y: number } = { x: 0, y: 0 },
): string {
  const matrix = transformMatrix(transform, translationOffsetMm);
  return [
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[3],
    matrix[7],
    matrix[11],
  ]
    .map(formatNumber)
    .join(' ');
}

export function matrix4(transform: Transform): string {
  return transformMatrix(transform).map(formatNumber).join(' ');
}

export function transformMatrix(
  transform: Transform,
  translationOffsetMm: { x: number; y: number } = { x: 0, y: 0 },
): number[] {
  let [x, y, z, w] = transform.rotation;
  const norm = Math.hypot(x, y, z, w);
  x /= norm;
  y /= norm;
  z /= norm;
  w /= norm;
  const [sx, sy, sz] = transform.scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y - z * w) * sy,
    2 * (x * z + y * w) * sz,
    transform.translationMm[0] + translationOffsetMm.x,
    2 * (x * y + z * w) * sx,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z - x * w) * sz,
    transform.translationMm[1] + translationOffsetMm.y,
    2 * (x * z - y * w) * sx,
    2 * (y * z + x * w) * sy,
    (1 - 2 * (x * x + y * y)) * sz,
    transform.translationMm[2],
    0,
    0,
    0,
    1,
  ];
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite coordinate');
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * Write a mesh coordinate as the shortest decimal that still names the same
 * float32.
 *
 * Canonical mesh positions are float32, and printing one through `String` emits
 * the shortest *double* that round-trips — for a float32 that is its exact
 * binary expansion, so a coordinate the source file wrote as `-25.7756138`
 * comes back out as `-25.77561378479004`. Those trailing digits carry no
 * information: they are the same float32 either way. They cost about 60% more
 * bytes each, and because they are effectively noise they also wreck
 * compression — reopening a 1.9M-facet model turned a 27.9 MB archive into an
 * 85.7 MB one, which is what an external slicer then has to receive.
 *
 * Round-tripping is exact in both directions: the emitted text parses to this
 * same float32, which is what the canonical asset stores.
 */
export function formatMeshCoordinate(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite coordinate');
  if (Object.is(value, -0) || value === 0) return '0';
  // Nine significant digits always suffice to name a float32 uniquely; the loop
  // stops at the first precision that does, which is usually far fewer.
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  return String(value);
}
