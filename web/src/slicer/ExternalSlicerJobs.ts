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
}

function jobUrl(context: Pick<ExternalJobContext, 'endpoint' | 'jobId'>): string {
  if (typeof context.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.jobId))
    throw new Error('The external slicer returned an invalid job ID.');
  return `${context.endpoint}/jobs/${encodeURIComponent(context.jobId)}`;
}

/** The deadline owns DELETE, body parsing, polls, and delays from the first request. */
export async function confirmExternalCancellation(context: ExternalJobContext): Promise<void> {
  const timeout = new SlicerClientCancellationError('External slice cancellation confirmation timed out.', false);
  try {
    await withinDeadline(context.cancellationTimeoutMs, timeout, async (signal) => {
      let response = await fetchLocalNetwork(jobUrl(context), { method: 'DELETE', headers: context.headers, signal });
      for (;;) {
        signal.throwIfAborted();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = (await response.json()) as { status?: unknown };
        signal.throwIfAborted();
        if (status.status === 'cancelled') return;
        if (status.status === 'done' || status.status === 'error' || status.status === 'released') {
          throw new SlicerClientCancellationError(
            `External slice was already ${status.status}; it was not cancelled by this request.`,
            false,
            status.status,
          );
        }
        if (status.status !== 'queued' && status.status !== 'running' && status.status !== 'cancelling')
          throw new Error('The server returned an unknown job state.');
        await delay(context.pollIntervalMs, signal);
        response = await fetchLocalNetwork(jobUrl(context), { headers: context.headers, signal });
      }
    });
  } catch (error) {
    if (error instanceof SlicerClientCancellationError) throw error;
    throw new SlicerClientCancellationError(`Could not confirm external slice cancellation: ${message(error)}`, false);
  }
}

export async function pollExternalJob(context: ExternalJobContext): Promise<string> {
  let failures = 0;
  try {
    for (;;) {
      await delay(context.pollIntervalMs, context.signal);
      let status: { status: string; percent?: number; message?: string; error?: string };
      try {
        const response = await fetchLocalNetwork(jobUrl(context), { headers: context.headers, signal: context.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        status = await response.json();
        if (!['queued', 'running', 'cancelling', 'done', 'error', 'cancelled'].includes(status.status))
          throw new Error('Unknown job state.');
        failures = 0;
      } catch (error) {
        if (context.signal?.aborted) throw error;
        if (++failures >= 5) throw new Error(`External slicer stopped responding: ${message(error)}`, { cause: error });
        continue;
      }
      if (status.status === 'error') throw new Error(`External Slicer Failed: ${status.error}`);
      if (status.status === 'cancelled')
        throw new SlicerClientCancellationError('The external slicer job was cancelled.', true);
      if (status.status === 'done') {
        const response = await fetchLocalNetwork(`${jobUrl(context)}/gcode`, {
          headers: context.headers,
          signal: context.signal,
        });
        return await readExternalResult(response, context);
      }
      context.onProgress?.({ percent: status.percent ?? 0, message: status.message || 'Slicing externally...' });
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

/** Keep older servers compatible; only release a result whose transfer identity was verified. */
export async function readExternalResult(
  response: Response,
  context: Omit<ExternalJobContext, 'jobId'> & { readonly jobId?: string },
): Promise<string> {
  if (!response.ok) throw new Error(`External Slicer Failed: ${await response.text()}`);
  const headerId = response.headers.get('x-orcaxr-job-id');
  if (context.jobId && headerId && context.jobId !== headerId)
    throw new Error('External slicer returned a different job artifact. The result was retained.');
  const jobId = context.jobId ?? headerId;
  const expectedHash = response.headers.get('x-orcaxr-gcode-sha256');
  const bytes = new Uint8Array(await response.arrayBuffer());
  context.signal?.throwIfAborted();
  // Content-Length can describe a proxy's compressed representation. This
  // header describes the artifact bytes the browser actually validates.
  const length = response.headers.get('x-orcaxr-gcode-bytes');
  if (!bytes.length || (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes.length)))
    throw new Error('External slice download was incomplete. The result was retained for retry.');
  if (expectedHash !== null) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('External slicer returned an invalid artifact checksum.');
    const digest = globalThis.crypto?.subtle
      ? [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
      : sha256Bytes(bytes).slice(7);
    if (digest !== expectedHash)
      throw new Error('External slice download checksum did not match. The result was retained for retry.');
  }
  const gcode = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!gcode.trim()) throw new Error('External slicer returned an empty artifact.');
  context.signal?.throwIfAborted();
  if (jobId && expectedHash) await releaseCompletedResult({ ...context, jobId });
  if (context.signal?.aborted)
    throw new SlicerClientCancellationError('The external slice completed before cancellation.', false, 'done');
  return gcode;
}

async function releaseCompletedResult(
  context: Pick<ExternalJobContext, 'endpoint' | 'jobId' | 'headers'>,
): Promise<void> {
  try {
    await withinDeadline(1000, new Error('Result release timed out.'), async (signal) => {
      const response = await fetchLocalNetwork(jobUrl(context), { method: 'DELETE', signal, headers: context.headers });
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
