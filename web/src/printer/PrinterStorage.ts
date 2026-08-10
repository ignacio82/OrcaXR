/**
 * What is already on the printer, and what may be done with it (P9.5).
 *
 * Sending a plate is only half of a print workflow. The other half is the file
 * that is already sitting on the machine — the one someone sliced yesterday, or
 * uploaded from another computer, or wants to reprint without re-slicing. Orca
 * gives that its own browser, and without one an OrcaXR user has to walk to
 * Fluidd to reprint a file they can already see the printer holding.
 *
 * Three rules shape this module:
 *
 * - **Every destructive operation names its exact target.** Delete and move
 *   take the path the listing reported, not a name reconstructed from a label,
 *   because a rename that lands on the wrong file is unrecoverable.
 *
 * - **A missing fact stays missing.** Moonraker reports metadata only for files
 *   it has scanned; an unscanned file has no estimated time and no thumbnail.
 *   Reporting zero would read as "this print takes no time", so absent fields
 *   are absent here and the UI says so.
 *
 * - **Nothing reaches the printer with a credential in a URL.** Thumbnails and
 *   downloads go through the transport's own authenticated `download`, which is
 *   why they exist there rather than as an `<img src>` pointed at the machine.
 */

import { MoonrakerTransportError } from './MoonrakerTypes';

/** The Moonraker file root this module browses. */
export const GCODE_ROOT = 'gcodes';

export interface PrinterStorageTransport {
  request<T>(
    path: string,
    options?: { readonly signal?: AbortSignal; readonly operation?: string; readonly method?: string },
  ): Promise<T>;
  download(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<Uint8Array>;
}

export interface PrinterDirectoryEntry {
  readonly name: string;
  /** Root-relative path, exactly as the printer reported it. */
  readonly path: string;
  readonly modifiedMs?: number;
  readonly sizeBytes?: number;
}

export interface PrinterFileEntry extends PrinterDirectoryEntry {
  readonly kind: 'file';
}

export interface PrinterFolderEntry extends PrinterDirectoryEntry {
  readonly kind: 'directory';
}

export interface PrinterDirectoryListing {
  /** Root-relative directory this listing describes; empty string is the root. */
  readonly path: string;
  readonly directories: readonly PrinterFolderEntry[];
  readonly files: readonly PrinterFileEntry[];
  /** Free space the printer reported for the root, when it reported any. */
  readonly freeBytes?: number;
  readonly totalBytes?: number;
}

export interface PrinterFileThumbnail {
  readonly width: number;
  readonly height: number;
  /** Root-relative path to the image, resolved against the file's directory. */
  readonly path: string;
  readonly sizeBytes?: number;
}

export interface PrinterFileMetadata {
  readonly path: string;
  readonly sizeBytes?: number;
  readonly modifiedMs?: number;
  readonly slicer?: string;
  readonly slicerVersion?: string;
  readonly layerHeightMm?: number;
  readonly objectHeightMm?: number;
  readonly filamentTotalMm?: number;
  readonly filamentWeightG?: number;
  readonly estimatedSeconds?: number;
  readonly firstLayerBedTempC?: number;
  readonly firstLayerNozzleTempC?: number;
  readonly thumbnails: readonly PrinterFileThumbnail[];
}

/**
 * One thing a surface asks the shell to do with printer storage.
 *
 * Navigation is in here beside the destructive operations on purpose: browsing
 * needs the same live connection, and routing it through the same seam is what
 * keeps a delete acting on a path the printer just reported rather than on a
 * stale row someone is still looking at.
 */
export type PrinterStorageOperation =
  | { readonly kind: 'browse'; readonly path?: string }
  | { readonly kind: 'print'; readonly path: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string; readonly nextName: string }
  | { readonly kind: 'download'; readonly path: string };

export type PrinterStorageErrorCode =
  | 'listing-failed'
  | 'metadata-unavailable'
  | 'delete-failed'
  | 'move-failed'
  | 'download-failed'
  | 'start-failed'
  | 'invalid-target'
  | 'cancelled';

export class PrinterStorageError extends Error {
  override readonly name = 'PrinterStorageError';

  constructor(
    message: string,
    readonly code: PrinterStorageErrorCode,
  ) {
    super(message);
  }
}

/**
 * Reject a path that would escape the root or address nothing.
 *
 * Moonraker resolves `..` server-side, so a traversal would be refused there
 * too — but refusing it here means the operation is never attempted and the
 * message names the real problem instead of surfacing a 404.
 */
export function assertStoragePath(path: string, what: string): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) throw new PrinterStorageError(`${what} is empty.`, 'invalid-target');
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new PrinterStorageError(`${what} may not step outside the printer's ${GCODE_ROOT} folder.`, 'invalid-target');
  }
  return trimmed;
}

