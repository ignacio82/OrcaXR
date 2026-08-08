import assert from 'node:assert/strict';

import {
  GCODE_INSPECTION_HARD_CAPS,
  GcodeInspectionError,
  buildGcodePlaybackSequence,
  inspectGcode,
  stepGcodeInspection,
} from '../GcodeInspectionModel';
import { GCODE_RECORD_KIND, parseRichGcodeModel, type RichGcodeModel } from '../RichGcodeModel';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fixtureSource(): string {
  return [
    'M83',
    ';LAYER_CHANGE',
    'G1 Z0.2 F600',
    'G1 X10 E1',
    ';CUSTOM_GCODE',
    ';LAYER_CHANGE',
    'G1 Z0.4',
    'T1',
    'G1 X20 E1',
    '; COLOR_CHANGE,T1,#112233',
    ';PAUSE_PRINT',
    ';LAYER_CHANGE',
    'G1 Z0.6',
    'G1 X30 E1',
    ';WIPE_START',
    'G1 X31 E-0.1',
    ';WIPE_END',
  ].join('\n');
}

function fixture(): RichGcodeModel {
  return parseRichGcodeModel(fixtureSource(), { filamentColors: ['#FF0000', '#00FF00'] });
}

function assertNumbersClose(actual: readonly number[], expected: readonly number[], epsilon = 1e-6): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `expected ${actual[index]} to be within ${epsilon} of ${expected[index]}`,
    );
  }
}

function assertBoundsClose(
  actual: { readonly minMm: readonly number[]; readonly maxMm: readonly number[] } | null,
  expected: { readonly minMm: readonly number[]; readonly maxMm: readonly number[] },
): void {
  assert.ok(actual);
  assertNumbersClose(actual.minMm, expected.minMm);
  assertNumbersClose(actual.maxMm, expected.maxMm);
}

test('indexes exact record-bearing layers, Z values, record bounds, and accessible dual handles', () => {
  const state = inspectGcode(fixture());
  assert.deepEqual(Array.from(state.layers.layerIds), [1, 2, 3]);
  assertNumbersClose(Array.from(state.layers.zMm), [0.2, 0.4, 0.6]);
  assert.deepEqual(Array.from(state.layers.firstRecord), [1, 5, 11]);
  assert.deepEqual(Array.from(state.layers.lastRecord), [3, 9, 14]);
  assert.deepEqual(Array.from(state.recordIndices), [1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 14]);
  assert.deepEqual(state.layerSelection, {
    firstLayer: 1,
    lastLayer: 3,
    firstZMm: state.layers.zMm[0],
    lastZMm: state.layers.zMm[2],
    singleLayer: false,
    accessibleLabel: 'Layers 1 through 3, Z 0.2 through 0.6 mm',
  });
  assert.equal(state.moveSelection?.count, 11);
  assert.equal(state.current?.record, 14);
  assert.equal(state.current?.kind, GCODE_RECORD_KIND.WIPE);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.layerSelection!));
});

test('reports the height a layer prints at, not the height a Z-hop travel reached', () => {
  // A retraction Z-hop lifts the toolhead above the layer it is printing. The
  // layer's own height is what an operator locates an event by, so a lifted
  // travel must not raise it.
  const hopped = parseRichGcodeModel(
    [
      'M83',
      ';LAYER_CHANGE',
      'G1 Z0.2 F600',
      'G1 X10 E1',
      'G1 Z0.6 F9000',
      'G1 X20',
      'G1 Z0.2 F9000',
      'G1 X25 E1',
      ';LAYER_CHANGE',
      'G1 Z0.4',
      'G1 X30 E1',
    ].join('\n'),
    {},
  );
  const state = inspectGcode(hopped);
  assertNumbersClose(Array.from(state.layers.zMm), [0.2, 0.4]);
  assert.equal(state.layerSelection?.accessibleLabel, 'Layers 1 through 2, Z 0.2 through 0.4 mm');

  // A layer that prints nothing has only its observed height to report.
  const travelOnly = parseRichGcodeModel(['M83', ';LAYER_CHANGE', 'G1 Z0.9 F9000', 'G1 X10'].join('\n'), {});
  assertNumbersClose(Array.from(inspectGcode(travelOnly).layers.zMm), [0.9]);
});

