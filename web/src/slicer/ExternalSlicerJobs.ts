import { fetchLocalNetwork } from '../net/LocalNetworkAccess';
import { sha256Bytes } from './Utf8Sha256';
import { SlicerClientCancellationError } from './SlicerClientCancellationError';

export interface ExternalJobContext {
  readonly endpoint: string;
  readonly jobId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs: number;
  readonly cancellationTimeoutMs: number;
  readonly onProgress?: (progress: { percent: number; message: string }) => void;
  /** How requests leave; the local-network fetch unless a host supplies its own. */
  readonly fetcher?: typeof fetchLocalNetwork;
}

/** What one exchange with the external slicer produced: the transport's failure, or a reply. */
export type ExternalReply = { readonly failed: string } | { readonly status: number; readonly body: string };

/** One poll of a job's status: poll again (after any failures so far), fetch its artifact, or stop. */
export type JobPollStep =
  | { readonly kind: 'wait'; readonly failures: number; readonly progress?: { percent: number; message: string } }
  | { readonly kind: 'download' }
  | { readonly kind: 'failed'; readonly error: Error };

/** One reply while a cancellation is being confirmed: confirmed, ask again, or how it ended. */
export type CancelStep =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'poll' }
  | { readonly kind: 'failed'; readonly error: SlicerClientCancellationError };

/** What a `POST /slice?async=1` reply means: a job to poll, a job to cancel, an artifact to read, or a failure. */
export type SubmissionStep =
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'cancel'; readonly jobId: string }
  | { readonly kind: 'artifact' }
  | { readonly kind: 'failed'; readonly error: Error };

/** How one artifact download ended: accepted, its reply never arriving whole, or the artifact refused. */
export type DownloadOutcome =
  { readonly accepted: true } | { readonly transferFailed: Error } | { readonly refused: Error };

/** One download attempt read: the artifact accepted, the job's artifact fetched again, or the download failed. */
export type DownloadStep =
  { readonly kind: 'accept' } | { readonly kind: 'refetch' } | { readonly kind: 'failed'; readonly error: Error };

/** Where a project is submitted, after the captured endpoint. */
export const SUBMISSION_PATH = '/slice?async=1';
export const NOT_UTF8 = 'External slicer returned an artifact that is not valid UTF-8 text.';
/** Consecutive poll failures after which the server is taken to have stopped responding. */
export const MAX_POLL_FAILURES = 5;
export const CANCELLATION_TIMED_OUT = 'External slice cancellation confirmation timed out.';
/** A reply that is not JSON reads the same in every engine, not as its parser's message. */
export const UNREADABLE_REPLY = 'The server returned an unreadable reply.';
/**
 * How many times a finished job's artifact is fetched before its download
 * fails. The server keeps a result until it is released or expires and serves
 * it as often as it is asked (a transfer in progress holds it, so neither a
 * release nor its expiry cuts one short), so a transfer that dropped, came up
 * short or did not match its checksum is fetched again, not sliced again.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3;

/** An artifact the server still holds: the transfer was incomplete or did not match its checksum. */
export class RetainedResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetainedResultError';
  }
}

/** The artifact's reply did not arrive whole: [cause] is the transport's own failure. */
class TransferError extends Error {
  constructor(readonly failure: unknown) {
    super(message(failure));
    this.name = 'TransferError';
  }
}

const POLL_STATES = ['queued', 'running', 'cancelling', 'done', 'error', 'cancelled'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const succeeded = (status: number) => status >= 200 && status <= 299;
/** Text an operator reads, or nothing when it is blank. */
const said = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
/** A refusal's body as its sentence; a blank one reads as its status. */
const refusal = (status: number, body: string) => `External Slicer Failed: ${said(body) ?? `HTTP ${status}`}`;
function parseReply(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(UNREADABLE_REPLY);
  }
}

export function jobUrl(context: Pick<ExternalJobContext, 'endpoint' | 'jobId'>): string {
  if (typeof context.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.jobId))
    throw new Error('The external slicer returned an invalid job ID.');
  return `${context.endpoint}/jobs/${encodeURIComponent(context.jobId)}`;
}

