/**
 * The hosts' contract for a G-code's thumbnail blocks (`GcodeThumbnails.ts`):
 * each request and reply is a canonical JSON document, every answer comes from
 * the production module, and the shared Rust core answers the same requests
 * (`orcaxr_project::slicing::thumbnails`).
 *
 * - list: `{"value": any}` (a configuration's `thumbnails`, absent when the
 *   key is) → `{"problems": [{"entry", "reason"}], "requests": [{"format",
 *   "height", "width"}]}`.
 * - block: `{"image": hex, "request": {"format", "height", "width"}}` → the
 *   block's text, as a JSON string.
 * - inject: `{"blocks": [text], "gcode": text}` → the G-code with them, as a
 *   JSON string.
 *
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import {
  encodeThumbnailBlock,
  injectGcodeThumbnails,
  parseThumbnailList,
  type GcodeThumbnailRequest,
} from './GcodeThumbnails';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}
function object(value: Json | undefined, keys: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function dimension(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= 1000) invalid();
  return value;
}
function request(value: Json | undefined): GcodeThumbnailRequest {
  const fields = object(value, ['format', 'height', 'width']);
  const format = fields.format;
  if (format !== 'PNG' && format !== 'JPG') invalid();
  return { width: dimension(fields.width), height: dimension(fields.height), format };
}
function hex(value: Json | undefined): Uint8Array {
  const digits = text(value);
  if (!/^(?:[0-9a-f]{2})*$/.test(digits)) invalid();
  return Uint8Array.from({ length: digits.length / 2 }, (_, i) => parseInt(digits.slice(i * 2, i * 2 + 2), 16));
}

/** `{"value"?}` → what a `thumbnails` value asks for, and what of it cannot be honoured. */
export function thumbnailListExchange(requestJson: string): string {
  const fields = object(read(requestJson), [], ['value']);
  const list = parseThumbnailList('value' in fields ? fields.value : undefined);
  return canonicalStringify({
    problems: list.problems.map((problem) => ({ entry: problem.entry, reason: problem.reason })),
    requests: list.requests.map((entry) => ({ format: entry.format, height: entry.height, width: entry.width })),
  });
}

/** `{"image","request"}` → one thumbnail in the engine's wire format. */
export function thumbnailBlockExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['image', 'request']);
  return canonicalStringify(encodeThumbnailBlock(request(fields.request), hex(fields.image)));
}

/** `{"blocks","gcode"}` → the G-code with its thumbnail blocks where the engine puts them. */
export function thumbnailInjectExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['blocks', 'gcode']);
  if (!Array.isArray(fields.blocks)) invalid();
  return canonicalStringify(injectGcodeThumbnails(text(fields.gcode), fields.blocks.map(text)));
}
