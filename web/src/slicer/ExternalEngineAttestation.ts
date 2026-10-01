import { normalizeHttpEndpoint } from '../net/LocalNetworkAccess';
import { PINNED_ENGINE_PROVENANCE } from './pinnedEngineProvenance';

export type EngineAttestation =
  { readonly attested: true; readonly commit: string } | { readonly attested: false; readonly reason: string };
export type VerifiedEngineAttestation =
  | { readonly attested: true; readonly commit: string; readonly artifactHash: string }
  | { readonly attested: false; readonly reason: string };
export type ExternalEngineFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>;

/** Probe an explicit candidate; never mutate or look up the active route. */
export async function attestExternalEndpoint(
  endpoint: string,
  fetcher: ExternalEngineFetcher,
  signal?: AbortSignal,
): Promise<VerifiedEngineAttestation> {
  let payload: unknown;
  try {
    const response = await fetcher(`${canonicalExternalEndpoint(endpoint)}/engine`, signal);
    if (!response.ok) {
      // The status separates the two ways this fails in practice, which
      // otherwise look identical from the browser: an old server has no
      // /engine route at all, and a secured one wants a token first.
      if (response.status === 401 || response.status === 403) {
        return {
          attested: false,
          reason: 'The external slicer requires a token before it will report its engine.',
        };
      }
      const status = response.status === undefined ? '' : ` (HTTP ${response.status})`;
      return {
        attested: false,
        reason: `The external slicer did not report its engine provenance${status}; update the slicer server to a build that serves /engine.`,
      };
    }
    payload = await response.json?.();
  } catch {
    return { attested: false, reason: 'The external slicer could not be reached to check its engine.' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { attested: false, reason: 'The external slicer returned a malformed engine attestation.' };
  }
  const record = payload as {
    schemaVersion?: unknown;
    engine?: unknown;
    attested?: unknown;
    reason?: unknown;
    artifacts?: unknown;
    patches?: unknown;
    upstream?: { commit?: unknown };
  };
  if (record.attested !== true) {
    const reason = typeof record.reason === 'string' ? record.reason : 'It reported no verifiable engine build.';
    return { attested: false, reason };
  }
  if (record.schemaVersion !== 1 || (record.engine !== 'wasm' && record.engine !== 'cli')) {
    return { attested: false, reason: 'The external slicer reported an unsupported engine attestation.' };
  }
  const artifacts = record.artifacts;
  if (typeof artifacts !== 'object' || artifacts === null) {
    return { attested: false, reason: 'The external slicer attested no engine artifacts.' };
  }
  if (record.upstream?.commit !== PINNED_ENGINE_PROVENANCE.commit) {
    return { attested: false, reason: 'The external slicer reports a different pinned engine commit.' };
  }
  const failure =
    record.engine === 'wasm'
      ? compareWasmArtifacts(artifacts as Record<string, unknown>)
      : compareCliPatches(record.patches);
  if (failure) return { attested: false, reason: failure };
  const digest = (artifacts as Record<string, unknown>)[record.engine === 'wasm' ? 'slic3r.wasm' : 'snapmaker-orca'];
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    return { attested: false, reason: 'The external slicer reported no complete engine artifact digest.' };
  }
  return { attested: true, commit: PINNED_ENGINE_PROVENANCE.commit, artifactHash: `sha256:${digest}` };
}

export function canonicalExternalEndpoint(value: string): string {
  const normalized = normalizeHttpEndpoint(value);
  if (!normalized) throw new Error('The captured external slicer endpoint is invalid.');
  const endpoint = new URL(normalized);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[?#]/.test(normalized)) {
    throw new Error('Canonical external slicer URLs cannot contain credentials, query parameters, or fragments.');
  }
  return normalized;
}

/** A WASM server must run byte-identical artifacts to the ones this client verified. */
function compareWasmArtifacts(declared: Record<string, unknown>): string | undefined {
  for (const [name, digest] of Object.entries(PINNED_ENGINE_PROVENANCE.artifacts)) {
    if (declared[name] !== digest) {
      return `The external slicer runs a different ${name} than this build verified.`;
    }
  }
  return undefined;
}

/**
 * A CLI server must run the pinned upstream commit with exactly the OrcaXR
 * patches this build knows. An unknown or altered patch changes what the
 * engine emits, so it is named rather than tolerated.
 */
function compareCliPatches(reported: unknown): string | undefined {
  if (!Array.isArray(reported)) {
    return 'The external slicer did not report which engine patches it was built with.';
  }
  const applied = new Map<string, unknown>();
  for (const entry of reported) {
    if (typeof entry !== 'object' || entry === null) return 'The external slicer reported a malformed engine patch.';
    const record = entry as { name?: unknown; sha256?: unknown };
    if (typeof record.name !== 'string' || applied.has(record.name)) {
      return 'The external slicer reported malformed or duplicate engine patches.';
    }
    applied.set(record.name, record.sha256);
  }
  const expected = PINNED_ENGINE_PROVENANCE.cliPatches as Readonly<Record<string, string>>;
  for (const [name, digest] of Object.entries(expected)) {
    if (!applied.has(name)) return `The external slicer was built without the ${name} engine patch.`;
    if (applied.get(name) !== digest) return `The external slicer carries a different ${name} than this build pins.`;
  }
  for (const name of applied.keys()) {
    if (!(name in expected)) return `The external slicer carries an engine patch this build does not know: ${name}.`;
  }
  return undefined;
}
