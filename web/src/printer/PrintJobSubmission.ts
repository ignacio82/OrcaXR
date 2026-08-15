import { MoonrakerTransportError } from './MoonrakerTypes';
import type { GcodeToolUsage } from './PrintToolMapping';

/**
 * One artifact the shell has been asked to send, with the facts a safety
 * confirmation needs. The workspace produces it; the composition root decides
 * how to confirm and submit it.
 */
export interface PrintJobIntent {
  readonly filename: string;
  readonly gcode: string;
  readonly plateName: string;
  readonly usage: GcodeToolUsage;
}

/** Minimal transport surface a submission needs; the real transport satisfies it. */
export interface PrintSubmissionTransport {
  request<T>(
    path: string,
    options?: { readonly signal?: AbortSignal; readonly operation?: string; readonly method?: string },
  ): Promise<T>;
  upload<T>(
    path: string,
    body: FormData,
    options?: {
      readonly signal?: AbortSignal;
      readonly operation?: string;
      /** `null` runs without a deadline; the operator cancels instead. */
      readonly timeoutMs?: number | null;
    },
  ): Promise<T>;
}

export type PrintReadinessBlockerCode =
  'klippy-not-ready' | 'printer-busy' | 'state-unavailable' | 'file-root-unavailable';

export interface PrintReadinessBlocker {
  readonly code: PrintReadinessBlockerCode;
  readonly message: string;
}

export interface PrintReadiness {
  readonly ready: boolean;
  readonly blockers: readonly PrintReadinessBlocker[];
  /** Exactly what the printer reported; never a guess. */
  readonly klippyState?: string;
  readonly printState?: string;
  readonly currentFilename?: string;
}

export type PrintSubmissionPhase = 'checking' | 'uploading' | 'verifying' | 'starting' | 'done';

export interface PrintSubmissionRequest {
  /** Suggested name; it is sanitized and, unless overwriting, made unique. */
  readonly filename: string;
  readonly gcode: string;
  /** Upload only by default; starting a print is a separate explicit choice. */
  readonly startPrint?: boolean;
  /** Replace an existing file of the same name instead of picking a new one. */
  readonly overwrite?: boolean;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: PrintSubmissionPhase) => void;
  /**
   * Called while the upload is in flight, so a transfer that takes minutes is
   * visibly still running.
   *
   * It reports elapsed time and total size, never bytes sent: `fetch` does not
   * expose upload progress, and reporting a percentage derived from elapsed
   * time would be an invention. An honest "4m 12s of 93.0 MB" beats a
   * confident lie.
   */
  readonly onUploadElapsed?: (elapsed: { readonly elapsedMs: number; readonly totalBytes: number }) => void;
  /** Test seam; production ticks once a second. */
  readonly elapsedTickMs?: number;
}

export interface PrintSubmissionResult {
  readonly path: string;
  readonly root: string;
  readonly uploadedBytes: number;
  readonly verifiedBytes: number;
  readonly startedPrint: boolean;
  readonly renamedFrom?: string;
}

export class PrintSubmissionError extends Error {
  constructor(
    message: string,
    readonly code:
      'not-ready' | 'empty-artifact' | 'upload-failed' | 'verification-failed' | 'start-failed' | 'cancelled',
    readonly blockers: readonly PrintReadinessBlocker[] = [],
  ) {
    super(message);
    this.name = 'PrintSubmissionError';
  }
}

const GCODE_ROOT = 'gcodes';
/** Klipper rejects names outside this set; keep the mapping obvious and stable. */
const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

export function sanitizeGcodeFilename(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? filename).trim();
  const stem = /\.gcode$/i.test(base) ? base.slice(0, -'.gcode'.length) : base.replace(/\.[^.]*$/, '');
  const safe = stem
    .replace(SAFE_NAME, '_')
    .replace(/^[_.]+/, '')
    .slice(0, 110);
  return safe.length > 0 ? `${safe}.gcode` : 'orcaxr_print.gcode';
}

/**
 * Ask the printer whether it can accept a job right now. Every blocker names
 * the exact reported state; an unreadable state is itself a blocker, so a send
 * never proceeds on assumptions.
 */
