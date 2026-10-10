import assert from 'node:assert/strict';
import {
  checkedGcodeWindow,
  encodeGcodeOptions,
  encodeGcodePreview,
  encodeGcodeInspection,
} from '../core/GcodeRequests';
import { CoreGcodeSource, type GcodeCoreBinding } from '../core/CoreGcodeSource';
import { RICH_GCODE_HARD_CAPS } from '../RichGcodeModel';

const options = JSON.parse(encodeGcodeOptions({ filamentColors: ['#123456', '\ud800🎨'], limits: { records: 12 } }));
assert.deepEqual(options.filamentColors[1], [0xd800, 0xd83c, 0xdfa8]);
assert.equal(options.limits.records, 12);
const durationBits = new Uint32Array([0, 0x80000000, 0x7fc00001, 0x7f800000, 0x3f800000]);
const preview = JSON.parse(
  encodeGcodePreview([], {
    mode: 'LayerTime',
    layerTimes: { secondsByLayer: new Float32Array(durationBits.buffer), provenance: 'stats\udfff' },
    roleVisibility: new Uint8Array(20).fill(1),
    valueRange: [-0, 1.5],
  }),
);
assert.deepEqual(preview.request.layerTimes.secondsByLayerBits, [...durationBits]);
assert.equal(preview.request.layerTimes.provenance.at(-1), 0xdfff);
assert.deepEqual(preview.request.valueRange, [0, 1.5]);
assert.deepEqual(
  JSON.parse(encodeGcodeInspection([1, 2], { recordVisibility: new Uint8Array([1, 0]) }, true, { direction: -1 })),
  {
    version: 1,
    operation: 'playback',
    window: [1, 2],
    request: { recordVisibility: [1, 0] },
    includeSource: true,
    playback: { direction: -1 },
  },
);
for (const invalid of [
  null,
  [],
  { range: { startOffset: 0, endOffsetExclusive: 1 } },
  { resumeFrom: {} },
  { limits: { records: NaN } },
  { limits: { extra: 1 } },
  { limits: { records: 0 } },
  { filamentDiametersMm: [Infinity] },
  { filamentDiametersMm: new Array(257).fill(1.75) },
  { filamentColors: ['x'.repeat(32769)] },
  { filamentColors: ['\uffff'.repeat(12000)] },
  {
    get filamentColors() {
      throw new Error('must not invoke getters');
    },
  },
  Object.assign(Object.create({ limits: { records: 1 } }), {}),
])
  assert.throws(() => encodeGcodeOptions(invalid as any));
for (const invalid of [
  { mode: 'unknown' },
  { mode: 'Tool', extra: true },
  { mode: 'Tool', roleVisibility: new Uint8Array(19) },
  { mode: 'Tool', roleVisibility: new Uint8Array(20).fill(2) },
  { mode: 'Tool', layerRange: [NaN, 1] },
  { mode: 'Tool', layerTimes: { secondsByLayer: new Float32Array(), provenance: 'p'.repeat(257) } },
  { mode: 'Tool', maxProjectedRecords: Infinity },
])
  assert.throws(() => encodeGcodePreview([], invalid as any));
for (const invalid of [
  { gcodeSource: 'substitute' },
  { singleLayer: null },
  { moveRange: [0] },
  { recordVisibility: new Uint8Array(240001) },
  { sourceContextLines: NaN },
])
  assert.throws(() => encodeGcodeInspection([], invalid as any, false));
assert.throws(() => encodeGcodeInspection([], {}, false, { direction: 0 } as any));
assert.throws(() => encodeGcodeInspection([], {}, false, { direction: 1, maxFrames: Infinity }));
const tooLarge = new Float32Array(new Uint32Array(800000).fill(0xffffffff).buffer);
assert.throws(
  () => encodeGcodePreview([], { mode: 'LayerTime', layerTimes: { secondsByLayer: tooLarge, provenance: 'p' } }),
  /byte limit/,
);
const detached = new Float32Array(2);
structuredClone(detached, { transfer: [detached.buffer] });
assert.throws(() =>
  encodeGcodePreview([], { mode: 'LayerTime', layerTimes: { secondsByLayer: detached, provenance: 'p' } }),
);
if (typeof SharedArrayBuffer !== 'undefined')
  assert.throws(() =>
    encodeGcodePreview([], { mode: 'Tool', roleVisibility: new Uint8Array(new SharedArrayBuffer(20)) }),
  );
for (const invalid of [[1], [-1, 1], [2, 1], [0, 3], [0, 0.5], [0, Infinity]])
  assert.throws(() => checkedGcodeWindow(invalid as any, 3));
const selector: [number, number] = [0, 1];
const checked = checkedGcodeWindow(selector, 3);
selector[1] = 2;
assert.deepEqual(checked, [0, 1]);
assert.ok(Object.isFrozen(checked));

