/**
 * Application preferences (P6.6) — versioned, migrated, resettable.
 *
 * These are the settings that belong to *this browser*, not to a project: how
 * to reach the printer and the slicer, and how the app should behave. They are
 * deliberately separate from slice settings, which live in the project and
 * travel with it; a preference must never end up in an exported 3MF, and
 * resetting preferences must never touch a project or a preset.
 *
 * The store is versioned so a change of shape is a migration rather than a
 * silent loss, and migration is not hypothetical here: the slicer route was
 * originally written under unnamespaced keys (`external_slicer_url`,
 * `external_slicer_enabled`) that collide with anything else on the origin, and
 * v2 moves them under `orcaxr.`. An old install is migrated on first read.
 *
 * Secrets are not part of this. `RememberedCredentials` owns those, with its
 * own switch, so exporting preferences to share a setup cannot leak a token.
 */

export const PREFERENCES_SCHEMA_VERSION = 2;

const STORAGE_KEY = 'orcaxr.preferences';
/** Pre-v2 keys, unnamespaced and therefore collision-prone. */
const LEGACY_SLICER_URL_KEY = 'external_slicer_url';
const LEGACY_SLICER_ENABLED_KEY = 'external_slicer_enabled';

export const SLICER_URL_KEY = 'orcaxr.slicer.url';
export const SLICER_ENABLED_KEY = 'orcaxr.slicer.enabled';

/** Every key this app owns that is a preference rather than project data. */
/**
 * The language the operator chose (P10.4).
 *
 * A preference, not project data: it says how this browser shows the app, and
 * a reset should return it to "follow the browser" along with everything else.
 * Stored so a stored choice is never overruled by re-reading
 * `navigator.languages` on the next load — someone who picked English on a
 * German machine picked it deliberately.
 */
export const LANGUAGE_KEY = 'orcaxr.language';

export const PREFERENCE_KEYS: readonly string[] = Object.freeze([
  STORAGE_KEY,
  SLICER_URL_KEY,
  SLICER_ENABLED_KEY,
  LANGUAGE_KEY,
  'orcaxr.printer',
  'orcaxr.credentials',
]);

/** Keys that hold work, not settings. Reset must leave every one of these alone. */
export const PROJECT_DATA_KEYS: readonly string[] = Object.freeze([
  'orcaxr.profiles',
  'orcaxr.full-spectrum.auto-pairs',
  'orcaxrProjectEntity',
]);

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Whether the app should suppress motion beyond what the OS already asks for. */
export type ReduceMotionPreference = 'system' | 'always';

export interface AppPreferences {
  readonly schemaVersion: number;
  /**
   * `system` defers to `prefers-reduced-motion`, which the stylesheet already
   * honours. `always` is an override for someone whose OS setting does not
   * match how they want this app to behave.
   */
  readonly reduceMotion: ReduceMotionPreference;
}

export const DEFAULT_PREFERENCES: AppPreferences = Object.freeze({
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  reduceMotion: 'system',
});

export function loadPreferences(storage: KeyValueStorage | null = browserStorage()): AppPreferences {
  if (!storage) return DEFAULT_PREFERENCES;
  migrateLegacyKeys(storage);
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(value)) return DEFAULT_PREFERENCES;
    return Object.freeze({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      reduceMotion: value.reduceMotion === 'always' ? 'always' : 'system',
    });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: AppPreferences, storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: PREFERENCES_SCHEMA_VERSION,
        reduceMotion: preferences.reduceMotion === 'always' ? 'always' : 'system',
      }),
    );
  } catch {
    // A blocked or full storage area leaves the session working on defaults.
  }
}

/**
 * Move pre-v2 settings under the `orcaxr.` namespace.
 *
 * Runs on every read and is idempotent: it only acts when a legacy key exists
 * and its replacement does not, so a value the operator changed after
 * migrating is never overwritten by the stale original.
 */
export function migrateLegacyKeys(storage: KeyValueStorage): void {
  try {
    for (const [legacy, current] of [
      [LEGACY_SLICER_URL_KEY, SLICER_URL_KEY],
      [LEGACY_SLICER_ENABLED_KEY, SLICER_ENABLED_KEY],
    ]) {
      const value = storage.getItem(legacy);
      if (value === null) continue;
      if (storage.getItem(current) === null) storage.setItem(current, value);
      storage.removeItem(legacy);
    }
  } catch {
    // Migration is best-effort; a blocked store simply keeps its old keys.
  }
}

