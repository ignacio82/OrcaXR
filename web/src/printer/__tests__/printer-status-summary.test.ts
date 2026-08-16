import assert from 'node:assert/strict';

import { MoonrakerTransportError, type MoonrakerConnectionState } from '../MoonrakerTypes';
import { printJobCommandAvailability } from '../PrintJobControl';
import type { PrintJobSnapshot } from '../PrintJobStatus';
import {
  HoldToConfirm,
  PRINTER_HOLD_MS,
  formatReadingAge,
  guardedPrinterActions,
  summarizePrinterStatus,
} from '../PrinterStatusSummary';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const NOW = 1_800_000_000_000;

function connected(): MoonrakerConnectionState {
  return {
    status: 'connected',
    generation: 1,
    socketEpoch: 1,
    connectedAtMs: NOW - 60_000,
    lastHeartbeatAtMs: NOW - 1_000,
    handshake: {
      server: {
        apiVersion: [1, 5, 0],
        apiVersionString: '1.5.0',
        moonrakerVersion: 'v0.9.3',
        components: ['print_stats'],
        warnings: [],
      },
      printer: { state: 'ready', hostname: 'printer', softwareVersion: 'v0.12.0' },
      capabilities: {
        websocket: true,
        authorization: true,
        fileManagement: true,
        jobQueue: false,
        history: true,
        webcams: true,
        powerDevices: false,
        updateManager: false,
        announcements: false,
        database: true,
        klippyConnected: true,
        extensionComponents: [],
      },
    },
  };
}

function reconnecting(delayMs = 4_000): MoonrakerConnectionState {
  return {
    status: 'reconnecting',
    generation: 1,
    attempt: 2,
    delayMs,
    lastError: new MoonrakerTransportError('websocket_failed', 'socket').toDiagnostic(),
  };
}

function printing(overrides: Partial<PrintJobSnapshot> = {}): PrintJobSnapshot {
  return Object.freeze({
    state: 'printing',
    filename: 'tower.gcode',
    progress: 0.42,
    currentLayer: 84,
    totalLayers: 200,
    printDurationS: 1_800,
    estimatedRemainingS: 2_485,
    extruder: { actualC: 219.4, targetC: 220 },
    bed: { actualC: 60.1, targetC: 60 },
    updatedAtMs: NOW - 1_000,
    ...overrides,
  });
}

test('an unconfigured session stays out of the way and says why', () => {
  const summary = summarizePrinterStatus({ snapshot: null, connection: null, nowMs: NOW, configured: false });
  assert.equal(summary.present, false, 'nothing to monitor means nothing on screen');
  assert.equal(summary.headline, 'No printer configured');
  assert.equal(summary.tone, 'unknown');
  assert.deepEqual(summary.facts, []);
});

