/**
 * Stepping a calibration parameter, and nothing else.
 *
 * Its own module on purpose. The workspace renders XR steppers and needs this
 * arithmetic; importing it from `form.ts` pulled the compiler, the definitions
 * and the whole generated catalog into the main chunk — 84 KB every visitor
 * paid for four lines of arithmetic. This file imports a type and no code, so
 * it costs what it looks like it costs.
 */

import type { CalibrationFormField } from './form';

/**
 * One press of a stepper, in the units the definition declares (P8.3).
 *
 * This is how a headset enters a number. Several actions in this registry are
 * withheld from XR with the sentence "no in-headset number entry exists yet",
 * and a text field needs a keyboard nobody wants in a headset — but a
 * calibration parameter does not need free text. The definition carries a
 * `step` and a `range`, so the only values worth reaching are the ones a
 * decrement and an increment walk through.
 *
 * Bounds come from the definition, never from the surface: a stepper that
 * walked past a limit and then reported a compiler error would have lied about
 * what it could do. Returns `null` when there is nothing to step to.
 */
export function stepCalibrationValue(field: CalibrationFormField, direction: 1 | -1): string | null {
  if (!field.editable) return null;
  if (field.kind === 'boolean') return field.text === 'true' ? 'false' : 'true';
  if (field.kind === 'choice') {
    if (field.choices.length === 0) return null;
    const index = field.choices.indexOf(field.text);
    const from = index === -1 ? 0 : index;
    return field.choices[(from + direction + field.choices.length) % field.choices.length];
  }
  if (field.kind !== 'number') return null;
  const step = field.range?.step && field.range.step > 0 ? field.range.step : 1;
  const current = Number(field.text);
  if (!Number.isFinite(current)) return null;
  let next = current + direction * step;
  if (field.range) next = Math.min(field.range.max, Math.max(field.range.min, next));
  // Steps are often fractional, and floating point makes 0.1 + 0.2 into
  // something an operator should never be shown. Rounded to the step's own
  // precision rather than to a fixed one.
  const decimals = (String(step).split('.')[1] ?? '').length;
  return next.toFixed(decimals);
}
