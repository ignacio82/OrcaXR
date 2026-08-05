import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SAFE_KEYS } from '../../slicer/profileKeys';
import { EngineOptionCatalog, parseEngineOptionSchema } from '../generated/loader';
import { ENGINE_OPTION_SOURCE_COMMIT, type EngineOptionValue } from '../generated/types';
import {
  expandFullSpectrumSettingsTransaction,
  FULL_SPECTRUM_KEYS,
  FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS,
  FULL_SPECTRUM_SEMANTICS_SOURCE_COMMIT,
  getFullSpectrumDependencyState,
  getFullSpectrumSpecialEditorRequirement,
  validateFullSpectrumCrossFields,
} from './fullSpectrumSemantics';
import type { SettingsValueMap } from './types';

const schema = parseEngineOptionSchema(
  readFileSync(new URL('../generated/engine-options.schema.json', import.meta.url), 'utf8'),
);
const catalog = new EngineOptionCatalog(schema);

const P3_7_KEYS = Object.freeze([
  'mixed_color_layer_height_a',
  'mixed_color_layer_height_b',
  'mixed_filament_gradient_mode',
  'mixed_filament_height_lower_bound',
  'mixed_filament_height_upper_bound',
  'mixed_filament_advanced_dithering',
  'mixed_filament_pointillism_pixel_size',
  'mixed_filament_pointillism_line_gap',
  'mixed_filament_component_bias_enabled',
  'mixed_filament_surface_indentation',
  'mixed_filament_region_collapse',
  'mixed_filament_definitions',
  'dithering_z_step_size',
  'dithering_local_z_mode',
  'dithering_local_z_whole_objects',
  'dithering_local_z_infill',
  'dithering_local_z_direct_multicolor',
  'dithering_step_painted_zones_only',
  'local_z_wipe_tower_purge_lines',
]);

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('pins the GUI semantics to the same reviewed source revision and serialized definition metadata', () => {
  assert.equal(FULL_SPECTRUM_SEMANTICS_SOURCE_COMMIT, ENGINE_OPTION_SOURCE_COMMIT);
  const definitions = catalog.get(FULL_SPECTRUM_KEYS.definitions);
  assert.equal(definitions.storage.optionType, 'coString');
  assert.equal(definitions.presentation.guiFlags.value, 'serialized');
  assert.equal(definitions.provenance.commit, FULL_SPECTRUM_SEMANTICS_SOURCE_COMMIT);
  assert.deepEqual(FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS, [
    'dithering_local_z_whole_objects',
    'dithering_local_z_infill',
    'dithering_local_z_direct_multicolor',
  ]);
  assert.equal(Object.isFrozen(FULL_SPECTRUM_KEYS), true);
  assert.equal(Object.isFrozen(FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS), true);
});

