/**
 * The surface grammar every immersive panel is drawn in.
 *
 * These are the two rules the redesign states as principles and that a panel
 * can quietly break: a control is at least a 58 mm target, and a control that
 * cannot run says why *in place* rather than behind a hover nobody in a headset
 * can perform.
 */
import assert from 'node:assert/strict';
import {
  XR_HIT,
  createXrField,
  createXrGrabBar,
  createXrIconButton,
  createXrListRow,
  createXrProgressBar,
  createXrSegmented,
  createXrTextButton,
} from '../XrChrome';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();

test('the hit-target floor is the hand-tracking floor, in millimetres', () => {
  // One layout pixel is one millimetre (XR_PIXEL_SIZE), so these are the
  // redesign's stated 58 mm target and 10 mm spacing without a conversion.
  assert.equal(XR_HIT.target, 58);
  assert.equal(XR_HIT.spacing, 10);
  assert.ok(XR_HIT.row >= 40, 'a dense row is still a comfortable press');
});

test('a button is never drawn below the dense-row floor', () => {
  const button = createXrTextButton(ui, { label: 'Slice' });
  assert.ok(Number(button.root.props.height) >= XR_HIT.row);
  const icon = createXrIconButton(ui, { icon: 'undo' });
  assert.ok(Number(icon.root.props.width) >= XR_HIT.row);
  assert.ok(Number(icon.root.props.height) >= XR_HIT.row);
});

test('a disabled row prints its reason where the row is', () => {
  const row = createXrListRow(ui, {
    label: 'Export G-code…',
    enabled: false,
    reason: 'Slice successfully first.',
  });
  assert.ok(
    row.root.labels().includes('Slice successfully first.'),
    'the reason must be in the row, not in a tooltip a headset cannot open',
  );
});

test('an enabled row shows its hint rather than a reason', () => {
  const row = createXrListRow(ui, { label: 'Arrange', hint: 'Lay every model out on the plate' });
  assert.ok(row.root.labels().includes('Lay every model out on the plate'));
});

test('a press does not run while the control is disabled', () => {
  let runs = 0;
  const row = createXrListRow(ui, { label: 'Delete', enabled: false, onClick: () => (runs += 1) });
  row.root.click();
  assert.equal(runs, 0);
  row.setEnabled(true);
  row.root.click();
  assert.equal(runs, 1);
});

test('hovering a disabled control leaves it looking disabled', () => {
  const button = createXrTextButton(ui, { label: 'Print', enabled: false });
  const before = button.root.fillColor;
  button.root.hoverEnter();
  assert.equal(button.root.fillColor, before);
});

test('the grab bar offers a handle, a pin, and a way to close', () => {
  let pinned = 0;
  let closed = 0;
  const bar = createXrGrabBar(ui, {
    title: 'Panels',
    hint: 'Drag to place',
    onPin: () => (pinned += 1),
    onClose: () => (closed += 1),
  });
  assert.ok(bar.root.labels().includes('Panels'));
  assert.ok(bar.root.labels().includes('Drag to place'));
  const buttons = bar.root.buttons();
  assert.equal(buttons.length, 2, 'a pin and a close');
  buttons[0].click();
  buttons[1].click();
  assert.equal(pinned, 1);
  assert.equal(closed, 1);
});

test('a field shows its placeholder until it has a value, and opens an editor', () => {
  let opened = 0;
  const field = createXrField(ui, { value: '', placeholder: 'Search commands', onClick: () => (opened += 1) });
  assert.equal((field.valueNode as { text: string }).text, 'Search commands');
  field.setValue('supp');
  assert.equal((field.valueNode as { text: string }).text, 'supp');
  field.root.click();
  assert.equal(opened, 1, 'there is no caret in a headset; a field opens the keyboard');
});

test('a segmented control selects exactly one of its choices', () => {
  const chosen: string[] = [];
  const segmented = createXrSegmented(
    ui,
    [
      { id: 'global', label: 'Global' },
      { id: 'plate', label: 'Plate 1' },
      { id: 'object', label: 'Object 1' },
    ],
    'global',
    (id) => chosen.push(id),
  );
  const buttons = segmented.root.buttons();
  assert.equal(buttons.length, 3);
  buttons[2].click();
  assert.deepEqual(chosen, ['object']);
});

test('a progress bar with nothing running is taken out of the layout', () => {
  const bar = createXrProgressBar(ui);
  bar.setProgress(null);
  assert.equal(bar.root.props.display, 'none');
  bar.setProgress(0.62);
  assert.equal(bar.root.props.display, 'flex');
  const fill = bar.root.children[0] as FakePanel;
  assert.equal(fill.props.width, '62%');
});

test('a progress fraction outside 0–1 is clamped rather than drawn past the track', () => {
  const bar = createXrProgressBar(ui);
  bar.setProgress(4);
  assert.equal((bar.root.children[0] as FakePanel).props.width, '100%');
  bar.setProgress(-1);
  assert.equal((bar.root.children[0] as FakePanel).props.width, '0%');
});

console.log(`\nXR chrome: ${passed} tests passed.`);
