/**
 * Variable and adaptive layer-height profiles (P5.9).
 *
 * A port of the pinned `Slicing.cpp` / `SlicingAdaptive.cpp` editing and
 * generation algorithms. The profile is upstream's own representation: a flat
 * list of `[z0, h0, z1, h1, …]` pairs, where each pair is a print Z and the
 * layer height in force there, interpolated linearly between pairs. Keeping
 * that exact shape is what lets a profile round-trip through
 * `Metadata/layer_heights_profile.txt` and be read by desktop Orca unchanged.
 *
 * Every constant here is upstream's, including the ones that look arbitrary —
 * the 0.1 mm resampling step, the six smoothing rounds, the 1.44 and 0.184 in
 * the slope formula. They are reproduced rather than re-derived so a profile
 * compares numerically against the reference implementation.
 */

import type { Vec3 } from '../domain/model';

export const PINNED_LAYER_HEIGHT_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  slicing: 'src/libslic3r/Slicing.cpp',
  adaptive: 'src/libslic3r/SlicingAdaptive.cpp',
  persistence: 'src/libslic3r/Format/bbs_3mf.cpp',
});

/** Pinned `EPSILON` from libslic3r. */
const EPSILON = 1e-4;
/** Pinned `LAYER_HEIGHT_CHANGE_STEP`. */
const LAYER_HEIGHT_CHANGE_STEP = 0.05;
/** Pinned resampling step of the manual editor, in millimetres. */
const RESAMPLE_STEP_MM = 0.1;
/** Pinned number of smoothing rounds, in both the editor and the smoother. */
const SMOOTHING_ROUNDS = 6;

/** The slicing facts a profile is constrained by, as upstream names them. */
export interface LayerHeightSlicingParameters {
  readonly layerHeightMm: number;
  readonly minLayerHeightMm: number;
  readonly maxLayerHeightMm: number;
  readonly firstObjectLayerHeightMm: number;
  /** True when the first layer's height is fixed and not editable. */
  readonly firstObjectLayerHeightFixed: boolean;
  /** Object height above the bed, in millimetres. */
  readonly objectHeightMm: number;
}

/** Pinned `LayerHeightEditActionType`. */
export type LayerHeightEditAction = 'increase' | 'decrease' | 'reduce' | 'smooth';

/** Pinned `HeightProfileSmoothingParams`. */
export interface HeightProfileSmoothing {
  readonly radius: number;
  readonly keepMin: boolean;
}

export const DEFAULT_HEIGHT_PROFILE_SMOOTHING: HeightProfileSmoothing = Object.freeze({
  radius: 5,
  keepMin: false,
});

export class LayerHeightProfileError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-parameters' | 'invalid-profile',
  ) {
    super(message);
    this.name = 'LayerHeightProfileError';
  }
}

export function assertSlicingParameters(parameters: LayerHeightSlicingParameters): void {
  const finite = [
    parameters.layerHeightMm,
    parameters.minLayerHeightMm,
    parameters.maxLayerHeightMm,
    parameters.firstObjectLayerHeightMm,
    parameters.objectHeightMm,
  ];
  if (!finite.every((value) => Number.isFinite(value))) {
    throw new LayerHeightProfileError('Slicing parameters must all be finite', 'invalid-parameters');
  }
  if (parameters.minLayerHeightMm <= 0 || parameters.maxLayerHeightMm < parameters.minLayerHeightMm) {
    throw new LayerHeightProfileError(
      'Layer height limits must be positive with max at least min',
      'invalid-parameters',
    );
  }
  if (parameters.objectHeightMm <= 0) {
    throw new LayerHeightProfileError('An object with no height has no layers to edit', 'invalid-parameters');
  }
}

/**
 * The flat profile an object starts from: the base layer height everywhere,
 * with the fixed first layer pinned when the printer has one.
 */
export function baseLayerHeightProfile(parameters: LayerHeightSlicingParameters): number[] {
  assertSlicingParameters(parameters);
  const profile: number[] = [];
  if (parameters.firstObjectLayerHeightFixed) {
    profile.push(0, parameters.firstObjectLayerHeightMm);
    profile.push(parameters.firstObjectLayerHeightMm, parameters.firstObjectLayerHeightMm);
  } else {
    profile.push(0, parameters.layerHeightMm);
  }
  profile.push(parameters.objectHeightMm, parameters.layerHeightMm);
  return profile;
}

