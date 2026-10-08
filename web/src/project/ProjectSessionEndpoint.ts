import { sessionText, sameSessionGeneration } from './ProjectSessionClient';
import {
  decodeProjectSessionRequest,
  captureProjectSessionReply,
  encodeProjectSessionReply,
  PROJECT_INTENT_SESSION_VERSION,
  PROJECT_INTENT_VERSION,
  PROJECT_INTENT_MAX_BYTES,
  PROJECT_INTENT_MAX_NODES,
  type ProjectGenerationWire,
  type ProjectSessionGuardWire,
  type ProjectSessionHistoryWire,
  type ProjectSessionResultWire,
  type ProjectSessionErrorWire,
  type ProjectSessionRequestWire,
} from '../../../contracts/generated/project-intents';
import {
  AsyncEditorSession,
  AsyncSessionError,
  MAX_PENDING_SESSION_OPERATIONS,
  type AsyncSessionGuard,
  type AsyncSessionAcknowledgement,
} from './AsyncEditorSession';
import { entityId, isStableEntityId } from './domain/ids';
import { intentText } from './PreparedProjectCommands';
import type { CommandHistorySnapshot } from './history/commandBus';
import {
  takeStagedWork,
  StagedWorkSlot,
  StagedInputError,
  type StagedProjectWork,
  type ProjectStagingLimits,
  type ProjectStagingUsage,
} from './StagedProjectCommands';

export function wireSessionGuard(guard: AsyncSessionGuard): ProjectSessionGuardWire {
  return {
    projectId: intentText(guard.project.projectId),
    revision: guard.project.revision,
    semanticHash: intentText(guard.project.semanticHash),
    assetFingerprint: intentText(guard.project.assetFingerprint),
    historyRevision: guard.historyRevision,
  };
}
export function localSessionGuard(guard: ProjectSessionGuardWire, generation: symbol): AsyncSessionGuard {
  const projectId = sessionText(guard.projectId);
  if (!isStableEntityId(projectId)) throw new AsyncSessionError('invalid-request');
  return Object.freeze({
    generation,
    historyRevision: guard.historyRevision,
    project: Object.freeze({
      projectId: entityId<'project'>(projectId),
      revision: guard.revision,
      semanticHash: sessionText(guard.semanticHash),
      assetFingerprint: sessionText(guard.assetFingerprint),
    }),
  });
}
function historyWire(history: CommandHistorySnapshot): ProjectSessionHistoryWire {
  const label = (value: string | undefined) => ({
    text: intentText(value?.slice(0, 256) ?? ''),
    present: value !== undefined,
    truncated: (value?.length ?? 0) > 256,
  });
  return {
    undoCount: history.undoCount,
    redoCount: history.redoCount,
    undoLabel: label(history.undoLabel),
    redoLabel: label(history.redoLabel),
    dirtyCategories: history.dirtyCategories,
  };
}

/** One ordered connection to an existing authority. Only strings cross handle();
 * local command objects, owner symbols and mutable cancellation tokens stay here.
 * The host owns authentication, the generation nonce, and the underlying session. */
export class ProjectSessionEndpoint {
  private readonly generation: ProjectGenerationWire;
  private lastRequest = 0;
  private ready = false;
  private disposed = false;
  private readonly pending = new Map<number, { aborted: boolean; release?: () => void }>();
  private stagingLimits: ProjectStagingLimits = { maxResources: 0, maxCommands: 0, maxUnits: 0, maxAssetBytes: 0 };
  private stagingUsed = { resources: 0, commands: 0, units: 0, assetBytes: 0 };
  private stagedSequence = 0;
  private readonly staged = new Map<number, { readonly guard: AsyncSessionGuard; readonly slot: StagedWorkSlot }>();
  private commandFailures?: Map<number, unknown>;

  /**
   * For an in-process owner only: keep each failed command's own error, by
   * request, for {@link takeCommandFailure}. The wire still carries only
   * `commandFailed`; a remote session never sees the error itself.
   */
  retainCommandFailures(): void {
    this.commandFailures ??= new Map();
  }
  /** The error a retained failed command threw, once. */
  takeCommandFailure(requestId: number): unknown {
    const failure = this.commandFailures?.get(requestId);
    this.commandFailures?.delete(requestId);
    return failure;
  }

