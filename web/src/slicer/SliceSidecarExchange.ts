/**
 * The hosts' contract for what binds a slice's output and its statistics
 * sidecar: canonical JSON requests and replies answered by the production
 * modules, which the shared Rust core answers the same way
 * (`orcaxr_project::slicing::sidecar`, `orcaxr_printer::slicer::route`).
 *
 * - profiles: `{"plateId","stateJson"}` → the effective profile snapshot a
 *   plate is sliced with (`CanonicalStateProfileResolver.capture`:
 *   `{"effectiveConfigHash","references"}`), or `{"error"}`.
 * - route: `{"endpoint","engine":{"artifactHash","commit"}}` → the external
 *   route's metadata (`CanonicalSlicerClientRoute.metadata`:
 *   `{"engine","id","kind","protocolVersion"}`), or `{"error"}`.
 * - binding: `{"binding": any}` → `{"valid": true}`, or `{"error"}` naming the
 *   first field `validateGcodeStatisticsBinding` refuses.
 *
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { PlateId } from '../project/domain/ids';
import type { ProjectState } from '../project/domain/model';
import { CanonicalStateProfileResolver } from '../project/slicing/profileResolver';
import { CanonicalSlicerClientRoute } from './CanonicalSlicerClientRoute';
import { validateGcodeStatisticsBinding } from './GcodeStatisticsModel';

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
function object(value: Json | undefined, keys: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `{"plateId","stateJson"}` → the plate's effective profile snapshot, or why there is none. */
export async function sliceProfilesExchange(requestJson: string): Promise<string> {
  const fields = object(read(requestJson), ['plateId', 'stateJson']);
  const plateId = text(fields.plateId) as PlateId;
  const state = read(text(fields.stateJson)) as unknown as ProjectState;
  try {
    return canonicalStringify(await new CanonicalStateProfileResolver().capture(state, plateId));
  } catch (error) {
    return canonicalStringify({ error: message(error) });
  }
}

/** `{"endpoint","engine"}` → the external route's metadata, or why it cannot be one. */
export function sliceRouteExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['endpoint', 'engine']);
  const engine = object(fields.engine, ['artifactHash', 'commit']);
  const endpoint = text(fields.endpoint);
  const externalEngine = { commit: text(engine.commit), artifactHash: text(engine.artifactHash) };
  try {
    const route = new CanonicalSlicerClientRoute({
      client: { sliceProjectWithRoute: async () => '' },
      route: { kind: 'external-server', endpoint },
      externalEngine,
    });
    return canonicalStringify(route.metadata);
  } catch (error) {
    return canonicalStringify({ error: message(error) });
  }
}

/** `{"binding"}` → whether it binds an output as a statistics sidecar's binding must. */
export function sliceBindingExchange(requestJson: string): string {
  const fields = object(read(requestJson), ['binding']);
  try {
    validateGcodeStatisticsBinding(fields.binding);
    return canonicalStringify({ valid: true });
  } catch (error) {
    return canonicalStringify({ error: message(error) });
  }
}
