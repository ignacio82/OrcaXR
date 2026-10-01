import type { KeyValueStorage } from '../settings/Preferences';
import { SLICER_CONNECTION_KEY, SLICER_ENABLED_KEY, SLICER_URL_KEY } from '../settings/Preferences';
import { canonicalExternalEndpoint, type EngineAttestation } from './ExternalEngineAttestation';

export type ExternalSlicerOrigin = 'user' | 'auto-discovered' | 'none';
export interface ExternalSlicerConfiguration {
  readonly endpoint: string;
  readonly enabled: boolean;
  readonly explicitlyDisabled: boolean;
  readonly origin: ExternalSlicerOrigin;
  /** A remembered proof is informational; each canonical slice still attests its engine. */
  readonly attestation: { readonly commit: string } | null;
}
export interface ExternalSlicerConnectionSnapshot extends ExternalSlicerConfiguration {
  readonly generation: number;
  readonly phase: 'idle' | 'probing' | 'connected' | 'failed' | 'disposed';
  readonly reason: string;
  readonly persistence: 'saved' | 'session-only';
  readonly configurationError: string;
}
export type ExternalSlicerProbe = (endpoint: string, signal: AbortSignal) => Promise<EngineAttestation>;
const empty = (): ExternalSlicerConfiguration => ({
  endpoint: '',
  enabled: false,
  explicitlyDisabled: false,
  origin: 'none',
  attestation: null,
});
const superseded = () => new Error('The external slicer connection attempt was superseded.');
const LEGACY_ORIGIN_KEY = 'oxr_slicer_origin';
const keys = [
  SLICER_CONNECTION_KEY,
  SLICER_URL_KEY,
  SLICER_ENABLED_KEY,
  LEGACY_ORIGIN_KEY,
  'external_slicer_url',
  'external_slicer_enabled',
] as const;

/** One coherent session route, independently cancellable probes, and one atomic persisted record. */
export class ExternalSlicerConnectionController {
  private state: ExternalSlicerConnectionSnapshot = Object.freeze({
    ...empty(),
    generation: 0,
    phase: 'idle',
    reason: '',
    persistence: 'saved',
    configurationError: '',
  });
  private observed: string | undefined;
  private observedStorage: KeyValueStorage | null = null;
  private sessionOverride = false;
  private pending: AbortController | null = null;
  private listeners = new Set<(state: ExternalSlicerConnectionSnapshot) => void>();
  private disposed = false;

  constructor(
    private readonly storage: () => KeyValueStorage | null,
    private readonly timeoutMs = 8_000,
  ) {
    this.refresh();
  }

  get snapshot(): ExternalSlicerConnectionSnapshot {
    this.refresh();
    return this.state;
  }

