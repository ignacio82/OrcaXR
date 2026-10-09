/**
 * The application's printer session, which can change implementation once.
 *
 * The session exists from startup, but the shared core loads on demand. Until
 * it has, the browser controller serves; when it has, the switch adopts the
 * shared core's session as soon as no printer is selected (connecting waits for
 * the core before selecting, so that is usually at once). A session in use
 * keeps the implementation it started with until it is cleared.
 */
import type { MoonrakerHandshake } from './MoonrakerTypes';
import type { PrintJobCommand, PrintJobCommandDescriptor } from './PrintJobControl';
import type { PrintJobSnapshot } from './PrintJobStatus';
import type {
  PrintJobCommandIntent,
  PrintJobConfirmation,
  PrinterSelection,
  PrinterSession,
  PrinterSessionLease,
  PrinterSessionTransport,
} from './PrinterSessionController';

export class PrinterSessionSwitch<T extends PrinterSessionTransport> implements PrinterSession<T> {
  private active: PrinterSession<T>;
  private pending: PrinterSession<T> | null = null;
  private stop: () => void;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(initial: PrinterSession<T>) {
    this.active = initial;
    this.stop = initial.subscribe(() => this.emit());
  }

  /** The implementation in use. */
  get implementation(): PrinterSession<T> {
    return this.active;
  }

  /** Moves to `next` now if nothing is selected, or once nothing is; true once moved. */
  adopt(next: PrinterSession<T>): boolean {
    if (this.disposed) {
      next.dispose();
      return false;
    }
    this.pending?.dispose();
    this.pending = next;
    return this.settle();
  }

  private settle(): boolean {
    if (!this.pending || this.active.transport) return false;
    this.stop();
    this.active.dispose();
    this.active = this.pending;
    this.pending = null;
    this.stop = this.active.subscribe(() => this.emit());
    this.emit();
    return true;
  }

  get transport(): T | null {
    return this.active.transport;
  }
  get snapshot(): PrintJobSnapshot | null {
    return this.active.snapshot;
  }
  get state() {
    return this.active.state;
  }
  get generation(): number {
    return this.active.generation;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  select(selection: PrinterSelection): T {
    this.settle();
    return this.active.select(selection);
  }
  connect(signal?: AbortSignal): Promise<{ transport: T; handshake: MoonrakerHandshake }> {
    return this.active.connect(signal);
  }
  captureLease(): PrinterSessionLease<T> {
    return this.active.captureLease();
  }
  clear(): void {
    this.active.clear();
    this.settle();
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.pending?.dispose();
    this.pending = null;
    this.active.dispose();
    this.listeners.clear();
  }
  availability(): readonly PrintJobCommandDescriptor[] {
    return this.active.availability();
  }
  captureIntent(command: PrintJobCommand): PrintJobCommandIntent {
    return this.active.captureIntent(command);
  }
  confirm(intent: PrintJobCommandIntent): PrintJobConfirmation {
    return this.active.confirm(intent);
  }
  execute(
    intent: PrintJobCommandIntent,
    confirmation?: PrintJobConfirmation | ((intent: PrintJobCommandIntent, signal: AbortSignal) => Promise<boolean>),
  ): Promise<void> {
    return this.active.execute(intent, confirmation);
  }
  refresh(): Promise<void> {
    return this.active.refresh();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
