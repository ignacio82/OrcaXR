import type { InstanceId } from '../project/domain/ids';
import type { Transform, Vec3 } from '../project/domain/model';
import type { InstanceTransformChange } from '../project/objects/transformCommands';

export type MultiInstanceTransformMode = 'move' | 'rotate' | 'scale';

export interface MultiInstanceTransformOrigin {
  readonly instanceId: InstanceId;
  readonly transform: Transform;
}

/**
 * Project one TransformControls proxy delta over an exact stable-ID selection.
 *
 * The caller supplies the immutable pivot captured at gesture start and the
 * current proxy transform. Translation is shared directly, rotation carries
 * every placement around that pivot, and non-uniform scale is applied in the
 * pivot's initial local axes. Re-projecting from the captured origins prevents
 * streamed updates from accumulating floating-point drift.
 */
export function projectMultiInstanceTransform(
  origins: readonly MultiInstanceTransformOrigin[],
  initialPivotTransform: Transform,
  currentPivotTransform: Transform,
  mode: MultiInstanceTransformMode,
): readonly InstanceTransformChange[] {
  validateOrigins(origins);
  const initialPivot = initialPivotTransform.translationMm;
  const currentPivot = currentPivotTransform.translationMm;
  const translationDelta = subtract(currentPivot, initialPivot);
  const initialPivotRotation = normalizeQuaternion(initialPivotTransform.rotation);
  const currentPivotRotation = normalizeQuaternion(currentPivotTransform.rotation);
  const rotationDelta = multiplyQuaternion(currentPivotRotation, inverseQuaternion(initialPivotRotation));
  const scaleRatio = divideScale(currentPivotTransform.scale, initialPivotTransform.scale);

  return Object.freeze(
    origins.map((origin) => {
      let transform: Transform;
      switch (mode) {
        case 'move':
          transform = {
            ...cloneTransform(origin.transform),
            translationMm: add(origin.transform.translationMm, translationDelta),
          };
          break;
        case 'rotate': {
          const relative = subtract(origin.transform.translationMm, initialPivot);
          transform = {
            ...cloneTransform(origin.transform),
            translationMm: add(currentPivot, rotateVector(rotationDelta, relative)),
            rotation: normalizeQuaternion(multiplyQuaternion(rotationDelta, origin.transform.rotation)),
          };
          break;
        }
        case 'scale': {
          const relativeWorld = subtract(origin.transform.translationMm, initialPivot);
          const relativeLocal = rotateVector(inverseQuaternion(initialPivotRotation), relativeWorld);
          const scaledRelativeLocal = multiplyComponents(relativeLocal, scaleRatio);
          transform = {
            ...cloneTransform(origin.transform),
            translationMm: add(currentPivot, rotateVector(initialPivotRotation, scaledRelativeLocal)),
            scale: multiplyComponents(origin.transform.scale, scaleRatio),
          };
          break;
        }
      }
      return Object.freeze({ instanceId: origin.instanceId, transform });
    }),
  );
}

/**
 * Apply a numeric edit to the primary instance while carrying the rest of the
 * exact selection around that primary pivot.
 */
export function projectMultiInstancePrimaryTransform(
  origins: readonly MultiInstanceTransformOrigin[],
  primaryInstanceId: InstanceId,
  currentPrimaryTransform: Transform,
  mode: MultiInstanceTransformMode,
): readonly InstanceTransformChange[] {
  validateOrigins(origins);
  const primary = origins.find((origin) => origin.instanceId === primaryInstanceId);
  if (!primary) throw new Error(`Multi-instance transform is missing primary instance ${primaryInstanceId}`);
  const projected = projectMultiInstanceTransform(origins, primary.transform, currentPrimaryTransform, mode);
  return Object.freeze(
    projected.map((change) =>
      change.instanceId === primaryInstanceId
        ? Object.freeze({
            instanceId: change.instanceId,
            transform: cloneTransform(currentPrimaryTransform),
          })
        : change,
    ),
  );
}

function validateOrigins(origins: readonly MultiInstanceTransformOrigin[]): void {
  if (origins.length === 0) throw new Error('A multi-instance transform requires at least one origin');
  const ids = new Set<InstanceId>();
  for (const origin of origins) {
    if (ids.has(origin.instanceId)) {
      throw new Error(`Multi-instance transform contains duplicate instance ${origin.instanceId}`);
    }
    ids.add(origin.instanceId);
  }
}

function cloneTransform(transform: Transform): Transform {
  return {
    translationMm: [...transform.translationMm],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function multiplyComponents(left: Vec3, right: Vec3): Vec3 {
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2]];
}

function divideScale(current: Vec3, initial: Vec3): Vec3 {
  if (initial.some((value) => value === 0)) throw new Error('A transform origin scale cannot contain zero');
  return [current[0] / initial[0], current[1] / initial[1], current[2] / initial[2]];
}

function normalizeQuaternion(
  quaternion: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (!Number.isFinite(length) || length === 0) throw new Error('A transform quaternion must be finite and non-zero');
  return [quaternion[0] / length, quaternion[1] / length, quaternion[2] / length, quaternion[3] / length];
}

function inverseQuaternion(
  quaternion: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const normalized = normalizeQuaternion(quaternion);
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]];
}

function multiplyQuaternion(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ];
}

function rotateVector(quaternion: readonly [number, number, number, number], vector: Vec3): Vec3 {
  const [x, y, z, w] = normalizeQuaternion(quaternion);
  const uv: Vec3 = [y * vector[2] - z * vector[1], z * vector[0] - x * vector[2], x * vector[1] - y * vector[0]];
  const uuv: Vec3 = [y * uv[2] - z * uv[1], z * uv[0] - x * uv[2], x * uv[1] - y * uv[0]];
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}
