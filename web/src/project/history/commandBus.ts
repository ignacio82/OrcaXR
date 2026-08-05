import type { AssetRepositorySnapshot } from '../assets';
import type { DirtyCategory, ProjectState } from '../domain/model';
import type { SelectionSnapshot } from '../selection';
import { CompositeProjectCommand, type CommandContext, type ProjectCommand } from './command';

const DIRTY_CATEGORIES: readonly DirtyCategory[] = ['projectData', 'presets', 'printerDevice'];

type DirtyTokens = Record<DirtyCategory, number>;

interface HistoryEntry {
  command: ProjectCommand;
  beforeSelection: SelectionSnapshot;
  afterSelection: SelectionSnapshot;
  beforeDirty: DirtyTokens;
  afterDirty: DirtyTokens;
  estimatedBytes: number;
}

interface AtomicSnapshot {
  state: ProjectState;
  selection: SelectionSnapshot;
  assets: AssetRepositorySnapshot;
}

export interface CommandBusOptions {
  maxEntries?: number;
  maxEstimatedBytes?: number;
}

export interface CommandHistorySnapshot {
  readonly undoCount: number;
  readonly redoCount: number;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
  readonly dirtyCategories: readonly DirtyCategory[];
}

export type CommandHistorySubscriber = (current: CommandHistorySnapshot, previous: CommandHistorySnapshot) => void;

type SynchronousTransactionResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface CommandBusPort {
  execute(command: ProjectCommand, options?: { coalesce?: boolean }): void;
  undo(): boolean;
  redo(): boolean;
  transaction<T>(label: string, operation: () => SynchronousTransactionResult<T>): SynchronousTransactionResult<T>;
  markCheckpoint(): void;
  getHistorySnapshot(): CommandHistorySnapshot;
  subscribeHistory(subscriber: CommandHistorySubscriber): () => void;
}

interface ActiveTransaction {
  label: string;
  atomic: AtomicSnapshot;
  beforeSelection: SelectionSnapshot;
  beforeDirty: DirtyTokens;
  commands: ProjectCommand[];
}

/** Bounded command history with checkpoints, coalescing, and atomic rollback. */
export class CommandBus implements CommandBusPort {
  private readonly maxEntries: number;
  private readonly maxEstimatedBytes: number;
  private undoEntries: HistoryEntry[] = [];
  private redoEntries: HistoryEntry[] = [];
  private dirtyTokens = emptyDirtyTokens();
  private checkpointTokens = emptyDirtyTokens();
  private tokenClock = 0;
  private activeTransaction?: ActiveTransaction;
  private readonly historySubscribers = new Set<CommandHistorySubscriber>();

  constructor(
    readonly context: CommandContext,
    options: CommandBusOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.maxEstimatedBytes = Math.max(1, options.maxEstimatedBytes ?? 32 * 1024 * 1024);
  }

  execute(command: ProjectCommand, options: { coalesce?: boolean } = {}): void {
    const historyBefore = this.activeTransaction ? undefined : this.getHistorySnapshot();
    const beforeSelection = this.context.selection.getSnapshot();
    const beforeDirty = cloneTokens(this.dirtyTokens);
    const atomic = this.captureAtomic();
    const undoBefore = this.undoEntries.map(cloneHistoryEntry);
    const redoBefore = this.redoEntries.map(cloneHistoryEntry);
    const transactionLength = this.activeTransaction?.commands.length;
    try {
      for (const category of command.dirtyCategories) {
        if (!DIRTY_CATEGORIES.includes(category)) {
          throw new Error(`Unknown dirty category ${category}`);
        }
      }
      if (command.isNoop?.(this.context)) return;
      command.apply(this.context);
      this.advanceDirty(command.dirtyCategories);
      const entry: HistoryEntry = {
        command,
        beforeSelection,
        afterSelection: this.context.selection.getSnapshot(),
        beforeDirty,
        afterDirty: cloneTokens(this.dirtyTokens),
        estimatedBytes: Math.max(1, command.estimateBytes?.() ?? 1),
      };

      if (this.activeTransaction) {
        this.activeTransaction.commands.push(command);
        return;
      }

      const previous = this.undoEntries.at(-1);
      const merged =
        options.coalesce !== false &&
        this.redoEntries.length === 0 &&
        previous?.command.coalesceKey &&
        previous.command.coalesceKey === command.coalesceKey
          ? previous.command.mergeWith?.(command)
          : undefined;
      if (previous && merged) {
        previous.command = merged;
        previous.afterSelection = entry.afterSelection;
        previous.afterDirty = entry.afterDirty;
        previous.estimatedBytes = Math.max(1, merged.estimateBytes?.() ?? 1);
        this.trimHistory();
        this.emitHistory(historyBefore!);
        return;
      }

      this.pushEntry(entry);
      this.emitHistory(historyBefore!);
    } catch (error) {
      this.undoEntries = undoBefore;
      this.redoEntries = redoBefore;
      this.dirtyTokens = beforeDirty;
      if (this.activeTransaction && transactionLength !== undefined) {
        this.activeTransaction.commands.length = transactionLength;
      }
      this.restoreAtomic(atomic, 'command-apply-rollback');
      throw error;
    }
  }

