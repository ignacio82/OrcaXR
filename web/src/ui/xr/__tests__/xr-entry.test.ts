/**
 * Entering a value in a headset.
 *
 * This is the constraint the rest of the immersive shell was shaped by, so it
 * is worth asserting precisely: what a keypad produces, what it refuses, and
 * that a refusal is visible before the press rather than reported afterwards by
 * something else.
 */
import assert from 'node:assert/strict';
import { renderXrKeyboard, renderXrKeypad, xrValueAccepted } from '../XrKeypad';
import { XrShellState } from '../XrShellState';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();
const host = () => new FakePanel({});

const layerHeight = { title: 'Layer height', initial: '0.20', unit: 'mm', minimum: 0.05, maximum: 0.3 };

test('a keypad types the value a stepper cannot reach', () => {
  const committed: string[] = [];
  const pad = renderXrKeypad(
    ui,
    host(),
    { ...layerHeight, initial: '' },
    {
      onCommit: (value) => committed.push(value),
      onCancel: () => {},
    },
  );
  for (const key of ['0', '.', '1', '7']) pad.press(key);
  assert.equal(pad.value(), '0.17');
  // 0.17 mm is exactly the value the redesign names as unreachable by tapping
  // plus, and it is why the settings surface could only offer six rows.
  assert.ok(xrValueAccepted(pad.value(), layerHeight));
});

test('a value outside the field’s declared range cannot be applied', () => {
  assert.ok(xrValueAccepted('0.20', layerHeight));
  assert.ok(!xrValueAccepted('0.40', layerHeight), 'above the maximum');
  assert.ok(!xrValueAccepted('0.01', layerHeight), 'below the minimum');
  assert.ok(!xrValueAccepted('', layerHeight), 'nothing typed');
  assert.ok(!xrValueAccepted('-', layerHeight), 'a lone sign is not a number');
  assert.ok(!xrValueAccepted('abc', layerHeight));
  assert.ok(!xrValueAccepted('2.5', { title: 'Wall loops', initial: '2', minimum: 1, maximum: 10, integer: true }));
});

test('Apply is dim while the draft is out of range, not rejected afterwards', () => {
  const root = host();
  const pad = renderXrKeypad(ui, root, { ...layerHeight, initial: '' }, { onCommit: () => {}, onCancel: () => {} });
  const apply = root.buttons().find((button) => button.labels().includes('Apply'));
  assert.ok(apply);
  assert.ok((apply as FakePanel).opacity < 1, 'an empty draft cannot apply');
  for (const key of ['0', '.', '2']) pad.press(key);
  assert.equal((apply as FakePanel).opacity, 1);
});

test('a disabled Apply does not commit when it is pressed anyway', () => {
  const committed: string[] = [];
  const root = host();
  renderXrKeypad(
    ui,
    root,
    { ...layerHeight, initial: '' },
    {
      onCommit: (value) => committed.push(value),
      onCancel: () => {},
    },
  );
  root
    .buttons()
    .find((button) => button.labels().includes('Apply'))
    ?.click();
  assert.deepEqual(committed, []);
});

test('backspace and sign behave the way a calculator does', () => {
  const pad = renderXrKeypad(
    ui,
    host(),
    { title: 'Offset', initial: '' },
    {
      onCommit: () => {},
      onCancel: () => {},
    },
  );
  for (const key of ['1', '2', '⌫']) pad.press(key);
  assert.equal(pad.value(), '1');
  pad.press('−');
  assert.equal(pad.value(), '-1');
  pad.press('−');
  assert.equal(pad.value(), '1', 'the sign toggles rather than accumulating');
  pad.press('.');
  pad.press('.');
  assert.equal(pad.value(), '1.', 'a second decimal point is not a number');
});

test('the keyboard types names, shifts once, and spaces', () => {
  const keyboard = renderXrKeyboard(
    ui,
    host(),
    { title: 'Rename', initial: '' },
    {
      onCommit: () => {},
      onCancel: () => {},
    },
  );
  keyboard.press('⇧');
  for (const key of ['d', 'r', 'a', 'g', 'o', 'n']) keyboard.press(key);
  assert.equal(keyboard.value(), 'Dragon', 'shift applies to one character, as a phone keyboard does');
  keyboard.press('␣');
  keyboard.press('2');
  assert.equal(keyboard.value(), 'Dragon 2');
  keyboard.press('⌫');
  assert.equal(keyboard.value(), 'Dragon ');
});

test('every character key is at least the hand-tracking floor tall', () => {
  const root = host();
  renderXrKeyboard(ui, root, { title: 'Rename', initial: '' }, { onCommit: () => {}, onCancel: () => {} });
  const keys = root.buttons().filter((button) => button.labels().join('').length === 1);
  assert.ok(keys.length > 30, 'a full QWERTY, not a cycling picker');
  for (const key of keys) {
    assert.ok(Number(key.props.height) >= 58, `key "${key.labels().join('')}" is below the 58 mm floor`);
  }
  // The space bar is the one key allowed to be shorter: it is 400 mm wide and
  // unmistakable, which is the property the floor exists to guarantee.
  const space = root.buttons().find((button) => button.labels().includes('Space'));
  assert.ok(space && Number(space.props.height) >= 40);
});

test('a rename cannot be applied as an empty string', () => {
  const root = host();
  renderXrKeyboard(ui, root, { title: 'Rename', initial: 'dragon' }, { onCommit: () => {}, onCancel: () => {} });
  const apply = root.buttons().find((button) => button.labels().includes('Apply'));
  assert.equal((apply as FakePanel).opacity, 1);
  const cleared = host();
  const keyboard = renderXrKeyboard(
    ui,
    cleared,
    { title: 'Rename', initial: 'ab' },
    {
      onCommit: () => {},
      onCancel: () => {},
    },
  );
  keyboard.press('⌫');
  keyboard.press('⌫');
  const clearedApply = cleared.buttons().find((button) => button.labels().includes('Apply'));
  assert.ok((clearedApply as FakePanel).opacity < 1, 'a rename to nothing is a defect, not an edit');
});

test('an entry returns to what asked for it, and a cancel changes nothing', () => {
  const state = new XrShellState();
  const overlay = () => state.overlay as { kind: string };
  state.openPalette();
  state.beginEntry({
    target: { kind: 'palette-query' },
    layout: 'keyboard',
    title: 'Search commands',
    initial: '',
  });
  assert.equal(overlay().kind, 'entry');
  state.commitEntry('supp');
  assert.equal(state.paletteQuery, 'supp');
  assert.equal(overlay().kind, 'palette', 'committing a query returns to the list it narrows');

  state.beginEntry({ target: { kind: 'palette-query' }, layout: 'keyboard', title: 'Search', initial: 'supp' });
  state.cancelEntry();
  assert.equal(state.paletteQuery, 'supp', 'a cancel leaves the query as it was');
  assert.equal(overlay().kind, 'palette');
});

test('a settings entry hands the field back so the value can be applied', () => {
  const state = new XrShellState();
  state.beginEntry({
    target: { kind: 'setting', fieldId: 'quality:layer_height' },
    layout: 'keypad',
    title: 'Layer height',
    initial: '0.20',
  });
  const target = state.commitEntry('0.17');
  assert.deepEqual(target, { kind: 'setting', fieldId: 'quality:layer_height' });
  assert.equal(state.overlay.kind, 'none');
});

console.log(`\nXR value entry: ${passed} tests passed.`);
