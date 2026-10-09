/**
 * The printer core (`core/browser/printer`): the shared Rust printer policy as
 * WASM. Loaded once, on demand, in its own chunk; its bytes are verified
 * (length, SHA-256, then the core handshake) before anything runs, and both
 * service workers precache them with the application, so a printer on the LAN
 * stays reachable offline.
 */
import initialize, {
  core_info,
  moonraker_endpoint,
  MoonrakerTransport,
  PrinterSession,
  PrintWorkflow,
} from '../../../core/browser/printer/orcaxr_core.js';
import { CORE_PRINTER_ASSET } from '../../../core/browser/printer/asset';
import { checkCoreHandshake, fetchCoreAsset } from '../slicer/core/CoreAsset';
import type {
  MoonrakerConnection,
  MoonrakerTransportConfig,
  MoonrakerTransportDependencies,
} from './MoonrakerTransport';
import { SharedMoonrakerTransport } from './SharedMoonrakerTransport';
import type {
  PrinterSelection,
  PrinterSession as PrinterSessionApi,
  PrinterSessionTransport,
} from './PrinterSessionController';
import { SharedPrinterSession } from './SharedPrinterSession';
import type { PrintWorkflow as PrintWorkflowApi, PrintWorkflowDependencies } from './PrintWorkflowController';
import { SharedPrintWorkflow } from './SharedPrintWorkflow';

/** Makes connections that run on the loaded core. */
export type SharedConnectionFactory = (
  config: MoonrakerTransportConfig,
  dependencies?: MoonrakerTransportDependencies,
) => MoonrakerConnection;

/** What runs on the loaded printer core: connections, sessions and send workflows. */
export interface SharedPrinterRuntime {
  readonly connection: SharedConnectionFactory;
  session<T extends PrinterSessionTransport>(createTransport: (selection: PrinterSelection) => T): PrinterSessionApi<T>;
  workflow(dependencies: PrintWorkflowDependencies): PrintWorkflowApi;
}

const PRINTER = { maxBytes: 3 * 1024 * 1024, component: 'printer' } as const;

export async function loadPrinterCore(
  base = new URL(import.meta.env.BASE_URL, globalThis.location.origin),
  fetcher: typeof fetch = fetch,
): Promise<SharedPrinterRuntime> {
  await fetchCoreAsset(CORE_PRINTER_ASSET.manifest, base, fetcher, PRINTER);
  const bytes = await fetchCoreAsset(CORE_PRINTER_ASSET.wasm, base, fetcher, PRINTER);
  await initialize({ module_or_path: bytes });
  checkCoreHandshake(core_info(), 'printer');
  const core = { MoonrakerTransport, moonraker_endpoint, PrinterSession, PrintWorkflow };
  return {
    connection: (config, dependencies) => new SharedMoonrakerTransport(core, config, dependencies),
    session: (createTransport) => new SharedPrinterSession(core, createTransport),
    workflow: (dependencies) => new SharedPrintWorkflow(core, dependencies),
  };
}
