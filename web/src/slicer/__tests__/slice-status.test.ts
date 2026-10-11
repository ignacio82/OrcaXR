import assert from 'node:assert/strict';

import { describeSliceStatus, sliceStatusFigures } from '../SliceStatus';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const layers = (count: number, marker = ';LAYER_CHANGE') =>
  Array.from({ length: count }, (_, n) => `${marker}\nG1 Z${(n + 1) * 0.2}\n`).join('');

test("the engine's own layer total wins over its markers", () => {
  const gcode = `${layers(3)}; total layers count = 5\n`;
  assert.deepEqual(sliceStatusFigures(gcode), { lines: 8, layers: 5 });
});

test('a stated zero is a total, not a missing one', () => {
  assert.equal(sliceStatusFigures(`${layers(2)}; total layers count = 0\n`).layers, 0);
});

test('without a stated total, both marker spellings are counted', () => {
  const gcode = `${layers(2)}${layers(3, '; CHANGE_LAYER')}; total layers count = 2.5\n`;
  assert.equal(sliceStatusFigures(gcode).layers, 5);
  assert.equal(sliceStatusFigures('').layers, 0);
});

test('a total buried before the trailer is not read', () => {
  const gcode = `; total layers count = 99\n${'G1 X1 Y1 E0.01\n'.repeat(6000)}${layers(4)}`;
  assert.equal(sliceStatusFigures(gcode).layers, 4);
});

test('lines are split on LF, a final break adding an empty line', () => {
  assert.equal(sliceStatusFigures('G28\r\nG1\n').lines, 3);
  assert.equal(sliceStatusFigures('').lines, 1);
});

test('the status line: size to whole KB as toFixed rounds, then lines, layers and warnings', () => {
  const line = (byteLength: number, warnings: number) =>
    describeSliceStatus({ elapsedMs: 1234, byteLength, lines: 10, layers: 2, warnings });
  assert.equal(line(2048, 0), 'SLICED in 1234 ms\n2 KB, 10 lines, 2 layers');
  assert.equal(line(512, 1), 'SLICED in 1234 ms\n1 KB, 10 lines, 2 layers, 1 warning(s)');
  assert.equal(line(511, 2), 'SLICED in 1234 ms\n0 KB, 10 lines, 2 layers, 2 warning(s)');
  assert.equal(line(2560, 0), 'SLICED in 1234 ms\n3 KB, 10 lines, 2 layers');
});

console.log(`\nSlice status: ${passed} tests passed.`);
