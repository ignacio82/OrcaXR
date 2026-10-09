/** The packaged printer core, instantiated synchronously for Node tests. */
import { readFileSync } from 'node:fs';
import { CORE_PRINTER_ASSET } from '../../../../core/browser/printer/asset';
import {
  initSync,
  moonraker_endpoint,
  MoonrakerTransport,
  PrinterSession,
  PrintWorkflow,
} from '../../../../core/browser/printer/orcaxr_core.js';
import type { MoonrakerTransportCore } from '../SharedMoonrakerTransport';
import type { PrinterSessionCore } from '../SharedPrinterSession';
import type { PrintWorkflowCore } from '../SharedPrintWorkflow';

let loaded: (MoonrakerTransportCore & PrinterSessionCore & PrintWorkflowCore) | undefined;

export function loadSharedPrinterCore(): MoonrakerTransportCore & PrinterSessionCore & PrintWorkflowCore {
  if (!loaded) {
    initSync({ module: readFileSync(new URL(`../../../public/${CORE_PRINTER_ASSET.wasm.path}`, import.meta.url)) });
    loaded = { MoonrakerTransport, moonraker_endpoint, PrinterSession, PrintWorkflow };
  }
  return loaded;
}
