import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SAFE_KEYS } from '../../slicer/profileKeys';
import { projectUsesWaveOverhangs, type WaveProjectShape } from '../waveOverhangsProject';
import {
  WAVE_MASTER_KEY,
  WAVE_OPTION_GROUPS,
  WAVE_OVERHANG_OPTIONS,
  WaveValueError,
  isWaveOverhangKey,
  parseWaveValue,
  resolveWaveSettings,
  serializeWaveValue,
  steppedWaveValue,
  waveChoiceLabel,
  waveFlowForNozzle,
  waveGenerationBlockers,
  waveMaterialAssessment,
  waveNozzleDiameter,
  waveOption,
  waveOptionText,
  waveValueProblem,
  withWaveValue,
  withoutUnknownWaveKeys,
  withoutWaveOverrides,
  type WaveOverhangOption,
} from '../waveOverhangs';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const option = (key: string): WaveOverhangOption => {
  const found = waveOption(key);
  assert.ok(found, `${key} is defined`);
  return found;
};

test('the table defines exactly the 38 options the engine port adds, once each, in known groups', () => {
  const keys = WAVE_OVERHANG_OPTIONS.map((entry) => entry.key);
  assert.equal(keys.length, 38);
  assert.equal(new Set(keys).size, keys.length, 'no key is listed twice');
  assert.equal(keys[0], WAVE_MASTER_KEY, 'the master switch leads the page');
  for (const entry of WAVE_OVERHANG_OPTIONS) {
    assert.ok(WAVE_OPTION_GROUPS.includes(entry.group), `${entry.key} is in a known group`);
    assert.ok(isWaveOverhangKey(entry.key), `${entry.key} is recognised as a wave key`);
  }
  // The retired generators' keys are wave keys, but no longer defined ones.
  for (const retired of ['wave_overhang_algorithm', 'wave_overhang_ring_overlap']) {
    assert.equal(isWaveOverhangKey(retired), true);
    assert.equal(waveOption(retired), undefined);
  }
  assert.equal(isWaveOverhangKey('wall_loops'), false);
});

test('printer profiles may carry exactly the wave keys the engine defines', () => {
  // ProfileLoader drops any profile key outside SAFE_KEYS, so a defined option
  // missing there is silently lost from imported profiles, and a retired one
  // listed there is handed to an engine that rejects it.
  const allowed = [...SAFE_KEYS].filter(isWaveOverhangKey).sort();
  assert.deepEqual(allowed, WAVE_OVERHANG_OPTIONS.map((entry) => entry.key).sort());
});

test('every engine default is a value the engine itself accepts', () => {
  for (const entry of WAVE_OVERHANG_OPTIONS) {
    assert.equal(waveValueProblem(entry, entry.engineDefault), undefined, `${entry.key} default is valid`);
    if (entry.passthrough !== undefined) {
      assert.equal(waveValueProblem(entry, entry.passthrough), undefined, `${entry.key} passthrough is valid`);
    }
    for (const parent of entry.requires ?? []) {
      assert.equal(waveOption(parent)?.kind, 'bool', `${entry.key} depends on a boolean option`);
    }
    if (entry.kind === 'enum') assert.ok(entry.choices && entry.choices.length > 1, `${entry.key} lists choices`);
  }
});

test('the defaults match the engine port, not the invented numbers the old panel displayed', () => {
  assert.equal(option('wave_overhang_print_speed').engineDefault, 2);
  assert.equal(option('wave_overhang_travel_speed').engineDefault, 40);
  assert.equal(option('wave_overhang_fan_speed').engineDefault, 100);
  assert.equal(option('wave_overhang_floor_layers').engineDefault, 2);
  assert.equal(option('wave_overhang_floor_use_hilbert').engineDefault, false);
  assert.equal(option('wave_overhang_pattern').engineDefault, 'smart');
  assert.equal(option('wave_overhang_flow_mm3_per_mm').engineDefault, 0.15);
});

