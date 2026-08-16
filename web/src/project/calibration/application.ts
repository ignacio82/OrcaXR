/**
 * Turning a measured calibration result into a preset change (parity P8.3).
 *
 * The inventory records *which* preset keys a workflow targets, but not which
 * measured field feeds which key — and the relationship is not one-to-one. One
 * temperature result feeds two keys; a pressure-advance result needs a boolean
 * companion enabled alongside it; the input-shaping workflows target Klipper
 * configuration that no preset can hold at all. Guessing any of that would
 * write a real number into the wrong option, so the mapping is written out
 * here, per workflow, and the tests hold it against the pinned inventory.
 *
 * Two rules.
 *
 * A result is applied only where it holds. The same condition check that gates
 * the ledger gates this: a value measured on another nozzle, material, printer,
 * or filament preset is refused with the mismatch named, never coerced.
 *
 * A firmware target is never silently dropped. `input_shaper.*` lives in the
 * printer's own configuration, not in a slicer preset, so those workflows
 * produce an explicit hand-off — the exact lines to put in `printer.cfg` — in
 * place of an override. Reporting "applied" while writing nothing would be the
 * worst of the available outcomes.
 *
 * Values come out as text and are coerced against the base preset's own value
 * by `coerceOverrideValue`, so a key the engine reads as a list stays a list.
 */

import type { CalibrationWorkflowId } from '../../features/calibrationInventory';
import type { CalibrationPresetScope } from '../../features/calibrationInventory';
import {
  assessCalibrationApplicability,
  type CalibrationConditions,
  type CalibrationHistoryIssue,
  type CalibrationRecord,
} from './history';

/** One measured field feeding one preset key. */
export interface CalibrationResultBinding {
  readonly resultKey: string;
  readonly presetKey: string;
  /** Rendered alongside the value so a hand-off reads as instructions. */
  readonly note?: string;
}

/** A constant that must accompany a measured value for it to take effect. */
export interface CalibrationCompanionOverride {
  readonly presetKey: string;
  readonly value: string;
  readonly why: string;
}

export interface CalibrationApplicationRule {
  readonly scope: CalibrationPresetScope;
  readonly bindings: readonly CalibrationResultBinding[];
  readonly companions: readonly CalibrationCompanionOverride[];
  /**
   * True when the targets are printer firmware configuration rather than
   * anything a preset can hold, so the result is handed over instead of
   * written.
   */
  readonly handOff: boolean;
}

/**
 * The pinned result-to-preset mapping, one entry per P8.1 workflow.
 *
 * Every `presetKey` here appears in that workflow's own `presetTargets`, and
 * every `resultKey` in its `resultFields`; the test asserts both directions, so
 * this cannot drift from the inventory without failing.
 */
