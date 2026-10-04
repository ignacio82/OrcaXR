import { GCODE_LAYOUT } from '../../../../contracts/generated/gcode-layout';
import { GCODE_VIEW_LAYOUT } from '../../../../contracts/generated/gcode-view-layout';
import { GCODE_PREVIEW_MODES, type GcodePreviewRequest } from '../GcodePreviewModel';
import type { GcodeInspectionRequest, GcodePlaybackOptions } from '../GcodeInspectionModel';
import { RICH_GCODE_HARD_CAPS, type RichGcodeParseOptions } from '../RichGcodeModel';

export type GcodeWindowSelector = readonly [] | readonly [number, number];
export type GcodeSourceOptions = Omit<RichGcodeParseOptions, 'range' | 'resumeFrom'>;
export type GcodeSourceInspection = Omit<GcodeInspectionRequest, 'gcodeSource'>;
type Wire =
  | number
  | string
  | boolean
  | readonly Wire[]
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | { readonly [key: string]: Wire | undefined };

function check(value: unknown): asserts value {
  if (!value) throw new Error('Invalid shared G-code request');
}
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  check(Object.keys(value).every((key) => fields.includes(key)));
  // Only own data properties enter the serializer. No custom getters/toJSON or
  // inherited fields may change a request while its bound is being checked.
  for (const key of Object.getOwnPropertyNames(value)) {
    check(fields.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
  }
  check(Object.getOwnPropertySymbols(value).length === 0);
}
function finite(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value));
}
function ordinary(view: ArrayBufferView) {
  check(view.buffer instanceof ArrayBuffer);
  check(!('resizable' in view.buffer) || !view.buffer.resizable);
  // Constructing a view distinguishes a valid empty array from a detached one.
  new Uint8Array(view.buffer, 0, 0);
}
function pair(value: unknown): asserts value is readonly [number, number] {
  check(Array.isArray(value) && value.length === 2);
  finite(value[0]);
  finite(value[1]);
}
function units(value: unknown, maximum: number): Uint16Array {
  check(typeof value === 'string' && value.length <= maximum);
  const output = new Uint16Array(value.length);
  for (let i = 0; i < value.length; i++) output[i] = value.charCodeAt(i);
  return output;
}
function mask(value: unknown, maximum: number, exact = true): Uint8Array {
  check(value instanceof Uint8Array && (exact ? value.length === maximum : value.length <= maximum));
  ordinary(value);
  for (const byte of value) check(byte === 0 || byte === 1);
  return value;
}

/** The wire contains only ASCII keys/enums, finite numbers, and UTF-16 unit
 * arrays. Charge every byte before appending it; never stringify an unbounded
 * typed array or copy a too-large string through wasm-bindgen first. */
function encode(value: Wire, maximum: number): string {
  const chunks: string[] = [];
  let part = '',
    size = 0;
  const add = (text: string) => {
    size += text.length;
    if (size > maximum) throw new Error('Shared G-code request exceeds its byte limit');
    part += text;
    if (part.length >= 4096) {
      chunks.push(part);
      part = '';
    }
  };
  const visit = (item: Wire) => {
    if (typeof item === 'number') {
      finite(item);
      add(String(item));
    } else if (typeof item === 'boolean') add(item ? 'true' : 'false');
    else if (typeof item === 'string') {
      check(/^[\x20-\x7e]*$/.test(item));
      add(JSON.stringify(item));
    } else if (Array.isArray(item) || ArrayBuffer.isView(item)) {
      add('[');
      const array = item as readonly Wire[];
      for (let i = 0; i < array.length; i++) {
        if (i) add(',');
        visit(array[i]);
      }
      add(']');
    } else {
      add('{');
      let count = 0;
      for (const [key, field] of Object.entries(item)) {
        if (field === undefined) continue;
        if (count++) add(',');
        add(JSON.stringify(key));
        add(':');
        visit(field);
      }
      add('}');
    }
  };
  visit(value);
  chunks.push(part);
  return chunks.join('');
}

export function checkedGcodeWindow(value: GcodeWindowSelector, entryCount: number): GcodeWindowSelector {
  check(Array.isArray(value) && (value.length === 0 || value.length === 2));
  if (value.length) {
    check(Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]));
    check(value[0] >= 0 && value[0] <= value[1] && value[1] < entryCount);
    return Object.freeze([value[0], value[1]]) as readonly [number, number];
  }
  return Object.freeze([]);
}

