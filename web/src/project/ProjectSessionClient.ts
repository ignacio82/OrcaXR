import {
  captureProjectSessionRequest,
  decodeProjectSessionReply,
  encodeProjectSessionRequest,
  PROJECT_INTENT_SESSION_VERSION,
  PROJECT_INTENT_VERSION,
  PROJECT_INTENT_MAX_BYTES,
  PROJECT_INTENT_MAX_NODES,
  type ProjectGenerationWire,
  type ProjectSessionOperationWire,
  type ProjectSessionAcknowledgementWire,
  type ProjectSessionErrorWire,
  type ProjectCancelStatusWire,
  type ProjectSessionResultWire,
} from '../../../contracts/generated/project-intents';
import { MAX_PENDING_SESSION_OPERATIONS } from './AsyncEditorSession';
import { isStableEntityId } from './domain/ids';

export type ProjectSessionOperation = Exclude<
  ProjectSessionOperationWire,
  { readonly hello: unknown } | { readonly close: unknown } | { readonly cancel: unknown }
>;
export type ProjectSessionExchange = (request: string) => Promise<string>;
export type ProjectSessionClientErrorCode = ProjectSessionErrorWire | 'outcomeUnknown';

export class ProjectSessionClientError extends Error {
  constructor(readonly code: ProjectSessionClientErrorCode) {
    super(
      code === 'outcomeUnknown'
        ? 'The project operation outcome could not be verified. Refresh the session before editing again.'
        : `The project session rejected the operation (${code}).`,
    );
    this.name = 'ProjectSessionClientError';
  }
}

/** A completed operation, never a rejection or a reason to retry it. */
export type ProjectSessionCompletion =
  | { readonly requestId: number; readonly acknowledged: ProjectSessionAcknowledgementWire }
  | { readonly requestId: number; readonly receiptUnavailable: boolean };
export interface ProjectSessionTicket {
  readonly result: Promise<ProjectSessionCompletion>;
  /** requested is cooperative intent. The operation result remains authoritative. */
  cancel(): Promise<ProjectCancelStatusWire>;
}

/** One ordered, reliable string connection. Transport failures fail this client
 * closed; callers must reconcile authority rather than retry an uncertain edit.
 * This client owns no project, assets, callbacks in payloads or native handles. */
