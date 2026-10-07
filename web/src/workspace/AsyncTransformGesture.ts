import {
  AsyncSessionError,
  type AsyncSessionAcknowledgement,
  type AsyncSessionGuard,
} from '../project/AsyncEditorSession';
import type { InstanceTransformChange } from '../project/objects/transformCommands';

export interface TransformGestureHost {
  readonly guard: AsyncSessionGuard;
  /** Invalidates immediately even if selection changes away and back in one task. */
  readonly invalidation: AbortSignal;
  /** Capture immutable full poses and verify the gesture's exact target set. */
  capture(changes: readonly InstanceTransformChange[]): readonly InstanceTransformChange[];
  selectionCurrent(): boolean;
  guardCurrent(guard: AsyncSessionGuard): boolean;
  execute(
    changes: readonly InstanceTransformChange[],
    guard: AsyncSessionGuard,
    signal: AbortSignal,
  ): Promise<AsyncSessionAcknowledgement<void>>;
}

/** One gesture owns at most one dispatched edit and one latest pending pose.
 * Only its actual receipt advances the guard. Failure/close never retries an
 * uncertain edit, and cancellation does not roll back already committed steps. */
export class AsyncTransformGesture {
  private guard: AsyncSessionGuard;
  private latest?: readonly InstanceTransformChange[];
  private running?: Promise<void>;
  private accepting = true;
  private failure?: unknown;
  private failed = false;
  private readonly cancellation = new AbortController();
  private readonly invalidate = () => this.stop(this.host.invalidation.reason);

  constructor(private readonly host: TransformGestureHost) {
    this.guard = host.guard;
    host.invalidation.addEventListener('abort', this.invalidate, { once: true });
    if (host.invalidation.aborted) this.invalidate();
  }

  update(changes: readonly InstanceTransformChange[]): void {
    if (!this.accepting) throw this.failure ?? new AsyncSessionError('cancelled');
    if (!this.host.selectionCurrent()) {
      this.stop(new AsyncSessionError('stale'));
      throw this.failure;
    }
    try {
      this.latest = this.host.capture(changes);
    } catch (error) {
      this.stop(error);
      throw error;
    }
    if (!this.running) this.running = this.drain();
  }

  async finish(): Promise<void> {
    this.accepting = false;
    try {
      await this.running;
      if (this.failed) throw this.failure;
    } finally {
      this.host.invalidation.removeEventListener('abort', this.invalidate);
    }
  }

  selectionCurrent(): boolean {
    return this.host.selectionCurrent();
  }

  cancel(): void {
    this.stop(new AsyncSessionError('cancelled'));
  }

  private stop(error: unknown): void {
    this.accepting = false;
    this.latest = undefined;
    if (!this.failed) this.failure = error;
    this.failed = true;
    this.cancellation.abort();
    this.host.invalidation.removeEventListener('abort', this.invalidate);
  }

  private async drain(): Promise<void> {
    // Yield once so running is installed before a synchronous refusal or a
    // reentrant host callback can settle this pump.
    await Promise.resolve();
    try {
      while (this.latest && !this.cancellation.signal.aborted) {
        if (!this.host.selectionCurrent() || !this.host.guardCurrent(this.guard)) throw new AsyncSessionError('stale');
        const next = this.latest;
        this.latest = undefined;
        const receipt = await this.host.execute(next, this.guard, this.cancellation.signal);
        this.guard = receipt.guard;
      }
    } catch (error) {
      this.stop(error);
    } finally {
      this.running = undefined;
    }
  }
}
