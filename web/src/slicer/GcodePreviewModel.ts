import {
  GCODE_RECORD_KIND,
  GCODE_RECORD_KIND_NAMES,
  RICH_GCODE_HARD_CAPS,
  type GcodeRecordKind,
  type RichGcodeModel,
} from './RichGcodeModel';
import { validateGcodePathSidecar } from './GcodePathSegments';

export const GCODE_PREVIEW_MODES = Object.freeze([
  { id: 'FeatureType', label: 'Line Type', valueKind: 'category', unit: null, scale: 'categorical' },
  { id: 'Height', label: 'Layer Height', valueKind: 'number', unit: 'mm', scale: 'linear' },
  { id: 'Width', label: 'Line Width', valueKind: 'number', unit: 'mm', scale: 'linear' },
  { id: 'Feedrate', label: 'Speed', valueKind: 'number', unit: 'mm/s', scale: 'linear' },
  { id: 'FanSpeed', label: 'Fan Speed', valueKind: 'number', unit: '%', scale: 'linear' },
  { id: 'Temperature', label: 'Temperature', valueKind: 'number', unit: '°C', scale: 'linear' },
  {
    id: 'VolumetricRate',
    label: 'Volumetric Flow Rate',
    valueKind: 'number',
    unit: 'mm³/s',
    scale: 'linear',
  },
  { id: 'Tool', label: 'Tool', valueKind: 'category', unit: null, scale: 'categorical' },
  { id: 'ColorPrint', label: 'Filament', valueKind: 'category', unit: null, scale: 'categorical' },
  {
    id: 'FilamentId',
    label: 'Filament ID Encoding',
    valueKind: 'category',
    unit: null,
    scale: 'categorical',
  },
  { id: 'LayerTime', label: 'Layer Time', valueKind: 'number', unit: 's', scale: 'linear' },
  { id: 'LayerTimeLog', label: 'Layer Time (log)', valueKind: 'number', unit: 's', scale: 'log' },
] as const);

export type GcodePreviewMode = (typeof GCODE_PREVIEW_MODES)[number]['id'];
export type GcodePreviewScale = 'categorical' | 'linear' | 'log';

export const GCODE_PREVIEW_HARD_CAPS = Object.freeze({
  projectedRecords: RICH_GCODE_HARD_CAPS.records,
  legendEntries: 8_192,
  metadataTextCharacters: 256,
});

export const GCODE_PREVIEW_ROLE_COUNT = 20;
export const GCODE_PREVIEW_TOOL_COUNT = 256;
export const GCODE_PREVIEW_EVENT_COUNT = GCODE_RECORD_KIND_NAMES.length;

export interface AuthoritativeLayerTimes {
  /** Index is the one-based/zero-based layer ID stored in the rich columns. */
  readonly secondsByLayer: Float32Array;
  /** Stable non-empty identity of the processor/statistics artifact supplying these values. */
  readonly provenance: string;
}

export interface GcodePreviewRequest {
  readonly mode: GcodePreviewMode;
  /** Exact upstream-role-index mask; must contain 20 entries of only 0 or 1. */
  readonly roleVisibility?: Uint8Array;
  /** Physical tool mask; must contain 256 entries of only 0 or 1. */
  readonly toolVisibility?: Uint8Array;
  /** Rich record-kind mask; must contain 14 entries of only 0 or 1. */
  readonly eventVisibility?: Uint8Array;
  /** Inclusive layer IDs. */
  readonly layerRange?: readonly [number, number];
  /** Inclusive rich record indices. */
  readonly recordRange?: readonly [number, number];
  /** Inclusive numeric values; categorical modes reject this filter. */
  readonly valueRange?: readonly [number, number];
  readonly layerTimes?: AuthoritativeLayerTimes;
  readonly maxProjectedRecords?: number;
}

export interface GcodePreviewModeDefinition {
  readonly id: GcodePreviewMode;
  readonly label: string;
  readonly valueKind: 'category' | 'number';
  readonly unit: string | null;
  readonly scale: GcodePreviewScale;
}

export interface GcodePreviewMissingMetadata {
  readonly key: 'filament-colors' | 'layer-times' | 'role-color';
  readonly message: string;
  readonly indices: readonly number[];
  readonly additionalCount: number;
}

export interface GcodePreviewLimitation {
  readonly code: 'source-incomplete';
  readonly message: string;
}

export interface GcodePreviewLegendEntry {
  readonly id: string;
  readonly label: string;
  /** Text/code that keeps the entry identifiable without perceiving its hue. */
  readonly code: string;
  readonly accessibleLabel: string;
  readonly pattern: string;
  readonly color: readonly [number, number, number, number];
}