test('the defaults agree with the engine source the WASM build compiles, when that checkout is present', () => {
  // The WASM slice test compares the defaults with what the built engine writes;
  // this checks the same table against the patched PrintConfig.cpp when a fork
  // checkout is available, so a hand edit to either side is caught without a slice.
  let source: string;
  try {
    source = readFileSync(
      new URL('../../../../third_party/SnapmakerOrca/src/libslic3r/PrintConfig.cpp', import.meta.url),
      'utf8',
    );
  } catch {
    console.log('    (skipped: no third_party/SnapmakerOrca checkout)');
    return;
  }
  if (!source.includes('"wave_overhangs"')) {
    console.log('    (skipped: the checkout carries no wave-overhang port)');
    return;
  }
  for (const entry of WAVE_OVERHANG_OPTIONS) {
    const start = source.indexOf(`def = this->add("${entry.key}"`);
    assert.ok(start >= 0, `${entry.key} is defined in PrintConfig.cpp`);
    const end = source.indexOf('def = this->add(', start + 10);
    const body = source.slice(start, end < 0 ? undefined : end);
    const min = body.match(/def->min\s*=\s*([-\d.]+)/)?.[1];
    const max = body.match(/def->max\s*=\s*([-\d.]+)/)?.[1];
    assert.equal(min === undefined ? undefined : Number(min), entry.min, `${entry.key} min`);
    assert.equal(max === undefined ? undefined : Number(max), entry.max, `${entry.key} max`);
    assert.equal(/def->mode\s*=\s*comDevelop/.test(body), entry.develop === true, `${entry.key} develop mode`);
  }
});

test('stored values parse the way the engine reads them, and anything else is refused, not guessed', () => {
  const master = option(WAVE_MASTER_KEY);
  assert.equal(parseWaveValue(master, '1'), true);
  assert.equal(parseWaveValue(master, 0), false);
  assert.equal(parseWaveValue(master, true), true);
  assert.equal(parseWaveValue(master, ['1']), true);
  assert.equal(parseWaveValue(master, 'yes'), undefined);
  const layers = option('wave_overhang_floor_layers');
  assert.equal(parseWaveValue(layers, '3'), 3);
  assert.equal(parseWaveValue(layers, '2.5'), undefined, 'an integer option refuses a fraction');
  assert.equal(parseWaveValue(layers, ''), undefined);
  assert.equal(parseWaveValue(layers, ['1', '2']), undefined, 'a list is not a scalar');
  const pattern = option('wave_overhang_pattern');
  assert.equal(parseWaveValue(pattern, 'zigzag'), 'zigzag');
  assert.equal(parseWaveValue(pattern, 'kaiser'), undefined);
  assert.equal(serializeWaveValue(master, true), '1');
  assert.equal(serializeWaveValue(layers, 4), '4');
  assert.equal(serializeWaveValue(option('wave_overhang_line_spacing'), 0.1 + 0.2), '0.3');
  assert.equal(serializeWaveValue(pattern, 'monotonic'), 'monotonic');
});

test('resolution reports each value with its source and what the slice will use', () => {
  const state = resolveWaveSettings({
    inheritedConfig: {
      wave_overhangs: '1',
      wave_overhang_print_speed: '1.8',
      wave_overhang_pattern: 'kaiser',
      wave_overhang_algorithm: 'andersons',
      layer_height: '0.2',
    },
    overrides: { wave_overhang_fan_speed: '80', wave_overhang_ring_overlap: '0.4' },
  });
  const entry = (key: string) => state.options.find((candidate) => candidate.option.key === key)!;
  assert.equal(state.enabled, true);
  assert.equal(state.options.length, WAVE_OVERHANG_OPTIONS.length);
  assert.deepEqual([entry('wave_overhang_fan_speed').value, entry('wave_overhang_fan_speed').source], [80, 'override']);
  assert.deepEqual(
    [entry('wave_overhang_print_speed').value, entry('wave_overhang_print_speed').source],
    [1.8, 'inherited'],
  );
  assert.deepEqual(
    [entry('wave_overhang_travel_speed').value, entry('wave_overhang_travel_speed').source],
    [40, 'default'],
  );
  const pattern = entry('wave_overhang_pattern');
  assert.equal(pattern.value, 'smart', 'a refused stored value falls back to the engine default');
  assert.equal(pattern.rejected, 'kaiser');
  assert.deepEqual(state.unknownKeys, ['wave_overhang_algorithm', 'wave_overhang_ring_overlap']);
  assert.equal(state.hasOverrides, true);
});

