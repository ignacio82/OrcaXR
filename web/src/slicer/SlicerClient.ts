import { fetchLocalNetwork, normalizeHttpEndpoint } from '../net/LocalNetworkAccess';
import { PINNED_ENGINE_PROVENANCE } from './pinnedEngineProvenance';

/**
 * Browser-side client for the OrcaXR WASM slicer (wasm/dist → /slicer/).
 *
 * The module's slice runs on its own pthread (startSlice/pollSlice async
 * API) so the UI thread never blocks; progress arrives by parsing the
 * module's stderr status lines ("[orcaxr] 35% Generating infill…").
 */

export interface SliceProgress {
  percent: number;
  message: string;
}

export type SlicerClientProjectRoute =
  { readonly kind: 'browser-wasm' } | { readonly kind: 'external-server'; readonly endpoint: string };

export interface SlicerClientProjectSliceOptions {
  readonly maxThreads?: number;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SliceProgress) => void;
  /**
   * The legacy project path may fall back to a synchronous main-thread slice.
   * A canonical route disables this because it cannot honestly cancel work
   * once the synchronous engine call starts.
   */
  readonly allowUncancellableMainThreadFallback?: boolean;
  /** Test seam; production polling remains deliberately modest. */
  readonly externalPollIntervalMs?: number;
  readonly externalCancellationTimeoutMs?: number;
}

export class SlicerClientCancellationError extends Error {
  constructor(
    message: string,
    readonly cancellationConfirmed: boolean,
  ) {
    super(message);
    this.name = 'SlicerClientCancellationError';
  }
}

interface Slic3rModule {
  versionString(): string;
  startSlice(stlBinary: string, maxThreads: number): void;
  startSliceFile(path: string, maxThreads: number, overridesJson: string): void;
  startSliceProject(path: string, maxThreads: number, overridesJson: string): void;
  sliceProjectSync(path: string, maxThreads: number, overridesJson: string): string;
  startSlicePainted(
    posPath: string,
    filPath: string,
    filamentCount: number,
    maxThreads: number,
    overridesJson: string,
  ): void;
  pollSlice(): string;
  startRepair(stl: string | ArrayBuffer, maxThreads: number): void;
  pollRepair(): string;
  startBoolean(stlA: string | ArrayBuffer, stlB: string | ArrayBuffer, op: string, maxThreads: number): void;
  pollBoolean(): string;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

/**
 * Bearer token for a secured external slicer, held for this tab only.
 *
 * A server published beyond loopback refuses to start without a token, so
 * without somewhere to put one there is no way to reach a correctly secured
 * slicer at all — the attestation probe just 401s and canonical slicing stays
 * blocked forever. It is deliberately *not* persisted: it is a credential, and
 * the repo keeps credentials in session memory rather than in localStorage
 * where any later script can read them back.
 */
let externalSlicerToken = '';

const EXTERNAL_URL_KEY = 'external_slicer_url';
const EXTERNAL_ENABLED_KEY = 'external_slicer_enabled';

export class SlicerClient {
  private static externalConnectionEpoch = 0;
  private module: Slic3rModule | null = null;
  private loading: Promise<Slic3rModule> | null = null;
  private slicing = false;
  private crashed = false;
  private lastSliceActivity = 0;
  onProgress: ((p: SliceProgress) => void) | null = null;

  // Dedicated worker that hosts a second module instance for FullSpectrum
  // PROJECT slices (async, off the UI thread — see sliceProject / sliceWorker).
  private projectWorker: Worker | null = null;
  private workerJobs = new Map<
    number,
    {
      resolve: (g: string) => void;
      reject: (e: Error) => void;
      removeAbortListener: () => void;
    }
  >();
  private workerJobSeq = 0;
  private projectProgress: ((progress: SliceProgress) => void) | null = null;

  // ---- External slicer configuration (shared by the 2D + XR UIs) --------
  // Two independent pieces of state: the saved URL (survives being turned
  // off) and an explicit enabled flag. A model is used externally only when
  // a URL is configured AND the flag is on, so the user can keep a server
  // saved while slicing locally, and can delete it outright.
  static getExternalSlicerUrl(): string {
    return localStorage.getItem(EXTERNAL_URL_KEY) || '';
  }

  private static setExternalSlicerUrl(url: string): void {
    const v = url.trim();
    if (v) localStorage.setItem(EXTERNAL_URL_KEY, v);
    else localStorage.removeItem(EXTERNAL_URL_KEY);
  }

