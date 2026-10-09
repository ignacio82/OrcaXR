/** The packaged printer core, instantiated synchronously for Node tests. */
import { readFileSync } from 'node:fs';
import { CORE_PRINTER_ASSET } from '../../../../core/browser/printer/asset';
import { initSync, moonraker_endpoint, MoonrakerTransport } from '../../../../core/browser/printer/orcaxr_core.js';
import type { MoonrakerTransportCore } from '../SharedMoonrakerTransport';

let loaded: MoonrakerTransportCore | undefined;

export function loadSharedPrinterCore(): MoonrakerTransportCore {
  if (!loaded) {
    initSync({ module: readFileSync(new URL(`../../../public/${CORE_PRINTER_ASSET.wasm.path}`, import.meta.url)) });
    loaded = { MoonrakerTransport, moonraker_endpoint };
  }
  return loaded;
}
