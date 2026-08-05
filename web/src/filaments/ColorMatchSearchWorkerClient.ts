import type {
  SuppliedPaletteMatchSearchInput,
  SuppliedPaletteMatchSearchResult,
} from '../project/filaments/colorMatchSearch';
import {
  COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
  type ColorMatchSearchWorkerRequest,
  type ColorMatchSearchWorkerResponse,
} from '../project/filaments/colorMatchSearchProtocol';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export interface ColorMatchSearchWorkerLike {
  onmessage: ((event: MessageEvent<ColorMatchSearchWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ColorMatchSearchWorkerRequest): void;
  terminate(): void;
}

export interface ColorMatchSearchWorkerClientOptions {
  readonly createWorker?: () => ColorMatchSearchWorkerLike;
  readonly createRequestId?: () => string;
  readonly timeoutMs?: number;
}

export interface ColorMatchSearchWorkerSearchOptions {
  readonly signal?: AbortSignal;
}

export class ColorMatchSearchWorkerProtocolError extends Error {
  override readonly name = 'ColorMatchSearchWorkerProtocolError';
}

export class ColorMatchSearchWorkerRemoteError extends Error {
  override readonly name = 'ColorMatchSearchWorkerRemoteError';

  constructor(
    readonly remoteName: string,
    message: string,
  ) {
    super(message);
  }
}

export class ColorMatchSearchWorkerCrashError extends Error {
  override readonly name = 'ColorMatchSearchWorkerCrashError';
}

export class ColorMatchSearchWorkerTimeoutError extends Error {
  override readonly name = 'ColorMatchSearchWorkerTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Color Match search worker timed out after ${timeoutMs} ms`);
  }
}

export class ColorMatchSearchCancelledError extends Error {
  override readonly name: string = 'ColorMatchSearchCancelledError';

  constructor(readonly reason?: unknown) {
    super(cancellationMessage('Color Match search was cancelled', reason));
  }
}

export class ColorMatchSearchSupersededError extends ColorMatchSearchCancelledError {
  override readonly name = 'ColorMatchSearchSupersededError';

  constructor(
    readonly supersededRequestId: string,
    readonly replacementRequestId: string,
  ) {
    super(`replaced by ${replacementRequestId}`);
    this.message = `Color Match search ${supersededRequestId} was superseded by ${replacementRequestId}`;
  }
}

export class ColorMatchSearchDisposedError extends ColorMatchSearchCancelledError {
  override readonly name = 'ColorMatchSearchDisposedError';

  constructor() {
    super('client disposed');
    this.message = 'Color Match search worker client is disposed';
  }
}

interface ActiveSearch {
  readonly requestId: string;
  readonly cancel: (error: Error) => void;
}

/**
 * Latest-request-wins client. Each search receives a dedicated worker because
 * synchronous pigment search cannot process an in-worker cancel message while
 * it is running; terminating the superseded worker is the prompt hard stop.
 */
export class ColorMatchSearchWorkerClient {
  private readonly createWorker: () => ColorMatchSearchWorkerLike;
  private readonly createRequestId: () => string;
  private readonly timeoutMs: number;
  private active: ActiveSearch | null = null;
  private disposed = false;

  constructor(options: ColorMatchSearchWorkerClientOptions = {}) {
    this.createWorker = options.createWorker ?? defaultWorkerFactory;
    this.createRequestId = options.createRequestId ?? defaultRequestId;
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  search(
    input: SuppliedPaletteMatchSearchInput,
    options: ColorMatchSearchWorkerSearchOptions = {},
  ): Promise<SuppliedPaletteMatchSearchResult> {
    if (this.disposed) return Promise.reject(new ColorMatchSearchDisposedError());
    if (options.signal?.aborted) {
      return Promise.reject(new ColorMatchSearchCancelledError(options.signal.reason));
    }

    const requestId = requireRequestId(this.createRequestId());
    const previous = this.active;
    if (previous) previous.cancel(new ColorMatchSearchSupersededError(previous.requestId, requestId));

    let worker: ColorMatchSearchWorkerLike;
    try {
      worker = this.createWorker();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const message: ColorMatchSearchWorkerRequest = {
      protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
      requestId,
      type: 'search',
      input,
    };

    return new Promise<SuppliedPaletteMatchSearchResult>((resolve, reject) => {
      let settled = false;
      let abortCleanup = (): void => {};
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abortCleanup();
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        if (this.active?.requestId === requestId) this.active = null;
        operation();
      };
      const timeout = setTimeout(
        () => finish(() => reject(new ColorMatchSearchWorkerTimeoutError(this.timeoutMs))),
        this.timeoutMs,
      );
      const cancel = (error: Error): void => finish(() => reject(error));
      this.active = { requestId, cancel };

      worker.onmessage = (event) => {
        const response = event.data;
        if (
          response?.protocolVersion !== COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION ||
          response.requestId !== requestId
        ) {
          finish(() =>
            reject(
              new ColorMatchSearchWorkerProtocolError(
                'Color Match search worker returned an invalid or mismatched protocol response',
              ),
            ),
          );
          return;
        }
        if (response.type === 'error') {
          if (
            !response.error ||
            typeof response.error.name !== 'string' ||
            typeof response.error.message !== 'string'
          ) {
            finish(() =>
              reject(new ColorMatchSearchWorkerProtocolError('Color Match search worker returned a malformed error')),
            );
            return;
          }
          finish(() =>
            reject(
              new ColorMatchSearchWorkerRemoteError(
                sanitize(response.error.name, 80),
                sanitize(response.error.message, 512),
              ),
            ),
          );
          return;
        }
        if (response.type !== 'result' || !response.result || typeof response.result !== 'object') {
          finish(() =>
            reject(new ColorMatchSearchWorkerProtocolError('Color Match search worker returned a malformed result')),
          );
          return;
        }
        finish(() => resolve(response.result));
      };
      worker.onerror = (event) => {
        finish(() =>
          reject(
            new ColorMatchSearchWorkerCrashError(`Color Match search worker crashed: ${sanitize(event.message, 512)}`),
          ),
        );
      };

      if (options.signal) {
        const abort = (): void => cancel(new ColorMatchSearchCancelledError(options.signal?.reason));
        options.signal.addEventListener('abort', abort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener('abort', abort);
        if (options.signal.aborted) {
          abort();
          return;
        }
      }

      try {
        worker.postMessage(message);
      } catch (error) {
        finish(() => reject(asError(error)));
      }
    });
  }

  cancel(reason?: unknown): boolean {
    if (!this.active) return false;
    this.active.cancel(new ColorMatchSearchCancelledError(reason));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.cancel(new ColorMatchSearchDisposedError());
  }
}

function defaultWorkerFactory(): ColorMatchSearchWorkerLike {
  return new Worker(new URL('./colorMatchSearch.worker.ts', import.meta.url), { type: 'module' });
}

function defaultRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `color-match-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requireRequestId(value: string): string {
  if (typeof value !== 'string') {
    throw new ColorMatchSearchWorkerProtocolError(
      'Color Match search worker request ID must contain 1-128 safe characters',
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new ColorMatchSearchWorkerProtocolError(
      'Color Match search worker request ID must contain 1-128 safe characters',
    );
  }
  return normalized;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`Color Match search worker timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`);
  }
  return value;
}

function cancellationMessage(prefix: string, reason: unknown): string {
  if (reason === undefined) return prefix;
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `${prefix}: ${sanitize(detail, 256)}`;
}

function sanitize(value: string, maximumLength: number): string {
  return (
    String(value || 'unknown error')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, maximumLength) || 'unknown error'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
