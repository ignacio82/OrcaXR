/**
 * The hosts' contract for what a split would split (`SplitSource.ts`): each
 * request and reply is a canonical JSON document, every answer comes from the
 * production module, and the shared Rust core answers the same requests over
 * a captured project (`orcaxr_project::split::source_json`).
 *
 * A request is `{"instanceId": string, "target": "objects" | "parts",
 * "triangleLimit": positive safe integer}`: the selected instance, the split
 * asked for and the workspace's synchronous triangle limit. The reply is
 * `{"source": {"instanceIds", "objectId", "objectName", "plateId",
 * "strategy", "triangleCount", "volumeIds"}}`, or `{"refusal": message}` in
 * the workspace's words. A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../project/domain/canonical';
import type { InstanceId } from '../project/domain/ids';
import type { ProjectState } from '../project/domain/model';
import { splitSourceOf, type SplitSourceTarget } from './SplitSource';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}

/** `{"instanceId","target","triangleLimit"}` → the split's source or its refusal. */
export function splitSourceExchange(state: ProjectState, requestJson: string): string {
  let request: unknown;
  try {
    request = JSON.parse(requestJson);
  } catch {
    invalid();
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) invalid();
  const fields = request as Record<string, unknown>;
  const keys = ['instanceId', 'target', 'triangleLimit'];
  if (Object.keys(fields).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(fields, key))) {
    invalid();
  }
  const { instanceId, target, triangleLimit } = fields;
  if (typeof instanceId !== 'string') invalid();
  if (target !== 'objects' && target !== 'parts') invalid();
  if (typeof triangleLimit !== 'number' || !Number.isSafeInteger(triangleLimit) || triangleLimit < 1) invalid();
  let source;
  try {
    source = splitSourceOf(state, instanceId as InstanceId, target as SplitSourceTarget, triangleLimit);
  } catch (error) {
    return canonicalStringify({ refusal: (error as Error).message });
  }
  return canonicalStringify({
    source: {
      instanceIds: [...source.instanceIds],
      objectId: source.objectId,
      objectName: source.objectName,
      plateId: source.plateId,
      strategy: source.strategy,
      triangleCount: source.triangleCount,
      volumeIds: [...source.volumeIds],
    },
  });
}
