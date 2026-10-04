/**
 * The headset's Wave overhangs panel: the same options, guidance and commits as
 * the flat card, pressed rather than clicked.
 */
import assert from 'node:assert/strict';
import { buildRegistry } from '../../../actions/catalog';
import { WAVE_OVERHANG_OPTIONS, waveOption, type WaveOverhangsProjectSnapshot } from '../../../settings/waveOverhangs';
import { hasIcon } from '../../icons';
import { entryForWaveOption } from '../XrImmersiveShell';
import { xrInspectorPanels } from '../XrPanels';
import { XrShellState } from '../XrShellState';
import { renderXrWaveOverhangsPanel } from '../XrWaveOverhangsPanel';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();

function snapshotOf(
  overrides: Record<string, unknown>,
  inheritedConfig: Record<string, unknown> = {},
  extra: Partial<WaveOverhangsProjectSnapshot> = {},
): WaveOverhangsProjectSnapshot {
  return {
    inheritedConfig,
    overrides,
    effectiveConfig: { ...inheritedConfig, ...overrides },
    guard: { sourceRevision: 4, sourceHash: 'h4' },
    ...extra,
  };
}

function draw(snapshot: WaveOverhangsProjectSnapshot | null) {
  const root = new FakePanel({});
  const applied: Record<string, unknown>[] = [];
  const edits: { key: string; current: number }[] = [];
  const render = renderXrWaveOverhangsPanel(ui, root, {
    snapshot,
    onApply: (next) => applied.push(next),
    onEditValue: (option, current) => edits.push({ key: option.key, current }),
  });
  /** The row whose label reads `label`. */
  const row = (label: string) => {
    const found = root.panels().find((panel) => panel.props.minHeight === 40 && panel.labels()[0] === label);
    assert.ok(found, `a row reads ${label}`);
    return found;
  };
  return { root, render, applied, edits, row };
}

test('the inspector offers Wave overhangs beside Settings, with its own icon', () => {
  const panels = xrInspectorPanels(buildRegistry());
  const ids = panels.map((panel) => panel.id);
  assert.deepEqual(ids.slice(0, 3), ['objects', 'settings', 'wave-overhangs']);
  const wave = panels.find((panel) => panel.id === 'wave-overhangs')!;
  assert.equal(wave.label, 'Wave overhangs');
  assert.equal(hasIcon(wave.icon), true, 'a drawn glyph, not the neutral fallback');
});

test('with no project the panel says so', () => {
  const view = draw(null);
  assert.deepEqual(view.render.keys, []);
  assert.ok(view.root.labels().includes('No project open.'));
});

test('off: the master switch alone, and pressing it turns waves on', () => {
  const view = draw(snapshotOf({ layer_height: '0.2' }));
  assert.deepEqual(view.render.keys, ['wave_overhangs']);
  assert.ok(view.root.labels().includes('EXPERIMENTAL'));
  assert.equal(view.root.findButton('Reset'), undefined, 'nothing to reset');
  view.row('Use wave overhangs (Experimental)').buttons().at(-1)!.click();
  assert.deepEqual(view.applied, [{ layer_height: '0.2', wave_overhangs: '1' }]);
});

test('on: the same options as the flat card, in upstream order, with engine defaults', () => {
  const view = draw(snapshotOf({ wave_overhangs: '1' }));
  const expected = WAVE_OVERHANG_OPTIONS.filter((entry) => (entry.requires ?? []).length === 0).map(
    (entry) => entry.key,
  );
  assert.deepEqual(view.render.keys, expected);
  for (const heading of ['GENERAL', 'DETECTION', 'PATTERN', 'CORNER REINFORCEMENT', 'MOTION', 'COOLING']) {
    assert.ok(view.root.labels().includes(heading), heading);
  }
  const speed = view.row('Print speed');
  assert.ok(speed.labels().includes('2 mm/s'), 'the engine default, not an invented one');
  assert.ok(speed.labels().includes('engine default'));
});

test('arrows step inside the engine bounds and commit the engine wire form', () => {
  const view = draw(snapshotOf({ wave_overhangs: '1' }));
  const speed = view.row('Print speed').buttons();
  speed.at(-1)!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1', wave_overhang_print_speed: '2.5' });
  speed[0]!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1', wave_overhang_print_speed: '1.5' });

  const aux = view.row('Aux fan speed').buttons();
  const before = view.applied.length;
  aux[0]!.click();
  assert.equal(view.applied.length, before, '−1 is the floor; the minus arrow is disabled there');
  assert.ok(view.row('Aux fan speed').labels().includes('−1 = normal aux fan'));
});

