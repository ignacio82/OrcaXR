/**
 * Checking a compiled plan against its own declared assertions (P8.3, P8.2).
 *
 * The compiler emits `sliceAssertions` — machine-readable statements about what
 * a correct plan for this definition looks like — and nothing evaluated them.
 * An assertion nobody runs is decoration: it reads like a guarantee in the
 * plan JSON, in an evidence row, and in a review, while guaranteeing nothing.
 *
 * Each assertion is evaluated by its `kind` rather than by parsing its `path`
 * as a general expression. That is deliberate. There are seven kinds, all
 * declared in the pinned types; a generic path evaluator would silently return
 * `undefined` for a path it did not understand and report a pass, which is the
 * exact failure this module exists to prevent.
 *
 * What this is and is not worth, plainly: several of these assertions are
 * computed by the compiler from the same plan they describe, so on a
 * freshly-compiled plan they are near-tautological. Their value is on a plan
 * that has *travelled* — stored, transported, edited, or handed through a
 * consumer that dropped or rewrote effects. That is the case where a
 * calibration silently stops being one, and it is the case nothing was
 * checking.
 */

import type { CalibrationJobPlan, CalibrationSliceAssertion } from './types';

export interface CalibrationAssertionResult {
  readonly assertion: CalibrationSliceAssertion;
  readonly satisfied: boolean;
  /** What the plan actually held, for a message that can be acted on. */
  readonly actual: unknown;
}

export interface CalibrationVerification {
  readonly satisfied: boolean;
  readonly results: readonly CalibrationAssertionResult[];
  readonly failures: readonly CalibrationAssertionResult[];
}

/**
 * Returned when an assertion's path is not one this evaluator understands.
 *
 * A distinct sentinel rather than `undefined`, because `undefined` compares
 * unequal to everything and would read as an ordinary failed assertion — which
 * looks like a broken plan instead of a broken checker.
 */
const UNREADABLE_PATH = Symbol('unreadable-assertion-path');

function compare(operator: CalibrationSliceAssertion['operator'], actual: unknown, expected: unknown): boolean {
  if (actual === UNREADABLE_PATH) return false;
  if (operator === 'equals') return actual === expected;
  if (operator === 'less-than-or-equal') {
    return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
}

function actualFor(plan: CalibrationJobPlan, assertion: CalibrationSliceAssertion): unknown {
  switch (assertion.kind) {
    case 'effect-count':
      return plan.effects.length;
    case 'label-count':
      return plan.expectedLabels.length;
    case 'actionable-effects':
      // Deliberately the compiler's own predicate, copied rather than
      // reinterpreted (`compiler.ts:966`). A first version counted only
      // overrides and G-code and so failed `tolerance-extension`, whose effects
      // are placed gauges that change nothing but their position — a placed
      // piece *is* an action, and deciding otherwise here would have meant this
      // checker quietly disagreeing with the thing it checks.
      return plan.effects.filter(
        (effect) =>
          effect.engineOverrides.length > 0 ||
          effect.customGcode !== null ||
          effect.positionMm !== null ||
          effect.lineMm !== null,
      ).length;
    case 'z-range':
      return plan.geometry.requiredEnvelopeMm[2];
    case 'resource-blob': {
      // A workflow can pin several resources — the input-shaping family names
      // two towers — and each gets its own assertion carrying its index. An
      // earlier version read `resources[0]` for all of them and reported a
      // false failure on the second; reading the index from the path is the
      // whole of the fix, and an unparseable path is reported rather than
      // quietly compared against nothing.
      const match = /^\$\.geometry\.resources\[(\d+)\]\.blob$/.exec(assertion.path);
      if (!match) return UNREADABLE_PATH;
      return plan.geometry.resources[Number(match[1])]?.blob;
    }
    case 'override-key':
      return plan.effects.flatMap((effect) => effect.engineOverrides.map((override) => override.key));
    case 'gcode-prefix':
      return plan.effects.map((effect) => effect.customGcode ?? '').join('\n');
  }
}

/**
 * Evaluate every assertion a plan carries.
 *
 * An unknown kind cannot reach here — the switch above is exhaustive over the
 * pinned union, so adding a kind upstream fails the build rather than passing
 * silently, which is the property that keeps this honest as the definitions
 * change.
 */
export function verifyCalibrationPlan(plan: CalibrationJobPlan): CalibrationVerification {
  const results = plan.sliceAssertions.map((assertion) => {
    const actual = actualFor(plan, assertion);
    return Object.freeze({
      assertion,
      actual,
      satisfied: compare(assertion.operator, actual, assertion.expected),
    });
  });
  const failures = results.filter((result) => !result.satisfied);
  return Object.freeze({
    satisfied: failures.length === 0,
    results: Object.freeze(results),
    failures: Object.freeze(failures),
  });
}

/** A failure said in terms an operator can act on rather than a path. */
export function describeAssertionFailure(result: CalibrationAssertionResult): string {
  const { assertion, actual } = result;
  const expected = JSON.stringify(assertion.expected);
  switch (assertion.kind) {
    case 'effect-count':
      return `expected ${expected} bands, the plan has ${String(actual)}`;
    case 'label-count':
      return `expected ${expected} labels, the plan has ${String(actual)}`;
    case 'actionable-effects':
      return `expected ${expected} bands that actually change something, the plan has ${String(actual)}`;
    case 'z-range':
      return `the print would be ${String(actual)} mm tall, above the ${expected} mm this calibration allows`;
    case 'resource-blob':
      return actual === UNREADABLE_PATH
        ? `this build cannot evaluate the assertion at ${assertion.path}`
        : `the geometry is ${String(actual)}, not the audited ${expected}`;
    case 'override-key':
      return `no band sets ${expected}`;
    case 'gcode-prefix':
      return `no band emits ${expected}`;
  }
}