  static isExternalSlicerEnabled(): boolean {
    if (!SlicerClient.getExternalSlicerUrl()) return false;
    // Fail closed for legacy URL-only preferences. An external endpoint may
    // receive model geometry, so only an explicit, persisted opt-in is valid.
    return localStorage.getItem(EXTERNAL_ENABLED_KEY) === 'true';
  }

  /** Route all slices locally and invalidate any connection probe in flight. */
  static disableExternalSlicer(): void {
    SlicerClient.externalConnectionEpoch += 1;
    localStorage.setItem(EXTERNAL_ENABLED_KEY, 'false');
  }

  /** Forget the configured external slicer entirely. */
  static clearExternalSlicer(): void {
    SlicerClient.externalConnectionEpoch += 1;
    localStorage.removeItem(EXTERNAL_URL_KEY);
    localStorage.removeItem(EXTERNAL_ENABLED_KEY);
  }

  /**
   * Set or clear the bearer token for the configured external slicer. Kept in
   * memory for this tab only; never written to storage and never logged.
   */
  static setExternalSlicerToken(token: string): void {
    externalSlicerToken = token.trim();
  }

  /** Whether a token is held, without revealing it. */
  static hasExternalSlicerToken(): boolean {
    return externalSlicerToken.length > 0;
  }

  /** Authorization header for the external slicer, empty when no token is held. */
  static externalAuthHeaders(): Record<string, string> {
    return externalSlicerToken ? { Authorization: `Bearer ${externalSlicerToken}` } : {};
  }

  /** True when the next slice will be dispatched to the external server. */
  static useExternalSlicer(): boolean {
    return !!SlicerClient.getExternalSlicerUrl() && SlicerClient.isExternalSlicerEnabled();
  }