export interface GcodePreviewRange {
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly scale: 'linear' | 'log';
  readonly sampleCount: number;
}

export interface ReadyGcodePreviewProjection {
  readonly status: 'ready';
  readonly mode: GcodePreviewModeDefinition;
  readonly sourceRecordCount: number;
  readonly count: number;
  /** Indirection into RichGcodeModel.columns; no object is allocated per source line. */
  readonly recordIndices: Uint32Array;
  readonly values: Float32Array;
  readonly valueValid: Uint8Array;
  /** Four contiguous floats per projected record. */
  readonly colorsRgba: Float32Array;
  readonly range?: GcodePreviewRange;
  readonly legend: readonly GcodePreviewLegendEntry[];
  readonly limitations: readonly GcodePreviewLimitation[];
  readonly layerTimeProvenance?: string;
}

export interface UnsupportedGcodePreviewProjection {
  readonly status: 'unsupported';
  readonly mode: GcodePreviewModeDefinition;
  readonly sourceRecordCount: number;
  readonly missingMetadata: readonly GcodePreviewMissingMetadata[];
  readonly limitations: readonly GcodePreviewLimitation[];
}

export type GcodePreviewProjection = ReadyGcodePreviewProjection | UnsupportedGcodePreviewProjection;

export type GcodePreviewErrorCode =
  'invalid-model' | 'invalid-mode' | 'invalid-mask' | 'invalid-range' | 'invalid-layer-times' | 'projection-cap';

export class GcodePreviewProjectionError extends Error {
  readonly name = 'GcodePreviewProjectionError';

