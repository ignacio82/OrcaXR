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
    this.client = new ProjectSessionClient((text) => this.endpoint.handle(text), generation, schemaVersion);
  }

  executeIntent(
    intent: ProjectIntentWire,
    options: { readonly guard?: AsyncSessionGuard } = {},
  ): Promise<TransportAcknowledgement<void>> {
    return this.submit(
      () => ({ execute: { guard: this.guard(options.guard), intent } }),
      () => undefined,
    );
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

  private guard(supplied?: AsyncSessionGuard) {
    const guard = supplied ?? this.session.captureGuard();
    if (guard.generation !== this.owner) throw new AsyncSessionError('stale');
    return wireSessionGuard(guard);
  }
  private submit<T>(
    operation: () => ProjectSessionOperation,
    value: (changed: boolean) => T,
  ): Promise<TransportAcknowledgement<T>> {
    try {
      return this.client
        .submit(operation())
        .result.then((receipt) => this.acknowledgement(receipt, value))
        .catch((error) => {
          throw localError(error);
        });
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