  undo(): boolean {
    if (this.activeTransaction) throw new Error('Cannot undo during a transaction');
    const entry = this.undoEntries.at(-1);
    if (!entry) return false;
    const historyBefore = this.getHistorySnapshot();
    const atomic = this.captureAtomic();
    try {
      entry.command.revert(this.context);
      this.context.selection.restore(entry.beforeSelection);
    } catch (error) {
      this.restoreAtomic(atomic, 'command-revert-rollback');
      throw error;
    }
    this.undoEntries.pop();
    this.redoEntries.push(entry);
    this.dirtyTokens = cloneTokens(entry.beforeDirty);
    this.emitHistory(historyBefore);
    return true;
  }

  redo(): boolean {
    if (this.activeTransaction) throw new Error('Cannot redo during a transaction');
    const entry = this.redoEntries.at(-1);
    if (!entry) return false;
    const historyBefore = this.getHistorySnapshot();
    const atomic = this.captureAtomic();
    try {
      entry.command.apply(this.context);
      this.context.selection.restore(entry.afterSelection);
    } catch (error) {
      this.restoreAtomic(atomic, 'command-redo-rollback');
      throw error;
    }
    this.redoEntries.pop();
    this.undoEntries.push(entry);
    this.dirtyTokens = cloneTokens(entry.afterDirty);
    this.emitHistory(historyBefore);
    return true;
  }

