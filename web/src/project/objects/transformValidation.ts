import type { Transform } from '../domain/model';

/**
 * A copy of an instance transform the workspace will submit, or the reason it
 * cannot: every value finite, no zero scale and a non-zero rotation.
 */
export function cloneAndValidateTransform(transform: Transform): Transform {
  const clone: Transform = {
    translationMm: [...transform.translationMm] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number],
  };
  if (
    clone.translationMm.length !== 3 ||
    clone.rotation.length !== 4 ||
    clone.scale.length !== 3 ||
    [...clone.translationMm, ...clone.rotation, ...clone.scale].some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Instance transform must contain finite translation, rotation, and scale values');
  }
  if (clone.scale.some((value) => Math.abs(value) < 1e-12)) {
    throw new Error('Instance transform scale cannot contain zero');
  }
  const quaternionNorm = clone.rotation.reduce((total, value) => total + value * value, 0);
  if (quaternionNorm < 1e-12) throw new Error('Instance transform rotation cannot be zero');
  return clone;
}
