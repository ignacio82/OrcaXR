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
  const positionsByAsset = new Map<string, Float32Array>();
  const result = emptyBounds();

  for (const instanceId of instanceIds) {
    if (seen.has(instanceId)) throw new Error(`Canonical bounds contain duplicate instance ${instanceId}`);
    seen.add(instanceId);
    const found = findInstance(state, instanceId);
    if (!found) throw new Error(`Unknown instance ${instanceId}`);

    for (const volume of found.object.volumes) {
      if (includedRoles && !includedRoles.has(volume.role)) continue;
      const descriptor = descriptors.get(volume.source.assetId);
      // Read-only: copying the bytes just to measure them is a memcpy of the
      // whole mesh, and this runs on every placement and preflight.
      const payload = assets.peek(volume.source.assetId);
      if (!descriptor || !payload) {
        throw new Error(`Volume ${volume.id} references missing asset ${volume.source.assetId}`);
      }
      if (canonicalStringify(descriptor) !== canonicalStringify(payload.descriptor)) {
        throw new Error(`Asset repository metadata differs for ${volume.source.assetId}`);
      }
      let positions = positionsByAsset.get(volume.source.assetId);
      if (!positions) {
        positions = decodeIndexedMeshAsset(payload).positions;
        positionsByAsset.set(volume.source.assetId, positions);
      }
      accumulateTransformedBounds(result, positions, volume.transform, found.instance.transform);
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

/**
 * Walk packed vertices through the volume and then the instance transform,
 * widening `bounds` as it goes.
 *
 * This is deliberately the same arithmetic as `applyTransform` composed twice,
 * written out in locals: every expression and its evaluation order is
 * unchanged, so the result is bit-identical, but a mesh of a million vertices
 * no longer allocates five short-lived arrays per vertex per transform, and the
 * quaternions are normalized once instead of two million times.
 */
function accumulateTransformedBounds(
  bounds: { min: [number, number, number]; max: [number, number, number] },
  positions: Float32Array,
  volume: Transform,
  instance: Transform,
): void {
  const [vqx, vqy, vqz, vqw] = normalizedQuaternion(volume.rotation);
  const [iqx, iqy, iqz, iqw] = normalizedQuaternion(instance.rotation);
  const [vsx, vsy, vsz] = volume.scale;
  const [isx, isy, isz] = instance.scale;
  const [vtx, vty, vtz] = volume.translationMm;
  const [itx, ity, itz] = instance.translationMm;
  let minX = bounds.min[0];
  let minY = bounds.min[1];
  let minZ = bounds.min[2];
  let maxX = bounds.max[0];
  let maxY = bounds.max[1];
  let maxZ = bounds.max[2];

  for (let offset = 0; offset < positions.length; offset += 3) {
    // Volume transform: scale, rotate, translate.
    let x = positions[offset] * vsx;
    let y = positions[offset + 1] * vsy;
    let z = positions[offset + 2] * vsz;
    let uvX = vqy * z - vqz * y;
    let uvY = vqz * x - vqx * z;
    let uvZ = vqx * y - vqy * x;
    let uuvX = vqy * uvZ - vqz * uvY;
    let uuvY = vqz * uvX - vqx * uvZ;
    let uuvZ = vqx * uvY - vqy * uvX;
    x = x + 2 * (vqw * uvX + uuvX) + vtx;
    y = y + 2 * (vqw * uvY + uuvY) + vty;
    z = z + 2 * (vqw * uvZ + uuvZ) + vtz;

    // Instance transform, applied to the volume-space point.
    x *= isx;
    y *= isy;
    z *= isz;
    uvX = iqy * z - iqz * y;
    uvY = iqz * x - iqx * z;
    uvZ = iqx * y - iqy * x;
    uuvX = iqy * uvZ - iqz * uvY;
    uuvY = iqz * uvX - iqx * uvZ;
    uuvZ = iqx * uvY - iqy * uvX;
    x = x + 2 * (iqw * uvX + uuvX) + itx;
    y = y + 2 * (iqw * uvY + uuvY) + ity;
    z = z + 2 * (iqw * uvZ + uuvZ) + itz;

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  bounds.min[0] = minX;
  bounds.min[1] = minY;
  bounds.min[2] = minZ;
  bounds.max[0] = maxX;
  bounds.max[1] = maxY;
  bounds.max[2] = maxZ;
}

function normalizedQuaternion(quaternion: readonly [number, number, number, number]): [number, number, number, number] {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (!Number.isFinite(length) || length === 0) throw new Error('A canonical transform quaternion must be non-zero');
  return [quaternion[0] / length, quaternion[1] / length, quaternion[2] / length, quaternion[3] / length];
}
