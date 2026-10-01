import { MoonrakerTransportError } from './MoonrakerTypes';
import type { GcodeToolUsage } from './PrintToolMapping';
import {
  executePrintPreparationStep,
  PrintPreparationUncertainError,
  type PrintPreparationStep,
} from './PrintStartOptions';

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
  readonly artifact: {
    readonly outputHash: string;
    readonly sourceRevision: number;
    readonly sourceHash: string;
    readonly sourceAssetHash: string;
    readonly plateId: string;
  };
  isCurrent(): boolean;
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
  /** Complete, recognized state; required even when only storing a file. */
  readonly known: boolean;
  readonly ready: boolean;
  readonly blockers: readonly PrintReadinessBlocker[];
  /** Exactly what the printer reported; never a guess. */
  readonly klippyState?: string;
  readonly printState?: string;
  readonly currentFilename?: string;
  readonly virtualSdActive?: boolean;
}

export type PrintSubmissionPhase =
  'checking' | 'confirming' | 'uploading' | 'verifying' | 'preparing' | 'starting' | 'completed';

export interface PrintFileIdentity {
  readonly filename: string;
  readonly size: number;
  readonly modified: number;
}

export interface PrintUploadPlan {
  readonly requested: string;
  readonly unique: string;
  readonly overwrite: {
    readonly allowed: boolean;
    readonly existing: PrintFileIdentity | null;
    readonly reason?: string;
  };
}

export interface PrintSubmissionValidation {
  readonly phase: PrintSubmissionPhase;
  readonly signal?: AbortSignal;
  readonly readiness: PrintReadiness;
  readonly uploadedPath?: string;
}

export interface PrintSubmissionRequest {
  /** Explicit operations chosen in the confirmation, checked again before each POST. */
  readonly preparation?: readonly PrintPreparationStep[];
  /** Captured before the confirmation; an overwrite may never manufacture one later. */
  readonly uploadPlan?: PrintUploadPlan;
  /** The live workflow verifies its session, artifact, mapping, and capabilities here. */
  readonly validate?: (context: PrintSubmissionValidation) => Promise<void>;
  readonly assertCurrent?: () => void;
  readonly checksum?: string;
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
      | 'not-ready'
      | 'empty-artifact'
      | 'upload-failed'
      | 'verification-failed'
      | 'start-failed'
      | 'cancelled'
      | 'listing-failed'
      | 'target-changed'
      | 'preparation-uncertain'
      | 'start-uncertain'
      | 'stale-context',
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
      known: false,
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
  const virtualSd = status && isRecord(status.virtual_sdcard) ? status.virtual_sdcard : undefined;
  const virtualSdActive = typeof virtualSd?.is_active === 'boolean' ? virtualSd.is_active : undefined;
  const recognizedKlippy = klippyState !== undefined && ['ready', 'startup', 'shutdown', 'error'].includes(klippyState);
  const recognizedPrint =
    printState !== undefined &&
    ['standby', 'printing', 'paused', 'complete', 'cancelled', 'error'].includes(printState);
  const known = recognizedKlippy && recognizedPrint && virtualSdActive !== undefined;

  const blockers: PrintReadinessBlocker[] = [];
  if (!recognizedKlippy) {
    blockers.push({ code: 'state-unavailable', message: 'The printer did not report a recognized Klipper state.' });
  } else if (klippyState !== 'ready') {
    blockers.push({
      code: 'klippy-not-ready',
      message: `Klipper reports "${klippyState}"; it must be ready before a job is sent.`,
    });
  }
  if (!recognizedPrint || virtualSdActive === undefined) {
    blockers.push({
      code: 'state-unavailable',
      message: 'The printer must report a recognized print state and whether its virtual SD card is active.',
    });
  } else if (!['standby', 'complete', 'cancelled'].includes(printState!) || virtualSdActive) {
    blockers.push({
      code: 'printer-busy',
      message: `The printer reports ${printState}${currentFilename ? ` "${currentFilename}"` : ''}${virtualSdActive ? ' with an active virtual SD card' : ''}.`,
    });
  }

