/**
 * The transform inspector's fields (the Tool Settings panel of the Move,
 * Rotate and Scale tools): what each field shows for an instance's transform
 * and what an edit of the three fields sets. Move reads millimetres, Rotate
 * degrees of three's Euler angles in its default XYZ order, Scale percent; a
 * field shows two decimals and reads its text with `parseFloat`, unreadable
 * text as 0. The shared Rust core answers the same
 * (`orcaxr_project::placement::fields`, through `TransformFieldsExchange.ts`).
 */
import * as THREE from 'three';
import type { Transform } from '../project/domain/model';
import type { MultiInstanceTransformMode } from './multiInstanceTransform';

export type TransformFieldTool = MultiInstanceTransformMode;
type Triple = [number, number, number];

/** Each tool's panel title. */
export const TRANSFORM_FIELD_TITLES: Readonly<Record<TransformFieldTool, string>> = Object.freeze({
  move: 'Move (mm)',
  rotate: 'Rotate (deg)',
  scale: 'Scale (%)',
});

/** Euler angles (radians, XYZ) of a rotation quaternion `[x, y, z, w]`, as three reads it unnormalized. */
export function eulerFromQuaternion(rotation: Transform['rotation']): Triple {
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray([...rotation]));
  return [euler.x, euler.y, euler.z];
}

/** The normalized rotation quaternion `[x, y, z, w]` of Euler angles (radians, XYZ). */
export function quaternionFromEuler(angles: readonly [number, number, number]): [number, number, number, number] {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(angles[0], angles[1], angles[2])).normalize();
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

/** What a tool's three fields show for a transform: millimetres, degrees or percent. */
export function transformFieldValues(tool: TransformFieldTool, transform: Transform): Triple {
  if (tool === 'move') return [transform.translationMm[0], transform.translationMm[1], transform.translationMm[2]];
  if (tool === 'rotate') {
    const [x, y, z] = eulerFromQuaternion(transform.rotation);
    return [THREE.MathUtils.radToDeg(x), THREE.MathUtils.radToDeg(y), THREE.MathUtils.radToDeg(z)];
  }
  return [transform.scale[0] * 100, transform.scale[1] * 100, transform.scale[2] * 100];
}

/** A field's text for a value: two decimals. */
export function transformFieldText(value: number): string {
  return value.toFixed(2);
}

/** A field's value from its text: `parseFloat`, unreadable text (and -0) as 0. */
export function transformFieldValue(text: string): number {
  return parseFloat(text) || 0;
}

/** What three field values hand the workspace: millimetres, radians or scale factors. */
export function transformFieldInput(tool: TransformFieldTool, values: readonly [number, number, number]): Triple {
  if (tool === 'rotate') {
    return [
      THREE.MathUtils.degToRad(values[0]),
      THREE.MathUtils.degToRad(values[1]),
      THREE.MathUtils.degToRad(values[2]),
    ];
  }
  if (tool === 'scale') return [values[0] / 100, values[1] / 100, values[2] / 100];
  return [values[0], values[1], values[2]];
}

/** The transform a tool's input sets on [transform]: its translation, its rotation from Euler angles, or its scale. */
export function withTransformFieldInput(
  tool: TransformFieldTool,
  transform: Transform,
  input: readonly [number, number, number],
): Transform {
  if (tool === 'move') return { ...transform, translationMm: [input[0], input[1], input[2]] };
  if (tool === 'rotate') return { ...transform, rotation: quaternionFromEuler(input) };
  return { ...transform, scale: [input[0], input[1], input[2]] };
}
