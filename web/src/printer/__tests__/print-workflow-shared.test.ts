/**
 * The browser send-workflow tests, run against the shared core's workflow
 * (`SharedPrintWorkflow` over the packaged printer WASM) with the same fake
 * printer: the browser's behaviour is the specification both meet.
 */
import assert from 'node:assert/strict';
import { SharedPrintWorkflow } from '../SharedPrintWorkflow';
import { loadSharedPrinterCore } from './sharedPrinterCore';
import { usePrintWorkflow } from './print-workflow.factory';

const core = loadSharedPrinterCore();
let created = 0;
usePrintWorkflow((dependencies) => {
  created += 1;
  return new SharedPrintWorkflow(core, dependencies);
});
await import('./print-workflow-controller.test');
assert.ok(created >= 10, `every workflow ran on the shared core (${created})`);
console.log(`The shared core workflow meets the browser workflow tests (${created} workflows).`);
