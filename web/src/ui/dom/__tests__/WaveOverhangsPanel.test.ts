import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { WAVE_OVERHANG_OPTIONS } from '../../../settings/waveOverhangs';
import {
  WaveOverhangsPanel,
  mountWaveOverhangsPanel,
  type WaveOverhangsPanelAdapter,
  type WaveOverhangsPanelState,
} from '../WaveOverhangsPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function stateOf(
  overrides: Record<string, unknown>,
  inheritedConfig: Record<string, unknown> = {},
  extra: Partial<WaveOverhangsPanelState> = {},
): WaveOverhangsPanelState {
  return {
    inheritedConfig,
    overrides,
    effectiveConfig: { ...inheritedConfig, ...overrides },
    guard: { sourceRevision: 7, sourceHash: 'hash-7' },
    ...extra,
  };
}

interface Applied {
  readonly next: Record<string, unknown>;
  readonly basis: WaveOverhangsPanelState;
}

function mount(initial: WaveOverhangsPanelState, adapterExtras: Partial<WaveOverhangsPanelAdapter> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  let state = initial;
  const applied: Applied[] = [];
  const errors: unknown[] = [];
  const panel = new WaveOverhangsPanel(host, {
    getState: () => state,
    apply: (next, basis) => {
      applied.push({ next, basis });
    },
    onError: (error) => errors.push(error),
    ...adapterExtras,
  });
  panel.mount();
  const change = (element: HTMLInputElement | HTMLSelectElement) =>
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return {
    host,
    applied,
    errors,
    window: dom.window,
    change,
    row: (key: string) => host.querySelector<HTMLElement>(`[data-wave-key="${key}"]`),
    numberInput: (key: string) =>
      host.querySelector<HTMLInputElement>(`[data-wave-key="${key}"] input[type="number"]`)!,
    setState: (next: WaveOverhangsPanelState) => {
      state = next;
      panel.refresh();
    },
    dispose: () => panel.dispose(),
  };
}

await test('off: only the master switch and the about section, no reset without overrides', () => {
  const view = mount(stateOf({}));
  const master = view.host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
  assert.equal(master.checked, false);
  assert.equal(view.host.querySelectorAll('[data-wave-group]').length, 0, 'tunables stay hidden like upstream');
  assert.equal(view.host.querySelector('[data-wave-action="reset"]'), null);
  assert.ok(view.host.querySelector('[data-wave-about]'));
  assert.match(view.host.textContent ?? '', /Experimental/);
  view.dispose();
});

await test('turning waves on commits one override map against the state it was read from', () => {
  const initial = stateOf({ layer_height: '0.2' });
  const view = mount(initial);
  const master = view.host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
  master.checked = true;
  view.change(master);
  assert.equal(view.applied.length, 1);
  assert.deepEqual(view.applied[0]!.next, { layer_height: '0.2', wave_overhangs: '1' });
  assert.equal(view.applied[0]!.basis, initial, 'the guard travels with the basis');
  view.dispose();
});

await test('on: every applicable option is shown once, in upstream page order, with engine defaults', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  const groups = [...view.host.querySelectorAll<HTMLElement>('[data-wave-group]')].map(
    (node) => node.dataset.waveGroup,
  );
  assert.deepEqual(groups, ['general', 'detection', 'pattern', 'corner', 'motion', 'cooling', 'floor', 'debug']);
  const keys = [...view.host.querySelectorAll<HTMLElement>('[data-wave-key]')].map((node) => node.dataset.waveKey);
  const expected = WAVE_OVERHANG_OPTIONS.filter(
    (entry) => entry.key !== 'wave_overhangs' && (entry.requires ?? []).length === 0,
  ).map((entry) => entry.key);
  assert.deepEqual(keys, expected);
  assert.equal(view.numberInput('wave_overhang_print_speed').value, '2', 'the engine default, not 35');
  assert.equal(view.numberInput('wave_overhang_travel_speed').value, '40', 'the engine default, not 80');
  assert.equal(view.numberInput('wave_overhang_floor_layers').value, '2', 'the engine default, not 3');
  assert.equal(view.row('wave_overhang_print_speed')!.dataset.waveSource, 'default');
  assert.equal(view.row('wave_overhang_algorithm'), null, 'the removed generator selector is gone');
  assert.equal(view.row('wave_overhang_ring_overlap'), null, 'the removed generator option is gone');
  view.dispose();
});