export function encodeGcodeOptions(options: GcodeSourceOptions = {}): string {
  object(options, ['limits', 'filamentDiametersMm', 'filamentColors']);
  const output: Record<string, Wire> = {};
  if (options.limits !== undefined) {
    object(options.limits, Object.keys(RICH_GCODE_HARD_CAPS));
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(options.limits)) {
      if (value === undefined) continue;
      check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1);
      limits[key] = value;
    }
    output.limits = limits;
  }
  if (options.filamentDiametersMm !== undefined) {
    check(Array.isArray(options.filamentDiametersMm) && options.filamentDiametersMm.length <= 256);
    for (const diameter of options.filamentDiametersMm) {
      finite(diameter);
      check(diameter > 0);
    }
    output.filamentDiametersMm = options.filamentDiametersMm;
  }
  if (options.filamentColors !== undefined) {
    check(Array.isArray(options.filamentColors) && options.filamentColors.length <= 256);
    // Reserve the entire minimum serialized unit count before allocating any
    // color arrays. Encoding then charges exact decimal digits and separators.
    let count = 0;
    for (const color of options.filamentColors) {
      check(typeof color === 'string');
      count += color.length;
      check(count <= 32768);
    }
    output.filamentColors = options.filamentColors.map((color) => units(color, 32768));
  }
  return encode(output, 64 * 1024);
}

export function encodeGcodePreview(window: GcodeWindowSelector, request: GcodePreviewRequest): string {
  window = checkedGcodeWindow(window, 0x1_0000_0000);
  object(request, [
    'mode',
    'roleVisibility',
    'toolVisibility',
    'eventVisibility',
    'layerRange',
    'recordRange',
    'valueRange',
    'layerTimes',
    'maxProjectedRecords',
  ]);
  check(GCODE_PREVIEW_MODES.some((mode) => mode.id === request.mode));
  const output: Record<string, Wire> = { mode: request.mode };
  for (const [key, count] of [
    ['roleVisibility', 20],
    ['toolVisibility', 256],
    ['eventVisibility', 14],
  ] as const)
    if (request[key] !== undefined) output[key] = mask(request[key], count);
  for (const key of ['layerRange', 'recordRange', 'valueRange'] as const)
    if (request[key] !== undefined) {
      pair(request[key]);
      output[key] = request[key];
    }
  if (request.maxProjectedRecords !== undefined) {
    finite(request.maxProjectedRecords);
    output.maxProjectedRecords = request.maxProjectedRecords;
  }
  if (request.layerTimes !== undefined) {
    object(request.layerTimes, ['secondsByLayer', 'provenance']);
    const times = request.layerTimes.secondsByLayer;
    check(times instanceof Float32Array && times.length <= GCODE_VIEW_LAYOUT.maxRequestBytes / 2);
    ordinary(times);
    output.layerTimes = {
      secondsByLayerBits: new Uint32Array(times.buffer, times.byteOffset, times.length),
      provenance: units(request.layerTimes.provenance, 256),
    };
  }
  return encode(
    { version: GCODE_VIEW_LAYOUT.version, operation: 'preview', window, request: output },
    GCODE_VIEW_LAYOUT.maxRequestBytes,
  );
}

export function encodeGcodeInspection(
  window: GcodeWindowSelector,
  request: GcodeSourceInspection,
  includeSource: boolean,
  playback?: GcodePlaybackOptions,
): string {
  window = checkedGcodeWindow(window, 0x1_0000_0000);
  object(request, [
    'clampLayerRange',
    'layerRange',
    'singleLayer',
    'recordVisibility',
    'moveRange',
    'currentRecord',
    'showToolMarker',
    'sourceContextLines',
  ]);
  check(typeof includeSource === 'boolean');
  const output: Record<string, Wire> = {};
  for (const key of ['clampLayerRange', 'singleLayer', 'showToolMarker'] as const)
    if (request[key] !== undefined) {
      check(typeof request[key] === 'boolean');
      output[key] = request[key];
    }
  for (const key of ['layerRange', 'moveRange'] as const)
    if (request[key] !== undefined) {
      pair(request[key]);
      output[key] = request[key];
    }
  for (const key of ['currentRecord', 'sourceContextLines'] as const)
    if (request[key] !== undefined) {
      finite(request[key]);
      output[key] = request[key];
    }
  if (request.recordVisibility !== undefined)
    output.recordVisibility = mask(request.recordVisibility, GCODE_LAYOUT.maxWindowRecords, false);
  let play: Record<string, Wire> | undefined;
  if (playback !== undefined) {
    object(playback, ['direction', 'wrap', 'includeCurrent', 'maxFrames']);
    check(playback.direction === 1 || playback.direction === -1);
    play = { direction: playback.direction };
    for (const key of ['wrap', 'includeCurrent'] as const)
      if (playback[key] !== undefined) {
        check(typeof playback[key] === 'boolean');
        play[key] = playback[key];
      }
    if (playback.maxFrames !== undefined) {
      finite(playback.maxFrames);
      play.maxFrames = playback.maxFrames;
    }
  }
  return encode(
    {
      version: GCODE_VIEW_LAYOUT.version,
      operation: play ? 'playback' : 'inspection',
      window,
      request: output,
      includeSource,
      playback: play,
    },
    GCODE_VIEW_LAYOUT.maxRequestBytes,
  );
}
