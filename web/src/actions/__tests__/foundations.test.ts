/**
 * Node tests for the Phase-0 UI foundations (run: npx tsx foundations.test.ts).
 * Covers the design-token flattening and the reactive UiState store — the two
 * new pure modules both shells will build on.
 */
import assert from 'node:assert';
import { domThemes, tokens, tokenCssVars } from '../../ui/tokens';
import { UiState } from '../UiState';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---- tokens ---------------------------------------------------------------
test('tokenCssVars: colors pass through, px groups get px suffix', () => {
  const vars = tokenCssVars();
  // The DOM shell is themed; the XR shell is not. Colour and radius therefore
  // come from the active theme and the shared ramps come from `tokens`.
  assert.strictEqual(vars['--oxr-color-bg'], domThemes.light.color.bg);
  assert.strictEqual(vars['--oxr-color-accent'], domThemes.light.color.accent);
  assert.strictEqual(vars['--oxr-radius-md'], `${domThemes.light.radius.md}px`);
  assert.strictEqual(vars['--oxr-space-lg'], `${tokens.space.lg}px`);
  assert.strictEqual(vars['--oxr-icon-lg'], `${tokens.icon.lg}px`);
});

test('tokenCssVars: the dark theme changes colour without changing geometry', () => {
  const light = tokenCssVars('light');
  const dark = tokenCssVars('dark');
  assert.notStrictEqual(light['--oxr-color-bg-card'], dark['--oxr-color-bg-card']);
  assert.strictEqual(light['--oxr-radius-md'], dark['--oxr-radius-md']);
  assert.strictEqual(light['--oxr-space-lg'], dark['--oxr-space-lg']);
  // A toolpath role is meaning, not decoration: it must not move with a theme.
  assert.strictEqual(light['--oxr-role-outer-wall'], dark['--oxr-role-outer-wall']);
});

test('tokenCssVars: every variable is defined in both themes', () => {
  const light = Object.keys(tokenCssVars('light')).sort();
  const dark = Object.keys(tokenCssVars('dark')).sort();
  assert.deepStrictEqual(light, dark);
});

test('tokenCssVars: camelCase keys become kebab-case var names', () => {
  const vars = tokenCssVars();
  assert.ok('--oxr-color-bg-card' in vars, 'bgCard → --oxr-color-bg-card');
  assert.ok('--oxr-color-surface-hover' in vars, 'surfaceHover → --oxr-color-surface-hover');
  assert.ok('--oxr-color-on-accent' in vars, 'onAccent → --oxr-color-on-accent');
});

// ---- UiState --------------------------------------------------------------
test('UiState: subscribe fires immediately with the initial snapshot', () => {
  const ui = new UiState();
  let seen = 0;
  ui.subscribe((s) => {
    seen++;
    assert.strictEqual(s.mode, 'prepare');
  });
  assert.strictEqual(seen, 1);
});

test('UiState: update notifies only on real change', () => {
  const ui = new UiState();
  let calls = 0;
  ui.subscribe(() => {
    calls++;
  });
  assert.strictEqual(calls, 1); // initial
  ui.update({ gcodeReady: true }); // change
  assert.strictEqual(calls, 2);
  ui.update({ gcodeReady: true }); // no-op
  assert.strictEqual(calls, 2);
  assert.strictEqual(ui.get().gcodeReady, true);
});

test('UiState: unsubscribe stops notifications', () => {
  const ui = new UiState();
  let calls = 0;
  const off = ui.subscribe(() => {
    calls++;
  });
  off();
  ui.update({ modelCount: 3 });
  assert.strictEqual(calls, 1); // only the immediate fire
  assert.strictEqual(ui.get().modelCount, 3);
});

console.log(`\nFoundations: ${passed} tests passed.`);