test('the readout opens the keypad with the option’s bounds', () => {
  const view = draw(snapshotOf({ wave_overhangs: '1', wave_overhang_fan_speed: '80' }));
  view.row('Fan speed').findButton('80 %')!.click();
  assert.deepEqual(view.edits, [{ key: 'wave_overhang_fan_speed', current: 80 }]);
  const entry = entryForWaveOption(waveOption('wave_overhang_fan_speed')!, 80);
  assert.deepEqual(entry, {
    target: { kind: 'wave-setting', key: 'wave_overhang_fan_speed' },
    layout: 'keypad',
    title: 'Fan speed',
    initial: '80',
    unit: '%',
    minimum: 0,
    maximum: 100,
    integer: true,
  });
  assert.equal(entryForWaveOption(waveOption('wave_overhang_line_spacing')!, 0.35).integer, false);
});

test('a keypad commit for a wave option closes the keypad and reports where it goes', () => {
  const state = new XrShellState(() => {});
  state.beginEntry(entryForWaveOption(waveOption('wave_overhang_fan_speed')!, 80));
  assert.equal(state.overlay.kind, 'entry');
  assert.deepEqual(state.commitEntry('60'), { kind: 'wave-setting', key: 'wave_overhang_fan_speed' });
  assert.equal(state.overlay.kind, 'none');
});

test('choices cycle and switches toggle, and options the engine ignores cannot be pressed', () => {
  const view = draw(snapshotOf({ wave_overhangs: '1' }));
  view.row('Pattern').findButton('Smart ⌄')!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1', wave_overhang_pattern: 'monotonic' });
  view.row('Debug g-code').buttons().at(-1)!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1', wave_overhang_debug_gcode: '0' });

  const count = view.applied.length;
  view.row('Seam mode').findButton('Alternating ⌄')!.click();
  for (const button of view.row('Min angle').buttons()) button.click();
  assert.equal(view.applied.length, count, 'inert options do not commit');
  assert.ok(
    view.row('Seam mode').labels().includes('Has no effect in this engine; kept so profiles that set it still load.'),
  );
});

test('overrides can be cleared one at a time or all at once', () => {
  const view = draw(
    snapshotOf({ wave_overhangs: '1', wave_overhang_fan_speed: '80', wave_overhang_algorithm: 'kaiser' }),
  );
  const fan = view.row('Fan speed');
  assert.ok(fan.labels().includes('set here'));
  fan.buttons().at(-1)!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1', wave_overhang_algorithm: 'kaiser' });
  view.root.findButton('Reset')!.click();
  assert.deepEqual(view.applied.at(-1), {}, 'reset drops every wave key, retired ones included');
});

test('the flat card’s notices and suggestions appear here too, with their fixes', () => {
  const view = draw(
    snapshotOf(
      { wave_overhangs: '1', wave_overhang_algorithm: 'kaiser' },
      { detect_overhang_wall: '0', filament_type: ['PETG'], nozzle_diameter: ['0.6'] },
    ),
  );
  const labels = view.root.labels();
  assert.ok(labels.some((text) => text.startsWith('Detect overhang walls is off')));
  assert.ok(labels.some((text) => /found PETG much more likely to delaminate or warp/.test(text)));
  assert.ok(labels.some((text) => /1 setting from another wave-overhang version/.test(text)));
  view.root.findButton('Turn it on')!.click();
  assert.deepEqual(view.applied.at(-1), {
    wave_overhangs: '1',
    wave_overhang_algorithm: 'kaiser',
    detect_overhang_wall: '1',
  });
  view.root.findButton('Remove them')!.click();
  assert.deepEqual(view.applied.at(-1), { wave_overhangs: '1' });
  view.row('Wave flow').findButton('Use 0.34')!.click();
  assert.equal(view.applied.at(-1)!.wave_overhang_flow_mm3_per_mm, '0.34');
});

test('nothing commits while the project is busy', () => {
  const view = draw(snapshotOf({ wave_overhangs: '1', wave_overhang_fan_speed: '80' }, {}, { busy: true }));
  for (const button of view.root.buttons()) button.click();
  assert.deepEqual(view.applied, []);
  assert.deepEqual(view.edits, []);
});

console.log(`${passed} XR wave-overhang panel checks passed`);
