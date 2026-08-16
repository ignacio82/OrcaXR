import assert from 'node:assert/strict';

import { CALIBRATION_WORKFLOW_IDS, type CalibrationWorkflowId } from '../../features/calibrationInventory';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { getCalibrationJobDefinition } from './definitions';
import {
  CALIBRATION_APPLICATION_RULES,
  describeCalibrationApplication,
  planCalibrationApplication,
} from './application';
import {
  calibrationMethodFromPlan,
  recordCalibrationRun,
  type CalibrationConditions,
  type CalibrationRecord,
} from './history';
import type { CalibrationFirmwareFlavor, CalibrationJobPrerequisites } from './types';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function prerequisites(flavor: CalibrationFirmwareFlavor = 'klipper'): CalibrationJobPrerequisites {
  return {
    printer: {
      id: 'printer:snapmaker-u1',
      manufacturer: 'Snapmaker',
      model: 'U1',
      bedWidthMm: 270,
      bedDepthMm: 270,
      buildHeightMm: 270,
      maxPrintSpeedMmPerS: 300,
      maxAccelerationMmPerS2: 10_000,
    },
    nozzle: { diameterMm: 0.4, minTemperatureC: 170, maxTemperatureC: 300, maxLayerHeightMm: 0.32 },
    filament: {
      id: 'filament:pla-red',
      name: 'Red PLA',
      material: 'PLA',
      minTemperatureC: 180,
      maxTemperatureC: 260,
      flowRatio: 0.98,
      maxVolumetricSpeedMm3PerS: 30,
      retractionLengthMm: 0.8,
    },
    process: {
      id: 'process:quality',
      layerHeightMm: 0.2,
      firstLayerHeightMm: 0.2,
      lineWidthMm: 0.45,
      outerWallSpeedMmPerS: 120,
      defaultAccelerationMmPerS2: 5_000,
      xyHoleCompensationMm: 0,
      xyContourCompensationMm: 0,
    },
    firmware: {
      flavor,
      nozzleTemperature: true,
      pressureAdvance: true,
      inputShaping: true,
      junctionDeviation: true,
      maxInputShapingFrequencyHz: 500,
    },
  };
}

function conditions(overrides: Partial<CalibrationConditions> = {}): CalibrationConditions {
  return {
    printerModel: 'Snapmaker U1',
    firmwareFlavor: 'klipper',
    firmwareVersion: 'v0.12.0',
    nozzleDiameterMm: 0.4,
    filamentMaterial: 'PLA',
    filamentPresetHash: 'fnv1a64:1111111111111111',
    processPresetHash: 'fnv1a64:2222222222222222',
    ...overrides,
  };
}