/** One status reply read as the poll loop reads it, given the consecutive failures before it. */
export function readJobPoll(failures: number, reply: ExternalReply): JobPollStep {
  let status: Record<string, unknown>;
  try {
    if ('failed' in reply) throw new Error(reply.failed);
    if (!succeeded(reply.status)) throw new Error(`HTTP ${reply.status}`);
    const payload = parseReply(reply.body);
    if (!isRecord(payload) || !POLL_STATES.includes(payload.status as string)) throw new Error('Unknown job state.');
    status = payload;
  } catch (error) {
    if (failures + 1 >= MAX_POLL_FAILURES)
      return {
        kind: 'failed',
        error: new Error(`External slicer stopped responding: ${message(error)}`, { cause: error }),
      };
    return { kind: 'wait', failures: failures + 1 };
  }
  if (status.status === 'error') {
    // A failure without its reason reads as one, not as "undefined" or nothing.
    return {
      kind: 'failed',
      error: new Error(`External Slicer Failed: ${said(status.error) ?? 'no reason was given'}`),
    };
  }
  if (status.status === 'cancelled')
    return { kind: 'failed', error: new SlicerClientCancellationError('The external slicer job was cancelled.', true) };
  if (status.status === 'done') return { kind: 'download' };
  // Progress is a number and a sentence, whatever else a server sends.
  const percent = typeof status.percent === 'number' && Number.isFinite(status.percent) ? status.percent : 0;
  return { kind: 'wait', failures: 0, progress: { percent, message: said(status.message) ?? 'Slicing externally...' } };
}

/**
 * The [attempt]th download of a finished job's artifact, read: accepted,
 * fetched again — after a transfer that failed, or an artifact the server
 * retained — while attempts remain, or failed with its own error.
 */
export function readDownload(attempt: number, outcome: DownloadOutcome): DownloadStep {
  if ('accepted' in outcome) return { kind: 'accept' };
  const repeatable = 'transferFailed' in outcome || outcome.refused instanceof RetainedResultError;
  if (repeatable && attempt < MAX_DOWNLOAD_ATTEMPTS) return { kind: 'refetch' };
  return { kind: 'failed', error: 'transferFailed' in outcome ? outcome.transferFailed : outcome.refused };
}

/** One reply while confirming a cancellation (the DELETE's, then each status poll's). */
export function readCancelReply(reply: ExternalReply): CancelStep {
  const unconfirmed = (text: string): CancelStep => ({
    kind: 'failed',
    error: new SlicerClientCancellationError(`Could not confirm external slice cancellation: ${text}`, false),
  });
  if ('failed' in reply) return unconfirmed(reply.failed);
  if (!succeeded(reply.status)) return unconfirmed(`HTTP ${reply.status}`);
  let payload: unknown;
  try {
    payload = parseReply(reply.body);
  } catch (error) {
    return unconfirmed(message(error));
  }
  const status = isRecord(payload) ? payload.status : undefined;
  if (status === 'cancelled') return { kind: 'confirmed' };
  if (status === 'done' || status === 'error' || status === 'released') {
    return {
      kind: 'failed',
      error: new SlicerClientCancellationError(
        `External slice was already ${status}; it was not cancelled by this request.`,
        false,
        status,
      ),
    };
  }
  if (status !== 'queued' && status !== 'running' && status !== 'cancelling')
    return unconfirmed('The server returned an unknown job state.');
  return { kind: 'poll' };
}

/**
 * A `POST /slice?async=1` reply ([jobIdHeader]: its `X-OrcaXR-Job-Id`), read
 * as the canonical route reads it, when the slice was or was not [aborted]
 * while the upload was in flight.
 */
