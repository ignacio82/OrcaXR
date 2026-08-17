/**
 * Reading the printed calibration (P8.3).
 *
 * A calibration print is useless without the key to it. The operator is holding
 * a tower with nine bands and has to know which band was which value, where to
 * look, and what to measure — and getting that mapping wrong is worse than
 * having no instructions at all, because it produces a confident answer that is
 * off by one band and then writes it into a preset.
 *
 * So this is derived from the compiled plan's own effects rather than
 * re-deriving values from the parameters. The effects are what
 * `applyCalibrationPlan` installed; reading the instructions from the same
 * place means the sheet and the G-code cannot disagree, whatever the compiler
 * does with a formula in between.
 */

import type { CalibrationJobPlan, CalibrationPlanEffect } from './types';
import type { CalibrationResultField } from '../../features/calibrationInventory';

/** One thing the operator can point at on the finished print. */
export interface CalibrationBandInstruction {
  /** 1-based, as an operator counts them off the print. */
  readonly ordinal: number;
  readonly label: string;
  readonly parameterKey: string;
  readonly value: string | number;
  readonly unit: string | null;
  /** Height band on the model, when this effect has one. */
  readonly zRangeMm: readonly [number, number] | null;
}

export interface CalibrationInstructions {
  readonly title: string;
  readonly bands: readonly CalibrationBandInstruction[];
  /** What to measure once the print is off the bed. */
  readonly measurements: readonly CalibrationResultField[];
  /** Where a recorded result will be written, so it is never a surprise. */
  readonly writesTo: readonly string[];
  /**
   * Said plainly when the bands are not stacked in height: a flow plate's
   * patches are laid out across the bed, and "the third band up" is then
   * wrong advice.
   */
  readonly layout: 'stacked-by-height' | 'placed-across-the-bed' | 'mixed';
}

function layoutOf(effects: readonly CalibrationPlanEffect[]): CalibrationInstructions['layout'] {
  const stacked = effects.some((effect) => effect.zRangeMm !== null);
  const placed = effects.some((effect) => effect.zRangeMm === null);
  if (stacked && placed) return 'mixed';
  return stacked ? 'stacked-by-height' : 'placed-across-the-bed';
}

/**
 * The key to a compiled calibration.
 *
 * Bands come out in the plan's own order, which is the order the effects were
 * compiled and installed in. Ordinals are 1-based because an operator counting
 * bands off a print starts at one, and an off-by-one here is precisely the
 * error that ends up in a preset.
 */
export function calibrationInstructions(plan: CalibrationJobPlan): CalibrationInstructions {
  const bands = plan.effects.map((effect, index) =>
    Object.freeze({
      ordinal: index + 1,
      label: effect.label,
      parameterKey: effect.parameterKey,
      value: effect.value,
      unit: effect.unit,
      zRangeMm: effect.zRangeMm,
    }),
  );
  return Object.freeze({
    title: plan.label,
    bands: Object.freeze(bands),
    measurements: plan.resultFields,
    writesTo: Object.freeze(plan.presetTargets.map((target) => `${target.scope}: ${target.key}`)),
    layout: layoutOf(plan.effects),
  });
}

/** How an operator is told to find a band, given how the print is laid out. */
export function describeBandLocation(
  band: CalibrationBandInstruction,
  layout: CalibrationInstructions['layout'],
): string {
  if (band.zRangeMm) {
    return `${band.zRangeMm[0]}–${band.zRangeMm[1]} mm from the bed`;
  }
  // No height means no "nth band up"; saying one anyway would send the operator
  // to the wrong part of the plate.
  return layout === 'placed-across-the-bed'
    ? `piece ${band.ordinal} on the plate`
    : `piece ${band.ordinal} (not stacked by height)`;
}
