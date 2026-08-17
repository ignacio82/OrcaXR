/**
 * The line body of a pressure-advance sweep (P8.2).
 *
 * `pressure-advance-line` and `pressure-advance-pattern` are not sliced
 * projects. Their lines all sit in one layer and differ only in Y, so no model
 * can distinguish them; upstream generates the G-code directly. This generates
 * the part of that program which encodes the calibration: for each line, the
 * command that sets its value, a travel to its start, and an extruding move to
 * its end.
 *
 * **It deliberately does not emit a complete, printable program, and that is a
 * safety decision rather than an unfinished one.** A program needs the
 * printer's own preamble, and on the Snapmaker U1 that preamble is 5,623
 * characters carrying 44 template tokens: bed mesh calibration, nozzle
 * cleaning at discard positions, per-extruder auto-feed and flow calibration,
 * `{if curr_bed_type == …}` branches choosing a Z offset, and expressions like
 * `{nozzle_temperature[initial_extruder] - 90}`. Evaluating those is the
 * slicer's job and this module cannot do it. Substituting a hand-written
 * preamble would produce a file that looks complete and skips bed levelling
 * and nozzle cleaning on someone's actual machine — the failure mode is a
 * toolhead into a bed, not a bad measurement.
 *
 * So the body is emitted on its own, and {@link pressureAdvanceLineProgram}
 * says what still has to be wrapped around it.
 */

import type { CalibrationJobPlan } from './types';

export interface LineProgramOptions {
  /** Layer height the lines are drawn at, in millimetres. */
  readonly layerHeightMm: number;
  /** Extrusion width, in millimetres. */
  readonly lineWidthMm: number;
  /** Filament diameter, in millimetres. */
  readonly filamentDiameterMm: number;
  /** Printing feed rate for the extruding moves, in mm/min. */
  readonly printFeedMmPerMin: number;
  /** Travel feed rate between lines, in mm/min. */
  readonly travelFeedMmPerMin: number;
}

export interface LineProgram {
  /** G-code for the calibration itself, with no machine preamble. */
  readonly body: string;
  /** Number of lines drawn. */
  readonly lines: number;
  /** Total filament this body extrudes, in millimetres. */
  readonly filamentMm: number;
  /**
   * What still has to be supplied for this to be printable. Non-empty by
   * design; a caller that ignores it produces a file no printer should run.
   */
  readonly missing: readonly string[];
}

export class LineProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineProgramError';
  }
}

function round(value: number, decimals: number): string {
  return Number(value.toFixed(decimals)).toString();
}

/**
 * Filament length for one extruding move.
 *
 * A rectangular bead of `width × height × length` in filament of the given
 * diameter. Upstream uses the same rectangular approximation; being exact about
 * the bead's rounded ends would change the answer by less than the flow
 * variation the test is measuring.
 */
export function extrusionForLine(
  lengthMm: number,
  options: Pick<LineProgramOptions, 'layerHeightMm' | 'lineWidthMm' | 'filamentDiameterMm'>,
): number {
  const filamentArea = Math.PI * (options.filamentDiameterMm / 2) ** 2;
  if (!(filamentArea > 0)) throw new LineProgramError('Filament diameter must be positive');
  return (lengthMm * options.lineWidthMm * options.layerHeightMm) / filamentArea;
}

/**
 * The calibration body for a single-layer line sweep.
 *
 * Refuses a plan whose lines are not all at one height: that is the property
 * that makes this a line program rather than a sliced tower, and a plan
 * violating it is a different shape being fed to the wrong generator.
 */
export function pressureAdvanceLineProgram(plan: CalibrationJobPlan, options: LineProgramOptions): LineProgram {
  const lines = plan.effects.filter((effect) => effect.lineMm !== null);
  if (lines.length === 0) throw new LineProgramError(`${plan.definitionId} has no lines to draw`);
  const heights = new Set(lines.map((effect) => effect.lineMm!.start[2]));
  if (heights.size !== 1) {
    throw new LineProgramError(
      `${plan.definitionId} draws at ${heights.size} heights; this generator is for one-layer sweeps`,
    );
  }
  if (lines.length !== plan.effects.length) {
    throw new LineProgramError(`${plan.definitionId} mixes line effects with others; nothing was generated`);
  }

  const z = [...heights][0];
  const out: string[] = [
    `; OrcaXR calibration body: ${plan.definitionId}`,
    `; ${lines.length} lines at z ${z} mm — machine preamble NOT included`,
    'G90',
    'M83',
  ];
  let filamentMm = 0;

  for (const effect of lines) {
    const line = effect.lineMm!;
    const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
    const extrusion = extrusionForLine(length, options);
    filamentMm += extrusion;
    out.push(`; ${effect.label} (${effect.parameterKey} = ${String(effect.value)})`);
    // The command first, then the move it applies to. Emitting it after would
    // draw one line at the previous value, and every line would carry its
    // neighbour's setting — the same off-by-one that scrambles a flow plate.
    const command = (effect.customGcode ?? '').trim();
    if (command.length > 0) out.push(command);
    out.push(
      `G0 X${round(line.start[0], 3)} Y${round(line.start[1], 3)} Z${round(z, 3)} F${options.travelFeedMmPerMin}`,
    );
    out.push(
      `G1 X${round(line.end[0], 3)} Y${round(line.end[1], 3)} E${round(extrusion, 5)} F${options.printFeedMmPerMin}`,
    );
  }

  return Object.freeze({
    body: `${out.join('\n')}\n`,
    lines: lines.length,
    filamentMm,
    // Stated as data rather than prose so a caller cannot accidentally treat
    // this as printable. Every entry is something the slicer's template
    // evaluation supplies and this module cannot.
    missing: Object.freeze([
      'machine start G-code, including bed mesh calibration and nozzle cleaning',
      'bed and nozzle heating for the chosen filament',
      'machine end G-code',
    ]),
  });
}