export function readSubmission(
  reply: ExternalReply & { readonly jobIdHeader?: string | null },
  aborted: boolean,
): SubmissionStep {
  if ('failed' in reply) {
    return {
      kind: 'failed',
      error: aborted
        ? new SlicerClientCancellationError(
            `External upload ended before a cancellable job ID was received: ${reply.failed}`,
            false,
          )
        : new Error(reply.failed),
    };
  }
  if (reply.status === 202) {
    let payload: unknown;
    try {
      payload = parseReply(reply.body);
    } catch {
      payload = undefined;
    }
    const job = isRecord(payload) ? payload.job : undefined;
    if (typeof job !== 'string' || !job) {
      return {
        kind: 'failed',
        error: aborted
          ? new SlicerClientCancellationError(
              'External slicer returned no usable job ID, so cancellation could not be confirmed.',
              false,
            )
          : new Error('External slicer returned an invalid async job ID.'),
      };
    }
    return aborted ? { kind: 'cancel', jobId: job } : { kind: 'job', jobId: job };
  }
  if (aborted) {
    if (reply.jobIdHeader) return { kind: 'cancel', jobId: reply.jobIdHeader };
    return {
      kind: 'failed',
      error: new SlicerClientCancellationError(
        'The external response did not provide a cancellable job ID before abort.',
        false,
      ),
    };
  }
  if (!succeeded(reply.status)) return { kind: 'failed', error: new Error(refusal(reply.status, reply.body)) };
  return { kind: 'artifact' };
}

/** The deadline owns DELETE, body parsing, polls, and delays from the first request. */
export async function confirmExternalCancellation(context: ExternalJobContext): Promise<void> {
  const fetcher = context.fetcher ?? fetchLocalNetwork;
  const timeout = new SlicerClientCancellationError(CANCELLATION_TIMED_OUT, false);
  try {
    await withinDeadline(context.cancellationTimeoutMs, timeout, async (signal) => {
      let response = await fetcher(jobUrl(context), { method: 'DELETE', headers: context.headers, signal });
      for (;;) {
        signal.throwIfAborted();
        const body = response.ok ? await response.text() : '';
        signal.throwIfAborted();
        const step = readCancelReply({ status: response.status, body });
        if (step.kind === 'confirmed') return;
        if (step.kind === 'failed') throw step.error;
        await delay(context.pollIntervalMs, signal);
        response = await fetcher(jobUrl(context), { headers: context.headers, signal });
      }
    });
  } catch (error) {
    if (error instanceof SlicerClientCancellationError) throw error;
    throw new SlicerClientCancellationError(`Could not confirm external slice cancellation: ${message(error)}`, false);
  }
}

export async function pollExternalJob(context: ExternalJobContext): Promise<string> {
  const fetcher = context.fetcher ?? fetchLocalNetwork;
  let failures = 0;
  try {
    // An ID no URL can carry fails now, not as polls that could never be sent.
    const url = jobUrl(context);
    for (;;) {
      await delay(context.pollIntervalMs, context.signal);
      let reply: ExternalReply;
      try {
        const response = await fetcher(url, { headers: context.headers, signal: context.signal });
        reply = { status: response.status, body: response.ok ? await response.text() : '' };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        reply = { failed: message(error) };
      }
      const step = readJobPoll(failures, reply);
      if (step.kind === 'failed') throw step.error;
      if (step.kind === 'download') return await downloadExternalResult(context, `${url}/gcode`);
      failures = step.failures;
      if (step.progress) context.onProgress?.(step.progress);
    }
  } catch (error) {
    if (context.signal?.aborted) {
      if (!(error instanceof SlicerClientCancellationError && (error.cancellationConfirmed || error.terminalStatus)))
        await confirmExternalCancellation(context);
      if (error instanceof SlicerClientCancellationError && error.terminalStatus) throw error;
      throw abortReason(context.signal);
    }
    throw error;
  }
}

/**
 * A finished job's artifact, fetched as often as [readDownload] allows: a
 * transfer that fails, or an artifact the server retained, is fetched again
 * after the poll interval, with the same length and checksum checks each
 * time. A cancel stops it where it stands.
 */
