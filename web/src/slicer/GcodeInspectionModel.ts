import {
  GCODE_RECORD_KIND,
  GCODE_RECORD_KIND_NAMES,
  RICH_GCODE_HARD_CAPS,
  type GcodeRecordKind,
  type RichGcodeModel,
} from './RichGcodeModel';
import { validateGcodePathSidecar, visitGcodeRecordPathSegments } from './GcodePathSegments';

export const GCODE_INSPECTION_HARD_CAPS = Object.freeze({
  ticks: 100_000,
  sourceContextLines: 50,
  sourceLineCharacters: 4_096,
  playbackFrames: 100_000,
});

export interface GcodeInspectionRequest {
  /** Inclusive rich layer IDs. Defaults to the complete record-bearing domain. */
  readonly layerRange?: readonly [number, number];
  /** Pinned one-layer mode collapses both handles to the upper layer. */
  readonly singleLayer?: boolean;
  /** One byte per rich record. Zero records are skipped by sequential inspection. */
  readonly recordVisibility?: Uint8Array;
  /** Inclusive ordinals within the filtered selected-layer record list. */
  readonly moveRange?: readonly [number, number];
  /** Exact rich record index selected by a prior inspection state. */
  readonly currentRecord?: number;
  readonly showToolMarker?: boolean;
  /** Optional exact source. Only a bounded window around the cursor is retained. */
  readonly gcodeSource?: string;
  readonly sourceContextLines?: number;
}

export interface GcodeInspectionLayerIndex {
  readonly count: number;
  readonly layerIds: Uint32Array;
  readonly zMm: Float32Array;
  readonly firstRecord: Uint32Array;
  readonly lastRecord: Uint32Array;
}

export interface GcodeInspectionLayerSelection {
  readonly firstLayer: number;
  readonly lastLayer: number;
  readonly firstZMm: number;
  readonly lastZMm: number;
  readonly singleLayer: boolean;
  readonly accessibleLabel: string;
}

export interface GcodeInspectionMoveSelection {
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly firstRecord: number;
  readonly lastRecord: number;
  readonly count: number;
  readonly accessibleLabel: string;
}

export interface GcodeInspectionCursor {
  readonly ordinal: number;
  readonly record: number;
  readonly kind: GcodeRecordKind;
  readonly kindLabel: string;
  readonly layer: number;
  readonly zMm: number;
  readonly tool: number;
  readonly filament: number;
  readonly sourceLine: number;
  readonly sourceStartOffset: number;
  readonly sourceEndOffset: number;
  readonly positionMm: readonly [number, number, number];
  readonly accessibleLabel: string;
}

export interface GcodeInspectionTick {
  readonly id: string;
  readonly kind: 'tool-change' | 'color-change' | 'pause' | 'custom';
  readonly label: string;
  readonly record: number;
  readonly layer: number;
  readonly zMm: number;
  readonly sourceLine: number;
  readonly sourceStartOffset: number;
  readonly sourceEndOffset: number;
}

export interface GcodeInspectionToolMarker {
  readonly visible: boolean;
  readonly record: number;
  readonly tool: number;
  readonly positionMm: readonly [number, number, number];
  readonly accessibleLabel: string;
}

export interface GcodeInspectionSourceLine {
  readonly number: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly current: boolean;
  readonly truncated: boolean;
}

export interface GcodeInspectionSourceWindow {
  readonly currentLine: number;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly lines: readonly GcodeInspectionSourceLine[];
}

export interface GcodeInspectionBounds {
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
}

export interface GcodeInspectionLimitation {
  readonly code: 'source-incomplete';
  readonly message: string;
}

export interface GcodeInspectionState {
  readonly sourceRecordCount: number;
  readonly layers: GcodeInspectionLayerIndex;
  readonly layerSelection: GcodeInspectionLayerSelection | null;
  /** Filtered rich record indices in source/sequential order. */
  readonly recordIndices: Uint32Array;
  readonly moveSelection: GcodeInspectionMoveSelection | null;
  readonly current: GcodeInspectionCursor | null;
  readonly ticks: readonly GcodeInspectionTick[];
  readonly toolMarker: GcodeInspectionToolMarker | null;
  readonly sourceWindow: GcodeInspectionSourceWindow | null;
  readonly focusBounds: GcodeInspectionBounds | null;
  readonly limitations: readonly GcodeInspectionLimitation[];
}

