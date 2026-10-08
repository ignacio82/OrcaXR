/**
 * A project session hosted off the UI thread, and its supervision.
 *
 * The worker owns the authority; the browser holds only what the session has
 * acknowledged. Each worker incarnation has its own session generation, so a
 * reply from a replaced or failed worker can never be taken for the current
 * one's. When a worker fails, every operation still in flight is rejected as
 * of unknown outcome, never retried; recovery opens a fresh incarnation from
 * the last checkpoint whose identity matches an acknowledgement, never from an
 * optimistic UI view, and reports what could not be accounted for.
 */
import type { ProjectGenerationWire } from '../../../contracts/generated/project-intents';
import {
  ProjectSessionClient,
  sessionText,
  type ProjectSessionOperation,
  type ProjectSessionTicket,
} from './ProjectSessionClient';

/** One acknowledged project state: the canonical document and its assets in
 * declaration order, with the identity the session reported for it. */
export interface SessionCheckpoint {
  readonly revision: number;
  readonly semanticHash: string;
  readonly assetFingerprint: string;
  readonly stateJson: string;
  readonly assets: readonly Uint8Array[];
}

/** Budgets the worker opens a checkpoint under (`contracts/project-host.json`);
 * the document size and asset count come from the checkpoint itself. */
export interface SessionOpenLimits {
  readonly documentNodes: number;
  readonly documentTextUnits: number;
  readonly numberBytes: number;
  readonly depth: number;
  readonly assetBytes: number;
  readonly totalAssetBytes: number;
  readonly historyEntries: number;
  readonly historyBytes: number;
}

export type SessionWorkerRequest =
  | {
      readonly kind: 'open';
      readonly incarnation: number;
      readonly id: number;
      readonly generation: ProjectGenerationWire;
      readonly limits: SessionOpenLimits;
      readonly checkpoint: SessionCheckpoint;
    }
  | { readonly kind: 'exchange'; readonly incarnation: number; readonly id: number; readonly text: string }
  | { readonly kind: 'checkpoint'; readonly incarnation: number; readonly id: number };

export type SessionWorkerReply =
  | { readonly kind: 'opened'; readonly incarnation: number; readonly id: number }
  | { readonly kind: 'exchange'; readonly incarnation: number; readonly id: number; readonly text: string }
  | {
      readonly kind: 'checkpoint';
      readonly incarnation: number;
      readonly id: number;
      readonly checkpoint: SessionCheckpoint;
    }
  | { readonly kind: 'failed'; readonly incarnation: number; readonly message: string };

/** The browser's end of one worker. `listen` is called once; the worker's
 * error, exit or undeliverable message is a failure. */
export interface SessionWorkerPort {
  postMessage(message: SessionWorkerRequest, transfer: Transferable[]): void;
  listen(listener: {
    readonly message: (reply: SessionWorkerReply) => void;
    readonly failure: (reason: string) => void;
  }): void;
  terminate(): void;
}

export class SessionWorkerFailure extends Error {
  constructor(readonly reason: string) {
    super(`The project session worker failed: ${reason}`);
    this.name = 'SessionWorkerFailure';
  }
}

/** Requests to one worker incarnation, matched to its replies by ID. A reply
 * tagged with another incarnation belongs to a superseded worker and is
 * dropped; anything else unexpected fails the channel closed. */
export class SessionWorkerChannel {
  private next = 0;
  private readonly pending = new Map<
    number,
    {
      readonly kind: SessionWorkerRequest['kind'];
      resolve(reply: SessionWorkerReply): void;
      reject(error: unknown): void;
    }
  >();
  private failure: SessionWorkerFailure | undefined;

  constructor(
    private readonly port: SessionWorkerPort,
    readonly incarnation: number,
    /** Called once, synchronously, before anything in flight is rejected. */
    private readonly onFailure: () => void = () => undefined,
  ) {
    port.listen({ message: (reply) => this.receive(reply), failure: (reason) => this.fail(reason) });
  }

  get failed(): SessionWorkerFailure | undefined {
    return this.failure;
  }

  open(generation: ProjectGenerationWire, limits: SessionOpenLimits, checkpoint: SessionCheckpoint): Promise<void> {
    // Copies, so the caller's retained checkpoint survives the transfer.
    const assets = checkpoint.assets.map((bytes) => bytes.slice());
    return this.call(
      (id) => ({
        kind: 'open',
        incarnation: this.incarnation,
        id,
        generation,
        limits,
        checkpoint: { ...checkpoint, assets },
      }),
      assets.map((bytes) => bytes.buffer),
    ).then(() => undefined);
  }

  /** The session's string exchange, in order. */
  exchange(text: string): Promise<string> {
    return this.call((id) => ({ kind: 'exchange', incarnation: this.incarnation, id, text }), []).then((reply) =>
      reply.kind === 'exchange' ? reply.text : this.mismatch(),
    );
  }

