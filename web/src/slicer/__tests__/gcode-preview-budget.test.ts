import assert from 'node:assert/strict';
import { GcodePreviewSession } from '../GcodePreviewSession';
import { parseRichGcodeModel } from '../RichGcodeModel';
import { inspectGcode } from '../GcodeInspectionModel';
const lines = ['G90', 'M83', 'M104 S205', ';TYPE:Outer wall'];
for (let layer = 1; layer <= 3; layer++) {
  lines.push(';LAYER_CHANGE', `G1 Z${layer * 0.2} F1200`);
  for (let i = 0; i < 87; i++) {
    if (i === 43) lines.push(`T${layer % 2}`, ';COLOR_CHANGE,T1,#0088ff', ';PAUSE_PRINT');
    lines.push(`G1 X${1 + (i % 2)} E0.02`);
  }
}
const gcode = lines.join('\n') + '\n';
const whole = parseRichGcodeModel(gcode);
const session = GcodePreviewSession.fromGcode(
  gcode,
  { kind: 'file', name: 'large-layer.gcode' },
  { limits: { records: 32 } },
);
let visited = 0;
let windows = 0;
do {
  const model = session.model;
  assert.ok(model.columns.count <= 32);
  assert.equal(model.complete, true);
  assert.equal(model.recordOffset, visited, 'windows must cover original records without gaps or renumbering');
  for (let record = 0; record < model.columns.count; record++) {
    for (const key of Object.keys(model.columns)) {
      if (key === 'count' || key === 'pathPointOffset') continue;
      const actual = model.columns[key as keyof typeof model.columns] as ArrayLike<number>;
      const expected = whole.columns[key as keyof typeof whole.columns] as ArrayLike<number>;
      assert.equal(actual[record], expected[visited + record], `${key} at source record ${visited + record}`);
    }
  }
  if (model.columns.count > 2) {
    const projection = session.project({ recordRange: [visited + 1, visited + model.columns.count - 1] });
    if (projection.status === 'ready')
      assert.ok([...projection.recordIndices].every((record) => record >= 1 && record < model.columns.count));
  }
  const inspection = session.inspect();
  if (inspection.current) {
    assert.ok(inspection.current.record >= visited);
    const exact = inspectGcode(model, { currentRecord: inspection.current.record });
    assert.deepEqual(exact.current, inspection.current);
  }
  for (const tick of inspection.ticks) assert.equal(tick.id, `${tick.kind}:${tick.record}`);
  visited += model.columns.count;
  windows++;
  assert.ok(windows < 30, 'pagination must advance');
  if (!session.windowState?.hasNext) break;
  session.updateView({ windowStep: 1 });
} while (visited < whole.columns.count);
assert.equal(visited, whole.columns.count, 'all moves in oversized layers remain reachable');
while (session.windowState?.hasPrevious) session.updateView({ windowStep: -1 });
assert.equal(session.model.recordOffset, 0);
const prefix = GcodePreviewSession.fromGcode(
  gcode,
  { kind: 'file', name: 'prefix.gcode' },
  { limits: { inputCharacters: 240, records: 32 } },
);
assert.match(prefix.windowNotice() ?? '', /Only a prefix was indexed \(input-cap\)/);
assert.doesNotMatch(prefix.windowNotice() ?? '', /fully indexed|G-code is complete/);
assert.equal(prefix.model.complete, false);
console.log(
  `Oversized-layer record parity, global inspection IDs, ${windows} bounded windows, reverse paging and incomplete input passed.`,
);

const arcs = 'G90\nM83\n;LAYER_CHANGE\nG1 X10 Y0 F1200\n' + 'G3 X10 Y0 I-10 J0 E1\n'.repeat(8);
const allArcs = parseRichGcodeModel(arcs);
const arcPoints = allArcs.columns.pathPointCount[2];
const arcSession = GcodePreviewSession.fromGcode(
  arcs,
  { kind: 'file', name: 'arcs.gcode' },
  { limits: { records: 32, pathPoints: arcPoints * 2 } },
);
let arcRecords = 0;
do {
  assert.equal(arcSession.model.complete, true, 'path points require index checkpoints too, without partial arcs');
  assert.ok(arcSession.model.pathPoints.count <= arcPoints * 2);
  const window = arcSession.model;
  for (let record = 0; record < window.columns.count; record++) {
    const globalRecord = arcRecords + record;
    const actualStart = window.columns.pathPointOffset[record];
    const expectedStart = allArcs.columns.pathPointOffset[globalRecord];
    const count = window.columns.pathPointCount[record];
    assert.equal(count, allArcs.columns.pathPointCount[globalRecord]);
    for (const axis of ['x', 'y', 'z'] as const)
      assert.deepEqual(
        window.pathPoints[axis].slice(actualStart, actualStart + count),
        allArcs.pathPoints[axis].slice(expectedStart, expectedStart + count),
      );
  }
  arcRecords += arcSession.model.columns.count;
  if (!arcSession.windowState?.hasNext) break;
  arcSession.updateView({ windowStep: 1 });
} while (arcRecords < allArcs.columns.count);
assert.equal(arcRecords, allArcs.columns.count);

// Fixed CI fixture: instrument constructor growth as well as initial allocation.
const largeSource =
  'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2 F1200\n;TYPE:Outer wall\n' + 'G1 X1 E0.02\nG1 X2 E0.02\n'.repeat(150_000);
const originalFloat = globalThis.Float32Array;
const descriptor = Object.getOwnPropertyDescriptor(originalFloat.prototype, 'constructor')!;
let maximumAllocation = 0;
const measuredFloat = new Proxy(originalFloat, {
  construct(target, args, newTarget) {
    if (typeof args[0] === 'number') maximumAllocation = Math.max(maximumAllocation, args[0]);
    return Reflect.construct(target, args, newTarget);
  },
});
const started = performance.now();
try {
  globalThis.Float32Array = measuredFloat;
  Object.defineProperty(originalFloat.prototype, 'constructor', { ...descriptor, value: measuredFloat });
  const largeSession = GcodePreviewSession.fromGcode(largeSource, {
    kind: 'file',
    name: 'generated-large-layer.gcode',
  });
  assert.equal(largeSession.model.columns.count, 240_000);
  assert.ok(maximumAllocation <= 240_000, 'no abandoned whole-file rich column allocation');
  largeSession.updateView({ windowStep: 1 });
  assert.equal(largeSession.model.recordOffset, 240_000);
  assert.equal(largeSession.model.columns.count, 60_002);
  const offset = largeSession.model.recordOffset;
  largeSession.updateView({ mode: 'Feedrate' });
  assert.equal(largeSession.model.recordOffset, offset, 'changing colour mode preserves the chosen record window');
} finally {
  globalThis.Float32Array = originalFloat;
  Object.defineProperty(originalFloat.prototype, 'constructor', descriptor);
}
console.log(
  JSON.stringify({
    fixture: '300002-record-single-layer',
    maximumAllocation,
    openAndPageMs: +(performance.now() - started).toFixed(2),
  }),
);
