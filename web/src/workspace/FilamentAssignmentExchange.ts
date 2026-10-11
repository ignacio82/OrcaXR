/**
 * The hosts' contract for filament assignment (`FilamentAssignment.ts`): each
 * request and reply is a canonical JSON document about one project state,
 * every answer comes from the production module, and the shared Rust core
 * answers the same requests (`orcaxr_project::filaments::assignment`).
 *
 * A ref is `{"kind","id"}` with kind `plate`, `object`, `volume`, `instance`
 * or `layer-range` (an entity, kind `object`, `volume` or `layer-range`).
 * `filamentAssignmentExchange` answers `{"refs"}` with
 * `{"options","scopes","unsupportedSelection"}`;
 * `filamentAssignmentChangesExchange` answers `{"entities","filamentId"}`
 * (`null` inherits) with `{"assignments"}`. A ref the project lacks, or an
 * assignment the controller refuses, answers `{"error": message}` in the
 * browser's words. A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { FilamentId } from '../project/domain/ids';
import type { ProjectState } from '../project/domain/model';
import type { FilamentAssignmentChange } from '../project/filaments/commands';
import type { ObjectTreeEntityRef } from '../project/objects/types';
import {
  filamentAssignmentChanges,
  filamentAssignmentResolution,
  type CanonicalFilamentAssignableEntityRef,
  type CanonicalFilamentAssignmentScope,
  type CanonicalFilamentOption,
} from './FilamentAssignment';

/** Why a request could not be read. */
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
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function list(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}

const REF_KINDS = ['plate', 'object', 'volume', 'instance', 'layer-range'] as const;
const ENTITY_KINDS = ['object', 'volume', 'layer-range'] as const;

function ref<Kind extends string>(value: Json, kinds: readonly Kind[]): { kind: Kind; id: string } {
  const fields = object(value, ['id', 'kind']);
  const kind = text(fields.kind);
  if (!(kinds as readonly string[]).includes(kind)) invalid();
  return { kind: kind as Kind, id: text(fields.id) };
}
const refJson = (value: ObjectTreeEntityRef): Json => ({ id: value.id, kind: value.kind });

function optionJson(option: CanonicalFilamentOption): Json {
  return {
    color: option.color,
    enabled: option.enabled,
    id: option.id,
    kind: option.kind,
    name: option.name,
    ...(option.material !== undefined ? { material: option.material } : {}),
    ...(option.presetId !== undefined ? { presetId: option.presetId } : {}),
    ...(option.toolId !== undefined ? { toolId: option.toolId } : {}),
    ...(option.distributionMode !== undefined ? { distributionMode: option.distributionMode } : {}),
    recipe: option.recipe.map((component) => ({
      color: component.color,
      filamentId: component.filamentId,
      name: component.name,
      weight: component.weight,
    })),
    warnings: [...option.warnings],
  };
}
function scopeJson(scope: CanonicalFilamentAssignmentScope): Json {
  return {
    entity: refJson(scope.entity),
    label: scope.label,
    objectId: scope.objectId,
    ...(scope.localFilamentId !== undefined ? { localFilamentId: scope.localFilamentId } : {}),
    ...(scope.inheritedFilamentId !== undefined ? { inheritedFilamentId: scope.inheritedFilamentId } : {}),
    ...(scope.effectiveFilamentId !== undefined ? { effectiveFilamentId: scope.effectiveFilamentId } : {}),
  };
}
function assignmentJson(change: FilamentAssignmentChange): Json {
  const target = change.target;
  return {
    filamentId: change.filamentId,
    target:
      target.kind === 'object'
        ? { kind: 'object', objectId: target.objectId }
        : target.kind === 'volume'
          ? { kind: 'volume', objectId: target.objectId, volumeId: target.volumeId }
          : { kind: 'layer-range', layerRangeId: target.layerRangeId, objectId: target.objectId },
  };
}
/** A refusal the production module throws, in its own words. */
function refused(error: unknown): string {
  if (!(error instanceof Error) || error.message === INVALID_REQUEST) throw error;
  return canonicalStringify({ error: error.message });
}

/** `{"refs"}` → the selection's assignable scopes, what it cannot assign and every filament offered. */
export function filamentAssignmentExchange(state: ProjectState, requestJson: string): string {
  const request = object(read(requestJson), ['refs']);
  const refs = list(request.refs).map((value) => ref(value, REF_KINDS)) as ObjectTreeEntityRef[];
  try {
    const resolution = filamentAssignmentResolution(state, refs);
    return canonicalStringify({
      options: resolution.options.map(optionJson),
      scopes: resolution.scopes.map(scopeJson),
      unsupportedSelection: resolution.unsupportedSelection.map(refJson),
    });
  } catch (error) {
    return refused(error);
  }
}

/** `{"entities","filamentId"}` → the assignments one command submits. */
export function filamentAssignmentChangesExchange(state: ProjectState, requestJson: string): string {
  const request = object(read(requestJson), ['entities', 'filamentId']);
  const entities = list(request.entities).map((value) =>
    ref(value, ENTITY_KINDS),
  ) as CanonicalFilamentAssignableEntityRef[];
  const filamentId = request.filamentId === null ? null : (text(request.filamentId) as FilamentId);
  try {
    return canonicalStringify({
      assignments: filamentAssignmentChanges(state, entities, filamentId).map(assignmentJson),
    });
  } catch (error) {
    return refused(error);
  }
}
