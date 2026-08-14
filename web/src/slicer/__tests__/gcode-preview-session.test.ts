import assert from 'node:assert/strict';

import { GcodePreviewSession, GCODE_PREVIEW_MOVE_FILTERS } from '../GcodePreviewSession';
import { GCODE_RECORD_KIND, parseRichGcodeModel } from '../RichGcodeModel';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Two layers of one extrusion plus one travel each. */
const FIXTURE = [
  'M104 S210',
  'G21',
  'G90',
  'M83',
  ';LAYER_CHANGE',
  ';Z:0.2',
  'G1 Z0.2 F600',
  ';TYPE:Outer wall',
  'G1 X10 Y10 F1800',
  'G1 X30 Y10 E1.2 F1200',
  'G1 X30 Y30 E1.2',
  ';LAYER_CHANGE',
  ';Z:0.4',
  'G1 Z0.4 F600',
  ';TYPE:Inner wall',
  'G1 X10 Y30 F1800',
  'G1 X10 Y10 E1.2 F900',
  '',
].join('\n');

/** A print of `layers` layers, each with `moves` extrusions. */
function tallPrint(layers: number, moves: number): string {
  const lines = ['M104 S210', 'G21', 'G90', 'M83'];
  for (let layer = 0; layer < layers; layer += 1) {
    lines.push(';LAYER_CHANGE', `;Z:${((layer + 1) * 0.2).toFixed(2)}`, `G1 Z${((layer + 1) * 0.2).toFixed(2)} F600`);
    lines.push(';TYPE:Outer wall');
    for (let move = 0; move < moves; move += 1) {
      lines.push(`G1 X${(10 + move).toFixed(3)} Y${(10 + layer).toFixed(3)} E0.02 F1200`);
    }
  }
  return `${lines.join('\n')}\n`;
}

test('a print too large to hold is read in windows, and every layer stays reachable', () => {
  // The failure this replaces: a parse that stopped partway up and drew the
  // stump as though it were the whole model. A window never claims to be more
  // than it is, and the layers beyond it are one view change away.
  const gcode = tallPrint(60, 40);
  const session = GcodePreviewSession.fromGcode(
    gcode,
    { kind: 'file', name: 'tall.gcode' },
    { limits: { records: 400 } },
  );
  assert.equal(session.streaming, true, 'a print that does not fit is streamed rather than truncated');
  assert.deepEqual(session.layerBounds, [0, 60], 'the whole print stays addressable');
  const [loadedLow, loadedHigh] = session.loadedLayerBounds;
  assert.ok(loadedHigh < 60, 'and only part of it is held at once');
  assert.equal(loadedLow, 0);

  // The last layer — the part an over-budget parse could never show.
  const view = session.updateView({ layerRange: [60, 60], singleLayer: true });
  assert.deepEqual(view.layerRange, [60, 60]);
  const projection = session.project();
  assert.equal(projection.status, 'ready');
  assert.ok(projection.status === 'ready' && projection.count > 0, 'the top of the print draws something');
  assert.deepEqual(session.loadedLayerBounds, [60, 60], 'and only that layer is now held');
});

test('a windowed layer contains exactly the records a whole parse would give it', () => {
  // If resuming missed any machine state, widths, flows, tools, or positions
  // would drift here — plausibly, and therefore dangerously.
  const gcode = tallPrint(12, 25);
  const whole = parseRichGcodeModel(gcode);
  const streamed = GcodePreviewSession.fromGcode(
    gcode,
    { kind: 'file', name: 'tall.gcode' },
    { limits: { records: 120 } },
  );
  assert.equal(streamed.streaming, true);

  for (const layer of [1, 6, 12]) {
    streamed.updateView({ layerRange: [layer, layer], singleLayer: true });
    const windowed = streamed.model.columns;
    const expected: number[] = [];
    for (let record = 0; record < whole.columns.count; record += 1) {
      if (whole.columns.layer[record] === layer) expected.push(record);
    }
    const actual: number[] = [];
    for (let record = 0; record < windowed.count; record += 1) {
      if (windowed.layer[record] === layer) actual.push(record);
    }
    assert.equal(actual.length, expected.length, `layer ${layer} record count`);
    expected.forEach((source, position) => {
      const target = actual[position];
      for (const column of [
        'startX',
        'startY',
        'startZ',
        'endX',
        'endY',
        'endZ',
        'deltaE',
        'widthMm',
        'heightMm',
      ] as const) {
        assert.equal(windowed[column][target], whole.columns[column][source], `layer ${layer} ${column}`);
      }
      assert.equal(windowed.kind[target], whole.columns.kind[source]);
      assert.equal(windowed.tool[target], whole.columns.tool[source]);
      assert.equal(windowed.role[target], whole.columns.role[source]);
      assert.equal(windowed.sourceLine[target], whole.columns.sourceLine[source]);
    });
  }
});