test('exhaustively expands Local-Z enable and disable across every prior child-state combination', () => {
  for (const localZMode of [false, true]) {
    for (const wholeObjects of [false, true]) {
      for (const infill of [false, true]) {
        for (const directMulticolor of [false, true]) {
          const nested = [1, { percent: false, value: 2 }] as const;
          const before: SettingsValueMap = {
            unrelated_setting: nested,
            [FULL_SPECTRUM_KEYS.localZMode]: localZMode,
            [FULL_SPECTRUM_KEYS.localZWholeObjects]: wholeObjects,
            [FULL_SPECTRUM_KEYS.localZInfill]: infill,
            [FULL_SPECTRUM_KEYS.localZDirectMulticolor]: directMulticolor,
          };
          const snapshot = structuredClone(before);
          const result = expandFullSpectrumSettingsTransaction({
            changedKeys: ['unrelated_setting', FULL_SPECTRUM_KEYS.localZMode],
            effectiveValues: before,
          });

          if (localZMode) {
            assert.deepEqual(result.implicitValues, { [FULL_SPECTRUM_KEYS.localZInfill]: true });
            assert.deepEqual(result.implicitKeys, [FULL_SPECTRUM_KEYS.localZInfill]);
            assert.equal(result.effectiveValues[FULL_SPECTRUM_KEYS.localZWholeObjects], wholeObjects);
            assert.equal(result.effectiveValues[FULL_SPECTRUM_KEYS.localZInfill], true);
            assert.equal(result.effectiveValues[FULL_SPECTRUM_KEYS.localZDirectMulticolor], directMulticolor);
          } else {
            assert.deepEqual(result.implicitValues, {
              [FULL_SPECTRUM_KEYS.localZWholeObjects]: false,
              [FULL_SPECTRUM_KEYS.localZInfill]: false,
              [FULL_SPECTRUM_KEYS.localZDirectMulticolor]: false,
            });
            assert.deepEqual(result.implicitKeys, FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS);
            for (const key of FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS) {
              assert.equal(result.effectiveValues[key], false);
            }
          }

          assert.deepEqual(before, snapshot, 'transaction expansion must not mutate caller state');
          assert.notEqual(result.effectiveValues, before);
          assert.notEqual(result.effectiveValues.unrelated_setting, before.unrelated_setting);
          assert.equal(Object.isFrozen(result), true);
          assert.equal(Object.isFrozen(result.effectiveValues), true);
          assert.equal(Object.isFrozen(result.effectiveValues.unrelated_setting), true);
          assert.equal(Object.isFrozen(result.implicitValues), true);
          assert.equal(Object.isFrozen(result.implicitKeys), true);
        }
      }
    }
  }
});

test('does not apply mode side effects when another key changes and fails closed without a typed effective mode', () => {
  const values: SettingsValueMap = {
    [FULL_SPECTRUM_KEYS.localZMode]: false,
    [FULL_SPECTRUM_KEYS.localZWholeObjects]: true,
    [FULL_SPECTRUM_KEYS.localZInfill]: true,
    [FULL_SPECTRUM_KEYS.localZDirectMulticolor]: true,
  };
  const unchanged = expandFullSpectrumSettingsTransaction({
    changedKeys: [FULL_SPECTRUM_KEYS.localZInfill],
    effectiveValues: values,
  });
  assert.deepEqual(unchanged.implicitValues, {});
  assert.deepEqual(unchanged.implicitKeys, []);
  assert.deepEqual(unchanged.effectiveValues, values);

  const invalidModes: readonly (EngineOptionValue | undefined)[] = [
    undefined,
    null,
    0,
    1,
    '0',
    '1',
    [],
    { percent: false, value: 1 },
  ];
  for (const invalidMode of invalidModes) {
    const effectiveValues: Record<string, EngineOptionValue> = {};
    if (invalidMode !== undefined) effectiveValues[FULL_SPECTRUM_KEYS.localZMode] = invalidMode;
    assert.throws(
      () =>
        expandFullSpectrumSettingsTransaction({
          changedKeys: [FULL_SPECTRUM_KEYS.localZMode],
          effectiveValues,
        }),
      new RegExp(`Effective ${FULL_SPECTRUM_KEYS.localZMode} must be boolean`),
    );
  }
});

test('projects the exact three Local-Z child dependencies for enabled, disabled, missing, and invalid controller states', () => {
  const controllerCases: readonly [SettingsValueMap, boolean][] = [
    [{ [FULL_SPECTRUM_KEYS.localZMode]: true }, true],
    [{ [FULL_SPECTRUM_KEYS.localZMode]: false }, false],
    [{}, false],
    [{ [FULL_SPECTRUM_KEYS.localZMode]: 1 }, false],
    [{ [FULL_SPECTRUM_KEYS.localZMode]: '1' }, false],
  ];
  for (const key of FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS) {
    for (const [values, enabled] of controllerCases) {
      const state = getFullSpectrumDependencyState(key, values);
      assert.ok(state);
      assert.equal(state.key, key);
      assert.equal(state.controllerKey, FULL_SPECTRUM_KEYS.localZMode);
      assert.equal(state.controllerValue, true);
      assert.equal(state.visible, true);
      assert.equal(state.enabled, enabled);
      assert.equal(state.applicable, enabled);
      assert.equal(state.disabledReason, enabled ? undefined : 'requires-dithering-local-z-mode');
      assert.equal(Object.isFrozen(state), true);
    }
  }

  for (const unmanaged of [
    FULL_SPECTRUM_KEYS.localZMode,
    FULL_SPECTRUM_KEYS.heightLowerBound,
    FULL_SPECTRUM_KEYS.definitions,
    'DITHERING_LOCAL_Z_INFILL',
    `${FULL_SPECTRUM_KEYS.localZInfill} `,
    '',
  ]) {
    assert.equal(getFullSpectrumDependencyState(unmanaged, { [FULL_SPECTRUM_KEYS.localZMode]: true }), undefined);
  }
});

