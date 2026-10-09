/**
 * The browser session tests, run against the shared core's session
 * (`SharedPrinterSession` over the packaged printer WASM) with the same fake
 * transports: the browser's behaviour is the specification both meet.
 */
import assert from 'node:assert/strict';
import { SharedPrinterSession } from '../SharedPrinterSession';
import { loadSharedPrinterCore } from './sharedPrinterCore';
import { usePrinterSession } from './printer-session.factory';

const core = loadSharedPrinterCore();
let created = 0;
usePrinterSession((createTransport) => {
  created += 1;
  return new SharedPrinterSession(core, createTransport);
});
await import('./printer-session-controller.test');
assert.ok(created >= 2, `every session ran on the shared core (${created})`);
console.log(`The shared core session meets the browser session tests (${created} sessions).`);