test('a streamed window says which layers it is showing, and that the slice is whole', () => {
  const session = GcodePreviewSession.fromGcode(
    tallPrint(60, 40),
    { kind: 'file', name: 'tall.gcode' },
    { limits: { records: 400 } },
  );
  const notice = session.windowNotice();
  assert.ok(notice, 'a partial window must announce itself');
  assert.match(notice, /Showing layers \d+–\d+ of 60/, 'naming what is drawn and what exists');
  assert.match(notice, /sliced G-code is complete/, 'so a window is never read as a failed slice');
});

test('a print that fits is read whole and says nothing', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'file', name: 'fixture.gcode' });
  assert.equal(session.streaming, false);
  assert.equal(session.windowNotice(), undefined);
  assert.deepEqual(session.loadedLayerBounds, session.layerBounds);
});

test('parses a source and starts on the complete layer window', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'file', name: 'fixture.gcode' });
  const view = session.getView();
  assert.equal(view.mode, 'FeatureType');
  assert.deepEqual(view.layerRange, session.layerBounds);
  assert.equal(view.singleLayer, false);
  assert.equal(view.moveVisibility.extrude, true);
  assert.equal(view.moveVisibility.travel, false, 'travel starts hidden like the reference viewer');
  assert.equal(session.source.name, 'fixture.gcode');
});

test('projects only the visible move classes', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'slice', name: 'plate.gcode' });
  const extrusionsOnly = session.project();
  assert.equal(extrusionsOnly.status, 'ready');
  if (extrusionsOnly.status !== 'ready') return;
  const kinds = new Set([...extrusionsOnly.recordIndices].map((record) => session.model.columns.kind[record]));
  assert.ok(!kinds.has(GCODE_RECORD_KIND.TRAVEL), 'hidden travel never reaches the projection');

  session.updateView({ moveVisibility: { travel: true } });
  const withTravel = session.project();
  assert.equal(withTravel.status, 'ready');
  if (withTravel.status !== 'ready') return;
  assert.ok(withTravel.count > extrusionsOnly.count, 'showing travel adds records');
});

test('clamps the layer window and collapses it in single-layer mode', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'slice', name: 'plate.gcode' });
  const [minLayer, maxLayer] = session.layerBounds;
  const clamped = session.updateView({ layerRange: [-50, maxLayer + 50] });
  assert.deepEqual(clamped.layerRange, [minLayer, maxLayer]);

  const reversed = session.updateView({ layerRange: [maxLayer, minLayer] });
  assert.deepEqual(reversed.layerRange, [minLayer, maxLayer], 'a reversed range is normalised');

  const single = session.updateView({ singleLayer: true });
  assert.deepEqual(single.layerRange, [maxLayer, maxLayer]);
  const inspection = session.inspect();
  assert.equal(inspection.layerSelection?.singleLayer, true);
  assert.equal(inspection.layerSelection?.firstLayer, inspection.layerSelection?.lastLayer);
  assert.ok((inspection.layerSelection?.accessibleLabel ?? '').length > 0, 'the slider announces its value');
});

test('exposes every pinned mode and rejects an unknown one', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'file', name: 'fixture.gcode' });
  const speed = session.updateView({ mode: 'Feedrate' });
  assert.equal(speed.mode, 'Feedrate');
  const projection = session.project();
  assert.equal(projection.mode.unit, 'mm/s');
  if (projection.status === 'ready') {
    assert.ok(projection.range && projection.range.max >= projection.range.min);
    assert.ok(projection.legend.every((entry) => entry.code.length > 0 && entry.accessibleLabel.length > 0));
  }
  assert.throws(() => session.updateView({ mode: 'NotAMode' as never }), /Unknown preview mode/);
});

test('reports an unsupported mode instead of inventing metadata', () => {
  const session = GcodePreviewSession.fromGcode(FIXTURE, { kind: 'file', name: 'fixture.gcode' });
  session.updateView({ mode: 'ColorPrint' });
  const projection = session.project();
  assert.equal(projection.status, 'unsupported', 'colour-print needs exact filament colours');
  if (projection.status === 'unsupported') {
    assert.ok(projection.missingMetadata.some((entry) => entry.key === 'filament-colors'));
  }
});

test('publishes the move filters a viewer surface renders', () => {
  assert.deepEqual(
    GCODE_PREVIEW_MOVE_FILTERS.map((filter) => filter.id),
    ['extrude', 'travel', 'wipe', 'retract', 'unretract'],
  );
});

console.log(`\nG-code preview session: ${passed} tests passed.`);
