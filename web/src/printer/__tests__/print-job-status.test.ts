import assert from 'node:assert/strict';

import {
  PrintJobStatusModel,
  PRINT_JOB_OBJECTS,
  describePrintJobState,
  formatDuration,
  isActivePrintState,
  projectPrintJobSnapshot,
} from '../PrintJobStatus';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const QUERY = Object.freeze({
  status: {
    webhooks: { state: 'ready' },
    print_stats: {
      state: 'printing',
      filename: 'PeggyPalette_Plate_1.gcode',
      print_duration: 600,
      total_duration: 640,
      filament_used: 1234.5,
      message: '',
      info: { current_layer: 12, total_layer: 98 },
    },
    virtual_sdcard: { progress: 0.25, is_active: true },
    display_status: { progress: 0.25 },
    extruder: { temperature: 219.8, target: 220 },
    heater_bed: { temperature: 59.4, target: 60 },
  },
});

test('projects one full query into a typed snapshot with an honest remaining estimate', () => {
  const model = new PrintJobStatusModel();
  const snapshot = model.applyQuery(QUERY, 1_000);
  assert.equal(snapshot.state, 'printing');
  assert.equal(snapshot.klippyState, 'ready');
  assert.equal(snapshot.filename, 'PeggyPalette_Plate_1.gcode');
  assert.equal(snapshot.progress, 0.25);
  assert.equal(snapshot.currentLayer, 12);
  assert.equal(snapshot.totalLayers, 98);
  assert.equal(snapshot.printDurationS, 600);
  assert.equal(snapshot.filamentUsedMm, 1234.5);
  assert.deepEqual(snapshot.extruder, { actualC: 219.8, targetC: 220 });
  assert.deepEqual(snapshot.bed, { actualC: 59.4, targetC: 60 });
  // 600 s covered a quarter of the file, so ~1800 s of file remains.
  assert.equal(Math.round(snapshot.estimatedRemainingS ?? 0), 1800);
  assert.equal(snapshot.updatedAtMs, 1_000);
  assert.equal(Object.isFrozen(snapshot), true);
  // An empty message is absent rather than an empty string.
  assert.equal('message' in snapshot, false);
});

test('merges partial status notifications instead of replacing the model', () => {
  const model = new PrintJobStatusModel();
  model.applyQuery(QUERY, 1_000);
  const updated = model.applyNotification([{ virtual_sdcard: { progress: 0.5 } }, 12.5], 2_000);
  assert.ok(updated);
  assert.equal(updated.progress, 0.5);
  // Everything the patch did not mention survives.
  assert.equal(updated.filename, 'PeggyPalette_Plate_1.gcode');
  assert.equal(updated.currentLayer, 12);
  assert.equal(updated.state, 'printing');

  const layered = model.applyNotification([{ print_stats: { info: { current_layer: 40 } } }], 3_000);
  assert.equal(layered?.currentLayer, 40);
  assert.equal(layered?.totalLayers, 98, 'a nested partial patch keeps the sibling field');
  assert.equal(layered?.filename, 'PeggyPalette_Plate_1.gcode');
});

test('ignores notifications for objects this model does not read', () => {
  const model = new PrintJobStatusModel();
  model.applyQuery(QUERY, 1_000);
  assert.equal(model.applyNotification([{ gcode_move: { speed_factor: 1.2 } }], 2_000), null);
  assert.equal(model.applyNotification('not a status update', 2_000), null);
  assert.equal(model.snapshot.progress, 0.25, 'the snapshot is untouched');
});

test('reports an unreadable state as unknown rather than idle', () => {
  const model = new PrintJobStatusModel();
  const snapshot = model.applyQuery({ status: { webhooks: { state: 'shutdown' } } }, 5_000);
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.klippyState, 'shutdown');
  assert.equal('progress' in snapshot, false);
  assert.equal(isActivePrintState(snapshot.state), false);
  assert.match(describePrintJobState(snapshot), /not reported/i);
  assert.equal(model.reset().state, 'unknown');
});

test('withholds a remaining estimate while the numbers cannot mean anything', () => {
  const early = projectPrintJobSnapshot(
    { print_stats: { state: 'printing', print_duration: 20 }, virtual_sdcard: { progress: 0.005 } },
    0,
  );
  assert.equal('estimatedRemainingS' in early, false, 'a 0.5% sample must not extrapolate a total');
  const done = projectPrintJobSnapshot(
    { print_stats: { state: 'printing', print_duration: 400 }, virtual_sdcard: { progress: 1 } },
    0,
  );
  assert.equal('estimatedRemainingS' in done, false);
});

test('normalizes reported states and clamps a nonsense progress value', () => {
  for (const [reported, expected] of [
    ['PAUSED', 'paused'],
    ['canceled', 'cancelled'],
    ['complete', 'complete'],
    ['error', 'error'],
    ['standby', 'standby'],
    ['weird', 'unknown'],
  ] as const) {
    assert.equal(projectPrintJobSnapshot({ print_stats: { state: reported } }, 0).state, expected);
  }
  assert.equal(projectPrintJobSnapshot({ virtual_sdcard: { progress: 4 } }, 0).progress, 1);
  assert.equal(projectPrintJobSnapshot({ virtual_sdcard: { progress: -1 } }, 0).progress, 0);
  assert.match(
    describePrintJobState(projectPrintJobSnapshot({ print_stats: { state: 'error', message: 'Lost heater' } }, 0)),
    /Lost heater/,
  );
});

test('formats durations and declares exactly the objects it subscribes to', () => {
  assert.equal(formatDuration(undefined), '—');
  assert.equal(formatDuration(-5), '—');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(750), '12m 30s');
  assert.equal(formatDuration(3_840), '1h 04m');
  assert.deepEqual(Object.keys(PRINT_JOB_OBJECTS).sort(), [
    'display_status',
    'extruder',
    'heater_bed',
    'print_stats',
    'virtual_sdcard',
    'webhooks',
  ]);
});

console.log(`\nPrint job status: ${passed} tests passed.`);