test('options apply only while the master switch and their parent options are on', () => {
  const off = resolveWaveSettings({ inheritedConfig: {}, overrides: {} });
  assert.equal(off.enabled, false);
  assert.ok(off.options.every((entry) => entry.applies === (entry.option.key === WAVE_MASTER_KEY)));
  assert.equal(off.hasOverrides, false);

  const on = resolveWaveSettings({ inheritedConfig: {}, overrides: { wave_overhangs: '1' } });
  const applies = (key: string) => on.options.find((entry) => entry.option.key === key)!.applies;
  assert.equal(applies('wave_overhang_print_speed'), true);
  assert.equal(applies('wave_overhang_line_spacing_corner'), false, 'corner rows wait for the taper switch');
  assert.equal(applies('wave_overhang_floor_hilbert_density'), false, 'Hilbert rows wait for the Hilbert switch');
  assert.equal(applies('wave_overhang_floor_perimeter_speed'), true, 'floor wall speed applies without Hilbert');

  const hilbert = resolveWaveSettings({
    inheritedConfig: {},
    overrides: { wave_overhangs: '1', wave_overhang_floor_use_hilbert: true },
  });
  assert.equal(
    hilbert.options.find((entry) => entry.option.key === 'wave_overhang_floor_hilbert_density')!.applies,
    true,
  );
});

test('edits are validated against the engine bounds and refused, never clamped', () => {
  const next = withWaveValue({ layer_height: '0.2' }, 'wave_overhang_print_speed', 1.5);
  assert.deepEqual(next, { layer_height: '0.2', wave_overhang_print_speed: '1.5' });
  assert.throws(() => withWaveValue({}, 'wave_overhang_fan_speed', 120), WaveValueError);
  assert.throws(() => withWaveValue({}, 'wave_overhang_floor_layers', 1.5), WaveValueError);
  assert.throws(() => withWaveValue({}, 'wave_overhang_pattern', 'kaiser'), WaveValueError);
  assert.throws(() => withWaveValue({}, 'wave_overhang_algorithm', 'andersons'), WaveValueError);
  assert.match(waveValueProblem(option('wave_overhang_fan_speed'), 120) ?? '', /100/);
});

test('stepping stays inside the bounds, cycles choices, and toggles switches', () => {
  const state = resolveWaveSettings({
    inheritedConfig: {},
    overrides: { wave_overhangs: '1', wave_overhang_fan_speed: '100', wave_overhang_pattern: 'smart' },
  });
  const entry = (key: string) => state.options.find((candidate) => candidate.option.key === key)!;
  assert.equal(steppedWaveValue(entry('wave_overhang_fan_speed'), 1), 100);
  assert.equal(steppedWaveValue(entry('wave_overhang_fan_speed'), -1), 95);
  assert.equal(steppedWaveValue(entry('wave_overhang_aux_fan_speed'), -1), -1);
  assert.equal(steppedWaveValue(entry('wave_overhang_print_speed'), -1), 1.5);
  assert.equal(steppedWaveValue(entry('wave_overhang_pattern'), 1), 'monotonic');
  assert.equal(steppedWaveValue(entry('wave_overhang_pattern'), -1), 'zigzag');
  assert.equal(steppedWaveValue(entry('wave_overhang_debug_gcode'), 1), false);
});

test('reset drops every wave key the project sets and keeps everything else', () => {
  const overrides = {
    layer_height: '0.2',
    wave_overhangs: '1',
    wave_overhang_algorithm: 'kaiser',
    support_remaining_areas_after_wave_overhangs: '0',
  };
  assert.deepEqual(withoutWaveOverrides(overrides), { layer_height: '0.2' });
  assert.deepEqual(withoutUnknownWaveKeys(overrides), {
    layer_height: '0.2',
    wave_overhangs: '1',
    support_remaining_areas_after_wave_overhangs: '0',
  });
});

test('nozzle-matched flow follows the engine tooltip formula', () => {
  assert.equal(waveFlowForNozzle(0.4), 0.15);
  assert.equal(waveFlowForNozzle(0.6), 0.34);
  assert.equal(waveFlowForNozzle(0.8), 0.6);
  assert.equal(waveFlowForNozzle(0.2), 0.04);
  assert.equal(waveFlowForNozzle(4), 1.5, 'clamped to the engine maximum');
  assert.equal(waveNozzleDiameter({ nozzle_diameter: ['0.6', '0.4'] }), 0.6);
  assert.equal(waveNozzleDiameter({ nozzle_diameter: '0.8,0.8' }), 0.8);
  assert.equal(waveNozzleDiameter({}), undefined);
});