export const CALIBRATION_APPLICATION_RULES: Readonly<Record<CalibrationWorkflowId, CalibrationApplicationRule>> =
  Object.freeze({
    'temperature-tower': {
      scope: 'filament',
      bindings: [
        { resultKey: 'bestNozzleTemperatureC', presetKey: 'nozzle_temperature' },
        {
          resultKey: 'bestNozzleTemperatureC',
          presetKey: 'nozzle_temperature_initial_layer',
          note: 'The first layer takes the same temperature; raise it separately if adhesion needs it.',
        },
      ],
      companions: [],
      handOff: false,
    },
    'flow-pass-1': {
      scope: 'filament',
      bindings: [{ resultKey: 'flowRatio', presetKey: 'filament_flow_ratio' }],
      companions: [],
      handOff: false,
    },
    'flow-pass-2': {
      scope: 'filament',
      bindings: [{ resultKey: 'flowRatio', presetKey: 'filament_flow_ratio' }],
      companions: [],
      handOff: false,
    },
    'flow-yolo': {
      scope: 'filament',
      bindings: [{ resultKey: 'flowRatio', presetKey: 'filament_flow_ratio' }],
      companions: [],
      handOff: false,
    },
    'flow-yolo-perfectionist': {
      scope: 'filament',
      bindings: [{ resultKey: 'flowRatio', presetKey: 'filament_flow_ratio' }],
      companions: [],
      handOff: false,
    },
    'pressure-advance-tower': {
      scope: 'filament',
      bindings: [{ resultKey: 'pressureAdvanceK', presetKey: 'pressure_advance' }],
      companions: [
        {
          presetKey: 'enable_pressure_advance',
          value: '1',
          why: 'A pressure-advance value is ignored unless pressure advance is enabled for this filament.',
        },
      ],
      handOff: false,
    },
    'pressure-advance-line': {
      scope: 'filament',
      bindings: [{ resultKey: 'pressureAdvanceK', presetKey: 'pressure_advance' }],
      companions: [
        {
          presetKey: 'enable_pressure_advance',
          value: '1',
          why: 'A pressure-advance value is ignored unless pressure advance is enabled for this filament.',
        },
      ],
      handOff: false,
    },
    'pressure-advance-pattern': {
      scope: 'filament',
      bindings: [{ resultKey: 'pressureAdvanceK', presetKey: 'pressure_advance' }],
      companions: [
        {
          presetKey: 'enable_pressure_advance',
          value: '1',
          why: 'A pressure-advance value is ignored unless pressure advance is enabled for this filament.',
        },
      ],
      handOff: false,
    },
    'retraction-tower': {
      scope: 'printer',
      bindings: [{ resultKey: 'retractionLengthMm', presetKey: 'retraction_length' }],
      companions: [],
      handOff: false,
    },
    'max-volumetric-speed': {
      scope: 'filament',
      bindings: [{ resultKey: 'maxVolumetricSpeedMm3PerS', presetKey: 'filament_max_volumetric_speed' }],
      companions: [],
      handOff: false,
    },
    'junction-deviation': {
      scope: 'process',
      bindings: [{ resultKey: 'junctionDeviationMm', presetKey: 'default_junction_deviation' }],
      companions: [],
      handOff: false,
    },
    'input-shaping-frequency': {
      scope: 'firmware',
      bindings: [
        { resultKey: 'frequencyXHz', presetKey: 'input_shaper.frequency_x' },
        { resultKey: 'frequencyYHz', presetKey: 'input_shaper.frequency_y' },
      ],
      companions: [],
      handOff: true,
    },
    'input-shaping-damping': {
      scope: 'firmware',
      bindings: [{ resultKey: 'dampingRatio', presetKey: 'input_shaper.damping_ratio' }],
      companions: [],
      handOff: true,
    },
    vfa: {
      scope: 'process',
      bindings: [
        { resultKey: 'artifactFreeSpeedMaxMmPerS', presetKey: 'outer_wall_speed' },
        {
          resultKey: 'artifactFreeSpeedMaxMmPerS',
          presetKey: 'inner_wall_speed',
          note: 'Inner walls take the same ceiling; they may safely run faster if the surface allows.',
        },
      ],
      companions: [],
      handOff: false,
    },
    'tolerance-extension': {
      scope: 'process',
      bindings: [
        { resultKey: 'xyHoleCompensationMm', presetKey: 'xy_hole_compensation' },
        { resultKey: 'xyContourCompensationMm', presetKey: 'xy_contour_compensation' },
      ],
      companions: [],
      handOff: false,
    },
  });

export interface CalibrationOverrideChange {
  readonly presetKey: string;
  /** Engine-wire text; the caller coerces it against the base's own value. */
  readonly value: string;
  /** Which measured field produced it, or why the constant is required. */
  readonly because: string;
}

export interface CalibrationApplicationPlan {
  readonly workflowId: CalibrationWorkflowId;
  readonly scope: CalibrationPresetScope;
  /** Preset overrides to write; empty for a firmware hand-off. */
  readonly overrides: readonly CalibrationOverrideChange[];
  /** Lines to put in the printer's own configuration, for a hand-off. */
  readonly manualTransfer: readonly string[];
  readonly issues: readonly CalibrationHistoryIssue[];
  /** True when there is a preset change to make and it is safe to make it. */
  readonly applicable: boolean;
}

function issue(
  code: CalibrationHistoryIssue['code'],
  path: string,
  message: string,
  severity: CalibrationHistoryIssue['severity'] = 'error',
): CalibrationHistoryIssue {
  return Object.freeze({ code, severity, path, message });
}