test('validates lower <= upper only when both effective values are finite numbers', () => {
  const validCases: readonly SettingsValueMap[] = [
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: 0.04,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.16,
    },
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: 0.16,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.16,
    },
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: 0.01,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.01,
    },
    { [FULL_SPECTRUM_KEYS.heightLowerBound]: 0.04 },
    { [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.16 },
    {},
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: '0.20',
      [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.16,
    },
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: 0.2,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: Number.NaN,
    },
    {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: Number.POSITIVE_INFINITY,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: 0.16,
    },
  ];
  for (const values of validCases) {
    const issues = validateFullSpectrumCrossFields(values);
    assert.deepEqual(issues, []);
    assert.equal(Object.isFrozen(issues), true);
  }

  for (const [lower, upper] of [
    [0.17, 0.16],
    [2, 1],
    [0.010_000_1, 0.01],
  ]) {
    const values = {
      [FULL_SPECTRUM_KEYS.heightLowerBound]: lower,
      [FULL_SPECTRUM_KEYS.heightUpperBound]: upper,
    };
    const snapshot = { ...values };
    const issues = validateFullSpectrumCrossFields(values);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0], {
      code: 'full-spectrum-height-bounds-order',
      path: FULL_SPECTRUM_KEYS.heightUpperBound,
      message: `Local-Z upper height bound (${upper}) must be greater than or equal to lower height bound (${lower})`,
      relatedKeys: [FULL_SPECTRUM_KEYS.heightLowerBound, FULL_SPECTRUM_KEYS.heightUpperBound],
    });
    assert.equal(Object.isFrozen(issues), true);
    assert.equal(Object.isFrozen(issues[0]), true);
    assert.equal(Object.isFrozen(issues[0].relatedKeys), true);
    assert.deepEqual(values, snapshot);
  }
});

test('requires the structured FullSpectrum editor for definitions and no other P3.7 field', () => {
  const requirement = getFullSpectrumSpecialEditorRequirement(FULL_SPECTRUM_KEYS.definitions);
  assert.deepEqual(requirement, {
    key: FULL_SPECTRUM_KEYS.definitions,
    kind: 'structured-editor-required',
    editorId: 'full-spectrum-recipes',
    genericEditable: false,
    unavailableReason: 'structured-editor:full-spectrum-recipes',
  });
  assert.equal(Object.isFrozen(requirement), true);
  assert.equal(getFullSpectrumSpecialEditorRequirement(FULL_SPECTRUM_KEYS.definitions), requirement);

  for (const key of P3_7_KEYS.filter((candidate) => candidate !== FULL_SPECTRUM_KEYS.definitions)) {
    assert.equal(getFullSpectrumSpecialEditorRequirement(key), undefined);
  }
  for (const lookalike of [
    'MIXED_FILAMENT_DEFINITIONS',
    'mixed-filament-definitions',
    `${FULL_SPECTRUM_KEYS.definitions} `,
    '',
  ]) {
    assert.equal(getFullSpectrumSpecialEditorRequirement(lookalike), undefined);
  }
});

test('keeps every P3.7 engine key in the crash-safe profile whitelist', () => {
  for (const key of P3_7_KEYS) assert.equal(SAFE_KEYS.has(key), true, `SAFE_KEYS must include ${key}`);
});

console.log(`\nFullSpectrum settings semantics: ${passed} tests passed.`);
