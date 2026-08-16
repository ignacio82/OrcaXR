/**
 * Which calibrations a connected printer can actually measure for itself
 * (parity P8.4).
 *
 * P8.4's requirement is not "automate calibration" — it is that automation
 * which does not exist must be visibly distinguished from manual calibration
 * rather than faked. Upstream's vendor-proprietary automatic flows have no
 * Moonraker equivalent, and Klipper only measures one family of these
 * workflows without a human looking at a print.
 *
 * So the split is written down and justified per workflow:
 *
 * - **Resonance testing** is genuinely automatic. Klipper's `SHAPER_CALIBRATE`
 *   drives an accelerometer through a frequency sweep and derives the shaper
 *   frequency and damping itself, then writes them to its own configuration
 *   with `SAVE_CONFIG`. That needs `resonance_tester` and an accelerometer, so
 *   a printer without one gets the printed test, not a failure.
 * - **Everything else** is measured by eye or with calipers — the best colour
 *   on a temperature tower, the smallest clearance that still fits, the corner
 *   where ringing stops. Klipper's `TUNING_TOWER` can ramp a parameter over Z,
 *   but the compiler already emits per-band overrides, and ramping was never
 *   the hard part: reading the result is, and no printer reports that.
 *
 * A workflow is only reported automatable when *this* printer says it has the
 * parts. "Not supported here" and "not supported at all" are different answers
 * and are given as different answers.
 */

import type { CalibrationWorkflowId } from '../../features/calibrationInventory';

export type CalibrationAutomationKind = 'automatic' | 'manual';

export interface CalibrationAutomationRule {
  readonly kind: CalibrationAutomationKind;
  /** The Klipper command that performs the measurement, when one does. */
  readonly command?: string;
  /** Printer objects that must all be present. */
  readonly requiredObjects: readonly string[];
  /**
   * Groups where at least one member must be present — an accelerometer may be
   * any of several supported parts.
   */
  readonly anyOfObjects: readonly (readonly string[])[];
  /** Why this workflow is or is not machine-measurable. */
  readonly why: string;
}

const MANUAL_WHY =
  'The result of this test is read from the printed part, and no printer reports what a human sees. ' +
  'Print it, measure it, and enter the result.';

function manual(): CalibrationAutomationRule {
  return Object.freeze({ kind: 'manual', requiredObjects: [], anyOfObjects: [], why: MANUAL_WHY });
}

/** Accelerometers Klipper supports for resonance testing. */
export const RESONANCE_ACCELEROMETERS: readonly string[] = Object.freeze(['adxl345', 'lis2dw', 'mpu9250', 'icm20948']);

function resonance(command: string): CalibrationAutomationRule {
  return Object.freeze({
    kind: 'automatic',
    command,
    requiredObjects: Object.freeze(['resonance_tester']),
    anyOfObjects: Object.freeze([RESONANCE_ACCELEROMETERS]),
    why:
      'Klipper sweeps the axis and reads an accelerometer, so the frequency and damping are measured by the ' +
      'machine rather than by eye, and saved with SAVE_CONFIG.',
  });
}

export const CALIBRATION_AUTOMATION_RULES: Readonly<Record<CalibrationWorkflowId, CalibrationAutomationRule>> =
  Object.freeze({
    'temperature-tower': manual(),
    'flow-pass-1': manual(),
    'flow-pass-2': manual(),
    'flow-yolo': manual(),
    'flow-yolo-perfectionist': manual(),
    'pressure-advance-tower': manual(),
    'pressure-advance-line': manual(),
    'pressure-advance-pattern': manual(),
    'retraction-tower': manual(),
    'max-volumetric-speed': manual(),
    'junction-deviation': manual(),
    'input-shaping-frequency': resonance('SHAPER_CALIBRATE'),
    'input-shaping-damping': resonance('SHAPER_CALIBRATE'),
    vfa: manual(),
    'tolerance-extension': manual(),
  });

export interface CalibrationAutomationAssessment {
  readonly workflowId: CalibrationWorkflowId;
  readonly kind: CalibrationAutomationKind;
  /** True only when this printer reports every part the measurement needs. */
  readonly available: boolean;
  readonly command?: string;
  /** Object names this printer is missing, when that is why it is unavailable. */
  readonly missing: readonly string[];
  /** One sentence an operator can act on. */
  readonly reason: string;
  /** Always true here: a printed test exists for every workflow. */
  readonly manualFallback: true;
}

/**
 * Decide what this printer can do for one workflow.
 *
 * `objects` is what `/printer/objects/list` returned. An empty set means the
 * printer has not been asked yet, which is reported as unknown rather than as
 * absent — claiming a machine lacks an accelerometer because nobody looked
 * would be the same class of error this module exists to prevent.
 */
export function assessCalibrationAutomation(
  workflowId: CalibrationWorkflowId,
  objects: readonly string[] | undefined,
): CalibrationAutomationAssessment {
  const rule = CALIBRATION_AUTOMATION_RULES[workflowId];
  const base = { workflowId, kind: rule.kind, missing: Object.freeze([]), manualFallback: true as const };
  if (rule.kind === 'manual') {
    return Object.freeze({ ...base, available: false, reason: rule.why });
  }
  if (objects === undefined) {
    return Object.freeze({
      ...base,
      available: false,
      ...(rule.command ? { command: rule.command } : {}),
      reason: 'Connect the printer to find out whether it can measure this itself.',
    });
  }

  const present = new Set(objects.map((name) => name.split(/\s+/, 1)[0].toLowerCase()));
  const missing: string[] = rule.requiredObjects.filter((name) => !present.has(name.toLowerCase()));
  for (const group of rule.anyOfObjects) {
    if (group.some((name) => present.has(name.toLowerCase()))) continue;
    missing.push(group.join(' or '));
  }

  if (missing.length === 0) {
    return Object.freeze({
      ...base,
      available: true,
      ...(rule.command ? { command: rule.command } : {}),
      reason: rule.why,
    });
  }
  return Object.freeze({
    ...base,
    available: false,
    ...(rule.command ? { command: rule.command } : {}),
    missing: Object.freeze(missing),
    reason:
      `This printer reports no ${missing.join(', ')}, so it cannot measure this itself. ` +
      'The printed test still applies.',
  });
}

/** Klipper's own object list endpoint; the assessment reads exactly this. */
export const PRINTER_OBJECTS_LIST_PATH = '/printer/objects/list';

/** Read the object names out of a `/printer/objects/list` response. */
export function parsePrinterObjects(payload: unknown): readonly string[] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const result = (payload as { result?: unknown }).result ?? payload;
  if (result === null || typeof result !== 'object') return undefined;
  const objects = (result as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return undefined;
  return Object.freeze(objects.filter((entry): entry is string => typeof entry === 'string'));
}