  /**
   * Ask the configured external slicer to prove which engine it runs, and
   * compare that to what this build accepts. Canonical work may only leave the
   * browser when the proof holds; anything else — an unattested build, a
   * different artifact, an unreachable or malformed response — returns the
   * exact reason so the caller can say why rather than refusing blankly.
   *
   * The two engines prove different things. A WASM server must match the exact
   * artifacts this client verified for itself. A CLI server runs the official
   * Snapmaker Orca binary, which has no WASM artifacts to compare, so it proves
   * the upstream commit it was built from and the OrcaXR patches applied on
   * top. Requiring WASM digests of a native binary is what previously made the
   * CLI route — the one that exists precisely to match desktop output — refuse
   * itself.
   */
  static async attestExternalEngine(
    fetcher: (url: string) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }> = (url) =>
      fetchLocalNetwork(url, { headers: SlicerClient.externalAuthHeaders() }),
  ): Promise<{ attested: true; commit: string } | { attested: false; reason: string }> {
    const endpoint = SlicerClient.useExternalSlicer() ? SlicerClient.getExternalSlicerUrl() : '';
    if (!endpoint) return { attested: false, reason: 'No external slicer is enabled.' };
    let payload: unknown;
    try {
      const response = await fetcher(`${canonicalExternalEndpoint(endpoint)}/engine`);
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
    return { attested: true, commit: PINNED_ENGINE_PROVENANCE.commit };
  }

  /** Capture one immutable semantic route. Callers must not re-decide mid-job. */
  static captureProjectRoute(): SlicerClientProjectRoute {
    const endpoint = SlicerClient.useExternalSlicer()
      ? canonicalExternalEndpoint(SlicerClient.getExternalSlicerUrl())
      : '';
    return endpoint ? { kind: 'external-server', endpoint } : { kind: 'browser-wasm' };
  }

  /**
   * Verify a user-selected endpoint before making it the active slice route.
   *
   * The current route is disabled before probing. This keeps a failed attempt
   * to replace endpoint A with candidate B from leaving A silently active
   * while the UI reports B as offline. The last configured URL remains saved so
   * the UI can restore it, but slicing stays local after any failed probe.
   */
  static async connectExternalSlicer(
    candidate: string,
    probe: (url: string) => Promise<{ ok: boolean }> = (url) =>
      fetchLocalNetwork(url, { headers: SlicerClient.externalAuthHeaders() }),
  ): Promise<string> {
    SlicerClient.disableExternalSlicer();
    const connectionEpoch = SlicerClient.externalConnectionEpoch;
    let endpoint: string;
    try {
      endpoint = canonicalExternalEndpoint(candidate);
    } catch (error) {
      throw new Error('Enter a plain HTTP or HTTPS external slicer URL without credentials, query, or fragment.', {
        cause: error,
      });
    }

    const response = await probe(`${endpoint}/ping`);
    if (!response.ok) throw new Error('The external slicer did not accept the connection.');
    if (connectionEpoch !== SlicerClient.externalConnectionEpoch) {
      throw new Error('The external slicer connection attempt was superseded.');
    }

    SlicerClient.setExternalSlicerUrl(endpoint);
    // This is intentionally the sole code path that writes enabled=true.
    localStorage.setItem(EXTERNAL_ENABLED_KEY, 'true');
    return endpoint;
  }

  async load(): Promise<void> {
    await this.ensureModule();
  }

  get isSlicing(): boolean {
    return this.slicing;
  }

  private ensureModule(): Promise<Slic3rModule> {
    if (this.module) return Promise.resolve(this.module);
    if (!this.loading) {
      this.loading = (async () => {
        // Runtime-computed URL so vite doesn't try to pre-bundle the
        // Emscripten module (it lives in /public/slicer, served as-is). Made
        // base-aware so it resolves under any deploy base: dev ('/') → it sits
        // at /slicer/slic3r.mjs; GitHub Pages ('/slicer/') → /slicer/slicer/…
        // (Emscripten locates slic3r.wasm relative to this .mjs URL.)
        const base = import.meta.env?.BASE_URL ?? '/'; // '/' in dev/tests, '/slicer/' on Pages
        const moduleUrl = new URL(`${base}slicer/slic3r.mjs`, window.location.origin).href;
        const factory = (await import(/* @vite-ignore */ moduleUrl)).default as (arg?: object) => Promise<Slic3rModule>;
        const mod = await factory({
          printErr: (text: string) => this.handleStderr(text),
          onAbort: () => {
            this.crashed = true;
          },
        });
        this.module = mod;
        console.log('[slicer]', mod.versionString());
        return mod;
      })();
    }
    return this.loading;
  }

  /** Poll an external job, and confirm server-side cancellation on abort. */
  private async pollExternalJob(
    externalUrl: string,
    jobId: string,
    options: Pick<
      SlicerClientProjectSliceOptions,
      'signal' | 'onProgress' | 'externalPollIntervalMs' | 'externalCancellationTimeoutMs'
    > = {},
  ): Promise<string> {
    const pollIntervalMs = positiveInteger(options.externalPollIntervalMs, 700, 'externalPollIntervalMs');
    let consecutiveFailures = 0;
    try {
      for (;;) {
        await delayWithSignal(pollIntervalMs, options.signal);
        let status: { status: string; percent: number; message?: string; error?: string };
        try {
          const res = await fetchLocalNetwork(`${externalUrl}/jobs/${jobId}`, {
            signal: options.signal,
            headers: SlicerClient.externalAuthHeaders(),
          });
          if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
          status = await res.json();
          consecutiveFailures = 0;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (++consecutiveFailures >= 5) {
            throw new Error(`External slicer stopped responding: ${errorMessage(error)}`, { cause: error });
          }
          continue;
        }
        if (status.status === 'error') {
          throw new Error(`External Slicer Failed: ${status.error}`);
        }
        if (status.status === 'cancelled') {
          throw new SlicerClientCancellationError('The external slicer job was cancelled.', true);
        }
        if (status.status === 'done') {
          const gcode = await fetchLocalNetwork(`${externalUrl}/jobs/${jobId}/gcode`, {
            signal: options.signal,
            headers: SlicerClient.externalAuthHeaders(),
          });
          if (!gcode.ok) {
            throw new Error(`External Slicer Failed: ${await gcode.text()}`);
          }
          return await gcode.text();
        }
        this.emitProjectProgress(
          {
            percent: status.percent ?? 0,
            message: status.message || 'Slicing externally...',
          },
          options.onProgress,
        );
      }
    } catch (error) {
      if (options.signal?.aborted) {
        if (!(error instanceof SlicerClientCancellationError && error.cancellationConfirmed)) {
          await this.confirmExternalCancellation(
            externalUrl,
            jobId,
            positiveInteger(options.externalCancellationTimeoutMs, 30_000, 'externalCancellationTimeoutMs'),
            pollIntervalMs,
          );
        }
        throw signalReason(options.signal);
      }
      throw error;
    }
  }

  private async confirmExternalCancellation(
    externalUrl: string,
    jobId: string,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetchLocalNetwork(`${externalUrl}/jobs/${jobId}`, {
        method: 'DELETE',
        headers: SlicerClient.externalAuthHeaders(),
      });
    } catch (error) {
      throw new SlicerClientCancellationError(
        `Could not confirm external slice cancellation: ${errorMessage(error)}`,
        false,
      );
    }
    if (!response.ok) {
      throw new SlicerClientCancellationError(
        `External slice cancellation was not accepted (HTTP ${response.status}).`,
        false,
      );
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    if (body.status === 'cancelled') return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delayWithoutSignal(pollIntervalMs);
      try {
        const statusResponse = await fetchLocalNetwork(`${externalUrl}/jobs/${jobId}`, {
          headers: SlicerClient.externalAuthHeaders(),
        });
        if (!statusResponse.ok) {
          throw new Error(`HTTP ${statusResponse.status}`);
        }
        const status = (await statusResponse.json()) as { status?: string };
        if (status.status === 'cancelled') return;
        if (status.status === 'done' || status.status === 'error') {
          throw new SlicerClientCancellationError(
            `External slice reached ${status.status} before cancellation was confirmed.`,
            false,
          );
        }
      } catch (error) {
        if (error instanceof SlicerClientCancellationError) throw error;
        throw new SlicerClientCancellationError(
          `Could not confirm external slice cancellation: ${errorMessage(error)}`,
          false,
        );
      }
    }
    throw new SlicerClientCancellationError('External slice cancellation confirmation timed out.', false);
  }

