import assert from 'node:assert/strict';
import { Color } from 'three';

import { parseGcodeToolpath } from '../GcodeToolpath';
import { GCODE_RECORD_KIND, RICH_GCODE_HARD_CAPS, parseRichGcodeModel, type RichGcodeColumns } from '../RichGcodeModel';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function columnValues<T extends ArrayLike<number>>(values: T): number[] {
  return Array.from(values);
}

function approximately(actual: number, expected: number, epsilon = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function approximatelyValues(actual: ArrayLike<number>, expected: readonly number[], epsilon = 1e-5): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => approximately(actual[index], value, epsilon));
}

function findKind(columns: RichGcodeColumns, kind: number): number {
  const index = columns.kind.indexOf(kind);
  assert.notEqual(index, -1, `missing record kind ${kind}`);
  return index;
}

test('compatible tags and modal G0/G1 state produce source-addressable classified columns', () => {
  const source = [
    ' \t;TYPE:Outer wall',
    ';HEIGHT:2e-1',
    ';WIDTH:4.5e-1',
    ';LAYER_CHANGE',
    'N7 G1 X10 Y0 E1 F1200',
    'G1 X20 E0.8 F1800',
    'G1 E0.5',
    'G1 E0.8',
    'G91',
    'G1 X5 E0.2 F600',
    'G90',
    'G92 X0 E0',
    'G1 X10 E1',
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.equal(model.layerCount, 1);
  assert.deepEqual(model.roles, ['Undefined', 'Outer wall']);
  assert.deepEqual(columnValues(columns.kind), [
    GCODE_RECORD_KIND.LAYER_CHANGE,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.TRAVEL,
    GCODE_RECORD_KIND.RETRACT,
    GCODE_RECORD_KIND.UNRETRACT,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
  ]);
  approximatelyValues(columns.deltaE, [0, 1, -0.2, -0.3, 0.3, 0.2, 1]);

  const firstExtrusion = 1;
  assert.equal(columns.sourceLine[firstExtrusion], 5);
  assert.equal(columns.commandLineNumber[firstExtrusion], 7);
  assert.equal(columns.sourceStartOffset[firstExtrusion], source.indexOf('N7 G1'));
  assert.equal(columns.sourceEndOffset[firstExtrusion], source.indexOf('N7 G1') + 'N7 G1 X10 Y0 E1 F1200'.length);
  assert.equal(model.roles[columns.role[firstExtrusion]], 'Outer wall');
  assert.equal(columns.layer[firstExtrusion], 1);
  approximately(columns.feedrateMmPerSecond[firstExtrusion], 20);
  approximately(columns.widthMm[firstExtrusion], 0.45);
  approximately(columns.heightMm[firstExtrusion], 0.2);
  const expectedMm3PerMm = (Math.PI * 0.875 ** 2) / 10;
  approximately(columns.mm3PerMm[firstExtrusion], expectedMm3PerMm);
  approximately(columns.volumetricFlowMm3PerSecond[firstExtrusion], expectedMm3PerMm * 20);

  assert.equal(columns.endX[5], 25, 'G91 makes both XYZ and E relative');
  assert.equal(columns.endX[6], 35, 'G92 shifts the subsequent absolute X origin');
  approximately(columns.endZ[1], 0.2);
  assert.equal(model.warnings.length, 0);
});

test('units and independent coordinate/extrusion modes match the pinned processor', () => {
  const source = [
    'G20',
    'M106 S255',
    'M83',
    'G1 X1 E0.1 F60',
    'G21',
    'G91',
    'M82',
    'G0 X1 F120',
    'G1 X1 E1',
    'G90',
    'G92 E0',
    'G1 X28.4 E1 F180',
    'M83',
    'M107',
    'G1 X29.4 E0.5',
  ].join('\n');
  const columns = parseRichGcodeModel(source).columns;

  assert.deepEqual(columnValues(columns.kind), [
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.TRAVEL,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
  ]);
  approximatelyValues(columns.endX, [25.4, 26.4, 27.4, 28.4, 29.4]);
  approximatelyValues(columns.deltaE, [2.54, 0, 1, 1, 0.5]);
  approximatelyValues(columns.feedrateMmPerSecond, [1, 2, 2, 3, 3]);
  approximatelyValues(columns.fanPercent, [100, 100, 100, 100, 0]);
});

test('BBL tags retain tool, filament, process-state, and wipe marker identity', () => {
  const source = [
    '; FEATURE: Sparse infill',
    '; LAYER_HEIGHT: 0.28',
    '; LINE_WIDTH: 0.5',
    '; CHANGE_LAYER',
    'M106 S128',
    'M104 S210',
    'M83',
    'G1 X5 E0.5 F600',
    'T1',
    'M109 S220',
    '; COLOR_CHANGE,T1,#112233',
    '; PAUSE_PRINTING',
    '; CUSTOM_GCODE',
    '; WIPE_START',
    'G1 X6 E-0.1 F300',
    '; WIPE_END',
    'G1 E-0.2',
    'G1 E0.2',
  ].join('\n');
  const model = parseRichGcodeModel(source, {
    filamentColors: ['#AA0000', '#00AA00'],
  });
  const columns = model.columns;

  assert.deepEqual(columnValues(columns.kind), [
    GCODE_RECORD_KIND.LAYER_CHANGE,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.TOOL_CHANGE,
    GCODE_RECORD_KIND.COLOR_CHANGE,
    GCODE_RECORD_KIND.PAUSE,
    GCODE_RECORD_KIND.CUSTOM,
    GCODE_RECORD_KIND.WIPE_START,
    GCODE_RECORD_KIND.WIPE,
    GCODE_RECORD_KIND.WIPE_END,
    GCODE_RECORD_KIND.RETRACT,
    GCODE_RECORD_KIND.UNRETRACT,
  ]);
  assert.deepEqual(
    model.filaments.map(({ id, tool, source: identitySource, color }) => ({
      id,
      tool,
      source: identitySource,
      color,
    })),
    [
      { id: 0, tool: 0, source: 'tool', color: '#AA0000' },
      { id: 1, tool: 1, source: 'tool', color: '#00AA00' },
      { id: 2, tool: 1, source: 'color-change', color: '#112233' },
    ],
  );

  const extrusion = findKind(columns, GCODE_RECORD_KIND.EXTRUDE);
  approximately(columns.fanPercent[extrusion], (100 / 255) * 128);
  assert.equal(columns.hotendTemperatureC[extrusion], 210);
  assert.equal(columns.tool[extrusion], 0);
  assert.equal(columns.filament[extrusion], 0);
  approximately(columns.widthMm[extrusion], 0.5);
  approximately(columns.heightMm[extrusion], 0.28);

  const colorChange = findKind(columns, GCODE_RECORD_KIND.COLOR_CHANGE);
  assert.equal(columns.tool[colorChange], 1);
  assert.equal(columns.filament[colorChange], 2);
  assert.equal(columns.hotendTemperatureC[colorChange], 220);

  const wipe = findKind(columns, GCODE_RECORD_KIND.WIPE);
  assert.equal(columns.tool[wipe], 1);
  assert.equal(columns.filament[wipe], 2);
  approximately(columns.deltaE[wipe], -0.1);
  approximately(columns.widthMm[wipe], 0.05);
  approximately(columns.heightMm[wipe], 0.05);
  assert.equal(columns.mm3PerMm[wipe], 0);
  assert.equal(columns.volumetricFlowMm3PerSecond[wipe], 0);
  assert.equal(model.warnings.length, 0);
});

test('malformed words are diagnosed and unsupported arcs stop before lossy interpolation', () => {
  const source = ['M83', 'G1 X E1', 'G1 X1 X2 E1', 'G2 X3 Y3 I1 J0', 'G1 X4 E1'].join('\n');
  const model = parseRichGcodeModel(source);

  assert.equal(model.complete, false);
  assert.equal(model.terminationReason, 'unsupported-arc');
  assert.equal(model.parsedLines, 4);
  assert.deepEqual(columnValues(model.columns.kind), [GCODE_RECORD_KIND.UNRETRACT, GCODE_RECORD_KIND.EXTRUDE]);
  assert.deepEqual(columnValues(model.columns.sourceLine), [2, 3]);
  assert.ok(model.warnings.some((warning) => warning.code === 'invalid-parameter' && warning.line === 2));
  assert.ok(model.warnings.some((warning) => warning.code === 'duplicate-parameter' && warning.line === 3));
  assert.ok(
    model.warnings.some(
      (warning) =>
        warning.code === 'unsupported-arc-interpolation' && warning.severity === 'error' && warning.line === 4,
    ),
  );
});

test('requested parse budgets are bounded, diagnosed, and never exceed hard caps', () => {
  const recordLimited = parseRichGcodeModel(['M83', 'G1 X1 E1', 'G1 X2 E1', 'G1 X3 E1'].join('\n'), {
    limits: { records: 2 },
  });
  assert.equal(recordLimited.columns.count, 2);
  assert.equal(recordLimited.complete, false);
  assert.equal(recordLimited.terminationReason, 'record-cap');
  assert.ok(recordLimited.warnings.some((warning) => warning.code === 'record-cap' && warning.line === 4));

  const lineLimited = parseRichGcodeModel(['G1 X1 E1', 'G1 X2 E2', 'G1 X3 E3'].join('\n'), {
    limits: { lines: 2 },
  });
  assert.equal(lineLimited.columns.count, 2);
  assert.equal(lineLimited.terminationReason, 'line-cap');
  assert.ok(lineLimited.warnings.some((warning) => warning.code === 'source-line-cap' && warning.line === 3));

  const characterLimited = parseRichGcodeModel('M83\nG1 X1 E1', {
    limits: { inputCharacters: 4 },
  });
  assert.equal(characterLimited.columns.count, 0);
  assert.equal(characterLimited.parsedCharacters, 4);
  assert.equal(characterLimited.terminationReason, 'input-cap');
  assert.ok(characterLimited.warnings.some((warning) => warning.code === 'input-character-cap'));

  const warningLimited = parseRichGcodeModel(['G1 X', 'G1 Y', 'G1 Z'].join('\n'), {
    limits: { warnings: 2 },
  });
  assert.equal(warningLimited.warnings.length, 2);
  assert.equal(warningLimited.warnings.at(-1)?.code, 'warning-cap');

  const longLineLimited = parseRichGcodeModel('M83\nG1 X1 E1', {
    limits: { lineCharacters: 4 },
  });
  assert.equal(longLineLimited.columns.count, 0);
  assert.ok(longLineLimited.warnings.some((warning) => warning.code === 'source-line-too-long' && warning.line === 2));

  const clamped = parseRichGcodeModel('', {
    limits: { records: RICH_GCODE_HARD_CAPS.records + 1 },
  });
  assert.equal(clamped.limits.records, RICH_GCODE_HARD_CAPS.records);
  assert.throws(
    () => parseRichGcodeModel('', { filamentColors: Array.from({ length: 257 }, () => '#000000') }),
    /At most 256 filament colors/,
  );
});

test('the legacy geometry adapter preserves extrusion-only output and feature color precedence', () => {
  const source = [
    'M83',
    ';TYPE:Outer wall',
    ';LAYER_CHANGE',
    'G1 X10 E1',
    'T1',
    'G1 X20 E1',
    ';TYPE:Support',
    'G1 X30 E1',
  ].join('\n');
  const toolpath = parseGcodeToolpath(source, ['#FF0000', '#00FF00']);
  const positions = toolpath.geometry.getAttribute('position');
  const colors = toolpath.geometry.getAttribute('color');
  const support = new Color(0x00ff7f);

  assert.equal(toolpath.layerCount, 1);
  assert.equal(toolpath.segmentCount, 3);
  approximatelyValues(positions.array, [0, 0, 0, 10, 0, 0.2, 10, 0, 0.2, 20, 0, 0.2, 20, 0, 0.2, 30, 0, 0.2]);
  assert.deepEqual(columnValues(colors.array).slice(0, 6), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(columnValues(colors.array).slice(6, 12), [0, 1, 0, 0, 1, 0]);
  approximately(colors.getX(4), support.r);
  approximately(colors.getY(4), support.g);
  approximately(colors.getZ(4), support.b);
  approximately(colors.getX(5), support.r);
  approximately(colors.getY(5), support.g);
  approximately(colors.getZ(5), support.b);
  toolpath.geometry.dispose();
});

console.log(`${passed} rich G-code model tests passed`);
