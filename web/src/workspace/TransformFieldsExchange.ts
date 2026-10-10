/**
 * The hosts' contract for the transform inspector's fields
 * (`TransformFields.ts`): each request and reply is a canonical JSON document,
 * every answer comes from the production modules, and the shared Rust core
 * answers the same requests (`orcaxr_project::placement::fields`).
 *
 * - `transformFieldsExchange`: `{"tool","transform"}` → `{"texts","values"}`,
 *   what the tool's three fields show.
 * - `transformFieldEditExchange`: `{"origins","primaryInstanceId","texts","tool"}`
 *   → `{"changes"}`, the instance transforms an edit of the three fields
 *   submits (the primary alone, or the selection carried around it), or
 *   `{"error":"invalid_edit","message"}` with the workspace's message.
 * - `transformRotationExchange`: `{"rotation"}` → `{"eulerRadians"}` and
 *   `{"eulerRadians"}` → `{"rotation"}`.
 *
 * A transform is `{"rotation","scale","translationMm"}`. A value JSON cannot
 * carry is `null`. A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { InstanceId } from '../project/domain/ids';
import type { Transform } from '../project/domain/model';
import { cloneAndValidateTransform } from '../project/objects/transformValidation';
import { primaryTransformEdit, type MultiInstanceTransformOrigin } from './multiInstanceTransform';
import {
  eulerFromQuaternion,
  quaternionFromEuler,
  transformFieldInput,
  transformFieldText,
  transformFieldValue,
  transformFieldValues,
  withTransformFieldInput,
  type TransformFieldTool,
} from './TransformFields';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';
/** The code of an edit the workspace refuses. */
export const INVALID_EDIT = 'invalid_edit';

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
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function numbers(value: Json | undefined, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) invalid();
  return value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) invalid();
    return entry;
  });
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}
function tool(value: Json | undefined): TransformFieldTool {
  if (value !== 'move' && value !== 'rotate' && value !== 'scale') invalid();
  return value;
}
function transform(value: Json | undefined): Transform {
  const fields = object(value, ['rotation', 'scale', 'translationMm']);
  const [x, y, z] = numbers(fields.translationMm, 3);
  const [qx, qy, qz, qw] = numbers(fields.rotation, 4);
  const [sx, sy, sz] = numbers(fields.scale, 3);
  return { translationMm: [x, y, z], rotation: [qx, qy, qz, qw], scale: [sx, sy, sz] };
}

const value = (number: number): number | null => (Number.isFinite(number) ? number : null);
const transformJson = (t: Transform) => ({
  rotation: t.rotation.map(value),
  scale: t.scale.map(value),
  translationMm: t.translationMm.map(value),
});

/** `{"tool","transform"}` → the three fields' values and texts. */
export function transformFieldsExchange(requestJson: string): string {
  const request = object(read(requestJson), ['tool', 'transform']);
  const values = transformFieldValues(tool(request.tool), transform(request.transform));
  return canonicalStringify({ texts: values.map(transformFieldText), values: values.map(value) });
}

/** `{"origins","primaryInstanceId","texts","tool"}` → the changes the edit submits, or the workspace's refusal. */
export function transformFieldEditExchange(requestJson: string): string {
  const request = object(read(requestJson), ['origins', 'primaryInstanceId', 'texts', 'tool']);
  const mode = tool(request.tool);
  if (!Array.isArray(request.texts) || request.texts.length !== 3) invalid();
  const [x, y, z] = request.texts.map(text).map(transformFieldValue);
  if (!Array.isArray(request.origins) || request.origins.length === 0) invalid();
  const origins: MultiInstanceTransformOrigin[] = request.origins.map((entry) => {
    const fields = object(entry, ['instanceId', 'transform']);
    return { instanceId: text(fields.instanceId) as InstanceId, transform: transform(fields.transform) };
  });
  const primaryId = text(request.primaryInstanceId) as InstanceId;
  const primary = origins.find((origin) => origin.instanceId === primaryId);
  if (!primary) invalid();
  try {
    const current = withTransformFieldInput(mode, primary.transform, transformFieldInput(mode, [x, y, z]));
    const changes = primaryTransformEdit(origins, primaryId, current, mode).map((change) => ({
      instanceId: change.instanceId,
      transform: cloneAndValidateTransform(change.transform),
    }));
    return canonicalStringify({
      changes: changes.map((change) => ({ instanceId: change.instanceId, transform: transformJson(change.transform) })),
    });
  } catch (error) {
    return canonicalStringify({ error: INVALID_EDIT, message: (error as Error).message });
  }
}

/** `{"rotation"}` → `{"eulerRadians"}`, or `{"eulerRadians"}` → `{"rotation"}`. */
export function transformRotationExchange(requestJson: string): string {
  const request = read(requestJson);
  if (request !== null && typeof request === 'object' && !Array.isArray(request) && 'rotation' in request) {
    const [x, y, z, w] = numbers(object(request, ['rotation']).rotation, 4);
    return canonicalStringify({ eulerRadians: eulerFromQuaternion([x, y, z, w]).map(value) });
  }
  const [x, y, z] = numbers(object(request, ['eulerRadians']).eulerRadians, 3);
  return canonicalStringify({ rotation: quaternionFromEuler([x, y, z]).map(value) });
}