function recordFor(
  id: CalibrationWorkflowId,
  measurements: readonly { key: string; value: number | string; unit: string | null }[],
  chosenKey?: string,
): CalibrationRecord {
  const compiled = compileCalibrationJob(
    createDefaultCalibrationJobRequest(id, prerequisites(id === 'junction-deviation' ? 'marlin' : 'klipper')),
    { jobId: `calibration:${id}` },
  );
  const written = recordCalibrationRun(calibrationMethodFromPlan(compiled), conditions(), {
    operator: 'ignacio',
    recordedAt: '2026-08-16T09:00:00.000Z',
    measurements,
    ...(chosenKey ? { chosenKey } : {}),
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(written.issues, [], JSON.stringify(written.issues));
  assert.ok(written.record);
  return written.record;
}

test('the mapping covers every workflow and cannot drift from the inventory', () => {
  assert.deepEqual(Object.keys(CALIBRATION_APPLICATION_RULES).sort(), [...CALIBRATION_WORKFLOW_IDS].sort());

  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const definition = getCalibrationJobDefinition(id);
    assert.ok(definition, id);
    const rule = CALIBRATION_APPLICATION_RULES[id];
    const resultKeys = new Set(definition.resultFields.map((field) => field.key));
    const targetKeys = new Set(definition.presetTargets.map((target) => target.key));
    const scopes = new Set(definition.presetTargets.map((target) => target.scope));

    for (const binding of rule.bindings) {
      assert.ok(resultKeys.has(binding.resultKey), `${id}: ${binding.resultKey} is not a result field`);
      assert.ok(targetKeys.has(binding.presetKey), `${id}: ${binding.presetKey} is not a preset target`);
    }
    for (const companion of rule.companions) {
      assert.ok(targetKeys.has(companion.presetKey), `${id}: ${companion.presetKey} is not a preset target`);
    }
    assert.ok(scopes.has(rule.scope), `${id}: ${rule.scope} is not a declared target scope`);

    // Every target the inventory declares is either bound to a measurement or
    // supplied as a companion — nothing upstream targets is silently ignored.
    const covered = new Set([
      ...rule.bindings.map((binding) => binding.presetKey),
      ...rule.companions.map((companion) => companion.presetKey),
    ]);
    assert.deepEqual(
      [...targetKeys].filter((key) => !covered.has(key)),
      [],
      `${id}: uncovered preset targets`,
    );

    // A firmware hand-off is exactly the workflows whose targets are firmware.
    assert.equal(rule.handOff, scopes.has('firmware'), `${id}: hand-off must follow the declared scope`);
  }
});

test('a measured value maps onto the option it was measured for', () => {
  const flow = recordFor('flow-pass-1', [{ key: 'flowRatio', value: 0.965, unit: null }], 'flowRatio');
  const plan = planCalibrationApplication(flow, conditions());
  assert.equal(plan.applicable, true);
  assert.equal(plan.scope, 'filament');
  assert.deepEqual(
    plan.overrides.map((change) => [change.presetKey, change.value]),
    [['filament_flow_ratio', '0.965']],
  );
  assert.match(plan.overrides[0].because, /Measured flowRatio = 0\.965/);
  assert.deepEqual(plan.manualTransfer, []);
  assert.match(describeCalibrationApplication(plan), /filament_flow_ratio = 0\.965 on the filament preset/);
});

test('a value that needs a companion switch gets one, with the reason', () => {
  const pa = recordFor(
    'pressure-advance-line',
    [{ key: 'pressureAdvanceK', value: 0.042, unit: null }],
    'pressureAdvanceK',
  );
  const plan = planCalibrationApplication(pa, conditions());
  assert.equal(plan.applicable, true);
  assert.deepEqual(
    plan.overrides.map((change) => [change.presetKey, change.value]),
    [
      ['pressure_advance', '0.042'],
      ['enable_pressure_advance', '1'],
    ],
    'the number is useless unless the feature it configures is on',
  );
  assert.match(plan.overrides[1].because, /ignored unless pressure advance is enabled/);
});

test('one result can feed two options, and each says why', () => {
  const temperature = recordFor(
    'temperature-tower',
    [{ key: 'bestNozzleTemperatureC', value: 215, unit: '°C' }],
    'bestNozzleTemperatureC',
  );
  const plan = planCalibrationApplication(temperature, conditions());
  assert.deepEqual(
    plan.overrides.map((change) => change.presetKey),
    ['nozzle_temperature', 'nozzle_temperature_initial_layer'],
  );
  assert.ok(plan.overrides.every((change) => change.value === '215'));
  assert.match(plan.overrides[1].because, /first layer takes the same temperature/i);
});

test('a firmware result is handed over rather than written into a preset', () => {
  const shaping = recordFor(
    'input-shaping-frequency',
    [
      { key: 'frequencyXHz', value: 48.2, unit: 'Hz' },
      { key: 'frequencyYHz', value: 41.7, unit: 'Hz' },
    ],
    'frequencyXHz',
  );
  const plan = planCalibrationApplication(shaping, conditions());
  assert.equal(plan.applicable, false, 'there is no preset change to make');
  assert.deepEqual(plan.overrides, [], 'and nothing is invented to make it look like there was');
  assert.deepEqual(plan.manualTransfer, ['input_shaper.frequency_x: 48.2 Hz', 'input_shaper.frequency_y: 41.7 Hz']);
  assert.deepEqual(
    plan.issues.map((entry) => entry.severity),
    ['warning'],
    'a hand-off is not a failure',
  );
  assert.match(plan.issues[0].message, /no slicer preset holds/);
  assert.match(describeCalibrationApplication(plan), /Copy 2 values into the printer/);
});

test('a result measured under other conditions is never written', () => {
  const flow = recordFor('flow-pass-1', [{ key: 'flowRatio', value: 0.965, unit: null }], 'flowRatio');

  for (const [field, value] of [
    ['nozzleDiameterMm', 0.6],
    ['filamentMaterial', 'PETG'],
    ['printerModel', 'Elegoo Centauri Carbon'],
  ] as const) {
    const plan = planCalibrationApplication(flow, conditions({ [field]: value } as never));
    assert.equal(plan.applicable, false, `${field} must block the write`);
    assert.ok(
      plan.issues.some((entry) => entry.code === 'condition-mismatch' && entry.severity === 'error'),
      `${field} must say why`,
    );
    // The plan still describes what *would* change, so the refusal can explain
    // itself rather than showing an empty dialog.
    assert.equal(plan.overrides.length, 1);
  }

  const newerFirmware = planCalibrationApplication(flow, conditions({ firmwareVersion: 'v0.13.0' }));
  assert.equal(newerFirmware.applicable, true, 'a firmware bump does not invalidate a flow ratio');
});

test('a run with nothing that maps to a preset applies nothing', () => {
  const tolerance = recordFor(
    'tolerance-extension',
    [{ key: 'passingClearanceMm', value: 0.15, unit: 'mm' }],
    'passingClearanceMm',
  );
  const plan = planCalibrationApplication(tolerance, conditions());
  assert.equal(plan.applicable, false, 'the measured clearance is not itself a preset option');
  assert.deepEqual(plan.overrides, []);
  assert.ok(plan.issues.some((entry) => entry.code === 'missing-measurement'));
  assert.equal(describeCalibrationApplication(plan), 'Nothing to apply.');

  // With the derived compensations recorded too, it applies both.
  const derived = recordFor(
    'tolerance-extension',
    [
      { key: 'passingClearanceMm', value: 0.15, unit: 'mm' },
      { key: 'xyHoleCompensationMm', value: 0.05, unit: 'mm' },
      { key: 'xyContourCompensationMm', value: -0.02, unit: 'mm' },
    ],
    'passingClearanceMm',
  );
  const full = planCalibrationApplication(derived, conditions());
  assert.equal(full.applicable, true);
  assert.deepEqual(
    full.overrides.map((change) => [change.presetKey, change.value]),
    [
      ['xy_hole_compensation', '0.05'],
      ['xy_contour_compensation', '-0.02'],
    ],
  );
});

console.log(`\nCalibration application: ${passed} tests passed.`);
