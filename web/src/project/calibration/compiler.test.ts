import assert from 'node:assert/strict';

import {
  CALIBRATION_WORKFLOW_IDS,
  PINNED_CALIBRATION_COMMIT,
  calibrationInventory,
  type CalibrationWorkflowId,
} from '../../features/calibrationInventory';
import { cloneJson } from '../domain/canonical';
import { CalibrationJobValidationError, compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { CALIBRATION_JOB_DEFINITIONS, getCalibrationJobDefinition } from './definitions';
import type { CalibrationFirmwareFlavor, CalibrationJobPrerequisites, CalibrationJobRequest } from './types';

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
    nozzle: {
      diameterMm: 0.4,
      minTemperatureC: 170,
      maxTemperatureC: 300,
      maxLayerHeightMm: 0.32,
    },
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

function request(
  id: CalibrationWorkflowId,
  parameters: Readonly<Record<string, string | number | boolean | readonly number[]>> = {},
): CalibrationJobRequest {
  return createDefaultCalibrationJobRequest(id, prerequisites(id === 'junction-deviation' ? 'marlin' : 'klipper'), {
    parameters,
  });
}

function plan(id: CalibrationWorkflowId) {
  return compileCalibrationJob(request(id), { jobId: `calibration:${id}` });
}

function expectValidation(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CalibrationJobValidationError);
    assert.ok(
      error.issues.some((candidate) => candidate.code === code),
      `missing issue ${code}`,
    );
    return true;
  });
}

test('definition catalog covers the exact frozen inventory with stable source-bound fingerprints', () => {
  assert.deepEqual(
    CALIBRATION_JOB_DEFINITIONS.map((definition) => definition.id),
    CALIBRATION_WORKFLOW_IDS,
  );
  assert.equal(CALIBRATION_JOB_DEFINITIONS.length, calibrationInventory.workflows.length);
  for (const definition of CALIBRATION_JOB_DEFINITIONS) {
    const workflow = calibrationInventory.workflows.find((candidate) => candidate.id === definition.id)!;
    assert.equal(definition.sourceCommit, PINNED_CALIBRATION_COMMIT);
    assert.match(definition.fingerprint, /^fnv1a64:[0-9a-f]{16}$/);
    assert.deepEqual(
      definition.parameters.map((parameter) => parameter.key),
      workflow.parameters.map((parameter) => parameter.key),
    );
    assert.deepEqual(definition.geometry.resources, workflow.resources);
    assert.deepEqual(definition.resultFields, workflow.resultFields);
    assert.deepEqual(definition.presetTargets, workflow.presetTargets);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.parameters));
  }
  assert.equal(getCalibrationJobDefinition('not-a-calibration'), undefined);
});

test('all fifteen default manual workflows compile into bounded detached effect plans', () => {
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const compiled = plan(id);
    const definition = getCalibrationJobDefinition(id)!;
    assert.equal(compiled.definitionId, id);
    assert.equal(compiled.definitionFingerprint, definition.fingerprint);
    assert.equal(compiled.execution, 'manual');
    assert.ok(compiled.effects.length > 0 && compiled.effects.length <= 512);
    assert.equal(compiled.expectedLabels.length, compiled.effects.length);
    assert.ok(compiled.geometry.requiredEnvelopeMm[0] <= compiled.prerequisites.printer.bedWidthMm);
    assert.ok(compiled.geometry.requiredEnvelopeMm[1] <= compiled.prerequisites.printer.bedDepthMm);
    assert.ok(compiled.geometry.requiredEnvelopeMm[2] <= compiled.prerequisites.printer.buildHeightMm);
    assert.ok(compiled.sliceAssertions.some((entry) => entry.kind === 'effect-count'));
    assert.deepEqual(compiled.resultFields, definition.resultFields);
    assert.deepEqual(compiled.presetTargets, definition.presetTargets);
    assert.ok(Object.isFrozen(compiled));
    assert.ok(Object.isFrozen(compiled.effects));
  }
});

