import * as THREE from 'three';
import type { InstanceId } from '../project/domain/ids';
import type { Transform, Vec3 } from '../project/domain/model';
import type { CanonicalBounds3 } from '../project/objects/bounds';
import type { MultiInstanceTransformOrigin } from './multiInstanceTransform';

/** What the workspace reads of the selection: its primary instance and every selected instance. */
export interface TransformProxySummary {
  readonly primaryInstanceId?: InstanceId;
  readonly selectedInstanceIds: readonly InstanceId[];
}

/** What the workspace reads of one instance. */
export interface TransformProxyInstance {
  readonly plateId: string;
  readonly transform: Transform;
}

/** The selection a transform acts on: its primary and the instances carried with it. */
export interface TransformProxySelection {
  readonly primaryInstanceId: InstanceId;
  readonly origins: readonly MultiInstanceTransformOrigin[];
}

/** The transform proxy's pose: position (mm), normalized quaternion `[x, y, z, w]` and scale. */
export interface TransformProxyPose {
  readonly position: Vec3;
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: Vec3;
}

/**
 * The primary instance and the selected instances on its plate, in selection
 * order (the primary alone when it is not among them), each with its
 * transform; none without a primary instance the project has.
 */
export function selectedInstanceOrigins(
  summary: TransformProxySummary,
  getInstance: (instanceId: InstanceId) => TransformProxyInstance | undefined,
): TransformProxySelection | undefined {
  const primaryInstanceId = summary.primaryInstanceId;
  if (!primaryInstanceId) return undefined;
  const primary = getInstance(primaryInstanceId);
  if (!primary) return undefined;
  const selectedIds = summary.selectedInstanceIds.includes(primaryInstanceId)
    ? summary.selectedInstanceIds
    : [primaryInstanceId];
  const origins = selectedIds.flatMap((instanceId) => {
    const instance = getInstance(instanceId);
    return instance && instance.plateId === primary.plateId ? [{ instanceId, transform: instance.transform }] : [];
  });
  return origins.length > 0 ? { primaryInstanceId, origins: Object.freeze(origins) } : undefined;
}

/**
 * Where the transform gizmo's proxy stands for a selection: one instance's own
 * pose (its quaternion normalized), or the centre of a selection's bounds with
 * no rotation and unit scale.
 */
export function transformProxyPose(
  selection: TransformProxySelection,
  getInstance: (instanceId: InstanceId) => TransformProxyInstance | undefined,
  getInstanceBounds: (instanceIds: readonly InstanceId[]) => CanonicalBounds3,
): TransformProxyPose | undefined {
  if (selection.origins.length > 1) {
    const bounds = getInstanceBounds(selection.origins.map((origin) => origin.instanceId));
    return {
      position: [
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      ],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }
  const instance = getInstance(selection.primaryInstanceId);
  if (!instance) return undefined;
  const [x, y, z, w] = new THREE.Quaternion().fromArray(instance.transform.rotation).normalize().toArray();
  return {
    position: [...instance.transform.translationMm],
    quaternion: [x, y, z, w],
    scale: [...instance.transform.scale],
  };
}
