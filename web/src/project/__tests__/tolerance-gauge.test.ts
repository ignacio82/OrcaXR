/**
 * `tolerance-extension` is one gauge, not six pieces (P8.2).
 *
 * It was recorded as blocked on a job-model gap: six effects carrying no
 * settings, so placing them would print identical parts under different labels.
 * That reading was right about the effects and wrong about what they are for.
 *
 * The plan's required envelope is 57.937 × 14.401 × 6.401 mm. The shipped
 * gauge measures 57.936 × 14.400 × 6.400. The envelope is *one copy plus a fit
 * margin* — and six copies of a 57.9 mm part cannot sit at the 38.6 mm spacing
 * the effects give, because they would overlap by nineteen millimetres. The six
 * effects are the reading key for a single gauge whose clearances are cut into
 * its geometry.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../calibration/compiler';
import { calibrationInstructions } from '../calibration/instructions';
import type { CalibrationJobPrerequisites } from '../calibration/types';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
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

/** Bounding box of a binary STL, read without a mesh library. */
async function stlBounds(file: string): Promise<readonly [number, number, number]> {
  const bytes = new Uint8Array(await readFile(resolve(import.meta.dirname, '../../../public/calibration/' + file)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangles; index += 1) {
    const base = 84 + index * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(base + vertex * 12 + axis * 4, true);
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as const;
}

const plan = () =>
  compileCalibrationJob(createDefaultCalibrationJobRequest('tolerance-extension', PREREQS), {
    jobId: 'calibration:tolerance-gauge',
  });

await test('the plan’s envelope is one gauge, not six', async () => {
  const size = await stlBounds('OrcaToleranceTest.stl');
  const envelope = plan().geometry.requiredEnvelopeMm;
  for (const axis of [0, 1, 2]) {
    assert.ok(
      Math.abs(size[axis] - envelope[axis]) < 1,
      `axis ${axis}: gauge ${size[axis].toFixed(3)} mm against envelope ${envelope[axis]} mm`,
    );
  }
});

await test('six copies could not fit the spacing the effects give', async () => {
  // The arithmetic that settles it. Each effect is 38.571 mm from the next and
  // the gauge is 57.9 mm wide, so six placements would overlap by ~19 mm —
  // which is not a layout anyone intended.
  const [width] = await stlBounds('OrcaToleranceTest.stl');
  const effects = plan().effects;
  const spacing = effects[1].positionMm![0] - effects[0].positionMm![0];
  assert.ok(spacing > 0, 'the effects are spread along X');
  assert.ok(
    width > spacing,
    `a ${width.toFixed(3)} mm gauge cannot repeat every ${spacing.toFixed(3)} mm without overlapping`,
  );
});

await test('the six clearances are the reading key, and the sheet already carries them', () => {
  const sheet = calibrationInstructions(plan());
  assert.equal(sheet.bands.length, 6, 'six clearances to compare on one printed gauge');
  assert.deepEqual(
    sheet.bands.map((band) => band.value),
    [0, 0.05, 0.1, 0.2, 0.3, 0.4],
  );
  assert.ok(
    sheet.measurements.some((field) => field.key === 'passingClearanceMm'),
    'and the operator is told to report which clearance fits freely',
  );
});

console.log(`\nTolerance gauge: ${passed} tests passed.`);