let made = 0,
  freed = 0,
  fault = '',
  expected = 0;
const chunks: Uint16Array[] = [];
class Binding implements GcodeCoreBinding {
  constructor(version: number, length: number) {
    assert.equal(version, 1);
    made++;
    expected = length;
  }
  append(offset: number, units: Uint16Array) {
    if (fault === 'append') throw new Error('append failed');
    assert.equal(
      offset,
      chunks.reduce((n, chunk) => n + chunk.length, 0),
    );
    assert.ok(units.length <= 65536);
    chunks.push(units.slice());
  }
  seal() {
    if (fault === 'seal') return '{"sourceLength":0}';
    return JSON.stringify({
      version: 1,
      entryCount: 2,
      layerCount: 0,
      recordCount: 0,
      pathPointCount: 0,
      sourceLength: expected,
      warnings: [],
      complete: true,
      limits: { ...RICH_GCODE_HARD_CAPS, records: 240000 },
    });
  }
  page() {
    if (fault === 'page') return '[]';
    return JSON.stringify([
      { layer: 0, startOffset: 0, endOffsetExclusive: 1, recordsBefore: 0, pathPointsBefore: 0 },
      { layer: 0, startOffset: 1, endOffsetExclusive: expected, recordsBefore: 0, pathPointsBefore: 0 },
    ]);
  }
  summary() {
    if (fault === 'summary') throw 'resource_limit';
    const tools = [
      { toolIndex: 0, lengthMm: 1200, weightG: 3.5, colorHex: '#FF0000', material: 'PLA' },
      { toolIndex: fault === 'summary-order' ? 0 : 1 },
    ];
    return JSON.stringify({
      summary: { perTool: tools, layerCount: 12, empty: false },
      text: { totals: '12 layers', tools: [{ toolIndex: 0, colorHex: '#FF0000', text: 'T0 · PLA · 1.20 m · 3.50 g' }] },
    });
  }
  whole(): Uint8Array {
    throw new Error('unused');
  }
  window(): Uint8Array {
    throw new Error('unused');
  }
  view(): Uint8Array {
    throw new Error('unused');
  }
  free() {
    freed++;
  }
}
// A split surrogate pair and isolated surrogate cross the real chunk boundary.
const source = ';'.repeat(65535) + '🎨\udfff';
const owner = new CoreGcodeSource(Binding, source);
assert.equal(made, 1);
assert.equal(chunks.length, 2);
assert.equal(chunks[0].at(-1), 0xd83c);
assert.deepEqual([...chunks[1]], [0xdfa8, 0xdfff]);
const entries = [...owner.entries()];
assert.equal(entries.length, 2);
assert.equal(entries.at(-1)!.endOffsetExclusive, source.length);
assert.ok(Object.isFrozen(owner.index) && Object.isFrozen(entries[0]));
const iterator = owner.entries();
iterator.next();
owner.dispose();
owner.dispose();
assert.equal(freed, 1);
assert.throws(() => iterator.next(), /closed/);
assert.throws(() => [...owner.entries()], /closed/);
assert.throws(() => owner.openWindow([]), /closed/);
assert.throws(() => new CoreGcodeSource(Binding, 'abc', { range: {} } as any));
assert.equal(made, 1, 'invalid options must not allocate a native owner');
for (const failure of ['append', 'seal']) {
  fault = failure;
  chunks.length = 0;
  assert.throws(() => new CoreGcodeSource(Binding, 'abc'));
  assert.equal(freed, made, 'partial initialization must release its owner');
}
fault = '';
chunks.length = 0;
const badPage = new CoreGcodeSource(Binding, 'abc');
fault = 'page';
assert.throws(() => [...badPage.entries()], /page length/);
badPage.dispose();
assert.equal(freed, made);
// The artifact's statement: validated against the contract, its tools in the
// artifact's order; a refusal past the bound leaves the source usable.
chunks.length = 0;
const stated = new CoreGcodeSource(Binding, 'abc');
const statement = stated.summary();
assert.equal(statement.summary.perTool[0].material, 'PLA');
assert.equal(statement.summary.layerCount, 12);
assert.equal(statement.text.tools[0].text, 'T0 · PLA · 1.20 m · 3.50 g');
fault = 'summary-order';
assert.throws(() => stated.summary(), /Invalid shared G-code packet/);
fault = 'summary';
assert.throws(
  () => stated.summary(),
  (error) => error === 'resource_limit',
);
fault = '';
assert.equal([...stated.entries()].length, 2);
stated.dispose();
assert.equal(freed, made);
console.log('Shared G-code host: bounded requests, Float32/UTF-16 fidelity, chunking, pagination and disposal passed');
