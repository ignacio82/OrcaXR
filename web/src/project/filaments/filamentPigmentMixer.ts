/**
 * Pure TypeScript port of the pinned `filament_mixer` byte-color pipeline.
 *
 * The polynomial feature order, coefficient accumulation order, float input
 * conversion, truncation, and sequential multi-color blend all mirror:
 * - `libslic3r/filament_mixer_model.h`
 * - `slic3r/GUI/MixedGradientSelector.cpp`
 * - `slic3r/GUI/MixedFilamentColorMapPanel.cpp`
 */
import { COEF, INTERCEPT, N_FEATURES, N_INPUTS, POWERS } from './filamentMixerModel';

export type FilamentRgb = readonly [red: number, green: number, blue: number];
export type WeightedFilamentColor = readonly [color: string, weight: number];

export const ORCA_INVALID_COLOR_FALLBACK = '#26A69A' as const;

/**
 * Parse the six-digit HTML colors supplied by the project. This intentionally
 * reproduces `parse_mixed_color`'s teal fallback for malformed palette data.
 */
export function parseOrcaMixedColor(value: string): FilamentRgb {
  if (typeof value !== 'string') return Object.freeze([38, 166, 154]);
  const normalized = value.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(normalized)) return Object.freeze([38, 166, 154]);
  return Object.freeze([
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ]);
}

export function filamentRgbToHex(rgb: FilamentRgb): string {
  assertRgb(rgb);
  return `#${rgb.map((channel) => channel.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

/**
 * Exact 330-feature degree-four pigment interpolation. `t` is converted to a
 * C++ `float` at the function boundary before the double polynomial executes.
 */
export function mixFilamentPigmentRgb(left: FilamentRgb, right: FilamentRgb, t: number): FilamentRgb {
  assertRgb(left);
  assertRgb(right);
  if (!Number.isFinite(t)) throw new RangeError('Pigment mix ratio must be finite');

  const floatT = Math.fround(t);
  if (floatT <= 0) return Object.freeze([...left] as [number, number, number]);
  if (floatT >= 1) return Object.freeze([...right] as [number, number, number]);

  const inputs = [left[0], left[1], left[2], right[0], right[1], right[2], floatT];
  const output = [INTERCEPT[0], INTERCEPT[1], INTERCEPT[2]];
  for (let featureIndex = 0; featureIndex < N_FEATURES; featureIndex += 1) {
    let feature = 1;
    for (let inputIndex = 0; inputIndex < N_INPUTS; inputIndex += 1) {
      const exponent = POWERS[featureIndex * N_INPUTS + inputIndex];
      if (exponent === 0) continue;
      const base = inputs[inputIndex];
      let power = 1;
      for (let powerIndex = 0; powerIndex < exponent; powerIndex += 1) power *= base;
      feature *= power;
    }
    const coefficientOffset = featureIndex * 3;
    output[0] += feature * COEF[coefficientOffset];
    output[1] += feature * COEF[coefficientOffset + 1];
    output[2] += feature * COEF[coefficientOffset + 2];
  }

  return Object.freeze([
    clampByte(Math.trunc(output[0])),
    clampByte(Math.trunc(output[1])),
    clampByte(Math.trunc(output[2])),
  ]);
}

/** Pair blend used by `blend_pair_filament_mixer`. */
export function blendPairFilamentPigment(left: string, right: string, mixRight: number): string {
  return filamentRgbToHex(mixFilamentPigmentRgb(parseOrcaMixedColor(left), parseOrcaMixedColor(right), mixRight));
}

/**
 * Sequential weighted blend used by `blend_multi_filament_mixer`. Callers
 * control color order because this polynomial blend is not associative.
 */
export function blendMultiFilamentPigment(colors: readonly WeightedFilamentColor[]): string {
  let output: FilamentRgb | null = null;
  let accumulatedWeight = 0;
  for (const [color, rawWeight] of colors) {
    if (!Number.isFinite(rawWeight)) throw new RangeError('Pigment component weights must be finite');
    const weight = Math.max(0, rawWeight);
    if (weight <= 0) continue;
    const next = parseOrcaMixedColor(color);
    if (output === null) {
      output = next;
      accumulatedWeight = weight;
      continue;
    }
    const newTotal = accumulatedWeight + weight;
    if (newTotal <= 0) continue;
    output = mixFilamentPigmentRgb(output, next, Math.fround(weight / newTotal));
    accumulatedWeight = newTotal;
  }
  return output === null ? ORCA_INVALID_COLOR_FALLBACK : filamentRgbToHex(output);
}

function assertRgb(rgb: FilamentRgb): void {
  if (rgb.length !== 3 || rgb.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 255)) {
    throw new RangeError('RGB channels must be bytes');
  }
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}