test('temperature, retraction, volumetric, and VFA bands carry exact values, Z ranges, and engine effects', () => {
  const temperature = plan('temperature-tower');
  assert.deepEqual(
    temperature.effects.map((entry) => entry.value),
    [230, 225, 220, 215, 210, 205, 200, 195, 190],
  );
  assert.deepEqual(temperature.effects[0].zRangeMm, [0, 10]);
  assert.deepEqual(temperature.effects.at(-1)!.zRangeMm, [80, 90]);
  assert.equal(temperature.effects[0].customGcode, 'M104 S230\n');
  assert.deepEqual(temperature.effects[0].engineOverrides, [{ scope: 'layer', key: 'nozzle_temperature', value: 230 }]);

  const retraction = plan('retraction-tower');
  assert.equal(retraction.effects.length, 21);
  assert.deepEqual(retraction.effects[1].zRangeMm, [1.4, 2.4]);
  assert.deepEqual(retraction.effects.at(-1)!.engineOverrides, [
    { scope: 'layer', key: 'retraction_length', value: 2 },
  ]);

  const volumetric = plan('max-volumetric-speed');
  assert.equal(volumetric.effects.length, 31);
  assert.ok(volumetric.effects.every((entry) => entry.engineOverrides[0]?.key === 'outer_wall_speed'));
  assert.deepEqual(volumetric.geometry.requiredEnvelopeMm, [190.006, 171, 32]);

  const vfa = plan('vfa');
  assert.equal(vfa.effects.length, 17);
  assert.deepEqual(vfa.effects.at(-1)!.zRangeMm, [80, 85]);
  assert.equal(vfa.effects.at(-1)!.engineOverrides[0].value, 200);
});

test('flow templates preserve every pinned object modifier and real print-flow override', () => {
  const pass1 = plan('flow-pass-1');
  assert.deepEqual(
    pass1.effects.map((entry) => entry.engineOverrides[0].value),
    [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2],
  );
  const pass2 = plan('flow-pass-2');
  assert.deepEqual(
    pass2.effects.map((entry) => entry.engineOverrides[0].value),
    [0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1],
  );
  const yolo = plan('flow-yolo');
  assert.equal(yolo.effects.length, 11);
  assert.equal(yolo.effects[0].engineOverrides[0].key, 'print_flow_ratio');
  assert.equal(yolo.effects[5].engineOverrides[0].value, 1);
  assert.equal(plan('flow-yolo-perfectionist').effects.length, 16);
});

test('pressure-advance plans emit flavor-correct commands and bed-bound line identities', () => {
  const klipper = plan('pressure-advance-tower');
  assert.equal(klipper.effects.length, 51);
  assert.equal(klipper.effects[1].customGcode, 'SET_PRESSURE_ADVANCE ADVANCE=0.002\n');
  assert.deepEqual(klipper.effects[1].engineOverrides, [
    { scope: 'layer', key: 'enable_pressure_advance', value: true },
    { scope: 'layer', key: 'pressure_advance', value: 0.002 },
  ]);

  const marlinRequest = createDefaultCalibrationJobRequest('pressure-advance-line', prerequisites('marlin'));
  const marlin = compileCalibrationJob(marlinRequest, { jobId: 'calibration:pa-marlin' });
  assert.equal(marlin.effects[0].customGcode, 'M900 K0\n');
  assert.ok(marlin.effects.every((entry) => entry.lineMm?.start[0] === 10 && entry.lineMm.end[0] === 260));

  const reprapRequest = createDefaultCalibrationJobRequest('pressure-advance-pattern', prerequisites('reprap'));
  const reprap = compileCalibrationJob(reprapRequest, { jobId: 'calibration:pa-reprap' });
  assert.equal(reprap.effects[1].customGcode, 'M572 D0 S0.005\n');
  assert.ok(reprap.effects.every((entry) => entry.lineMm !== null));
});

test('input-shaping and junction-deviation plans expose every planned layer command', () => {
  const frequency = plan('input-shaping-frequency');
  assert.equal(frequency.effects.length, 300);
  assert.equal(frequency.effects[0].customGcode, 'SET_INPUT_SHAPER DAMPING_RATIO_X=0.150 DAMPING_RATIO_Y=0.150\n');
  assert.match(frequency.effects.at(-1)!.customGcode!, /SHAPER_FREQ_X=110\.00 SHAPER_FREQ_Y=110\.00/);

  const damping = plan('input-shaping-damping');
  assert.equal(damping.effects.length, 300);
  assert.match(damping.effects[0].customGcode!, /SHAPER_FREQ_X=30\.00/);
  assert.match(damping.effects.at(-1)!.customGcode!, /DAMPING_RATIO_X=0\.400/);

  const junction = plan('junction-deviation');
  assert.equal(junction.effects.length, 300);
  assert.match(junction.effects.at(-1)!.customGcode!, /^M205 J0\.250/);
  assert.equal(junction.effects.at(-1)!.engineOverrides[0].key, 'default_junction_deviation');
});

