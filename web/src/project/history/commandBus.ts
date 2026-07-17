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

export interface CommandBusPort {
  execute(command: ProjectCommand, options?: { coalesce?: boolean }): void;
  undo(): boolean;
  redo(): boolean;
  transaction<T>(label: string, operation: () => T): T;
  markCheckpoint(): void;
  getHistorySnapshot(): CommandHistorySnapshot;
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

  constructor(
    readonly context: CommandContext,
    options: CommandBusOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.maxEstimatedBytes = Math.max(1, options.maxEstimatedBytes ?? 32 * 1024 * 1024);
  }

  execute(command: ProjectCommand, options: { coalesce?: boolean } = {}): void {
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
        return;
      }

      this.pushEntry(entry);
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
    return true;
  }

  redo(): boolean {
    if (this.activeTransaction) throw new Error('Cannot redo during a transaction');
    const entry = this.redoEntries.at(-1);
    if (!entry) return false;
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
    return true;
  }

  transaction<T>(label: string, operation: () => T): T {
    if (this.activeTransaction) return operation();
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
      this.commitTransaction(transaction);
      return result;
    } catch (error) {
      this.rollbackTransaction(transaction);
      throw error;
    } finally {
      this.activeTransaction = undefined;
    }
  }

  async transactionAsync<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeTransaction) return operation();
    const transaction: ActiveTransaction = {
      label,
      atomic: this.captureAtomic(),
      beforeSelection: this.context.selection.getSnapshot(),
      beforeDirty: cloneTokens(this.dirtyTokens),
      commands: [],
    };
    this.activeTransaction = transaction;
    try {
      const result = await operation();
      this.commitTransaction(transaction);
      return result;
    } catch (error) {
      this.rollbackTransaction(transaction);
      throw error;
    } finally {
      this.activeTransaction = undefined;
    }
  }

  markCheckpoint(): void {
    this.checkpointTokens = cloneTokens(this.dirtyTokens);
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
    this.undoEntries = [];
    this.redoEntries = [];
    if (options.markCheckpoint ?? true) this.markCheckpoint();
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
