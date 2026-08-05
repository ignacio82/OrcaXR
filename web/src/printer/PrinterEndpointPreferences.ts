const STORAGE_KEY = 'orcaxr.printer';
const DEFAULT_PORT = 7125;

export interface PrinterEndpointPreferences {
  host: string;
  port: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Persist only a non-secret endpoint. Credentials always belong to the session store. */
export function loadPrinterEndpointPreferences(
  storage: KeyValueStorage | null = browserStorage(),
): PrinterEndpointPreferences {
  if (!storage) return { host: '', port: DEFAULT_PORT };
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    const preferences = isRecord(value)
      ? {
          host: typeof value.host === 'string' ? value.host.trim().slice(0, 2048) : '',
          port: validPort(value.port) ? value.port : DEFAULT_PORT,
        }
      : { host: '', port: DEFAULT_PORT };
    rewriteSanitized(storage, preferences);
    return preferences;
  } catch {
    const preferences = { host: '', port: DEFAULT_PORT };
    rewriteSanitized(storage, preferences);
    return preferences;
  }
}

export function savePrinterEndpointPreferences(
  preferences: PrinterEndpointPreferences,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const host = preferences.host.trim();
  if (host.length > 2048) throw new Error('Printer endpoint is too long');
  if (!validPort(preferences.port)) throw new Error('Printer port is invalid');
  storage.setItem(STORAGE_KEY, JSON.stringify({ host, port: preferences.port }));
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function rewriteSanitized(storage: KeyValueStorage, preferences: PrinterEndpointPreferences): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A blocked/quota-limited storage area still cannot make credentials durable here.
  }
}
