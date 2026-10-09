/**
 * The application's printer session, which can change implementation once.
 *
 * The session exists from startup, but the shared core loads on demand. Until
 * it has, the browser controller serves; when it has, and while no printer is
 * selected (connecting waits for the core before selecting), the switch adopts
 * the shared core's session. A session already in use keeps the
 * implementation it started with.
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

  /** Moves to `next` while nothing is selected; otherwise `next` is discarded. */
  adopt(next: PrinterSession<T>): boolean {
    if (this.disposed || this.active.transport) {
      next.dispose();
      return false;
    }
    this.stop();
    this.active.dispose();
    this.active = next;
    this.stop = next.subscribe(() => this.emit());
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
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
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
