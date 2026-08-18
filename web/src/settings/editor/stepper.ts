/**
 * Stepping an engine setting, for surfaces with no keyboard (P6.5).
 *
 * P6.5 asks that project, plate, object, part and height-range overrides share
 * one draft and one validation across desktop, touch and XR — and XR had no
 * scoped-settings surface at all, because entering a value there means typing.
 * Calibration parameters solved that with steppers (`EVID-085`), and the same
 * answer applies here with one important difference: a calibration definition
 * declares its own `step`, and an engine option does not.
 *
 * So the increment is derived from the option's own range, and **an option with
 * no range gets no stepper**. That is the rule already applied to the brim-ear
 * radius and the SVG size: a stepper without bounds is a text field with extra
 * presses, and it would let a headset reach a value the DOM would refuse. An
 * unbounded option stays reachable through the DOM panel and says so, rather
 * than being offered here in a form that cannot be trusted.
 */

import { enumChoicesFor, parseSettingDraft, serializeSettingValue } from './codec';
import type { EngineOptionDefinition } from '../generated/types';

/** Why an option cannot be stepped, for a surface that must explain itself. */
export type StepRefusal = 'not-numeric' | 'unbounded' | 'unreadable' | 'read-only';

/** Human phrasing for each refusal, for a surface that must explain itself. */
export const STEP_REFUSAL_REASON: Readonly<Record<StepRefusal, string>> = Object.freeze({
  'not-numeric': 'This setting is not a bounded number, so it is edited in the settings panel.',
  unbounded: 'This setting has no declared limits, so stepping it could reach a value the engine refuses.',
  unreadable: 'This setting’s current value cannot be read as a number.',
  'read-only': 'This setting is read-only.',
});

export interface StepOutcome {
  /** The next serialized value, or null when it cannot be stepped. */
  readonly value: string | null;
  readonly refusal?: StepRefusal;
}

/**
 * One press worth of change for a bounded range.
 *
 * A hundredth of the span, snapped to a power of ten so the numbers a person
 * reads stay round — 0.1 rather than 0.137. Clamped to at least one decimal
 * place of movement so a wide range does not produce a step so large that two
 * presses cross the whole span.
 */
export function stepFor(minimum: number, maximum: number): number {
  const span = Math.abs(maximum - minimum);
  if (!(span > 0)) return 0;
  const rough = span / 100;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const snapped = magnitude * (rough / magnitude >= 5 ? 5 : rough / magnitude >= 2 ? 2 : 1);
  return snapped > 0 ? snapped : span;
}

function decimalsOf(step: number): number {
  const text = step.toString();
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * The value one press up or down from `current`.
 *
 * Booleans toggle and enums cycle, because the definition enumerates them and
 * there is nothing to type. Numbers step within their own bounds. Everything
 * else refuses with a reason rather than guessing.
 */
export function stepSettingValue(definition: EngineOptionDefinition, current: string, direction: 1 | -1): StepOutcome {
  if (definition.presentation.readonly.value) return { value: null, refusal: 'read-only' };

  const choices = enumChoicesFor(definition);
  if (choices.length > 0) {
    const index = choices.findIndex((choice) => choice.serialized === current);
    const from = index === -1 ? 0 : index;
    // Cycles rather than stopping: a ring of choices has no end to bump into.
    return { value: choices[(from + direction + choices.length) % choices.length].serialized };
  }

  const type = definition.storage.optionType;
  if (type === 'coBool') {
    return { value: current === '1' || current === 'true' ? '0' : '1' };
  }
  // Scalars only. A vector option needs a component chosen before it can be
  // stepped, and a stepper that silently moved the first one would edit a
  // setting the operator did not name.
  if (!['coFloat', 'coInt', 'coPercent'].includes(type)) {
    // `coFloatOrPercent` is deliberately absent. It holds either `50` or `50%`
    // and its declared bounds do not say which of the two they constrain, so a
    // step would be guessing at the units — and a percent stepped as an
    // absolute silently rewrites the setting's meaning. It stays a typed field.
    return { value: null, refusal: 'not-numeric' };
  }

  const minimum = definition.constraints.min.value;
  const maximum = definition.constraints.max.value;
  if (minimum === null || maximum === null) return { value: null, refusal: 'unbounded' };

  const parsed = parseSettingDraft(definition, current);
  const numeric = parsed.ok && typeof parsed.value === 'number' ? parsed.value : Number.parseFloat(current);
  if (!Number.isFinite(numeric)) return { value: null, refusal: 'unreadable' };

  const step = stepFor(minimum, maximum);
  if (!(step > 0)) return { value: null, refusal: 'unbounded' };
  // Rounded to the step's own precision first — floating point otherwise shows
  // an operator 0.30000000000000004 — and clamped *after*, because rounding can
  // move a value back across a limit. A setting bounded at 0.1 with a step of 1
  // rounds to 0 and the serializer rightly refuses it; clamping last is what
  // makes the result always a value the schema accepts.
  const raw = numeric + direction * step;
  const rounded = Number(raw.toFixed(decimalsOf(step)));
  const integral = type === 'coInt' ? Math.round(rounded) : rounded;
  const next = Math.min(maximum, Math.max(minimum, integral));
  return { value: serializeSettingValue(definition, next) };
}
