import type { ProjectIntentWire, ProjectBatchWire } from '../../../contracts/generated/project-intents';
import { prepareProjectIntent, prepareProjectBatch } from './PreparedProjectCommands';
import type { ProjectCommand } from './history/command';
import type { CommandHistorySnapshot } from './history/commandBus';
import type { CancellationToken, ProjectExportGuard } from './ports';
import type { EditorSession } from './session';

export const MAX_PENDING_SESSION_OPERATIONS = 32;
export const MAX_SESSION_TRANSACTION_COMMANDS = 64;

export type AsyncSessionErrorCode = 'disposed' | 'stale' | 'cancelled' | 'busy' | 'invalid-request';

export class AsyncSessionError extends Error {
  constructor(readonly code: AsyncSessionErrorCode) {
    super(
      {
        disposed: 'The project session is closed.',
        stale: 'The project or its history changed. Review the current state and try again.',
        cancelled: 'The project operation was cancelled.',
        busy: 'Too many project operations are pending.',
        'invalid-request': 'The project operation request is invalid.',
      }[code],
    );
    this.name = 'AsyncSessionError';
  }
}

/** Local owner token, deliberately not a worker/JNI wire contract. */
export interface AsyncSessionGuard {
  readonly generation: symbol;
  readonly project: ProjectExportGuard;
  readonly historyRevision: number;
}

export interface AsyncSessionSnapshot {
  readonly guard: AsyncSessionGuard;
  readonly history: CommandHistorySnapshot;
}

export interface AsyncSessionAcknowledgement<T> extends AsyncSessionSnapshot {
  readonly requestId: number;
  readonly value: T;
}

export interface AsyncSessionRequestOptions {
  /** Captured before any asynchronous preparation, or at submission by default. */
  readonly guard?: AsyncSessionGuard;
  readonly cancellation?: CancellationToken;
}

/**
 * Transitional asynchronous facade over the existing TypeScript authority.
 * Prepared plate intents are captured through generated validation; other
 * commands still use trusted local objects. No callback transaction crosses this boundary. Queries are ordered
 * with mutations, and queued mutations never silently rebase their guard.
 */
