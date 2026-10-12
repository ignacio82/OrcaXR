import type * as THREE from 'three';
import type { Transform } from '../project/domain/model';
import type { InstanceTransformChange } from '../project/objects/transformCommands';
import {
  projectMultiInstanceTransform,
  type MultiInstanceTransformMode,
  type MultiInstanceTransformOrigin,
} from './multiInstanceTransform';

/** The transform an object's pose submits: its position, its normalized quaternion and its scale. */
export function transformFromObject(object: THREE.Object3D): Transform {
  const quaternion = object.quaternion.clone().normalize();
  return {
    translationMm: [object.position.x, object.position.y, object.position.z],
    rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

/**
 * The changes a transform-gizmo drag submits for the proxy's current pose: the
 * one selected instance takes it as its transform; a selection is carried
 * around the pose the proxy had when the drag began.
 */
export function gizmoDragChanges(
  origins: readonly MultiInstanceTransformOrigin[],
  initialPivotTransform: Transform,
  current: Transform,
  mode: MultiInstanceTransformMode,
): readonly InstanceTransformChange[] {
  return origins.length > 1
    ? projectMultiInstanceTransform(origins, initialPivotTransform, current, mode)
    : [{ instanceId: origins[0].instanceId, transform: current }];
}