  constructor(
    readonly code: GcodePreviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface ValidatedRequest {
  readonly mode: GcodePreviewModeDefinition;
  readonly roleVisibility?: Uint8Array;
  readonly toolVisibility?: Uint8Array;
  readonly eventVisibility?: Uint8Array;
  readonly firstLayer: number;
  readonly lastLayer: number;
  readonly firstRecord: number;
  readonly lastRecord: number;
  readonly valueRange?: readonly [number, number];
  readonly layerTimes?: AuthoritativeLayerTimes;
  readonly maximum: number;
}

const RANGE_COLORS = Object.freeze([
  '#0B2C7A',
  '#135985',
  '#1C8891',
  '#04D60F',
  '#AAF200',
  '#FCF903',
  '#F5CE0A',
  '#D16830',
  '#C2523C',
  '#942616',
] as const);

const RANGE_RGBA = RANGE_COLORS.map(hexColor);

const ROLE_NAMES = Object.freeze([
  'Undefined',
  'Inner wall',
  'Outer wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Ironing',
  'Bridge',
  'Internal Bridge',
  'Gap infill',
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Support transition',
  'Prime tower',
  'Custom',
  'Multiple',
] as const);

const ROLE_RGBA: ReadonlyArray<readonly [number, number, number, number] | undefined> = Object.freeze([
  [0.9, 0.7, 0.7, 1],
  [1, 0.9, 0.3, 1],
  [1, 0.49, 0.22, 1],
  [0.12, 0.12, 1, 1],
  [0.69, 0.19, 0.16, 1],
  [0.59, 0.33, 0.8, 1],
  [0.94, 0.25, 0.25, 1],
  [0.4, 0.36, 0.78, 1],
  [1, 0.55, 0.41, 1],
  [0.3, 0.4, 0.63, 1],
  [0.3, 0.5, 0.73, 1],
  [1, 1, 1, 1],
  [0, 0.53, 0.43, 1],
  [0, 0.23, 0.43, 1],
  [0, 1, 0, 1],
  [0, 0.5, 0, 1],
  [0, 0.25, 0, 1],
  [0.7, 0.89, 0.67, 1],
  [0.37, 0.82, 0.58, 1],
  undefined,
]);

const EVENT_RGBA = Object.freeze([
  [0.2, 0.2, 0.2, 1],
  [0.803, 0.135, 0.839, 1],
  [0.287, 0.679, 0.81, 1],
  [0.9, 0.9, 0.9, 1],
  [0.758, 0.744, 0.389, 1],
  [0.856, 0.582, 0.546, 1],
  [0.322, 0.942, 0.512, 1],
  [0.886, 0.825, 0.262, 1],
  [0.219, 0.282, 0.609, 1],
  [1, 1, 0, 1],
  [1, 1, 1, 1],
  [0.35, 0.35, 0.35, 1],
  [0.55, 0.55, 0.55, 1],
  [0.45, 0.45, 0.45, 1],
] as const);

const EVENT_LABELS = Object.freeze([
  'No operation',
  'Retract',
  'Unretract',
  'Seam',
  'Tool change',
  'Color change',
  'Pause',
  'Custom G-code',
  'Travel',
  'Wipe',
  'Extrusion',
  'Layer change',
  'Wipe start',
  'Wipe end',
] as const);

const LEGEND_PATTERNS = Object.freeze(['solid', 'dash', 'dot', 'dash-dot', 'double', 'crosshatch'] as const);
const MAX_MISSING_INDICES = 64;

export function projectGcodePreview(model: RichGcodeModel, request: GcodePreviewRequest): GcodePreviewProjection {
  validateModel(model);
  const validated = validateRequest(model, request);
  const limitations = sourceLimitations(model);
  const missing = findMissingMetadata(model, validated);
  if (missing.length > 0) {
    return Object.freeze({
      status: 'unsupported',
      mode: validated.mode,
      sourceRecordCount: model.columns.count,
      missingMetadata: Object.freeze(missing),
      limitations,
    });
  }

  const statistics = scanProjection(model, validated);
  if (statistics.count > validated.maximum) {
    throw new GcodePreviewProjectionError(
      'projection-cap',
      `Preview projection requires ${statistics.count} records, exceeding the bounded limit of ${validated.maximum}`,
    );
  }

  const recordIndices = new Uint32Array(statistics.count);
  const values = new Float32Array(statistics.count);
  const valueValid = new Uint8Array(statistics.count);
  const colorsRgba = new Float32Array(statistics.count * 4);
  const seenCategories = new Uint8Array(categoryCapacity(validated.mode.id, model));
  const seenFixedEvents = new Uint8Array(GCODE_PREVIEW_EVENT_COUNT);
  const range =
    statistics.valueCount > 0 && validated.mode.valueKind === 'number'
      ? Object.freeze({
          min: statistics.min,
          max: statistics.max,
          unit: validated.mode.unit!,
          scale: validated.mode.scale as 'linear' | 'log',
          sampleCount: statistics.valueCount,
        })
      : undefined;

  let output = 0;
  for (let index = validated.firstRecord; index <= validated.lastRecord; index += 1) {
    if (!recordPasses(model, validated, index)) continue;
    const kind = model.columns.kind[index] as GcodeRecordKind;
    const valid = hasModeValue(validated.mode.id, kind);
    const value = valid ? modeValue(model, validated, index) : 0;
    if (valid && validated.valueRange && (value < validated.valueRange[0] || value > validated.valueRange[1])) {
      continue;
    }

    recordIndices[output] = index;
    values[output] = value;
    valueValid[output] = valid ? 1 : 0;
    const color = valid ? modeColor(model, validated.mode.id, index, value, range) : eventColor(model, kind, index);
    const colorOffset = output * 4;
    colorsRgba[colorOffset] = color[0];
    colorsRgba[colorOffset + 1] = color[1];
    colorsRgba[colorOffset + 2] = color[2];
    colorsRgba[colorOffset + 3] = color[3];
    if (valid) seenCategories[categoryIndex(model, validated.mode.id, index)] = 1;
    else seenFixedEvents[kind] = 1;
    output += 1;
  }

  const legend = buildLegend(model, validated.mode, range, seenCategories, seenFixedEvents);
  return Object.freeze({
    status: 'ready',
    mode: validated.mode,
    sourceRecordCount: model.columns.count,
    count: output,
    recordIndices,
    values,
    valueValid,
    colorsRgba,
    ...(range ? { range } : {}),
    legend,
    limitations,
    ...(validated.layerTimes ? { layerTimeProvenance: validated.layerTimes.provenance } : {}),
  });
}

function validateModel(model: RichGcodeModel): void {
  const count = model.columns.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > GCODE_PREVIEW_HARD_CAPS.projectedRecords) {
    invalidModel('Rich G-code record count is outside the bounded preview domain');
  }
  const columns: ArrayLike<number>[] = [
    model.columns.kind,
    model.columns.startX,
    model.columns.startY,
    model.columns.startZ,
    model.columns.endX,
    model.columns.endY,
    model.columns.endZ,
    model.columns.deltaE,
    model.columns.feedrateMmPerSecond,
    model.columns.widthMm,
    model.columns.heightMm,
    model.columns.mm3PerMm,
    model.columns.volumetricFlowMm3PerSecond,
    model.columns.fanPercent,
    model.columns.hotendTemperatureC,
    model.columns.layer,
    model.columns.role,
    model.columns.tool,
    model.columns.filament,
    model.columns.sourceLine,
    model.columns.sourceStartOffset,
    model.columns.sourceEndOffset,
    model.columns.commandLineNumber,
  ];
  if (columns.some((column) => column.length !== count)) invalidModel('Rich G-code column lengths are inconsistent');
  if (
    model.roles.length < 1 ||
    model.roles.length > RICH_GCODE_HARD_CAPS.roles ||
    model.filaments.length < 1 ||
    model.filaments.length > RICH_GCODE_HARD_CAPS.filaments
  ) {
    invalidModel('Rich G-code lookup tables are outside their bounded domain');
  }
  for (let id = 0; id < model.filaments.length; id += 1) {
    const filament = model.filaments[id];
    if (filament.id !== id || !Number.isInteger(filament.tool) || filament.tool < 0 || filament.tool >= 256) {
      invalidModel(`Rich G-code filament identity ${id} is malformed`);
    }
  }
  for (let index = 0; index < count; index += 1) {
    const kind = model.columns.kind[index];
    if (kind >= GCODE_PREVIEW_EVENT_COUNT || kind === 3) invalidModel(`Record ${index} has an unsupported kind`);
    if (
      model.columns.role[index] >= model.roles.length ||
      model.columns.tool[index] >= GCODE_PREVIEW_TOOL_COUNT ||
      model.columns.filament[index] >= model.filaments.length ||
      model.columns.layer[index] > model.layerCount
    ) {
      invalidModel(`Record ${index} references an out-of-range lookup value`);
    }
    if (
      !Number.isFinite(model.columns.startX[index]) ||
      !Number.isFinite(model.columns.startY[index]) ||
      !Number.isFinite(model.columns.startZ[index]) ||
      !Number.isFinite(model.columns.endX[index]) ||
      !Number.isFinite(model.columns.endY[index]) ||
      !Number.isFinite(model.columns.endZ[index]) ||
      !Number.isFinite(model.columns.deltaE[index]) ||
      !Number.isFinite(model.columns.feedrateMmPerSecond[index]) ||
      !Number.isFinite(model.columns.widthMm[index]) ||
      !Number.isFinite(model.columns.heightMm[index]) ||
      !Number.isFinite(model.columns.volumetricFlowMm3PerSecond[index]) ||
      !Number.isFinite(model.columns.fanPercent[index]) ||
      !Number.isFinite(model.columns.hotendTemperatureC[index])
    ) {
      invalidModel(`Record ${index} contains a non-finite preview value`);
    }
  }
  try {
    validateGcodePathSidecar(model);
  } catch (error) {
    invalidModel(error instanceof Error ? error.message : 'Rich G-code path sidecar is malformed');
  }
}

function validateRequest(model: RichGcodeModel, request: GcodePreviewRequest): ValidatedRequest {
  const mode = GCODE_PREVIEW_MODES.find((candidate) => candidate.id === request.mode);
  if (!mode) throw new GcodePreviewProjectionError('invalid-mode', `Unknown official preview mode "${request.mode}"`);
  validateMask(request.roleVisibility, GCODE_PREVIEW_ROLE_COUNT, 'role');
  validateMask(request.toolVisibility, GCODE_PREVIEW_TOOL_COUNT, 'tool');
  validateMask(request.eventVisibility, GCODE_PREVIEW_EVENT_COUNT, 'event');

  const [firstLayer, lastLayer] = validateIntegerRange(request.layerRange, 0, model.layerCount, 'layer', false);
  const [firstRecord, lastRecord] = validateIntegerRange(
    request.recordRange,
    0,
    Math.max(0, model.columns.count - 1),
    'record',
    model.columns.count === 0,
  );
  if (request.valueRange) {
    if (mode.valueKind !== 'number') {
      throw new GcodePreviewProjectionError(
        'invalid-range',
        `${mode.id} is categorical and cannot use a numeric value range`,
      );
    }
    if (
      request.valueRange.length !== 2 ||
      !Number.isFinite(request.valueRange[0]) ||
      !Number.isFinite(request.valueRange[1]) ||
      request.valueRange[0] > request.valueRange[1]
    ) {
      throw new GcodePreviewProjectionError('invalid-range', 'Preview value range must be two ordered finite numbers');
    }
  }

  const maximum = request.maxProjectedRecords ?? GCODE_PREVIEW_HARD_CAPS.projectedRecords;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > GCODE_PREVIEW_HARD_CAPS.projectedRecords) {
    throw new GcodePreviewProjectionError('projection-cap', 'Requested preview record cap is outside the hard domain');
  }
  if (request.layerTimes) validateLayerTimes(request.layerTimes);