/**
 * Work out exactly what a recorded result would change, without changing it.
 *
 * Nothing is written here: the caller submits the overrides through the preset
 * library's own validated write path, so provenance, versioning, and the
 * refusal of unknown or reserved keys all still apply.
 */
export function planCalibrationApplication(
  record: CalibrationRecord,
  current: CalibrationConditions,
): CalibrationApplicationPlan {
  const rule = CALIBRATION_APPLICATION_RULES[record.method.definitionId];
  const issues: CalibrationHistoryIssue[] = [];
  if (!rule) {
    return frozenPlan(
      record.method.definitionId,
      'filament',
      [],
      [],
      [issue('method-changed', '$.method', `No preset mapping is defined for ${record.method.label}.`)],
    );
  }

  const applicability = assessCalibrationApplicability(record, current);
  issues.push(...applicability.issues);

  const measured = new Map(record.measurements.map((measurement) => [measurement.key, measurement]));
  const overrides: CalibrationOverrideChange[] = [];
  const transfers: string[] = [];
  for (const binding of rule.bindings) {
    const measurement = measured.get(binding.resultKey);
    if (!measurement) {
      // A workflow with several optional results applies the ones it has; only
      // an empty plan is a failure.
      continue;
    }
    const value = String(measurement.value);
    if (rule.handOff) {
      transfers.push(`${binding.presetKey}: ${value}${measurement.unit ? ` ${measurement.unit}` : ''}`);
      continue;
    }
    overrides.push(
      Object.freeze({
        presetKey: binding.presetKey,
        value,
        because: binding.note
          ? `Measured ${binding.resultKey} = ${value}. ${binding.note}`
          : `Measured ${binding.resultKey} = ${value}.`,
      }),
    );
  }

  if (rule.handOff) {
    if (transfers.length === 0) {
      issues.push(issue('missing-measurement', '$.measurements', `${record.method.label} recorded no usable result.`));
    } else {
      issues.push(
        issue(
          'condition-mismatch',
          '$.presetTargets',
          `${record.method.label} tunes the printer's own configuration, which no slicer preset holds. ` +
            'Copy the values below into the printer and restart its firmware.',
          'warning',
        ),
      );
    }
    return frozenPlan(record.method.definitionId, rule.scope, [], transfers, issues);
  }

  if (overrides.length === 0) {
    issues.push(
      issue(
        'missing-measurement',
        '$.measurements',
        `${record.method.label} recorded no result that maps to a preset.`,
      ),
    );
    return frozenPlan(record.method.definitionId, rule.scope, [], [], issues);
  }

  for (const companion of rule.companions) {
    overrides.push(Object.freeze({ presetKey: companion.presetKey, value: companion.value, because: companion.why }));
  }

  return frozenPlan(record.method.definitionId, rule.scope, overrides, [], issues);
}

function frozenPlan(
  workflowId: CalibrationWorkflowId,
  scope: CalibrationPresetScope,
  overrides: readonly CalibrationOverrideChange[],
  manualTransfer: readonly string[],
  issues: readonly CalibrationHistoryIssue[],
): CalibrationApplicationPlan {
  return Object.freeze({
    workflowId,
    scope,
    overrides: Object.freeze([...overrides]),
    manualTransfer: Object.freeze([...manualTransfer]),
    issues: Object.freeze([...issues]),
    applicable: overrides.length > 0 && !issues.some((entry) => entry.severity === 'error'),
  });
}

/** A one-line summary of what applying would do, for a confirmation. */
export function describeCalibrationApplication(plan: CalibrationApplicationPlan): string {
  if (plan.manualTransfer.length > 0) {
    return `Copy ${plan.manualTransfer.length} value${plan.manualTransfer.length === 1 ? '' : 's'} into the printer's own configuration.`;
  }
  if (plan.overrides.length === 0) return 'Nothing to apply.';
  return `Set ${plan.overrides.map((change) => `${change.presetKey} = ${change.value}`).join(', ')} on the ${plan.scope} preset.`;
}
