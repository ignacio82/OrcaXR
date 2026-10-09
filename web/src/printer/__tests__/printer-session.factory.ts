/**
 * Which printer session the browser session tests drive. They run as written
 * against `PrinterSessionController`; `printer-session-shared.test.ts` selects
 * the shared core's before importing them, so one suite holds both
 * implementations to the same behaviour.
 */
import {
  PrinterSessionController,
  type PrinterSelection,
  type PrinterSession,
  type PrinterSessionTransport,
} from '../PrinterSessionController';

export type PrinterSessionFactory = <T extends PrinterSessionTransport>(
  createTransport: (selection: PrinterSelection) => T,
) => PrinterSession<T>;

let factory: PrinterSessionFactory = (createTransport) => new PrinterSessionController(createTransport);

export function usePrinterSession(next: PrinterSessionFactory): void {
  factory = next;
}

export function createPrinterSession<T extends PrinterSessionTransport>(
  createTransport: (selection: PrinterSelection) => T,
): PrinterSession<T> {
  return factory(createTransport);
}