/** The layer height the profile specifies at `z`, interpolated as upstream does. */
export function layerHeightAt(profile: readonly number[], z: number, fallbackMm: number): number {
  for (let index = 0; index < profile.length; index += 2) {
    if (index + 2 === profile.length) return profile[index + 1];
    if (profile[index + 2] > z) {
      const z1 = profile[index];
      const h1 = profile[index + 1];
      const z2 = profile[index + 2];
      const h2 = profile[index + 3];
      return z2 === z1 ? h1 : lerp(h1, h2, (z - z1) / (z2 - z1));
    }
  }
  return fallbackMm;
}

/**
 * Apply one manual edit at `z`, exactly as the pinned editor does.
 *
 * Returns a new profile; the input is not modified. An edit that upstream
 * would refuse — outside the editable span, or already at a limit — returns
 * the profile unchanged, which is how the caller learns nothing happened.
 */
export function adjustLayerHeightProfile(
  profile: readonly number[],
  parameters: LayerHeightSlicingParameters,
  request: {
    readonly zMm: number;
    readonly thicknessDeltaMm: number;
    readonly bandWidthMm: number;
    readonly action: LayerHeightEditAction;
  },
): number[] {
  assertSlicingParameters(parameters);
  assertProfile(profile);
  const spanLow = parameters.firstObjectLayerHeightFixed ? parameters.firstObjectLayerHeightMm : 0;
  const spanHigh = parameters.objectHeightMm;
  const z = request.zMm;
  if (z < spanLow || z > spanHigh) return [...profile];

  const currentHeight = layerHeightAt(profile, z, parameters.layerHeightMm);

  // Decide the usable delta before touching anything, so a refused edit leaves
  // the profile byte-identical rather than resampled for no reason.
  let delta = request.thicknessDeltaMm;
  if (request.action === 'increase' || request.action === 'decrease') {
    if (request.action === 'decrease') delta = -delta;
    if (delta > 0) {
      if (currentHeight >= parameters.maxLayerHeightMm - EPSILON) return [...profile];
      delta = Math.min(delta, parameters.maxLayerHeightMm - currentHeight);
    } else {
      if (currentHeight <= parameters.minLayerHeightMm + EPSILON) return [...profile];
      delta = Math.max(delta, parameters.minLayerHeightMm - currentHeight);
    }
  } else {
    delta = Math.min(Math.abs(delta), Math.abs(parameters.layerHeightMm - currentHeight));
    if (delta < EPSILON) return [...profile];
  }

  const lo = Math.max(spanLow, z - 0.5 * request.bandWidthMm);
  // The upper side is deliberately unbounded so an edit can reach the top point.
  const hi = z + 0.5 * request.bandWidthMm;

  let index = 0;
  while (index < profile.length && profile[index] < lo) index += 2;
  index = Math.max(0, index - 2);

  const next: number[] = profile.slice(0, index + 2);
  const resampledStart = next.length;
  let zz = lo;
  for (;;) {
    const following = index + 2;
    const z1 = profile[index];
    const h1 = profile[index + 1];
    let height = h1;
    if (following < profile.length) {
      const z2 = profile[following];
      const h2 = profile[following + 1];
      height = z2 === z1 ? h1 : lerp(h1, h2, (zz - z1) / (z2 - z1));
    }

    // A raised cosine over the band, so an edit fades out at its edges.
    const weight =
      Math.abs(zz - z) < 0.5 * request.bandWidthMm
        ? 0.5 + 0.5 * Math.cos((2 * Math.PI * (zz - z)) / request.bandWidthMm)
        : 0;
    if (request.action === 'increase' || request.action === 'decrease') {
      height += weight * delta;
    } else if (request.action === 'reduce') {
      const toBase = height - parameters.layerHeightMm;
      const step = weight * delta;
      height += Math.abs(toBase) > step ? (toBase > 0 ? -step : step) : -toBase;
    }
    // 'smooth' leaves the height alone here and is applied after resampling.
    height = clamp(height, parameters.minLayerHeightMm, parameters.maxLayerHeightMm);

    if (zz === spanHigh) {
      // The last point of the profile replaces any point that reached it.
      if (next[next.length - 2] + EPSILON > zz) {
        next.pop();
        next.pop();
      }
      next.push(zz, height);
      index = profile.length;
      break;
    }
    if (next[next.length - 2] + EPSILON < zz) next.push(zz, height);
    if (zz >= hi) break;

    zz = Math.min(zz + RESAMPLE_STEP_MM, spanHigh);
    index = following;
    while (index < profile.length && profile[index] < zz) index += 2;
    index = Math.max(0, index - 2);
  }

  index += 2;
  const resampledEnd = next.length;
  if (index < profile.length) {
    next.push(...profile.slice(index));
  } else if (next[next.length - 2] + 0.5 * EPSILON < spanHigh) {
    next.push(...profile.slice(profile.length - 2));
  }

  if (request.action !== 'smooth') return next;

  // Smoothing is six weighted passes over the resampled window only, so an
  // edit stays local instead of creeping along the whole object.
  const start = resampledStart === 0 ? 1 : resampledStart;
  const end = resampledEnd === next.length ? resampledEnd - 2 : resampledEnd;
  const smoothed = [...next];
  for (let round = 0; round < SMOOTHING_ROUNDS; round += 1) {
    const previous = [...smoothed];
    for (let i = start; i < end; i += 2) {
      const zi = previous[i];
      const t =
        Math.abs(zi - z) < 0.5 * request.bandWidthMm
          ? 0.25 + 0.25 * Math.cos((2 * Math.PI * (zi - z)) / request.bandWidthMm)
          : 0;
      if (i === 0) smoothed[i + 1] = (1 - t) * previous[i + 1] + t * previous[i + 3];
      else if (i + 1 === previous.length) smoothed[i + 1] = (1 - t) * previous[i + 1] + t * previous[i - 1];
      else smoothed[i + 1] = (1 - t) * previous[i + 1] + 0.5 * t * (previous[i - 1] + previous[i + 3]);
    }
  }
  return smoothed;
}

