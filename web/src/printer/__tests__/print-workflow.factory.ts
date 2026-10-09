/**
 * Which send workflow the browser workflow tests drive. They run as written
 * against `PrintWorkflowController`; `print-workflow-shared.test.ts` selects the
 * shared core's before importing them, so one suite holds both
 * implementations to the same behaviour.
 */
import {
  PrintWorkflowController,
  type PrintWorkflow,
  type PrintWorkflowDependencies,
} from '../PrintWorkflowController';

export type PrintWorkflowFactory = (dependencies: PrintWorkflowDependencies) => PrintWorkflow;

let factory: PrintWorkflowFactory = (dependencies) => new PrintWorkflowController(dependencies);

export function usePrintWorkflow(next: PrintWorkflowFactory): void {
  factory = next;
}

export function createPrintWorkflow(dependencies: PrintWorkflowDependencies): PrintWorkflow {
  return factory(dependencies);
}
