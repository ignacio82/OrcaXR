/**
 * Traces for matching resource pieces to plan effects (P8.2).
 *
 * The trace that justifies the module is the first one: the real resource's
 * object order is not the plan's effect order, so zipping by index produces a
 * plate that prints and measures wrongly while looking perfect. Everything else
 * here is about refusing rather than approximating.
 */

import assert from 'node:assert/strict';

import { flowPatchRatio, matchFlowPatches } from './resourceObjects';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import type { CalibrationJobPrerequisites, CalibrationPlanEffect } from './types';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PREREQS: CalibrationJobPrerequisites = {
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
    flowRatio: 1,
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
    flavor: 'klipper',
    nozzleTemperature: true,
    pressureAdvance: true,
    inputShaping: true,
    junctionDeviation: true,
    maxInputShapingFrequencyHz: 500,
  },
};

/** The object names exactly as `flowrate-test-pass1.3mf` stores them. */
const RESOURCE_ORDER = [
  'flowrate_0',
  'flowrate_10',
  'flowrate_15',
  'flowrate_20',
  'flowrate_5',
  'flowrate_m10',
  'flowrate_m15',
  'flowrate_m20',
  'flowrate_m5',
];

const flowEffects = (): readonly CalibrationPlanEffect[] =>
  compileCalibrationJob(createDefaultCalibrationJobRequest('flow-pass-1', PREREQS), { jobId: 'calibration:match' })
    .effects;

test('a patch name is read as the ratio it stands for, in both upstream encodings', () => {
  // Integers are percentages; decimals are absolute offsets. Derived by reading
  // each archive against its plan, not assumed — and the difference is not
  // cosmetic: reading `flowrate_0.05` as five percent would put it on the wrong
  // patch and mis-label the whole plate.
  assert.equal(flowPatchRatio('flowrate_0'), 1);
  assert.equal(flowPatchRatio('flowrate_15'), 1.15);
  assert.equal(flowPatchRatio('flowrate_m20'), 0.8);
  assert.equal(flowPatchRatio('flowrate_m9'), 0.91);
  assert.ok(Math.abs(flowPatchRatio('flowrate_0.05')! - 1.05) < 1e-9);
  assert.ok(Math.abs(flowPatchRatio('flowrate_m0.005')! - 0.995) < 1e-9);
  assert.equal(flowPatchRatio('something_else'), null, 'an unrecognised name yields nothing, not a guess');
  assert.equal(flowPatchRatio('flowrate_'), null);
});

test('the resource order is NOT the effect order — which is why this module exists', () => {
  const effects = flowEffects();
  assert.equal(RESOURCE_ORDER.length, effects.length, 'nine patches, nine effects');

  const mapping = matchFlowPatches(RESOURCE_ORDER, effects);
  assert.deepEqual(mapping.problems, []);

  // The first patch on the plate is the *unmodified* one, and the first effect
  // is the −20 % one. Zipping by index would have printed 0.8 on the patch
  // labelled 0 %, and every patch after it would be wrong too.
  const first = mapping.matches.find((match) => match.objectName === 'flowrate_0');
  assert.ok(first);
  assert.equal(first.effect.value, 1, 'the 0 % patch prints at ratio 1');
  assert.notEqual(effects[0].value, 1, 'while the first effect is not ratio 1 — the orders genuinely differ');

  const extreme = mapping.matches.find((match) => match.objectName === 'flowrate_m20');
  assert.equal(extreme?.effect.value, 0.8, 'and the −20 % patch is the one that prints at 0.8');
});

test('every patch is matched exactly once, and every effect is used', () => {
  const effects = flowEffects();
  const mapping = matchFlowPatches(RESOURCE_ORDER, effects);
  assert.equal(mapping.matches.length, RESOURCE_ORDER.length);
  assert.equal(new Set(mapping.matches.map((match) => match.objectName)).size, RESOURCE_ORDER.length);
  assert.equal(new Set(mapping.matches.map((match) => match.effect.value)).size, effects.length);
});

test('a plate missing a patch is refused, not silently printed short', () => {
  const mapping = matchFlowPatches(RESOURCE_ORDER.slice(0, -1), flowEffects());
  assert.ok(mapping.problems.length > 0);
  assert.match(mapping.problems.join(' '), /no piece on the plate prints at/);
  assert.deepEqual(mapping.matches, [], 'a partial mapping is the scrambled plate with fewer pieces');
});

test('a patch the plan has no setting for is refused', () => {
  const mapping = matchFlowPatches([...RESOURCE_ORDER, 'flowrate_50'], flowEffects());
  assert.match(mapping.problems.join(' '), /which this plan does not contain/);
  assert.deepEqual(mapping.matches, []);
});

test('a name that is not a patch name is refused rather than guessed at', () => {
  const mapping = matchFlowPatches([...RESOURCE_ORDER.slice(1), 'calibration_cube'], flowEffects());
  assert.match(mapping.problems.join(' '), /is not a flow patch name/);
  assert.deepEqual(mapping.matches, []);
});

console.log(`\nResource object matching: ${passed} tests passed.`);
