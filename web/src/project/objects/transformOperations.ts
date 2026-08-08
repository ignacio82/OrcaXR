import type { AssetRepository } from '../assets';
import type { InstanceId } from '../domain/ids';
import type { ProjectState, Quaternion, Transform, Vec3 } from '../domain/model';
import { findInstance } from '../domain/selectors';
import { computeCanonicalInstanceBounds } from './bounds';
import type { InstanceTransformChange } from './transformCommands';

export type MirrorAxis = 'x' | 'y' | 'z';

export class TransformOperationError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown-instance' | 'empty-selection' | 'invalid-axis' | 'invalid-normal' | 'invalid-bed',
  ) {
    super(message);
    this.name = 'TransformOperationError';
  }
}

/**
 * Mirror each instance across its own centre on one axis.
 *
 * Upstream stores a mirror as a negative scale component, so the operation is
 * exactly reversible and keeps rotation and position intact; the exporter's
 * winding fix already accounts for the flipped determinant.
 */
export function mirrorInstances(
  state: ProjectState,
  instanceIds: readonly InstanceId[],
  axis: MirrorAxis,
): InstanceTransformChange[] {
  const index = axisIndex(axis);
  return eachInstance(state, instanceIds, (transform) => {
    const scale = [...transform.scale] as [number, number, number];
    scale[index] = -scale[index];
    return { ...transform, scale: scale as unknown as Transform['scale'] };
  });
}

/** Clear rotation, matching upstream's per-object "Reset rotation". */
export function resetInstanceRotations(
  state: ProjectState,
  instanceIds: readonly InstanceId[],
): InstanceTransformChange[] {
  return eachInstance(state, instanceIds, (transform) => ({
    ...transform,
    rotation: [0, 0, 0, 1] as unknown as Transform['rotation'],
  }));
}

/** Clear non-uniform and mirrored scaling back to 1×. */
export function resetInstanceScales(
  state: ProjectState,
  instanceIds: readonly InstanceId[],
): InstanceTransformChange[] {
  return eachInstance(state, instanceIds, (transform) => ({
    ...transform,
    scale: [1, 1, 1] as unknown as Transform['scale'],
  }));
}

/**
 * Centre the selection's combined footprint on the printable area, moving
 * every instance by the same delta so their relative layout is preserved.
 */
export function centerInstancesOnPlate(
  state: ProjectState,
  assets: AssetRepository,
  instanceIds: readonly InstanceId[],
  bedSizeMm: readonly [number, number],
): InstanceTransformChange[] {
  if (instanceIds.length === 0) throw new TransformOperationError('Nothing is selected', 'empty-selection');
  const [bedX, bedY] = bedSizeMm;
  if (!Number.isFinite(bedX) || !Number.isFinite(bedY) || bedX <= 0 || bedY <= 0) {
    throw new TransformOperationError('Centring needs a positive printable area', 'invalid-bed');
  }
  const bounds = computeCanonicalInstanceBounds(state, assets, [...new Set(instanceIds)], {
    volumeRoles: ['model'],
  });
  const deltaX = bedX / 2 - (bounds.min[0] + bounds.max[0]) / 2;
  const deltaY = bedY / 2 - (bounds.min[1] + bounds.max[1]) / 2;
  return eachInstance(state, instanceIds, (transform) => ({
    ...transform,
    translationMm: [
      transform.translationMm[0] + deltaX,
      transform.translationMm[1] + deltaY,
      transform.translationMm[2],
    ] as unknown as Transform['translationMm'],
  }));
}

export interface LayOnFaceRequest {
  readonly instanceId: InstanceId;
  /** Facet normal in the instance's own local space, any non-zero length. */
  readonly localNormal: Vec3;
}

/**
 * Rotate an instance so the chosen facet faces the bed, then rest it on Z=0 —
 * the pinned "place on face" outcome. Rotation composes with the instance's
 * existing orientation instead of replacing it, so a laid face stays flat
 * after further edits.
 */