  configureStaging(limits: ProjectStagingLimits): void {
    if (this.disposed) throw new AsyncSessionError('disposed');
    const owned = {
      maxResources: limits.maxResources,
      maxCommands: limits.maxCommands,
      maxUnits: limits.maxUnits,
      maxAssetBytes: limits.maxAssetBytes,
    };
    if (!Object.values(owned).every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new AsyncSessionError('invalid-request');
    if (!this.fits(this.stagingUsed, owned)) throw new AsyncSessionError('busy');
    this.stagingLimits = owned;
  }
  stagingUsage(): ProjectStagingUsage {
    return Object.freeze({ ...this.stagingUsed });
  }
  stage(value: StagedProjectWork, guard: AsyncSessionGuard): number {
    let owned;
    try {
      owned = takeStagedWork(value);
    } catch {
      throw new AsyncSessionError('invalid-request');
    }
    if (this.disposed) throw new AsyncSessionError('disposed');
    if (!this.session.isCurrent(guard)) throw new AsyncSessionError('stale');
    const usage = {
      resources: this.stagingUsed.resources + 1,
      commands: this.stagingUsed.commands + value.commandCount,
      units: this.stagingUsed.units + value.inputUnits,
      assetBytes: this.stagingUsed.assetBytes + value.assetBytes,
    };
    if (
      !Number.isSafeInteger(this.stagedSequence + 1) ||
      !Object.values(usage).every(Number.isSafeInteger) ||
      !this.fits(usage, this.stagingLimits)
    )
      throw new AsyncSessionError('resourceLimit');
    const capturedGuard = this.session.captureGuard();
    this.stagingUsed = usage;
    const slot = new StagedWorkSlot(owned, () => {
      this.stagingUsed.resources--;
      this.stagingUsed.commands -= value.commandCount;
      this.stagingUsed.units -= value.inputUnits;
      this.stagingUsed.assetBytes -= value.assetBytes;
    });
    const id = ++this.stagedSequence;
    this.staged.set(id, { guard: capturedGuard, slot });
    return id;
  }
  /** Host cleanup is also safe after transport failure: it only releases input
   * that has not been accepted. It never cancels, retries or undoes an edit. */
  releaseStaged(id: number): boolean {
    const resource = this.staged.get(id);
    if (!resource) return false;
    this.staged.delete(id);
    resource.slot.release();
    return true;
  }
  private fits(usage: ProjectStagingUsage, limits: ProjectStagingLimits): boolean {
    return (
      usage.resources <= limits.maxResources &&
      usage.commands <= limits.maxCommands &&
      usage.units <= limits.maxUnits &&
      usage.assetBytes <= limits.maxAssetBytes
    );
  }

  constructor(
    private readonly session: AsyncEditorSession,
    generation: ProjectGenerationWire,
    private readonly projectSchemaVersion: number,
  ) {
    // Exercise the generated shape before retaining a caller-owned nonce.
    const reply = captureProjectSessionReply({
      protocolVersion: PROJECT_INTENT_SESSION_VERSION,
      generation,
      requestId: 0,
      result: {
        welcome: {
          protocolVersion: PROJECT_INTENT_SESSION_VERSION,
          projectSchemaVersion,
          intentVersion: PROJECT_INTENT_VERSION,
          maxPending: MAX_PENDING_SESSION_OPERATIONS,
          maxBytes: PROJECT_INTENT_MAX_BYTES,
          maxNodes: PROJECT_INTENT_MAX_NODES,
        },
      },
    });
    this.generation = reply.generation;
  }

  handle(text: string): Promise<string> {
    let request: ProjectSessionRequestWire;
    try {
      request = decodeProjectSessionRequest(text);
    } catch {
      return Promise.resolve(this.reply(0, { error: 'invalidRequest' }));
    }
    const respond = (result: ProjectSessionResultWire) => this.reply(request.requestId, result, request.generation);
    const reject = (error: ProjectSessionErrorWire) => Promise.resolve(respond({ error }));
    if (!sameSessionGeneration(request.generation, this.generation)) return reject('wrongSession');
    if (request.protocolVersion !== PROJECT_INTENT_SESSION_VERSION) return reject('unsupportedVersion');
    if (this.disposed) return reject('disposed');
    if (request.requestId <= this.lastRequest) return reject('duplicateRequest');
    this.lastRequest = request.requestId;
    const operation = request.operation;
    if ('close' in operation) {
      this.dispose();
      return Promise.resolve(respond({ closed: {} }));
    }
    if ('hello' in operation) {
      try {
        this.session.captureGuard();
      } catch {
        return reject('disposed');
      }
      const hello = operation.hello;
      if (
        hello.minProtocolVersion > PROJECT_INTENT_SESSION_VERSION ||
        hello.maxProtocolVersion < PROJECT_INTENT_SESSION_VERSION ||
        hello.minProtocolVersion > hello.maxProtocolVersion ||
        hello.projectSchemaVersion !== this.projectSchemaVersion ||
        hello.intentVersion !== PROJECT_INTENT_VERSION
      )
        return reject('unsupportedVersion');
      this.ready = true;
      return Promise.resolve(
        respond({
          welcome: {
            protocolVersion: PROJECT_INTENT_SESSION_VERSION,
            projectSchemaVersion: this.projectSchemaVersion,
            intentVersion: PROJECT_INTENT_VERSION,
            maxPending: MAX_PENDING_SESSION_OPERATIONS,
            maxBytes: PROJECT_INTENT_MAX_BYTES,
            maxNodes: PROJECT_INTENT_MAX_NODES,
          },
        }),
      );
    }
    if (!this.ready) return reject('notReady');
    if ('cancel' in operation) {
      const token = this.pending.get(operation.cancel.targetRequestId);
      if (token) {
        token.aborted = true;
        token.release?.();
      }
      // Requested is cooperative intent, never a claim that an edit was undone.
      return Promise.resolve(respond({ cancelled: token ? 'requested' : 'notPending' }));
    }
    if ('releaseStaged' in operation)
      return Promise.resolve(respond({ released: this.releaseStaged(operation.releaseStaged.stagedId) }));
    if (this.pending.size >= MAX_PENDING_SESSION_OPERATIONS) return reject('busy');
    const cancellation: { aborted: boolean; release?: () => void } = { aborted: false };
    this.pending.set(request.requestId, cancellation);
    let work: Promise<AsyncSessionAcknowledgement<void | boolean>>;
    let before: AsyncSessionGuard;
    try {
      before = this.session.captureGuard();
      const guarded = (value: ProjectSessionGuardWire) => ({
        guard: localSessionGuard(value, before.generation),
        cancellation,
      });
      if ('executeStaged' in operation) {
        const resource = this.staged.get(operation.executeStaged.stagedId);
        if (!resource) throw new AsyncSessionError('invalid-request');
        this.staged.delete(operation.executeStaged.stagedId);
        cancellation.release = () => resource.slot.release();
        work = this.session.executeStaged(resource.slot, { guard: resource.guard, cancellation });
      } else if ('execute' in operation)
        work = this.session.executeIntent(operation.execute.intent, guarded(operation.execute.guard));
      else if ('transaction' in operation)
        work = this.session.transactionIntents(operation.transaction.batch, guarded(operation.transaction.guard));
      else if ('undo' in operation) work = this.session.undo(guarded(operation.undo));
      else if ('redo' in operation) work = this.session.redo(guarded(operation.redo));
      else work = this.session.query(cancellation);
    } catch (error) {
      work = Promise.reject(error);
    }
    return work
      .then(
        (receipt) => {
          const changed =
            'query' in operation
              ? false
              : typeof receipt.value === 'boolean'
                ? receipt.value
                : receipt.guard.project.revision !== before.project.revision ||
                  receipt.guard.historyRevision !== before.historyRevision;
          try {
            return respond({
              acknowledged: { guard: wireSessionGuard(receipt.guard), history: historyWire(receipt.history), changed },
            });
          } catch {
            // A large restored/imported ID or exhausted counter can make a snapshot
            // unencodable *after* undo commits. Preserve the known completed outcome.
            return respond({ receiptUnavailable: changed });
          }
        },
        (error) => {
          const code = sessionErrorCode(error);
          if (code === 'commandFailed' && this.commandFailures) {
            this.commandFailures.set(request.requestId, error);
            // An owner that never asks cannot grow this past the queue bound.
            if (this.commandFailures.size > MAX_RETAINED_COMMAND_FAILURES)
              this.commandFailures.delete(this.commandFailures.keys().next().value as number);
          }
          return respond({ error: code });
        },
      )
      .finally(() => this.pending.delete(request.requestId));
  }

  /** Close this connection and invalidate its queued work; never dispose assets. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.staged.values()) resource.slot.release();
    this.staged.clear();
    for (const pending of this.pending.values()) pending.release?.();
    this.session.dispose();
  }

  private reply(requestId: number, result: ProjectSessionResultWire, generation = this.generation): string {
    return encodeProjectSessionReply({
      protocolVersion: PROJECT_INTENT_SESSION_VERSION,
      generation,
      requestId,
      result,
    });
  }
}
const MAX_RETAINED_COMMAND_FAILURES = 64;
function sessionErrorCode(error: unknown): ProjectSessionErrorWire {
  if (error instanceof StagedInputError) return error.code === 'limit' ? 'resourceLimit' : 'invalidRequest';
  if (error instanceof AsyncSessionError) return error.code === 'invalid-request' ? 'invalidRequest' : error.code;
  return 'commandFailed';
}
