/**
 * The hosts' contract for where the workspace's transform gizmo stands
 * (`transformProxy.ts`, as `OrcaWorkspace.syncTransformProxy` places the
 * proxy and `captureSelectedInstanceOrigins` captures a drag's origins):
 * canonical JSON over a project and its assets, which the shared Rust core
 * answers from a session (`orcaxr_project::placement::gizmo::proxy_json`).
 *
 * `transformProxyExchange`: `{"primaryInstanceId","selectedInstanceIds"}` — the
 * selection summary the workspace reads: the primary selected instance (or
 * `null`) and every selected instance — → `{"origins","primaryInstanceId",
 * "proxy"}`: the primary and the selected instances on its plate with their
 * transforms, and the proxy's pose (`{"position","quaternion","scale"}`: one
 * instance's own, its quaternion normalized, or the centre of a selection's
 * bounds unrotated at unit scale); `{"proxy":null}` without a primary instance
 * the project has; or `{"error":"invalid_proxy","message"}` when the bounds
 * cannot be measured, in the workspace's words. A malformed request is refused
 * as `invalid_request`.
 */
import type { AssetRepository } from '../project/assets';
import { canonicalStringify } from '../project/domain/canonical';
import type { InstanceId } from '../project/domain/ids';
import type { ProjectState, Transform } from '../project/domain/model';
import { findInstance } from '../project/domain/selectors';
import { computeCanonicalInstanceBounds } from '../project/objects/bounds';
import { selectedInstanceOrigins, transformProxyPose } from './transformProxy';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';
/** The code of a selection whose proxy the workspace cannot place. */
export const INVALID_PROXY = 'invalid_proxy';

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
function read(json: string): Json {
  try {
    return JSON.parse(json) as Json;
  } catch {
    return invalid();
  }
}

const value = (number: number): number | null => (Number.isFinite(number) ? number : null);
const values = (list: readonly number[]): (number | null)[] => list.map(value);
const transformJson = (transform: Transform): Json => ({
  rotation: values(transform.rotation),
  scale: values(transform.scale),
  translationMm: values(transform.translationMm),
});

/** `{"primaryInstanceId","selectedInstanceIds"}` → the proxy's pose and the drag's origins. */
export function transformProxyExchange(state: ProjectState, assets: AssetRepository, requestJson: string): string {
  const fields = object(read(requestJson), ['primaryInstanceId', 'selectedInstanceIds']);
  const primary = fields.primaryInstanceId === null ? undefined : (text(fields.primaryInstanceId) as InstanceId);
  if (!Array.isArray(fields.selectedInstanceIds)) invalid();
  const selected = fields.selectedInstanceIds.map((id) => text(id) as InstanceId);
  // `CanonicalWorkspaceController.getInstance`, without the summary's other fields.
  const getInstance = (instanceId: InstanceId) => {
    const found = findInstance(state, instanceId);
    return found ? { plateId: found.plate.id, transform: found.instance.transform } : undefined;
  };
  const selection = selectedInstanceOrigins(
    { ...(primary ? { primaryInstanceId: primary } : {}), selectedInstanceIds: selected },
    getInstance,
  );
  if (!selection) return canonicalStringify({ proxy: null });
  try {
    const pose = transformProxyPose(selection, getInstance, (instanceIds) =>
      computeCanonicalInstanceBounds(state, assets, instanceIds),
    );
    if (!pose) return canonicalStringify({ proxy: null });
    return canonicalStringify({
      origins: selection.origins.map((origin) => ({
        instanceId: origin.instanceId,
        transform: transformJson(origin.transform),
      })),
      primaryInstanceId: selection.primaryInstanceId,
      proxy: { position: values(pose.position), quaternion: values(pose.quaternion), scale: values(pose.scale) },
    });
  } catch (error) {
    return canonicalStringify({ error: INVALID_PROXY, message: (error as Error).message });
  }
}