  return {
    mode: mode as GcodePreviewModeDefinition,
    roleVisibility: request.roleVisibility,
    toolVisibility: request.toolVisibility,
    eventVisibility: request.eventVisibility,
    firstLayer,
    lastLayer,
    firstRecord,
    lastRecord,
    ...(request.valueRange ? { valueRange: request.valueRange } : {}),
    ...(request.layerTimes ? { layerTimes: request.layerTimes } : {}),
    maximum,
  };
}

function validateMask(mask: Uint8Array | undefined, expected: number, label: string): void {
  if (!mask) return;
  if (!(mask instanceof Uint8Array) || mask.length !== expected) {
    throw new GcodePreviewProjectionError('invalid-mask', `${label} visibility mask must have ${expected} bytes`);
  }
  for (const value of mask) {
    if (value !== 0 && value !== 1) {
      throw new GcodePreviewProjectionError('invalid-mask', `${label} visibility mask values must be 0 or 1`);
    }
  }
}

function validateIntegerRange(
  range: readonly [number, number] | undefined,
  minimum: number,
  maximum: number,
  label: string,
  empty: boolean,
): [number, number] {
  if (!range) return empty ? [0, -1] : [minimum, maximum];
  if (
    empty ||
    range.length !== 2 ||
    !Number.isSafeInteger(range[0]) ||
    !Number.isSafeInteger(range[1]) ||
    range[0] < minimum ||
    range[1] > maximum ||
    range[0] > range[1]
  ) {
    throw new GcodePreviewProjectionError('invalid-range', `Preview ${label} range is outside the source domain`);
  }
  return [range[0], range[1]];
}