test('layer ranges and pinned one-layer mode select exact source records without renumbering', () => {
  const range = inspectGcode(fixture(), { layerRange: [1, 2] });
  assert.deepEqual(Array.from(range.recordIndices), [1, 2, 3, 5, 6, 7, 8, 9]);
  assert.equal(range.layerSelection?.accessibleLabel, 'Layers 1 through 2, Z 0.2 through 0.4 mm');

  const single = inspectGcode(fixture(), { layerRange: [1, 2], singleLayer: true });
  assert.deepEqual(Array.from(single.recordIndices), [5, 6, 7, 8, 9]);
  assert.equal(single.layerSelection?.firstLayer, 2);
  assert.equal(single.layerSelection?.lastLayer, 2);
  assert.equal(single.layerSelection?.accessibleLabel, 'Layer 2, Z 0.4 mm');

  const defaultSingle = inspectGcode(fixture(), { singleLayer: true });
  assert.deepEqual(Array.from(defaultSingle.recordIndices), [11, 12, 14]);
  assert.equal(defaultSingle.layerSelection?.firstLayer, 3);
  assert.equal(defaultSingle.layerSelection?.lastLayer, 3);

  assert.throws(
    () => inspectGcode(fixture(), { layerRange: [0, 2] }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-layer-range',
  );
  assert.throws(
    () => inspectGcode(fixture(), { layerRange: [3, 1] }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-layer-range',
  );
});

test('visibility and sequential move handles compose while the layer domain stays stable', () => {
  const model = fixture();
  const visibility = new Uint8Array(model.columns.count);
  visibility.fill(1);
  visibility[5] = 0;
  visibility[7] = 0;
  const snapshot = visibility.slice();
  const state = inspectGcode(model, {
    layerRange: [1, 2],
    recordVisibility: visibility,
    moveRange: [1, 3],
    currentRecord: 6,
  });
  assert.deepEqual(Array.from(state.layers.layerIds), [1, 2, 3]);
  assert.deepEqual(Array.from(state.recordIndices), [1, 2, 3, 6, 8, 9]);
  assert.deepEqual(state.moveSelection, {
    firstOrdinal: 1,
    lastOrdinal: 3,
    firstRecord: 2,
    lastRecord: 6,
    count: 3,
    accessibleLabel: 'Moves 2 through 4 of 6',
  });
  assert.equal(state.current?.ordinal, 3);
  assert.equal(state.current?.record, 6);
  assert.deepEqual(visibility, snapshot);

  assert.throws(
    () => inspectGcode(model, { recordVisibility: new Uint8Array(2) }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-visibility',
  );
  const invalidVisibility = new Uint8Array(model.columns.count);
  invalidVisibility[0] = 2;
  assert.throws(
    () => inspectGcode(model, { recordVisibility: invalidVisibility }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-visibility',
  );
  assert.throws(
    () => inspectGcode(model, { moveRange: [2, 99] }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-move-range',
  );
  assert.throws(
    () => inspectGcode(model, { moveRange: [0, 2], currentRecord: 14 }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-current-record',
  );
});

test('custom, pause, tool, and color ticks retain exact layer/Z/source identities', () => {
  const state = inspectGcode(fixture());
  assert.deepEqual(
    state.ticks.map(({ kind, record, layer, label, sourceLine }) => ({ kind, record, layer, label, sourceLine })),
    [
      { kind: 'custom', record: 3, layer: 1, label: 'Custom G-code', sourceLine: 5 },
      { kind: 'tool-change', record: 6, layer: 2, label: 'Tool T1', sourceLine: 8 },
      { kind: 'color-change', record: 8, layer: 2, label: 'Filament F2 on T1', sourceLine: 10 },
      { kind: 'pause', record: 9, layer: 2, label: 'Pause print', sourceLine: 11 },
    ],
  );
  assert.deepEqual(
    state.ticks.map(({ zMm }) => zMm),
    [state.layers.zMm[0], state.layers.zMm[1], state.layers.zMm[1], state.layers.zMm[1]],
  );
  assert.equal(new Set(state.ticks.map(({ id }) => id)).size, state.ticks.length);
});

test('tool marker and bounded G-code window follow the exact current rich record', () => {
  const source = fixtureSource();
  const state = inspectGcode(fixture(), {
    currentRecord: 6,
    showToolMarker: true,
    gcodeSource: source,
    sourceContextLines: 1,
  });
  assert.deepEqual(state.toolMarker, {
    visible: true,
    record: 6,
    tool: 1,
    positionMm: state.current!.positionMm,
    accessibleLabel: 'Tool T1 at 10, 0, 0.4 mm',
  });
  assert.equal(state.current?.sourceLine, 8);
  assert.deepEqual(
    state.sourceWindow?.lines.map(({ number, text, current }) => ({ number, text, current })),
    [
      { number: 7, text: 'G1 Z0.4', current: false },
      { number: 8, text: 'T1', current: true },
      { number: 9, text: 'G1 X20 E1', current: false },
    ],
  );
  assert.equal(
    source.slice(state.current!.sourceStartOffset, state.current!.sourceEndOffset),
    state.sourceWindow?.lines.find(({ current }) => current)?.text,
  );
  assert.throws(
    () => inspectGcode(fixture(), { currentRecord: 6, gcodeSource: `${source}\n` }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-source',
  );
  assert.throws(
    () => inspectGcode(fixture(), { currentRecord: 6, gcodeSource: '' }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-source',
  );
  assert.throws(
    () =>
      inspectGcode(fixture(), {
        currentRecord: 6,
        gcodeSource: source,
        sourceContextLines: GCODE_INSPECTION_HARD_CAPS.sourceContextLines + 1,
      }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-source',
  );

  const longSource = [`;${'x'.repeat(5_000)}`, ';LAYER_CHANGE', 'M83', 'G1 X1 E1'].join('\n');
  const longState = inspectGcode(parseRichGcodeModel(longSource), {
    currentRecord: 1,
    gcodeSource: longSource,
    sourceContextLines: 3,
  });
  const truncated = longState.sourceWindow?.lines[0];
  assert.equal(truncated?.truncated, true);
  assert.equal(truncated?.text.length, GCODE_INSPECTION_HARD_CAPS.sourceLineCharacters);
});

test('step and playback sequences are bounded, directional, wrap-aware, and immutable', () => {
  const state = inspectGcode(fixture(), { moveRange: [0, 4], currentRecord: 3 });
  assert.equal(stepGcodeInspection(state, 1), 5);
  assert.equal(stepGcodeInspection(state, -1), 2);
  assert.deepEqual(Array.from(buildGcodePlaybackSequence(state, { direction: 1 })), [5, 6]);
  assert.deepEqual(Array.from(buildGcodePlaybackSequence(state, { direction: -1, includeCurrent: true })), [3, 2, 1]);
  assert.deepEqual(
    Array.from(buildGcodePlaybackSequence(state, { direction: 1, wrap: true, maxFrames: 10 })),
    [5, 6, 1, 2, 3],
  );
  assert.deepEqual(Array.from(state.recordIndices), [1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 14]);
  assert.throws(
    () => buildGcodePlaybackSequence(state, { direction: 1, maxFrames: GCODE_INSPECTION_HARD_CAPS.playbackFrames + 1 }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-playback',
  );
  assert.throws(
    () => stepGcodeInspection(state, 0 as 1),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-playback',
  );
});

test('focus bounds cover only geometric records inside the selected sequential span', () => {
  const all = inspectGcode(fixture());
  assertBoundsClose(all.focusBounds, { minMm: [0, 0, 0], maxMm: [31, 0, 0.6] });

  const secondLayer = inspectGcode(fixture(), { layerRange: [2, 2], moveRange: [1, 2] });
  assert.deepEqual(Array.from(secondLayer.recordIndices), [5, 6, 7, 8, 9]);
  assertBoundsClose(secondLayer.focusBounds, { minMm: [10, 0, 0.4], maxMm: [20, 0, 0.4] });

  const eventOnly = inspectGcode(fixture(), { layerRange: [2, 2], moveRange: [1, 1] });
  assert.equal(eventOnly.current?.kind, GCODE_RECORD_KIND.TOOL_CHANGE);
  assert.equal(eventOnly.focusBounds, null);
});

test('empty inputs and complete arc suffixes stay explicit while malformed columns fail closed', () => {
  const empty = inspectGcode(parseRichGcodeModel(''));
  assert.equal(empty.layers.count, 0);
  assert.equal(empty.layerSelection, null);
  assert.equal(empty.moveSelection, null);
  assert.equal(empty.current, null);
  assert.equal(empty.focusBounds, null);

  const withArc = parseRichGcodeModel([';LAYER_CHANGE', 'M83', 'G1 X1 E1', 'G2 X2 Y2 I1 J0'].join('\n'));
  const arcState = inspectGcode(withArc);
  assert.deepEqual(Array.from(arcState.recordIndices), [1, 2]);
  assert.deepEqual(arcState.limitations, []);

  const base = fixture();
  const malformed: RichGcodeModel = {
    ...base,
    columns: { ...base.columns, endX: base.columns.endX.slice() },
  };
  malformed.columns.endX[1] = Number.NaN;
  assert.throws(
    () => inspectGcode(malformed),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-model',
  );
  assert.throws(
    () => inspectGcode({ ...base, layerCount: base.columns.count + 1 }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-model',
  );
  assert.throws(
    () => inspectGcode({ ...base, filaments: [] }),
    (error: unknown) => error instanceof GcodeInspectionError && error.code === 'invalid-model',
  );
});

console.log(`\n${passed} G-code inspection-model tests passed.`);
