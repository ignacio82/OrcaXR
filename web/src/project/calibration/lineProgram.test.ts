/**
 * Traces for the pressure-advance line body (P8.2).
 *
 * Two things carry weight. Each line must be preceded by *its own* command —
 * emitting it after the move would draw every line at its neighbour's setting,
 * the same off-by-one that scrambles a flow plate and is just as invisible in
 * the output. And the module must keep refusing to look printable, because a
 * file that appears complete and skips bed levelling is worse than no file.
 */

import assert from 'node:assert/strict';

import { extrusionForLine, LineProgramError, pressureAdvanceLineProgram } from './lineProgram';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import type { CalibrationJobPlan, CalibrationJobPrerequisites } from './types';

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

const OPTIONS = {
  layerHeightMm: 0.2,
  lineWidthMm: 0.42,
  filamentDiameterMm: 1.75,
  printFeedMmPerMin: 1200,
  travelFeedMmPerMin: 9000,
};

const planFor = (id: 'pressure-advance-line' | 'pressure-advance-pattern'): CalibrationJobPlan =>
  compileCalibrationJob(createDefaultCalibrationJobRequest(id, PREREQS), { jobId: 'calibration:line-program' });

test('every line is drawn, at the coordinates the plan gives', () => {
  const plan = planFor('pressure-advance-line');
  const program = pressureAdvanceLineProgram(plan, OPTIONS);
  assert.equal(program.lines, plan.effects.length);
  for (const effect of plan.effects) {
    const line = effect.lineMm!;
    assert.ok(
      program.body.includes(`G1 X${line.end[0]} Y${line.end[1]}`),
      `the line ending at ${line.end[0]},${line.end[1]} is drawn`,
    );
  }
});

test('each command comes before the line it applies to, not after', () => {
  // The off-by-one that would be invisible: emit the command after the move and
  // every line prints at its predecessor's value, including the first, which
  // prints at whatever the machine had.
  const plan = planFor('pressure-advance-line');
  const body = pressureAdvanceLineProgram(plan, OPTIONS).body;
  for (const effect of plan.effects.slice(0, 5)) {
    const command = (effect.customGcode ?? '').trim();
    const move = `G1 X${effect.lineMm!.end[0]} Y${effect.lineMm!.end[1]}`;
    const commandAt = body.indexOf(command);
    const moveAt = body.indexOf(move, commandAt);
    assert.ok(commandAt >= 0, `${command} is emitted`);
    assert.ok(moveAt > commandAt, `${command} precedes the line it sets`);
    // And nothing else sets the value in between, or the line would print at
    // whatever came last.
    const between = body.slice(commandAt + command.length, moveAt);
    assert.doesNotMatch(between, /SET_PRESSURE_ADVANCE/, 'no other value is set between a command and its line');
  }
});

test('extrusion is proportional to length and never negative', () => {
  const single = extrusionForLine(100, OPTIONS);
  const double = extrusionForLine(200, OPTIONS);
  assert.ok(single > 0);
  assert.ok(Math.abs(double - single * 2) < 1e-9, 'twice the line is twice the filament');
  // A thicker bead at the same length uses more, which is the sanity check that
  // width and height are not silently dropped.
  assert.ok(extrusionForLine(100, { ...OPTIONS, lineWidthMm: 0.84 }) > single);
  assert.ok(extrusionForLine(100, { ...OPTIONS, layerHeightMm: 0.4 }) > single);
});

test('relative extrusion is declared, or every E would be read as absolute', () => {
  const body = pressureAdvanceLineProgram(planFor('pressure-advance-line'), OPTIONS).body;
  assert.match(body, /^M83$/m, 'E values are per-move; without M83 the first line would extrude metres');
  assert.match(body, /^G90$/m, 'coordinates are absolute, as the plan states them');
});

test('the body says what it is missing, and says it as data', () => {
  const program = pressureAdvanceLineProgram(planFor('pressure-advance-line'), OPTIONS);
  assert.ok(program.missing.length > 0, 'this is never a complete program');
  assert.match(program.missing.join(' '), /bed mesh calibration|nozzle cleaning/);
  assert.match(program.body, /machine preamble NOT included/, 'and the file itself says so, for anyone reading it');
});

test('the pattern sweep works the same way', () => {
  const plan = planFor('pressure-advance-pattern');
  const program = pressureAdvanceLineProgram(plan, OPTIONS);
  assert.equal(program.lines, plan.effects.length);
  assert.ok(program.filamentMm > 0);
});

test('a plan that is not a one-layer sweep is refused', () => {
  const plan = planFor('pressure-advance-line');
  const twoHeights = {
    ...plan,
    effects: plan.effects.map((effect, index) =>
      index === 0 ? { ...effect, lineMm: { start: [0, 0, 5] as const, end: [10, 0, 5] as const } } : effect,
    ),
  } as CalibrationJobPlan;
  assert.throws(() => pressureAdvanceLineProgram(twoHeights, OPTIONS), LineProgramError);
});

console.log(`\nPressure-advance line program: ${passed} tests passed.`);
