/**
 * Printer storage over the hosts' shared contract (`PrinterStorage.ts`): the
 * request each operation sends or why it is refused, the result an outcome
 * reads as, a listing or metadata reply read, and a size put to an operator.
 * Every answer comes from the production functions over a scripted transport;
 * the Rust core answers the same requests (`orcaxr_printer::storage`).
 */
import type {
  ProjectOptionalTextWire,
  ProjectPrinterStorageFailureWire,
  ProjectPrinterStorageFinishWire,
  ProjectPrinterStorageListingWire,
  ProjectPrinterStorageMetadataWire,
  ProjectPrinterStorageOperationWire,
  ProjectPrinterStoragePlanWire,
  ProjectPrinterStorageResultWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  PrinterStorageError,
  deletePrinterFile,
  downloadPrinterFile,
  formatStorageSize,
  listPrinterDirectory,
  movePrinterFile,
  readPrinterFileMetadata,
  joinStoragePath,
  renamedStoragePath,
  startStoredPrint,
  storageDirectoryOf,
  type PrinterDirectoryEntry,
  type PrinterDirectoryListing,
  type PrinterFileMetadata,
  type PrinterStorageTransport,
} from './PrinterStorage';
import { fromUnits, optionalTextWire, units } from './PrinterWire';

const absent = { absent: {} } as const;
const finite = (value: number | undefined) => (value === undefined ? absent : { value });
const camel = (code: string): string => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (code: string): string => code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function storageFailureWire(error: PrinterStorageError): ProjectPrinterStorageFailureWire {
  return { code: camel(error.code) as ProjectPrinterStorageFailureWire['code'], message: units(error.message) };
}

/** Runs one operation over [transport], as the shell runs it. */
function run(
  operation: ProjectPrinterStorageOperationWire,
  transport: PrinterStorageTransport,
  signal?: AbortSignal,
): Promise<unknown> {
  if ('list' in operation) return listPrinterDirectory(transport, fromUnits(operation.list.text), signal);
  if ('metadata' in operation) return readPrinterFileMetadata(transport, fromUnits(operation.metadata.text), signal);
  if ('download' in operation) return downloadPrinterFile(transport, fromUnits(operation.download.text), signal);
  if ('delete' in operation) return deletePrinterFile(transport, fromUnits(operation.delete.text), signal);
  if ('move' in operation)
    return movePrinterFile(transport, fromUnits(operation.move.source), fromUnits(operation.move.destination), signal);
  if ('rename' in operation) {
    const path = fromUnits(operation.rename.path);
    // Validated before anything moves, as the shell computes it.
    return Promise.resolve()
      .then(() => renamedStoragePath(path, fromUnits(operation.rename.name)))
      .then((destination) => movePrinterFile(transport, path, destination, signal));
  }
  return startStoredPrint(transport, fromUnits(operation.start.text), signal);
}

/** What [operation] sends, or why it is refused before anything leaves. */
export async function answerStoragePlan(
  operation: ProjectPrinterStorageOperationWire,
): Promise<ProjectPrinterStoragePlanWire> {
  let sent: ProjectPrinterStoragePlanWire | undefined;
  const transport: PrinterStorageTransport = {
    request: async (path, options) => {
      sent = {
        request: {
          path: units(path),
          method: units(options?.method ?? 'GET'),
          operation: units(options?.operation ?? ''),
          timeoutMs: absent,
        },
      };
      throw new Error('sent');
    },
    download: async (path, options) => {
      sent = { download: { path: units(path), operation: units(options?.operation ?? '') } };
      throw new Error('sent');
    },
  };
  try {
    await run(operation, transport);
  } catch (error) {
    if (sent) return sent;
    if (error instanceof PrinterStorageError) return { refused: storageFailureWire(error) };
    throw error;
  }
  throw new Error('The operation sent nothing');
}

function resultWire(operation: ProjectPrinterStorageOperationWire, value: unknown): ProjectPrinterStorageResultWire {
  if ('list' in operation) return { listing: listingWire(value as PrinterDirectoryListing) };
  if ('metadata' in operation) return { metadata: metadataWire(value as PrinterFileMetadata) };
  if ('move' in operation || 'rename' in operation) return { moved: { text: units(value as string) } };
  if ('start' in operation) return { started: { text: units(value as string) } };
  return { done: {} };
}

