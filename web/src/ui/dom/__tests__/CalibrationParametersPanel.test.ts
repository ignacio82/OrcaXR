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

const DOC = 'https://github.com/Snapmaker/OrcaSlicer/blob/abc123/doc/calibration/temp-calib.md';

const base: CalibrationParametersPanelState = {
  workflowLabel: 'Temperature Tower',
  docHref: DOC,
  planSummary: '13 bands, 30 × 30 × 130 mm on the bed',
  preview: { fields: [numberField()], plan: {} as never, issues: [] },
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
      plan: {} as never,
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