await test('each row says where its value comes from, and an override can be cleared on its own', () => {
  const view = mount(
    stateOf({ wave_overhangs: '1', wave_overhang_fan_speed: '80' }, { wave_overhang_print_speed: '1.8' }),
  );
  assert.equal(view.row('wave_overhang_fan_speed')!.dataset.waveSource, 'override');
  assert.equal(view.row('wave_overhang_print_speed')!.dataset.waveSource, 'inherited');
  assert.equal(view.numberInput('wave_overhang_print_speed').value, '1.8');
  assert.equal(view.row('wave_overhang_print_speed')!.querySelector('[data-wave-clear]'), null);
  view.row('wave_overhang_fan_speed')!.querySelector<HTMLButtonElement>('[data-wave-clear]')!.click();
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1' });
  view.dispose();
});

await test('parent switches reveal their rows, matching upstream gating', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  assert.equal(view.row('wave_overhang_line_spacing_corner'), null);
  assert.equal(view.row('wave_overhang_floor_hilbert_density'), null);
  view.setState(
    stateOf({ wave_overhangs: '1', wave_overhang_corner_taper_enable: '1', wave_overhang_floor_use_hilbert: '1' }),
  );
  assert.ok(view.row('wave_overhang_line_spacing_corner'));
  assert.ok(view.row('wave_overhang_floor_hilbert_density'));
  assert.match(
    view.row('wave_overhang_corner_taper_enable')!.textContent ?? '',
    /stays off until Corner line spacing and Corner taper distance/,
  );
  view.dispose();
});

await test('a valid number commits its engine wire form; an out-of-range one is refused and kept for correction', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  const speed = view.numberInput('wave_overhang_print_speed');
  speed.value = '1.5';
  view.change(speed);
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1', wave_overhang_print_speed: '1.5' });

  const fan = view.numberInput('wave_overhang_fan_speed');
  fan.value = '140';
  view.change(fan);
  assert.equal(view.applied.length, 1, 'nothing out of range reaches the project');
  const refused = view.numberInput('wave_overhang_fan_speed');
  assert.equal(refused.value, '140', 'the typed text survives the re-render');
  assert.equal(refused.getAttribute('aria-invalid'), 'true');
  assert.match(view.row('wave_overhang_fan_speed')!.textContent ?? '', /largest value the engine accepts is 100/);

  refused.value = '90';
  view.change(refused);
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1', wave_overhang_fan_speed: '90' });
  view.setState(stateOf({ wave_overhangs: '1', wave_overhang_fan_speed: '90' }));
  assert.equal(view.numberInput('wave_overhang_fan_speed').getAttribute('aria-invalid'), null);
  view.dispose();
});

await test('choices and switches commit engine values', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  const pattern = view.row('wave_overhang_pattern')!.querySelector<HTMLSelectElement>('select')!;
  assert.equal(pattern.value, 'smart');
  pattern.value = 'zigzag';
  view.change(pattern);
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1', wave_overhang_pattern: 'zigzag' });
  const debug = view.row('wave_overhang_debug_gcode')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.equal(debug.checked, true);
  debug.checked = false;
  view.change(debug);
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1', wave_overhang_debug_gcode: '0' });
  view.dispose();
});

await test('options the engine ignores are shown as such and cannot be edited', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  for (const key of ['wave_overhang_min_angle', 'wave_overhang_seam_mode', 'wave_overhang_spacing_mode']) {
    const row = view.row(key)!;
    assert.equal(row.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')!.disabled, true, key);
    assert.match(row.textContent ?? '', /Has no effect in this engine/);
  }
  view.dispose();
});

