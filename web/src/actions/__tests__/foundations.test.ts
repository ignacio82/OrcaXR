/**
 * Node tests for the Phase-0 UI foundations (run: npx tsx foundations.test.ts).
 * Covers the design-token flattening and the reactive UiState store — the two
 * new pure modules both shells will build on.
 */
import assert from 'node:assert';
import { tokens, tokenCssVars } from '../../ui/tokens';
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
  assert.strictEqual(vars['--oxr-color-bg'], tokens.color.bg);
  assert.strictEqual(vars['--oxr-color-accent'], tokens.color.accent);
  assert.strictEqual(vars['--oxr-radius-md'], '10px');
  assert.strictEqual(vars['--oxr-space-lg'], '20px');
  assert.strictEqual(vars['--oxr-icon-lg'], '48px');
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
