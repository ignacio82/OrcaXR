import { GCODE_FIELDS, GCODE_LAYOUT } from '../../../../contracts/generated/gcode-layout';
import { GCODE_VIEW_FIELDS, GCODE_VIEW_LAYOUT } from '../../../../contracts/generated/gcode-view-layout';
import {
  validateGcodeMetadata,
  type GcodeIndexMetadata,
  type GcodeIndexEntryMetadata,
  type GcodeSummaryMetadata,
} from '../../../../contracts/generated/gcode-metadata';
import {
  GCODE_RECORD_KIND_NAMES,
  type RichGcodeModel,
  type RichGcodeColumns,
  type RichGcodePathPoints,
} from '../RichGcodeModel';
import { GCODE_PREVIEW_MODES, type GcodePreviewProjection } from '../GcodePreviewModel';
import type { GcodeInspectionState } from '../GcodeInspectionModel';
import { validateGcodePathSidecar } from '../GcodePathSegments';

const MAX_U32 = 0xffffffff;
const decoder = new TextDecoder('utf-8', { fatal: true });
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
type Column = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array;
function check(value: unknown): asserts value {
  if (!value) throw new Error('Invalid shared G-code packet');
}
function text(units: readonly number[]): string {
  let value = '';
  // Do not replace lone surrogates through UTF-8 conversion or spread an entire
  // untrusted string into the JavaScript argument stack.
  for (let i = 0; i < units.length; i += 8192) value += String.fromCharCode(...units.slice(i, i + 8192));
  return value;
}
function json(value: string): unknown {
  check(value.length <= GCODE_LAYOUT.maxMetadataBytes);
  return JSON.parse(value);
}
function messages<T extends { readonly message: readonly number[] }>(values: readonly T[]) {
  return values.map((value) => ({ ...value, message: text(value.message) }));
}
function complete(value: { readonly complete: boolean; readonly terminationReason?: string }) {
  check(value.complete === (value.terminationReason === undefined));
}
function sourceSpans(
  values: readonly { startOffset: number; endOffset: number; line: number }[],
  length: number,
  lines: number,
) {
  for (const value of values)
    check(value.startOffset <= value.endOffset && value.endOffset <= length && value.line <= lines);
}
function recordId(id: number, model: RichGcodeModel): number {
  const local = id - (model.recordOffset ?? 0);
  check(Number.isSafeInteger(local) && local >= 0 && local < model.columns.count);
  return local;
}
function increasing(values: Uint32Array, maximum: number, minimum = 0) {
  let previous = minimum - 1;
  for (const value of values) {
    check(value > previous && value <= maximum);
    previous = value;
  }
}
function inspectable(kind: number) {
  return kind === 1 || kind === 2 || (kind >= 4 && kind <= 10);
}

/** Only complete, ordinary owned buffers cross this boundary. No views into
 * WASM memory, shared memory or resizable backing stores are accepted. */
class Packet {
  readonly data: DataView;
  readonly buffer: ArrayBuffer;
  constructor(
    readonly bytes: Uint8Array,
    minimum: number,
    maximum: number,
    magic: number,
    version: number,
  ) {
    check(littleEndian && bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer);
    check(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength);
    check(!('resizable' in bytes.buffer) || !bytes.buffer.resizable);
    check(bytes.length >= minimum && bytes.length <= maximum);
    this.buffer = bytes.buffer;
    this.data = new DataView(bytes.buffer);
    check(this.word(0) === magic && this.word(4) === version);
  }
  word(offset: number) {
    return this.data.getUint32(offset, true);
  }
  align(offset: number) {
    const end = Math.ceil(offset / 4) * 4;
    check(end <= this.bytes.length);
    for (let i = offset; i < end; i++) check(this.bytes[i] === 0);
    return end;
  }
  metadata(start: number, size: number, maximum: number) {
    check(size >= 2 && size <= maximum && start + size <= this.bytes.length);
    return json(decoder.decode(this.bytes.subarray(start, start + size)));
  }
}

