/**
 * The hosts' contract for the volume-role editor (`volumeRoleEditor.ts`) and
 * the conversion command's decisions (`inspectVolumeRoleConversion`):
 * canonical JSON requests and replies, every answer from the production
 * modules. The shared Rust core answers the same requests
 * (`orcaxr_project::volume_role_editor`).
 *
 * - decision `{"role","volumeId"}` (any role text) → the decision:
 *   `{"allowed":true,"noop"}` or `{"allowed":false,"code","reason"}`;
 * - projection `{"volumeId"}` → `{"projection"}`: null for a volume the
 *   project lacks, else `{"choices","objectId","objectName","role","summary",
 *   "volumeId","volumeName"}`, each choice `{"blockedReason"?,"current",
 *   "decision","label","role"}` in upstream Orca's role order;
 * - messages `{"role","volumeName"}` (a supported role) → `{"pending","success"}`.
 *
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../domain/canonical';
import type { VolumeId } from '../domain/ids';
import type { ProjectState, VolumeRole } from '../domain/model';
import { inspectVolumeRoleConversion, ORCA_VOLUME_ROLE_ORDER } from './semanticVolumeCommands';
import { volumeRoleEditorProjection, volumeRoleOperationMessages } from './volumeRoleEditor';

export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function fields(request: string, keys: readonly string[]): JsonObject {
  let value: Json;
  try {
    value = JSON.parse(request) as Json;
  } catch {
    invalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}

export function volumeRoleDecisionExchange(state: ProjectState, request: string): string {
  const request_ = fields(request, ['role', 'volumeId']);
  return canonicalStringify(
    inspectVolumeRoleConversion(state, text(request_.volumeId) as VolumeId, text(request_.role)),
  );
}

export function volumeRoleEditorExchange(state: ProjectState, request: string): string {
  const projection = volumeRoleEditorProjection(state, text(fields(request, ['volumeId']).volumeId) as VolumeId);
  return canonicalStringify({ projection: projection ?? null });
}

export function volumeRoleMessagesExchange(request: string): string {
  const request_ = fields(request, ['role', 'volumeName']);
  const role = text(request_.role);
  if (!ORCA_VOLUME_ROLE_ORDER.some((known) => known === role)) invalid();
  return canonicalStringify(volumeRoleOperationMessages(text(request_.volumeName), role as VolumeRole));
}