function validateLayerTimes(layerTimes: AuthoritativeLayerTimes): void {
  if (
    !(layerTimes.secondsByLayer instanceof Float32Array) ||
    layerTimes.secondsByLayer.length > RICH_GCODE_HARD_CAPS.lines + 1 ||
    !layerTimes.provenance.trim() ||
    layerTimes.provenance.length > GCODE_PREVIEW_HARD_CAPS.metadataTextCharacters
  ) {
    throw new GcodePreviewProjectionError(
      'invalid-layer-times',
      'Layer times require a bounded Float32Array and non-empty bounded provenance',
    );
  }
}

function findMissingMetadata(model: RichGcodeModel, request: ValidatedRequest): GcodePreviewMissingMetadata[] {
  const missing: GcodePreviewMissingMetadata[] = [];
  if (request.mode.id === 'LayerTime' || request.mode.id === 'LayerTimeLog') {
    if (!request.layerTimes) {
      missing.push(
        missingMetadata(
          'layer-times',
          'Authoritative G-code processor layer durations are required; geometric feedrate estimates are not substituted',
          [],
          0,
        ),
      );
      return missing;
    }
  }

  const missingColors = new Uint8Array(model.filaments.length);
  const missingLayers =
    request.mode.id === 'LayerTime' || request.mode.id === 'LayerTimeLog'
      ? new Uint8Array(model.layerCount + 1)
      : undefined;
  const missingRoles = new Uint8Array(GCODE_PREVIEW_ROLE_COUNT);
  for (let index = request.firstRecord; index <= request.lastRecord; index += 1) {
    if (!recordPasses(model, request, index)) continue;
    const kind = model.columns.kind[index] as GcodeRecordKind;
    if (!hasModeValue(request.mode.id, kind)) continue;
    if (request.mode.id === 'ColorPrint') {
      const filament = model.columns.filament[index];
      if (!parseHexColor(model.filaments[filament]?.color)) missingColors[filament] = 1;
    } else if (request.mode.id === 'FeatureType') {
      const role = officialRole(model.roles[model.columns.role[index]]);
      if (!ROLE_RGBA[role]) missingRoles[role] = 1;
    } else if (missingLayers) {
      const layer = model.columns.layer[index];
      const seconds = request.layerTimes!.secondsByLayer[layer];
      if (!Number.isFinite(seconds) || seconds <= 0) missingLayers[layer] = 1;
    }
  }
  appendMissingMask(missing, 'filament-colors', 'Exact #RRGGBB filament colors are unavailable', missingColors);
  appendMissingMask(
    missing,
    'layer-times',
    'Positive authoritative durations are unavailable for layers',
    missingLayers,
  );
  appendMissingMask(
    missing,
    'role-color',
    'The pinned viewer defines no display color for extrusion roles',
    missingRoles,
  );
  return missing;
}

