/**
 * The hosts' contract for which plates a slice slices: a canonical JSON
 * request and reply, answered by the coordinator's own `selectPlateIds` behind
 * the workspace's refusal when there is nothing to slice (`sliceNow`: "No
 * models to slice."; `sliceAllPlates`: "No printable plate has models to
 * slice.", each over the summary's per-plate instance counts). The shared
 * Rust core answers the same requests (`orcaxr_project::slicing::plate::plan`).
 *
 * A request is `{"scope": "current-plate" | "all-plates", "stateJson": text}`.
 * The reply is `{"plateIds": [id]}` in slicing order, or `{"refusal": text}`.
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../domain/canonical';
import type { ProjectState } from '../domain/model';
import { selectPlateIds } from './SliceJobCoordinator';
import type { SliceJobScope } from './types';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}

/** The workspace's refusal before a slice of [scope] starts, when nothing it would slice holds a model. */
function nothingToSlice(state: ProjectState, scope: SliceJobScope): string | undefined {
  const instances = (plate: ProjectState['plates'][number]) =>
    plate.objects.reduce((count, object) => count + object.instances.length, 0);
  if (scope === 'current-plate') {
    const active = state.plates.find((plate) => plate.id === state.activePlateId);
    return active && instances(active) > 0 ? undefined : 'No models to slice.';
  }
  return state.plates.some((plate) => plate.printable && instances(plate) > 0)
    ? undefined
    : 'No printable plate has models to slice.';
}

/** `{"scope","stateJson"}` → the plates a slice of that scope slices, or why it slices none. */
export function slicePlanExchange(requestJson: string): string {
  let request: unknown;
  try {
    request = JSON.parse(requestJson);
  } catch {
    invalid();
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) invalid();
  const fields = request as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== 'scope,stateJson') invalid();
  const scope = fields.scope;
  if (scope !== 'current-plate' && scope !== 'all-plates') invalid();
  if (typeof fields.stateJson !== 'string') invalid();
  let state: ProjectState;
  try {
    state = JSON.parse(fields.stateJson) as ProjectState;
  } catch {
    invalid();
  }
  const refusal = nothingToSlice(state, scope);
  if (refusal) return canonicalStringify({ refusal });
  try {
    return canonicalStringify({ plateIds: selectPlateIds(state.activePlateId, state.plates, scope) });
  } catch (error) {
    return canonicalStringify({ refusal: (error as Error).message });
  }
}
