import artifactProvenance from '../../../wasm/artifact-provenance.json' with { type: 'json' };
import { SliceRouteCancellationError, SliceRouteError } from '../project/slicing/SliceJobCoordinator';
import {
  SLICE_PROTOCOL_VERSION,
  type SliceEngineMetadata,
  type SliceRouteAdapterPort,
  type SliceRouteMetadata,
  type SliceRouteProgress,
  type SliceRouteRequest,
  type SliceRouteResponse,
} from '../project/slicing/types';
import { encodeThumbnailBlock, injectGcodeThumbnails, type GcodeThumbnailRequest } from './GcodeThumbnails';
import {
  SlicerClient,
  SlicerClientCancellationError,
  type SliceProgress,
  type SlicerClientProjectRoute,
  type SlicerClientProjectSliceOptions,
} from './SlicerClient';

const encoder = new TextEncoder();

export const BROWSER_WASM_ENGINE_METADATA: SliceEngineMetadata = Object.freeze({
  commit: artifactProvenance.engine.commit,
  artifactHash: `sha256:${artifactProvenance.outputs['slic3r.wasm']}`,
});

export interface CanonicalSlicerRouteProgress extends SliceProgress {
  readonly jobId: string;
  readonly plateId: SliceRouteRequest['plateId'];
  readonly attempt: number;
  readonly routeId: string;
}

export interface CanonicalProjectSlicerClientPort {
  sliceProjectWithRoute(
    project: ArrayBuffer,
    route: SlicerClientProjectRoute,
    options?: SlicerClientProjectSliceOptions,
  ): Promise<string>;
}

/**
 * The engine's missing `thumbnail_cb`, supplied by whoever owns the scene.
 *
 * `libslic3r` only writes a thumbnail when the host hands it one, and the WASM
 * build has no GUI to render it — so the picture a printer's display shows has
 * to be produced in the browser and put into the file here. Attaching it at the
 * route means the thumbnail is inside the artifact the coordinator hashes, so
 * downloading, previewing and sending all carry the same bytes.
 */
export interface SliceThumbnailPort {
  /** The sizes and formats the active printer's `thumbnails` value asks for. */
  requests(): readonly GcodeThumbnailRequest[];
  /** `null` when there is nothing on the plate worth a picture. */
  render(request: GcodeThumbnailRequest): Promise<Uint8Array | null>;
}

export interface CanonicalSlicerClientRouteOptions {
  readonly client: CanonicalProjectSlicerClientPort;
  /** Omitted in headless hosts and tests; the G-code then carries no thumbnail. */
  readonly thumbnails?: SliceThumbnailPort;
  /** Defaults to the preference-backed route captured at construction. */
  readonly route?: SlicerClientProjectRoute;
  /** External servers must supply an independently obtained engine attestation. */
  readonly externalEngine?: SliceEngineMetadata;
  readonly maxThreads?: number;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly onProgress?: (progress: CanonicalSlicerRouteProgress) => void;
}

/**
 * Browser boundary from the canonical slice protocol to SlicerClient.
 *
 * One instance freezes one semantic route for the coordinator's lifetime.
 * Browser provenance comes from the tracked artifact manifest. External
 * provenance is mandatory because the legacy `/ping` response does not attest
 * which binary a user-configured server actually runs.
 */
export class CanonicalSlicerClientRoute implements SliceRouteAdapterPort {
  readonly metadata: SliceRouteMetadata;
  readonly cancellation = Object.freeze({
    mode: 'confirmed-cleanup' as const,
    cleanupTimeoutMs: 31_000,
  });
  private readonly route: SlicerClientProjectRoute;
  private readonly maxThreads: number;

  constructor(private readonly options: CanonicalSlicerClientRouteOptions) {
    this.route = normalizedRoute(options.route ?? SlicerClient.captureProjectRoute());
    this.maxThreads = positiveInteger(options.maxThreads ?? 4, 'maxThreads');
    const engine =
      this.route.kind === 'browser-wasm'
        ? BROWSER_WASM_ENGINE_METADATA
        : validatedExternalEngine(options.externalEngine);
    this.metadata = Object.freeze({
      id: routeId(this.route),
      kind: this.route.kind,
      protocolVersion: SLICE_PROTOCOL_VERSION,
      engine: Object.freeze({ ...engine }),
    });
  }

  /**
   * Put the plate's picture in the file, if this host can draw one.
   *
   * Deliberately best-effort: a thumbnail is what a display shows, not what a
   * printer prints, and losing a WebGL context or a canvas must not turn a
   * finished slice into a failed one. A failure leaves the G-code exactly as
   * the engine wrote it, which is the behaviour every build had until now.
   */
  private async withThumbnails(gcodeText: string): Promise<string> {
    const port = this.options.thumbnails;
    if (!port) return gcodeText;
    try {
      const blocks: string[] = [];
      for (const request of port.requests()) {
        const image = await port.render(request);
        if (image && image.byteLength > 0) blocks.push(encodeThumbnailBlock(request, image));
      }
      return injectGcodeThumbnails(gcodeText, blocks);
    } catch (error) {
      console.warn('[orcaxr] could not render a G-code thumbnail; the file will carry none', error);
      return gcodeText;
    }
  }