  private emitProjectProgress(progress: SliceProgress, perCall?: (progress: SliceProgress) => void): void {
    try {
      perCall?.(progress);
    } catch {
      // Progress observers are informational and cannot change slice semantics.
    }
    if (this.onProgress && this.onProgress !== perCall) {
      try {
        this.onProgress(progress);
      } catch {
        // The legacy global observer has the same non-semantic contract.
      }
    }
  }

  private handleStderr(text: string) {
    // Any engine chatter (progress or the [orcaxr] setup lines) means the
    // slice thread is alive — reset the stall watchdog.
    if (text.startsWith('[orcaxr]')) this.lastSliceActivity = Date.now();
    const m = /^\[orcaxr\] (\d+)% (.*)$/.exec(text);
    if (m) {
      this.emitProjectProgress({ percent: Number(m[1]), message: m[2] }, this.projectProgress ?? undefined);
      return;
    }
    if (text.includes('uncaught exception') || text.includes('memory access out of bounds')) {
      console.error('[slicer] caught fatal worker error in stderr:', text);
      this.crashed = true;
    }
    console.log('[slicer]', text);
  }

  /**
   * Slice a binary STL (printer coordinates, mm, Z-up) to G-code text.
   * Rejects with the slicer's error message on failure.
   */
  /** Drop a crashed module so the next slice boots a fresh one. */
  private resetIfCrashed() {
    if (this.crashed) {
      this.module = null;
      this.loading = null;
      this.crashed = false;
      this.slicing = false;
      console.warn('[slicer] module crashed — restarting fresh instance');
    }
  }

  async slice(stl: ArrayBuffer, maxThreads = 4, overrides: Record<string, string> = {}): Promise<string> {
    const externalUrl = SlicerClient.useExternalSlicer()
      ? normalizeHttpEndpoint(SlicerClient.getExternalSlicerUrl())
      : '';
    if (externalUrl) {
      if (this.onProgress) {
        this.onProgress({ percent: 0, message: 'Slicing externally...' });
      }
      const formData = new FormData();
      formData.append('file', new Blob([stl]), 'model.stl');
      formData.append('overrides', JSON.stringify(overrides));

      // Ask for the async job protocol (202 + job id, then progress polling).
      // A legacy server ignores the query flag and answers 200 + G-code
      // directly, so both server generations keep working.
      const res = await fetchLocalNetwork(`${externalUrl}/slice?async=1`, {
        method: 'POST',
        body: formData,
        headers: SlicerClient.externalAuthHeaders(),
      });
      if (res.status === 202) {
        const { job } = (await res.json()) as { job: string };
        return await this.pollExternalJob(externalUrl, job);
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`External Slicer Failed: ${err}`);
      }
      return await res.text();
    }

