/**
 * Traces for the calibration parameter panel (P8.3).
 *
 * The panel holds no rules, so what is worth pinning is that it reports the
 * ones it is given faithfully: the right box is marked, the operator cannot
 * build from a form that does not compile, and a fixed parameter is not
 * presented as if it were adjustable.
 */

import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { CalibrationParametersPanel, type CalibrationParametersPanelState } from '../CalibrationParametersPanel';
import type { CalibrationFormField } from '../../../project/calibration/form';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../../../project/calibration/compiler';
import type { CalibrationJobPrerequisites } from '../../../project/calibration/types';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const numberField = (over: Partial<CalibrationFormField> = {}): CalibrationFormField => ({
  key: 'start',
  label: 'Start',
  kind: 'number',
  unit: '°C',
  editable: true,
  choices: [],
  range: { min: 170, max: 350, step: 5, minInclusive: true, maxInclusive: true },
  maxItems: null,
  text: '230',
  changed: false,
  ...over,
});

function mount(state: CalibrationParametersPanelState): {
  host: HTMLElement;
  calls: string[];
  setState: (next: CalibrationParametersPanelState) => void;
} {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const host = dom.window.document.getElementById('host') as unknown as HTMLElement;
  let current = state;
  const calls: string[] = [];
  const panel = new CalibrationParametersPanel(host, {
    getState: () => current,
    onEdit: (key, text) => {
      calls.push(`edit:${key}=${text}`);
    },
    onReset: () => {
      calls.push('reset');
    },
    onGenerate: () => {
      calls.push('generate');
    },
  });
  panel.mount();
  return {
    host,
    calls,
    setState: (next) => {
      current = next;
      panel.refresh();
    },
  };
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
    flavor: 'klipper',
    nozzleTemperature: true,
    pressureAdvance: true,
    inputShaping: true,
    junctionDeviation: true,
    maxInputShapingFrequencyHz: 500,
  },
};

// A real compiled plan, not `{} as never`. The panel reads a plan's effects to
// build the reading key, so a stub that claims to be one while holding nothing
// is a fixture that agrees with no code path.
const PLAN = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', PREREQS), {
  jobId: 'calibration:panel-fixture',
});

const DOC = 'https://github.com/Snapmaker/OrcaSlicer/blob/abc123/doc/calibration/temp-calib.md';

const base: CalibrationParametersPanelState = {
  workflowLabel: 'Temperature Tower',
  docHref: DOC,
  planSummary: '13 bands, 30 × 30 × 130 mm on the bed',
  preview: { fields: [numberField()], plan: PLAN, issues: [] },
};

await test('a compiling form offers to build and reports what it would build', () => {
  const view = mount(base);
  const generate = view.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-generate"]');
  assert.ok(generate);
  assert.equal(generate.disabled, false);
  assert.match(view.host.querySelector('[data-calibration-preview]')?.textContent ?? '', /13 bands/);
});

await test('a form that does not compile cannot be built from', () => {
  const view = mount({
    ...base,
    preview: {
      fields: [numberField({ text: '', changed: true })],
      plan: null,
      issues: [{ code: 'unreadable-parameter', path: '$.parameters.start', message: 'Start needs a number' }],
    },
  });
  const generate = view.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-generate"]');
  assert.equal(generate?.disabled, true, 'no plan means nothing to add');
});

await test('an issue marks the field that caused it, not the panel', () => {
  const view = mount({
    ...base,
    preview: {
      fields: [numberField({ text: 'x', changed: true }), numberField({ key: 'end', label: 'End', text: '190' })],
      plan: null,
      issues: [{ code: 'unreadable-parameter', path: '$.parameters.start', message: 'Start is not a number' }],
    },
  });
  const bad = view.host.querySelector<HTMLInputElement>('[data-calibration-input="start"]');
  const good = view.host.querySelector<HTMLInputElement>('[data-calibration-input="end"]');
  assert.equal(bad?.getAttribute('aria-invalid'), 'true');
  assert.equal(good?.hasAttribute('aria-invalid'), false, 'the field that is fine is not marked');

  const message = view.host.querySelector('[data-calibration-field-issue="start"]');
  assert.ok(message);
  assert.equal(message.getAttribute('role'), 'alert');
  // The message is tied to its input, so a screen reader reaches it from the
  // field rather than only by encountering it separately.
  assert.equal(bad?.getAttribute('aria-describedby'), message.id);
});

