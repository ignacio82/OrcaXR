/**
 * Borrowing a real machine envelope, and refusing an unsafe one (P8.2).
 *
 * The pressure-advance sweeps need the printer's own start and end G-code, and
 * those are templates the slicer evaluates. Rather than reimplement that
 * evaluation — or hand-write a substitute that would skip bed levelling on
 * someone's machine — the envelope is taken from the engine's own output for an
 * ordinary slice.
 *
 * These traces drive the real engine, because a hand-written donor would prove
 * only that the parser matches the fixture. The safety refusals are exercised
 * against mutated real output for the same reason.
 */

import assert from 'node:assert/strict';

import { extractMachineEnvelope, MachineEnvelopeError, wrapInMachineEnvelope } from '../calibration/machineEnvelope';
import { pressureAdvanceLineProgram } from '../calibration/lineProgram';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../calibration/compiler';
import { buildSliceArchive, sliceArchive } from './sliceHarness';
import type { CalibrationJobPrerequisites } from '../calibration/types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
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
    id: 'filament:pla',
    name: 'PLA',
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

/** One real slice, reused: the engine is slow and this is the same donor. */
let donor: string | null = null;
async function donorProgram(): Promise<string> {
  donor ??= await sliceArchive(await buildSliceArchive({}), 'envelope-donor');
  return donor;
}

await test('the borrowed preamble is the machine’s own, evaluated', async () => {
  const envelope = extractMachineEnvelope(await donorProgram());
  // The very things a hand-written substitute would have omitted, and the
  // reason the templates were not reimplemented: these are the evaluated
  // results of `{if curr_bed_type == …}` and friends.
  assert.match(envelope.head, /^\s*G28\b/m, 'it homes');
  assert.match(envelope.head, /BED_MESH_CALIBRATE/, 'it levels the bed');
  assert.match(envelope.head, /CLEAN_NOZZLE/, 'it cleans the nozzle');
  assert.doesNotMatch(envelope.head, /\{|\}/, 'and no template token survived into the program');
  assert.match(envelope.tail, /PRINT_END/, 'the epilogue ends the print');
});

await test('the preamble stops before the donor’s own printing', async () => {
  const envelope = extractMachineEnvelope(await donorProgram());
  assert.doesNotMatch(envelope.head, /^;LAYER_CHANGE/m, 'no layer of the donor leaks into the preamble');
  // The donor was a small solid; its extrusion must not come along.
  assert.doesNotMatch(envelope.tail, /^;LAYER_CHANGE/m, 'nor into the epilogue');
});

await test('a sweep wrapped in the envelope is a whole program', async () => {
  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('pressure-advance-line', PREREQS), {
    jobId: 'calibration:wrapped',
  });
  const body = pressureAdvanceLineProgram(plan, {
    layerHeightMm: 0.2,
    lineWidthMm: 0.42,
    filamentDiameterMm: 1.75,
    printFeedMmPerMin: 1200,
    travelFeedMmPerMin: 9000,
  });
  const program = wrapInMachineEnvelope(body.body, extractMachineEnvelope(await donorProgram()));

  assert.match(program, /BED_MESH_CALIBRATE/, 'the machine still prepares itself');
  assert.match(program, /SET_PRESSURE_ADVANCE ADVANCE=0\b/, 'the calibration is in it');
  assert.match(program, /PRINT_END/, 'and it finishes');
  // Order matters as much as presence: preparation, calibration, shutdown.
  assert.ok(program.indexOf('BED_MESH_CALIBRATE') < program.indexOf('SET_PRESSURE_ADVANCE'));
  assert.ok(program.indexOf('SET_PRESSURE_ADVANCE') < program.indexOf('PRINT_END'));
});

await test('a preamble that lost its homing is refused', async () => {
  // Mutating real output rather than inventing a bad fixture: this is what a
  // profile change or an extraction bug would actually look like.
  const stripped = (await donorProgram())
    .split('\n')
    .filter((line) => !/^\s*G28\b/.test(line))
    .join('\n');
  assert.throws(
    () => extractMachineEnvelope(stripped),
    (error: unknown) => error instanceof MachineEnvelopeError && error.code === 'unsafe-start',
    'a program that never homes must not be built',
  );
});

await test('an epilogue that never ends the print is refused', async () => {
  const program = await donorProgram();
  const stripped = program
    .split('\n')
    .map((line) => (/PRINT_END|^\s*M104\s+S0|^\s*M84\b|^\s*M140\s+S0/.test(line) ? '; removed' : line))
    .join('\n');
  assert.throws(
    () => extractMachineEnvelope(stripped),
    (error: unknown) => error instanceof MachineEnvelopeError && error.code === 'unsafe-end',
    'a program that leaves the machine hot must not be built',
  );
});

console.log(`\nMachine envelope: ${passed} tests passed.`);