test('conditional defaults follow pinned filament/extruder selectors without weakening fixed fields', () => {
  const bowden = createDefaultCalibrationJobRequest('pressure-advance-tower', prerequisites(), {
    parameters: { extruderType: 'Bowden' },
  });
  assert.equal(bowden.parameters.end, 1);
  assert.equal(bowden.parameters.step, 0.02);
  assert.equal(compileCalibrationJob(bowden, { jobId: 'calibration:bowden' }).effects.length, 51);

  const petg = createDefaultCalibrationJobRequest('temperature-tower', prerequisites(), {
    parameters: { filamentType: 'PETG' },
  });
  assert.equal(petg.parameters.start, 250);
  assert.equal(petg.parameters.end, 230);
  assert.equal(petg.parameters.step, 5);

  const changedFixed = cloneJson(request('flow-pass-1'));
  (changedFixed.parameters as Record<string, string | number | boolean | readonly number[]>).pass = 2;
  expectValidation(() => compileCalibrationJob(changedFixed, { jobId: 'calibration:fixed' }), 'fixed-parameter');
});

test('schema, range, safety, fit, motion, firmware, and count faults all fail before a plan exists', () => {
  const stale: CalibrationJobRequest = {
    ...request('temperature-tower'),
    definitionFingerprint: 'fnv1a64:0000000000000000',
  };
  expectValidation(() => compileCalibrationJob(stale, { jobId: 'calibration:stale' }), 'definition-fingerprint');

  const automatic: CalibrationJobRequest = { ...request('temperature-tower'), execution: 'automatic' };
  expectValidation(() => compileCalibrationJob(automatic, { jobId: 'calibration:auto' }), 'automatic-unavailable');

  expectValidation(() => compileCalibrationJob(request('temperature-tower'), { jobId: '../bad' }), 'job-id');

  const unsafeTemperature = createDefaultCalibrationJobRequest('temperature-tower', prerequisites(), {
    parameters: { start: 280, end: 260 },
  });
  expectValidation(
    () => compileCalibrationJob(unsafeTemperature, { jobId: 'calibration:unsafe-temperature' }),
    'temperature-safety',
  );

  const unaligned = createDefaultCalibrationJobRequest('retraction-tower', prerequisites(), {
    parameters: { end: 2, step: 0.3 },
  });
  expectValidation(() => compileCalibrationJob(unaligned, { jobId: 'calibration:unaligned' }), 'sweep-alignment');

  const overFrequencyBase = prerequisites();
  const overFrequencyPrerequisites: CalibrationJobPrerequisites = {
    ...overFrequencyBase,
    firmware: { ...overFrequencyBase.firmware, maxInputShapingFrequencyHz: 100 },
  };
  const overFrequency = createDefaultCalibrationJobRequest('input-shaping-frequency', overFrequencyPrerequisites);
  expectValidation(
    () => compileCalibrationJob(overFrequency, { jobId: 'calibration:frequency' }),
    'firmware-frequency',
  );

  const wrongFirmware = createDefaultCalibrationJobRequest('junction-deviation', prerequisites('klipper'));
  expectValidation(() => compileCalibrationJob(wrongFirmware, { jobId: 'calibration:junction' }), 'firmware-flavor');

  const noCapabilityBase = prerequisites();
  const noCapabilityPrerequisites: CalibrationJobPrerequisites = {
    ...noCapabilityBase,
    firmware: { ...noCapabilityBase.firmware, pressureAdvance: false },
  };
  const noCapability = createDefaultCalibrationJobRequest('pressure-advance-tower', noCapabilityPrerequisites);
  expectValidation(() => compileCalibrationJob(noCapability, { jobId: 'calibration:no-pa' }), 'firmware-capability');

  const smallBedBase = prerequisites();
  const smallBedPrerequisites: CalibrationJobPrerequisites = {
    ...smallBedBase,
    printer: { ...smallBedBase.printer, bedDepthMm: 50 },
  };
  const smallBed = createDefaultCalibrationJobRequest('flow-pass-2', smallBedPrerequisites);
  expectValidation(() => compileCalibrationJob(smallBed, { jobId: 'calibration:small-bed' }), 'bed-depth');

  const tooMany = createDefaultCalibrationJobRequest('pressure-advance-tower', prerequisites(), {
    parameters: { end: 1, step: 0.001 },
  });
  expectValidation(() => compileCalibrationJob(tooMany, { jobId: 'calibration:too-many' }), 'effect-count');
});

test('compiled plans are deterministic and detached from mutable request inputs', () => {
  const mutable = cloneJson(request('vfa'));
  const first = compileCalibrationJob(mutable, { jobId: 'calibration:deterministic' });
  const second = compileCalibrationJob(mutable, { jobId: 'calibration:deterministic' });
  assert.deepEqual(first, second);
  (mutable.prerequisites.printer as { model: string }).model = 'Changed later';
  (mutable.parameters as Record<string, string | number | boolean | readonly number[]>).end = 210;
  assert.equal(first.prerequisites.printer.model, 'U1');
  assert.equal(first.parameters.end, 200);
});

console.log(`\n${passed} calibration job-model tests passed.`);
