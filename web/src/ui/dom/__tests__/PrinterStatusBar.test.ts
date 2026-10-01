import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom 29 has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { PrinterStatusBar } from '../PrinterStatusBar';
import { askPrintJobConfirmation } from '../PrintJobConfirmDialog';
import { guardedPrinterActions, summarizePrinterStatus } from '../../../printer/PrinterStatusSummary';
import { printJobCommandAvailability } from '../../../printer/PrintJobControl';
import type { PrintJobCommandIntent } from '../../../printer/PrinterSessionController';

const dom = new JSDOM('<div id="host"></div>');
const host = dom.window.document.getElementById('host')!;
let now = 0;
let notify: () => void = () => {};
let displayed = 'A';
const sent: PrintJobCommandIntent[] = [];
const snapshot = { state: 'printing', klippyState: 'ready', filename: 'part.gcode', updatedAtMs: 0 } as const;
const actions = guardedPrinterActions(printJobCommandAvailability(snapshot));
const bar = new PrinterStatusBar(host, {
  getSummary: () => ({
    ...summarizePrinterStatus({ snapshot, connection: null, nowMs: now, configured: true }),
    present: true,
  }),
  getActions: () => actions,
  subscribe: (listener) => {
    notify = listener;
    return () => {
      notify = () => {};
    };
  },
  captureIntent: (command) =>
    Object.freeze({
      command,
      generation: 1,
      printerId: 'printer',
      printerLabel: 'Printer',
      observedState: 'printing',
      displayedFilename: 'part.gcode',
      job: Object.freeze({ jobId: displayed, startedAt: 1000, filename: 'part.gcode', modified: 500, size: 100 }),
    }),
  run: (intent) => {
    sent.push(intent);
  },
  reconnect: () => {},
  openDetails: () => {},
  now: () => now,
  scheduleFrame: () => 1,
  cancelFrame: () => {},
});
bar.mount();
const button = host.querySelector<HTMLButtonElement>('[data-printer-status-command="cancel"]')!;
button.dispatchEvent(new dom.window.Event('pointerdown'));
displayed = 'B';
now = 400;
notify();
assert.equal(
  host.querySelector('[data-printer-status-command="cancel"]'),
  button,
  'progress refresh must not destroy a held control',
);
now = 1000;
button.dispatchEvent(new dom.window.Event('pointerup'));
assert.equal(sent.length, 1);
assert.equal(sent[0].job?.jobId, 'A', 'release must carry the press-time intent, never job B');
button.dispatchEvent(new dom.window.Event('pointerup'));
assert.equal(sent.length, 1, 'duplicate release must not repeat a command');
button.dispatchEvent(new dom.window.Event('pointerdown'));
bar.dispose();
now = 3000;
button.dispatchEvent(new dom.window.Event('pointerup'));
assert.equal(sent.length, 1, 'disposal must abandon held confirmation');
Object.defineProperties(globalThis, {
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
});
const abort = new AbortController();
const dialogInput = {
  title: 'Cancel job A?',
  message: 'Printer A',
  consequences: ['Stops this print.'],
  confirmLabel: 'Confirm',
  dismissLabel: 'Dismiss',
};
const answer = askPrintJobConfirmation(dialogInput, abort.signal);
assert.ok(dom.window.document.querySelector('[data-print-job-confirm]'));
abort.abort();
assert.equal(await answer, false);
assert.equal(
  dom.window.document.querySelector('[data-print-job-confirm]'),
  null,
  'session loss removes a stale dialog',
);
assert.equal(await askPrintJobConfirmation(dialogInput, abort.signal), false);
assert.equal(dom.window.document.querySelector('[data-print-job-confirm]'), null, 'pre-aborted dialogs never mount');
dom.window.close();
console.log('PrinterStatusBar: press-time intent survives telemetry, duplicate release and disposal send nothing.');