  async execute(
    request: SliceRouteRequest,
    signal: AbortSignal,
    onProgress?: (progress: SliceRouteProgress) => void,
  ): Promise<SliceRouteResponse> {
    assertRequestMatchesRoute(request, this.metadata);
    if (signal.aborted) {
      const reason = signalReason(signal);
      throw new SliceRouteCancellationError('Canonical slice route cancelled before submission', true, reason, {
        cause: reason,
      });
    }

    try {
      const gcodeText = await this.options.client.sliceProjectWithRoute(
        copyAsArrayBuffer(request.project.bytes),
        this.route,
        {
          maxThreads: this.maxThreads,
          // The plate's own keys win: the static map is this composition's
          // preference, while these belong to the plate actually being sliced.
          overrides: { ...this.options.overrides, ...request.plateOverrides },
          signal,
          onProgress: (progress) => {
            emitProgress(onProgress, progress);
            emitContextualProgress(this.options.onProgress, {
              jobId: request.jobId,
              plateId: request.plateId,
              attempt: request.attempt,
              routeId: this.metadata.id,
              percent: progress.percent,
              message: progress.message,
            });
          },
          // Canonical cancellation must never fall through to a synchronous
          // main-thread engine call that cannot observe AbortSignal.
          allowUncancellableMainThreadFallback: false,
          externalCancellationTimeoutMs: 30_000,
        },
      );
      if (signal.aborted) {
        const reason = signalReason(signal);
        throw new SliceRouteCancellationError('Canonical slice route cancelled after engine completion', false, reason);
      }
      const gcode = encoder.encode(await this.withThumbnails(gcodeText));
      return {
        protocolVersion: SLICE_PROTOCOL_VERSION,
        jobId: request.jobId,
        plateId: request.plateId,
        inputHash: request.project.inputHash,
        engine: { ...this.metadata.engine },
        gcode,
        warnings: [],
        statistics: {
          route: this.metadata.kind,
          gcodeBytes: gcode.byteLength,
        },
      };
    } catch (error) {
      if (error instanceof SliceRouteCancellationError) throw error;
      if (error instanceof SlicerClientCancellationError) {
        throw new SliceRouteCancellationError(
          error.message,
          error.cancellationConfirmed,
          signal.aborted ? signalReason(signal) : undefined,
          { cause: error },
        );
      }
      if (signal.aborted) {
        const reason = signalReason(signal);
        // Confirming cleanup is not the interesting part — *why* the slice was
        // aborted is, and it is the only thing the operator can act on. Saying
        // only that cleanup was confirmed reported a timed-out slice of a large
        // model as if nothing had gone wrong but the teardown.
        throw new SliceRouteCancellationError(
          `Canonical slice route stopped: ${boundedMessage(reason ?? error)}`,
          true,
          reason,
          { cause: error },
        );
      }
      if (error instanceof SliceRouteError) throw error;
      throw new SliceRouteError(`SlicerClient route failed: ${boundedMessage(error)}`, isRetryable(error));
    }
  }
}

function normalizedRoute(route: SlicerClientProjectRoute): SlicerClientProjectRoute {
  if (route.kind === 'browser-wasm') return Object.freeze({ kind: 'browser-wasm' });
  let endpoint: URL;
  try {
    endpoint = new URL(route.endpoint);
  } catch {
    throw new Error('Canonical external slice route requires a valid absolute endpoint.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Canonical external slice route supports only HTTP or HTTPS.');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[?#]/.test(route.endpoint)) {
    throw new Error('Canonical external slice routes cannot contain credentials, query parameters, or fragments.');
  }
  return Object.freeze({ kind: 'external-server', endpoint: endpoint.href.replace(/\/+$/, '') });
}

function validatedExternalEngine(engine: SliceEngineMetadata | undefined): SliceEngineMetadata {
  if (!engine?.commit.trim() || !engine.artifactHash.trim()) {
    throw new Error('External canonical slicing requires attested engine commit and artifact hash.');
  }
  return { commit: engine.commit, artifactHash: engine.artifactHash };
}

function routeId(route: SlicerClientProjectRoute): string {
  if (route.kind === 'browser-wasm') {
    return `slicer-client:browser-wasm:${BROWSER_WASM_ENGINE_METADATA.artifactHash}`;
  }
  const endpoint = new URL(route.endpoint);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  return `slicer-client:external-server:${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}`;
}

function assertRequestMatchesRoute(request: SliceRouteRequest, metadata: SliceRouteMetadata): void {
  if (request.protocolVersion !== metadata.protocolVersion) {
    throw new SliceRouteError(`Unsupported canonical slice protocol ${request.protocolVersion}.`);
  }
  if (
    request.engine.commit !== metadata.engine.commit ||
    request.engine.artifactHash !== metadata.engine.artifactHash
  ) {
    throw new SliceRouteError('Slice request engine provenance does not match the captured route.');
  }
}

function copyAsArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof SlicerClientCancellationError) return false;
  if (error instanceof TypeError) return true;
  const message = boundedMessage(error).toLowerCase();
  return message.includes('stopped responding') || message.includes('worker crashed');
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'unknown failure';
}

function signalReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal.reason ?? 'Canonical slice route cancelled.'));
  error.name = 'AbortError';
  return error;
}

function emitProgress(observer: ((progress: SliceRouteProgress) => void) | undefined, progress: SliceProgress): void {
  try {
    observer?.(progress);
  } catch {
    // Progress observers cannot change route semantics.
  }
}

function emitContextualProgress(
  observer: ((progress: CanonicalSlicerRouteProgress) => void) | undefined,
  progress: CanonicalSlicerRouteProgress,
): void {
  try {
    observer?.(progress);
  } catch {
    // The optional UI observer is informational too.
  }
}
