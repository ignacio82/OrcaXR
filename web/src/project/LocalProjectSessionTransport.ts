import type {
  ProjectBatchWire,
  ProjectGenerationWire,
  ProjectIntentWire,
  ProjectSessionHistoryWire,
} from '../../../contracts/generated/project-intents';
import {
  AsyncEditorSession,
  AsyncSessionError,
  type AsyncSessionAcknowledgement,
  type AsyncSessionGuard,
} from './AsyncEditorSession';
import {
  ProjectSessionClient,
  ProjectSessionClientError,
  type ProjectSessionCompletion,
  type ProjectSessionOperation,
  sessionText,
} from './ProjectSessionClient';
import { ProjectSessionEndpoint, localSessionGuard, wireSessionGuard } from './ProjectSessionEndpoint';
import {
  discardStagedWork,
  type ProjectStagingLimits,
  type ProjectStagingUsage,
  type StagedProjectWork,
} from './StagedProjectCommands';

export interface TransportAcknowledgement<T> extends AsyncSessionAcknowledgement<T> {
  /** Preserves explicit display-label truncation without changing canonical history. */
  readonly wireHistory: ProjectSessionHistoryWire;
}
export class ProjectReceiptUnavailableError extends Error {
  constructor(readonly changed: boolean) {
    super('The project operation completed, but its summary is unavailable. Refresh the session before editing again.');
    this.name = 'ProjectReceiptUnavailableError';
  }
}

/** Browser transition adapter. The string endpoint uses the sole existing bus;
 * local owner tokens only appear outside that boundary. Projection subscriptions
 * still belong to the browser session until their separate migration. */
export class LocalProjectSessionTransport {
  private readonly owner: symbol;
  private readonly endpoint: ProjectSessionEndpoint;
  private readonly client: ProjectSessionClient;

  constructor(
    private readonly session: AsyncEditorSession,
    generation: ProjectGenerationWire,
    schemaVersion: number,
  ) {
    this.owner = session.captureGuard().generation;
    this.endpoint = new ProjectSessionEndpoint(session, generation, schemaVersion);
    // In process, a refused command reports the browser's own error.
    this.endpoint.retainCommandFailures();
    this.client = new ProjectSessionClient((text) => this.endpoint.handle(text), generation, schemaVersion);
  }

  executeIntent(
    intent: ProjectIntentWire,
    options: { readonly guard?: AsyncSessionGuard; readonly signal?: AbortSignal } = {},
  ): Promise<TransportAcknowledgement<void>> {
    return this.submit(
      () => ({ execute: { guard: this.guard(options.guard), intent } }),
      () => undefined,
      options.signal,
    );
  }
  configureStaging(limits: ProjectStagingLimits): void {
    this.endpoint.configureStaging(limits);
  }
  stagingUsage(): ProjectStagingUsage {
    return this.endpoint.stagingUsage();
  }
  executeStaged(
    work: StagedProjectWork,
    options: { readonly guard: AsyncSessionGuard; readonly signal?: AbortSignal },
  ): Promise<TransportAcknowledgement<void>> {
    try {
      if (!options?.guard) throw new AsyncSessionError('invalid-request');
      if (options.signal?.aborted) throw new AsyncSessionError('cancelled');
      const stagedId = this.endpoint.stage(work, options.guard);
      const releaseReady = () => {
        this.endpoint.releaseStaged(stagedId);
      };
      options.signal?.addEventListener('abort', releaseReady, { once: true });
      if (options.signal?.aborted) releaseReady();
      return this.submit(
        () => ({ executeStaged: { stagedId } }),
        () => undefined,
        options.signal,
      ).finally(() => {
        options.signal?.removeEventListener('abort', releaseReady);
        releaseReady();
      });
    } catch (error) {
      discardStagedWork(work);
      return Promise.reject(localError(error));
    }
  }
  transactionIntents(
    batch: ProjectBatchWire,
    options: { readonly guard?: AsyncSessionGuard } = {},
  ): Promise<TransportAcknowledgement<void>> {
    return this.submit(
      () => ({ transaction: { guard: this.guard(options.guard), batch } }),
      () => undefined,
    );
  }
  undo(options: { readonly guard?: AsyncSessionGuard } = {}): Promise<TransportAcknowledgement<boolean>> {
    return this.submit(
      () => ({ undo: this.guard(options.guard) }),
      (changed) => changed,
    );
  }
  redo(options: { readonly guard?: AsyncSessionGuard } = {}): Promise<TransportAcknowledgement<boolean>> {
    return this.submit(
      () => ({ redo: this.guard(options.guard) }),
      (changed) => changed,
    );
  }
  query(): Promise<TransportAcknowledgement<void>> {
    return this.submit(
      () => ({ query: {} }),
      () => undefined,
    );
  }
  dispose(): void {
    // Synchronous host teardown invalidates accepted work even if transport fails.
    void this.client.close().catch(() => undefined);
    this.endpoint.dispose();
  }

  private localFailure(error: unknown): unknown {
    if (error instanceof ProjectSessionClientError && error.code === 'commandFailed' && error.requestId !== undefined) {
      const failure = this.endpoint.takeCommandFailure(error.requestId);
      if (failure !== undefined) return failure;
    }
    return localError(error);
  }
  private guard(supplied?: AsyncSessionGuard) {
    const guard = supplied ?? this.session.captureGuard();
    if (guard.generation !== this.owner) throw new AsyncSessionError('stale');
    return wireSessionGuard(guard);
  }
  private submit<T>(
    operation: () => ProjectSessionOperation,
    value: (changed: boolean) => T,
    signal?: AbortSignal,
  ): Promise<TransportAcknowledgement<T>> {
    try {
      if (signal?.aborted) throw new AsyncSessionError('cancelled');
      const ticket = this.client.submit(operation());
      const cancel = () => {
        void ticket.cancel().catch(() => undefined);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      return ticket.result
        .then((receipt) => this.acknowledgement(receipt, value))
        .catch((error) => {
          throw this.localFailure(error);
        })
        .finally(() => signal?.removeEventListener('abort', cancel));
    } catch (error) {
      return Promise.reject(localError(error));
    }
  }
  private acknowledgement<T>(
    receipt: ProjectSessionCompletion,
    value: (changed: boolean) => T,
  ): TransportAcknowledgement<T> {
    if ('receiptUnavailable' in receipt) throw new ProjectReceiptUnavailableError(receipt.receiptUnavailable);
    const { guard, history, changed } = receipt.acknowledged;
    return Object.freeze({
      requestId: receipt.requestId,
      guard: localSessionGuard(guard, this.owner),
      value: value(changed),
      wireHistory: history,
      history: Object.freeze({
        undoCount: history.undoCount,
        redoCount: history.redoCount,
        undoLabel: history.undoLabel.present ? sessionText(history.undoLabel.text) : undefined,
        redoLabel: history.redoLabel.present ? sessionText(history.redoLabel.text) : undefined,
        dirtyCategories: history.dirtyCategories,
      }),
    });
  }
}
function localError(error: unknown): unknown {
  if (error instanceof ProjectSessionClientError) {
    if (error.code === 'invalidRequest') return new AsyncSessionError('invalid-request');
    if (error.code === 'stale' || error.code === 'disposed' || error.code === 'cancelled' || error.code === 'busy')
      return new AsyncSessionError(error.code);
  }
  return error;
}