export function decodeGcodeModel(bytes: Uint8Array): RichGcodeModel {
  const packet = new Packet(bytes, 24, GCODE_LAYOUT.maxPacketBytes, 0x5047584f, GCODE_LAYOUT.version);
  const size = packet.word(8),
    records = packet.word(12),
    points = packet.word(16);
  check(
    records <= GCODE_LAYOUT.maxWindowRecords &&
      points <= GCODE_LAYOUT.maxPathPoints &&
      packet.word(20) === bytes.length,
  );
  const metadata = packet.metadata(24, size, GCODE_LAYOUT.maxMetadataBytes);
  validateGcodeMetadata('Model', metadata);
  const groups: Record<string, Record<string, Column | number>> = {
    columns: { count: records },
    pathPoints: { count: points },
  };
  let offset = packet.align(24 + size);
  for (const field of GCODE_FIELDS) {
    const count = field.group === 'columns' ? records : points;
    const end = offset + count * field.bytes;
    check(end <= bytes.length);
    groups[field.group][field.name] = new field.ArrayType(packet.buffer, offset, count);
    offset = packet.align(end);
  }
  check(offset === bytes.length);
  const model: RichGcodeModel = {
    ...metadata,
    roles: metadata.roles.map(text),
    filaments: metadata.filaments.map(({ color, ...filament }) => ({
      ...filament,
      ...(color === undefined ? {} : { color: text(color) }),
    })),
    warnings: messages(metadata.warnings),
    columns: groups.columns as unknown as RichGcodeColumns,
    pathPoints: groups.pathPoints as unknown as RichGcodePathPoints,
  };
  complete(model);
  check((model.recordOffset ?? 0) + records <= MAX_U32 && records <= model.limits.records);
  check(model.parsedCharacters <= model.sourceLength && model.parsedLines <= model.limits.lines);
  const lastLine = (model.sourceLineOffset ?? 0) + model.parsedLines;
  check(
    lastLine <= 16000000 &&
      model.roles.length <= model.limits.roles &&
      model.filaments.length <= model.limits.filaments,
  );
  sourceSpans(metadata.warnings, model.sourceLength, 16000000);
  model.filaments.forEach((filament, i) => check(filament.id === i));
  const c = model.columns;
  for (let i = 0; i < records; i++) {
    check(c.kind[i] < 14 && c.kind[i] !== 3 && c.layer[i] <= model.layerCount);
    check(c.role[i] < model.roles.length && c.tool[i] < 256 && c.filament[i] < model.filaments.length);
    check(c.sourceLine[i] > (model.sourceLineOffset ?? 0) && c.sourceLine[i] <= lastLine);
    check(c.sourceStartOffset[i] <= c.sourceEndOffset[i] && c.sourceEndOffset[i] <= model.sourceLength);
    check(
      Number.isFinite(c.startX[i]) &&
        Number.isFinite(c.startY[i]) &&
        Number.isFinite(c.startZ[i]) &&
        Number.isFinite(c.endX[i]) &&
        Number.isFinite(c.endY[i]) &&
        Number.isFinite(c.endZ[i]),
    );
  }
  validateGcodePathSidecar(model);
  return model;
}

export function decodeGcodeIndex(value: string, sourceLength: number): GcodeIndexMetadata {
  const index = json(value);
  validateGcodeMetadata('Index', index);
  check(index.sourceLength === sourceLength && index.entryCount <= index.sourceLength + 1);
  complete(index);
  sourceSpans(index.warnings, sourceLength, 16000000);
  return index;
}

/** The shared core's statement of a sealed artifact (`summarizeGcodeArtifact`
 * and `describeArtifactSummary`): its tools are the artifact's filaments in
 * order, and each panel line names one of them, in order. */
export function decodeGcodeSummary(value: string): GcodeSummaryMetadata {
  const statement = json(value);
  validateGcodeMetadata('Summary', statement);
  const tools = statement.summary.perTool;
  check(tools.every((tool, index) => tool.toolIndex === index));
  const lines = statement.text.tools;
  check(
    lines.every(
      (line, index) => line.toolIndex < tools.length && (index === 0 || lines[index - 1].toolIndex < line.toolIndex),
    ),
  );
  return statement;
}