await test('reset removes every wave key, including retired ones, and keeps other overrides', () => {
  const view = mount(
    stateOf({
      layer_height: '0.2',
      wave_overhangs: '1',
      wave_overhang_algorithm: 'kaiser',
      wave_overhang_fan_speed: '80',
    }),
  );
  view.host.querySelector<HTMLButtonElement>('[data-wave-action="reset"]')!.click();
  assert.deepEqual(view.applied.at(-1)!.next, { layer_height: '0.2' });
  view.dispose();
});

await test('settings from another wave version are named, and only project ones offered for removal', () => {
  const view = mount(
    stateOf({ wave_overhangs: '1', wave_overhang_algorithm: 'kaiser' }, { wave_overhang_ring_overlap: '0.4' }),
  );
  const notice = view.host.querySelector<HTMLElement>('[data-wave-notice="unknown-keys"]')!;
  assert.match(notice.textContent ?? '', /2 settings from another wave-overhang version/);
  assert.match(notice.textContent ?? '', /wave_overhang_algorithm, wave_overhang_ring_overlap/);
  notice.querySelector<HTMLButtonElement>('[data-wave-action="remove-unknown"]')!.click();
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1' });
  view.dispose();
});

await test('settings outside the card that stop waves are named, with the fix where there is one', () => {
  const view = mount(
    stateOf({ wave_overhangs: '1' }, { detect_overhang_wall: '0', wall_loops: '0', spiral_mode: '1' }),
  );
  const kinds = [...view.host.querySelectorAll<HTMLElement>('[data-wave-notice]')].map(
    (node) => node.dataset.waveNotice,
  );
  assert.deepEqual(kinds, ['detect-overhang-wall', 'no-walls', 'spiral-vase']);
  view.host.querySelector<HTMLButtonElement>('[data-wave-action="enable-overhang-detection"]')!.click();
  assert.deepEqual(view.applied.at(-1)!.next, { wave_overhangs: '1', detect_overhang_wall: '1' });
  view.dispose();
});

await test('a filament upstream reports failing is called out before the print; an untested one is named as such', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }, { filament_type: ['PETG', 'TPU'] }));
  assert.match(
    view.host.querySelector('[data-wave-notice="material"]')?.textContent ?? '',
    /Upstream testing found PETG much more likely to delaminate or warp/,
  );
  assert.match(
    view.host.querySelector('[data-wave-notice="material-untested"]')?.textContent ?? '',
    /proven with PLA; TPU has no reported results yet/,
  );
  view.setState(stateOf({ wave_overhangs: '1' }, { filament_type: ['PLA'] }));
  assert.equal(view.host.querySelector('[data-wave-notice^="material"]'), null);
  view.dispose();
});

await test('a stored value the engine refuses is reported, and the engine default shown', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }, { wave_overhang_pattern: 'kaiser' }));
  const row = view.row('wave_overhang_pattern')!;
  assert.equal(row.querySelector<HTMLSelectElement>('select')!.value, 'smart');
  assert.match(row.textContent ?? '', /stored value “kaiser” is not one the engine accepts/);
  view.dispose();
});

await test('guidance appears where it applies: speed range, nozzle-matched flow, pass-through meaning', () => {
  const view = mount(
    stateOf({ wave_overhangs: '1', wave_overhang_print_speed: '8' }, { nozzle_diameter: ['0.6'], auxiliary_fan: '0' }),
  );
  assert.match(view.row('wave_overhang_print_speed')!.textContent ?? '', /1\.5–2\.5 mm\/s is the useful range/);
  const flow = view.row('wave_overhang_flow_mm3_per_mm')!;
  assert.match(flow.textContent ?? '', /For this 0\.6 mm nozzle, start at 0\.34/);
  flow.querySelector<HTMLButtonElement>('[data-wave-action="use-nozzle-flow"]')!.click();
  assert.equal(view.applied.at(-1)!.next.wave_overhang_flow_mm3_per_mm, '0.34');
  assert.match(view.row('wave_overhang_nozzle_temp')!.textContent ?? '', /0 = filament temperature/);
  assert.match(view.row('wave_overhang_aux_fan_speed')!.textContent ?? '', /−1 = normal aux fan/);

  view.setState(stateOf({ wave_overhangs: '1', wave_overhang_aux_fan_speed: '60' }, { auxiliary_fan: '0' }));
  assert.match(view.row('wave_overhang_aux_fan_speed')!.textContent ?? '', /no auxiliary fan enabled/);
  assert.doesNotMatch(view.row('wave_overhang_flow_mm3_per_mm')!.textContent ?? '', /start at/, 'no nozzle, no guess');
  view.dispose();
});

