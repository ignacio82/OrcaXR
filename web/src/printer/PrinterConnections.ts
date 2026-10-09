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
import type { SharedConnectionFactory } from './SharedPrinterCore';

export type PrinterTransportChoice = 'shared' | 'typescript';

export const PRINTER_TRANSPORT_PREFERENCE = 'orcaxr.printerTransport';

/** The query parameter wins over the stored preference; anything else is the shared core. */
export function printerTransportChoice(search: string, stored: string | null): PrinterTransportChoice {
  const asked = new URLSearchParams(search).get('printer-transport') ?? stored;
  return asked === 'typescript' ? 'typescript' : 'shared';
}

export class PrinterConnections {
  private factory: SharedConnectionFactory | null = null;
  private loading: Promise<void> | null = null;
  private failure: unknown = null;

  constructor(
    readonly choice: PrinterTransportChoice,
    private readonly load: () => Promise<SharedConnectionFactory>,
    private readonly warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
  ) {}

  /** Starts loading the shared core, once; settles when it is ready or cannot load. Never rejects. */
  prepare(): Promise<void> {
    if (this.choice === 'typescript') return Promise.resolve();
    this.loading ??= this.load().then(
      (factory) => {
        this.factory = factory;
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
    return this.factory ? 'shared' : 'typescript';
  }

  /** Why the shared core is not running, if it failed to load. */
  get loadFailure(): unknown {
    return this.failure;
  }

  create(config: MoonrakerTransportConfig, dependencies?: MoonrakerTransportDependencies): MoonrakerConnection {
    return this.factory ? this.factory(config, dependencies) : new MoonrakerTransport(config, dependencies);
  }
}
