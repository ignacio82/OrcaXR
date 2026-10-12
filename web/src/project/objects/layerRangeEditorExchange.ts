/**
 * The hosts' contract for the height-range editor (`layerRangeEditor.ts`):
 * canonical JSON requests and replies, every answer from the production
 * module. The shared Rust core answers the same requests
 * (`orcaxr_project::layer_range_editor`).
 *
 * - projection `{"objectId","selectedLayerRangeId"}` (null for none) →
 *   `{"projection"}`: null for an object the project lacks, else
 *   `{"layerRanges","objectId","objectName","selectedLayerRange"?}`, each range
 *   `{"id","label","maxZMm","minZMm"}`;
 * - bounds `{"excludedId","ranges","rawMax","rawMin"}` →
 *   `{"maxZMm","minZMm","valid":true}` or `{"message","valid":false}`;
 * - split `{"maxZMm","minZMm","raw"}` → `{"splitZMm","valid":true}` or
 *   `{"message","valid":false}`;
 * - messages, an operation (`{"kind":"add","maxZMm","minZMm"}`,
 *   `{"fromMaxZMm","fromMinZMm","kind":"edit","maxZMm","minZMm"}`,
 *   `{"kind":"split","splitZMm"}`, `{"direction","kind":"merge"}` or
 *   `{"kind":"delete"}`) → `{"pending","success"}`.
 *
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../domain/canonical';
import type { LayerRangeId, ObjectId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import {
  formatLayerRangeBounds,
  layerRangeEditorProjection,
  layerRangeOperationMessages,
  validateLayerRangeBounds,
  validateLayerRangeSplit,
  type LayerRangeEditorOperation,
  type LayerRangeEditorRange,
} from './layerRangeEditor';

export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, keys: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function parse(request: string): Json {
  try {
    return JSON.parse(request) as Json;
  } catch {
    invalid();
  }
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function optionalText(value: Json | undefined): string | undefined {
  return value === null ? undefined : text(value);
}
function finite(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}

export function layerRangeEditorExchange(state: ProjectState, request: string): string {
  const fields = object(parse(request), ['objectId', 'selectedLayerRangeId']);
  const projection = layerRangeEditorProjection(
    state,
    text(fields.objectId) as ObjectId,
    optionalText(fields.selectedLayerRangeId) as LayerRangeId | undefined,
  );
  if (!projection) return canonicalStringify({ projection: null });
  return canonicalStringify({
    projection: {
      ...projection,
      layerRanges: projection.layerRanges.map((range) => ({
        ...range,
        label: formatLayerRangeBounds(range.minZMm, range.maxZMm),
      })),
    },
  });
}

export function layerRangeBoundsExchange(request: string): string {
  const fields = object(parse(request), ['excludedId', 'ranges', 'rawMax', 'rawMin']);
  if (!Array.isArray(fields.ranges)) invalid();
  const ranges: LayerRangeEditorRange[] = fields.ranges.map((entry) => {
    const range = object(entry, ['id', 'maxZMm', 'minZMm']);
    return { id: text(range.id) as LayerRangeId, maxZMm: finite(range.maxZMm), minZMm: finite(range.minZMm) };
  });
  const result = validateLayerRangeBounds(
    text(fields.rawMin),
    text(fields.rawMax),
    ranges,
    optionalText(fields.excludedId) as LayerRangeId | undefined,
  );
  return canonicalStringify(
    result.valid
      ? { maxZMm: result.maxZMm!, minZMm: result.minZMm!, valid: true }
      : { message: result.message, valid: false },
  );
}

export function layerRangeSplitExchange(request: string): string {
  const fields = object(parse(request), ['maxZMm', 'minZMm', 'raw']);
  const result = validateLayerRangeSplit(text(fields.raw), {
    id: '' as LayerRangeId,
    minZMm: finite(fields.minZMm),
    maxZMm: finite(fields.maxZMm),
  });
  return canonicalStringify(
    result.valid ? { splitZMm: result.splitZMm, valid: true } : { message: result.message, valid: false },
  );
}

export function layerRangeMessagesExchange(request: string): string {
  const value = parse(request);
  const kind = text(object(value, Object.keys((value ?? {}) as JsonObject)).kind);
  let operation: LayerRangeEditorOperation;
  switch (kind) {
    case 'add': {
      const fields = object(value, ['kind', 'maxZMm', 'minZMm']);
      operation = { kind, minZMm: finite(fields.minZMm), maxZMm: finite(fields.maxZMm) };
      break;
    }
    case 'edit': {
      const fields = object(value, ['fromMaxZMm', 'fromMinZMm', 'kind', 'maxZMm', 'minZMm']);
      operation = {
        kind,
        fromMinZMm: finite(fields.fromMinZMm),
        fromMaxZMm: finite(fields.fromMaxZMm),
        minZMm: finite(fields.minZMm),
        maxZMm: finite(fields.maxZMm),
      };
      break;
    }
    case 'split':
      operation = { kind, splitZMm: finite(object(value, ['kind', 'splitZMm']).splitZMm) };
      break;
    case 'merge': {
      const direction = text(object(value, ['direction', 'kind']).direction);
      if (direction !== 'previous' && direction !== 'next') invalid();
      operation = { kind, direction };
      break;
    }
    case 'delete':
      object(value, ['kind']);
      operation = { kind };
      break;
    default:
      invalid();
  }
  return canonicalStringify(layerRangeOperationMessages(operation));
}