export function decodeGcodeIndexPage(value: string, index: GcodeIndexMetadata, previous?: GcodeIndexEntryMetadata) {
  const entries = json(value);
  validateGcodeMetadata('IndexPage', entries);
  for (const entry of entries) {
    check(entry.startOffset <= entry.endOffsetExclusive && entry.endOffsetExclusive <= index.sourceLength);
    check(
      entry.layer <= index.layerCount &&
        entry.recordsBefore <= index.recordCount &&
        entry.pathPointsBefore <= index.pathPointCount,
    );
    if (previous)
      check(
        entry.layer >= previous.layer &&
          entry.startOffset === previous.endOffsetExclusive &&
          entry.recordsBefore >= previous.recordsBefore &&
          entry.pathPointsBefore >= previous.pathPointsBefore,
      );
    else check(entry.startOffset === 0 && entry.recordsBefore === 0 && entry.pathPointsBefore === 0);
    previous = entry;
  }
  return entries;
}

function view(bytes: Uint8Array, expected: 1 | 2 | 3) {
  const packet = new Packet(bytes, 32, GCODE_VIEW_LAYOUT.maxPacketBytes, 0x5647584f, GCODE_VIEW_LAYOUT.version);
  const kind = packet.word(8),
    size = packet.word(12);
  const counts = [packet.word(16), packet.word(20), packet.word(24)];
  check(kind === expected && packet.word(28) === bytes.length);
  check(
    counts[0] <= GCODE_VIEW_LAYOUT.maxRecords &&
      counts[1] <= GCODE_VIEW_LAYOUT.maxLayers &&
      counts[2] <= GCODE_VIEW_LAYOUT.maxTicks,
  );
  check(kind === 2 || (counts[1] === 0 && counts[2] === 0));
  const metadata = packet.metadata(32, size, GCODE_VIEW_LAYOUT.maxMetadataBytes);
  const columns: Record<string, Column> = {};
  let offset = packet.align(32 + size);
  for (const field of GCODE_VIEW_FIELDS[expected]) {
    const count = counts[field.counter] * field.factor;
    const end = offset + count * field.bytes;
    check(end <= bytes.length);
    columns[field.name] = new field.ArrayType(packet.buffer, offset, count);
    offset = packet.align(end);
  }
  check(offset === bytes.length);
  return { metadata, columns, counts };
}

export function decodeGcodePreview(bytes: Uint8Array, model: RichGcodeModel): GcodePreviewProjection {
  const {
    metadata,
    columns: c,
    counts: [count],
  } = view(bytes, 1);
  const status = (metadata as { status?: unknown } | null)?.status;
  if (status === 'unsupported') validateGcodeMetadata('PreviewUnsupported', metadata);
  else validateGcodeMetadata('PreviewReady', metadata);
  // Both guarded variants share the mode/source/limitation contract.
  const p = metadata as
    | import('../../../../contracts/generated/gcode-metadata').GcodePreviewReadyMetadata
    | import('../../../../contracts/generated/gcode-metadata').GcodePreviewUnsupportedMetadata;
  check(p.sourceRecordCount === model.columns.count && p.limitations.length === (model.complete ? 0 : 1));
  const mode = GCODE_PREVIEW_MODES.find((mode) => mode.id === p.mode.id);
  check(mode && Object.entries(mode).every(([key, value]) => value === p.mode[key as keyof typeof mode]));
  const limitations = messages(p.limitations);
  if (p.status === 'unsupported') {
    check(count === 0);
    check(new Set(p.missingMetadata.map((m) => m.key)).size === p.missingMetadata.length);
    for (const missing of p.missingMetadata) {
      const maximum =
        missing.key === 'filament-colors'
          ? model.filaments.length - 1
          : missing.key === 'role-color'
            ? 19
            : model.layerCount;
      let previous = -1;
      for (const index of missing.indices) {
        check(index > previous && index <= maximum);
        previous = index;
      }
    }
    return { ...p, limitations, missingMetadata: messages(p.missingMetadata) };
  }
  check(count <= p.sourceRecordCount);
  const recordIndices = c.recordIndices as Uint32Array;
  increasing(recordIndices, model.columns.count - 1);
  for (let i = 0; i < count; i++) {
    check(c.valueValid[i] <= 1 && Number.isFinite(c.values[i]));
    if (!c.valueValid[i]) check(c.values[i] === 0);
  }
  for (const color of c.colorsRgba) check(Number.isFinite(color) && color >= 0 && color <= 1);
  if (p.range)
    check(
      p.range.min <= p.range.max &&
        p.range.sampleCount <= count &&
        p.range.scale === mode.scale &&
        p.range.unit === mode.unit,
    );
  check(new Set(p.legend.map((entry) => entry.id)).size === p.legend.length);
  const { layerTimeProvenance, ...rest } = p;
  return {
    ...rest,
    limitations,
    count,
    recordIndices,
    values: c.values as Float32Array,
    valueValid: c.valueValid as Uint8Array,
    colorsRgba: c.colorsRgba as Float32Array,
    ...(layerTimeProvenance === undefined ? {} : { layerTimeProvenance: text(layerTimeProvenance) }),
  };
}