function appendMissingMask(
  target: GcodePreviewMissingMetadata[],
  key: GcodePreviewMissingMetadata['key'],
  message: string,
  mask: Uint8Array | undefined,
): void {
  if (!mask) return;
  const indices: number[] = [];
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    total += 1;
    if (indices.length < MAX_MISSING_INDICES) indices.push(index);
  }
  if (total > 0) target.push(missingMetadata(key, message, indices, total - indices.length));
}

function missingMetadata(
  key: GcodePreviewMissingMetadata['key'],
  message: string,
  indices: readonly number[],
  additionalCount: number,
): GcodePreviewMissingMetadata {
  return Object.freeze({ key, message, indices: Object.freeze([...indices]), additionalCount });
}

function scanProjection(
  model: RichGcodeModel,
  request: ValidatedRequest,
): { count: number; min: number; max: number; valueCount: number } {
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let valueCount = 0;
  for (let index = request.firstRecord; index <= request.lastRecord; index += 1) {
    if (!recordPasses(model, request, index)) continue;
    const kind = model.columns.kind[index] as GcodeRecordKind;
    const valid = hasModeValue(request.mode.id, kind);
    if (valid) {
      const value = modeValue(model, request, index);
      if (request.valueRange && (value < request.valueRange[0] || value > request.valueRange[1])) continue;
      if (request.mode.valueKind === 'number') {
        min = Math.min(min, rangeValue(request.mode.id, value));
        max = Math.max(max, rangeValue(request.mode.id, value));
        valueCount += 1;
      }
    }
    count += 1;
  }
  return { count, min, max, valueCount };
}

function recordPasses(model: RichGcodeModel, request: ValidatedRequest, index: number): boolean {
  const columns = model.columns;
  const kind = columns.kind[index];
  if (columns.layer[index] < request.firstLayer || columns.layer[index] > request.lastLayer) return false;
  if (request.eventVisibility && request.eventVisibility[kind] === 0) return false;
  if (request.toolVisibility && request.toolVisibility[columns.tool[index]] === 0) return false;
  if (kind === GCODE_RECORD_KIND.EXTRUDE && request.roleVisibility) {
    const role = officialRole(model.roles[columns.role[index]]);
    if (request.roleVisibility[role] === 0) return false;
  }
  return true;
}

function hasModeValue(mode: GcodePreviewMode, kind: GcodeRecordKind): boolean {
  if (kind === GCODE_RECORD_KIND.EXTRUDE) return true;
  return kind === GCODE_RECORD_KIND.TRAVEL && (mode === 'Feedrate' || mode === 'Tool');
}

function modeValue(model: RichGcodeModel, request: ValidatedRequest, index: number): number {
  const columns = model.columns;
  switch (request.mode.id) {
    case 'FeatureType':
      return officialRole(model.roles[columns.role[index]]);
    case 'Height':
      return roundToBin(columns.heightMm[index]);
    case 'Width':
      return roundToBin(columns.widthMm[index]);
    case 'Feedrate':
      return columns.feedrateMmPerSecond[index];
    case 'FanSpeed':
      return columns.fanPercent[index];
    case 'Temperature':
      return columns.hotendTemperatureC[index];
    case 'VolumetricRate':
      return columns.volumetricFlowMm3PerSecond[index];
    case 'Tool':
      return columns.tool[index];
    case 'ColorPrint':
      return columns.filament[index];
    case 'FilamentId':
      return columns.tool[index] * GCODE_PREVIEW_ROLE_COUNT + officialRole(model.roles[columns.role[index]]);
    case 'LayerTime':
    case 'LayerTimeLog':
      return request.layerTimes!.secondsByLayer[columns.layer[index]];
  }
}

function rangeValue(mode: GcodePreviewMode, value: number): number {
  return mode === 'VolumetricRate' ? roundToBin(value) : value;
}

function modeColor(
  model: RichGcodeModel,
  mode: GcodePreviewMode,
  index: number,
  value: number,
  range: GcodePreviewRange | undefined,
): readonly [number, number, number, number] {
  const columns = model.columns;
  switch (mode) {
    case 'FeatureType':
      return ROLE_RGBA[value]!;
    case 'Tool':
      return RANGE_RGBA[columns.tool[index] % RANGE_RGBA.length];
    case 'ColorPrint':
      return adjustForRendering(parseHexColor(model.filaments[columns.filament[index]].color)!);
    case 'FilamentId': {
      const tool = columns.tool[index] / 256;
      const role = officialRole(model.roles[columns.role[index]]) / 256;
      return [tool, role, tool, 1];
    }
    default:
      return rangeColor(value, range!);
  }
}