  /** The worker's current state, after every exchange sent before it. */
  checkpoint(): Promise<SessionCheckpoint> {
    return this.call((id) => ({ kind: 'checkpoint', incarnation: this.incarnation, id }), []).then((reply) =>
      reply.kind === 'checkpoint' ? reply.checkpoint : this.mismatch(),
    );
  }

  /** Stop the worker; everything in flight is rejected. */
  fail(reason: string): void {
    if (this.failure) return;
    this.failure = new SessionWorkerFailure(reason);
    this.onFailure();
    for (const entry of this.pending.values()) entry.reject(this.failure);
    this.pending.clear();
    this.port.terminate();
  }

  private call(request: (id: number) => SessionWorkerRequest, transfer: Transferable[]): Promise<SessionWorkerReply> {
    if (this.failure) return Promise.reject(this.failure);
    const message = request(++this.next);
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { kind: message.kind, resolve, reject });
      try {
        this.port.postMessage(message, transfer);
      } catch (cause) {
        this.fail(cause instanceof Error ? cause.message : 'the request could not be delivered');
      }
    });
  }

  private receive(reply: SessionWorkerReply): void {
    if (reply.incarnation !== this.incarnation || this.failure) return;
    if (reply.kind === 'failed') return this.fail(reply.message);
    const entry = this.pending.get(reply.id);
    const expected = entry && (entry.kind === 'open' ? 'opened' : entry.kind);
    if (!entry || reply.kind !== expected) return this.fail('an unexpected reply');
    this.pending.delete(reply.id);
    entry.resolve(reply);
  }

  private mismatch(): never {
    this.fail('an unexpected reply');
    throw this.failure!;
  }
}

export interface ProjectSessionSupervisorOptions {
  /** A new worker for each incarnation. */
  readonly spawn: () => SessionWorkerPort;
  /** A fresh, never reused session generation for each incarnation. */
  readonly generation: () => ProjectGenerationWire;
  readonly schemaVersion: number;
  readonly limits: SessionOpenLimits;
}

export interface SessionRecovery {
  /** The acknowledged checkpoint the new incarnation opened from. */
  readonly checkpoint: Pick<SessionCheckpoint, 'revision' | 'semanticHash' | 'assetFingerprint'>;
  /** Operations still awaiting a reply when the worker was stopped. Each was
   * already rejected as of unknown outcome; this is for reconciliation. */
  readonly unknownOutcomes: number;
  readonly generation: ProjectGenerationWire;
}

export class ProjectSessionSupervisorError extends Error {
  constructor(readonly code: 'not-started' | 'disposed' | 'not-failed' | 'unacknowledged' | 'recovery-mismatch') {
    super(
      {
        'not-started': 'The project session has not started.',
        disposed: 'The project session is closed.',
        'not-failed': 'The project session worker has not failed.',
        unacknowledged: 'The worker state does not match an acknowledged project state.',
        'recovery-mismatch': 'The recovered project does not match its acknowledged checkpoint.',
      }[code],
    );
    this.name = 'ProjectSessionSupervisorError';
  }
}

interface Incarnation {
  readonly channel: SessionWorkerChannel;
  readonly client: ProjectSessionClient;
  readonly generation: ProjectGenerationWire;
  /** Caller operations submitted and not yet settled. */
  inFlight: number;
}

/** The browser's owner of a worker-hosted session: submissions, acknowledged
 * checkpoints, explicit disposal and recovery after the worker fails. */
export class ProjectSessionSupervisor {
  private incarnations = 0;
  private current: Incarnation | undefined;
  private acknowledged: SessionCheckpoint | undefined;
  private unknownOutcomes = 0;
  private disposed = false;

  constructor(private readonly options: ProjectSessionSupervisorOptions) {}

  /** Open the first incarnation from a state the host already owns as
   * acknowledged — an opened document or a recovery record. */
  async start(checkpoint: SessionCheckpoint): Promise<void> {
    if (this.disposed) throw new ProjectSessionSupervisorError('disposed');
    this.current?.channel.fail('replaced');
    this.acknowledged = cloneCheckpoint(checkpoint);
    await this.incarnate();
  }

  get generation(): ProjectGenerationWire | undefined {
    return this.current?.generation;
  }

  /** Whether the current worker failed, or its session failed closed (an
   * unverifiable reply); submissions then fail until recovery. */
  get failed(): boolean {
    const current = this.current;
    return current !== undefined && (current.channel.failed !== undefined || current.client.failedClosed);
  }

  /** The last acknowledged checkpoint's identity. */
  get checkpointIdentity(): SessionRecovery['checkpoint'] | undefined {
    const value = this.acknowledged;
    return (
      value && { revision: value.revision, semanticHash: value.semanticHash, assetFingerprint: value.assetFingerprint }
    );
  }