/**
 * The pinned biased Gaussian smoother, run for six rounds.
 *
 * The bias pulls the result toward the minimum layer height: a thin layer
 * carries more weight than a thick one, so smoothing sharpens detail rather
 * than averaging it away.
 */
export function smoothHeightProfile(
  profile: readonly number[],
  parameters: LayerHeightSlicingParameters,
  smoothing: HeightProfileSmoothing = DEFAULT_HEIGHT_PROFILE_SMOOTHING,
): number[] {
  assertSlicingParameters(parameters);
  assertProfile(profile);
  let result = [...profile];
  for (let round = 0; round < SMOOTHING_ROUNDS; round += 1) result = gaussBlur(result, parameters, smoothing);
  return result;
}

function gaussBlur(
  profile: readonly number[],
  parameters: LayerHeightSlicingParameters,
  smoothing: HeightProfileSmoothing,
): number[] {
  // The fixed first layer is left exactly as it is.
  const skip = parameters.firstObjectLayerHeightFixed ? 4 : 0;
  if (profile.length - skip < 6) return [...profile];

  const radius = Math.max(Math.trunc(smoothing.radius), 1);
  const kernel = gaussKernel(radius);
  const twoRadius = 2 * radius;
  const result: number[] = profile.slice(0, skip);

  const deltaH = parameters.maxLayerHeightMm - parameters.minLayerHeightMm;
  const inverseDeltaH = deltaH !== 0 ? 1 / deltaH : 1;
  const maxDzBand = radius * parameters.layerHeightMm;

  for (let i = skip; i < profile.length; i += 2) {
    const zi = profile[i];
    const hi = profile[i + 1];
    let height = 0;
    let weightTotal = 0;
    const begin = Math.max(i - twoRadius, skip);
    const end = Math.min(i + twoRadius, profile.length - 2);
    for (let j = begin; j <= end; j += 2) {
      const kernelIndex = radius + (j - i) / 2;
      const dz = Math.abs(zi - profile[j]);
      if (dz * parameters.layerHeightMm <= maxDzBand) {
        const dh = Math.abs(parameters.maxLayerHeightMm - profile[j + 1]);
        const weight = kernel[kernelIndex] * Math.sqrt(dh * inverseDeltaH);
        height += weight * profile[j + 1];
        weightTotal += weight;
      }
    }
    let value = clamp(
      weightTotal === 0 ? hi : height / weightTotal,
      parameters.minLayerHeightMm,
      parameters.maxLayerHeightMm,
    );
    if (smoothing.keepMin) value = Math.min(value, hi);
    result.push(zi, value);
  }
  return result;
}