  subscribe(listener: (state: ExternalSlicerConnectionSnapshot) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Also called for storage events and preference import/reset, including a change back to identical bytes. */
  preferencesChanged(reset = false): void {
    if (this.disposed) return;
    this.invalidate();
    if (reset) {
      // Reset is an explicit intent even if browser storage rejected every
      // removal. Remember those old bytes without adopting their enabled route.
      let persistence: ExternalSlicerConnectionSnapshot['persistence'] = 'session-only';
      try {
        const storage = this.storage();
        if (storage) {
          const values = keys.map((key) => storage.getItem(key));
          this.observedStorage = storage;
          this.observed = JSON.stringify(values);
          if (values.every((value) => value === null)) persistence = 'saved';
        }
      } catch {
        /* Keep the reset session state while storage is unavailable. */
      }
      this.sessionOverride = true;
      this.publish({
        ...empty(),
        explicitlyDisabled: true,
        phase: 'idle',
        reason: '',
        persistence,
        configurationError: '',
      });
      return;
    }
    this.refresh();
  }

  /** Abandon pending work when an operator edits a candidate or credentials. */
  invalidate(): void {
    if (this.disposed) return;
    this.pending?.abort(superseded());
    this.pending = null;
    this.publish({
      generation: this.state.generation + 1,
      phase: this.state.enabled ? 'connected' : 'idle',
      reason: '',
    });
  }

  disable(): void {
    if (this.disposed) return;
    this.refresh();
    this.invalidate();
    this.commit({ ...this.configuration(), enabled: false, explicitlyDisabled: true, attestation: null });
  }

  clear(): void {
    if (this.disposed) return;
    this.invalidate();
    // Forget is a deliberate local-slicing choice, including on the next startup.
    this.commit({ ...empty(), explicitlyDisabled: true });
  }

  async connect(candidate: string, probe: ExternalSlicerProbe, origin: ExternalSlicerOrigin = 'user'): Promise<string> {
    if (this.disposed) throw superseded();
    this.disable();
    const endpoint = canonicalExternalEndpoint(candidate);
    const result = await this.probe(endpoint, origin, probe);
    if (!result.attested) throw new Error(result.reason);
    return endpoint;
  }

  async discover(
    candidate: string,
    probe: ExternalSlicerProbe,
  ): Promise<
    | { readonly discovered: true; readonly endpoint: string; readonly commit: string }
    | { readonly discovered: false; readonly reason: string }
  > {
    const state = this.snapshot;
    if (this.disposed || state.explicitlyDisabled || (state.endpoint && state.origin === 'user')) {
      return {
        discovered: false,
        reason: 'External slicing is disabled or a user-configured endpoint is already set.',
      };
    }
    try {
      const endpoint = canonicalExternalEndpoint(candidate);
      const proof = await this.probe(endpoint, 'auto-discovered', probe);
      return proof.attested
        ? { discovered: true, endpoint, commit: proof.commit }
        : { discovered: false, reason: proof.reason };
    } catch (error) {
      return { discovered: false, reason: error instanceof Error ? error.message : 'The discovery request failed.' };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    this.publish({ enabled: false, attestation: null, phase: 'disposed' });
    this.listeners.clear();
  }

  private async probe(
    endpoint: string,
    origin: ExternalSlicerOrigin,
    probe: ExternalSlicerProbe,
  ): Promise<EngineAttestation> {
    this.invalidate();
    const generation = this.state.generation;
    const abort = new AbortController();
    this.pending = abort;
    this.publish({ phase: 'probing', reason: '' });
    const timer = setTimeout(() => abort.abort(new Error('The external slicer connection timed out.')), this.timeoutMs);
    let removeAbort = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        const onAbort = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => abort.signal.removeEventListener('abort', onAbort);
      });
      // The deadline covers both fetch and response parsing, even for a probe that ignores abort.
      const proof = await Promise.race([
        Promise.resolve().then(() => {
          if (abort.signal.aborted) throw abort.signal.reason;
          return probe(endpoint, abort.signal);
        }),
        cancelled,
      ]);
      this.refresh();
      if (this.disposed || generation !== this.state.generation || abort.signal.aborted) throw superseded();
      if (!proof.attested) {
        this.publish({ phase: 'failed', reason: proof.reason });
        return proof;
      }
      this.commit({
        endpoint,
        enabled: true,
        explicitlyDisabled: false,
        origin,
        attestation: Object.freeze({ commit: proof.commit }),
      });
      return proof;
    } catch (error) {
      if (!this.disposed && generation === this.state.generation) {
        this.publish({ phase: 'failed', reason: error instanceof Error ? error.message : 'The connection failed.' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      removeAbort();
      if (this.pending === abort) this.pending = null;
    }
  }

  private configuration(): ExternalSlicerConfiguration {
    const { endpoint, enabled, explicitlyDisabled, origin, attestation } = this.state;
    return { endpoint, enabled, explicitlyDisabled, origin, attestation };
  }

  private commit(configuration: ExternalSlicerConfiguration): void {
    this.sessionOverride = true;
    let persistence: ExternalSlicerConnectionSnapshot['persistence'] = 'session-only';
    try {
      const storage = this.storage();
      if (storage) {
        const encoded = JSON.stringify({ version: 1, ...configuration });
        storage.setItem(SLICER_CONNECTION_KEY, encoded);
        // Legacy values remain migration inputs only; the atomic record wins.
        this.observedStorage = storage;
        this.observed = JSON.stringify(
          keys.map((key) => (key === SLICER_CONNECTION_KEY ? encoded : storage.getItem(key))),
        );
        this.sessionOverride = false;
        persistence = 'saved';
      }
    } catch {
      /* The session route remains usable when browser storage is blocked or full. */
    }
    this.publish({
      ...configuration,
      persistence,
      phase: configuration.enabled ? 'connected' : 'idle',
      reason: '',
      configurationError: '',
    });
  }

  private refresh(): void {
    if (this.disposed) return;
    try {
      const storage = this.storage();
      if (!storage) throw new Error('Storage unavailable');
      const values = keys.map((key) => storage.getItem(key));
      const signature = JSON.stringify(values);
      if (storage === this.observedStorage && signature === this.observed) return;
      if (this.observed === undefined && this.sessionOverride) {
        this.observedStorage = storage;
        this.observed = signature;
        return;
      }
      this.observedStorage = storage;
      this.observed = signature;
      this.sessionOverride = false;
      this.invalidate();
      const configuration = decodeConfiguration(values);
      this.publish({
        ...configuration,
        phase: configuration.configurationError ? 'failed' : configuration.enabled ? 'connected' : 'idle',
        reason: configuration.configurationError ?? '',
        configurationError: configuration.configurationError ?? '',
        persistence: 'saved',
      });
    } catch {
      if (this.state.persistence !== 'session-only') this.publish({ persistence: 'session-only' });
    }
  }

  private publish(update: Partial<ExternalSlicerConnectionSnapshot>): void {
    this.state = Object.freeze({ ...this.state, ...update });
    for (const listener of this.listeners) listener(this.state);
  }
}

function decodeConfiguration(
  values: readonly (string | null)[],
): ExternalSlicerConfiguration & { configurationError?: string } {
  const [record, url, enabled, origin, legacyUrl, legacyEnabled] = values;
  if (record !== null) {
    try {
      const value = JSON.parse(record) as ExternalSlicerConfiguration & { version: unknown };
      if (
        value.version !== 1 ||
        typeof value.endpoint !== 'string' ||
        typeof value.enabled !== 'boolean' ||
        typeof value.explicitlyDisabled !== 'boolean' ||
        !['user', 'auto-discovered', 'none'].includes(value.origin)
      )
        throw new Error();
      const endpoint = value.endpoint ? canonicalExternalEndpoint(value.endpoint) : '';
      const commit = value.attestation?.commit;
      if (
        value.enabled &&
        (!endpoint || value.explicitlyDisabled || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit))
      )
        throw new Error();
      return {
        endpoint,
        enabled: value.enabled,
        explicitlyDisabled: value.explicitlyDisabled,
        origin: endpoint ? (value.origin === 'auto-discovered' ? 'auto-discovered' : 'user') : 'none',
        attestation: value.enabled ? Object.freeze({ commit: commit! }) : null,
      };
    } catch {
      return {
        ...empty(),
        explicitlyDisabled: true,
        configurationError: 'Saved external slicer preferences are invalid. Connect to verify a server.',
      };
    }
  }
  try {
    const endpoint = url ?? legacyUrl ?? '';
    const optedIn = enabled ?? legacyEnabled;
    return {
      endpoint: endpoint ? canonicalExternalEndpoint(endpoint) : '',
      enabled: Boolean(endpoint) && optedIn === 'true',
      explicitlyDisabled: optedIn === 'false',
      origin: endpoint ? (origin === 'auto-discovered' ? 'auto-discovered' : 'user') : 'none',
      attestation: null,
    };
  } catch (error) {
    return {
      ...empty(),
      explicitlyDisabled: true,
      configurationError: error instanceof Error ? error.message : 'Saved external slicer preferences are invalid.',
    };
  }
}
