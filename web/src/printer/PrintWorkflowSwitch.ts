/**
 * The application's send workflow, which can change implementation once.
 *
 * The workflow exists from startup, but the shared core loads on demand. Until
 * it has, the browser controller serves; when it has, the switch adopts the
 * shared core's workflow as soon as no send is running. A send already
 * running finishes on the implementation it started with.
 */
import type { PrintJobIntent, PrintSubmissionResult } from './PrintJobSubmission';
import type { PrintWorkflow, PrintWorkflowProgress } from './PrintWorkflowController';

export class PrintWorkflowSwitch implements PrintWorkflow {
  private active: PrintWorkflow;
  private pending: PrintWorkflow | null = null;
  private disposed = false;

  constructor(initial: PrintWorkflow) {
    this.active = initial;
  }

  /** The implementation in use. */
  get implementation(): PrintWorkflow {
    return this.active;
  }

  /** Moves to `next` now if no send is running, or before the next send; true once moved. */
  adopt(next: PrintWorkflow): boolean {
    if (this.disposed) {
      next.dispose();
      return false;
    }
    this.pending?.dispose();
    this.pending = next;
    return this.settle();
  }

  private settle(): boolean {
    if (!this.pending || this.active.busy) return false;
    this.active.dispose();
    this.active = this.pending;
    this.pending = null;
    return true;
  }

  get busy(): boolean {
    return this.active.busy;
  }
  get phase(): PrintWorkflow['phase'] {
    return this.active.phase;
  }
  cancel(): void {
    this.active.cancel();
  }
  dispose(): void {
    this.disposed = true;
    this.pending?.dispose();
    this.pending = null;
    this.active.dispose();
  }
  run(input: PrintJobIntent, progress?: PrintWorkflowProgress): Promise<PrintSubmissionResult | null> {
    this.settle();
    return this.active.run(input, progress);
  }
  startStored(path: string): Promise<string | null> {
    this.settle();
    return this.active.startStored(path);
  }
}