export class AsyncEditorSession {
  private readonly generation = Symbol('editor-session');
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly session: EditorSession) {}

  captureGuard(): AsyncSessionGuard {
    this.assertActive();
    return this.snapshot().guard;
  }

  /** Whether a local acknowledgement still describes this live authority. */
  isCurrent(guard: AsyncSessionGuard): boolean {
    try {
      this.assertActive();
      return (
        guard.generation === this.generation &&
        this.session.isExportCurrent(guard.project) &&
        this.session.commands.getHistoryRevision() === guard.historyRevision
      );
    } catch {
      return false;
    }
  }

  query(cancellation?: CancellationToken): Promise<AsyncSessionAcknowledgement<void>> {
    return this.enqueue(() => undefined, undefined, cancellation);
  }

  execute(
    command: ProjectCommand,
    options: AsyncSessionRequestOptions & { readonly coalesce?: boolean } = {},
  ): Promise<AsyncSessionAcknowledgement<void>> {
    const coalesce = options.coalesce;
    return this.mutate(() => this.session.execute(command, { coalesce }), options);
  }

  /** Serializable prepared command; ownership guards remain local until the session transport lands. */
  executeIntent(
    intent: ProjectIntentWire,
    options: AsyncSessionRequestOptions = {},
  ): Promise<AsyncSessionAcknowledgement<void>> {
    try {
      const guard = options.guard ?? this.captureGuard();
      const prepared = prepareProjectIntent(intent);
      return this.execute(prepared, { ...options, guard });
    } catch (error) {
      return Promise.reject(error instanceof AsyncSessionError ? error : new AsyncSessionError('invalid-request'));
    }
  }

  transactionIntents(
    batch: ProjectBatchWire,
    options: AsyncSessionRequestOptions = {},
  ): Promise<AsyncSessionAcknowledgement<void>> {
    try {
      const guard = options.guard ?? this.captureGuard();
      const prepared = prepareProjectBatch(batch);
      return this.transaction(prepared.label, prepared.commands, { ...options, guard });
    } catch (error) {
      return Promise.reject(error instanceof AsyncSessionError ? error : new AsyncSessionError('invalid-request'));
    }
  }

  transaction(
    label: string,
    commands: readonly ProjectCommand[],
    options: AsyncSessionRequestOptions = {},
  ): Promise<AsyncSessionAcknowledgement<void>> {
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 256 ||
      !Array.isArray(commands) ||
      commands.length > MAX_SESSION_TRANSACTION_COMMANDS ||
      Array.from(commands).some((command) => !command)
    )
      return Promise.reject(new AsyncSessionError('invalid-request'));
    // The bounded list is captured now. Command objects retain their existing
    // local ownership contract; caller mutation is not a supported transport.
    const batch = [...commands];
    return this.mutate(() => {
      this.session.transaction(label, () => {
        for (const command of batch) this.session.execute(command);
      });
    }, options);
  }

  undo(options: AsyncSessionRequestOptions = {}): Promise<AsyncSessionAcknowledgement<boolean>> {
    return this.mutate(() => this.session.undo(), options);
  }

  redo(options: AsyncSessionRequestOptions = {}): Promise<AsyncSessionAcknowledgement<boolean>> {
    return this.mutate(() => this.session.redo(), options);
  }

  /** Invalidates queued work without disposing the separately owned session. */
  dispose(): void {
    this.disposed = true;
  }

  private mutate<T>(operation: () => T, options: AsyncSessionRequestOptions): Promise<AsyncSessionAcknowledgement<T>> {
    try {
      this.assertActive();
      const supplied = options.guard ?? this.captureGuard();
      if (supplied.generation !== this.generation) throw new AsyncSessionError('stale');
      // A request cannot follow later mutation of the caller's guard object.
      const guard: AsyncSessionGuard = Object.freeze({
        generation: supplied.generation,
        project: Object.freeze({ ...supplied.project }),
        historyRevision: supplied.historyRevision,
      });
      return this.enqueue(operation, guard, options.cancellation);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private enqueue<T>(
    operation: () => T,
    guard?: AsyncSessionGuard,
    cancellation?: CancellationToken,
  ): Promise<AsyncSessionAcknowledgement<T>> {
    try {
      this.assertActive();
      if (cancellation?.aborted) throw new AsyncSessionError('cancelled');
      if (this.pending >= MAX_PENDING_SESSION_OPERATIONS) throw new AsyncSessionError('busy');
      if (!Number.isSafeInteger(this.sequence + 1)) throw new AsyncSessionError('invalid-request');
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = ++this.sequence;
    this.pending++;
    const result = this.tail
      .then(() => {
        this.assertActive();
        if (cancellation?.aborted) throw new AsyncSessionError('cancelled');
        if (
          guard &&
          (!this.session.isExportCurrent(guard.project) ||
            this.session.commands.getHistoryRevision() !== guard.historyRevision)
        )
          throw new AsyncSessionError('stale');
        // The current bus commits synchronously. Cancellation/disposal raised by
        // an observer after commit must not report that accepted edit as undone.
        const value = operation();
        return Object.freeze({ ...this.snapshot(), requestId, value });
      })
      .finally(() => {
        this.pending--;
      });
    // A failed request never poisons later reads, retries or mutations.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private snapshot(): AsyncSessionSnapshot {
    const current = this.session.project.getSnapshot();
    const history = this.session.commands.getHistorySnapshot();
    return Object.freeze({
      guard: Object.freeze({
        generation: this.generation,
        project: Object.freeze({
          projectId: current.state.id,
          revision: current.revision,
          semanticHash: current.hash,
          assetFingerprint: this.session.assets.bundleFingerprint(),
        }),
        historyRevision: this.session.commands.getHistoryRevision(),
      }),
      history: Object.freeze({ ...history, dirtyCategories: Object.freeze([...history.dirtyCategories]) }),
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new AsyncSessionError('disposed');
    try {
      this.session.captureExportGuard();
    } catch {
      throw new AsyncSessionError('disposed');
    }
  }
}
