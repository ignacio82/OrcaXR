import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { askPrintSubmission, type PrintSubmissionDialogInput } from '../PrintSubmissionDialog';

const dom = new JSDOM('<button id="previous">Send</button>');
const document = dom.window.document;
Object.defineProperties(globalThis, {
  document: { configurable: true, value: document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
});
const input: PrintSubmissionDialogInput = {
  filename: 'part_01234567890123456789012345678901.gcode',
  plateName: 'Plate A',
  byteLength: 12,
  endpointLabel: 'Printer A',
  printerStateLabel: 'standby',
  toolSummary: 'T0',
  blockers: [],
  warnings: [],
  startOptions: [],
  overwrite: { allowed: true, filename: 'part.gcode', existing: { filename: 'part.gcode', size: 30, modified: 100 } },
};
document.getElementById('previous').focus();
const abort = new AbortController();
const cancelled = askPrintSubmission(input, abort.signal);
assert.equal(document.querySelector('[data-print-submission-overwrite]').checked, false);
assert.equal(document.activeElement.dataset.printSubmissionChoice, 'upload');
assert.match(document.querySelector('label').textContent, /part.gcode, replacing 30 bytes modified 1970-01-01/);
abort.abort();
assert.deepEqual(await cancelled, { choice: 'cancel' });
assert.equal(document.querySelector('[role="dialog"]'), null);
assert.equal(document.activeElement.id, 'previous');

const blocked = askPrintSubmission({ ...input, blockers: ['T1 is not loaded.'] });
assert.equal(document.querySelector('[data-print-submission-choice="upload-and-print"]').disabled, true);
document.querySelector('[data-print-submission-choice="upload"]').click();
assert.deepEqual(await blocked, { choice: 'upload', overwrite: false, startOptions: [] });

const stored = askPrintSubmission({ ...input, mode: 'stored' });
assert.equal(document.querySelector('[data-print-submission-choice="upload"]'), null);
assert.equal(document.querySelector('[data-print-submission-overwrite]'), null);
assert.equal(document.activeElement.dataset.printSubmissionChoice, 'cancel');
document.querySelector('[data-print-submission-choice="upload-and-print"]').click();
assert.deepEqual(await stored, { choice: 'upload-and-print', overwrite: false, startOptions: [] });
dom.window.close();
console.log(
  'Print submission dialog: cancellation, exact overwrite, safe defaults, and stored-file confirmation passed.',
);
