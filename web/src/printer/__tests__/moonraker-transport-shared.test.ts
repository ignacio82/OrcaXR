/**
 * The browser transport tests and the Moonraker simulators (a real HTTP
 * server: uploads, storage, prints), run against the shared core's transport
 * (`SharedMoonrakerTransport` over the packaged project WASM): the browser's
 * behaviour is the specification both implementations meet.
 */
import assert from 'node:assert/strict';
import { loadSharedPrinterCore } from './sharedPrinterCore';
import { SharedMoonrakerTransport } from '../SharedMoonrakerTransport';
import type { MoonrakerTransport } from '..';
import { useMoonrakerTransport } from './moonraker-transport.factory';

const core = loadSharedPrinterCore();
let created = 0;
useMoonrakerTransport((config, dependencies) => {
  created += 1;
  return new SharedMoonrakerTransport(core, config, dependencies) as unknown as MoonrakerTransport;
});
await import('./moonraker-transport.test');
await import('./moonraker-storage-simulator.test');
await import('./moonraker-print-simulator.test');
assert.ok(created >= 16, `every harness ran on the shared core (${created})`);
console.log(`The shared core transport meets the browser transport tests (${created} transports).`);