export function decodeGcodeInspection(bytes: Uint8Array, model: RichGcodeModel): GcodeInspectionState {
  const {
    metadata: p,
    columns: c,
    counts: [records, layerCount, ticks],
  } = view(bytes, 2);
  validateGcodeMetadata('Inspection', p);
  check(p.sourceRecordCount === model.columns.count && p.limitations.length === (model.complete ? 0 : 1));
  check(
    records <= model.columns.count &&
      layerCount <= model.columns.count &&
      ticks <= records &&
      p.tickLabels.length <= ticks,
  );
  const first = model.recordOffset ?? 0,
    last = first + model.columns.count - 1;
  const recordIndices = c.recordIndices as Uint32Array;
  increasing(recordIndices, last, first);
  increasing(c.layerIds as Uint32Array, model.layerCount);
  increasing(c.tickRecord as Uint32Array, last, first);
  for (const record of recordIndices) check(inspectable(model.columns.kind[recordId(record, model)]));
  for (let i = 0; i < layerCount; i++) {
    const a = recordId(c.layerFirstRecord[i], model),
      b = recordId(c.layerLastRecord[i], model);
    check(
      a <= b &&
        model.columns.layer[a] === c.layerIds[i] &&
        model.columns.layer[b] === c.layerIds[i] &&
        Number.isFinite(c.layerZMm[i]),
    );
    check(inspectable(model.columns.kind[a]) && inspectable(model.columns.kind[b]));
  }
  const selection = p.moveSelection,
    current = p.current;
  check((current !== null) === (selection !== null));
  if (selection)
    check(
      selection.firstOrdinal <= selection.lastOrdinal &&
        selection.lastOrdinal < records &&
        selection.count === selection.lastOrdinal - selection.firstOrdinal + 1 &&
        recordIndices[selection.firstOrdinal] === selection.firstRecord &&
        recordIndices[selection.lastOrdinal] === selection.lastRecord,
    );
  else check(records === 0 && current === null);
  if (current) {
    const i = recordId(current.record, model),
      m = model.columns;
    check(
      selection &&
        current.ordinal >= selection.firstOrdinal &&
        current.ordinal <= selection.lastOrdinal &&
        recordIndices[current.ordinal] === current.record,
    );
    check(
      current.kind === m.kind[i] &&
        current.kindLabel === GCODE_RECORD_KIND_NAMES[current.kind] &&
        current.layer === m.layer[i] &&
        current.tool === m.tool[i] &&
        current.filament === m.filament[i],
    );
    check(
      current.sourceLine === m.sourceLine[i] &&
        current.sourceStartOffset === m.sourceStartOffset[i] &&
        current.sourceEndOffset === m.sourceEndOffset[i],
    );
    check(
      current.positionMm[0] === m.endX[i] && current.positionMm[1] === m.endY[i] && current.positionMm[2] === m.endZ[i],
    );
  }
  if (p.layerSelection) {
    const layers = c.layerIds as Uint32Array,
      selection = p.layerSelection;
    const a = layers.indexOf(selection.firstLayer),
      b = layers.indexOf(selection.lastLayer);
    check(a >= 0 && b >= a && c.layerZMm[a] === selection.firstZMm && c.layerZMm[b] === selection.lastZMm);
    check(!selection.singleLayer || a === b);
    for (const record of recordIndices) {
      const layer = model.columns.layer[recordId(record, model)];
      check(layer >= selection.firstLayer && layer <= selection.lastLayer);
    }
  } else check(records === 0 && ticks === 0);
  if (p.toolMarker)
    check(
      current &&
        p.toolMarker.visible &&
        p.toolMarker.record === current.record &&
        p.toolMarker.tool === current.tool &&
        p.toolMarker.positionMm.every((v, i) => v === current.positionMm[i]),
    );
  if (p.focusBounds)
    check(
      p.focusBounds.minMm.every(
        (v, i) =>
          v <= p.focusBounds!.maxMm[i] &&
          Number.isFinite(Math.fround(v)) &&
          Number.isFinite(Math.fround(p.focusBounds!.maxMm[i])),
      ),
    );
  const eventTicks: GcodeInspectionState['ticks'][number][] = [];
  let selected = 0;
  for (let t = 0; t < ticks; t++) {
    const kind = c.tickKind[t];
    check(kind === 4 || kind === 5 || kind === 6 || kind === 7);
    const record = c.tickRecord[t],
      i = recordId(record, model),
      m = model.columns;
    while (selected < records && recordIndices[selected] < record) selected++;
    check(recordIndices[selected] === record && c.tickLabel[t] < p.tickLabels.length);
    check(
      kind === m.kind[i] &&
        c.tickLayer[t] === m.layer[i] &&
        c.tickZMm[t] === Math.max(m.startZ[i], m.endZ[i]) &&
        c.tickSourceLine[t] === m.sourceLine[i] &&
        c.tickStartOffset[t] === m.sourceStartOffset[i] &&
        c.tickEndOffset[t] === m.sourceEndOffset[i],
    );
    const name = GCODE_VIEW_LAYOUT.tickKinds[kind];
    eventTicks.push({
      id: `${name}:${record}`,
      kind: name,
      label: p.tickLabels[c.tickLabel[t]],
      record,
      layer: c.tickLayer[t],
      zMm: c.tickZMm[t],
      sourceLine: c.tickSourceLine[t],
      sourceStartOffset: c.tickStartOffset[t],
      sourceEndOffset: c.tickEndOffset[t],
    });
  }
  const source = p.sourceWindow;
  if (source) {
    check(
      current &&
        source.currentLine === current.sourceLine &&
        source.firstLine <= source.currentLine &&
        source.lastLine >= source.currentLine,
    );
    check(
      source.currentLine - source.firstLine <= 50 &&
        source.lastLine - source.currentLine <= 50 &&
        source.lines.length === source.lastLine - source.firstLine + 1,
    );
    let before = -1,
      marked = 0;
    source.lines.forEach((line, i) => {
      check(
        line.number === source.firstLine + i &&
          line.startOffset > before &&
          line.startOffset <= line.endOffset &&
          line.endOffset <= model.sourceLength,
      );
      const span = line.endOffset - line.startOffset;
      // Source spans include a trailing CR while display text omits it. At the
      // 4,096-unit boundary this can change whether the display is truncated.
      if (line.truncated) check(span > 4096 && line.text.length === 4096 && line.text.at(-1) === 0x2026);
      else check(span - line.text.length === 0 || span - line.text.length === 1);
      check(line.current === (line.number === source.currentLine));
      if (line.current) marked++;
      before = line.endOffset;
    });
    check(marked === 1);
  }
  const { tickLabels: _labels, ...rest } = p;
  return {
    ...rest,
    recordIndices,
    limitations: messages(p.limitations),
    ticks: eventTicks,
    layers: {
      count: layerCount,
      layerIds: c.layerIds as Uint32Array,
      zMm: c.layerZMm as Float32Array,
      firstRecord: c.layerFirstRecord as Uint32Array,
      lastRecord: c.layerLastRecord as Uint32Array,
    },
    sourceWindow: source
      ? { ...source, lines: source.lines.map((line) => ({ ...line, text: text(line.text) })) }
      : null,
  };
}

export function decodeGcodePlayback(bytes: Uint8Array, model: RichGcodeModel): Uint32Array {
  const { metadata, columns, counts } = view(bytes, 3);
  validateGcodeMetadata('Playback', metadata);
  check(counts[0] <= 100000);
  const records = columns.recordIndices as Uint32Array;
  for (const record of records) check(inspectable(model.columns.kind[recordId(record, model)]));
  return records;
}
