import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GCODE_FIELDS, GCODE_LAYOUT } from '../../../../contracts/generated/gcode-layout';
import { validateGcodeMetadata } from '../../../../contracts/generated/gcode-metadata';
import { decodeGcodeModel, decodeGcodeIndex, decodeGcodeIndexPage } from '../core/GcodePackets';
import { hasPackedGcodeOwnership } from '../core/GcodeBufferOwnership';

const corpus = JSON.parse(
  readFileSync(new URL('../../../../testdata/cross-platform/gcode-vectors.json', import.meta.url), 'utf8'),
);
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
function snapshot(value: any): any {
  if (value instanceof Float32Array)
    return { $f32: Array.from(new Uint32Array(value.buffer, value.byteOffset, value.length)) };
  if (ArrayBuffer.isView(value)) return Array.from(value as any);
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'roles' && Array.isArray(v)
          ? (v as string[]).map(units)
          : ['message', 'color'].includes(k) && typeof v === 'string'
            ? units(v)
            : snapshot(v),
      ]),
    );
  return value;
}
/** Independent test producer from the TypeScript reference model, using the
 * published layout. Actual Rust-produced packets are additionally replayed in
 * the browser qualification harness. */
function encode(model: any, update: (metadata: any) => void = () => {}) {
  const { columns, pathPoints, ...metadata } = structuredClone(model);
  update(metadata);
  const text = new TextEncoder().encode(JSON.stringify(metadata));
  let offset = Math.ceil((24 + text.length) / 4) * 4;
  const offsets = new Map<string, number>();
  for (const field of GCODE_FIELDS) {
    offsets.set(field.group + '.' + field.name, offset);
    offset = Math.ceil((offset + (field.group === 'columns' ? columns.count : pathPoints.count) * field.bytes) / 4) * 4;
  }
  const bytes = new Uint8Array(offset),
    data = new DataView(bytes.buffer);
  [0x5047584f, 1, text.length, columns.count, pathPoints.count, bytes.length].forEach((v, i) =>
    data.setUint32(i * 4, v, true),
  );
  bytes.set(text, 24);
  for (const field of GCODE_FIELDS) {
    const values = (field.group === 'columns' ? columns : pathPoints)[field.name];
    const column = field.type === 'f32' ? values.$f32 : values;
    const start = offsets.get(field.group + '.' + field.name)!;
    for (let i = 0; i < column.length; i++) {
      if (field.bytes === 1) data.setUint8(start + i, column[i]);
      else if (field.bytes === 2) data.setUint16(start + i * 2, column[i], true);
      else data.setUint32(start + i * 4, column[i], true);
    }
  }
  return { bytes, data, offsets };
}

let models = 0;
for (const vector of corpus.vectors) {
  const { entries, ...rest } = vector.binding.index;
  const info = decodeGcodeIndex(
    JSON.stringify({ ...rest, version: 1, entryCount: entries.length }),
    vector.sourceUnits.length,
  );
  const page = entries.map(({ checkpoint: _checkpoint, ...entry }: any) => entry);
  assert.deepEqual(decodeGcodeIndexPage(JSON.stringify(page), info), page);
  for (const expected of [vector.binding.model, ...vector.binding.windows]) {
    const { bytes } = encode(expected);
    const model = decodeGcodeModel(bytes);
    assert.equal(hasPackedGcodeOwnership(model), true);
    assert.deepEqual(snapshot(model), expected, vector.id);
    assert.equal(model.columns.endX.buffer, bytes.buffer, 'columns must share the one owned transfer buffer');
    const transferred = structuredClone(model, { transfer: [bytes.buffer] });
    assert.equal(bytes.byteLength, 0);
    assert.equal(hasPackedGcodeOwnership(model), false, 'transferred owner is detached');
    assert.equal(hasPackedGcodeOwnership(transferred), true);
    assert.deepEqual(snapshot(transferred), expected);
    assert.throws(() => decodeGcodeModel(bytes));
    models++;
  }
}