function eventColor(
  model: RichGcodeModel,
  kind: GcodeRecordKind,
  index: number,
): readonly [number, number, number, number] {
  if (kind === GCODE_RECORD_KIND.TRAVEL) {
    const delta = model.columns.deltaE[index];
    if (delta < 0) return [0.505, 0.064, 0.028, 1];
    if (delta > 0) return [0.112, 0.422, 0.103, 1];
  }
  return EVENT_RGBA[kind];
}

function rangeColor(value: number, range: GcodePreviewRange): readonly [number, number, number, number] {
  if (range.min === range.max) return RANGE_RGBA[0];
  const normalized =
    range.scale === 'log'
      ? (Math.log(value) - Math.log(range.min)) / (Math.log(range.max) - Math.log(range.min))
      : (value - range.min) / (range.max - range.min);
  const global = Math.max(0, Math.min(1, normalized)) * (RANGE_RGBA.length - 1);
  const low = Math.floor(global);
  const high = Math.min(RANGE_RGBA.length - 1, low + 1);
  const amount = global - low;
  return lerpColor(RANGE_RGBA[low], RANGE_RGBA[high], amount);
}

function categoryCapacity(mode: GcodePreviewMode, model: RichGcodeModel): number {
  switch (mode) {
    case 'FeatureType':
      return GCODE_PREVIEW_ROLE_COUNT;
    case 'Tool':
      return GCODE_PREVIEW_TOOL_COUNT;
    case 'ColorPrint':
      return model.filaments.length;
    case 'FilamentId':
      return GCODE_PREVIEW_TOOL_COUNT * GCODE_PREVIEW_ROLE_COUNT;
    default:
      return 1;
  }
}

function categoryIndex(model: RichGcodeModel, mode: GcodePreviewMode, index: number): number {
  switch (mode) {
    case 'FeatureType':
      return officialRole(model.roles[model.columns.role[index]]);
    case 'Tool':
      return model.columns.tool[index];
    case 'ColorPrint':
      return model.columns.filament[index];
    case 'FilamentId':
      return (
        model.columns.tool[index] * GCODE_PREVIEW_ROLE_COUNT + officialRole(model.roles[model.columns.role[index]])
      );
    default:
      return 0;
  }
}