await test('controls are disabled while the project is busy', () => {
  const view = mount(stateOf({ wave_overhangs: '1', wave_overhang_fan_speed: '80' }, {}, { busy: true }));
  const controls = [
    ...view.host.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, select, button'),
  ].filter((control) => !control.closest('[data-wave-about]'));
  assert.ok(controls.length > 10);
  assert.ok(controls.every((control) => control.disabled));
  view.dispose();
});

await test('a group the operator closes stays closed across refreshes', () => {
  const view = mount(stateOf({ wave_overhangs: '1' }));
  const motion = view.host.querySelector<HTMLDetailsElement>('[data-wave-group="motion"]')!;
  assert.equal(motion.open, true);
  assert.equal(view.host.querySelector<HTMLDetailsElement>('[data-wave-group="debug"]')!.open, false);
  motion.open = false;
  motion.dispatchEvent(new view.window.Event('toggle'));
  view.setState(stateOf({ wave_overhangs: '1', wave_overhang_fan_speed: '90' }));
  assert.equal(view.host.querySelector<HTMLDetailsElement>('[data-wave-group="motion"]')!.open, false);
  view.dispose();
});

await test('a rejected commit reaches the error handler instead of vanishing', async () => {
  const errors: unknown[] = [];
  const view = mount(stateOf({}), {
    apply: () => Promise.reject(new Error('stale project revision')),
    onError: (error) => errors.push(error),
  });
  const master = view.host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
  master.checked = true;
  view.change(master);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((errors[0] as Error).message, 'stale project revision');
  view.dispose();
});

await test('the mounted panel applies through the canonical project-settings action with the read guard', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = dom.window;
  try {
    const host = dom.window.document.querySelector('#host') as HTMLElement;
    const invocations: unknown[] = [];
    const messages: string[] = [];
    let accept = true;
    const dispose = mountWaveOverhangsPanel({
      container: host,
      workspace: {
        getProjectSettingsOverrideSnapshot: () => ({
          effectiveConfig: { layer_height: '0.2' },
          overrides: {},
          inheritedConfig: { layer_height: '0.2' },
          sourceRevision: 3,
          sourceHash: 'abc',
        }),
        subscribeCanonicalState: () => () => {},
      },
      registry: {
        invoke: async (id, surface, _ctx, _state, payload) => {
          invocations.push({ id, surface, payload });
          return accept;
        },
      },
      actionCtx: {},
      getUiState: () => ({}),
      onErrorMessage: (message) => messages.push(message),
    });
    const master = host.querySelector<HTMLInputElement>('[data-wave-enable]')!;
    master.checked = true;
    master.dispatchEvent(new dom.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(invocations, [
      {
        id: 'settings_apply_project',
        surface: 'dom-inspector',
        payload: {
          projectSettingsApply: {
            inheritedConfig: { layer_height: '0.2' },
            overrides: { wave_overhangs: '1' },
            sourceRevision: 3,
            sourceHash: 'abc',
          },
        },
      },
    ]);
    assert.deepEqual(messages, []);

    accept = false;
    master.dispatchEvent(new dom.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /^Wave overhangs: Project settings cannot be changed/);
    dispose();
    assert.equal(host.querySelector('[data-wave-overhangs-panel]'), null);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

console.log(`${passed} wave-overhang panel checks passed`);