export class ProjectSessionClient {
  private readonly generation: ProjectGenerationWire;
  private readonly ready: Promise<void>;
  private sequence = 0;
  private pending = 0;
  private closed = false;
  private failed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly exchange: ProjectSessionExchange,
    generation: ProjectGenerationWire,
    private readonly projectSchemaVersion: number,
  ) {
    const hello = captureProjectSessionRequest({
      protocolVersion: PROJECT_INTENT_SESSION_VERSION,
      generation,
      requestId: 1,
      operation: {
        hello: {
          minProtocolVersion: PROJECT_INTENT_SESSION_VERSION,
          maxProtocolVersion: PROJECT_INTENT_SESSION_VERSION,
          projectSchemaVersion,
          intentVersion: PROJECT_INTENT_VERSION,
        },
      },
    });
    this.generation = hello.generation;
    this.ready = this.send(hello.operation).result.then((reply) => {
      const value = reply.result;
      if (!('welcome' in value)) return this.uncertain();
      const welcome = value.welcome;
      if (
        welcome.protocolVersion !== PROJECT_INTENT_SESSION_VERSION ||
        welcome.projectSchemaVersion !== this.projectSchemaVersion ||
        welcome.intentVersion !== PROJECT_INTENT_VERSION ||
        welcome.maxPending !== MAX_PENDING_SESSION_OPERATIONS ||
        welcome.maxBytes !== PROJECT_INTENT_MAX_BYTES ||
        welcome.maxNodes !== PROJECT_INTENT_MAX_NODES
      ) {
        this.failed = true;
        throw new ProjectSessionClientError('unsupportedVersion');
      }
    });
    // Initialization may finish before the first operation attaches a handler.
    void this.ready.catch(() => undefined);
  }

  submit(operation: ProjectSessionOperation): ProjectSessionTicket {
    try {
      this.assertActive();
      if (this.pending >= MAX_PENDING_SESSION_OPERATIONS) throw new ProjectSessionClientError('busy');
      // Own the entire payload now, before the handshake or any other await.
      const captured = captureProjectSessionRequest({
        protocolVersion: PROJECT_INTENT_SESSION_VERSION,
        generation: this.generation,
        requestId: 1,
        operation,
      }).operation;
      if ('hello' in captured || 'close' in captured || 'cancel' in captured)
        throw new ProjectSessionClientError('invalidRequest');
      this.pending++;
      let cancelled = false;
      let settled = false;
      let requestId: number | undefined;
      let cancelling: Promise<ProjectCancelStatusWire> | undefined;
      const result = this.ready
        .then(() => {
          this.assertActive();
          if (cancelled) throw new ProjectSessionClientError('cancelled');
          const sent = this.send(captured);
          requestId = sent.requestId;
          return sent.result;
        })
        .then((reply) => {
          if ('receiptUnavailable' in reply.result)
            return Object.freeze({ requestId: reply.requestId, receiptUnavailable: reply.result.receiptUnavailable });
          if (!('acknowledged' in reply.result) || !validAcknowledgement(reply.result.acknowledged))
            return this.uncertain();
          return Object.freeze({ requestId: reply.requestId, acknowledged: reply.result.acknowledged });
        })
        .finally(() => {
          this.pending--;
          settled = true;
        });
      return {
        result,
        cancel: () => {
          if (settled) return Promise.resolve('notPending');
          cancelled = true;
          if (requestId === undefined) return Promise.resolve('requested');
          if (!cancelling)
            cancelling = this.send({ cancel: { targetRequestId: requestId } }).result.then((reply) => {
              if (!('cancelled' in reply.result)) return this.uncertain();
              return reply.result.cancelled;
            });
          return cancelling;
        },
      };
    } catch (error) {
      return {
        result: Promise.reject(
          error instanceof ProjectSessionClientError ? error : new ProjectSessionClientError('invalidRequest'),
        ),
        cancel: () => Promise.resolve('notPending'),
      };
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.send({ close: {} }).result.then((reply) => {
      if (!('closed' in reply.result)) return this.uncertain();
    });
    return this.closing;
  }

  private assertActive(): void {
    if (this.closed) throw new ProjectSessionClientError('disposed');
    if (this.failed) throw new ProjectSessionClientError('outcomeUnknown');
  }
  private uncertain(): never {
    this.failed = true;
    throw new ProjectSessionClientError('outcomeUnknown');
  }
  private send(operation: ProjectSessionOperationWire): {
    readonly requestId: number;
    readonly result: Promise<{ readonly requestId: number; readonly result: ProjectSessionResultWire }>;
  } {
    const requestId = ++this.sequence;
    let response: Promise<string>;
    try {
      const message = encodeProjectSessionRequest({
        protocolVersion: PROJECT_INTENT_SESSION_VERSION,
        generation: this.generation,
        requestId,
        operation,
      });
      // Invoke synchronously to preserve request order, without waiting on replies.
      response = this.exchange(message);
    } catch {
      this.failed = true;
      response = Promise.reject(new ProjectSessionClientError('outcomeUnknown'));
    }
    return {
      requestId,
      result: response.then(
        (text) => {
          let reply;
          try {
            reply = decodeProjectSessionReply(text);
          } catch {
            return this.uncertain();
          }
          if (reply.requestId !== requestId || !sameSessionGeneration(reply.generation, this.generation))
            return this.uncertain();
          if ('error' in reply.result) throw new ProjectSessionClientError(reply.result.error);
          return reply;
        },
        () => this.uncertain(),
      ),
    };
  }
}

export function sameSessionGeneration(a: ProjectGenerationWire, b: ProjectGenerationWire): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index]);
}
export function sessionText(units: readonly number[]): string {
  let result = '';
  for (let offset = 0; offset < units.length; offset += 4096)
    result += String.fromCharCode(...units.slice(offset, offset + 4096));
  return result;
}
function validAcknowledgement(value: ProjectSessionAcknowledgementWire): boolean {
  const { guard, history } = value;
  const fingerprint = /^fnv1a64:[0-9a-f]{16}$/;
  if (
    !isStableEntityId(sessionText(guard.projectId)) ||
    !fingerprint.test(sessionText(guard.semanticHash)) ||
    !fingerprint.test(sessionText(guard.assetFingerprint)) ||
    new Set(history.dirtyCategories).size !== history.dirtyCategories.length
  )
    return false;
  for (const [count, label] of [
    [history.undoCount, history.undoLabel],
    [history.redoCount, history.redoLabel],
  ] as const) {
    if (
      label.present !== count > 0 ||
      (!label.present && (label.text.length > 0 || label.truncated)) ||
      (label.truncated && label.text.length !== 256)
    )
      return false;
  }
  return true;
}