test('material and generation warnings name what stops waves from working', () => {
  assert.deepEqual(waveMaterialAssessment({ filament_type: ['PLA', 'PLA-CF', 'PLA+'] }), { poor: [], untested: [] });
  assert.deepEqual(waveMaterialAssessment({ filament_type: 'PLA;PETG;PETG;ABS-GF;PC' }), {
    poor: ['PETG', 'ABS-GF', 'PC'],
    untested: [],
  });
  // Upstream reports on PETG, ABS and PC only; anything else is untested, not failing.
  assert.deepEqual(waveMaterialAssessment({ filament_type: ['PCTG', 'TPU', 'ASA'] }), {
    poor: [],
    untested: ['PCTG', 'TPU', 'ASA'],
  });
  assert.deepEqual(waveGenerationBlockers({}), []);
  assert.deepEqual(waveGenerationBlockers({ detect_overhang_wall: '0', wall_loops: '0', spiral_mode: '1' }), [
    'detect-overhang-wall-off',
    'no-walls',
    'spiral-vase',
  ]);
  assert.deepEqual(waveGenerationBlockers({ detect_overhang_wall: true, wall_loops: 2, spiral_mode: false }), []);
});

test('every option and choice has its own text', () => {
  for (const entry of WAVE_OVERHANG_OPTIONS) {
    const text = waveOptionText(entry.key);
    assert.notEqual(text.label, entry.key, `${entry.key} has a label`);
    assert.ok(text.tooltip.length > 20, `${entry.key} has a tooltip`);
    if (entry.passthrough !== undefined) assert.ok(text.passthroughHint, `${entry.key} explains its pass-through`);
    for (const choice of entry.choices ?? []) {
      assert.notEqual(waveChoiceLabel(entry.key, choice), choice, `${entry.key}=${choice} has a label`);
    }
  }
  for (const key of ['wave_overhang_min_angle', 'wave_overhang_seam_mode', 'wave_overhang_spacing_mode']) {
    assert.equal(option(key).inert, true, `${key} is marked as having no effect`);
    assert.match(waveOptionText(key).tooltip, /^Not used by the engine/);
  }
});

test('a project uses waves when any printing region resolves them on, chain by chain', () => {
  type Volume = WaveProjectShape['plates'][number]['objects'][number]['volumes'][number];
  const project = (
    config: Record<string, unknown>,
    object: Record<string, unknown> = {},
    volumes: Volume[] = [{ role: 'model', config: {} }],
    ranges: Record<string, unknown>[] = [],
    plate: Record<string, unknown> = {},
  ): WaveProjectShape => ({
    config,
    plates: [
      {
        config: plate,
        objects: [{ config: object, volumes, layerRanges: ranges.map((entry) => ({ config: entry })) }],
      },
    ],
  });
  assert.equal(projectUsesWaveOverhangs(project({})), false, 'off by default');
  assert.equal(projectUsesWaveOverhangs(project({ wave_overhangs: '1' })), true);
  assert.equal(projectUsesWaveOverhangs({ config: { wave_overhangs: '1' }, plates: [] }), false, 'nothing to print');
  assert.equal(projectUsesWaveOverhangs(project({ wave_overhangs: '1' }, { wave_overhangs: '0' })), false);
  assert.equal(projectUsesWaveOverhangs(project({}, {}, [], [], { wave_overhangs: true })), true, 'plate scope');
  assert.equal(projectUsesWaveOverhangs(project({}, { wave_overhangs: true })), true, 'an imported object');
  assert.equal(
    projectUsesWaveOverhangs(project({}, {}, [{ role: 'parameter-modifier', config: { wave_overhangs: '1' } }])),
    true,
    'a modifier turns waves on for its region',
  );
  assert.equal(
    projectUsesWaveOverhangs(
      project({ wave_overhangs: '1' }, {}, [
        { role: 'model', config: { wave_overhangs: '0' } },
        { role: 'negative-volume', config: {} },
      ]),
    ),
    false,
    'a part that turns waves off leaves only a negative volume, which prints nothing',
  );
  assert.equal(projectUsesWaveOverhangs(project({}, {}, undefined, [{ wave_overhangs: '1' }])), true, 'a range');
  assert.equal(
    projectUsesWaveOverhangs(project({ wave_overhangs: '1' }, { wave_overhangs: 'yes' })),
    true,
    'a value the engine refuses leaves the inherited one in force',
  );
});

console.log(`${passed} wave-overhang settings checks passed`);
