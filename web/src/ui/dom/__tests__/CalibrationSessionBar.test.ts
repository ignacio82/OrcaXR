/**
 * Traces for the calibration session banner (P8.3).
 *
 * The banner exists to stop someone building on top of a temperature tower
 * without realising their own project is waiting behind it. So the properties
 * that matter are: it is absent when there is nothing to say, it names both
 * ways out whenever there is, and neither way out can be pressed into silence.
 */

import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { CalibrationSessionBar, type CalibrationSessionBarState } from '../CalibrationSessionBar';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mount(initial: CalibrationSessionBarState): {
  host: HTMLElement;
  calls: string[];
  setState: (next: CalibrationSessionBarState) => void;
} {
  const dom = new JSDOM('<!doctype html><div id="host" hidden></div>');
  const host = dom.window.document.getElementById('host') as unknown as HTMLElement;
  let state = initial;
  const calls: string[] = [];
  const bar = new CalibrationSessionBar(host, {
    getState: () => state,
    onDiscard: () => {
      calls.push('discard');
    },
    onKeep: () => {
      calls.push('keep');
    },
    onSlice: () => {
      calls.push('slice');
    },
    onExport: () => {
      calls.push('export');
    },
    onSend: () => {
      calls.push('send');
    },
  });
  bar.mount();
  return {
    host,
    calls,
    setState: (next) => {
      state = next;
      bar.refresh();
    },
  };
}

const action = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-calibration-session-action="${id}"]`);

await test('nothing is shown while no calibration owns the editor', () => {
  const view = mount({ open: false });
  assert.equal(view.host.hidden, true, 'a slot that usually says nothing trains people to stop reading it');
  assert.equal(view.host.children.length, 0);
});

await test('an open session says so and offers both ways out', () => {
  const view = mount({ open: true });
  assert.equal(view.host.hidden, false);
  assert.ok(action(view.host, 'calibration-discard'), 'the way back to the project is offered');
  assert.ok(action(view.host, 'calibration-keep'), 'and so is adopting the calibration');
  const message = view.host.querySelector('[data-calibration-session-message]');
  assert.ok(message);
  assert.equal(message.getAttribute('role'), 'status', 'nothing is wrong, so this is not an alert');
  assert.match(message.textContent ?? '', /held aside/);
});

await test('the held project is named when it has one', () => {
  const view = mount({ open: true, heldProjectName: 'Bracket v3' });
  assert.match(
    view.host.querySelector('[data-calibration-session-message]')?.textContent ?? '',
    /Bracket v3/,
    'a named project is a thing the operator recognises, not a promise',
  );
});

await test('both controls report, and the banner clears once the session closes', async () => {
  const view = mount({ open: true });
  action(view.host, 'calibration-discard')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.setState({ open: true });
  action(view.host, 'calibration-keep')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.calls, ['discard', 'keep']);

  view.setState({ open: false });
  assert.equal(view.host.hidden, true);
  assert.equal(action(view.host, 'calibration-discard'), null, 'and neither control lingers');
});

await test('slicing is offered immediately; moving G-code waits until there is some', () => {
  const view = mount({ open: true });
  assert.equal(action(view.host, 'calibration-slice')?.disabled, false, 'there is always something to slice');
  assert.equal(action(view.host, 'calibration-export')?.disabled, true, 'but nothing to save yet');
  assert.equal(action(view.host, 'calibration-send')?.disabled, true, 'and nothing to send');

  view.setState({ open: true, sliced: true });
  assert.equal(action(view.host, 'calibration-export')?.disabled, false);
  assert.equal(action(view.host, 'calibration-send')?.disabled, false);
});

await test('sending is withheld with a reason when no printer is connected', () => {
  const view = mount({
    open: true,
    sliced: true,
    sendUnavailableReason: 'No printer is connected, so there is nowhere to send it.',
  });
  const send = action(view.host, 'calibration-send');
  assert.equal(send?.disabled, true);
  assert.equal(send?.dataset.calibrationSendUnavailable, 'true');
  assert.match(send?.title ?? '', /nowhere to send it/, 'grey with no reason teaches people the app is broken');
  // Saving the file does not need a printer, so it must stay available.
  assert.equal(action(view.host, 'calibration-export')?.disabled, false);
});

await test('the banner says what slicing and sending will act on', () => {
  // The reason these controls live on the banner at all: with a session open
  // they act on the calibration, not on the project waiting behind it.
  const view = mount({ open: true, heldProjectName: 'Bracket v3' });
  const message = view.host.querySelector('[data-calibration-session-message]')?.textContent ?? '';
  assert.match(message, /act on the calibration/);
  assert.match(message, /Bracket v3/);
});

await test('each control reports exactly once', async () => {
  const view = mount({ open: true, sliced: true });
  for (const id of ['calibration-slice', 'calibration-export', 'calibration-send']) {
    action(view.host, id)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.setState({ open: true, sliced: true });
  }
  assert.deepEqual(view.calls, ['slice', 'export', 'send']);
});

console.log(`\nCalibration session bar: ${passed} tests passed.`);