export function layInstanceOnFace(
  state: ProjectState,
  assets: AssetRepository,
  request: LayOnFaceRequest,
): InstanceTransformChange[] {
  const found = findInstance(state, request.instanceId);
  if (!found) throw new TransformOperationError(`Unknown instance ${request.instanceId}`, 'unknown-instance');
  const length = Math.hypot(request.localNormal[0], request.localNormal[1], request.localNormal[2]);
  if (!Number.isFinite(length) || length < 1e-9) {
    throw new TransformOperationError('The chosen facet has no usable normal', 'invalid-normal');
  }
  const normal: Vec3 = [
    request.localNormal[0] / length,
    request.localNormal[1] / length,
    request.localNormal[2] / length,
  ];
  // The facet normal must end up pointing straight down at the bed.
  const worldNormal = rotateVector(normal, found.instance.transform.rotation);
  const alignment = quaternionBetween(worldNormal, [0, 0, -1]);
  const rotation = multiplyQuaternions(alignment, found.instance.transform.rotation);
  const rotated: Transform = { ...found.instance.transform, rotation };

  const probe: ProjectState = replaceInstanceTransform(state, request.instanceId, rotated);
  const bounds = computeCanonicalInstanceBounds(probe, assets, [request.instanceId], { volumeRoles: ['model'] });
  return [
    {
      instanceId: request.instanceId,
      transform: {
        ...rotated,
        translationMm: [
          rotated.translationMm[0],
          rotated.translationMm[1],
          rotated.translationMm[2] - bounds.min[2],
        ] as unknown as Transform['translationMm'],
      },
    },
  ];
}

function eachInstance(
  state: ProjectState,
  instanceIds: readonly InstanceId[],
  map: (transform: Transform) => Transform,
): InstanceTransformChange[] {
  if (instanceIds.length === 0) throw new TransformOperationError('Nothing is selected', 'empty-selection');
  const seen = new Set<InstanceId>();
  const changes: InstanceTransformChange[] = [];
  for (const instanceId of instanceIds) {
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const found = findInstance(state, instanceId);
    if (!found) throw new TransformOperationError(`Unknown instance ${instanceId}`, 'unknown-instance');
    changes.push({ instanceId, transform: map(found.instance.transform) });
  }
  return changes;
}

function axisIndex(axis: MirrorAxis): 0 | 1 | 2 {
  if (axis === 'x') return 0;
  if (axis === 'y') return 1;
  if (axis === 'z') return 2;
  throw new TransformOperationError(`Unknown mirror axis ${String(axis)}`, 'invalid-axis');
}

/** Structural clone with one instance transform replaced, for probe bounds. */
function replaceInstanceTransform(state: ProjectState, instanceId: InstanceId, transform: Transform): ProjectState {
  return {
    ...state,
    plates: state.plates.map((plate) => ({
      ...plate,
      objects: plate.objects.map((object) => ({
        ...object,
        instances: object.instances.map((instance) =>
          instance.id === instanceId ? { ...instance, transform } : instance,
        ),
      })),
    })),
  };
}

export function rotateVector(vector: Vec3, quaternion: Quaternion): Vec3 {
  const [x, y, z, w] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

export function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ] as unknown as Quaternion;
}

/** Shortest-arc rotation taking `from` to `to`; both must be unit length. */
export function quaternionBetween(from: Vec3, to: Vec3): Quaternion {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot >= 1 - 1e-9) return [0, 0, 0, 1] as unknown as Quaternion;
  if (dot <= -1 + 1e-9) {
    // Opposite vectors: any perpendicular axis gives a deterministic 180° turn.
    const axis: Vec3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const perpendicular: Vec3 = [
      from[1] * axis[2] - from[2] * axis[1],
      from[2] * axis[0] - from[0] * axis[2],
      from[0] * axis[1] - from[1] * axis[0],
    ];
    const length = Math.hypot(perpendicular[0], perpendicular[1], perpendicular[2]);
    return [
      perpendicular[0] / length,
      perpendicular[1] / length,
      perpendicular[2] / length,
      0,
    ] as unknown as Quaternion;
  }
  const cross: Vec3 = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ];
  const w = 1 + dot;
  const length = Math.hypot(cross[0], cross[1], cross[2], w);
  return [cross[0] / length, cross[1] / length, cross[2] / length, w / length] as unknown as Quaternion;
}
