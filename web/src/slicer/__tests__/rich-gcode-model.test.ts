import assert from 'node:assert/strict';
import { Color } from 'three';

import { parseGcodeToolpath } from '../GcodeToolpath';
import {
  GCODE_PATH_KIND,
  GCODE_RECORD_KIND,
  RICH_GCODE_HARD_CAPS,
  parseRichGcodeModel,
  type RichGcodeColumns,
} from '../RichGcodeModel';

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

test('CW/CCW quarter and major arcs retain one source record and parse the suffix', () => {
  const source = [
    'G21',
    'M83',
    'G1 X10 Y0',
    'N17 G3 X0 Y10 I-10 J0 E1 F600',
    'G2 X10 Y0 I0 J-10 E1',
    'G2 X0 Y10 I-10 J0 E1',
    'G1 X20 Y10 E1',
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.equal(model.parsedLines, 7);
  assert.equal(model.warnings.length, 0);
  assert.deepEqual(columnValues(columns.kind), [
    GCODE_RECORD_KIND.TRAVEL,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
    GCODE_RECORD_KIND.EXTRUDE,
  ]);
  assert.deepEqual(columnValues(columns.pathKind), [
    GCODE_PATH_KIND.DIRECT,
    GCODE_PATH_KIND.ARC_CCW,
    GCODE_PATH_KIND.ARC_CW,
    GCODE_PATH_KIND.ARC_CW,
    GCODE_PATH_KIND.DIRECT,
  ]);
  assert.deepEqual(columnValues(columns.pathPointCount), [0, 15, 15, 47, 0]);
  assert.deepEqual(columnValues(columns.pathPointOffset), [0, 0, 15, 30, 77]);
  assert.equal(model.pathPoints.count, 77);
  assert.deepEqual(columnValues(columns.sourceLine), [3, 4, 5, 6, 7]);
  assert.equal(columns.commandLineNumber[1], 17);
  assert.equal(columns.sourceStartOffset[1], source.indexOf('N17 G3'));
  assert.equal(columns.sourceEndOffset[1], source.indexOf('N17 G3') + 'N17 G3 X0 Y10 I-10 J0 E1 F600'.length);
  approximately(columns.arcCenterX[1], 0);
  approximately(columns.arcCenterY[1], 0);
  assert.ok(model.pathPoints.x[0] < 10 && model.pathPoints.y[0] > 0, 'CCW begins toward +Y');
  assert.ok(model.pathPoints.x[30] < 10 && model.pathPoints.y[30] < 0, 'CW major arc begins toward -Y');
  approximately(columns.startX[4], 0);
  approximately(columns.endX[4], 20);

  const quarterDistance = 5 * Math.PI;
  const expectedMm3PerMm = (Math.PI * 0.875 ** 2) / quarterDistance;
  approximately(columns.mm3PerMm[1], expectedMm3PerMm, 2e-6);
  approximately(columns.volumetricFlowMm3PerSecond[1], expectedMm3PerMm * 10, 2e-5);
});

test('I-only and J-only centers are valid while extra R and malformed unused center words are ignored', () => {
  const source = ['M83', 'G1 X10 Y0', 'G3 X0 Y10 I-10 E1', 'G2 X10 Y0 Ibad J-10 R999 E1', 'G1 X11'].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.deepEqual(
    model.warnings.map(({ code, line }) => ({ code, line })),
    [{ code: 'invalid-parameter', line: 4 }],
  );
  assert.deepEqual(columnValues(columns.pathKind), [
    GCODE_PATH_KIND.DIRECT,
    GCODE_PATH_KIND.ARC_CCW,
    GCODE_PATH_KIND.ARC_CW,
    GCODE_PATH_KIND.DIRECT,
  ]);
  assert.deepEqual(columnValues(columns.pathPointCount), [0, 15, 15, 0]);
  approximatelyValues(columns.arcCenterX, [0, 0, 0, 0]);
  approximatelyValues(columns.arcCenterY, [0, 0, 0, 0]);
  approximately(columns.startX[3], 10);
  approximately(columns.endX[3], 11);
});

test('only pinned delimited two-character G2/G3 spellings dispatch arcs', () => {
  const source = ['G1 X1 Y0', 'G02 X0 Y1 I-1', 'G2.0 X0 Y1 I-1', 'G2X0Y1I-1', 'g3 X0 Y1 I-1', 'G1 X2'].join('\n');
  const model = parseRichGcodeModel(source);

  assert.equal(model.complete, true);
  assert.equal(model.warnings.length, 0);
  assert.deepEqual(columnValues(model.columns.sourceLine), [1, 5, 6]);
  assert.deepEqual(columnValues(model.columns.pathKind), [
    GCODE_PATH_KIND.DIRECT,
    GCODE_PATH_KIND.ARC_CCW,
    GCODE_PATH_KIND.DIRECT,
  ]);
  approximately(model.columns.startX[1], 1);
  approximately(model.columns.startY[1], 0);
});

test('P1 full-circle helices use exact arc length and bounded Float32 interpolation', () => {
  const source = ['G21', 'M83', 'G1 X5 Y0 Z1', 'G3 X5 Y0 Z3 I-5 J0 P1 E2 F1200', 'G1 X6 E1'].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;
  const arc = 1;

  assert.equal(model.complete, true);
  assert.deepEqual(columnValues(columns.pathKind), [
    GCODE_PATH_KIND.DIRECT,
    GCODE_PATH_KIND.ARC_CCW,
    GCODE_PATH_KIND.DIRECT,
  ]);
  assert.equal(columns.pathPointCount[arc], 44);
  assert.equal(model.pathPoints.count, 44);
  approximately(columns.arcCenterX[arc], 0);
  approximately(columns.arcCenterY[arc], 0);
  approximately(columns.endZ[arc], 3);
  assert.ok(model.pathPoints.z[0] > 1);
  assert.ok(model.pathPoints.z[43] <= 3 + 1e-5);
  const distance = Math.hypot(2 * Math.PI * 5, 2);
  const expectedMm3PerMm = (Math.PI * 0.875 ** 2 * 2) / distance;
  approximately(columns.mm3PerMm[arc], expectedMm3PerMm, 2e-6);
  approximately(columns.volumetricFlowMm3PerSecond[arc], expectedMm3PerMm * 20, 2e-5);
  assert.equal(columns.sourceLine[2], 5, 'the command after the full circle remains available');
});

test('P uses pinned Float32 truncation and rejects multi-turn or mismatched forms', () => {
  const source = [
    'M83',
    'G1 X2 Y0',
    'G3 X2 Y0 I-2 R99 P1.5 E1',
    'G3 X2 Y0 I-2 P2 E1',
    'G3 X0 Y2 I-2 P1 E1',
    'G1 X1 Y2 E1',
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.deepEqual(columnValues(columns.sourceLine), [2, 3, 6]);
  assert.equal(columns.pathKind[1], GCODE_PATH_KIND.ARC_CCW);
  assert.ok(columns.pathPointCount[1] > 0, 'P1.5 truncates to the supported single turn');
  assert.equal(columns.pathPointOffset[2], model.pathPoints.count);
  approximately(columns.startX[2], 0, 1e-6);
  approximately(columns.startY[2], 2, 1e-6);
  approximately(columns.endX[2], 1, 1e-6);
  assert.deepEqual(
    model.warnings.filter((warning) => warning.code === 'invalid-arc-turns').map((warning) => warning.line),
    [4, 5],
  );
});

test('P full-circle length retains the pinned double-PI branch before Float32 storage', () => {
  const implicit = parseRichGcodeModel('M83\nG1 X0.013\nG3 X0.013 I-0.013 E1 F60');
  const explicit = parseRichGcodeModel('M83\nG1 X0.013\nG3 X0.013 I-0.013 P1 E1 F60');
  const radius = Math.fround(0.013);
  const implicitLength = Math.fround(radius * Math.fround(2 * Math.PI));
  const explicitLength = Math.fround(2 * Math.PI * radius);
  const filamentRadius = Math.fround(0.5 * Math.fround(1.75));
  const filamentArea = Math.fround(Math.fround(Math.PI) * Math.fround(filamentRadius * filamentRadius));
  const volume = Math.fround(filamentArea * Math.fround(1));

  assert.notEqual(implicitLength, explicitLength, 'the pinned branches differ by one Float32 ULP');
  assert.equal(implicit.columns.mm3PerMm[1], Math.fround(volume / implicitLength));
  assert.equal(explicit.columns.mm3PerMm[1], Math.fround(volume / explicitLength));
  assert.notEqual(implicit.columns.mm3PerMm[1], explicit.columns.mm3PerMm[1]);
});

test('Float32 parameter normalization pins P equality, exponents, and extrusion underflow', () => {
  const equalEndpoint = parseRichGcodeModel(['M83', 'G1 X0.1 Y0', 'G3 X0.100000001 Y0 I-0.1 P1 E1 F100'].join('\n'));
  assert.equal(equalEndpoint.complete, true);
  assert.equal(equalEndpoint.columns.count, 2);
  assert.equal(equalEndpoint.columns.pathKind[1], GCODE_PATH_KIND.ARC_CCW);
  assert.equal(equalEndpoint.columns.feedrateMmPerSecond[1], Math.fround(Math.fround(100) * Math.fround(1 / 60)));
  assert.ok(!equalEndpoint.warnings.some((warning) => warning.code === 'invalid-arc-turns'));

  const underflow = parseRichGcodeModel(['M83', 'G2 X1 Y0 I0.5 E1e-50'].join('\n'));
  assert.equal(underflow.complete, true);
  assert.equal(underflow.columns.count, 1);
  assert.equal(underflow.columns.pathKind[0], GCODE_PATH_KIND.ARC_CW);
  assert.equal(underflow.columns.kind[0], GCODE_RECORD_KIND.TRAVEL);
  assert.equal(underflow.columns.deltaE[0], 0);
  assert.equal(underflow.columns.mm3PerMm[0], 0);
  assert.equal(underflow.columns.volumetricFlowMm3PerSecond[0], 0);

  const unsignedExponent = parseRichGcodeModel('G1 X1e2');
  assert.equal(unsignedExponent.columns.count, 1);
  assert.equal(unsignedExponent.columns.endX[0], 100);
});

test('arc extrusion metrics and role widths retain pinned Float32 assignment order', () => {
  const arcForRole = (role?: string) =>
    parseRichGcodeModel(['M83', ...(role ? [`;TYPE:${role}`] : []), 'G1 X10', 'G3 X0 Y10 I-10 E1 F100'].join('\n'));

  const inner = arcForRole('Inner wall');
  const innerArc = inner.columns.count - 1;
  assert.equal(inner.columns.mm3PerMm[innerArc], 0.15312500298023224);
  assert.equal(inner.columns.volumetricFlowMm3PerSecond[innerArc], 0.2552083432674408);
  assert.equal(inner.columns.widthMm[innerArc], 0.8085452914237976);
  assert.equal(inner.columns.heightMm[innerArc], Math.fround(0.2));

  const bridge = arcForRole('Bridge');
  const undefinedRole = arcForRole();
  assert.equal(bridge.columns.widthMm[bridge.columns.count - 1], 0.4415481686592102);
  assert.equal(undefinedRole.columns.widthMm[undefinedRole.columns.count - 1], 0.4415481686592102);
});

test('Float32 forced dimensions underflow, retain exact values, and clamp positive overflow like upstream', () => {
  const forced = parseRichGcodeModel(
    ['M83', ';HEIGHT:0.20000001', ';WIDTH:0.45000001', 'G1 X10', 'G3 X0 Y10 I-10 E1'].join('\n'),
  );
  const forcedArc = forced.columns.count - 1;
  assert.equal(forced.columns.heightMm[forcedArc], Math.fround(0.20000001));
  assert.equal(forced.columns.widthMm[forcedArc], Math.fround(0.45000001));

  const underflow = parseRichGcodeModel(
    ['M83', ';HEIGHT:1e-50', ';WIDTH:1e-50', 'G1 X1', 'G2 X0 Y1 I-1 E1'].join('\n'),
  );
  const underflowArc = underflow.columns.count - 1;
  assert.equal(underflow.columns.heightMm[underflowArc], Math.fround(0.2));
  assert.equal(underflow.columns.endZ[underflowArc], Math.fround(0.2));
  assert.equal(underflow.columns.widthMm[underflowArc], 0.8061529994010925);

  const overflowWidth = parseRichGcodeModel(
    ['M83', ';TYPE:Outer wall', ';HEIGHT:1e-45', 'G1 X10', 'G3 X0 Y10 I-10 E1'].join('\n'),
  );
  const overflowArc = overflowWidth.columns.count - 1;
  assert.equal(overflowWidth.columns.heightMm[overflowArc], Math.fround(1e-45));
  assert.equal(overflowWidth.columns.widthMm[overflowArc], 2);
});

test('arc width defaults after positive subnormal underflow and negative-E adaptation stays finite', () => {
  const subnormal = parseRichGcodeModel(['M83', ';TYPE:Outer wall', 'G1 X20', 'G2 X20 I-20 P1 E1e-45'].join('\n'));
  const arc = subnormal.columns.count - 1;
  assert.equal(subnormal.columns.kind[arc], GCODE_RECORD_KIND.EXTRUDE);
  assert.equal(subnormal.columns.deltaE[arc], Math.fround(1e-45));
  assert.equal(subnormal.columns.widthMm[arc], Math.fround(0.4));
  assert.equal(subnormal.columns.mm3PerMm[arc], 0);

  const negative = parseRichGcodeModel('M83\nG1 X1\nG2 X0 Y1 I-1 E-1');
  const negativeArc = negative.columns.count - 1;
  assert.equal(negative.columns.kind[negativeArc], GCODE_RECORD_KIND.EXTRUDE);
  assert.equal(negative.columns.widthMm[negativeArc], Math.fround(0.4));
  assert.ok(Number.isFinite(negative.columns.widthMm[negativeArc]));
});

test('repeated relative helical arcs retain Float32 extruded-Z state', () => {
  const model = parseRichGcodeModel(
    [
      'G91',
      'M83',
      'G1 X1',
      'G2 X0 Y0 Z0.1 I-1 P1 E1',
      'G2 X0 Y0 Z0.1 I-1 P1 E1',
      'G2 X0 Y0 Z0.1 I-1 P1 E1',
      'G2 X0 Y0 Z0.1 I-1 P1 E1',
    ].join('\n'),
  );

  assert.deepEqual(
    columnValues(model.columns.heightMm),
    [0, 0.10000000149011612, 0.10000000149011612, 0.10000000149011612, 0.09999999403953552],
  );
});

test('a zero-Z linear extrusion leaves pinned Float32 modal height for the following arc', () => {
  const model = parseRichGcodeModel(['M83', 'G1 X1 E1', 'G91', 'G2 X0 Y0 Z0.000100001 I-1 P1 E1'].join('\n'));
  const arc = model.columns.count - 1;

  assert.equal(model.columns.endZ[0], Math.fround(0.2));
  assert.equal(model.columns.startZ[arc], Math.fround(0.2));
  assert.equal(model.columns.heightMm[arc], Math.fround(0.000100001));
});

test('inch and relative modes apply to arc endpoints and I/J offsets but not feedrate units', () => {
  const source = ['G20', 'G91', 'M83', 'G1 X1 Z0.1', 'G3 X-1 Y1 I-1 J0 E0.1 F60', 'G1 X1 E0.1'].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.equal(columns.pathKind[1], GCODE_PATH_KIND.ARC_CCW);
  approximately(columns.startX[1], 25.4);
  approximately(columns.endX[1], 0);
  approximately(columns.endY[1], 25.4);
  approximately(columns.arcCenterX[1], 0);
  approximately(columns.arcCenterY[1], 0);
  approximately(columns.deltaE[1], 2.54);
  approximately(columns.feedrateMmPerSecond[1], 1);
  approximately(columns.startX[2], 0);
  approximately(columns.endX[2], 25.4);
  approximately(columns.endY[2], 25.4);
});

test('G92 and M82/M83 preserve arc extrusion state, including pinned negative-E classification', () => {
  const source = [
    'M82',
    'G92 E5',
    'G1 X10 Y0',
    'G3 X0 Y10 I-10 E6',
    'M83',
    ';WIPE_START',
    'G2 X10 Y0 J-10 E-0.5',
    ';WIPE_END',
    'M82',
    'G92 E20',
    'G3 X0 Y10 I-10 E21',
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;
  const arcRows = columnValues(columns.pathKind)
    .map((kind, index) => (kind === GCODE_PATH_KIND.DIRECT ? -1 : index))
    .filter((index) => index >= 0);

  assert.equal(model.complete, true);
  assert.deepEqual(arcRows, [1, 3, 5]);
  approximatelyValues(
    arcRows.map((index) => columns.deltaE[index]),
    [1, -0.5, 1],
  );
  assert.deepEqual(
    arcRows.map((index) => columns.kind[index]),
    [GCODE_RECORD_KIND.EXTRUDE, GCODE_RECORD_KIND.EXTRUDE, GCODE_RECORD_KIND.EXTRUDE],
  );
  assert.equal(columns.kind[3], GCODE_RECORD_KIND.EXTRUDE, 'arc classification ignores active wipe state');
  assert.ok(columns.mm3PerMm[3] < 0);
  assert.ok(columns.widthMm[3] > 0);
});

test('malformed arc forms warn, advance pinned endpoint state, and emit no partial path', () => {
  const source = [
    'M83',
    'G1 X1',
    'G2 X2 E1',
    'G1 X3 E1',
    'G3 X4 I-1 P2 E1',
    'G1 X5 E1',
    'G2 X6 R1 E1',
    'G1 X7 E1',
    'G3 X8 Ibad E1',
    'G1 X9 E1',
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.deepEqual(columnValues(columns.sourceLine), [2, 4, 6, 8, 10]);
  approximatelyValues(columns.startX, [0, 2, 4, 6, 8]);
  approximatelyValues(columns.endX, [1, 3, 5, 7, 9]);
  approximatelyValues(columns.deltaE, [0, 1, 1, 1, 1]);
  assert.equal(model.pathPoints.count, 0);
  assert.deepEqual(columnValues(columns.pathPointOffset), [0, 0, 0, 0, 0]);
  assert.ok(model.warnings.some((warning) => warning.code === 'missing-arc-center' && warning.line === 3));
  assert.ok(model.warnings.some((warning) => warning.code === 'invalid-arc-turns' && warning.line === 5));
  assert.ok(model.warnings.some((warning) => warning.code === 'missing-arc-center' && warning.line === 7));
  assert.ok(model.warnings.some((warning) => warning.code === 'invalid-parameter' && warning.line === 9));
  assert.ok(model.warnings.some((warning) => warning.code === 'missing-arc-center' && warning.line === 9));
});

test('tiny arcs may have zero path points and Float32 rounding pins interpolation count boundaries', () => {
  const boundaryRadius = 3.2848932311832004;
  const source = [
    'M83',
    'G1 X0 Y0 Z0.2',
    'G2 X0 Y0 I0.01 J0 P1 E1',
    `G1 X${boundaryRadius} Y0`,
    `G3 X0 Y${boundaryRadius} I-${boundaryRadius} J0 E1`,
  ].join('\n');
  const model = parseRichGcodeModel(source);
  const columns = model.columns;

  assert.equal(model.complete, true);
  assert.equal(columns.pathKind[1], GCODE_PATH_KIND.ARC_CW);
  assert.equal(columns.pathPointCount[1], 0);
  approximately(columns.arcCenterX[1], 0.01);
  assert.equal(columns.pathPointCount[3], 8, 'pinned float arithmetic must not round this boundary up to 9');
  assert.equal(model.pathPoints.count, 8);
});

test('path-point and numeric caps fail before an arc record or partial sidecar is appended', () => {
  const pathLimited = parseRichGcodeModel(['G1 X10', 'G3 X0 Y10 I-10 J0', 'G1 X20'].join('\n'), {
    limits: { pathPoints: 5 },
  });
  assert.equal(pathLimited.complete, false);
  assert.equal(pathLimited.terminationReason, 'path-point-cap');
  assert.equal(pathLimited.parsedLines, 2);
  assert.equal(pathLimited.columns.count, 1);
  assert.equal(pathLimited.pathPoints.count, 0);
  assert.ok(pathLimited.warnings.some((warning) => warning.code === 'arc-path-point-cap'));

  const remainingLimited = parseRichGcodeModel(['G1 X10', 'G3 X0 Y10 I-10 J0', 'G2 X10 Y0 J-10', 'G1 X20'].join('\n'), {
    limits: { pathPoints: 20 },
  });
  assert.equal(remainingLimited.complete, false);
  assert.equal(remainingLimited.terminationReason, 'path-point-cap');
  assert.equal(remainingLimited.parsedLines, 3);
  assert.equal(remainingLimited.columns.count, 2);
  assert.deepEqual(columnValues(remainingLimited.columns.pathPointCount), [0, 15]);
  assert.equal(remainingLimited.pathPoints.count, 15, 'the rejected second arc appends no partial points');

  const hugeRadius = parseRichGcodeModel(['G1 X1e+18', 'G3 X0 Y1e+18 I-1e+18 J0', 'G1 X1'].join('\n'));
  assert.equal(hugeRadius.complete, false);
  assert.equal(hugeRadius.terminationReason, 'numeric-cap');
  assert.equal(hugeRadius.parsedLines, 2);
  assert.equal(hugeRadius.columns.count, 1);
  assert.equal(hugeRadius.pathPoints.count, 0);
  assert.ok(hugeRadius.warnings.some((warning) => warning.code === 'arc-interpolation-range'));

  const unsafeParameter = parseRichGcodeModel(['G1 X2', 'G3 X2 I-2 P1e39', 'G1 X3'].join('\n'));
  assert.equal(unsafeParameter.complete, false);
  assert.equal(unsafeParameter.terminationReason, 'numeric-cap');
  assert.equal(unsafeParameter.parsedLines, 2);
  assert.equal(unsafeParameter.columns.count, 1);
  assert.equal(unsafeParameter.pathPoints.count, 0);
  assert.ok(unsafeParameter.warnings.some((warning) => warning.code === 'arc-parameter-range'));

  const numberOverflow = parseRichGcodeModel(['G1 X2', 'G2 X1e999 Y5 I1', 'G1 X3'].join('\n'));
  assert.equal(numberOverflow.complete, false);
  assert.equal(numberOverflow.terminationReason, 'numeric-cap');
  assert.equal(numberOverflow.parsedLines, 2);
  assert.equal(numberOverflow.columns.count, 1);
  assert.equal(numberOverflow.pathPoints.count, 0);
  assert.ok(numberOverflow.warnings.some((warning) => warning.code === 'arc-parameter-range'));

  const recordLimited = parseRichGcodeModel(['G1 X1e+9', 'G3 X1e+9 I-1e+9 P1', 'G1 X1'].join('\n'), {
    limits: { records: 1 },
  });
  assert.equal(recordLimited.complete, false);
  assert.equal(recordLimited.terminationReason, 'record-cap');
  assert.equal(recordLimited.parsedLines, 2);
  assert.equal(recordLimited.columns.count, 1);
  assert.equal(recordLimited.pathPoints.count, 0, 'record exhaustion wins before a full-arc sidecar allocation');
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
