/**
 * Traces for the indexed G-code document (P11.2).
 *
 * The properties that matter are all about not lying to a reader who is
 * inspecting a file before printing it. Counts must be of the whole program
 * rather than the window on screen; a bounded search must say it was bounded;
 * and a window past the end must clamp rather than invent lines.
 */

import assert from 'node:assert/strict';

import { GcodeDocument, MAX_SEARCH_RESULTS } from '../GcodeDocument';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SAMPLE = ['; header', 'G28', 'M104 S230', 'G1 X1 Y1 E0.1', 'M104 S225', 'G1 X2 Y2 E0.2'].join('\n');

test('lines are numbered the way an operator would cite them', () => {
  const document = new GcodeDocument(SAMPLE);
  assert.equal(document.lineCount, 6);
  assert.deepEqual(document.window(1, 2), [
    { number: 1, text: '; header' },
    { number: 2, text: 'G28' },
  ]);
  assert.deepEqual(document.window(6, 1), [{ number: 6, text: 'G1 X2 Y2 E0.2' }]);
});

test('a trailing newline is not an extra line', () => {
  // It would show as an empty line 7 that no editor and no printer agrees
  // exists, and every line number after a re-slice would look shifted.
  assert.equal(new GcodeDocument(`${SAMPLE}\n`).lineCount, 6);
  assert.equal(new GcodeDocument('').lineCount, 1, 'an empty program is one empty line, not zero');
});

test('carriage returns are not part of the text', () => {
  const crlf = new GcodeDocument('G28\r\nM104 S230\r\n');
  assert.deepEqual(crlf.window(1, 2), [
    { number: 1, text: 'G28' },
    { number: 2, text: 'M104 S230' },
  ]);
});

test('a window past the end clamps instead of inventing lines', () => {
  // A viewer scrolled to the end of a program that was re-sliced shorter must
  // show the end of the new one, not blank rows suggesting content is there.
  const document = new GcodeDocument(SAMPLE);
  assert.deepEqual(document.window(100, 5), [{ number: 6, text: 'G1 X2 Y2 E0.2' }]);
  assert.deepEqual(document.window(0, 1), [{ number: 1, text: '; header' }], 'and before the start');
  assert.deepEqual(document.window(1, 0), []);
});

test('search finds lines, not occurrences', () => {
  const document = new GcodeDocument(SAMPLE);
  assert.deepEqual(document.search('M104').lineNumbers, [3, 5]);
  assert.deepEqual(document.search('m104').lineNumbers, [3, 5], 'case does not matter to a reader');
  // Twice on one line is one result: the operator wants the line.
  const doubled = new GcodeDocument('G1 X1 X1\nG28');
  assert.deepEqual(doubled.search('X1').lineNumbers, [1]);
});

test('a bounded search says it was bounded', () => {
  // Reporting a capped count as if it were the total would have an operator
  // believe they had seen every match.
  const many = new GcodeDocument(Array.from({ length: 20 }, () => 'G1 E1').join('\n'));
  const limited = many.search('G1', 5);
  assert.equal(limited.lineNumbers.length, 5);
  assert.equal(limited.truncated, true);

  const complete = many.search('G1', MAX_SEARCH_RESULTS);
  assert.equal(complete.lineNumbers.length, 20);
  assert.equal(complete.truncated, false);
});

test('an empty query matches nothing rather than everything', () => {
  const document = new GcodeDocument(SAMPLE);
  assert.deepEqual(document.search('   ').lineNumbers, []);
});

test('a realistic program is indexed without walking it per line', () => {
  // 200,000 lines is an ordinary plate. The point is that windowing and search
  // stay usable at that size — an implementation that split the source per
  // window would take seconds here.
  const big = new GcodeDocument(Array.from({ length: 200_000 }, (_, index) => `G1 X${index} E0.01`).join('\n'));
  assert.equal(big.lineCount, 200_000);
  const started = Date.now();
  assert.equal(big.window(199_998, 3).length, 3);
  assert.equal(big.window(199_998, 3)[0].number, 199_998);
  assert.ok(Date.now() - started < 500, 'a window near the end is cheap');
  assert.equal(big.search('X199999').lineNumbers[0], 200_000);
});

console.log(`\nG-code document: ${passed} tests passed.`);