  /** A copy of the last acknowledged checkpoint, for the host's own
   * recovery record. */
  acknowledgedCheckpoint(): SessionCheckpoint | undefined {
    return this.acknowledged && cloneCheckpoint(this.acknowledged);
  }

  submit(operation: ProjectSessionOperation): ProjectSessionTicket {
    const current = this.active();
    if (!current) return refused(new ProjectSessionSupervisorError(this.disposed ? 'disposed' : 'not-started'));
    const ticket = current.client.submit(operation);
    current.inFlight++;
    const settle = () => {
      current.inFlight--;
    };
    void ticket.result.then(settle, settle);
    return ticket;
  }

  /**
   * Take a checkpoint the browser may recover from: the worker's state, captured
   * after a query is acknowledged and adopted only when its identity equals that
   * acknowledgement. An edit landing in between, or anything else, keeps the
   * previous checkpoint.
   */
  async checkpoint(): Promise<SessionRecovery['checkpoint']> {
    const current = this.active();
    if (!current) throw new ProjectSessionSupervisorError(this.disposed ? 'disposed' : 'not-started');
    const receipt = await current.client.submit({ query: {} }).result;
    const checkpoint = await current.channel.checkpoint();
    if (
      current !== this.current ||
      current.channel.failed ||
      !('acknowledged' in receipt) ||
      !sameIdentity(receipt.acknowledged.guard, checkpoint, true)
    )
      throw new ProjectSessionSupervisorError('unacknowledged');
    this.acknowledged = checkpoint;
    return this.checkpointIdentity!;
  }

  /**
   * After a failure, open a new incarnation with a new generation from the last
   * acknowledged checkpoint. Edits acknowledged after it are not replayed from
   * any UI view; the caller reconciles from the recovered state.
   */
  async recover(): Promise<SessionRecovery> {
    if (this.disposed) throw new ProjectSessionSupervisorError('disposed');
    const previous = this.current;
    if (!previous || !this.acknowledged) throw new ProjectSessionSupervisorError('not-started');
    if (!this.failed) throw new ProjectSessionSupervisorError('not-failed');
    // A session that failed closed is stopped before it is replaced.
    previous.channel.fail('the session failed closed');
    const unknownOutcomes = this.unknownOutcomes;
    const generation = await this.incarnate();
    // The new incarnation must hold exactly the acknowledged state (its
    // revision counter starts again; the content identity may not).
    const current = this.current!;
    const receipt = await current.client.submit({ query: {} }).result;
    if (!('acknowledged' in receipt) || !sameIdentity(receipt.acknowledged.guard, this.acknowledged, false)) {
      current.channel.fail('recovery mismatch');
      throw new ProjectSessionSupervisorError('recovery-mismatch');
    }
    this.acknowledged = { ...this.acknowledged, revision: receipt.acknowledged.guard.revision };
    return { checkpoint: this.checkpointIdentity!, unknownOutcomes, generation };
  }

  /** Close the session and stop its worker now, even a hung one. Work still
   * in flight is rejected as of unknown outcome; nothing is submitted after. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    // The close request is a courtesy to a live worker; it is not awaited.
    void current.client.close().catch(() => undefined);
    current.channel.fail('disposed');
  }

  private active(): Incarnation | undefined {
    return this.disposed ? undefined : this.current;
  }

  private async incarnate(): Promise<ProjectGenerationWire> {
    const generation = this.options.generation();
    const number = ++this.incarnations;
    const channel = new SessionWorkerChannel(this.options.spawn(), number, () => {
      // Counted synchronously, before the client learns of the failure.
      const current = this.current;
      if (current?.channel.incarnation === number) this.unknownOutcomes = current.inFlight;
    });
    // Opening is posted first; the client's handshake follows it in order.
    const opened = channel.open(generation, this.options.limits, this.acknowledged!);
    const client = new ProjectSessionClient((text) => channel.exchange(text), generation, this.options.schemaVersion);
    this.current = { channel, client, generation, inFlight: 0 };
    this.unknownOutcomes = 0;
    try {
      await opened;
    } catch (error) {
      channel.fail('the session could not open');
      throw error;
    }
    return generation;
  }
}

function sameIdentity(
  guard: {
    readonly revision: number;
    readonly semanticHash: readonly number[];
    readonly assetFingerprint: readonly number[];
  },
  checkpoint: SessionCheckpoint,
  revision: boolean,
): boolean {
  return (
    (!revision || guard.revision === checkpoint.revision) &&
    sessionText(guard.semanticHash) === checkpoint.semanticHash &&
    sessionText(guard.assetFingerprint) === checkpoint.assetFingerprint
  );
}

function refused(error: unknown): ProjectSessionTicket {
  return { result: Promise.reject(error), cancel: () => Promise.resolve('notPending') };
}

function cloneCheckpoint(value: SessionCheckpoint): SessionCheckpoint {
  return { ...value, assets: value.assets.map((bytes) => bytes.slice()) };
}
