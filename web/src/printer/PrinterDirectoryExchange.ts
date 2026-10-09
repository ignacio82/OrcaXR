/**
 * The printer directory over the hosts' shared contract
 * (`PrinterDirectory.ts`): a stored directory read and written, and each
 * edit — add, update, remove, choose the default, adopt a legacy endpoint —
 * answered as the directory it makes or why it is refused. Every answer comes
 * from the production functions over an in-memory store; the Rust core
 * answers the same requests (`orcaxr_printer::directory`).
 */
import type {
  ProjectPrinterDirectoryAddWire,
  ProjectPrinterDirectoryAdoptWire,
  ProjectPrinterDirectoryReplyWire,
  ProjectPrinterDirectorySelectWire,
  ProjectPrinterDirectoryUpdateWire,
  ProjectPrinterDirectoryWire,
} from '../../../contracts/generated/project-intents';
import type { KeyValueStorage } from '../settings/Preferences';
import {
  PrinterDirectoryError,
  addPrinter,
  adoptLegacyEndpoint,
  loadPrinterDirectory,
  removePrinter,
  savePrinterDirectory,
  setDefaultPrinter,
  updatePrinter,
  type PrinterDirectory,
  type PrinterEntry,
} from './PrinterDirectory';
import { fromUnits, units } from './PrinterWire';

const absent = { absent: {} } as const;
const STORAGE_KEY = 'orcaxr.printers';
const camel = (code: string): string => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function store(stored: string | null): KeyValueStorage & { stored: string | null } {
  const state = {
    stored,
    getItem: (key: string) => (key === STORAGE_KEY ? state.stored : null),
    setItem: (key: string, value: string) => {
      if (key === STORAGE_KEY) state.stored = value;
    },
    removeItem: () => undefined,
  };
  return state;
}

export function directoryWire(directory: PrinterDirectory): ProjectPrinterDirectoryWire {
  return {
    printers: directory.printers.map((entry) => ({
      id: units(entry.id),
      name: units(entry.name),
      host: units(entry.host),
      port: entry.port,
      capabilities: entry.capabilities === undefined ? absent : { value: entry.capabilities.map(units) },
      toolCount: entry.toolCount === undefined ? absent : { value: entry.toolCount },
    })),
    defaultId: units(directory.defaultId),
  };
}

function directoryFromWire(directory: ProjectPrinterDirectoryWire): PrinterDirectory {
  return {
    printers: directory.printers.map((entry): PrinterEntry => ({
      id: fromUnits(entry.id),
      name: fromUnits(entry.name),
      host: fromUnits(entry.host),
      port: entry.port,
      ...('value' in entry.capabilities ? { capabilities: entry.capabilities.value.map(fromUnits) } : {}),
      ...('value' in entry.toolCount ? { toolCount: entry.toolCount.value } : {}),
    })),
    defaultId: fromUnits(directory.defaultId),
  };
}

function answer(edit: () => PrinterDirectory): ProjectPrinterDirectoryReplyWire {
  try {
    return { directory: directoryWire(edit()) };
  } catch (error) {
    if (error instanceof PrinterDirectoryError) {
      return {
        refused: {
          code: camel(error.code) as 'duplicate',
          message: units(error.message),
        },
      };
    }
    throw error;
  }
}

/** The directory stored text reads as (none: nothing stored). */
export function answerDirectoryLoad(stored: string | null): ProjectPrinterDirectoryWire {
  return directoryWire(loadPrinterDirectory(store(stored)));
}

/** The text a directory is stored as. */
export function answerDirectorySave(directory: ProjectPrinterDirectoryWire): string {
  const target = store(null);
  savePrinterDirectory(directoryFromWire(directory), target);
  if (target.stored === null) throw new Error('Nothing was stored');
  return target.stored;
}

export function answerDirectoryAdd(request: ProjectPrinterDirectoryAddWire): ProjectPrinterDirectoryReplyWire {
  return answer(() =>
    addPrinter(
      directoryFromWire(request.directory),
      {
        name: fromUnits(request.name),
        host: fromUnits(request.host),
        ...('value' in request.port ? { port: request.port.value } : {}),
      },
      () => fromUnits(request.id),
    ),
  );
}

export function answerDirectoryUpdate(request: ProjectPrinterDirectoryUpdateWire): ProjectPrinterDirectoryReplyWire {
  return answer(() =>
    updatePrinter(directoryFromWire(request.directory), fromUnits(request.id), {
      ...('value' in request.name ? { name: fromUnits(request.name.value) } : {}),
      ...('value' in request.host ? { host: fromUnits(request.host.value) } : {}),
      ...('value' in request.port ? { port: request.port.value } : {}),
      ...('value' in request.capabilities ? { capabilities: request.capabilities.value.map(fromUnits) } : {}),
      ...('value' in request.toolCount ? { toolCount: request.toolCount.value } : {}),
    }),
  );
}

export function answerDirectoryRemove(request: ProjectPrinterDirectorySelectWire): ProjectPrinterDirectoryReplyWire {
  return answer(() => removePrinter(directoryFromWire(request.directory), fromUnits(request.id)));
}

export function answerDirectorySetDefault(
  request: ProjectPrinterDirectorySelectWire,
): ProjectPrinterDirectoryReplyWire {
  return answer(() => setDefaultPrinter(directoryFromWire(request.directory), fromUnits(request.id)));
}

export function answerDirectoryAdopt(request: ProjectPrinterDirectoryAdoptWire): ProjectPrinterDirectoryWire {
  const legacy =
    'value' in request.legacy
      ? { host: fromUnits(request.legacy.value.host), port: request.legacy.value.port }
      : undefined;
  return directoryWire(adoptLegacyEndpoint(directoryFromWire(request.directory), legacy, () => fromUnits(request.id)));
}
