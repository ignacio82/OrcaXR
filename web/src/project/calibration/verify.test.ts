/**
 * Traces for plan verification (P8.3, P8.2).
 *
 * Two properties matter. Every pinned workflow must satisfy its own declared
 * assertions, or the compiler is promising something it does not deliver. And
 * the evaluator must actually fail when a plan is wrong — an assertion checker
 * that cannot report a failure is the same decoration it was written to
 * replace, only more convincing.
 */

import assert from 'node:assert/strict';

import { describeAssertionFailure, verifyCalibrationPlan } from './verify';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { CALIBRATION_WORKFLOW_IDS } from '../../features/calibrationInventory';
import type { CalibrationFirmwareFlavor, CalibrationJobPlan, CalibrationJobPrerequisites } from './types';

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

const planFor = (id: (typeof CALIBRATION_WORKFLOW_IDS)[number]): CalibrationJobPlan =>
  compileCalibrationJob(
    createDefaultCalibrationJobRequest(id, prerequisites(id === 'junction-deviation' ? 'marlin' : 'klipper')),
    { jobId: 'calibration:verify' },
  );

test('every pinned workflow satisfies its own declared assertions', () => {
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const verification = verifyCalibrationPlan(planFor(id));
    assert.equal(
      verification.satisfied,
      true,
      `${id}: ${verification.failures.map(describeAssertionFailure).join('; ')}`,
    );
    assert.ok(verification.results.length > 0, `${id} declares assertions at all`);
  }
});

test('the evaluator reports a failure when the plan is wrong', () => {
  // The check on the checker. A plan with a band removed must fail its own
  // effect-count assertion; if it does not, every pass above means nothing.
  const plan = planFor('temperature-tower');
  const short = { ...plan, effects: plan.effects.slice(0, -1) } as CalibrationJobPlan;
  const verification = verifyCalibrationPlan(short);
  assert.equal(verification.satisfied, false);
  const failure = verification.failures.find((entry) => entry.assertion.kind === 'effect-count');
  assert.ok(failure, 'the missing band is caught by the count assertion');
  assert.match(describeAssertionFailure(failure), /expected 9 bands, the plan has 8/);
});

test('bands that change nothing and sit nowhere do not count as actionable', () => {
  // A plan of inert placeholders would satisfy a naive count. The predicate is
  // the compiler's: an effect is actionable if it overrides something, emits
  // something, or is *placed* somewhere — `tolerance-extension` is six gauges
  // that only differ in position, and calling those inert would be wrong.
  const plan = planFor('temperature-tower');
  const inert = {
    ...plan,
    effects: plan.effects.map((effect) => ({
      ...effect,
      engineOverrides: [],
      customGcode: null,
      positionMm: null,
      lineMm: null,
    })),
  } as CalibrationJobPlan;
  const verification = verifyCalibrationPlan(inert);
  const failure = verification.failures.find((entry) => entry.assertion.kind === 'actionable-effects');
  assert.ok(failure, 'inert bands fail the actionable assertion');
  assert.match(describeAssertionFailure(failure), /actually change something, the plan has 0/);
  // And the converse: a placed-but-inert-config workflow is not reported broken.
  assert.equal(verifyCalibrationPlan(planFor('tolerance-extension')).satisfied, true);
});

test('a substituted resource is caught, because the envelope was audited from the real one', () => {
  const plan = planFor('temperature-tower');
  const swapped = {
    ...plan,
    geometry: {
      ...plan.geometry,
      resources: [{ ...plan.geometry.resources[0], blob: '0'.repeat(40) }],
    },
  } as CalibrationJobPlan;
  const verification = verifyCalibrationPlan(swapped);
  const failure = verification.failures.find((entry) => entry.assertion.kind === 'resource-blob');
  assert.ok(failure);
  assert.match(describeAssertionFailure(failure), /not the audited/);
});

test('every failure is described in terms of the print, not a JSON path', () => {
  const plan = planFor('temperature-tower');
  for (const assertion of plan.sliceAssertions) {
    const broken = verifyCalibrationPlan({
      ...plan,
      sliceAssertions: [{ ...assertion, expected: assertion.operator === 'equals' ? '__no__' : 9_999 }],
    } as CalibrationJobPlan);
    for (const failure of broken.failures) {
      const message = describeAssertionFailure(failure);
      assert.ok(message.length > 0, `${assertion.kind} has a message`);
      assert.doesNotMatch(message, /\$\./, `${assertion.kind} does not hand an operator a JSON path`);
    }
  }
});

console.log(`\nCalibration plan verification: ${passed} tests passed.`);
