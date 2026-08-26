/**
 * Named printers and fast switching (P9.2).
 *
 * OrcaXR previously knew about one endpoint. A workshop with two machines —
 * a Snapmaker U1 and an Elegoo Centauri Carbon, say — had to retype the
 * address to move between them, which loses the credential, the tool map, and
 * any sense of which machine a job was meant for.
 *
 * This is a directory of named printers with one default, stored on the device
 * next to the other preferences. Two properties matter more than the feature
 * itself:
 *
 * - **No state leakage between printers.** Each entry owns its address, its
 *   credential, and its capability record. Switching does not carry anything
 *   from the previous machine, because a tool map or an API key silently
 *   surviving a switch is how a job goes to the wrong printer.
 * - **No fake discovery.** A browser cannot scan a subnet, and pretending to
 *   would produce an empty list that reads as "no printers found" rather than
 *   "this cannot be done here". Discovery is reported as unavailable with the
 *   manual and proxy alternatives named.
 */

import type { KeyValueStorage } from '../settings/Preferences';

const STORAGE_KEY = 'orcaxr.printers';
const MAX_PRINTERS = 16;
const MAX_NAME_LENGTH = 64;
const MAX_HOST_LENGTH = 2048;
const DEFAULT_PORT = 7125;

export interface PrinterEntry {
  /** Stable identity; survives renaming so a default never dangles. */
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /**
   * Capabilities as this printer last reported them, so the UI can be honest
   * before a connection is made. Never inferred from another printer.
   */
  readonly capabilities?: readonly string[];
  /** Tool count last reported, used to check a job fits before sending. */
  readonly toolCount?: number;
}

export interface PrinterDirectory {
  readonly printers: readonly PrinterEntry[];
  /** Id of the default, or empty when none is configured. */
  readonly defaultId: string;
}

export const EMPTY_PRINTER_DIRECTORY: PrinterDirectory = Object.freeze({
  printers: Object.freeze([]),
  defaultId: '',
});

export function loadPrinterDirectory(storage: KeyValueStorage | null): PrinterDirectory {
  if (!storage) return EMPTY_PRINTER_DIRECTORY;
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(value) || !Array.isArray(value.printers)) return EMPTY_PRINTER_DIRECTORY;
    const printers = value.printers
      .map(readEntry)
      .filter((entry): entry is PrinterEntry => entry !== undefined)
      .slice(0, MAX_PRINTERS);
    const defaultId = typeof value.defaultId === 'string' ? value.defaultId : '';
    return Object.freeze({
      printers: Object.freeze(printers),
      // A default naming a printer that is gone is worse than none: it would
      // silently resolve to nothing at send time.
      defaultId: printers.some((entry) => entry.id === defaultId) ? defaultId : (printers[0]?.id ?? ''),
    });
  } catch {
    return EMPTY_PRINTER_DIRECTORY;
  }
}

export function savePrinterDirectory(directory: PrinterDirectory, storage: KeyValueStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        printers: directory.printers.slice(0, MAX_PRINTERS),
        defaultId: directory.defaultId,
      }),
    );
  } catch {
    // A blocked store means the directory lasts only for this session.
  }
}

export class PrinterDirectoryError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-name' | 'invalid-endpoint' | 'duplicate' | 'not-found' | 'too-many',
  ) {
    super(message);
    this.name = 'PrinterDirectoryError';
  }
}

/**
 * A printer's stable identity, without requiring a secure context.
 *
 * `crypto.randomUUID` is secure-context-only, and the all-in-one server
 * publishes the UI over plain HTTP on a LAN address — so on the deployment this
 * app is built for it is simply `undefined`, and calling it throws while the
 * printer directory is being loaded at startup. `getRandomValues` carries no
 * such restriction and is what a v4 UUID actually needs; `randomUUID` is kept
 * as the fast path where it exists.
 */
export function randomPrinterId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  // Version 4, variant 1, exactly as `randomUUID` produces.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Add a printer, refusing a duplicate address rather than silently shadowing one. */
export function addPrinter(
  directory: PrinterDirectory,
  candidate: { name: string; host: string; port?: number },
  makeId: () => string,
): PrinterDirectory {
  const name = candidate.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new PrinterDirectoryError('A printer needs a name you will recognise', 'invalid-name');
  const host = normalizeHost(candidate.host);
  const port = candidate.port ?? DEFAULT_PORT;
  if (!validPort(port)) throw new PrinterDirectoryError('That port is not usable', 'invalid-endpoint');
  if (directory.printers.length >= MAX_PRINTERS) {
    throw new PrinterDirectoryError(`This device holds at most ${MAX_PRINTERS} printers`, 'too-many');
  }
  // Two entries for one machine would each hold their own credential and tool
  // map, and there is no way to tell which one a job used.
  if (directory.printers.some((entry) => entry.host === host && entry.port === port)) {
    throw new PrinterDirectoryError('That address is already saved under another name', 'duplicate');
  }
  const entry: PrinterEntry = { id: makeId(), name, host, port };
  const printers = [...directory.printers, entry];
  return Object.freeze({
    printers: Object.freeze(printers),
    defaultId: directory.defaultId || entry.id,
  });
}

