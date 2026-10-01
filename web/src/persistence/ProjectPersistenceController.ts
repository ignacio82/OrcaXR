import type { CancellationToken, ProjectExportGuard, SerializedProjectSnapshot } from '../project/ports';

export type PersistencePurpose = 'manual' | 'recovery';
export type NavigationReason = 'new' | 'open' | 'reload' | 'update' | 'navigate' | 'recover';
export interface PersistenceProjectState {
  readonly guard: ProjectExportGuard;
  readonly name: string;
  readonly dirty: boolean;
}
export interface PersistenceProjectPort {
  read(): PersistenceProjectState;
  subscribe(listener: () => void): () => void;
  serialize(purpose: PersistencePurpose, cancellation: CancellationToken): Promise<SerializedProjectSnapshot>;
  acknowledge(guard: ProjectExportGuard): void;
}
export interface RecoverySessionSummary {
  readonly id: string;
  readonly projectName: string;
  readonly savedAt: string;
  readonly byteLength: number;
  readonly available: boolean;
  readonly reason?: string;
}
export interface ProjectRecoveryPort {
  list(): Promise<readonly RecoverySessionSummary[]>;
  /** Restore only through the validated import pipeline and its dirty-project decision. */
  restore(id: string): Promise<boolean>;
  download(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}
export interface PersistenceEffectsPort {
  readonly recovery?: ProjectRecoveryPort;
  /** A browser download acknowledges handoff, not completion of a disk write. */
  download(snapshot: SerializedProjectSnapshot): Promise<void>;
  /** Check cancellation immediately before opening the atomic storage transaction. */
  storeRecovery(
    snapshot: SerializedProjectSnapshot,
    projectName: string,
    sessionId: string,
    cancellation: CancellationToken,
  ): Promise<void>;
  discardRecovery(projectId: string, sessionId: string): Promise<void>;
  confirmNavigation(reason: NavigationReason, projectName: string): Promise<'save' | 'discard' | 'cancel'>;
}
export interface PersistenceClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface PersistenceStatus {
  readonly phase: 'idle' | 'saving' | 'capturing' | 'error' | 'disposed';
  readonly message: string;
}
interface Task {
  readonly purpose: PersistencePurpose;
  readonly promise: Promise<boolean>;
  resolve(value: boolean): void;
  reject(error: Error): void;
  readonly cancellation: { aborted: boolean; reason?: string };
}
const browserClock: PersistenceClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** One persistence queue and one dirty-navigation decision for every presentation surface. */
export class ProjectPersistenceController {
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(status: PersistenceStatus) => void>();
  private statusValue: PersistenceStatus = { phase: 'idle', message: '' };
  private readonly manual: Task[] = [];
  private recovery?: Task;
  private active?: Task;
  private timer?: unknown;
  private firstEditAt?: number;
  private observed = '';
  private captured = '';
  private generation = 0;
  private projectId: string;
  private disposed = false;
  private navigation?: Promise<boolean>;
  private cancelNavigation?: () => void;
  private readonly recoveryOperations = new Set<(error: Error) => void>();
  private recoveryBusy = false;
  private navigationGuard?: ProjectExportGuard;

  get approvedNavigationGuard(): ProjectExportGuard | undefined {
    return this.navigationGuard;
  }

  constructor(
    private readonly project: PersistenceProjectPort,
    private readonly effects: PersistenceEffectsPort,
    readonly sessionId: string,
    private readonly clock: PersistenceClock = browserClock,
  ) {
    this.projectId = project.read().guard.projectId;
    this.unsubscribe = project.subscribe(() => this.changed());
    this.changed();
  }

  get status(): PersistenceStatus {
    return this.statusValue;
  }
  subscribe(listener: (status: PersistenceStatus) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.statusValue);
    return () => this.listeners.delete(listener);
  }
  save(): Promise<boolean> {
    return this.enqueue('manual');
  }
  captureNow(): Promise<boolean> {
    return this.enqueue('recovery');
  }

  listRecoverySessions(): Promise<readonly RecoverySessionSummary[]> {
    return this.recoveryOperation((port) => port.list(), false);
  }
  recoverSession(id: string): Promise<boolean> {
    return this.recoveryOperation((port) => port.restore(id));
  }
  downloadRecovery(id: string): Promise<void> {
    return this.recoveryOperation((port) => port.download(id));
  }
  discardRecovery(id: string): Promise<void> {
    return this.recoveryOperation((port) => port.discard(id));
  }

