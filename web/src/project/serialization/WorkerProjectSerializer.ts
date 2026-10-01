import type { AssetPayload } from '../assets';
import type {
  CancellationToken,
  ProjectArchiveSnapshot,
  ProjectSerializerPort,
  SerializedProject,
  ProjectSerializationOptions,
} from '../ports';
import type { ProjectState } from '../domain/model';
import { Bbs3mfProjectSerializer } from './Bbs3mfProjectSerializer';
import {
  PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
  type SerializeWorkerRequest,
  type SerializeWorkerResponse,
} from './ProjectSerializerProtocol';

export interface WorkerProjectSerializerOptions {
  readonly createWorker?: () => Worker;
  readonly fallback?: ProjectSerializerPort;
  readonly timeoutMs?: number;
}
export class ProjectSerializerUnavailableError extends Error {
  override readonly name = 'ProjectSerializerUnavailableError';
  constructor() {
    super('Project serializer worker is unavailable. Recovery is paused; explicit manual export remains available.');
  }
}
interface Pending {
  resolve(value: SerializedProject): void;
  reject(error: Error): void;
}

/** Canonical BBS archive writer with bounded, owned worker requests and explicit fallback policy. */
export class WorkerProjectSerializer implements ProjectSerializerPort {
  private readonly fallback: ProjectSerializerPort;
  private readonly createWorker: (() => Worker) | undefined;
  private readonly timeoutMs: number;
  private worker: Worker | undefined;
  private unavailable = false;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Set<(error: Error) => void>();
  private disposed = false;

  constructor(options: WorkerProjectSerializerOptions = {}) {
    this.fallback = options.fallback ?? new Bbs3mfProjectSerializer();
    this.createWorker = options.createWorker ?? defaultWorkerFactory();
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 300_000);
  }

  async serialize(
    snapshot: ProjectArchiveSnapshot,
    cancellation?: CancellationToken,
    options: ProjectSerializationOptions = {},
  ): Promise<SerializedProject> {
    this.assertActive();
    if (cancellation?.aborted) throw cancellationError(cancellation);
    const worker = this.ensureWorker(options.purpose === 'manual');
    if (!worker) {
      if (options.purpose === 'recovery') throw new ProjectSerializerUnavailableError();
      return this.track(() => this.fallback.serialize(snapshot, cancellation, options), cancellation);
    }
    const requestId = `serialize-${++this.sequence}`;
    const request: SerializeWorkerRequest = {
      protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
      requestId,
      snapshot: {
        state: snapshot.state,
        assets: snapshot.assets.map((asset) => ({
          descriptor: asset.descriptor,
          bytes: asset.bytes.slice(),
        })),
        sourceRevision: snapshot.sourceRevision,
        sourceHash: snapshot.sourceHash,
      },
    };
    return this.track(
      () =>
        new Promise<SerializedProject>((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          try {
            worker.postMessage(
              request,
              request.snapshot.assets.map((asset) => asset.bytes.buffer as ArrayBuffer),
            );
          } catch {
            this.pending.delete(requestId);
            this.recycle(new Error('Project serializer worker could not accept the archive'), true);
            if (options.purpose === 'recovery' || options.purpose === 'manual')
              reject(new ProjectSerializerUnavailableError());
            else this.fallback.serialize(snapshot, cancellation, options).then(resolve, reject);
          }
        }),
      cancellation,
      (error) => this.recycle(error, false),
    )
      .catch((error: unknown) => {
        if (options.purpose === 'manual' && this.unavailable && !this.disposed && !cancellation?.aborted)
          return this.track(() => this.fallback.serialize(snapshot, cancellation, options), cancellation);
        throw error;
      })
      .finally(() => this.pending.delete(requestId));
  }

  async deserialize(
    bytes: Uint8Array,
    cancellation?: CancellationToken,
  ): Promise<{
    state: ProjectState;
    assets: AssetPayload[];
    warnings: string[];
  }> {
    this.assertActive();
    return this.track(() => this.fallback.deserialize(bytes, cancellation), cancellation);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Project serializer worker disposed');
    this.recycle(error, true);
    for (const reject of [...this.active]) reject(error);
  }

  private ensureWorker(retry: boolean): Worker | undefined {
    if (this.worker) return this.worker;
    if (!this.createWorker || (this.unavailable && !retry)) return undefined;
    try {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      worker.onerror = () => this.recycle(new Error('Project serializer worker failed'), true);
      worker.onmessageerror = () =>
        this.recycle(new Error('Project serializer worker sent an unreadable message'), true);
      this.unavailable = false;
      this.worker = worker;
      return worker;
    } catch {
      this.unavailable = true;
      return undefined;
    }
  }

  private receive(message: unknown): void {
    if (!validResponse(message)) {
      this.recycle(new Error('Project serializer worker sent an invalid response'), true);
      return;
    }
    const settle = this.pending.get(message.requestId);
    if (!settle) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      settle.reject(error);
    } else
      settle.resolve({
        ...message.result,
        warnings: [...message.result.warnings],
      });
  }

  private recycle(error: Error, unavailable: boolean): void {
    if (unavailable) this.unavailable = true;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const settle of pending) settle.reject(error);
  }

  /** Also owns asynchronous manual fallbacks, so disposal/cancellation always settles callers. */
  private track<T>(
    start: () => Promise<T>,
    cancellation?: CancellationToken,
    abort?: (error: Error) => void,
  ): Promise<T> {
    this.assertActive();
    if (cancellation?.aborted) return Promise.reject(cancellationError(cancellation));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        this.active.delete(fail);
        if (error) reject(error);
        else resolve(value as T);
      };
      const fail = (error: Error) => finish(error);
      const cancel = (error: Error) => {
        abort?.(error);
        finish(error);
      };
      const timeout = setTimeout(() => cancel(new Error('Project serialization timed out')), this.timeoutMs);
      if (cancellation)
        poll = setInterval(() => {
          if (cancellation.aborted) cancel(cancellationError(cancellation));
        }, 20);
      this.active.add(fail);
      try {
        start().then(
          (value) => {
            if (cancellation?.aborted) cancel(cancellationError(cancellation));
            else finish(undefined, value);
          },
          (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Project serializer worker disposed');
  }
}

function validResponse(value: unknown): value is SerializeWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const message = value as SerializeWorkerResponse;
  if (message.protocolVersion !== PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION || typeof message.requestId !== 'string')
    return false;
  if (message.type === 'error')
    return typeof message.error?.name === 'string' && typeof message.error.message === 'string';
  if (message.type !== 'serialized') return false;
  const result = message.result;
  return (
    result?.bytes instanceof Uint8Array &&
    typeof result.mediaType === 'string' &&
    typeof result.suggestedFilename === 'string' &&
    Number.isSafeInteger(result.sourceRevision) &&
    result.sourceRevision >= 0 &&
    typeof result.sourceHash === 'string' &&
    (result.archiveDigest === undefined ||
      (typeof result.archiveDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(result.archiveDigest))) &&
    Array.isArray(result.warnings) &&
    result.warnings.every((warning) => typeof warning === 'string')
  );
}
function defaultWorkerFactory(): (() => Worker) | undefined {
  if (typeof Worker === 'undefined') return undefined;
  return () =>
    new Worker(new URL('./projectArchive.worker.ts', import.meta.url), {
      type: 'module',
    });
}
function cancellationError(cancellation: CancellationToken | undefined): Error {
  const error = new Error(cancellation?.reason ?? 'Project serialization cancelled');
  error.name = 'AbortError';
  return error;
}
