/**
 * Matching a resource's objects to a plan's effects (P8.2).
 *
 * A per-object calibration is a plate of pieces, each printed at a different
 * setting. The pieces come from an upstream resource and the settings come from
 * the compiled plan, and something has to say which piece gets which setting.
 *
 * The obvious answer — zip them in order — is wrong, and quietly so.
 * `flowrate-test-pass1.3mf` stores its nine patches in *lexicographic* name
 * order: `flowrate_0`, `flowrate_10`, `flowrate_15`, `flowrate_20`,
 * `flowrate_5`, `flowrate_m10`, … while the plan's effects run 0.8 → 1.2
 * ascending. Zipping by index would print the −20 % setting on the patch
 * labelled 0 %, and every patch after it would be wrong too. The plate would
 * slice, print, and measure beautifully, and the number it taught the operator
 * would be nonsense.
 *
 * So the match is by what the name *means*. `flowrate_m20` is −20 %, which is a
 * flow ratio of 0.8, which is the effect whose value is 0.8. If any piece fails
 * to find exactly one effect, the whole mapping is refused: a partially matched
 * plate is the scrambled plate above, with fewer pieces.
 */

import type { CalibrationPlanEffect } from './types';

export interface ResourceObjectMatch {
  /** Object name as the resource stores it. */
  readonly objectName: string;
  /** Index into the resource's object list. */
  readonly objectIndex: number;
  /** The effect whose setting this piece prints at. */
  readonly effect: CalibrationPlanEffect;
}

export interface ResourceObjectMapping {
  readonly matches: readonly ResourceObjectMatch[];
  /** Why the mapping was refused; empty when it holds. */
  readonly problems: readonly string[];
}

/**
 * Read the percentage a flow patch's name encodes.
 *
 * `flowrate_15` is +15 %, `flowrate_m15` is −15 %, `flowrate_0` is the
 * unmodified one. Returns `null` for a name that is not of this shape rather
 * than guessing a number out of it.
 */
export function flowPatchPercent(objectName: string): number | null {
  const match = /^flowrate_(m?)(\d+)$/.exec(objectName.trim());
  if (!match) return null;
  const magnitude = Number(match[2]);
  if (!Number.isFinite(magnitude)) return null;
  return match[1] === 'm' ? -magnitude : magnitude;
}

/** Compare ratios at the precision the plan states them in. */
function sameRatio(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

/**
 * Match a flow resource's patches to a flow plan's effects, by meaning.
 *
 * Refused rather than approximated when anything does not line up: an unmatched
 * piece, a piece matching two effects, or an effect no piece carries. Each of
 * those produces a plate that looks finished and measures something else.
 */
export function matchFlowPatches(
  objectNames: readonly string[],
  effects: readonly CalibrationPlanEffect[],
): ResourceObjectMapping {
  const problems: string[] = [];
  const matches: ResourceObjectMatch[] = [];
  const usedEffects = new Set<number>();

  objectNames.forEach((objectName, objectIndex) => {
    const percent = flowPatchPercent(objectName);
    if (percent === null) {
      problems.push(`“${objectName}” is not a flow patch name, so nothing can say what it should print at`);
      return;
    }
    const ratio = 1 + percent / 100;
    const candidates = effects
      .map((effect, index) => ({ effect, index }))
      .filter((entry) => typeof entry.effect.value === 'number' && sameRatio(entry.effect.value, ratio));
    if (candidates.length === 0) {
      problems.push(`“${objectName}” wants a flow ratio of ${ratio}, which this plan does not contain`);
      return;
    }
    if (candidates.length > 1) {
      problems.push(`“${objectName}” matches ${candidates.length} effects at ${ratio}; the plan is ambiguous`);
      return;
    }
    usedEffects.add(candidates[0].index);
    matches.push({ objectName, objectIndex, effect: candidates[0].effect });
  });

  for (const [index, effect] of effects.entries()) {
    if (!usedEffects.has(index)) {
      problems.push(`no piece on the plate prints at ${String(effect.value)}, so that band would be missing`);
    }
  }

  return Object.freeze({
    matches: Object.freeze(problems.length === 0 ? matches : []),
    problems: Object.freeze(problems),
  });
}