  guardNavigation(reason: NavigationReason): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('Project persistence is disposed'));
    if (this.navigation) return this.navigation;
    this.navigationGuard = undefined;
    const cancelled = new Promise<boolean>((resolve) => {
      this.cancelNavigation = () => resolve(false);
    });
    this.navigation = Promise.race([this.decideNavigation(reason), cancelled]).finally(() => {
      this.navigation = undefined;
      this.cancelNavigation = undefined;
    });
    return this.navigation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.cancelNavigation?.();
    this.clearTimer();
    const error = new Error('Project persistence is disposed');
    for (const reject of [...this.recoveryOperations]) reject(error);
    for (const task of [
      ...this.manual,
      ...(this.recovery ? [this.recovery] : []),
      ...(this.active ? [this.active] : []),
    ]) {
      task.cancellation.aborted = true;
      task.cancellation.reason = error.message;
      task.reject(error);
    }
    this.manual.length = 0;
    this.recovery = undefined;
    this.publish('disposed', '');
    this.listeners.clear();
  }

  private changed(): void {
    if (this.disposed) return;
    const state = this.project.read();
    if (this.navigationGuard && versionIdentity(state.guard) !== versionIdentity(this.navigationGuard))
      this.navigationGuard = undefined;
    if (state.guard.projectId !== this.projectId) {
      this.invalidateRecovery();
      this.projectId = state.guard.projectId;
      this.captured = '';
    }
    if (!state.dirty) {
      this.clearTimer();
      this.firstEditAt = undefined;
      return;
    }
    const identity = versionIdentity(state.guard);
    if (identity === this.observed) return;
    this.observed = identity;
    this.firstEditAt ??= this.clock.now();
    this.clearTimer();
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = undefined;
        this.firstEditAt = undefined;
        void this.captureNow().catch(() => {
          /* Failure is already in the shared status. */
        });
      },
      Math.max(0, Math.min(5_000, this.firstEditAt + 30_000 - this.clock.now())),
    );
  }

  private recoveryOperation<T>(operation: (port: ProjectRecoveryPort) => Promise<T>, exclusive = true): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Project persistence is disposed'));
    const port = this.effects.recovery;
    if (!port) return Promise.reject(new Error('Project recovery is unavailable'));
    if (exclusive && this.recoveryBusy) return Promise.reject(new Error('Another recovery operation is still running'));
    if (exclusive) this.recoveryBusy = true;
    let rejectDisposed!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectDisposed = reject;
    });
    this.recoveryOperations.add(rejectDisposed);
    return Promise.race([
      Promise.resolve().then(() => {
        if (this.disposed) throw new Error('Project persistence is disposed');
        return operation(port);
      }),
      cancelled,
    ]).finally(() => {
      this.recoveryOperations.delete(rejectDisposed);
      if (exclusive) this.recoveryBusy = false;
    });
  }

  private enqueue(purpose: PersistencePurpose): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('Project persistence is disposed'));
    if (purpose === 'recovery' && this.recovery) return this.recovery.promise;
    let resolve!: Task['resolve'];
    let reject!: Task['reject'];
    const promise = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const task: Task = {
      purpose,
      promise,
      resolve,
      reject,
      cancellation: { aborted: false },
    };
    if (purpose === 'manual') this.manual.push(task);
    else this.recovery = task;
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.disposed || this.active) return;
    const task = this.manual.shift() ?? this.recovery;
    if (!task) return;
    if (task === this.recovery) this.recovery = undefined;
    this.active = task;
    void this.run(task)
      .then(task.resolve, (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!this.disposed && !task.cancellation.aborted) this.publish('error', failure.message);
        task.reject(failure);
      })
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
  }

  private async run(task: Task): Promise<boolean> {
    const state = this.project.read();
    const generation = this.generation;
    if (task.purpose === 'recovery' && (!state.dirty || contentIdentity(state.guard) === this.captured)) return false;
    this.publish(task.purpose === 'manual' ? 'saving' : 'capturing', '');
    const snapshot = await this.project.serialize(task.purpose, task.cancellation);
    this.assertTask(task, generation);
    if (snapshot.guard.projectId !== state.guard.projectId)
      throw new Error('The project changed before serialization started');
    if (task.purpose === 'manual') {
      if (versionIdentity(this.project.read().guard) !== versionIdentity(snapshot.guard))
        throw new Error('The project changed during export. Save again to include the latest edits.');
      await this.effects.download(snapshot);
      this.assertTask(task, generation);
      this.project.acknowledge(snapshot.guard);
    } else {
      await this.effects.storeRecovery(snapshot, state.name, this.sessionId, task.cancellation);
      this.assertTask(task, generation);
      this.captured = contentIdentity(snapshot.guard);
    }
    this.publish('idle', '');
    return true;
  }

  private async decideNavigation(reason: NavigationReason): Promise<boolean> {
    const state = this.project.read();
    if (!state.dirty) {
      this.navigationGuard = state.guard;
      return true;
    }
    const choice = await this.effects.confirmNavigation(reason, state.name);
    if (this.disposed || choice === 'cancel') return false;
    if (versionIdentity(this.project.read().guard) !== versionIdentity(state.guard)) {
      this.publish('error', 'The project changed while the decision was open. Review the latest work before leaving.');
      return false;
    }
    if (choice === 'save') {
      const saved = await this.save();
      const current = this.project.read();
      if (!saved || current.dirty) return false;
      this.navigationGuard = current.guard;
      return true;
    }
    this.invalidateRecovery();
    await this.effects.discardRecovery(state.guard.projectId, this.sessionId);
    const allowed = !this.disposed && versionIdentity(this.project.read().guard) === versionIdentity(state.guard);
    if (allowed) this.navigationGuard = state.guard;
    return allowed;
  }

  private invalidateRecovery(): void {
    this.generation++;
    this.clearTimer();
    this.firstEditAt = undefined;
    if (this.recovery) {
      this.recovery.resolve(false);
      this.recovery = undefined;
    }
    if (this.active?.purpose === 'recovery') {
      this.active.cancellation.aborted = true;
      this.active.cancellation.reason = 'The recovery capture was superseded';
    }
  }
  private assertTask(task: Task, generation: number): void {
    if (this.disposed || task.cancellation.aborted || generation !== this.generation)
      throw new Error(task.cancellation.reason ?? 'The persistence request was superseded');
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private publish(phase: PersistenceStatus['phase'], message: string): void {
    this.statusValue = Object.freeze({ phase, message });
    for (const listener of this.listeners) {
      try {
        listener(this.statusValue);
      } catch {
        /* Observers cannot veto persistence. */
      }
    }
  }
}

function contentIdentity(guard: ProjectExportGuard): string {
  return JSON.stringify([guard.projectId, guard.semanticHash, guard.assetFingerprint]);
}
function versionIdentity(guard: ProjectExportGuard): string {
  return JSON.stringify([guard.projectId, guard.revision, guard.semanticHash, guard.assetFingerprint]);
}
