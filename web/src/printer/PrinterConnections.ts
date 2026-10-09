/**
 * Which implementation runs a printer connection.
 *
 * Production runs the shared core's transport (`SharedMoonrakerTransport` over
 * the printer WASM): the policy the Android app runs, replayed against the
 * browser's own. The browser transport stays selectable as the rollback
 * adapter — `?printer-transport=typescript`, or the stored
 * `orcaxr.printerTransport` preference — and also serves a connection made
 * while the core cannot load, so printing never depends on it.
 */
import {
  MoonrakerTransport,
  type MoonrakerConnection,
  type MoonrakerTransportConfig,
  type MoonrakerTransportDependencies,
} from './MoonrakerTransport';
import type { SharedPrinterRuntime } from './SharedPrinterCore';

export type PrinterTransportChoice = 'shared' | 'typescript';

export const PRINTER_TRANSPORT_PREFERENCE = 'orcaxr.printerTransport';

/** The query parameter wins over the stored preference; anything else is the shared core. */
export function printerTransportChoice(search: string, stored: string | null): PrinterTransportChoice {
  const asked = new URLSearchParams(search).get('printer-transport') ?? stored;
  return asked === 'typescript' ? 'typescript' : 'shared';
}

export class PrinterConnections {
  private runtime: SharedPrinterRuntime | null = null;
  private loading: Promise<void> | null = null;
  private failure: unknown = null;
  private readonly ready: ((runtime: SharedPrinterRuntime) => void)[] = [];

  constructor(
    readonly choice: PrinterTransportChoice,
    private readonly load: () => Promise<SharedPrinterRuntime>,
    private readonly warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
  ) {}

  /** Starts loading the shared core, once; settles when it is ready or cannot load. Never rejects. */
  prepare(): Promise<void> {
    if (this.choice === 'typescript') return Promise.resolve();
    this.loading ??= this.load().then(
      (runtime) => {
        this.runtime = runtime;
        for (const use of this.ready.splice(0)) use(runtime);
      },
      (error: unknown) => {
        this.failure = error;
        this.warn('The shared printer core could not load; the browser transport serves this session.', error);
      },
    );
    return this.loading;
  }

  /** Which implementation the next connection runs on. */
  get implementation(): PrinterTransportChoice {
    return this.runtime ? 'shared' : 'typescript';
  }

  /** Runs `use` once the shared core has loaded: never for the rollback, or a core that cannot load. */
  whenReady(use: (runtime: SharedPrinterRuntime) => void): void {
    if (this.runtime) use(this.runtime);
    else if (this.choice === 'shared') this.ready.push(use);
  }

  /** Why the shared core is not running, if it failed to load. */
  get loadFailure(): unknown {
    return this.failure;
  }

  create(config: MoonrakerTransportConfig, dependencies?: MoonrakerTransportDependencies): MoonrakerConnection {
    return this.runtime ? this.runtime.connection(config, dependencies) : new MoonrakerTransport(config, dependencies);
  }
}