const fixture = corpus.vectors.find((v: any) => v.binding.model.columns.count > 3).binding.model;
for (const mutate of [
  (m: any) => {
    m.columns.endX = m.columns.endX.slice();
  },
  (m: any) => {
    m.columns.endX = new Float32Array(m.columns.endX.buffer, m.columns.endX.byteOffset + 4, m.columns.count);
  },
  (m: any) => {
    m.pathPoints.count++;
  },
  (m: any) => {
    new DataView(m.columns.kind.buffer).setUint32(4, 99, true);
  },
  (m: any) => {
    new DataView(m.columns.kind.buffer).setUint32(20, 1, true);
  },
]) {
  const model = decodeGcodeModel(encode(fixture).bytes);
  mutate(model);
  assert.equal(hasPackedGcodeOwnership(model), false, 'reject excess, substituted and mismatched column ownership');
}
for (const [offset, bad] of [
  [0, 0],
  [4, 99],
  [8, 0],
  [8, GCODE_LAYOUT.maxMetadataBytes + 1],
  [12, 240001],
  [16, 8000001],
  [20, 1],
]) {
  const { bytes, data } = encode(fixture);
  data.setUint32(offset, bad, true);
  assert.throws(() => decodeGcodeModel(bytes), `header ${offset}`);
}
for (const change of [
  (m: any) => {
    m.extra = true;
  },
  (m: any) => {
    delete m.sourceLength;
  },
  (m: any) => {
    m.roles[0] = [65536];
  },
  (m: any) => {
    m.filaments[0].id = 20;
  },
  (m: any) => {
    m.parsedCharacters = m.sourceLength + 1;
  },
  (m: any) => {
    m.sourceLineOffset = 16000000;
  },
  (m: any) => {
    m.limits.pathPoints = 0;
  },
  (m: any) => {
    m.terminationReason = 'numeric-cap';
    m.complete = true;
  },
  (m: any) => {
    m.roles[0] = Array(65537).fill(1);
  },
])
  assert.throws(() => decodeGcodeModel(encode(fixture, change).bytes));
for (const [field, bits, size] of [
  ['kind', 3, 1],
  ['tool', 256, 2],
  ['filament', 65535, 2],
  ['sourceLine', 0, 4],
  ['sourceEndOffset', 0xffffffff, 4],
  ['endX', 0x7f800000, 4],
  ['pathPointOffset', 1, 4],
] as const) {
  const { bytes, data, offsets } = encode(fixture);
  const offset = offsets.get('columns.' + field)!;
  if (size === 1) data.setUint8(offset, bits);
  else if (size === 2) data.setUint16(offset, bits, true);
  else data.setUint32(offset, bits, true);
  assert.throws(() => decodeGcodeModel(bytes), field);
}
const badText = encode(fixture).bytes;
badText[24] = 0xff;
assert.throws(() => decodeGcodeModel(badText));
const good = encode(fixture).bytes;
const backing = new Uint8Array(good.length + 4);
backing.set(good);
assert.throws(() => decodeGcodeModel(backing.subarray(0, good.length)), 'reject excess backing allocation');
const shared = new Uint8Array(new SharedArrayBuffer(good.length));
shared.set(good);
assert.throws(() => decodeGcodeModel(shared), 'reject mutable shared memory');
assert.throws(
  () => validateGcodeMetadata('Limits', Object.create(fixture.limits)),
  'required properties must be owned',
);
assert.throws(() => validateGcodeMetadata('Playback', { unexpected: 0 }));
assert.throws(() =>
  validateGcodeMetadata('SourceLine', {
    number: 0,
    startOffset: 0,
    endOffset: 0,
    text: [],
    current: false,
    truncated: false,
  }),
);
console.log(
  `G-code packet boundary: ${models} reference models/windows, ownership transfers and malformed header/metadata/column cases passed.`,
);