export async function queryPrintReadiness(
  transport: PrintSubmissionTransport,
  signal?: AbortSignal,
): Promise<PrintReadiness> {
  let payload: unknown;
  try {
    payload = await transport.request<unknown>('/printer/objects/query?webhooks&print_stats&virtual_sdcard', {
      operation: 'print_readiness',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return Object.freeze({
      ready: false,
      blockers: Object.freeze([
        {
          code: 'state-unavailable' as const,
          message: `The printer did not report its state (${
            error instanceof MoonrakerTransportError ? error.code : 'request failed'
          }).`,
        },
      ]),
    });
  }

  const status = isRecord(payload) && isRecord(payload.status) ? payload.status : undefined;
  const webhooks = status && isRecord(status.webhooks) ? status.webhooks : undefined;
  const printStats = status && isRecord(status.print_stats) ? status.print_stats : undefined;
  const klippyState = typeof webhooks?.state === 'string' ? webhooks.state : undefined;
  const printState = typeof printStats?.state === 'string' ? printStats.state : undefined;
  const currentFilename = typeof printStats?.filename === 'string' ? printStats.filename : undefined;

  const blockers: PrintReadinessBlocker[] = [];
  if (!klippyState) {
    blockers.push({ code: 'state-unavailable', message: 'The printer did not report a Klippy state.' });
  } else if (klippyState !== 'ready') {
    blockers.push({
      code: 'klippy-not-ready',
      message: `Klipper reports "${klippyState}"; it must be ready before a job is sent.`,
    });
  }
  if (printState === 'printing' || printState === 'paused') {
    blockers.push({
      code: 'printer-busy',
      message: `The printer is ${printState}${currentFilename ? ` "${currentFilename}"` : ''}.`,
    });
  }

  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    ...(klippyState ? { klippyState } : {}),
    ...(printState ? { printState } : {}),
    ...(currentFilename ? { currentFilename } : {}),
  });
}

/**
 * Upload one G-code artifact and optionally start it.
 *
 * The flow is deliberately conservative: readiness is checked first, an
 * existing name is never overwritten silently, the uploaded size is verified
 * against what was sent before any print starts, and starting a print is a
 * separate step the caller must ask for.
 */
