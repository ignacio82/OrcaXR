import type { AssetPayload } from '../assets';
import type { CancellationToken, ProjectArchiveSnapshot, ProjectSerializerPort, SerializedProject } from '../ports';
import type { ProjectState } from '../domain/model';
import { Bbs3mfProjectSerializer } from './Bbs3mfProjectSerializer';
import {
  PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
  type SerializeWorkerRequest,
  type SerializeWorkerResponse,
} from './ProjectSerializerProtocol';

export interface WorkerProjectSerializerOptions {
  /** Dependency seam: tests and non-worker hosts supply their own factory. */
  readonly createWorker?: () => Worker;
  /** Used when no worker can be constructed at all. */
  readonly fallback?: ProjectSerializerPort;
}

/**
 * Authors the slice/save archive on a worker.
 *
 * Building a plate's 3MF is not a small step on a large project: a
 * two-million-facet model spends seconds writing its core model XML and
 * compressing it, and doing that on the main thread froze the app on every
 * slice and every save. Nothing about it needs the DOM, so it runs beside the
 * UI instead of in front of it.
 *
 * Reading stays on the caller's thread: project *import* already has its own
 * worker, and `deserialize` here would duplicate that boundary.
 */
export class WorkerProjectSerializer implements ProjectSerializerPort {
  private readonly fallback: ProjectSerializerPort;
  private readonly createWorker: (() => Worker) | undefined;
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: SerializedProject) => void; reject: (error: Error) => void }
  >();
  private disposed = false;

  constructor(options: WorkerProjectSerializerOptions = {}) {
    this.fallback = options.fallback ?? new Bbs3mfProjectSerializer();
    this.createWorker = options.createWorker ?? defaultWorkerFactory();
  }

  async serialize(snapshot: ProjectArchiveSnapshot, cancellation?: CancellationToken): Promise<SerializedProject> {
    if (cancellation?.aborted) throw cancellationError(cancellation);
    const worker = this.ensureWorker();
    // No worker in this host, or the worker died: the archive still has to be
    // written, and writing it slowly is better than not writing it.
    if (!worker) return this.fallback.serialize(snapshot, cancellation);

    this.sequence += 1;
    const requestId = `serialize-${this.sequence}`;
    const request: SerializeWorkerRequest = {
      protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
      requestId,
      snapshot: {
        state: snapshot.state as ProjectState,
        assets: snapshot.assets.map((asset: AssetPayload) => ({
          descriptor: asset.descriptor,
          // Copied, because the caller keeps owning its asset bytes.
          bytes: asset.bytes.slice(),
        })),
        sourceRevision: snapshot.sourceRevision,
        sourceHash: snapshot.sourceHash,
      },
    };

    return new Promise<SerializedProject>((resolve, reject) => {
      // The token is polled, not subscribed to; the caller already races this
      // promise against its own abort and timeout.
      const settle = {
        resolve: (value: SerializedProject) => {
          if (cancellation?.aborted) reject(cancellationError(cancellation));
          else resolve(value);
        },
        reject,
      };
      this.pending.set(requestId, settle);
      const transfer = request.snapshot.assets.map((asset) => asset.bytes.buffer as ArrayBuffer);
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(requestId);
        // A host that refuses the transfer list still gets a correct archive.
        this.fallback.serialize(snapshot, cancellation).then(resolve, reject);
        void error;
      }
    });
  }

  deserialize(
    bytes: Uint8Array,
    cancellation?: CancellationToken,
  ): Promise<{ state: ProjectState; assets: AssetPayload[]; warnings: string[] }> {
    return this.fallback.deserialize(bytes, cancellation);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('Project serializer worker disposed'));
    this.worker?.terminate();
    this.worker = undefined;
  }

  private ensureWorker(): Worker | undefined {
    if (this.disposed || !this.createWorker) return undefined;
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch {
      return undefined;
    }
    worker.onmessage = (event: MessageEvent<SerializeWorkerResponse>) => this.receive(event.data);
    worker.onerror = () => this.recycle(new Error('Project serializer worker failed'));
    worker.onmessageerror = () => this.recycle(new Error('Project serializer worker sent an unreadable message'));
    this.worker = worker;
    return worker;
  }

  private receive(message: SerializeWorkerResponse | undefined): void {
    if (message?.protocolVersion !== PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION) return;
    const settle = this.pending.get(message.requestId);
    if (!settle) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      settle.reject(error);
      return;
    }
    settle.resolve({
      bytes: message.result.bytes,
      mediaType: message.result.mediaType,
      suggestedFilename: message.result.suggestedFilename,
      sourceRevision: message.result.sourceRevision,
      sourceHash: message.result.sourceHash,
      warnings: [...message.result.warnings],
    });
  }

  private recycle(error: Error): void {
    this.rejectAll(error);
    this.worker?.terminate();
    this.worker = undefined;
  }

  private rejectAll(error: Error): void {
    for (const [, settle] of [...this.pending]) settle.reject(error);
    this.pending.clear();
  }
}

function defaultWorkerFactory(): (() => Worker) | undefined {
  if (typeof Worker === 'undefined') return undefined;
  return () => new Worker(new URL('./projectSerializer.worker.ts', import.meta.url), { type: 'module' });
}

function cancellationError(cancellation: CancellationToken | undefined): Error {
  const error = new Error(cancellation?.reason ?? 'Project serialization cancelled');
  error.name = 'AbortError';
  return error;
}
