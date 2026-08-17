/**
 * Traces for calibration parameter editing and its preview (P8.3).
 *
 * The properties worth holding are the ones a form usually gets wrong. A
 * cleared number field must not become zero. A parameter the definition marks
 * uneditable must not be steerable by passing an edit anyway. And the preview
 * must be the compiler's answer rather than a second opinion, so that what an
 * operator is shown is what would actually be built.
 */

import assert from 'node:assert/strict';

import { buildCalibrationForm, describeCalibrationPlan } from './form';
import { stepCalibrationValue } from './stepper';
import { CALIBRATION_JOB_DEFINITIONS } from './definitions';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
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

const JOB = 'calibration:form-trace-1';

test('every pinned calibration builds a form and a plan from its own defaults', () => {
  for (const definition of CALIBRATION_JOB_DEFINITIONS) {
    const flavor: CalibrationFirmwareFlavor = definition.id === 'junction-deviation' ? 'marlin' : 'klipper';
    const preview = buildCalibrationForm(definition.id, prerequisites(flavor), {}, JOB);
    assert.deepEqual(preview.issues, [], `${definition.id} compiles untouched: ${JSON.stringify(preview.issues)}`);
    assert.ok(preview.plan, `${definition.id} produces a plan`);
    assert.equal(preview.fields.length, definition.parameters.length);
    assert.ok(
      preview.fields.every((field) => !field.changed),
      `${definition.id} reports nothing changed before anything is edited`,
    );
    assert.match(describeCalibrationPlan(preview.plan), /band/);
  }
});

test('every default survives being shown and read back', () => {
  // The round trip is the property that makes a form safe to render at all: a
  // value shown to an operator who touches nothing must parse back to what it
  // started as. This caught a real one — several calibrations default their
  // `speeds` and `accelerations` to an empty list, which an earlier version of
  // the parser read as a blank and refused, making those workflows uncompilable
  // from their own defaults.
  for (const definition of CALIBRATION_JOB_DEFINITIONS) {
    const flavor: CalibrationFirmwareFlavor = definition.id === 'junction-deviation' ? 'marlin' : 'klipper';
    const shown = buildCalibrationForm(definition.id, prerequisites(flavor), {}, JOB);
    const echoed = Object.fromEntries(shown.fields.map((field) => [field.key, field.text]));
    const reread = buildCalibrationForm(definition.id, prerequisites(flavor), echoed, JOB);
    assert.deepEqual(reread.issues, [], `${definition.id} reads back its own displayed defaults`);
    assert.deepEqual(reread.plan, shown.plan, `${definition.id} compiles to the same plan after a round trip`);
    assert.ok(
      reread.fields.every((field) => !field.changed),
      `${definition.id} does not report an edit when nothing was edited`,
    );
  }
});

test('the preview is the compiler’s own answer, not a second opinion', () => {
  const definition = CALIBRATION_JOB_DEFINITIONS.find((entry) => entry.id === 'temperature-tower');
  assert.ok(definition);
  const preview = buildCalibrationForm(definition.id, prerequisites(), {}, JOB);
  const direct = compileCalibrationJob(createDefaultCalibrationJobRequest(definition.id, prerequisites()), {
    jobId: JOB,
  });
  // Identical, because a preview that agrees only approximately with what gets
  // built is a preview of something else.
  assert.deepEqual(preview.plan, direct);
});

test('a cleared number is absent, never zero', () => {
  const definition = CALIBRATION_JOB_DEFINITIONS.find((entry) =>
    entry.parameters.some((parameter) => parameter.kind === 'number' && parameter.editable),
  );
  assert.ok(definition, 'some calibration has an editable number');
  const numberField = definition.parameters.find((p) => p.kind === 'number' && p.editable)!;

  const preview = buildCalibrationForm(definition.id, prerequisites(), { [numberField.key]: '   ' }, JOB);
  assert.equal(preview.plan, null, 'nothing is compiled from an unreadable form');
  assert.equal(preview.issues.length, 1);
  assert.equal(preview.issues[0].code, 'unreadable-parameter');
  assert.match(preview.issues[0].message, /needs a number/);
  // The trap this exists for: Number('') is 0, and a calibration silently run
  // at zero is worse than one that refuses.
  assert.ok(!preview.issues[0].message.includes('0'));
});

test('an unreadable number says so instead of being coerced', () => {
  const definition = CALIBRATION_JOB_DEFINITIONS.find((entry) =>
    entry.parameters.some((parameter) => parameter.kind === 'number' && parameter.editable),
  )!;
  const numberField = definition.parameters.find((p) => p.kind === 'number' && p.editable)!;
  const preview = buildCalibrationForm(definition.id, prerequisites(), { [numberField.key]: '21o' }, JOB);
  assert.equal(preview.plan, null);
  assert.match(preview.issues[0].message, /is not a number/);
});

test('an uneditable parameter cannot be steered by passing an edit anyway', () => {
  const definition = CALIBRATION_JOB_DEFINITIONS.find((entry) =>
    entry.parameters.some((parameter) => !parameter.editable),
  );
  if (!definition) {
    console.log('    (no pinned calibration declares a fixed parameter; nothing to hold)');
    return;
  }
  const fixed = definition.parameters.find((parameter) => !parameter.editable)!;
  const flavor: CalibrationFirmwareFlavor = definition.id === 'junction-deviation' ? 'marlin' : 'klipper';
  const preview = buildCalibrationForm(definition.id, prerequisites(flavor), { [fixed.key]: '999' }, JOB);
  const field = preview.fields.find((entry) => entry.key === fixed.key)!;
  assert.equal(field.editable, false);
  assert.equal(field.changed, false, 'the definition decides this, not the caller');
  assert.notEqual(field.text, '999');
});

