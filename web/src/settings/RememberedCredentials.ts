/**
 * Device-local credentials for the printer and the external slicer.
 *
 * Everything else in this app deliberately keeps secrets in session memory,
 * where a later script cannot read them back. These two are the exception, and
 * it is a deliberate one: a printer API key and a slicer token are entered to
 * reach hardware on the operator's own network, and re-typing both on every
 * reload made the app unusable as a daily tool. The operator asked for them to
 * be remembered, so they are — on this device, under an explicit switch they
 * can turn off, with a one-click way to forget them.
 *
 * What that costs, stated rather than buried: anything that can run script on
 * this origin can read them. The app ships a CSP that forbids remote script and
 * inlines nothing, which is what makes the trade defensible; it is not a claim
 * that storage is private.
 *
 * Diagnostics redaction is untouched — a remembered secret is still stripped
 * from every log and error path it could otherwise reach.
 */

const STORAGE_KEY = 'orcaxr.credentials';
const MAX_SECRET_LENGTH = 4096;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RememberedCredentials {
  /**
   * Moonraker API key for the single legacy endpoint.
   *
   * Kept for installs written before printers were named; it is adopted into
   * `printerApiKeys` under the first printer's id and then stays empty.
   */
  readonly printerApiKey: string;
  /**
   * Per-printer API keys, keyed by printer id.
   *
   * Separate entries rather than one shared key, because a credential that
   * follows a printer switch is a credential sent to the wrong machine.
   */
  readonly printerApiKeys: Readonly<Record<string, string>>;
  /** Bearer token for the configured external slicer. */
  readonly slicerToken: string;
  /**
   * Whether secrets are written to this device at all.
   *
   * Off keeps this session working while storing nothing, which is what a
   * shared or public machine needs.
   */
  readonly remember: boolean;
}

export const NO_REMEMBERED_CREDENTIALS: RememberedCredentials = Object.freeze({
  printerApiKey: '',
  printerApiKeys: Object.freeze({}),
  slicerToken: '',
  remember: true,
});

export function loadRememberedCredentials(storage: KeyValueStorage | null = browserStorage()): RememberedCredentials {
  if (!storage) return NO_REMEMBERED_CREDENTIALS;
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(value)) return NO_REMEMBERED_CREDENTIALS;
    return Object.freeze({
      printerApiKey: readSecret(value.printerApiKey),
      printerApiKeys: readSecretMap(value.printerApiKeys),
      slicerToken: readSecret(value.slicerToken),
      // Absent means an older store written before the switch existed; those
      // were only ever written by an operator who wanted them kept.
      remember: value.remember !== false,
    });
  } catch {
    return NO_REMEMBERED_CREDENTIALS;
  }
}

/**
 * Persist the secrets, or erase them when remembering is off.
 *
 * Turning the switch off does not merely stop future writes — it removes what
 * is already stored, because leaving a secret behind after being told to stop
 * remembering it would be the opposite of what was asked.
 */
export function saveRememberedCredentials(
  credentials: RememberedCredentials,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const printerApiKey = readSecret(credentials.printerApiKey);
  const printerApiKeys = readSecretMap(credentials.printerApiKeys);
  const slicerToken = readSecret(credentials.slicerToken);
  try {
    if (!credentials.remember) {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ printerApiKey: '', printerApiKeys: {}, slicerToken: '', remember: false }),
      );
      return;
    }
    if (!printerApiKey && !slicerToken && Object.keys(printerApiKeys).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ printerApiKey, printerApiKeys, slicerToken, remember: true }));
  } catch {
    // A blocked or full storage area simply means nothing is remembered; the
    // session still works with whatever the operator typed.
  }
}

/** Forget every stored secret on this device. */
export function forgetRememberedCredentials(storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing further to do; the caller clears the in-memory copies too.
  }
}

/** Per-printer keys, bounded so a corrupt store cannot grow without limit. */
function readSecretMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    const secret = readSecret(entry);
    if (secret) map[key.slice(0, 64)] = secret;
  }
  return Object.freeze(map);
}

function readSecret(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // Anything longer than this is not a key anyone issued; refuse to grow the
  // store rather than persist an accidental paste of a whole file.
  return trimmed.length > MAX_SECRET_LENGTH ? '' : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