export function updatePrinter(
  directory: PrinterDirectory,
  id: string,
  changes: Partial<Omit<PrinterEntry, 'id'>>,
): PrinterDirectory {
  const index = directory.printers.findIndex((entry) => entry.id === id);
  if (index === -1) throw new PrinterDirectoryError('That printer is not in this directory', 'not-found');
  const current = directory.printers[index];
  const next: PrinterEntry = {
    ...current,
    ...(changes.name !== undefined ? { name: requireName(changes.name) } : {}),
    ...(changes.host !== undefined ? { host: normalizeHost(changes.host) } : {}),
    ...(changes.port !== undefined ? { port: requirePort(changes.port) } : {}),
    ...(changes.capabilities !== undefined ? { capabilities: Object.freeze([...changes.capabilities]) } : {}),
    ...(changes.toolCount !== undefined ? { toolCount: changes.toolCount } : {}),
  };
  if (
    directory.printers.some(
      (entry, position) => position !== index && entry.host === next.host && entry.port === next.port,
    )
  ) {
    throw new PrinterDirectoryError('Another saved printer already uses that address', 'duplicate');
  }
  const printers = [...directory.printers];
  printers[index] = next;
  return Object.freeze({ printers: Object.freeze(printers), defaultId: directory.defaultId });
}

export function removePrinter(directory: PrinterDirectory, id: string): PrinterDirectory {
  const printers = directory.printers.filter((entry) => entry.id !== id);
  if (printers.length === directory.printers.length) {
    throw new PrinterDirectoryError('That printer is not in this directory', 'not-found');
  }
  return Object.freeze({
    printers: Object.freeze(printers),
    // Removing the default promotes the first remaining printer rather than
    // leaving a dangling id that resolves to nothing at send time.
    defaultId: directory.defaultId === id ? (printers[0]?.id ?? '') : directory.defaultId,
  });
}

export function setDefaultPrinter(directory: PrinterDirectory, id: string): PrinterDirectory {
  if (!directory.printers.some((entry) => entry.id === id)) {
    throw new PrinterDirectoryError('That printer is not in this directory', 'not-found');
  }
  return Object.freeze({ printers: directory.printers, defaultId: id });
}

export function findPrinter(directory: PrinterDirectory, id: string): PrinterEntry | undefined {
  return directory.printers.find((entry) => entry.id === id);
}

export function defaultPrinter(directory: PrinterDirectory): PrinterEntry | undefined {
  return findPrinter(directory, directory.defaultId);
}

/**
 * Adopt a single legacy endpoint as the first named printer.
 *
 * An existing install has one address under `orcaxr.printer` and no name. It
 * becomes "My printer" rather than being dropped, because an operator who
 * already configured a machine should not have to do it again.
 */
export function adoptLegacyEndpoint(
  directory: PrinterDirectory,
  legacy: { host: string; port: number } | undefined,
  makeId: () => string,
): PrinterDirectory {
  if (!legacy?.host.trim()) return directory;
  if (directory.printers.length > 0) return directory;
  try {
    return addPrinter(directory, { name: 'My printer', host: legacy.host, port: legacy.port }, makeId);
  } catch {
    return directory;
  }
}

export interface DiscoveryOutcome {
  readonly available: false;
  readonly reason: string;
  readonly alternatives: readonly string[];
}

/**
 * Local-network discovery, reported honestly.
 *
 * A page cannot enumerate a subnet: there is no browser API for it, and
 * probing addresses one by one is slow, trips Local Network Access prompts per
 * address, and returns nothing useful behind most routers. Offering a Scan
 * button that finds nothing would read as "you have no printers", which is a
 * worse answer than "this cannot be done from a browser".
 */
export function describeDiscovery(): DiscoveryOutcome {
  return Object.freeze({
    available: false,
    reason:
      'A browser cannot scan your network for printers; there is no API for it and probing addresses one by one is unreliable and slow.',
    alternatives: Object.freeze([
      'Enter the printer address directly — Moonraker usually answers on port 7125.',
      'Check the printer’s own screen or router for its address.',
      'Run a local proxy that publishes a list, and point OrcaXR at that.',
    ]),
  });
}

function readEntry(value: unknown): PrinterEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  const host = typeof value.host === 'string' ? value.host.trim().slice(0, MAX_HOST_LENGTH) : '';
  const port = validPort(value.port) ? (value.port as number) : DEFAULT_PORT;
  if (!id || !name || !host) return undefined;
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((entry): entry is string => typeof entry === 'string').slice(0, 32)
    : undefined;
  const toolCount =
    Number.isSafeInteger(value.toolCount) && (value.toolCount as number) > 0 ? (value.toolCount as number) : undefined;
  return Object.freeze({
    id,
    name,
    host,
    port,
    ...(capabilities ? { capabilities: Object.freeze(capabilities) } : {}),
    ...(toolCount ? { toolCount } : {}),
  });
}

function requireName(value: string): string {
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new PrinterDirectoryError('A printer needs a name you will recognise', 'invalid-name');
  return name;
}

function requirePort(value: number): number {
  if (!validPort(value)) throw new PrinterDirectoryError('That port is not usable', 'invalid-endpoint');
  return value;
}

function normalizeHost(value: string): string {
  const host = value.trim().slice(0, MAX_HOST_LENGTH);
  if (!host) throw new PrinterDirectoryError('A printer needs an address', 'invalid-endpoint');
  return host;
}

function validPort(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