  transaction<T>(label: string, operation: () => SynchronousTransactionResult<T>): SynchronousTransactionResult<T> {
    if (this.activeTransaction) return operation();
    const historyBefore = this.getHistorySnapshot();
    const transaction: ActiveTransaction = {
      label,
      atomic: this.captureAtomic(),
      beforeSelection: this.context.selection.getSnapshot(),
      beforeDirty: cloneTokens(this.dirtyTokens),
      commands: [],
    };
    this.activeTransaction = transaction;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new Error('Command transactions must be synchronous; stage asynchronous work before committing');
      }
      this.commitTransaction(transaction);
      this.activeTransaction = undefined;
      this.emitHistory(historyBefore);
      return result;
    } catch (error) {
      this.rollbackTransaction(transaction);
      throw error;
    } finally {
      this.activeTransaction = undefined;
    }
  }

  markCheckpoint(): void {
    const historyBefore = this.getHistorySnapshot();
    this.checkpointTokens = cloneTokens(this.dirtyTokens);
    if (!this.activeTransaction) this.emitHistory(historyBefore);
  }

  dirtyCategories(): DirtyCategory[] {
    return DIRTY_CATEGORIES.filter((category) => this.dirtyTokens[category] !== this.checkpointTokens[category]);
  }

  isDirty(category?: DirtyCategory): boolean {
    return category
      ? this.dirtyTokens[category] !== this.checkpointTokens[category]
      : this.dirtyCategories().length > 0;
  }

  clearHistory(options: { markCheckpoint?: boolean } = {}): void {
    const historyBefore = this.getHistorySnapshot();
    this.undoEntries = [];
    this.redoEntries = [];
    if (options.markCheckpoint ?? true) this.checkpointTokens = cloneTokens(this.dirtyTokens);
    if (!this.activeTransaction) this.emitHistory(historyBefore);
  }

  getHistorySnapshot(): CommandHistorySnapshot {
    return {
      undoCount: this.undoEntries.length,
      redoCount: this.redoEntries.length,
      undoLabel: this.undoEntries.at(-1)?.command.label,
      redoLabel: this.redoEntries.at(-1)?.command.label,
      dirtyCategories: this.dirtyCategories(),
    };
  }

  subscribeHistory(subscriber: CommandHistorySubscriber): () => void {
    this.historySubscribers.add(subscriber);
    return () => this.historySubscribers.delete(subscriber);
  }

  private commitTransaction(transaction: ActiveTransaction): void {
    if (transaction.commands.length === 0) return;
    const command = new CompositeProjectCommand(transaction.label, transaction.commands);
    this.pushEntry({
      command,
      beforeSelection: transaction.beforeSelection,
      afterSelection: this.context.selection.getSnapshot(),
      beforeDirty: transaction.beforeDirty,
      afterDirty: cloneTokens(this.dirtyTokens),
      estimatedBytes: Math.max(1, command.estimateBytes()),
    });
  }

  private rollbackTransaction(transaction: ActiveTransaction): void {
    this.restoreAtomic(transaction.atomic, 'transaction-rollback');
    this.dirtyTokens = cloneTokens(transaction.beforeDirty);
  }

  private pushEntry(entry: HistoryEntry): void {
    this.undoEntries.push(entry);
    this.redoEntries = [];
    this.trimHistory();
  }

  private trimHistory(): void {
    let bytes = this.undoEntries.reduce((total, entry) => total + entry.estimatedBytes, 0);
    while (
      this.undoEntries.length > this.maxEntries ||
      (bytes > this.maxEstimatedBytes && this.undoEntries.length > 1)
    ) {
      const removed = this.undoEntries.shift();
      if (removed) bytes -= removed.estimatedBytes;
    }
  }

  private advanceDirty(categories: readonly DirtyCategory[]): void {
    for (const category of new Set(categories)) {
      this.tokenClock += 1;
      this.dirtyTokens[category] = this.tokenClock;
    }
  }

  private captureAtomic(): AtomicSnapshot {
    return {
      state: this.context.project.getSnapshot().state,
      selection: this.context.selection.getSnapshot(),
      assets: this.context.assets.capture(),
    };
  }

  private restoreAtomic(snapshot: AtomicSnapshot, reason: string): void {
    this.context.assets.restore(snapshot.assets);
    this.context.project.restoreState(snapshot.state, reason);
    this.context.selection.restore(snapshot.selection);
  }

  private emitHistory(previous: CommandHistorySnapshot): void {
    const current = this.getHistorySnapshot();
    if (historySnapshotsEqual(current, previous)) return;
    for (const subscriber of [...this.historySubscribers]) {
      try {
        subscriber(current, previous);
      } catch {
        // History observers cannot veto an already committed command.
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function emptyDirtyTokens(): DirtyTokens {
  return { projectData: 0, presets: 0, printerDevice: 0 };
}

function cloneTokens(tokens: DirtyTokens): DirtyTokens {
  return { ...tokens };
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    beforeSelection: {
      refs: entry.beforeSelection.refs.map((ref) => ({ ...ref })),
      ...(entry.beforeSelection.primary ? { primary: { ...entry.beforeSelection.primary } } : {}),
    },
    afterSelection: {
      refs: entry.afterSelection.refs.map((ref) => ({ ...ref })),
      ...(entry.afterSelection.primary ? { primary: { ...entry.afterSelection.primary } } : {}),
    },
    beforeDirty: cloneTokens(entry.beforeDirty),
    afterDirty: cloneTokens(entry.afterDirty),
  };
}

function historySnapshotsEqual(left: CommandHistorySnapshot, right: CommandHistorySnapshot): boolean {
  return (
    left.undoCount === right.undoCount &&
    left.redoCount === right.redoCount &&
    left.undoLabel === right.undoLabel &&
    left.redoLabel === right.redoLabel &&
    left.dirtyCategories.length === right.dirtyCategories.length &&
    left.dirtyCategories.every((category, index) => category === right.dirtyCategories[index])
  );
}