/** A versioned, secret-free snapshot of this device's setup. */
export interface PreferencesExport {
  readonly format: 'orcaxr.preferences';
  readonly schemaVersion: number;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Export every preference except the secrets.
 *
 * The point of an export is to move a setup between machines or attach it to a
 * bug report, and a token in either is a leak the operator did not intend.
 */
export function exportPreferences(storage: KeyValueStorage | null = browserStorage()): PreferencesExport {
  const values: Record<string, string> = {};
  if (storage) {
    migrateLegacyKeys(storage);
    for (const key of PREFERENCE_KEYS) {
      if (key === 'orcaxr.credentials') continue;
      const value = storage.getItem(key);
      if (value !== null) values[key] = value;
    }
  }
  return Object.freeze({
    format: 'orcaxr.preferences',
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    values: Object.freeze(values),
  });
}

export interface PreferencesImportResult {
  readonly applied: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Apply an exported snapshot, refusing anything it does not recognise.
 *
 * A key outside the preference set is reported rather than written: an import
 * is a file from somewhere else, and it must not be able to reach project
 * data, credentials, or an arbitrary key on this origin.
 */
export function importPreferences(
  candidate: unknown,
  storage: KeyValueStorage | null = browserStorage(),
): PreferencesImportResult {
  const warnings: string[] = [];
  const applied: string[] = [];
  if (!isRecord(candidate) || candidate.format !== 'orcaxr.preferences') {
    return { applied: [], warnings: ['That file is not an OrcaXR preferences export.'] };
  }
  const version = candidate.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { applied: [], warnings: ['That preferences export declares no usable schema version.'] };
  }
  if (version > PREFERENCES_SCHEMA_VERSION) {
    return {
      applied: [],
      warnings: [
        `That export is version ${version}; this build understands up to ${PREFERENCES_SCHEMA_VERSION}. Update OrcaXR first.`,
      ],
    };
  }
  if (!isRecord(candidate.values)) {
    return { applied: [], warnings: ['That preferences export carries no values.'] };
  }
  if (!storage) return { applied: [], warnings: ['This browser has no storage to import into.'] };

  for (const [key, value] of Object.entries(candidate.values)) {
    if (typeof value !== 'string') {
      warnings.push(`Ignored ${key}: a preference value must be text.`);
      continue;
    }
    if (key === 'orcaxr.credentials') {
      warnings.push('Ignored a credentials entry: secrets are never imported from a file.');
      continue;
    }
    if (!PREFERENCE_KEYS.includes(key)) {
      warnings.push(`Ignored ${key}: not a preference this build recognises.`);
      continue;
    }
    try {
      storage.setItem(key, value);
      applied.push(key);
    } catch {
      warnings.push(`Could not store ${key}; this browser refused the write.`);
    }
  }
  // A pre-v2 export names the old keys, so migrate straight after applying it.
  migrateLegacyKeys(storage);
  return { applied: Object.freeze(applied), warnings: Object.freeze(warnings) };
}

/**
 * Clear every preference, leaving projects and presets untouched.
 *
 * That separation is the whole reason this list is explicit rather than a
 * prefix sweep: `orcaxr.profiles` shares the namespace and is the operator's
 * work, not a setting.
 */
export function resetPreferences(storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  for (const key of [...PREFERENCE_KEYS, LEGACY_SLICER_URL_KEY, LEGACY_SLICER_ENABLED_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing useful to do; the caller reports the outcome.
    }
  }
}

/**
 * Apply the preferences that have an observable effect right now.
 *
 * Deliberately narrow: a preference the app stores but never reads is worse
 * than one it does not offer, because it looks like it works.
 */
export function applyPreferences(preferences: AppPreferences, root: { dataset: DOMStringMap } | null): void {
  if (!root) return;
  if (preferences.reduceMotion === 'always') root.dataset.reduceMotion = 'always';
  else delete root.dataset.reduceMotion;
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
