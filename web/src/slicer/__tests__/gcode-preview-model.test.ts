import assert from 'node:assert/strict';

import {
  GCODE_PREVIEW_EVENT_COUNT,
  GCODE_PREVIEW_MODES,
  GCODE_PREVIEW_ROLE_COUNT,
  GCODE_PREVIEW_TOOL_COUNT,
  GcodePreviewProjectionError,
  projectGcodePreview,
  type GcodePreviewMode,
} from '../GcodePreviewModel';
import { GCODE_RECORD_KIND, parseRichGcodeModel, type RichGcodeModel } from '../RichGcodeModel';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function approximately(actual: number, expected: number, epsilon = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} within ${epsilon} of ${expected}`);
}

function approximatelyValues(actual: ArrayLike<number>, expected: readonly number[], epsilon = 1e-5): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => approximately(actual[index], value, epsilon));
}

function visibleKinds(...kinds: number[]): Uint8Array {
  const mask = new Uint8Array(GCODE_PREVIEW_EVENT_COUNT);
  for (const kind of kinds) mask[kind] = 1;
  return mask;
}

function allVisible(length: number): Uint8Array {
  const mask = new Uint8Array(length);
  mask.fill(1);
  return mask;
}

function fixture(): RichGcodeModel {
  return parseRichGcodeModel(
    [
      ';TYPE:Outer wall',
      ';HEIGHT:0.2',
      ';WIDTH:0.45',
      ';LAYER_CHANGE',
      'M106 S0',
      'M104 S200',
      'M83',
      'G1 X10 E1 F600',
      'G0 X15 F1200',
      ';LAYER_CHANGE',
      ';TYPE:Support',
      'M106 S255',
      'M104 S220',
      'G1 X25 E1 F1800',
      'T1',
      'M104 S230',
      '; COLOR_CHANGE,T1,#112233',
      ';LAYER_CHANGE',
      ';TYPE:Inner wall',
      'G1 X35 E1 F600',
      'G1 E-0.2',
      '; PAUSE_PRINTING',
      '; WIPE_START',
      'G1 X36 E-0.1',
      '; WIPE_END',
    ].join('\n'),
    { filamentColors: ['#FF0000', '#00FF00'] },
  );
}

test('inventory exactly covers the 12 pinned EViewType values with explicit units and scales', () => {
  assert.deepEqual(
    GCODE_PREVIEW_MODES.map(({ id }) => id),
    [
      'FeatureType',
      'Height',
      'Width',
      'Feedrate',
      'FanSpeed',
      'Temperature',
      'VolumetricRate',
      'Tool',
      'ColorPrint',
      'FilamentId',
      'LayerTime',
      'LayerTimeLog',
    ],
  );
  assert.equal(GCODE_PREVIEW_MODES.find(({ id }) => id === 'Feedrate')?.unit, 'mm/s');
  assert.equal(GCODE_PREVIEW_MODES.find(({ id }) => id === 'VolumetricRate')?.unit, 'mm³/s');
  assert.equal(GCODE_PREVIEW_MODES.find(({ id }) => id === 'LayerTimeLog')?.scale, 'log');
});

test('numeric projections use compact typed columns, pinned ranges, and non-hue legend text', () => {
  const model = fixture();
  const extrusionOnly = visibleKinds(GCODE_RECORD_KIND.EXTRUDE);
  const speed = projectGcodePreview(model, { mode: 'Feedrate', eventVisibility: extrusionOnly });
  assert.equal(speed.status, 'ready');
  if (speed.status !== 'ready') return;

  assert.ok(speed.recordIndices instanceof Uint32Array);
  assert.ok(speed.values instanceof Float32Array);
  assert.ok(speed.valueValid instanceof Uint8Array);
  assert.ok(speed.colorsRgba instanceof Float32Array);
  assert.equal(speed.count, 3);
  approximatelyValues(speed.values, [10, 30, 10]);
  assert.deepEqual(Array.from(speed.valueValid), [1, 1, 1]);
  assert.deepEqual(speed.range, { min: 10, max: 30, unit: 'mm/s', scale: 'linear', sampleCount: 3 });
  assert.equal(speed.legend.length, 10);
  assert.equal(speed.legend[0].label, '30 mm/s');
  assert.match(speed.legend[0].accessibleLabel, /range step 10 of 10/);
  assert.notEqual(speed.legend[0].code, '');
  assert.notEqual(speed.legend[0].pattern, '');
  approximatelyValues(speed.colorsRgba.slice(0, 4), [11 / 255, 44 / 255, 122 / 255, 1]);
  approximatelyValues(speed.colorsRgba.slice(4, 8), [148 / 255, 38 / 255, 22 / 255, 1]);

  const flow = projectGcodePreview(model, { mode: 'VolumetricRate', eventVisibility: extrusionOnly });
  assert.equal(flow.status, 'ready');
  if (flow.status === 'ready') {
    const area = Math.PI * 0.875 ** 2;
    approximatelyValues(flow.values, [area, area * 3, area]);
    assert.equal(flow.range?.unit, 'mm³/s');
  }
});

test('role, tool, event, layer, record, and numeric filters compose without mutating masks', () => {
  const model = fixture();
  const roles = allVisible(GCODE_PREVIEW_ROLE_COUNT);
  const tools = allVisible(GCODE_PREVIEW_TOOL_COUNT);
  const events = visibleKinds(GCODE_RECORD_KIND.EXTRUDE, GCODE_RECORD_KIND.TRAVEL);
  roles[14] = 0;
  tools[1] = 0;
  const roleSnapshot = roles.slice();
  const toolSnapshot = tools.slice();
  const eventSnapshot = events.slice();

  const filtered = projectGcodePreview(model, {
    mode: 'Feedrate',
    roleVisibility: roles,
    toolVisibility: tools,
    eventVisibility: events,
    layerRange: [1, 2],
    recordRange: [1, 8],
    valueRange: [5, 25],
  });
  assert.equal(filtered.status, 'ready');
  if (filtered.status === 'ready') {
    assert.deepEqual(Array.from(filtered.recordIndices), [1, 2]);
    approximatelyValues(filtered.values, [10, 20]);
  }
  assert.deepEqual(roles, roleSnapshot);
  assert.deepEqual(tools, toolSnapshot);
  assert.deepEqual(events, eventSnapshot);
});

test('categorical modes retain official role/tool/filament identity and accessible codes', () => {
  const model = fixture();
  const extrusionOnly = visibleKinds(GCODE_RECORD_KIND.EXTRUDE);
  const feature = projectGcodePreview(model, { mode: 'FeatureType', eventVisibility: extrusionOnly });
  const tool = projectGcodePreview(model, { mode: 'Tool', eventVisibility: extrusionOnly });
  const color = projectGcodePreview(model, { mode: 'ColorPrint', eventVisibility: extrusionOnly });
  const encoded = projectGcodePreview(model, { mode: 'FilamentId', eventVisibility: extrusionOnly });
  assert.equal(feature.status, 'ready');
  assert.equal(tool.status, 'ready');
  assert.equal(color.status, 'ready');
  assert.equal(encoded.status, 'ready');
  if (feature.status !== 'ready' || tool.status !== 'ready' || color.status !== 'ready' || encoded.status !== 'ready') {
    return;
  }

  approximatelyValues(feature.values, [2, 14, 1]);
  assert.deepEqual(
    feature.legend.map(({ label, code }) => ({ label, code })),
    [
      { label: 'Inner wall', code: 'R1' },
      { label: 'Outer wall', code: 'R2' },
      { label: 'Support', code: 'R14' },
    ],
  );
  approximatelyValues(tool.values, [0, 0, 1]);
  assert.deepEqual(
    tool.legend.map(({ code }) => code),
    ['T0', 'T1'],
  );
  approximatelyValues(color.values, [0, 0, 2]);
  assert.deepEqual(
    color.legend.map(({ code }) => code),
    ['F0/T0', 'F2/T1'],
  );
  approximatelyValues(color.colorsRgba.slice(0, 4), [1, 0, 0, 1]);
  approximatelyValues(color.colorsRgba.slice(8, 12), [0x11 / 255, 0x22 / 255, 0x33 / 255, 1]);
  approximatelyValues(encoded.values, [2, 14, 21]);
  approximatelyValues(encoded.colorsRgba.slice(0, 4), [0, 2 / 256, 0, 1]);
  assert.match(encoded.legend[0].accessibleLabel, /physical tool T0 and role R2/);
});

test('layer-time modes require authoritative metadata and distinguish linear from logarithmic color mapping', () => {
  const model = fixture();
  const extrusionOnly = visibleKinds(GCODE_RECORD_KIND.EXTRUDE);
  const missing = projectGcodePreview(model, { mode: 'LayerTimeLog', eventVisibility: extrusionOnly });
  assert.equal(missing.status, 'unsupported');
  if (missing.status === 'unsupported') {
    assert.deepEqual(
      missing.missingMetadata.map(({ key }) => key),
      ['layer-times'],
    );
    assert.match(missing.missingMetadata[0].message, /not substituted/);
  }

  const layerTimes = {
    secondsByLayer: new Float32Array([0, 1, 10, 100]),
    provenance: 'processor-result:fixture',
  };
  const linear = projectGcodePreview(model, { mode: 'LayerTime', eventVisibility: extrusionOnly, layerTimes });
  const logarithmic = projectGcodePreview(model, {
    mode: 'LayerTimeLog',
    eventVisibility: extrusionOnly,
    layerTimes,
  });
  assert.equal(linear.status, 'ready');
  assert.equal(logarithmic.status, 'ready');
  if (linear.status !== 'ready' || logarithmic.status !== 'ready') return;
  approximatelyValues(linear.values, [1, 10, 100]);
  approximatelyValues(logarithmic.values, [1, 10, 100]);
  assert.equal(logarithmic.range?.scale, 'log');
  assert.equal(logarithmic.layerTimeProvenance, layerTimes.provenance);
  assert.notDeepEqual(Array.from(linear.colorsRgba.slice(4, 8)), Array.from(logarithmic.colorsRgba.slice(4, 8)));
  approximatelyValues(logarithmic.colorsRgba.slice(4, 8), [
    (0xaa + 0xfc) / (2 * 255),
    (0xf2 + 0xf9) / (2 * 255),
    (0x00 + 0x03) / (2 * 255),
    1,
  ]);
});

test('missing semantic colors and incomplete parsing are reported instead of guessed', () => {
  const noColor = parseRichGcodeModel('M83\nG1 X10 E1');
  const unsupported = projectGcodePreview(noColor, {
    mode: 'ColorPrint',
    eventVisibility: visibleKinds(GCODE_RECORD_KIND.EXTRUDE),
  });
  assert.equal(unsupported.status, 'unsupported');
  if (unsupported.status === 'unsupported') {
    assert.equal(unsupported.missingMetadata[0].key, 'filament-colors');
    assert.deepEqual(unsupported.missingMetadata[0].indices, [0]);
  }

  const partial = parseRichGcodeModel('M83\nG1 X1 E1\nG2 X2 Y2 I1 J0\nG1 X3 E1');
  const projected = projectGcodePreview(partial, {
    mode: 'FeatureType',
    eventVisibility: visibleKinds(GCODE_RECORD_KIND.EXTRUDE),
  });
  assert.equal(projected.status, 'ready');
  if (projected.status === 'ready') {
    assert.equal(projected.count, 1);
    assert.match(projected.limitations[0].message, /unsupported-arc/);
  }
});

test('validation and caps fail closed, and projections do not retain mutable output state', () => {
  const model = fixture();
  const extrusionOnly = visibleKinds(GCODE_RECORD_KIND.EXTRUDE);
  assert.throws(
    () => projectGcodePreview(model, { mode: 'Feedrate', eventVisibility: new Uint8Array(2) }),
    (error: unknown) => error instanceof GcodePreviewProjectionError && error.code === 'invalid-mask',
  );
  assert.throws(
    () => projectGcodePreview(model, { mode: 'Tool', valueRange: [0, 1] }),
    (error: unknown) => error instanceof GcodePreviewProjectionError && error.code === 'invalid-range',
  );
  assert.throws(
    () =>
      projectGcodePreview(model, {
        mode: 'Feedrate',
        eventVisibility: extrusionOnly,
        maxProjectedRecords: 2,
      }),
    (error: unknown) => error instanceof GcodePreviewProjectionError && error.code === 'projection-cap',
  );

  const malformed: RichGcodeModel = {
    ...model,
    columns: {
      ...model.columns,
      feedrateMmPerSecond: model.columns.feedrateMmPerSecond.slice(),
    },
  };
  malformed.columns.feedrateMmPerSecond[1] = Number.NaN;
  assert.throws(
    () => projectGcodePreview(malformed, { mode: 'Feedrate' }),
    (error: unknown) => error instanceof GcodePreviewProjectionError && error.code === 'invalid-model',
  );

  const first = projectGcodePreview(model, { mode: 'Feedrate', eventVisibility: extrusionOnly });
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') return;
  first.values[0] = 999;
  first.colorsRgba[0] = 999;
  const second = projectGcodePreview(model, { mode: 'Feedrate', eventVisibility: extrusionOnly });
  assert.equal(second.status, 'ready');
  if (second.status === 'ready') {
    assert.equal(second.values[0], 10);
    assert.notEqual(second.colorsRgba[0], 999);
  }
});

test('every official mode returns a deterministic ready projection when its declared metadata is present', () => {
  const model = fixture();
  const layerTimes = {
    secondsByLayer: new Float32Array([0, 1, 10, 100]),
    provenance: 'processor-result:all-modes',
  };
  for (const { id } of GCODE_PREVIEW_MODES) {
    const mode = id as GcodePreviewMode;
    const projection = projectGcodePreview(model, {
      mode,
      ...(mode === 'LayerTime' || mode === 'LayerTimeLog' ? { layerTimes } : {}),
    });
    assert.equal(projection.status, 'ready', mode);
  }
});

console.log(`${passed} G-code preview model tests passed`);