await test('an issue with no field path is reported as a whole-form message', () => {
  const view = mount({
    ...base,
    preview: {
      fields: [numberField()],
      plan: null,
      issues: [{ code: 'envelope', path: '$.geometry', message: 'The tower is taller than the printer.' }],
    },
  });
  assert.match(
    view.host.querySelector('[data-calibration-preview]')?.textContent ?? '',
    /taller than the printer/,
    'a fault that belongs to no single field still has to be said',
  );
});

await test('a fixed parameter is shown but not adjustable', () => {
  const view = mount({
    ...base,
    preview: {
      fields: [numberField({ key: 'step', label: 'Step', editable: false, text: '5' })],
      plan: PLAN,
      issues: [],
    },
  });
  const input = view.host.querySelector<HTMLInputElement>('[data-calibration-input="step"]');
  assert.ok(input, 'it is visible, so the operator knows what it is');
  assert.equal(input.disabled, true, 'and inert, because the definition fixed it');
});

await test('reset is inert until something has been changed', () => {
  const clean = mount(base);
  assert.equal(
    clean.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-reset"]')?.disabled,
    true,
  );
  const dirty = mount({
    ...base,
    preview: { ...base.preview, fields: [numberField({ text: '240', changed: true })] },
  });
  assert.equal(
    dirty.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-reset"]')?.disabled,
    false,
  );
});

await test('a compiled plan comes with the key to reading the print', () => {
  // Built from a real compiled plan rather than a stub: the point of the sheet
  // is that it matches what was installed, and a hand-written fixture could
  // agree with nothing.
  const compiled = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', PREREQS), {
    jobId: 'calibration:panel-instructions',
  });
  const view = mount({ ...base, preview: { fields: [numberField()], plan: compiled, issues: [] } });

  const details = view.host.querySelector('[data-calibration-instructions]');
  assert.ok(details, 'the key is present once there is a plan');
  const bands = view.host.querySelectorAll('[data-calibration-band]');
  assert.equal(
    bands.length,
    compiled.effects.length,
    'every band is listed; the one you need is the one truncation hides',
  );
  assert.match(bands[0].textContent ?? '', /mm from the bed/, 'a tower is located by height');

  const measure = view.host.querySelector('[data-calibration-measurements]');
  assert.match(measure?.textContent ?? '', /Measure:/);
  assert.match(
    measure?.textContent ?? '',
    /writes to/,
    'the operator is told where a result lands before recording one',
  );
});

await test('a plan that breaks its own definition cannot be built from, and says how', () => {
  // Not a hypothetical: a consumer that drops effects produces exactly this,
  // and the compiler would have returned the plan quite happily.
  const broken = { ...PLAN, effects: PLAN.effects.slice(0, -1) };
  const view = mount({ ...base, preview: { fields: [numberField()], plan: broken, issues: [] } });

  const generate = view.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-generate"]');
  assert.equal(generate?.disabled, true, 'a plan that is no longer the calibration is not offered');
  const alert = view.host.querySelector('[data-calibration-assertion-failures]');
  assert.ok(alert, 'and the reason is shown');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent ?? '', /expected 9 bands, the plan has 8/);
});

await test('a withheld build says why, and still reports what the settings would make', () => {
  const view = mount({
    ...base,
    generateUnavailableReason: 'Building a compiled plan into the project is still P8.2 work.',
  });
  const generate = view.host.querySelector<HTMLButtonElement>('[data-calibration-action="calibration-generate"]');
  assert.equal(generate?.disabled, true, 'withheld rather than pretending to work');
  assert.equal(generate?.dataset.calibrationUnavailable, 'true');
  assert.match(generate?.title ?? '', /P8\.2/, 'and it says why rather than being mysteriously grey');

  const summary = view.host.querySelector('[data-calibration-preview]')?.textContent ?? '';
  assert.match(summary, /13 bands/, 'the preview is still the point, even when acting on it is not offered');
  assert.match(summary, /P8\.2/);
});

await test('edits report the text as typed, and the doc link is safe and pinned', async () => {
  const view = mount(base);
  const input = view.host.querySelector<HTMLInputElement>('[data-calibration-input="start"]')!;
  input.value = '245';
  input.dispatchEvent(new (input.ownerDocument.defaultView as Window & typeof globalThis).Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['edit:start=245']);

  const link = view.host.querySelector<HTMLAnchorElement>('[data-calibration-doc]');
  assert.equal(link?.href, DOC);
  // A new tab gets no handle back on the opener.
  assert.equal(link?.rel, 'noopener noreferrer');
});

console.log(`\nCalibration parameters panel: ${passed} tests passed.`);
