/**
 * The hosts' contract for the workspace's bed (`WorkspaceBed.ts`): each
 * request and reply is a canonical JSON document, every answer comes from the
 * production module, and the shared Rust core answers the same requests
 * (`orcaxr_project::placement::bed`).
 *
 * A request is `{"config": object, "wipeTower": WipeTowerState | null}`: a
 * project configuration and the tower of the plate being arranged. The reply
 * is `{"areaMm", "keepOut", "printableArea", "printableHeightMm", "sizeMm",
 * "volumeMm"}` — the volume as `{"maxMm", "minMm"}` corners — each absent
 * value `null`; a keep-out edge JSON cannot carry (an infinite tower width) is
 * `null` too. A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { WipeTowerState } from '../project/domain/model';
import { wipeTowerKeepOut, workspaceBed } from './WorkspaceBed';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, keys: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function finite(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}

/** A plate's wipe tower as the canonical state records it. */
function wipeTower(value: Json | undefined): WipeTowerState | undefined {
  if (value === null) return undefined;
  const fields = object(value, ['enabled', 'positionMm', 'rotationDeg'], ['filamentId']);
  if (typeof fields.enabled !== 'boolean') invalid();
  const position = fields.positionMm;
  if (!Array.isArray(position) || position.length !== 2) invalid();
  if ('filamentId' in fields && typeof fields.filamentId !== 'string') invalid();
  return {
    enabled: fields.enabled,
    positionMm: [finite(position[0]), finite(position[1])],
    rotationDeg: finite(fields.rotationDeg),
    ...(typeof fields.filamentId === 'string' ? { filamentId: fields.filamentId as WipeTowerState['filamentId'] } : {}),
  };
}

const edge = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** `{"config","wipeTower"}` → the bed, its printable area and height, where models go, and the tower's keep-out. */
export function workspaceBedExchange(requestJson: string): string {
  const request = object(read(requestJson), ['config', 'wipeTower']);
  const config = request.config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) invalid();
  const bed = workspaceBed(config);
  const keepOut = wipeTowerKeepOut(config, wipeTower(request.wipeTower));
  return canonicalStringify({
    areaMm: bed.areaMm,
    keepOut: keepOut
      ? { minX: edge(keepOut.minX), minY: edge(keepOut.minY), maxX: edge(keepOut.maxX), maxY: edge(keepOut.maxY) }
      : null,
    printableArea: bed.printableArea ?? null,
    printableHeightMm: bed.printableHeightMm ?? null,
    sizeMm: [bed.sizeMm[0], bed.sizeMm[1]],
    volumeMm: bed.volumeMm ? { minMm: [...bed.volumeMm.minMm], maxMm: [...bed.volumeMm.maxMm] } : null,
  });
}
