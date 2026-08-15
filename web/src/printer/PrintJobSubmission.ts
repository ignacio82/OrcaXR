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
  request<T>(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<T>;
  upload<T>(
    path: string,
    body: FormData,
    options?: {
      readonly signal?: AbortSignal;
      readonly operation?: string;
      /** Transfers are sized, not prompt, so they carry their own deadline. */
      readonly timeoutMs?: number;
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
  /**
   * Slowest acceptable upload rate, used to derive the transfer deadline.
   * Defaults to `MINIMUM_UPLOAD_BYTES_PER_SECOND`.
   */
  readonly minimumUploadBytesPerSecond?: number;
  readonly onPhase?: (phase: PrintSubmissionPhase) => void;
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
  const uploadTimeoutMs = uploadDeadlineMs(bytes.byteLength, request.minimumUploadBytesPerSecond);
  try {
    uploaded = await transport.upload<unknown>('/server/files/upload', form, {
      operation: 'upload_gcode',
      timeoutMs: uploadTimeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (isCancellation(error, request.signal)) throw new PrintSubmissionError('Upload cancelled.', 'cancelled');
    if (error instanceof MoonrakerTransportError && error.code === 'timeout') {
      // Say what the link would have had to do, because the operator is the
      // only one who can tell "my printer is on slow wifi" from "it is stuck".
      throw new PrintSubmissionError(
        `Uploading ${filename} (${megabytes(bytes.byteLength)}) did not finish within ` +
          `${Math.round(uploadTimeoutMs / 1000)} s, which is slower than ` +
          `${Math.round((request.minimumUploadBytesPerSecond ?? MINIMUM_UPLOAD_BYTES_PER_SECOND) / 1024)} kB/s. ` +
          'Nothing was started; the printer may hold a partial file.',
        'upload-failed',
      );
    }
    throw new PrintSubmissionError(
      `Uploading ${filename} failed (${error instanceof MoonrakerTransportError ? error.code : 'request failed'}).`,
      'upload-failed',
    );
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
        operation: 'start_print',
        ...(request.signal ? { signal: request.signal } : {}),
      });
      startedPrint = true;
    } catch (error) {
      if (isCancellation(error, request.signal)) throw new PrintSubmissionError('Print start cancelled.', 'cancelled');
      throw new PrintSubmissionError(
        `${path} uploaded, but starting the print failed (${
          error instanceof MoonrakerTransportError ? error.code : 'request failed'
        }).`,
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

/**
 * Slowest link an upload is still expected to complete on.
 *
 * A print artifact is not a status query: a two-million-facet model slices to
 * around 95 MB, which cannot cross any real network inside the shared
 * ten-second request timeout, so sending it failed on the clock rather than on
 * anything being wrong. The deadline is derived from the payload instead, and
 * this floor is what turns "large" into "stuck" — generous enough for a printer
 * on poor wifi, short enough that a dead link does not hang for an hour.
 */
export const MINIMUM_UPLOAD_BYTES_PER_SECOND = 256 * 1024;

/** Fixed allowance for connection setup and the printer writing the file out. */
const UPLOAD_OVERHEAD_MS = 30_000;

function uploadDeadlineMs(byteLength: number, minimumBytesPerSecond?: number): number {
  const floor =
    minimumBytesPerSecond && minimumBytesPerSecond > 0 ? minimumBytesPerSecond : MINIMUM_UPLOAD_BYTES_PER_SECOND;
  return Math.ceil(UPLOAD_OVERHEAD_MS + (byteLength / floor) * 1000);
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
