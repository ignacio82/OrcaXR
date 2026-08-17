/**
 * Traces for the measurement instructions (P8.3).
 *
 * The failure this guards against is specific and expensive: instructions that
 * are off by one band produce a confident measurement of the wrong value, which
 * then gets written into a preset and printed with from then on. So the
 * assertions are about correspondence with the plan, not about wording.
 */

import assert from 'node:assert/strict';

import { calibrationInstructions, describeBandLocation } from './instructions';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { CALIBRATION_WORKFLOW_IDS } from '../../features/calibrationInventory';
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

const plan = (id: (typeof CALIBRATION_WORKFLOW_IDS)[number]) =>
  compileCalibrationJob(
    createDefaultCalibrationJobRequest(id, prerequisites(id === 'junction-deviation' ? 'marlin' : 'klipper')),
    { jobId: 'calibration:instructions' },
  );

test('every band in the plan gets exactly one instruction, in the plan’s order', () => {
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const compiled = plan(id);
    const instructions = calibrationInstructions(compiled);
    assert.equal(instructions.bands.length, compiled.effects.length, `${id} loses no band`);
    for (const [index, band] of instructions.bands.entries()) {
      const effect = compiled.effects[index];
      // Value and label come from the effect, never re-derived: a sheet that
      // recomputes a formula can disagree with the G-code that was installed.
      assert.equal(band.value, effect.value, `${id} band ${index + 1} states the value that was installed`);
      assert.equal(band.label, effect.label);
      assert.equal(band.zRangeMm, effect.zRangeMm);
    }
  }
});

test('ordinals are 1-based and contiguous, because an operator counts from one', () => {
  const instructions = calibrationInstructions(plan('temperature-tower'));
  assert.deepEqual(
    instructions.bands.map((band) => band.ordinal),
    instructions.bands.map((_, index) => index + 1),
  );
});

test('a stacked print is described by height; a plate is not described as stacked', () => {
  const tower = calibrationInstructions(plan('temperature-tower'));
  assert.equal(tower.layout, 'stacked-by-height');
  const first = tower.bands[0];
  assert.ok(first.zRangeMm);
  assert.match(describeBandLocation(first, tower.layout), /mm from the bed/);

  const flow = calibrationInstructions(plan('flow-pass-1'));
  assert.equal(flow.layout, 'placed-across-the-bed', 'a flow plate is patches, not a tower');
  // The important half: it must not tell the operator to count bands upward on
  // a print that has no bands to count.
  const located = describeBandLocation(flow.bands[0], flow.layout);
  assert.doesNotMatch(located, /from the bed/);
  assert.match(located, /piece 1/);
});

test('the sheet says what to measure and where the answer will be written', () => {
  const instructions = calibrationInstructions(plan('temperature-tower'));
  assert.ok(instructions.measurements.length > 0, 'there is something to measure');
  for (const field of instructions.measurements) {
    assert.ok(field.label.length > 0, 'each measurement is named');
  }
  assert.ok(
    instructions.writesTo.length > 0,
    'and the operator is told which preset key a result lands in, before they record one',
  );
  assert.ok(instructions.writesTo.every((entry) => entry.includes(': ')));
});

test('every pinned workflow produces a usable sheet', () => {
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const instructions = calibrationInstructions(plan(id));
    assert.ok(instructions.title.length > 0, `${id} names itself`);
    assert.ok(instructions.bands.length > 0, `${id} has something to point at`);
    for (const band of instructions.bands) {
      assert.doesNotThrow(() => describeBandLocation(band, instructions.layout));
    }
  }
});

console.log(`\nCalibration instructions: ${passed} tests passed.`);