export type GcodeInspectionErrorCode =
  | 'invalid-model'
  | 'invalid-layer-range'
  | 'invalid-visibility'
  | 'invalid-move-range'
  | 'invalid-current-record'
  | 'invalid-source'
  | 'invalid-playback';

export class GcodeInspectionError extends Error {
  readonly name = 'GcodeInspectionError';

  constructor(
    readonly code: GcodeInspectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GcodePlaybackOptions {
  readonly direction: -1 | 1;
  readonly wrap?: boolean;
  readonly includeCurrent?: boolean;
  readonly maxFrames?: number;
}

const INSPECTABLE_KIND = new Uint8Array(GCODE_RECORD_KIND_NAMES.length);
for (const kind of [
  GCODE_RECORD_KIND.RETRACT,
  GCODE_RECORD_KIND.UNRETRACT,
  GCODE_RECORD_KIND.TOOL_CHANGE,
  GCODE_RECORD_KIND.COLOR_CHANGE,
  GCODE_RECORD_KIND.PAUSE,
  GCODE_RECORD_KIND.CUSTOM,
  GCODE_RECORD_KIND.TRAVEL,
  GCODE_RECORD_KIND.WIPE,
  GCODE_RECORD_KIND.EXTRUDE,
]) {
  INSPECTABLE_KIND[kind] = 1;
}

const GEOMETRIC_KIND = new Uint8Array(GCODE_RECORD_KIND_NAMES.length);
GEOMETRIC_KIND[GCODE_RECORD_KIND.RETRACT] = 1;
GEOMETRIC_KIND[GCODE_RECORD_KIND.UNRETRACT] = 1;
GEOMETRIC_KIND[GCODE_RECORD_KIND.TRAVEL] = 1;
GEOMETRIC_KIND[GCODE_RECORD_KIND.WIPE] = 1;
GEOMETRIC_KIND[GCODE_RECORD_KIND.EXTRUDE] = 1;

/** Build exact layer/move/tick/source inspection state without retaining G-code text. */
export function inspectGcode(model: RichGcodeModel, request: GcodeInspectionRequest = {}): GcodeInspectionState {
  validateModel(model);
  const visibility = validateVisibility(request.recordVisibility, model.columns.count);
  const layers = buildLayerIndex(model);
  const layerSelection = selectLayers(layers, request.layerRange, request.singleLayer ?? false);
  const recordIndices = selectRecords(model, visibility, layerSelection);
  const moveSelection = selectMoveRange(recordIndices, request.moveRange);
  const current = selectCurrent(model, layers, recordIndices, moveSelection, request.currentRecord);
  const ticks = buildTicks(model, visibility, layerSelection);
  const toolMarker =
    request.showToolMarker && current
      ? Object.freeze({
          visible: true,
          record: current.record,
          tool: current.tool,
          positionMm: current.positionMm,
          accessibleLabel: `Tool T${current.tool} at ${formatMm(current.positionMm[0])}, ${formatMm(current.positionMm[1])}, ${formatMm(current.positionMm[2])} mm`,
        })
      : null;
  const sourceWindow =
    request.gcodeSource !== undefined
      ? buildSourceWindow(model, current, request.gcodeSource, request.sourceContextLines)
      : null;
  const focusBounds = buildFocusBounds(model, recordIndices, moveSelection);
  const limitations = model.complete
    ? Object.freeze([])
    : Object.freeze([
        Object.freeze({
          code: 'source-incomplete' as const,
          message: `Inspection covers only the parsed prefix (${model.terminationReason ?? 'unknown termination'}).`,
        }),
      ]);

  return Object.freeze({
    sourceRecordCount: model.columns.count,
    layers,
    layerSelection,
    recordIndices,
    moveSelection,
    current,
    ticks,
    toolMarker,
    sourceWindow,
    focusBounds,
    limitations,
  });
}

/** Return the next exact rich record while respecting the selected move range. */
export function stepGcodeInspection(state: GcodeInspectionState, direction: -1 | 1, wrap = false): number | undefined {
  if (direction !== -1 && direction !== 1) {
    throw new GcodeInspectionError('invalid-playback', 'Inspection step direction must be -1 or 1');
  }
  const selection = state.moveSelection;
  if (!selection || !state.current) return undefined;
  let ordinal = state.current.ordinal + direction;
  if (ordinal < selection.firstOrdinal || ordinal > selection.lastOrdinal) {
    if (!wrap) return undefined;
    ordinal = direction > 0 ? selection.firstOrdinal : selection.lastOrdinal;
  }
  return state.recordIndices[ordinal];
}

/**
 * Materialize a bounded playback sequence of rich record IDs. The sequence is
 * detached and never mutates the inspection state or source visibility mask.
 */
export function buildGcodePlaybackSequence(state: GcodeInspectionState, options: GcodePlaybackOptions): Uint32Array {
  const maximum = options.maxFrames ?? GCODE_INSPECTION_HARD_CAPS.playbackFrames;
  if (
    (options.direction !== -1 && options.direction !== 1) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > GCODE_INSPECTION_HARD_CAPS.playbackFrames
  ) {
    throw new GcodeInspectionError('invalid-playback', 'Playback options are outside the bounded domain');
  }
  const selection = state.moveSelection;
  if (!selection) return new Uint32Array();
  let ordinal = state.current?.ordinal ?? (options.direction > 0 ? selection.firstOrdinal : selection.lastOrdinal);
  if (!options.includeCurrent) ordinal += options.direction;
  const records: number[] = [];
  const rangeCount = selection.lastOrdinal - selection.firstOrdinal + 1;
  const limit = options.wrap ? Math.min(maximum, rangeCount) : maximum;
  while (records.length < limit) {
    if (ordinal < selection.firstOrdinal || ordinal > selection.lastOrdinal) {
      if (!options.wrap) break;
      ordinal = options.direction > 0 ? selection.firstOrdinal : selection.lastOrdinal;
    }
    records.push(state.recordIndices[ordinal]);
    ordinal += options.direction;
  }
  return Uint32Array.from(records);
}

function validateModel(model: RichGcodeModel): void {
  const columns = model?.columns;
  const count = columns?.count;
  if (
    !columns ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > RICH_GCODE_HARD_CAPS.records ||
    !Number.isSafeInteger(model.layerCount) ||
    model.layerCount < 0 ||
    model.layerCount > count ||
    model.layerCount > RICH_GCODE_HARD_CAPS.lines ||
    !Number.isSafeInteger(model.sourceLength) ||
    model.sourceLength < 0 ||
    !Number.isSafeInteger(model.parsedLines) ||
    model.parsedLines < 0 ||
    model.parsedLines > RICH_GCODE_HARD_CAPS.lines
  ) {
    invalidModel('Rich G-code model is outside the bounded inspection domain');
  }
  const arrays: readonly ArrayLike<number>[] = [
    columns.kind,
    columns.startX,
    columns.startY,
    columns.startZ,
    columns.endX,
    columns.endY,
    columns.endZ,
    columns.layer,
    columns.tool,
    columns.filament,
    columns.sourceLine,
    columns.sourceStartOffset,
    columns.sourceEndOffset,
  ];
  if (arrays.some((array) => !array || array.length !== count)) invalidModel('Rich G-code columns differ in length');
  if (
    !Array.isArray(model.roles) ||
    model.roles.length < 1 ||
    model.roles.length > RICH_GCODE_HARD_CAPS.roles ||
    !Array.isArray(model.filaments) ||
    model.filaments.length < 1 ||
    model.filaments.length > RICH_GCODE_HARD_CAPS.filaments
  ) {
    invalidModel('Rich G-code lookup tables are outside their bounded domain');
  }
  for (let index = 0; index < count; index += 1) {
    const kind = columns.kind[index];
    if (kind >= GCODE_RECORD_KIND_NAMES.length || kind === 3) invalidModel(`Record ${index} has an invalid kind`);
    if (
      columns.layer[index] > model.layerCount ||
      columns.tool[index] >= 256 ||
      columns.filament[index] >= model.filaments.length
    ) {
      invalidModel(`Record ${index} has an invalid lookup identity`);
    }
    if (
      !Number.isFinite(columns.startX[index]) ||
      !Number.isFinite(columns.startY[index]) ||
      !Number.isFinite(columns.startZ[index]) ||
      !Number.isFinite(columns.endX[index]) ||
      !Number.isFinite(columns.endY[index]) ||
      !Number.isFinite(columns.endZ[index])
    ) {
      invalidModel(`Record ${index} has a non-finite position`);
    }
    if (
      columns.sourceLine[index] < 1 ||
      columns.sourceLine[index] > model.parsedLines ||
      columns.sourceStartOffset[index] > columns.sourceEndOffset[index] ||
      columns.sourceEndOffset[index] > model.sourceLength
    ) {
      invalidModel(`Record ${index} has an invalid source location`);
    }
  }
  try {
    validateGcodePathSidecar(model);
  } catch (error) {
    invalidModel(error instanceof Error ? error.message : 'Rich G-code path sidecar is malformed');
  }
}

function validateVisibility(mask: Uint8Array | undefined, count: number): Uint8Array | undefined {
  if (!mask) return undefined;
  if (!(mask instanceof Uint8Array) || mask.length !== count) {
    throw new GcodeInspectionError('invalid-visibility', `Record visibility must contain exactly ${count} bytes`);
  }
  for (const value of mask) {
    if (value !== 0 && value !== 1) {
      throw new GcodeInspectionError('invalid-visibility', 'Record visibility values must be zero or one');
    }
  }
  return mask;
}

function buildLayerIndex(model: RichGcodeModel): GcodeInspectionLayerIndex {
  const maximumLayer = model.layerCount;
  const first = new Uint32Array(maximumLayer + 1);
  first.fill(0xffff_ffff);
  const last = new Uint32Array(maximumLayer + 1);
  const z = new Float64Array(maximumLayer + 1);
  z.fill(Number.NEGATIVE_INFINITY);
  // A layer's height is where it is printed, which only extrusions report: a
  // travel or wipe may be lifted by the retraction Z-hop, and taking the
  // maximum over those would overstate every layer by the hop and mislocate
  // anything authored against it.
  const extrudeZ = new Float64Array(maximumLayer + 1);
  extrudeZ.fill(Number.NEGATIVE_INFINITY);
  const present = new Uint8Array(maximumLayer + 1);
  for (let record = 0; record < model.columns.count; record += 1) {
    const kind = model.columns.kind[record];
    if (INSPECTABLE_KIND[kind] === 0) continue;
    const layer = model.columns.layer[record];
    present[layer] = 1;
    first[layer] = Math.min(first[layer], record);
    last[layer] = record;
    z[layer] = Math.max(z[layer], model.columns.startZ[record], model.columns.endZ[record]);
    if (kind === GCODE_RECORD_KIND.EXTRUDE) {
      extrudeZ[layer] = Math.max(extrudeZ[layer], model.columns.startZ[record], model.columns.endZ[record]);
    }
  }
  const layerIds: number[] = [];
  const zValues: number[] = [];
  const firstRecords: number[] = [];
  const lastRecords: number[] = [];
  for (let layer = 0; layer <= maximumLayer; layer += 1) {
    if (present[layer] === 0) continue;
    layerIds.push(layer);
    // Prefer the extrusion height; fall back only for a layer that prints
    // nothing (a travel-only or marker-only layer), where the observed Z is
    // the only fact available.
    const printZ = Number.isFinite(extrudeZ[layer]) ? extrudeZ[layer] : z[layer];
    zValues.push(Number.isFinite(printZ) ? printZ : 0);
    firstRecords.push(first[layer]);
    lastRecords.push(last[layer]);
  }
  return Object.freeze({
    count: layerIds.length,
    layerIds: Uint32Array.from(layerIds),
    zMm: Float32Array.from(zValues),
    firstRecord: Uint32Array.from(firstRecords),
    lastRecord: Uint32Array.from(lastRecords),
  });
}

function selectLayers(
  layers: GcodeInspectionLayerIndex,
  requested: readonly [number, number] | undefined,
  singleLayer: boolean,
): GcodeInspectionLayerSelection | null {
  if (layers.count === 0) {
    if (requested) throw new GcodeInspectionError('invalid-layer-range', 'An empty inspection has no layer range');
    return null;
  }
  let firstLayer = requested?.[0] ?? layers.layerIds[0];
  const lastLayer = requested?.[1] ?? layers.layerIds[layers.count - 1];
  const firstOrdinal = layers.layerIds.indexOf(firstLayer);
  const lastOrdinal = layers.layerIds.indexOf(lastLayer);
  if (
    requested?.length !== undefined &&
    (requested.length !== 2 ||
      !Number.isSafeInteger(firstLayer) ||
      !Number.isSafeInteger(lastLayer) ||
      firstOrdinal < 0 ||
      lastOrdinal < 0 ||
      firstOrdinal > lastOrdinal)
  ) {
    throw new GcodeInspectionError('invalid-layer-range', 'Layer handles must select ordered record-bearing layers');
  }
  if (singleLayer) {
    firstLayer = lastLayer;
  }
  const selectedFirstOrdinal = layers.layerIds.indexOf(firstLayer);
  const firstZMm = layers.zMm[selectedFirstOrdinal];
  const lastZMm = layers.zMm[lastOrdinal];
  return Object.freeze({
    firstLayer,
    lastLayer,
    firstZMm,
    lastZMm,
    singleLayer,
    accessibleLabel:
      firstLayer === lastLayer
        ? `Layer ${lastLayer}, Z ${formatMm(lastZMm)} mm`
        : `Layers ${firstLayer} through ${lastLayer}, Z ${formatMm(firstZMm)} through ${formatMm(lastZMm)} mm`,
  });
}

function selectRecords(
  model: RichGcodeModel,
  visibility: Uint8Array | undefined,
  selection: GcodeInspectionLayerSelection | null,
): Uint32Array {
  if (!selection) return new Uint32Array();
  const records: number[] = [];
  for (let record = 0; record < model.columns.count; record += 1) {
    const kind = model.columns.kind[record];
    const layer = model.columns.layer[record];
    if (
      INSPECTABLE_KIND[kind] !== 0 &&
      visibility?.[record] !== 0 &&
      layer >= selection.firstLayer &&
      layer <= selection.lastLayer
    ) {
      records.push(record);
    }
  }
  return Uint32Array.from(records);
}

function selectMoveRange(
  records: Uint32Array,
  requested: readonly [number, number] | undefined,
): GcodeInspectionMoveSelection | null {
  if (records.length === 0) {
    if (requested) throw new GcodeInspectionError('invalid-move-range', 'An empty inspection has no move range');
    return null;
  }
  const firstOrdinal = requested?.[0] ?? 0;
  const lastOrdinal = requested?.[1] ?? records.length - 1;
  if (
    requested?.length !== undefined &&
    (requested.length !== 2 ||
      !Number.isSafeInteger(firstOrdinal) ||
      !Number.isSafeInteger(lastOrdinal) ||
      firstOrdinal < 0 ||
      lastOrdinal >= records.length ||
      firstOrdinal > lastOrdinal)
  ) {
    throw new GcodeInspectionError('invalid-move-range', 'Move handles are outside the filtered record domain');
  }
  return Object.freeze({
    firstOrdinal,
    lastOrdinal,
    firstRecord: records[firstOrdinal],
    lastRecord: records[lastOrdinal],
    count: lastOrdinal - firstOrdinal + 1,
    accessibleLabel:
      firstOrdinal === lastOrdinal
        ? `Move ${firstOrdinal + 1} of ${records.length}`
        : `Moves ${firstOrdinal + 1} through ${lastOrdinal + 1} of ${records.length}`,
  });
}

function selectCurrent(
  model: RichGcodeModel,
  layers: GcodeInspectionLayerIndex,
  records: Uint32Array,
  selection: GcodeInspectionMoveSelection | null,
  requestedRecord: number | undefined,
): GcodeInspectionCursor | null {
  if (!selection) {
    if (requestedRecord !== undefined) {
      throw new GcodeInspectionError('invalid-current-record', 'An empty inspection has no current record');
    }
    return null;
  }
  const record = requestedRecord ?? selection.lastRecord;
  if (!Number.isSafeInteger(record)) {
    throw new GcodeInspectionError('invalid-current-record', 'Current record must be a safe integer');
  }
  const ordinal = records.indexOf(record);
  if (ordinal < selection.firstOrdinal || ordinal > selection.lastOrdinal) {
    throw new GcodeInspectionError('invalid-current-record', 'Current record is outside the selected move range');
  }
  const layer = model.columns.layer[record];
  const layerOrdinal = layers.layerIds.indexOf(layer);
  const zMm = layerOrdinal >= 0 ? layers.zMm[layerOrdinal] : model.columns.endZ[record];
  const kind = model.columns.kind[record] as GcodeRecordKind;
  const positionMm = Object.freeze([
    model.columns.endX[record],
    model.columns.endY[record],
    model.columns.endZ[record],
  ]) as readonly [number, number, number];
  return Object.freeze({
    ordinal,
    record,
    kind,
    kindLabel: GCODE_RECORD_KIND_NAMES[kind],
    layer,
    zMm,
    tool: model.columns.tool[record],
    filament: model.columns.filament[record],
    sourceLine: model.columns.sourceLine[record],
    sourceStartOffset: model.columns.sourceStartOffset[record],
    sourceEndOffset: model.columns.sourceEndOffset[record],
    positionMm,
    accessibleLabel: `Move ${ordinal + 1} of ${records.length}, ${GCODE_RECORD_KIND_NAMES[kind]}, layer ${layer}, source line ${model.columns.sourceLine[record]}`,
  });
}

function buildTicks(
  model: RichGcodeModel,
  visibility: Uint8Array | undefined,
  selection: GcodeInspectionLayerSelection | null,
): readonly GcodeInspectionTick[] {
  if (!selection) return Object.freeze([]);
  const ticks: GcodeInspectionTick[] = [];
  for (let record = 0; record < model.columns.count; record += 1) {
    if (visibility?.[record] === 0) continue;
    const layer = model.columns.layer[record];
    if (layer < selection.firstLayer || layer > selection.lastLayer) continue;
    const tick = tickFor(model, record);
    if (!tick) continue;
    if (ticks.length >= GCODE_INSPECTION_HARD_CAPS.ticks) {
      throw new GcodeInspectionError(
        'invalid-model',
        `Inspection tick count exceeds ${GCODE_INSPECTION_HARD_CAPS.ticks}`,
      );
    }
    ticks.push(Object.freeze(tick));
  }
  return Object.freeze(ticks);
}

function tickFor(model: RichGcodeModel, record: number): GcodeInspectionTick | undefined {
  const kind = model.columns.kind[record];
  const layer = model.columns.layer[record];
  const base = {
    record,
    layer,
    // Event records are zero-length at the exact parser cursor. Avoid a layer-index
    // search per event so tick projection stays linear for very large files.
    zMm: Math.max(model.columns.startZ[record], model.columns.endZ[record]),
    sourceLine: model.columns.sourceLine[record],
    sourceStartOffset: model.columns.sourceStartOffset[record],
    sourceEndOffset: model.columns.sourceEndOffset[record],
  };
  switch (kind) {
    case GCODE_RECORD_KIND.TOOL_CHANGE:
      return {
        ...base,
        id: `tool-change:${record}`,
        kind: 'tool-change',
        label: `Tool T${model.columns.tool[record]}`,
      };
    case GCODE_RECORD_KIND.COLOR_CHANGE:
      return {
        ...base,
        id: `color-change:${record}`,
        kind: 'color-change',
        label: `Filament F${model.columns.filament[record]} on T${model.columns.tool[record]}`,
      };
    case GCODE_RECORD_KIND.PAUSE:
      return { ...base, id: `pause:${record}`, kind: 'pause', label: 'Pause print' };
    case GCODE_RECORD_KIND.CUSTOM:
      return { ...base, id: `custom:${record}`, kind: 'custom', label: 'Custom G-code' };
    default:
      return undefined;
  }
}

function buildSourceWindow(
  model: RichGcodeModel,
  current: GcodeInspectionCursor | null,
  source: string,
  requestedContext: number | undefined,
): GcodeInspectionSourceWindow | null {
  if (source.length !== model.sourceLength) {
    throw new GcodeInspectionError('invalid-source', 'G-code source length differs from the parsed model');
  }
  if (!current) return null;
  const context = requestedContext ?? 3;
  if (!Number.isSafeInteger(context) || context < 0 || context > GCODE_INSPECTION_HARD_CAPS.sourceContextLines) {
    throw new GcodeInspectionError(
      'invalid-source',
      `Source context must be in [0, ${GCODE_INSPECTION_HARD_CAPS.sourceContextLines}]`,
    );
  }
  let windowStart = current.sourceStartOffset;
  let firstLine = current.sourceLine;
  for (let index = 0; index < context && windowStart > 0; index += 1) {
    const priorNewline = source.lastIndexOf('\n', Math.max(0, windowStart - 2));
    windowStart = priorNewline < 0 ? 0 : priorNewline + 1;
    firstLine -= 1;
  }
  const currentNewline = source.indexOf('\n', current.sourceEndOffset);
  let windowEnd = currentNewline < 0 ? source.length : currentNewline + 1;
  let lastLine = current.sourceLine;
  for (let index = 0; index < context && windowEnd < source.length; index += 1) {
    const newline = source.indexOf('\n', windowEnd);
    windowEnd = newline < 0 ? source.length : newline + 1;
    lastLine += 1;
  }
  const lines: GcodeInspectionSourceLine[] = [];
  let offset = windowStart;
  let lineNumber = firstLine;
  while (offset < windowEnd && lineNumber <= lastLine) {
    const newline = source.indexOf('\n', offset);
    const rawEnd = newline < 0 || newline >= windowEnd ? windowEnd : newline;
    const contentEnd = rawEnd > offset && source.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const raw = source.slice(offset, contentEnd);
    const truncated = raw.length > GCODE_INSPECTION_HARD_CAPS.sourceLineCharacters;
    const text = truncated ? `${raw.slice(0, GCODE_INSPECTION_HARD_CAPS.sourceLineCharacters - 1)}…` : raw;
    lines.push(
      Object.freeze({
        number: lineNumber,
        startOffset: offset,
        endOffset: rawEnd,
        text,
        current: lineNumber === current.sourceLine,
        truncated,
      }),
    );
    if (newline < 0 || newline >= windowEnd) break;
    offset = newline + 1;
    lineNumber += 1;
  }
  return Object.freeze({
    currentLine: current.sourceLine,
    firstLine,
    lastLine: lines.at(-1)?.number ?? firstLine,
    lines: Object.freeze(lines),
  });
}

function buildFocusBounds(
  model: RichGcodeModel,
  records: Uint32Array,
  selection: GcodeInspectionMoveSelection | null,
): GcodeInspectionBounds | null {
  if (!selection) return null;
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const include = (x: number, y: number, z: number): void => {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  };
  for (let ordinal = selection.firstOrdinal; ordinal <= selection.lastOrdinal; ordinal += 1) {
    const record = records[ordinal];
    if (GEOMETRIC_KIND[model.columns.kind[record]] === 0) continue;
    // A direct record with no XYZ delta still locates the toolhead even though
    // it has no renderable segment. Seed the bounds before walking an arc's
    // intermediate points so that semantic focus is never lost.
    include(model.columns.startX[record], model.columns.startY[record], model.columns.startZ[record]);
    visitGcodeRecordPathSegments(model, record, (_startX, _startY, _startZ, endX, endY, endZ) => {
      include(endX, endY, endZ);
    });
  }
  if (!Number.isFinite(min[0])) return null;
  return Object.freeze({
    minMm: Object.freeze(min) as readonly [number, number, number],
    maxMm: Object.freeze(max) as readonly [number, number, number],
  });
}

function invalidModel(message: string): never {
  throw new GcodeInspectionError('invalid-model', message);
}

function formatMm(value: number): string {
  return Number(value.toFixed(3)).toString();
}