test('a value the compiler rejects is reported as the compiler’s issue, with its path', () => {
  // `start` is bounded 170..350 by the pinned definition, so 900 is refused by
  // the compiler rather than by this module — which is the point: the rules
  // live in one place, and this module does not get a second opinion.
  const preview = buildCalibrationForm('temperature-tower', prerequisites(), { start: '900' }, JOB);
  assert.equal(preview.plan, null);
  assert.ok(preview.issues.length > 0);
  assert.ok(
    preview.issues.every((issue) => issue.path.startsWith('$')),
    'every issue points at the field that caused it',
  );
  assert.ok(
    preview.issues.every((issue) => issue.code !== 'unreadable-parameter'),
    'these parsed fine; they are simply not allowed',
  );
});

test('an edit is reported as changed, and regenerating is just asking again', () => {
  const definition = CALIBRATION_JOB_DEFINITIONS.find((entry) =>
    entry.parameters.some((parameter) => parameter.kind === 'number' && parameter.editable),
  )!;
  const numberField = definition.parameters.find((p) => p.kind === 'number' && p.editable)!;
  const base = buildCalibrationForm(definition.id, prerequisites(), {}, JOB);
  const original = base.fields.find((entry) => entry.key === numberField.key)!.text;

  const edited = buildCalibrationForm(definition.id, prerequisites(), { [numberField.key]: original }, JOB);
  assert.equal(edited.fields.find((entry) => entry.key === numberField.key)!.changed, false, 'same text is no change');

  // Asking twice with the same inputs and job id gives the same plan, which is
  // what makes "regenerate" a re-ask rather than a separate code path.
  const again = buildCalibrationForm(definition.id, prerequisites(), {}, JOB);
  assert.deepEqual(again.plan, base.plan);
});

test('an edit naming a parameter the definition does not have is ignored, not smuggled through', () => {
  // The form is the definition's fields and nothing else. A caller passing a
  // key that does not exist must not be able to inject it into the request,
  // where the compiler would see a parameter no operator could have typed.
  const clean = buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB);
  const withStray = buildCalibrationForm(
    'temperature-tower',
    prerequisites(),
    { 'start-temperature': '900', nonsense: 'x' },
    JOB,
  );
  assert.deepEqual(withStray.plan, clean.plan);
  assert.equal(withStray.fields.length, clean.fields.length);
});

test('a stepper walks the definition’s own steps and stops at its bounds', () => {
  // How a headset enters a number. The values it can reach must be exactly the
  // ones the definition allows — a stepper that walked past a limit and then
  // reported a compiler error would have lied about what it could do.
  const form = buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB);
  const start = form.fields.find((field) => field.key === 'start')!;
  assert.equal(start.range?.step, 5);

  assert.equal(stepCalibrationValue(start, 1), '235', 'one press moves by the declared step');
  assert.equal(stepCalibrationValue({ ...start, text: '350' }, 1), '350', 'and stops at the maximum');
  assert.equal(stepCalibrationValue({ ...start, text: '170' }, -1), '170', 'and at the minimum');
});

test('a fixed parameter cannot be stepped either', () => {
  const form = buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB);
  const fixed = form.fields.find((field) => !field.editable);
  assert.ok(fixed, 'temperature-tower fixes its step size');
  assert.equal(stepCalibrationValue(fixed, 1), null, 'the definition decides this on every surface, not just the DOM');
});

test('choices cycle and booleans toggle, because the definition enumerates them', () => {
  const form = buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB);
  const choice = form.fields.find((field) => field.kind === 'choice' && field.editable);
  if (choice) {
    const next = stepCalibrationValue(choice, 1);
    assert.ok(choice.choices.includes(next!), 'a step lands on a declared choice, never on free text');
    // Wrapping rather than stopping: a cycle has no end to bump into.
    const last = { ...choice, text: choice.choices[choice.choices.length - 1] };
    assert.equal(stepCalibrationValue(last, 1), choice.choices[0]);
  }
  const boolean = { ...form.fields[0], kind: 'boolean' as const, text: 'false', editable: true };
  assert.equal(stepCalibrationValue(boolean, 1), 'true');
  assert.equal(stepCalibrationValue({ ...boolean, text: 'true' }, 1), 'false');
});

test('a fractional step does not show an operator a floating-point artefact', () => {
  // 0.1 + 0.2 is the classic; a calibration field showing 0.30000000000000004
  // is a field nobody trusts again.
  const field = {
    ...buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB).fields[1],
    kind: 'number' as const,
    editable: true,
    text: '0.2',
    range: { min: 0, max: 5, step: 0.1, minInclusive: true, maxInclusive: true },
  };
  assert.equal(stepCalibrationValue(field, 1), '0.3');
});

test('an unreadable value cannot be stepped into a plausible one', () => {
  const field = {
    ...buildCalibrationForm('temperature-tower', prerequisites(), {}, JOB).fields[1],
    kind: 'number' as const,
    editable: true,
    text: 'abc',
  };
  assert.equal(stepCalibrationValue(field, 1), null, 'stepping nonsense must not produce a number');
});

test('an unknown calibration is refused rather than compiled', () => {
  const preview = buildCalibrationForm('not-a-calibration' as never, prerequisites(), {}, JOB);
  assert.equal(preview.plan, null);
  assert.deepEqual(preview.fields, []);
  assert.equal(preview.issues[0].code, 'unknown-definition');
});

console.log(`\nCalibration form: ${passed} tests passed.`);