/** The result an operation reads as once its exchange ended without a reply to read. */
export async function answerStorageFinish(
  request: ProjectPrinterStorageFinishWire,
): Promise<ProjectPrinterStorageResultWire> {
  const { operation, outcome } = request;
  const abort = new AbortController();
  const answer = async (): Promise<never | undefined> => {
    if ('done' in outcome) return undefined;
    if ('cancelled' in outcome) {
      abort.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const failure = outcome.failed;
    if (!('value' in failure.code)) throw new Error('request failed');
    throw new MoonrakerTransportError(snake(failure.code.value) as MoonrakerErrorCode, 'storage', {
      ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
      ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
    });
  };
  const transport: PrinterStorageTransport = {
    request: async () => (await answer()) as never,
    download: async () => {
      await answer();
      return new Uint8Array(0);
    },
  };
  try {
    return resultWire(operation, await run(operation, transport, abort.signal));
  } catch (error) {
    if (error instanceof PrinterStorageError) return { failed: storageFailureWire(error) };
    throw error;
  }
}

/** A listing or metadata reply (Moonraker's `result`, as JSON) read as the shell reads it. */
export async function answerStorageRead(
  operation: ProjectPrinterStorageOperationWire,
  reply: string,
): Promise<ProjectPrinterStorageResultWire> {
  const transport: PrinterStorageTransport = {
    request: async () => JSON.parse(reply),
    download: async () => new Uint8Array(0),
  };
  try {
    return resultWire(operation, await run(operation, transport));
  } catch (error) {
    if (error instanceof PrinterStorageError) return { failed: storageFailureWire(error) };
    throw error;
  }
}

export function answerStorageSize(bytes: number): ProjectOptionalTextWire {
  return optionalTextWire(formatStorageSize(bytes));
}

/** An entry carries its name; its path is the listing's joined with it. */
function entryWire(listing: PrinterDirectoryListing, entry: PrinterDirectoryEntry) {
  if (entry.path !== joinStoragePath(listing.path, entry.name))
    throw new Error(`Entry path ${entry.path} is not joined`);
  return {
    name: units(entry.name),
    modifiedMs: finite(entry.modifiedMs),
    sizeBytes: finite(entry.sizeBytes),
  };
}

function listingWire(listing: PrinterDirectoryListing): ProjectPrinterStorageListingWire {
  return {
    path: units(listing.path),
    directories: listing.directories.map((entry) => entryWire(listing, entry)),
    files: listing.files.map((entry) => entryWire(listing, entry)),
    freeBytes: finite(listing.freeBytes),
    totalBytes: finite(listing.totalBytes),
  };
}

function metadataWire(metadata: PrinterFileMetadata): ProjectPrinterStorageMetadataWire {
  const directory = storageDirectoryOf(metadata.path);
  // A thumbnail carries the path the printer reported relative to its file's
  // folder; its path is that folder joined with it.
  const relativePath = (path: string): string => {
    const relative = directory ? path.slice(directory.length + 1) : path;
    if (joinStoragePath(directory, relative) !== path) throw new Error(`Thumbnail path ${path} is not joined`);
    return relative;
  };
  return {
    path: units(metadata.path),
    sizeBytes: finite(metadata.sizeBytes),
    modifiedMs: finite(metadata.modifiedMs),
    slicer: optionalTextWire(metadata.slicer),
    slicerVersion: optionalTextWire(metadata.slicerVersion),
    layerHeightMm: finite(metadata.layerHeightMm),
    objectHeightMm: finite(metadata.objectHeightMm),
    filamentTotalMm: finite(metadata.filamentTotalMm),
    filamentWeightG: finite(metadata.filamentWeightG),
    estimatedSeconds: finite(metadata.estimatedSeconds),
    firstLayerBedTempC: finite(metadata.firstLayerBedTempC),
    firstLayerNozzleTempC: finite(metadata.firstLayerNozzleTempC),
    thumbnails: metadata.thumbnails.map((thumbnail) => ({
      width: thumbnail.width,
      height: thumbnail.height,
      relativePath: units(relativePath(thumbnail.path)),
      sizeBytes: finite(thumbnail.sizeBytes),
    })),
  };
}