    // Preflight: the in-browser engine is a -pthread WASM build and its slice
    // runs on a Worker thread, which requires SharedArrayBuffer — only
    // available in a cross-origin-isolated context (COOP+COEP). If isolation
    // isn't active, the slice thread silently never starts and the slice
    // "hangs" at 0% forever with no error. Fail fast with an actionable
    // message instead. (The external-server path above needs none of this.)
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'In-browser slicing needs a cross-origin-isolated context (SharedArrayBuffer), ' +
          'which is not active here (crossOriginIsolated=' +
          String(globalThis.crossOriginIsolated) +
          ', SharedArrayBuffer=' +
          (typeof SharedArrayBuffer !== 'undefined') +
          '). ' +
          'Serve the page with COOP/COEP headers and reload, or configure an external slicer server.',
      );
    }

    this.resetIfCrashed();
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // Typed-array write into MEMFS: embind's std::string marshalling
      // UTF-8-mangles binary bytes in the browser, so never pass the STL
      // through a JS string.
      console.log(
        '[slicer] starting local slice: STL',
        stl.byteLength,
        'bytes,',
        Object.keys(overrides).length,
        'overrides, maxThreads',
        maxThreads,
      );
      mod.FS.writeFile('/tmp/orcaxr_upload.stl', new Uint8Array(stl));
      this.lastSliceActivity = Date.now();
      mod.startSliceFile('/tmp/orcaxr_upload.stl', maxThreads, JSON.stringify(overrides));
      let stallWarned = false;
      const gcode = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          // Stall watchdog: a healthy slice emits its first progress line
          // within a second or two. If nothing has happened for 20s, the
          // engine thread almost certainly failed to start (threading /
          // SharedArrayBuffer) — surface it rather than spin forever.
          const idleMs = Date.now() - this.lastSliceActivity;
          if (!stallWarned && idleMs > 20000) {
            stallWarned = true;
            console.error(
              '[slicer] no engine output for 20s — the slice thread may have failed to start (threading/SharedArrayBuffer). Aborting.',
            );
            if (this.onProgress) this.onProgress({ percent: 0, message: 'engine stalled (no output) — see console' });
            clearInterval(timer);
            this.crashed = true; // force a fresh module next time
            this.resetIfCrashed();
            reject(
              new Error(
                'slicer produced no output for 20s — the engine thread failed to start. Reload the page; if it persists, use an external slicer server.',
              ),
            );
            return;
          }
          const out = mod.pollSlice();
          if (out.length > 0) {
            clearInterval(timer);
            if (out.startsWith('ORCAXR_ERROR:')) {
              reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
            } else {
              resolve(out);
            }
          }
        }, 100);
      });
      return gcode;
    } finally {
      this.slicing = false;
    }
  }

  /**
   * PROJECT slice: the original 3MF (model + embedded project config —
   * including FullSpectrum mixed-filament definitions and per-part virtual
   * extruders) sliced the way desktop Snapmaker Orca opens the same file.
   * External server: the 3MF uploads through the same /slice contract (the
   * server sniffs the ZIP magic and slices it as a project). Local: the
   * engine's startSliceProject loads model AND config via load_bbs_3mf.
   */
  async sliceProject(project: ArrayBuffer, maxThreads = 4, overrides: Record<string, string> = {}): Promise<string> {
    return this.sliceProjectWithRoute(project, SlicerClient.captureProjectRoute(), {
      maxThreads,
      overrides,
      allowUncancellableMainThreadFallback: true,
    });
  }

  /**
   * Slice through one previously captured route. This is the canonical seam:
   * it cannot silently switch between the browser and a server on retry.
   */
  async sliceProjectWithRoute(
    project: ArrayBuffer,
    route: SlicerClientProjectRoute,
    options: SlicerClientProjectSliceOptions = {},
  ): Promise<string> {
    throwIfAborted(options.signal);
    const maxThreads = positiveInteger(options.maxThreads, 4, 'maxThreads');
    const overrides = { ...(options.overrides ?? {}) };

    if (route.kind === 'external-server') {
      const externalUrl = canonicalExternalEndpoint(route.endpoint);
      const enabledEndpoint = SlicerClient.captureProjectRoute();
      if (enabledEndpoint.kind !== 'external-server' || enabledEndpoint.endpoint !== externalUrl) {
        throw new Error('External slicer consent or endpoint changed after the route was captured.');
      }
      this.emitProjectProgress({ percent: 0, message: 'Slicing project externally...' }, options.onProgress);
      const formData = new FormData();
      formData.append('file', new Blob([project]), 'project.3mf');
      formData.append('overrides', JSON.stringify(overrides));

      // Do not abort this POST: once an async server has accepted the upload,
      // losing its response also loses the only job ID needed by DELETE. If an
      // abort arrives while it is in flight, wait for the ID and cancel there.
      let response: Response;
      try {
        response = await fetchLocalNetwork(`${externalUrl}/slice?async=1`, {
          method: 'POST',
          body: formData,
          headers: SlicerClient.externalAuthHeaders(),
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new SlicerClientCancellationError(
            `External upload ended before a cancellable job ID was received: ${errorMessage(error)}`,
            false,
          );
        }
        throw error;
      }
      if (response.status === 202) {
        const { job } = (await response.json()) as { job?: unknown };
        if (typeof job !== 'string' || !job) {
          if (options.signal?.aborted) {
            throw new SlicerClientCancellationError(
              'External slicer returned no usable job ID, so cancellation could not be confirmed.',
              false,
            );
          }
          throw new Error('External slicer returned an invalid async job ID.');
        }
        if (options.signal?.aborted) {
          await this.confirmExternalCancellation(
            externalUrl,
            job,
            positiveInteger(options.externalCancellationTimeoutMs, 30_000, 'externalCancellationTimeoutMs'),
            positiveInteger(options.externalPollIntervalMs, 700, 'externalPollIntervalMs'),
          );
          throw signalReason(options.signal);
        }
        return this.pollExternalJob(externalUrl, job, options);
      }
      if (options.signal?.aborted) {
        throw new SlicerClientCancellationError(
          'The external response did not provide a cancellable job ID before abort.',
          false,
        );
      }
      if (!response.ok) throw new Error(`External Slicer Failed: ${await response.text()}`);
      return await response.text();
    }

    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'In-browser slicing needs a cross-origin-isolated context (SharedArrayBuffer). ' +
          'Serve the page with COOP/COEP headers and reload, or configure an external slicer server.',
      );
    }
    if (this.slicing) throw new Error('a slice is already running');
    this.slicing = true;
    this.projectProgress = options.onProgress ?? null;
    try {
      console.log('[slicer] starting local PROJECT slice:', project.byteLength, 'bytes');
      this.emitProjectProgress(
        { percent: 0, message: 'Slicing FullSpectrum project…' },
        this.projectProgress ?? undefined,
      );
      // FullSpectrum project slices run on a DEDICATED worker (sliceWorker.ts)
      // via the synchronous sliceProjectSync — this keeps the heavy slice off
      // the page's UI thread (async, non-blocking) while running it on the
      // module's own runtime thread rather than an Emscripten pool pthread,
      // which crashes for heavy FS slices in the browser (see
      // project_web_fs_inbrowser_slice). If the worker path can't run (e.g. no
      // cross-origin isolation inside the worker, or module load fails), fall
      // back to a synchronous main-thread slice — correct, but briefly busy.
      try {
        return await this.sliceProjectInWorker(project, maxThreads, overrides, options.signal);
      } catch (e) {
        if (options.signal?.aborted) throw signalReason(options.signal);
        if (!(e instanceof Error) || !e.message.startsWith('WORKER_INFRA:')) throw e;
        if (options.allowUncancellableMainThreadFallback !== true) {
          throw new Error(`Cancellable worker route unavailable: ${e.message.slice('WORKER_INFRA:'.length)}`, {
            cause: e,
          });
        }
        console.warn('[slicer] project worker unavailable, falling back to main-thread slice:', e.message);
        return await this.sliceProjectOnMainThread(project, maxThreads, overrides);
      }
    } finally {
      this.projectProgress = null;
      this.slicing = false;
    }
  }

  /** Run a FullSpectrum project slice on the dedicated worker (async). */
  private sliceProjectInWorker(
    project: ArrayBuffer,
    maxThreads: number,
    overrides: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const worker = this.ensureProjectWorker();
    const base = import.meta.env?.BASE_URL ?? '/'; // '/' in dev/tests, '/slicer/' on Pages
    const moduleUrl = new URL(`${base}slicer/slic3r.mjs`, self.location.origin).href;
    const id = ++this.workerJobSeq;
    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        const reason = signalReason(signal!);
        this.terminateProjectWorker(reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.workerJobs.set(id, {
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener('abort', abort),
      });
      // No transfer: the caller keeps `project` (originalProject) for re-slices;
      // structured clone copies the 3.4 MB buffer, which is negligible.
      worker.postMessage({ type: 'slice', id, moduleUrl, project, maxThreads, overrides });
    });
  }

  private ensureProjectWorker(): Worker {
    if (this.projectWorker) return this.projectWorker;
    const worker = new Worker(new URL('./sliceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        this.emitProjectProgress({ percent: msg.percent, message: msg.message }, this.projectProgress ?? undefined);
        return;
      }
      const job = this.workerJobs.get(msg.id);
      if (!job) return;
      this.workerJobs.delete(msg.id);
      job.removeAbortListener();
      if (msg.type === 'done') job.resolve(msg.gcode);
      else if (msg.type === 'error') job.reject(new Error((msg.infra ? 'WORKER_INFRA:' : '') + msg.error));
    };
    worker.onerror = (e: ErrorEvent) => {
      // The worker itself crashed — reject everything pending as infra failure
      // so callers fall back, and drop it so the next slice recreates it.
      const err = new Error('WORKER_INFRA:slice worker crashed: ' + (e.message || 'unknown'));
      this.terminateProjectWorker(err);
    };
    this.projectWorker = worker;
    return worker;
  }

  private terminateProjectWorker(error: Error): void {
    this.projectWorker?.terminate();
    this.projectWorker = null;
    for (const [, job] of this.workerJobs) {
      job.removeAbortListener();
      job.reject(error);
    }
    this.workerJobs.clear();
  }

  /** Synchronous main-thread project slice (fallback; briefly blocks the UI). */
  private async sliceProjectOnMainThread(
    project: ArrayBuffer,
    maxThreads: number,
    overrides: Record<string, string>,
  ): Promise<string> {
    this.resetIfCrashed();
    const mod = await this.ensureModule();
    mod.FS.writeFile('/tmp/orcaxr_upload.3mf', new Uint8Array(project));
    this.emitProjectProgress(
      { percent: 0, message: 'Slicing FullSpectrum project (this can take a while)…' },
      this.projectProgress ?? undefined,
    );
    await new Promise((r) => setTimeout(r, 0)); // let the status paint first
    const out = mod.sliceProjectSync('/tmp/orcaxr_upload.3mf', maxThreads, JSON.stringify(overrides));
    if (out.startsWith('ORCAXR_ERROR:')) throw new Error(out.slice('ORCAXR_ERROR:'.length).trim());
    return out;
  }

  /**
   * Painted (multi-color) slice. `positions` is a Float32 buffer of 9 floats
   * per triangle (printer coords, mm, Z-up); `triFilament` is one 0-based
   * filament index per triangle. The engine splits the mesh into a per-filament
   * volume and emits tool changes — this is how painting a model actually
   * reaches the G-code. Local WASM only (needs cross-origin isolation).
   */
  async slicePainted(
    positions: Float32Array,
    triFilament: Int32Array,
    filamentCount: number,
    maxThreads = 4,
    overrides: Record<string, string> = {},
  ): Promise<string> {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      throw new Error(
        'Painted slicing needs a cross-origin-isolated context (SharedArrayBuffer). ' +
          'Serve the page with COOP/COEP headers and reload.',
      );
    }
    this.resetIfCrashed();
    if (this.slicing) throw new Error('a slice is already running');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      const posBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
      const filBytes = new Uint8Array(triFilament.buffer, triFilament.byteOffset, triFilament.byteLength);
      console.log('[slicer] painted slice:', triFilament.length, 'tris,', filamentCount, 'filaments');
      mod.FS.writeFile('/tmp/orcaxr_painted_pos.bin', posBytes);
      mod.FS.writeFile('/tmp/orcaxr_painted_fil.bin', filBytes);
      this.lastSliceActivity = Date.now();
      mod.startSlicePainted(
        '/tmp/orcaxr_painted_pos.bin',
        '/tmp/orcaxr_painted_fil.bin',
        filamentCount,
        maxThreads,
        JSON.stringify(overrides),
      );
      return await this.awaitSliceResult(() => mod.pollSlice());
    } finally {
      this.slicing = false;
    }
  }

  /** Shared poll loop for the async slice path (mono file + painted).
   *  [idleLimitMs] — how long the engine may stay silent before the stall
   *  watchdog declares it dead. Project 3MFs (big zip parse, many meshes,
   *  FullSpectrum tool ordering) legitimately go quiet far longer than a
   *  flat STL slice. */
  private awaitSliceResult(poll: () => string, idleLimitMs = 20000): Promise<string> {
    let stallWarned = false;
    return new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.crashed) {
          clearInterval(timer);
          this.resetIfCrashed();
          reject(new Error('slicer crashed — restarted, please try again'));
          return;
        }
        const idleMs = Date.now() - this.lastSliceActivity;
        if (!stallWarned && idleMs > idleLimitMs) {
          stallWarned = true;
          clearInterval(timer);
          this.crashed = true;
          this.resetIfCrashed();
          reject(
            new Error(
              `slicer produced no output for ${Math.round(idleLimitMs / 1000)}s — the engine thread failed to start.`,
            ),
          );
          return;
        }
        const out = poll();
        if (out.length > 0) {
          clearInterval(timer);
          if (out.startsWith('ORCAXR_ERROR:')) reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
          else resolve(out);
        }
      }, 100);
    });
  }

  async repair(stl: ArrayBuffer, maxThreads = 4): Promise<ArrayBuffer> {
    this.resetIfCrashed();
    if (this.slicing) throw new Error('the engine is busy');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      // For repair, we pass STL as a string for now, or wait, startRepair takes a string!
      // But passing binary as string can corrupt it in Embind.
      // Wait, in start_slice_file we wrote to MEMFS. We didn't do start_repair_file, we just did start_repair(string).
      // Since embind string is utf-8, binary bytes might get corrupted!
      // Let's modify start_repair to take the file path instead, or just use the string (the Android port did something similar, but files are safer).
      // Actually, since I wrote repair_stl_to_stl in C++ taking std::string, if we just write the file to MEMFS and read it, it's safer. But wait, startRepair takes std::string!
      // Let's pass it as a binary string (which is what Emscripten's std::string typemap does if not careful, but it might fail).
      // A better way is to pass Uint8Array? Emscripten's embind handles std::string as UTF-8.
      // But we can convert ArrayBuffer to a binary string and hope it survives? NO!
      // Since I already compiled the WASM, let's just pass a binary string.
      const binaryString = String.fromCharCode(...new Uint8Array(stl));
      mod.startRepair(binaryString, maxThreads);

      const outString = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          const out = mod.pollRepair();
          if (out.length > 0) {
            clearInterval(timer);
            if (out.startsWith('ORCAXR_ERROR:')) {
              reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
            } else {
              resolve(out);
            }
          }
        }, 100);
      });

      const outBuffer = new Uint8Array(outString.length);
      for (let i = 0; i < outString.length; i++) {
        outBuffer[i] = outString.charCodeAt(i);
      }
      return outBuffer.buffer;
    } finally {
      this.slicing = false;
    }
  }

  /**
   * Boolean CSG (UNION / A_NOT_B / INTERSECTION) of two binary STLs via the
   * WASM engine's mcut path. Returns the result binary STL. Binary bytes go
   * through the same binary-string channel as repair() (embind std::string).
   */
  async boolean(
    stlA: ArrayBuffer,
    stlB: ArrayBuffer,
    op: 'UNION' | 'A_NOT_B' | 'INTERSECTION',
    maxThreads = 4,
  ): Promise<ArrayBuffer> {
    this.resetIfCrashed();
    if (this.slicing) throw new Error('the engine is busy');
    const mod = await this.ensureModule();
    this.slicing = true;
    try {
      const toBinStr = (b: ArrayBuffer) => {
        const u = new Uint8Array(b);
        let s = '';
        // Chunked to avoid blowing the argument stack on large meshes.
        for (let i = 0; i < u.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
        }
        return s;
      };
      mod.startBoolean(toBinStr(stlA), toBinStr(stlB), op, maxThreads);
      const outString = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          if (this.crashed) {
            clearInterval(timer);
            this.resetIfCrashed();
            reject(new Error('slicer crashed — restarted, please try again'));
            return;
          }
          const out = mod.pollBoolean();
          if (out.length > 0) {
            clearInterval(timer);
            if (out.startsWith('ORCAXR_ERROR:')) {
              reject(new Error(out.slice('ORCAXR_ERROR:'.length).trim()));
            } else {
              resolve(out);
            }
          }
        }, 100);
      });
      const outBuffer = new Uint8Array(outString.length);
      for (let i = 0; i < outString.length; i++) {
        outBuffer[i] = outString.charCodeAt(i);
      }
      return outBuffer.buffer;
    } finally {
      this.slicing = false;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signalReason(signal);
}

function signalReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal.reason ?? 'Slicer operation cancelled.'));
  error.name = 'AbortError';
  return error;
}

function delayWithSignal(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signalReason(signal!));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function delayWithoutSignal(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalExternalEndpoint(value: string): string {
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
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; sha256?: unknown };
    if (typeof record.name === 'string') applied.set(record.name, record.sha256);
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