async function downloadExternalResult(context: ExternalJobContext, url: string): Promise<string> {
  const fetcher = context.fetcher ?? fetchLocalNetwork;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: DownloadOutcome;
    try {
      let response: Response;
      try {
        response = await fetcher(url, { headers: context.headers, signal: context.signal });
      } catch (error) {
        throw new TransferError(error);
      }
      return await judgeExternalResult(response, context);
    } catch (error) {
      if (context.signal?.aborted) throw error instanceof TransferError ? error.failure : error;
      outcome =
        error instanceof TransferError
          ? { transferFailed: error.failure instanceof Error ? error.failure : new Error(message(error.failure)) }
          : { refused: error instanceof Error ? error : new Error(message(error)) };
    }
    const step = readDownload(attempt, outcome);
    if (step.kind === 'failed') throw step.error;
    await delay(context.pollIntervalMs, context.signal);
  }
}

/** Keep older servers compatible; only release a result whose transfer identity was verified. */
export async function readExternalResult(
  response: Response,
  context: Omit<ExternalJobContext, 'jobId'> & { readonly jobId?: string },
): Promise<string> {
  try {
    return await judgeExternalResult(response, context);
  } catch (error) {
    // A synchronous reply cannot be fetched again: its transport's failure is the slice's.
    throw error instanceof TransferError ? error.failure : error;
  }
}

/** An artifact reply judged; a body that never arrived whole fails as a [TransferError]. */
async function judgeExternalResult(
  response: Response,
  context: Omit<ExternalJobContext, 'jobId'> & { readonly jobId?: string },
): Promise<string> {
  if (!response.ok) throw new Error(refusal(response.status, await response.text()));
  const headerId = response.headers.get('x-orcaxr-job-id');
  if (context.jobId && headerId && context.jobId !== headerId)
    throw new Error('External slicer returned a different job artifact. The result was retained.');
  const jobId = context.jobId ?? headerId;
  const expectedHash = response.headers.get('x-orcaxr-gcode-sha256');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new TransferError(error);
  }
  context.signal?.throwIfAborted();
  // Content-Length can describe a proxy's compressed representation. This
  // header describes the artifact bytes the browser actually validates.
  const length = response.headers.get('x-orcaxr-gcode-bytes');
  if (!bytes.length || (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes.length)))
    throw new RetainedResultError('External slice download was incomplete. The result was retained for retry.');
  if (expectedHash !== null) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('External slicer returned an invalid artifact checksum.');
    const digest = globalThis.crypto?.subtle
      ? [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
      : sha256Bytes(bytes).slice(7);
    if (digest !== expectedHash)
      throw new RetainedResultError(
        'External slice download checksum did not match. The result was retained for retry.',
      );
  }
  let gcode: string;
  try {
    gcode = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // The decoder's own message differs between engines.
    throw new Error(NOT_UTF8);
  }
  if (!gcode.trim()) throw new Error('External slicer returned an empty artifact.');
  context.signal?.throwIfAborted();
  if (jobId && expectedHash) await releaseCompletedResult({ ...context, jobId });
  if (context.signal?.aborted)
    throw new SlicerClientCancellationError('The external slice completed before cancellation.', false, 'done');
  return gcode;
}

/** How long releasing a validated result may take before the server is left to expire it. */
export const RELEASE_TIMEOUT_MS = 1000;

async function releaseCompletedResult(
  context: Pick<ExternalJobContext, 'endpoint' | 'jobId' | 'headers' | 'fetcher'>,
): Promise<void> {
  const fetcher = context.fetcher ?? fetchLocalNetwork;
  try {
    await withinDeadline(RELEASE_TIMEOUT_MS, new Error('Result release timed out.'), async (signal) => {
      const response = await fetcher(jobUrl(context), { method: 'DELETE', signal, headers: context.headers });
      await response.body?.cancel();
    });
  } catch {
    /* Older or unavailable servers retain the result until their TTL. */
  }
}

async function withinDeadline<T>(
  timeoutMs: number,
  reason: Error,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(reason);
        reject(reason);
      }, timeoutMs);
    });
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'Slicer operation cancelled.'));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