export async function submitPrintJob(
  transport: PrintSubmissionTransport,
  request: PrintSubmissionRequest,
): Promise<PrintSubmissionResult> {
  const bytes = new TextEncoder().encode(request.gcode);
  if (bytes.byteLength === 0) throw new PrintSubmissionError('The G-code artifact is empty.', 'empty-artifact');
  throwIfCancelled(request.signal);

  request.onPhase?.('checking');
  // Readiness gates starting a print, not storing a file: Moonraker's file
  // manager accepts uploads while the machine is busy or Klipper is down, and
  // refusing that would block the ordinary "queue the next plate" workflow.
  const readiness = await queryPrintReadiness(transport, request.signal);
  if (request.startPrint && !readiness.ready) {
    throw new PrintSubmissionError(
      `The printer cannot start a job: ${readiness.blockers.map((blocker) => blocker.message).join(' ')}`,
      'not-ready',
      readiness.blockers,
    );
  }
  throwIfCancelled(request.signal);

  const requested = sanitizeGcodeFilename(request.filename);
  const existing = await listGcodeFilenames(transport, request.signal);
  const filename = request.overwrite ? requested : uniqueFilename(requested, existing);
  throwIfCancelled(request.signal);

  request.onPhase?.('uploading');
  const form = new FormData();
  form.set('root', GCODE_ROOT);
  form.set('path', '');
  form.set('print', 'false');
  form.set('file', new Blob([bytes], { type: 'text/plain' }), filename);
  let uploaded: unknown;
  // No deadline: see `MoonrakerRequestOptions.timeoutMs`. An upload's progress
  // cannot be observed through `fetch`, so the only honest alternatives are to
  // guess a floor rate — which fails transfers that are working, as a 93 MB
  // print over a 237 kB/s link did — or to let it run and let the operator
  // stop it. The caller is required to offer that stop; `main.ts` turns the
  // send button into "Cancel send" for exactly this window.
  const stopTicking = startElapsedTicks(request, bytes.byteLength);
  try {
    uploaded = await transport.upload<unknown>('/server/files/upload', form, {
      operation: 'upload_gcode',
      timeoutMs: null,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (isCancellation(error, request.signal)) throw new PrintSubmissionError('Upload cancelled.', 'cancelled');
    throw new PrintSubmissionError(
      `Uploading ${filename} (${megabytes(bytes.byteLength)}) failed (${describeTransportFailure(error)}). ` +
        'Nothing was started; the printer may hold a partial file.',
      'upload-failed',
    );
  } finally {
    stopTicking();
  }
  const item = isRecord(uploaded) && isRecord(uploaded.item) ? uploaded.item : undefined;
  const path = typeof item?.path === 'string' && item.path.length > 0 ? item.path : filename;
  throwIfCancelled(request.signal);

  request.onPhase?.('verifying');
  const verifiedBytes = await verifyUploadedSize(transport, path, request.signal);
  if (verifiedBytes !== bytes.byteLength) {
    throw new PrintSubmissionError(
      `The printer stored ${verifiedBytes} bytes but ${bytes.byteLength} were sent; the job was not started.`,
      'verification-failed',
    );
  }

  let startedPrint = false;
  if (request.startPrint) {
    request.onPhase?.('starting');
    try {
      await transport.request<unknown>(`/printer/print/start?filename=${encodeURIComponent(path)}`, {
        method: 'POST',
        operation: 'start_print',
        ...(request.signal ? { signal: request.signal } : {}),
      });
      startedPrint = true;
    } catch (error) {
      if (isCancellation(error, request.signal)) throw new PrintSubmissionError('Print start cancelled.', 'cancelled');
      throw new PrintSubmissionError(
        `${path} uploaded, but starting the print failed (${describeTransportFailure(error)}). ` +
          'The file is on the printer and can be started from its file list.',
        'start-failed',
      );
    }
  }

  request.onPhase?.('done');
  return Object.freeze({
    path,
    root: GCODE_ROOT,
    uploadedBytes: bytes.byteLength,
    verifiedBytes,
    startedPrint,
    ...(filename !== requested ? { renamedFrom: requested } : {}),
  });
}

async function listGcodeFilenames(
  transport: PrintSubmissionTransport,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  try {
    const listed = await transport.request<unknown>(`/server/files/list?root=${GCODE_ROOT}`, {
      operation: 'list_gcodes',
      ...(signal ? { signal } : {}),
    });
    const names = new Set<string>();
    if (Array.isArray(listed)) {
      for (const entry of listed) {
        if (isRecord(entry) && typeof entry.path === 'string') names.add(entry.path);
      }
    }
    return names;
  } catch {
    // A printer that cannot list files still accepts uploads; a unique name is
    // then chosen from the requested one alone.
    return new Set<string>();
  }
}

async function verifyUploadedSize(
  transport: PrintSubmissionTransport,
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const metadata = await transport.request<unknown>(`/server/files/metadata?filename=${encodeURIComponent(path)}`, {
      operation: 'verify_upload',
      ...(signal ? { signal } : {}),
    });
    const size = isRecord(metadata) ? metadata.size : undefined;
    if (typeof size === 'number' && Number.isFinite(size)) return size;
  } catch (error) {
    if (isCancellation(error, signal)) throw new PrintSubmissionError('Upload cancelled.', 'cancelled');
  }
  throw new PrintSubmissionError(
    `The printer did not report a size for ${path}; the upload could not be verified.`,
    'verification-failed',
  );
}

function uniqueFilename(filename: string, existing: ReadonlySet<string>): string {
  if (!existing.has(filename)) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${stem}_${attempt}${extension}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}${extension}`;
}

/*
 * There is deliberately no upload rate floor here any more.
 *
 * Three deadlines were tried and all three were wrong. The shared 10 s request
 * timeout could not carry 95 MB. A size-derived deadline at a 256 kB/s floor
 * collided with the transport's own 5-minute configuration bound and rejected
 * every print over ~67 MB before a byte was sent. Raising that bound then
 * failed a real 93 MB upload at 402 s, because the link was moving 237 kB/s —
 * healthy, just below a floor invented on its behalf.
 *
 * The floor was always a guess about someone else's network, and `fetch`
 * cannot report upload progress, so there is no way to tell a slow transfer
 * from a stuck one from inside this module. The upload therefore runs without
 * a deadline, reports elapsed time so it is visibly alive, and is cancelled by
 * the operator — who can see the printer and the network, and is the only one
 * here who actually knows.
 */

/**
 * Name a transport failure the way an operator can act on.
 *
 * The code alone ("http_error") says only that something went wrong. Moonraker
 * usually says exactly what, so lead with its own words and keep the status
 * beside them.
 */
export function describeTransportFailure(error: unknown): string {
  if (!(error instanceof MoonrakerTransportError)) return 'request failed';
  const status = error.httpStatus === undefined ? '' : `HTTP ${error.httpStatus}`;
  if (error.detail === undefined) return status === '' ? error.code : `${error.code}, ${status}`;
  return status === '' ? `${error.code}: ${error.detail}` : `${status}: ${error.detail}`;
}

/**
 * Report elapsed time while the upload runs, and return a stop function.
 *
 * Without this an upload of a hundred megabytes is indistinguishable from a
 * hung one, which is precisely the anxiety a fixed deadline used to answer —
 * badly, by failing the transfer.
 */
function startElapsedTicks(request: PrintSubmissionRequest, totalBytes: number): () => void {
  if (!request.onUploadElapsed) return () => {};
  const startedAt = Date.now();
  const intervalMs = request.elapsedTickMs ?? 1000;
  const handle = setInterval(() => {
    request.onUploadElapsed?.({ elapsedMs: Date.now() - startedAt, totalBytes });
  }, intervalMs);
  // Node keeps the process alive for a pending interval; a submission must not.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

function megabytes(byteLength: number): string {
  return `${(byteLength / 1048576).toFixed(1)} MB`;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrintSubmissionError('The send was cancelled.', 'cancelled');
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof MoonrakerTransportError && error.code === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
