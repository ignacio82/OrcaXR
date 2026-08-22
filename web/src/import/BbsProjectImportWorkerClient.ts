import {
  BBS_IMPORT_WORKER_PROTOCOL_VERSION,
  type BbsImportWorkerRequest,
  type BbsImportWorkerResponse,
} from '../project/import/BbsProjectImportProtocol';
import {
  ImportCancelledError,
  type ParsedProjectImport,
  type ProjectImportParseRequest,
  type ProjectImportParserPort,
} from '../project/import/types';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const CANCELLATION_POLL_MS = 25;

export interface BbsImportWorkerLike {
  onmessage: ((event: MessageEvent<BbsImportWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: BbsImportWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface BbsProjectImportWorkerClientOptions {
  readonly createWorker?: () => BbsImportWorkerLike;
  readonly timeoutMs?: number;
  readonly createRequestId?: () => string;
}

export class BbsProjectImportWorkerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`BBS project import worker timed out after ${timeoutMs} ms`);
    this.name = 'BbsProjectImportWorkerTimeoutError';
  }
}

/** One short-lived worker per parse gives cancellation a prompt hard stop. */
export class BbsProjectImportWorkerClient implements ProjectImportParserPort {
  private readonly createWorker: () => BbsImportWorkerLike;
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;

  constructor(options: BbsProjectImportWorkerClientOptions = {}) {
    this.createWorker = options.createWorker ?? defaultWorkerFactory;
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.createRequestId = options.createRequestId ?? defaultRequestId;
  }

  parse(request: ProjectImportParseRequest): Promise<ParsedProjectImport> {
    if (request.cancellation?.aborted) {
      return Promise.reject(new ImportCancelledError(request.cancellation.reason));
    }
    if (request.mode !== 'replace') {
      return Promise.reject(new Error('BBS project import worker currently supports replace mode only'));
    }
    const requestId = requireRequestId(this.createRequestId());
    const worker = this.createWorker();
    const bytes = request.bytes.slice();
    const message: BbsImportWorkerRequest = {
      protocolVersion: BBS_IMPORT_WORKER_PROTOCOL_VERSION,
      requestId,
      request: {
        bytes,
        source: { ...request.source },
        mode: request.mode,
      },
    };

    return new Promise<ParsedProjectImport>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(cancellationPoll);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        operation();
      };
      const timeout = setTimeout(
        () => finish(() => reject(new BbsProjectImportWorkerTimeoutError(this.timeoutMs))),
        this.timeoutMs,
      );
      const cancellationPoll = setInterval(() => {
        if (request.cancellation?.aborted) {
          finish(() => reject(new ImportCancelledError(request.cancellation?.reason)));
        }
      }, CANCELLATION_POLL_MS);

      worker.onmessage = (event) => {
        const response = event.data;
        if (response?.protocolVersion !== BBS_IMPORT_WORKER_PROTOCOL_VERSION || response.requestId !== requestId) {
          finish(() => reject(new Error('BBS import worker returned an invalid or mismatched protocol response')));
          return;
        }
        if (response.type === 'error') {
          finish(() => reject(workerError(response.error)));
          return;
        }
        finish(() => resolve(response.result));
      };
      worker.onerror = (event) => {
        finish(() => reject(new Error(`BBS import worker crashed: ${boundedMessage(event.message)}`)));
      };

      try {
        worker.postMessage(message, [bytes.buffer]);
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
}

function defaultWorkerFactory(): BbsImportWorkerLike {
  return new Worker(new URL('./bbsProjectImport.worker.ts', import.meta.url), { type: 'module' });
}

function defaultRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `bbs-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requireRequestId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(result)) {
    throw new Error('BBS import worker request ID must be 1-128 safe characters');
  }
  return result;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`BBS import worker timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms`);
  }
  return value;
}

function workerError(value: { name: string; message: string }): Error {
  const error = new Error(boundedMessage(value.message));
  error.name = boundedMessage(value.name || 'BbsImportWorkerError', 80);
  return error;
}

function boundedMessage(value: string, maxLength = 512): string {
  const normalized = String(value || 'unknown error')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return normalized.slice(0, maxLength) || 'unknown error';
}