function gaussKernel(radius: number): number[] {
  const size = 2 * radius + 1;
  const sigma = 0.3 * (radius - 1) + 0.8;
  const twoSquareSigma = 2 * sigma * sigma;
  const inverseRoot = 1 / Math.sqrt(Math.PI * twoSquareSigma);
  const kernel: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const x = i - radius;
    kernel.push(inverseRoot * Math.exp((-x * x) / twoSquareSigma));
  }
  return kernel;
}

/** One triangle reduced to what the adaptive slicer needs from it. */
interface FaceZ {
  readonly zMin: number;
  readonly zMax: number;
  /** |normal.z|, so a flat top and a flat bottom weigh the same. */
  readonly normalCos: number;
  /** Length of the normal's horizontal part. */
  readonly normalSin: number;
}

export interface AdaptiveMesh {
  readonly vertices: ReadonlyArray<Vec3 | readonly [number, number, number]>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
}

/**
 * Generate an adaptive profile from the object's own geometry.
 *
 * `qualityFactor` is the pinned "Quality / Speed" slider: **0 is finest and 1
 * is fastest**, which is the opposite of what the name suggests on first
 * reading. It selects the surface deviation a layer is allowed to produce,
 * interpolated between the min, nominal, and max layer heights rather than
 * used as a free parameter.
 *
 * The result also inverts the intuition that steep walls need thin layers: a
 * vertical wall has no stair-stepping to hide and takes the maximum height,
 * while a shallow, nearly horizontal surface takes the minimum.
 */
export function adaptiveLayerHeightProfile(
  mesh: AdaptiveMesh,
  parameters: LayerHeightSlicingParameters,
  qualityFactor: number,
): number[] {
  assertSlicingParameters(parameters);
  if (!Number.isFinite(qualityFactor) || qualityFactor < 0 || qualityFactor > 1) {
    throw new LayerHeightProfileError('Adaptive quality must be between 0 and 1', 'invalid-parameters');
  }
  const faces = prepareFaces(mesh);

  const profile: number[] = [0, parameters.firstObjectLayerHeightMm];
  if (parameters.firstObjectLayerHeightFixed) {
    profile.push(parameters.firstObjectLayerHeightMm, parameters.firstObjectLayerHeightMm);
  }
  let printZ = parameters.firstObjectLayerHeightMm;
  const cursor = { facet: 0 };

  while (printZ + EPSILON < parameters.objectHeightMm) {
    let height = nextLayerHeight(faces, parameters, printZ, qualityFactor, cursor);
    // Upstream refuses a step change larger than this, so a profile never
    // jumps in a way the extruder cannot follow.
    const previous = profile[profile.length - 1];
    if (previous < height && height - previous > LAYER_HEIGHT_CHANGE_STEP) {
      height = previous + LAYER_HEIGHT_CHANGE_STEP;
    } else if (previous > height && previous - height > LAYER_HEIGHT_CHANGE_STEP) {
      height = previous - LAYER_HEIGHT_CHANGE_STEP;
    }
    profile.push(printZ, height);
    printZ += height;
  }

  const gap = parameters.objectHeightMm - profile[profile.length - 2];
  if (gap > 0) {
    profile.push(parameters.objectHeightMm, clamp(gap, parameters.minLayerHeightMm, parameters.maxLayerHeightMm));
  }
  return profile;
}

function prepareFaces(mesh: AdaptiveMesh): FaceZ[] {
  const faces: FaceZ[] = [];
  for (const triangle of mesh.triangles) {
    const a = mesh.vertices[triangle[0]];
    const b = mesh.vertices[triangle[1]];
    const c = mesh.vertices[triangle[2]];
    if (!a || !b || !c) continue;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    faces.push({
      zMin: Math.min(a[2], b[2], c[2]),
      zMax: Math.max(a[2], b[2], c[2]),
      normalCos: Math.abs(nz),
      normalSin: Math.hypot(nx, ny),
    });
  }
  // Lexicographic by Z span, which is what lets the walk below stay linear.
  faces.sort((left, right) => left.zMin - right.zMin || left.zMax - right.zMax);
  return faces;
}