  return Object.freeze({
    known,
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    ...(klippyState ? { klippyState } : {}),
    ...(printState ? { printState } : {}),
    ...(currentFilename ? { currentFilename } : {}),
    ...(virtualSdActive === undefined ? {} : { virtualSdActive }),
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

  const validate = async (phase: PrintSubmissionPhase, uploadedPath?: string): Promise<void> => {
    throwIfCancelled(request.signal);
    const readiness = await queryPrintReadiness(transport, request.signal);
    if (!readiness.known || (request.startPrint && !readiness.ready)) {
      throw new PrintSubmissionError(
        `${uploadedPath ? `${uploadedPath} is stored, but printing was not started. ` : ''}The printer cannot accept this operation: ${readiness.blockers.map((blocker) => blocker.message).join(' ')}`,
        'not-ready',
        readiness.blockers,
      );
    }
    await request.validate?.({ phase, readiness, signal: request.signal, ...(uploadedPath ? { uploadedPath } : {}) });
    throwIfCancelled(request.signal);
  };
  request.onPhase?.('checking');
  await validate('checking');
  const plan = request.uploadPlan ?? (await preparePrintUpload(transport, request.filename, request.signal));
  const requested = sanitizeGcodeFilename(request.filename);
  if (plan.requested !== requested)
    throw new PrintSubmissionError('The confirmed upload target changed.', 'target-changed');
  if (request.overwrite && !request.uploadPlan) {
    throw new PrintSubmissionError(
      'Review the exact file and its metadata before confirming replacement.',
      'target-changed',
    );
  }
  const filename = request.overwrite ? plan.requested : plan.unique;
  await validate('uploading');
  await validatePrintUploadTarget(transport, plan, request.overwrite === true, request.signal);
  request.assertCurrent?.();
  throwIfCancelled(request.signal);

  request.onPhase?.('uploading');
  const form = new FormData();
  form.set('root', GCODE_ROOT);
  form.set('path', '');
  form.set('print', 'false');
  if (request.checksum) form.set('checksum', request.checksum);
  form.set('file', new Blob([bytes], { type: 'text/plain' }), filename);
  let uploaded: unknown;
  // No deadline: see `MoonrakerRequestOptions.timeoutMs`. An upload's progress
  // cannot be observed through `fetch`, so the only honest alternatives are to
  // guess a floor rate — which fails transfers that are working, as a 93 MB
  // print over a 237 kB/s link did — or to let it run and let the operator
  // stop it. The caller is required to offer that stop; `main.ts` turns the
  // send button into "Cancel send" for exactly this window.
  request.assertCurrent?.();
  throwIfCancelled(request.signal);
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
  if (
    !isRecord(uploaded) ||
    !item ||
    item.root !== GCODE_ROOT ||
    item.path !== filename ||
    item.size !== bytes.byteLength ||
    uploaded.print_started !== false ||
    uploaded.print_queued !== false
  ) {
    throw new PrintSubmissionError(
      'The upload response did not confirm the requested root, path, byte count, and upload-only mode. Check the printer before trying again.',
      'verification-failed',
    );
  }
  const path = filename;
  request.onPhase?.('verifying');
  throwIfCancelled(request.signal);
  const verifiedBytes = await verifyUploadedSize(transport, path, request.signal);
  if (verifiedBytes !== bytes.byteLength) {
    throw new PrintSubmissionError(
      `The printer stored ${verifiedBytes} bytes but ${bytes.byteLength} were sent; the job was not started.`,
      'verification-failed',
    );
  }

  await validate('verifying', path);
  let startedPrint = false;
  if (request.startPrint) {
    const retained = await readPrintFileIdentity(transport, path, request.signal);
    const validateBeforeMutation = async (phase: PrintSubmissionPhase) => {
      await validate(phase, path);
      const current = await readPrintFileIdentity(transport, path, request.signal);
      if (!samePrintFile(retained, current))
        throw new PrintSubmissionError(`${path} changed after upload. Nothing else was sent.`, 'target-changed');
      const fresh = await queryPrintReadiness(transport, request.signal);
      if (!fresh.ready)
        throw new PrintSubmissionError(
          `${path} is stored, but printer readiness changed. Printing was not started.`,
          'not-ready',
          fresh.blockers,
        );
      request.assertCurrent?.();
      throwIfCancelled(request.signal);
    };
    for (const step of request.preparation ?? []) {
      request.onPhase?.('preparing');
      await executePrintPreparationStep(transport, step, {
        signal: request.signal,
        validate: () => validateBeforeMutation('preparing'),
      }).catch((error: unknown) => {
        if (!(error instanceof PrintPreparationUncertainError)) throw error;
        throw new PrintSubmissionError(
          `${path} is stored. The ${step.label} request has an uncertain outcome; check fresh printer status before trying again. Nothing was retried.`,
          'preparation-uncertain',
        );
      });
    }
    await validateBeforeMutation('starting');
    request.onPhase?.('starting');
    request.assertCurrent?.();
    throwIfCancelled(request.signal);
    try {
      await transport.request<unknown>(`/printer/print/start?filename=${encodeURIComponent(path)}`, {
        method: 'POST',
        operation: 'start_print',
        ...(request.signal ? { signal: request.signal } : {}),
      });
      startedPrint = true;
    } catch {
      throw new PrintSubmissionError(
        `${path} is stored. The print-start request has an uncertain outcome; check fresh printer status before trying again. It was not retried.`,
        'start-uncertain',
      );
    }
  }

  request.onPhase?.('completed');
  return Object.freeze({
    path,
    root: GCODE_ROOT,
    uploadedBytes: bytes.byteLength,
    verifiedBytes,
    startedPrint,
    ...(filename !== requested ? { renamedFrom: requested } : {}),
  });
}

export async function listGcodeFilenames(
  transport: PrintSubmissionTransport,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  try {
    const listed = await transport.request<unknown>(`/server/files/list?root=${GCODE_ROOT}`, {
      operation: 'list_gcodes',
      signal,
    });
    if (
      !Array.isArray(listed) ||
      listed.some((entry) => !isRecord(entry) || typeof entry.path !== 'string' || !entry.path)
    ) {
      throw new Error('Malformed file list.');
    }
    return new Set(listed.map((entry: { path: string }) => entry.path));
  } catch (error) {
    if (isCancellation(error, signal)) throw new PrintSubmissionError('Send cancelled.', 'cancelled');
    throw new PrintSubmissionError(
      'The printer did not report its file list. Refresh the connection before sending; no file was uploaded.',
      'listing-failed',
    );
  }
}

export async function readPrintFileIdentity(
  transport: PrintSubmissionTransport,
  filename: string,
  signal?: AbortSignal,
): Promise<PrintFileIdentity> {
  const value = await transport.request<unknown>(`/server/files/metadata?filename=${encodeURIComponent(filename)}`, {
    signal,
    operation: 'print_file_identity',
  });
  if (
    !isRecord(value) ||
    value.filename !== filename ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.modified !== 'number' ||
    !Number.isFinite(value.modified) ||
    value.modified < 0
  ) {
    throw new PrintSubmissionError(
      `The printer did not report reliable metadata for ${filename}.`,
      'verification-failed',
    );
  }
  return Object.freeze({ filename, size: value.size, modified: value.modified });
}

/** Capture the exact overwrite target before asking the operator to replace it. */
export async function preparePrintUpload(
  transport: PrintSubmissionTransport,
  filename: string,
  signal?: AbortSignal,
  randomBytes: () => Uint8Array = () => globalThis.crypto.getRandomValues(new Uint8Array(16)),
): Promise<PrintUploadPlan> {
  const requested = sanitizeGcodeFilename(filename);
  const files = await listGcodeFilenames(transport, signal);
  let unique = '';
  for (let attempt = 0; attempt < 16; attempt++) {
    const random = randomBytes();
    if (random.length !== 16)
      throw new PrintSubmissionError('A unique upload name could not be generated.', 'target-changed');
    const suffix = [...random].map((value) => value.toString(16).padStart(2, '0')).join('');
    unique = `${requested.slice(0, -6)}_${suffix}.gcode`;
    if (!files.has(unique)) break;
    unique = '';
  }
  if (!unique)
    throw new PrintSubmissionError('A unique upload name could not be reserved. Try again.', 'target-changed');
  let overwrite: PrintUploadPlan['overwrite'] = { allowed: true, existing: null };
  if (files.has(requested)) {
    try {
      overwrite = { allowed: true, existing: await readPrintFileIdentity(transport, requested, signal) };
    } catch {
      overwrite = {
        allowed: false,
        existing: null,
        reason: 'The existing file metadata is unavailable. Upload with a unique name instead.',
      };
    }
  }
  throwIfCancelled(signal);
  return Object.freeze({ requested, unique, overwrite: Object.freeze(overwrite) });
}

export async function validatePrintUploadTarget(
  transport: PrintSubmissionTransport,
  plan: PrintUploadPlan,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const files = await listGcodeFilenames(transport, signal);
  if (!overwrite) {
    if (files.has(plan.unique))
      throw new PrintSubmissionError(
        'The unique upload name was taken after confirmation. Confirm a new send.',
        'target-changed',
      );
    return;
  }
  if (!plan.overwrite.allowed)
    throw new PrintSubmissionError(plan.overwrite.reason ?? 'Replacing this file is unavailable.', 'target-changed');
  if (files.has(plan.requested) !== (plan.overwrite.existing !== null))
    throw new PrintSubmissionError(
      'The overwrite target changed after confirmation. Review it again.',
      'target-changed',
    );
  if (
    plan.overwrite.existing &&
    !samePrintFile(plan.overwrite.existing, await readPrintFileIdentity(transport, plan.requested, signal))
  ) {
    throw new PrintSubmissionError(
      'The overwrite target changed after confirmation. Review it again.',
      'target-changed',
    );
  }
  const readiness = await queryPrintReadiness(transport, signal);
  if (
    !readiness.known ||
    ((readiness.printState === 'printing' || readiness.printState === 'paused' || readiness.virtualSdActive) &&
      (!readiness.currentFilename || readiness.currentFilename === plan.requested))
  ) {
    throw new PrintSubmissionError(
      'An active file cannot be replaced. Upload with a unique name instead.',
      'target-changed',
    );
  }
}

export function samePrintFile(a: PrintFileIdentity, b: PrintFileIdentity): boolean {
  return a.filename === b.filename && a.size === b.size && a.modified === b.modified;
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
