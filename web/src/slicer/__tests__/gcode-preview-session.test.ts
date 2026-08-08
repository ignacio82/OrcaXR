import assert from 'node:assert/strict';

import { GcodePreviewSession, GCODE_PREVIEW_MOVE_FILTERS } from '../GcodePreviewSession';
import { GCODE_RECORD_KIND } from '../RichGcodeModel';

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