/** A new name for one file: a bare segment, never a path. */
export function assertStorageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new PrinterStorageError('The new name is empty.', 'invalid-target');
  if (/[\\/]/.test(trimmed)) {
    throw new PrinterStorageError(
      'A name may not contain a folder separator; move the file instead.',
      'invalid-target',
    );
  }
  if (trimmed === '.' || trimmed === '..') throw new PrinterStorageError('That name is reserved.', 'invalid-target');
  return trimmed;
}

/** The directory part of a root-relative file path; empty for the root. */
export function storageDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function joinStoragePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

/** The parent of a directory path, or undefined at the root. */
export function parentStorageDirectory(path: string): string | undefined {
  if (!path) return undefined;
  return storageDirectoryOf(path);
}

/**
 * List one directory.
 *
 * `/server/files/directory` is used rather than the flat `list` because a
 * printer that has been in service for a while has folders, and flattening them
 * turns "which of these is the one I sliced" into a scrolling exercise.
 */
export async function listPrinterDirectory(
  transport: PrinterStorageTransport,
  path = '',
  signal?: AbortSignal,
): Promise<PrinterDirectoryListing> {
  const relative = path ? assertStoragePath(path, 'That folder') : '';
  const target = relative ? `${GCODE_ROOT}/${relative}` : GCODE_ROOT;
  let payload: unknown;
  try {
    payload = await transport.request<unknown>(
      `/server/files/directory?path=${encodeURIComponent(target)}&extended=true`,
      { operation: 'list_directory', ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    throw storageFailure(error, `The printer could not list ${relative || GCODE_ROOT}`, 'listing-failed', signal);
  }
  if (!isRecord(payload)) {
    throw new PrinterStorageError(
      `The printer's listing of ${relative || GCODE_ROOT} was not readable.`,
      'listing-failed',
    );
  }

  const directories: PrinterFolderEntry[] = [];
  for (const entry of asArray(payload.dirs)) {
    if (!isRecord(entry)) continue;
    const name = readString(entry.dirname) ?? readString(entry.name);
    if (!name || name === '.' || name === '..') continue;
    directories.push(
      Object.freeze({
        kind: 'directory' as const,
        name,
        path: joinStoragePath(relative, name),
        ...optionalNumber('modifiedMs', readTimestampMs(entry.modified)),
        ...optionalNumber('sizeBytes', readNumber(entry.size)),
      }),
    );
  }

  const files: PrinterFileEntry[] = [];
  for (const entry of asArray(payload.files)) {
    if (!isRecord(entry)) continue;
    const name = readString(entry.filename) ?? readString(entry.path);
    if (!name) continue;
    files.push(
      Object.freeze({
        kind: 'file' as const,
        name,
        path: joinStoragePath(relative, name),
        ...optionalNumber('modifiedMs', readTimestampMs(entry.modified)),
        ...optionalNumber('sizeBytes', readNumber(entry.size)),
      }),
    );
  }

  const usage = isRecord(payload.disk_usage) ? payload.disk_usage : undefined;
  return Object.freeze({
    path: relative,
    // Folders first, then files, each newest first: the file someone just
    // sliced is the one they are looking for.
    directories: Object.freeze(directories.sort(byNameAscending)),
    files: Object.freeze(files.sort(byNewestFirst)),
    ...optionalNumber('freeBytes', readNumber(usage?.free)),
    ...optionalNumber('totalBytes', readNumber(usage?.total)),
  });
}

/** Everything the printer knows about one stored file. */
export async function readPrinterFileMetadata(
  transport: PrinterStorageTransport,
  path: string,
  signal?: AbortSignal,
): Promise<PrinterFileMetadata> {
  const relative = assertStoragePath(path, 'That file');
  let payload: unknown;
  try {
    payload = await transport.request<unknown>(`/server/files/metadata?filename=${encodeURIComponent(relative)}`, {
      operation: 'file_metadata',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw storageFailure(error, `The printer has no metadata for ${relative}`, 'metadata-unavailable', signal);
  }
  if (!isRecord(payload)) {
    throw new PrinterStorageError(`The printer's metadata for ${relative} was not readable.`, 'metadata-unavailable');
  }

  const directory = storageDirectoryOf(relative);
  const thumbnails: PrinterFileThumbnail[] = [];
  for (const entry of asArray(payload.thumbnails)) {
    if (!isRecord(entry)) continue;
    const width = readNumber(entry.width);
    const height = readNumber(entry.height);
    const relativePath = readString(entry.relative_path);
    if (width === undefined || height === undefined || !relativePath) continue;
    thumbnails.push(
      Object.freeze({
        width,
        height,
        path: joinStoragePath(directory, relativePath.replace(/^\.?\//, '')),
        ...optionalNumber('sizeBytes', readNumber(entry.size)),
      }),
    );
  }

  return Object.freeze({
    path: relative,
    ...optionalNumber('sizeBytes', readNumber(payload.size)),
    ...optionalNumber('modifiedMs', readTimestampMs(payload.modified)),
    ...optionalString('slicer', readString(payload.slicer)),
    ...optionalString('slicerVersion', readString(payload.slicer_version)),
    ...optionalNumber('layerHeightMm', readNumber(payload.layer_height)),
    ...optionalNumber('objectHeightMm', readNumber(payload.object_height)),
    ...optionalNumber('filamentTotalMm', readNumber(payload.filament_total)),
    ...optionalNumber('filamentWeightG', readNumber(payload.filament_weight_total)),
    ...optionalNumber('estimatedSeconds', readNumber(payload.estimated_time)),
    ...optionalNumber('firstLayerBedTempC', readNumber(payload.first_layer_bed_temp)),
    ...optionalNumber('firstLayerNozzleTempC', readNumber(payload.first_layer_extr_temp)),
    // Largest first: a panel showing one wants the best it can get.
    thumbnails: Object.freeze(thumbnails.sort((left, right) => right.width * right.height - left.width * left.height)),
  });
}

/** Fetch one stored file's bytes with the session's credentials attached. */
export async function downloadPrinterFile(
  transport: PrinterStorageTransport,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const relative = assertStoragePath(path, 'That file');
  try {
    return await transport.download(`/server/files/${GCODE_ROOT}/${encodePathSegments(relative)}`, {
      operation: 'download_file',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw storageFailure(error, `Downloading ${relative} failed`, 'download-failed', signal);
  }
}

export async function deletePrinterFile(
  transport: PrinterStorageTransport,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const relative = assertStoragePath(path, 'That file');
  try {
    await transport.request<unknown>(`/server/files/${GCODE_ROOT}/${encodePathSegments(relative)}`, {
      method: 'DELETE',
      operation: 'delete_file',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw storageFailure(error, `Deleting ${relative} failed`, 'delete-failed', signal);
  }
}

/**
 * Move or rename one file.
 *
 * Moonraker has no separate rename: both are `/server/files/move`, and a rename
 * is a move whose destination shares the source's directory. Keeping that one
 * call means a rename and a move cannot drift apart in their failure handling.
 */
export async function movePrinterFile(
  transport: PrinterStorageTransport,
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  const from = assertStoragePath(source, 'The file being moved');
  const to = assertStoragePath(destination, 'The destination');
  if (from === to) throw new PrinterStorageError('The destination is the file itself.', 'invalid-target');
  try {
    await transport.request<unknown>(
      `/server/files/move?source=${encodeURIComponent(`${GCODE_ROOT}/${from}`)}&dest=${encodeURIComponent(
        `${GCODE_ROOT}/${to}`,
      )}`,
      { method: 'POST', operation: 'move_file', ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    throw storageFailure(error, `Moving ${from} to ${to} failed`, 'move-failed', signal);
  }
  return to;
}

export function renamedStoragePath(path: string, nextName: string): string {
  const relative = assertStoragePath(path, 'That file');
  return joinStoragePath(storageDirectoryOf(relative), assertStorageName(nextName));
}

/** Start a print of a file that is already on the printer. */
export async function startStoredPrint(
  transport: PrinterStorageTransport,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const relative = assertStoragePath(path, 'That file');
  try {
    await transport.request<unknown>(`/printer/print/start?filename=${encodeURIComponent(relative)}`, {
      method: 'POST',
      operation: 'start_stored_print',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw storageFailure(error, `Starting ${relative} failed`, 'start-failed', signal);
  }
  return relative;
}

/** Human-readable size; a missing size stays missing rather than becoming 0 B. */
export function formatStorageSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function storageFailure(
  error: unknown,
  prefix: string,
  code: PrinterStorageErrorCode,
  signal?: AbortSignal,
): PrinterStorageError {
  if (error instanceof PrinterStorageError) return error;
  if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
    return new PrinterStorageError(`${prefix}: cancelled.`, 'cancelled');
  }
  const detail = error instanceof MoonrakerTransportError ? error.code : 'request failed';
  return new PrinterStorageError(`${prefix} (${detail}).`, code);
}

function byNameAscending(left: PrinterDirectoryEntry, right: PrinterDirectoryEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function byNewestFirst(left: PrinterDirectoryEntry, right: PrinterDirectoryEntry): number {
  const difference = (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0);
  return difference !== 0 ? difference : byNameAscending(left, right);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Moonraker reports modification times in seconds since the epoch. */
function readTimestampMs(value: unknown): number | undefined {
  const seconds = readNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