function buildLegend(
  model: RichGcodeModel,
  mode: GcodePreviewModeDefinition,
  range: GcodePreviewRange | undefined,
  categories: Uint8Array,
  fixedEvents: Uint8Array,
): readonly GcodePreviewLegendEntry[] {
  const entries: GcodePreviewLegendEntry[] = [];
  if (range) {
    const steps = range.min === range.max ? 1 : RANGE_RGBA.length;
    for (let rank = steps - 1; rank >= 0; rank -= 1) {
      const fraction = steps === 1 ? 0 : rank / (steps - 1);
      const value =
        range.scale === 'log'
          ? Math.exp(Math.log(range.min) + fraction * (Math.log(range.max) - Math.log(range.min)))
          : range.min + fraction * (range.max - range.min);
      const label = `${formatNumber(value)} ${range.unit}`;
      entries.push(
        legendEntry(
          `${mode.id}:range:${rank}`,
          label,
          `R${rank + 1}`,
          `${mode.label}, ${label}, range step ${rank + 1} of ${steps}`,
          `range-${rank + 1}`,
          rangeColor(value, range),
        ),
      );
    }
  } else if (mode.id === 'FeatureType') {
    for (let role = 0; role < categories.length; role += 1) {
      if (categories[role] === 0) continue;
      entries.push(
        legendEntry(
          `role:${role}`,
          ROLE_NAMES[role],
          `R${role}`,
          `Line type R${role}: ${ROLE_NAMES[role]}`,
          LEGEND_PATTERNS[role % LEGEND_PATTERNS.length],
          ROLE_RGBA[role]!,
        ),
      );
    }
  } else if (mode.id === 'Tool') {
    for (let tool = 0; tool < categories.length; tool += 1) {
      if (categories[tool] === 0) continue;
      entries.push(
        legendEntry(
          `tool:${tool}`,
          `Tool ${tool}`,
          `T${tool}`,
          `Physical tool T${tool}`,
          LEGEND_PATTERNS[tool % LEGEND_PATTERNS.length],
          RANGE_RGBA[tool % RANGE_RGBA.length],
        ),
      );
    }
  } else if (mode.id === 'ColorPrint') {
    for (let filament = 0; filament < categories.length; filament += 1) {
      if (categories[filament] === 0) continue;
      const identity = model.filaments[filament];
      const color = adjustForRendering(parseHexColor(identity.color)!);
      entries.push(
        legendEntry(
          `filament:${filament}`,
          `Filament ${filament} · Tool ${identity.tool}`,
          `F${filament}/T${identity.tool}`,
          `Filament F${filament}, physical tool T${identity.tool}, color ${identity.color}`,
          LEGEND_PATTERNS[filament % LEGEND_PATTERNS.length],
          color,
        ),
      );
    }
  } else if (mode.id === 'FilamentId') {
    for (let category = 0; category < categories.length; category += 1) {
      if (categories[category] === 0) continue;
      const tool = Math.floor(category / GCODE_PREVIEW_ROLE_COUNT);
      const role = category % GCODE_PREVIEW_ROLE_COUNT;
      entries.push(
        legendEntry(
          `filament-id:${tool}:${role}`,
          `Tool ${tool} · ${ROLE_NAMES[role]}`,
          `T${tool}/R${role}`,
          `Calibration encoding for physical tool T${tool} and role R${role}, ${ROLE_NAMES[role]}`,
          LEGEND_PATTERNS[(tool + role) % LEGEND_PATTERNS.length],
          [tool / 256, role / 256, tool / 256, 1],
        ),
      );
    }
  }

  for (let kind = 0; kind < fixedEvents.length; kind += 1) {
    if (fixedEvents[kind] === 0) continue;
    entries.push(
      legendEntry(
        `event:${kind}`,
        EVENT_LABELS[kind],
        `E${kind}`,
        `Event E${kind}: ${EVENT_LABELS[kind]}`,
        LEGEND_PATTERNS[kind % LEGEND_PATTERNS.length],
        EVENT_RGBA[kind],
      ),
    );
  }
  if (entries.length > GCODE_PREVIEW_HARD_CAPS.legendEntries) {
    throw new GcodePreviewProjectionError('projection-cap', 'Preview legend exceeds its bounded hard cap');
  }
  return Object.freeze(entries);
}

function legendEntry(
  id: string,
  label: string,
  code: string,
  accessibleLabel: string,
  pattern: string,
  color: readonly [number, number, number, number],
): GcodePreviewLegendEntry {
  return Object.freeze({
    id,
    label,
    code,
    accessibleLabel,
    pattern,
    color: Object.freeze([...color]) as unknown as readonly [number, number, number, number],
  });
}

function sourceLimitations(model: RichGcodeModel): readonly GcodePreviewLimitation[] {
  if (model.complete) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      code: 'source-incomplete',
      message: `Projection covers only the parsed prefix; parser termination reason: ${model.terminationReason ?? 'unknown'}`,
    }),
  ]);
}

function officialRole(name: string): number {
  const role = ROLE_NAMES.indexOf(name as (typeof ROLE_NAMES)[number]);
  return role < 0 ? 0 : role;
}

function roundToBin(value: number): number {
  const scales = [100, 1_000, 10_000, 100_000, 1_000_000] as const;
  const thresholds = [0.095, 0.0095, 0.00095, 0.000095, 0.0000095] as const;
  let index = 0;
  while (value < thresholds[index] && index < 4) index += 1;
  return Math.round(value * scales[index]) / scales[index];
}

function parseHexColor(value: string | undefined): readonly [number, number, number, number] | undefined {
  if (!value || !/^#[0-9A-Fa-f]{6}$/.test(value)) return undefined;
  return hexColor(value);
}

function hexColor(value: string): readonly [number, number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
    1,
  ];
}

function adjustForRendering(
  color: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  return color[3] < 0.1
    ? [1, 1, 1, 0.3]
    : color[0] < 0.2 && color[1] < 0.2 && color[2] < 0.2
      ? [0.2, 0.2, 0.2, color[3]]
      : color;
}

function lerpColor(
  low: readonly [number, number, number, number],
  high: readonly [number, number, number, number],
  amount: number,
): readonly [number, number, number, number] {
  return [
    low[0] + (high[0] - low[0]) * amount,
    low[1] + (high[1] - low[1]) * amount,
    low[2] + (high[2] - low[2]) * amount,
    low[3] + (high[3] - low[3]) * amount,
  ];
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/(?:\.0+|(\.\d*[1-9])0+)$/, '$1');
}

function invalidModel(message: string): never {
  throw new GcodePreviewProjectionError('invalid-model', message);
}
