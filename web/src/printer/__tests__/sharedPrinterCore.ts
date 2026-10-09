/** The packaged printer core, instantiated synchronously for Node tests. */
import { readFileSync } from 'node:fs';
import { CORE_PRINTER_ASSET } from '../../../../core/browser/printer/asset';
import {
  initSync,
  moonraker_endpoint,
  MoonrakerTransport,
  PrinterSession,
} from '../../../../core/browser/printer/orcaxr_core.js';
import type { MoonrakerTransportCore } from '../SharedMoonrakerTransport';
import type { PrinterSessionCore } from '../SharedPrinterSession';

let loaded: (MoonrakerTransportCore & PrinterSessionCore) | undefined;

export function loadSharedPrinterCore(): MoonrakerTransportCore & PrinterSessionCore {
  if (!loaded) {
    initSync({ module: readFileSync(new URL(`../../../public/${CORE_PRINTER_ASSET.wasm.path}`, import.meta.url)) });
    loaded = { MoonrakerTransport, moonraker_endpoint, PrinterSession };
  }
  return loaded;
}
