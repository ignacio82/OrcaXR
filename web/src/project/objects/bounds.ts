import type { AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { InstanceId } from '../domain/ids';
import type { ProjectState, Transform, Vec3, VolumeRole } from '../domain/model';
import { findInstance } from '../domain/selectors';
import { decodeIndexedMeshAsset } from '../meshCodec';

export interface CanonicalBounds3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface CanonicalInstanceBoundsOptions {
  /** Omit to include every canonical volume role. */
  readonly volumeRoles?: readonly VolumeRole[];
}

/**
 * Compute the exact canonical TRS-space AABB for a stable instance set.
 *
 * Bounds derive from immutable asset bytes and canonical volume/instance
 * transforms only; projected Three objects are never read back into state.
 */
export function computeCanonicalInstanceBounds(
  state: ProjectState,
  assets: AssetRepository,
  instanceIds: readonly InstanceId[],
  options: CanonicalInstanceBoundsOptions = {},
): CanonicalBounds3 {
  if (instanceIds.length === 0) throw new Error('Canonical bounds require at least one instance');
  const seen = new Set<InstanceId>();
  const includedRoles = options.volumeRoles ? new Set(options.volumeRoles) : undefined;
  const descriptors = new Map(state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
  const verticesByAsset = new Map<string, ReadonlyArray<readonly [number, number, number]>>();
  const result = emptyBounds();

  for (const instanceId of instanceIds) {
    if (seen.has(instanceId)) throw new Error(`Canonical bounds contain duplicate instance ${instanceId}`);
    seen.add(instanceId);
    const found = findInstance(state, instanceId);
    if (!found) throw new Error(`Unknown instance ${instanceId}`);

    for (const volume of found.object.volumes) {
      if (includedRoles && !includedRoles.has(volume.role)) continue;
      const descriptor = descriptors.get(volume.source.assetId);
      const payload = assets.get(volume.source.assetId);
      if (!descriptor || !payload) {
        throw new Error(`Volume ${volume.id} references missing asset ${volume.source.assetId}`);
      }
      if (canonicalStringify(descriptor) !== canonicalStringify(payload.descriptor)) {
        throw new Error(`Asset repository metadata differs for ${volume.source.assetId}`);
      }
      let vertices = verticesByAsset.get(volume.source.assetId);
      if (!vertices) {
        vertices = decodeIndexedMeshAsset(payload).vertices;
        verticesByAsset.set(volume.source.assetId, vertices);
      }
      for (const vertex of vertices) {
        const volumePoint = applyTransform(vertex, volume.transform);
        include(result, applyTransform(volumePoint, found.instance.transform));
      }
    }
  }

  if (!result.min.every(Number.isFinite) || !result.max.every(Number.isFinite)) {
    throw new Error('Selected instances contain no bounded mesh geometry');
  }
  return Object.freeze({
    min: Object.freeze([...result.min]) as Vec3,
    max: Object.freeze([...result.max]) as Vec3,
  });
}

function emptyBounds(): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

function include(bounds: { min: [number, number, number]; max: [number, number, number] }, point: Vec3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function applyTransform(point: Vec3, transform: Transform): Vec3 {
  const scaled: Vec3 = [point[0] * transform.scale[0], point[1] * transform.scale[1], point[2] * transform.scale[2]];
  const rotated = rotateVector(transform.rotation, scaled);
  return [
    rotated[0] + transform.translationMm[0],
    rotated[1] + transform.translationMm[1],
    rotated[2] + transform.translationMm[2],
  ];
}

function rotateVector(quaternion: readonly [number, number, number, number], vector: Vec3): Vec3 {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (!Number.isFinite(length) || length === 0) throw new Error('A canonical transform quaternion must be non-zero');
  const x = quaternion[0] / length;
  const y = quaternion[1] / length;
  const z = quaternion[2] / length;
  const w = quaternion[3] / length;
  const uv: Vec3 = [y * vector[2] - z * vector[1], z * vector[0] - x * vector[2], x * vector[1] - y * vector[0]];
  const uuv: Vec3 = [y * uv[2] - z * uv[1], z * uv[0] - x * uv[2], x * uv[1] - y * uv[0]];
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}