test('an idle connected printer stays out of the way; a running one does not', () => {
  const idle = summarizePrinterStatus({
    snapshot: { state: 'standby', updatedAtMs: NOW, extruder: { actualC: 24, targetC: 0 } },
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(idle.present, false, 'preparation is what the screen is for when nothing is running');
  assert.equal(idle.tone, 'idle');
  assert.equal(idle.headline, 'Idle');
  assert.deepEqual(
    idle.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ['Nozzle: 24 °C'],
    'a heater at no target reads as one number, not an arrow to zero',
  );

  const running = summarizePrinterStatus({
    snapshot: printing(),
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(running.present, true);
  assert.equal(running.tone, 'active');
  assert.equal(running.headline, 'Printing tower.gcode');
  assert.equal(running.detail, '42% · about 41m 25s left');
  assert.equal(running.progress, 0.42);
  assert.equal(running.stale, false);
  assert.equal(running.recovery, undefined);
  assert.deepEqual(
    running.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ['Layer: 84 / 200', 'Elapsed: 30m 00s', 'Left (approx.): 41m 25s', 'Nozzle: 219 °C → 220 °C', 'Bed: 60 °C → 60 °C'],
  );
});

test('a paused job asks for attention, and an errored one is the loudest thing on screen', () => {
  const paused = summarizePrinterStatus({
    snapshot: printing({ state: 'paused' }),
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(paused.tone, 'attention');
  assert.equal(paused.headline, 'Paused — tower.gcode');
  assert.equal(paused.present, true);

  const failed = summarizePrinterStatus({
    snapshot: { state: 'error', message: 'Extruder heater not heating at expected rate', updatedAtMs: NOW },
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(failed.tone, 'danger');
  assert.equal(failed.present, true, 'a failure shows itself even though nothing is running');
  assert.match(failed.headline, /^Error: Extruder heater/);
});

test('a lost session keeps the last reading, ages it, and says what is being done', () => {
  const summary = summarizePrinterStatus({
    snapshot: printing({ updatedAtMs: NOW - 40_000 }),
    connection: reconnecting(4_000),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(summary.stale, true);
  assert.equal(summary.tone, 'attention', 'a dropped socket is not a failed print');
  assert.equal(summary.headline, 'Printing tower.gcode', 'the last thing it said is still the most useful thing');
  assert.equal(summary.detail, 'Last reading 40 s ago', 'how old it is outranks how far along it was');
  assert.equal(summary.ageLabel, '40 s ago');
  assert.equal(summary.progress, 0.42, 'the reading is kept, not blanked');
  assert.equal(summary.present, true);
  assert.ok(summary.recovery);
  assert.equal(summary.recovery.automatic, true);
  assert.equal(summary.recovery.retryInS, 4);
  assert.match(summary.recovery.message, /dropped\. Retrying on its own; the print keeps running either way\./);
  assert.equal(summary.recovery.actionLabel, 'Reconnect now');
});

test('an errored connection offers a manual reconnect and never invents a message', () => {
  const summary = summarizePrinterStatus({
    snapshot: printing(),
    connection: {
      status: 'error',
      generation: 1,
      error: new MoonrakerTransportError('heartbeat_timeout', 'socket').toDiagnostic(),
    },
    nowMs: NOW,
    configured: true,
  });
  assert.equal(summary.stale, true);
  assert.ok(summary.recovery);
  assert.equal(summary.recovery.automatic, false, 'nothing is retrying, so the operator has to');
  assert.equal(summary.recovery.actionLabel, 'Reconnect');
  // The diagnostic deliberately carries no message; the phrase comes from the
  // shared code table rather than being written twice.
  assert.equal(summary.recovery.message, 'The Moonraker WebSocket heartbeat timed out.');
  assert.equal(summary.recovery.retryInS, undefined);
});

test('a reading age reads as a duration, not a timestamp', () => {
  assert.equal(formatReadingAge(0), 'just now');
  assert.equal(formatReadingAge(4_400), 'just now');
  assert.equal(formatReadingAge(40_000), '40 s ago');
  assert.equal(formatReadingAge(89_000), '89 s ago');
  assert.equal(formatReadingAge(200_000), '3 min ago');
  assert.equal(formatReadingAge(7_200_000), '2 h ago');
  assert.equal(formatReadingAge(Number.NaN), 'just now');
});

test('progress that the printer never reported is absent, not zero', () => {
  const summary = summarizePrinterStatus({
    snapshot: { state: 'printing', filename: 'a.gcode', updatedAtMs: NOW },
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(summary.progress, undefined);
  assert.equal(summary.progressLabel, undefined);
  assert.equal(summary.detail, 'Nothing running', 'with no progress there is no number to lead with');

  const clamped = summarizePrinterStatus({
    snapshot: printing({ progress: 1.4, estimatedRemainingS: undefined }),
    connection: connected(),
    nowMs: NOW,
    configured: true,
  });
  assert.equal(clamped.progress, 1);
  assert.equal(clamped.detail, '100%');
});

test('destructive commands are held, recoverable ones are not', () => {
  const actions = guardedPrinterActions(printJobCommandAvailability(printing()));
  const byCommand = new Map(actions.map((action) => [action.command, action]));

  assert.equal(byCommand.get('pause')?.holdMs, 0, 'pause is one tap; being slow to reach it costs prints');
  assert.equal(byCommand.get('pause')?.enabled, true);
  assert.equal(byCommand.get('cancel')?.holdMs, PRINTER_HOLD_MS.cancel);
  const cancel = byCommand.get('cancel');
  const stop = byCommand.get('emergency-stop');
  const resume = byCommand.get('resume');
  assert.ok(cancel && stop && resume);
  assert.ok(cancel.holdMs > 0);
  assert.ok(stop.holdMs > cancel.holdMs, 'halting the machine is the hardest thing to do by accident');
  assert.match(cancel.confirmation ?? '', /cannot be resumed/);
  assert.equal(resume.enabled, false, 'a running print has nothing to resume');
  assert.ok(resume.reason?.includes('printing'), resume.reason ?? 'no reason given');
  assert.equal(
    actions.every((action) => action.destructive === action.holdMs > 0),
    true,
    'exactly the destructive commands are the held ones',
  );
});

test('a reading nobody can confirm disables every command, with the same reason', () => {
  const actions = guardedPrinterActions(printJobCommandAvailability(printing()), {
    stale: true,
    staleReason: 'The connection to the printer dropped.',
  });
  assert.equal(
    actions.every((action) => !action.enabled),
    true,
    'acting on a state nothing can confirm is guessing',
  );
  assert.deepEqual([...new Set(actions.map((action) => action.reason))], ['The connection to the printer dropped.']);
  assert.equal(
    actions.every((action) => action.holdMs === PRINTER_HOLD_MS[action.command]),
    true,
    'the guard is unchanged; only availability moved',
  );
});

test('a hold that is released early runs nothing', () => {
  let now = 0;
  const hold = new HoldToConfirm({ now: () => now });
  const cancel = guardedPrinterActions(printJobCommandAvailability(printing())).find(
    (action) => action.command === 'cancel',
  );
  assert.ok(cancel);

  assert.deepEqual(hold.press(cancel), { phase: 'holding', progress: 0, command: 'cancel' });
  now = 200;
  assert.equal(hold.poll().progress, 0.25, 'a quarter of the way, and drawable');
  now = 799;
  const early = hold.release();
  assert.equal(early.command, undefined, 'one millisecond short is short');
  assert.equal(early.state.phase, 'idle');

  now = 1_000;
  hold.press(cancel);
  now = 1_800;
  const complete = hold.release();
  assert.equal(complete.command, 'cancel');
  assert.equal(complete.state.phase, 'fired');
  assert.equal(complete.state.progress, 1);

  // The gesture resets, so the next press starts from nothing rather than
  // inheriting the progress that just fired.
  assert.deepEqual(hold.poll(), { phase: 'idle', progress: 0 });
});

test('a hold cannot start on a disabled control, and can always be abandoned', () => {
  let now = 0;
  const hold = new HoldToConfirm({ now: () => now });
  const disabled = guardedPrinterActions(printJobCommandAvailability(printing()), { stale: true }).find(
    (action) => action.command === 'cancel',
  );
  assert.ok(disabled);
  assert.deepEqual(hold.press(disabled), { phase: 'idle', progress: 0 });
  now = 5_000;
  assert.equal(hold.release().command, undefined, 'a gesture that never started cannot complete');

  const live = guardedPrinterActions(printJobCommandAvailability(printing())).find(
    (action) => action.command === 'cancel',
  );
  assert.ok(live);
  hold.press(live);
  now = 5_400;
  assert.deepEqual(hold.cancel(), { phase: 'idle', progress: 0 }, 'a ray that left the control abandons the hold');
  now = 9_000;
  assert.equal(hold.release().command, undefined, 'and releasing afterwards still runs nothing');
});

test('a zero-hold command fires the moment it is released', () => {
  const hold = new HoldToConfirm({ now: () => 0 });
  const pause = guardedPrinterActions(printJobCommandAvailability(printing())).find(
    (action) => action.command === 'pause',
  );
  assert.ok(pause);
  assert.equal(hold.press(pause).progress, 1, 'nothing to hold means nothing to draw');
  const released = hold.release();
  assert.equal(released.command, 'pause');
  assert.equal(released.state.phase, 'fired');
});

console.log(`\nPrinter status summary: ${passed} tests passed.`);
