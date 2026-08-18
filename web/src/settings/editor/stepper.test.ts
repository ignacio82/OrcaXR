/**
 * Traces for the engine-setting stepper (P6.5).
 *
 * P6.5 wants one draft and one validation across desktop, touch and XR, and XR
 * had no scoped-settings surface because entering a value there means typing.
 * Calibration parameters solved that with steppers; an engine option differs in
 * one way that decides the whole design — it declares bounds but **no step**.
 *
 * So the increment is derived, and an option with no bounds gets no stepper at
 * all. Driven against the real shipped schema rather than hand-built
 * definitions, because a definition invented here would agree with this code
 * and with nothing that ships.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadEngineOptionSchema } from '../generated/loader';
import { stepFor, stepSettingValue } from './stepper';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const json = await readFile(resolve(import.meta.dirname, '../generated/engine-options.schema.json'), 'utf8');
const schema = await loadEngineOptionSchema('memory:engine-options', async () => new Response(json, { status: 200 }));

function definitionFor(predicate: (definition: (typeof schema.definitions)[number]) => boolean) {
  return schema.definitions.find(predicate);
}

test('a step is a round fraction of the range, not an arbitrary one', () => {
  // An operator reads these numbers. 0.1 is a step; 0.137 is a defect report.
  assert.equal(stepFor(0, 100), 1);
  assert.equal(stepFor(0, 10), 0.1);
  assert.equal(stepFor(0, 1), 0.01);
  assert.equal(stepFor(0, 0), 0, 'a zero span has no step');
});

test('a bounded number steps and stops at its own limits', () => {
  const bounded = definitionFor(
    (definition) =>
      definition.storage.optionType === 'coFloat' &&
      definition.storage.shape === 'scalar' &&
      definition.constraints.min.value !== null &&
      definition.constraints.max.value !== null &&
      (definition.constraints.max.value as number) > (definition.constraints.min.value as number) &&
      !definition.presentation.readonly.value,
  );
  assert.ok(bounded, 'the shipped schema has a bounded float');
  const minimum = bounded.constraints.min.value as number;
  const maximum = bounded.constraints.max.value as number;

  const up = stepSettingValue(bounded, `${minimum}`, 1);
  assert.ok(up.value !== null, `${bounded.key} steps up from its minimum`);
  assert.ok(Number.parseFloat(up.value) > minimum);

  assert.equal(
    Number.parseFloat(stepSettingValue(bounded, `${minimum}`, -1).value ?? 'NaN'),
    minimum,
    'and stops at the minimum',
  );
  assert.equal(
    Number.parseFloat(stepSettingValue(bounded, `${maximum}`, 1).value ?? 'NaN'),
    maximum,
    'and at the maximum',
  );
});

test('an unbounded number is refused rather than given an invented step', () => {
  // The rule already applied to the brim-ear radius and the SVG size: a stepper
  // without bounds is a text field with extra presses, and would let a headset
  // reach a value the DOM would refuse.
  const unbounded = definitionFor(
    (definition) =>
      definition.storage.optionType === 'coFloat' &&
      definition.storage.shape === 'scalar' &&
      definition.constraints.min.value === null &&
      definition.constraints.max.value === null &&
      !definition.presentation.readonly.value,
  );
  assert.ok(unbounded, 'the shipped schema has an unbounded float');
  const outcome = stepSettingValue(unbounded, '1', 1);
  assert.equal(outcome.value, null);
  assert.equal(outcome.refusal, 'unbounded');
});

test('a boolean toggles', () => {
  const boolean = definitionFor(
    (definition) => definition.storage.optionType === 'coBool' && !definition.presentation.readonly.value,
  );
  assert.ok(boolean);
  assert.equal(stepSettingValue(boolean, '0', 1).value, '1');
  assert.equal(stepSettingValue(boolean, '1', 1).value, '0');
});

test('a vector setting is refused, because no component was named', () => {
  // Stepping the first component of a point would edit a setting the operator
  // did not choose.
  const vector = definitionFor(
    (definition) => definition.storage.shape === 'vector' && !definition.presentation.readonly.value,
  );
  if (!vector) return;
  assert.equal(stepSettingValue(vector, '0,0', 1).value, null);
});

test('every steppable setting stays inside its own bounds, across the whole schema', () => {
  // The sweep. One press from each end, in both directions, on every bounded
  // scalar the engine declares — a step derived from a range must never produce
  // a value that range forbids.
  let checked = 0;
  for (const definition of schema.definitions) {
    const minimum = definition.constraints.min.value;
    const maximum = definition.constraints.max.value;
    if (minimum === null || maximum === null) continue;
    if (definition.storage.shape !== 'scalar') continue;
    if (definition.presentation.readonly.value) continue;
    for (const [start, direction] of [
      [minimum, -1],
      [maximum, 1],
      [minimum, 1],
      [maximum, -1],
    ] as const) {
      const outcome = stepSettingValue(definition, `${start}`, direction);
      if (outcome.value === null) continue;
      const value = Number.parseFloat(outcome.value);
      if (!Number.isFinite(value)) continue;
      assert.ok(
        value >= minimum - 1e-9 && value <= maximum + 1e-9,
        `${definition.key}: stepping ${direction > 0 ? 'up' : 'down'} from ${start} produced ${value}, outside ${minimum}..${maximum}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 100, `the sweep covered real settings (${checked} steps)`);
});

console.log(`\nSettings stepper: ${passed} tests passed.`);