function nextLayerHeight(
  faces: readonly FaceZ[],
  parameters: LayerHeightSlicingParameters,
  printZ: number,
  qualityFactor: number,
  cursor: { facet: number },
): number {
  let height = parameters.maxLayerHeightMm;
  const maxSurfaceDeviation =
    qualityFactor < 0.5
      ? lerp(parameters.minLayerHeightMm, parameters.layerHeightMm, 2 * qualityFactor)
      : lerp(parameters.maxLayerHeightMm, parameters.layerHeightMm, 2 * (1 - qualityFactor));

  let ordered = cursor.facet;
  let firstHit = false;
  for (; ordered < faces.length; ordered += 1) {
    const face = faces[ordered];
    if (face.zMin >= printZ) break;
    if (face.zMax > printZ) {
      if (!firstHit) {
        firstHit = true;
        cursor.facet = ordered;
      }
      // A facet that merely touches this Z would otherwise force a tiny layer.
      if (face.zMax < printZ + EPSILON) continue;
      height = Math.min(height, layerHeightFromSlope(face, maxSurfaceDeviation));
    }
  }

  height = Math.max(height, parameters.minLayerHeightMm);
  if (height > parameters.minLayerHeightMm) {
    for (; ordered < faces.length; ordered += 1) {
      const face = faces[ordered];
      if (face.zMin >= printZ + height) break;
      if (face.zMax < printZ + EPSILON) continue;
      const reduced = layerHeightFromSlope(face, maxSurfaceDeviation);
      const zDiff = face.zMin - printZ;
      if (reduced < zDiff) height = zDiff;
      else if (reduced < height) height = reduced;
    }
    height = Math.max(height, parameters.minLayerHeightMm);
  }
  return height;
}

/**
 * Upstream's surface-error metric: the layer height whose step leaves a
 * triangle of error no larger than `maxSurfaceDeviation`, clamped at the
 * roughness a vertical wall implies.
 */
function layerHeightFromSlope(face: FaceZ, maxSurfaceDeviation: number): number {
  const sloped =
    face.normalCos > 1e-5 ? 1.44 * maxSurfaceDeviation * Math.sqrt(face.normalSin / face.normalCos) : Infinity;
  return Math.min(maxSurfaceDeviation / 0.184, sloped);
}

/**
 * The layer boundaries a profile produces, as print Z values.
 *
 * This is what makes an edit checkable: the preview and the engine must agree
 * on where the layers actually land, not merely on the profile that describes
 * them.
 */
export function objectLayersFromProfile(
  profile: readonly number[],
  parameters: LayerHeightSlicingParameters,
): { readonly printZMm: number; readonly heightMm: number }[] {
  assertSlicingParameters(parameters);
  assertProfile(profile);
  const layers: { printZMm: number; heightMm: number }[] = [];
  let printZ = 0;
  // A generous ceiling: even a 1 m object at the minimum height cannot reach it.
  const limit = Math.ceil(parameters.objectHeightMm / parameters.minLayerHeightMm) + 4;
  while (printZ + EPSILON < parameters.objectHeightMm && layers.length < limit) {
    const height = clamp(
      layerHeightAt(profile, printZ, parameters.layerHeightMm),
      parameters.minLayerHeightMm,
      parameters.maxLayerHeightMm,
    );
    printZ += height;
    layers.push({ printZMm: Math.min(printZ, parameters.objectHeightMm), heightMm: height });
  }
  return layers;
}

function assertProfile(profile: readonly number[]): void {
  if (profile.length < 4 || profile.length % 2 !== 0) {
    throw new LayerHeightProfileError('A layer height profile is at least two z/height pairs', 'invalid-profile');
  }
  if (!profile.every((value) => Number.isFinite(value))) {
    throw new LayerHeightProfileError('A layer height profile must be finite throughout', 'invalid-profile');
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
