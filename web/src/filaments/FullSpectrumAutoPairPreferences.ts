import type { FullSpectrumAutoPairGenerationPreferences } from '../project/filaments/autoPairReconciliation';

export const FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY = 'orcaxr.full-spectrum.auto-pairs';

export interface FullSpectrumAutoPairPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Load the explicit app preference; absent, malformed, and future values fail closed. */
export function loadFullSpectrumAutoPairPreferences(
  storage: FullSpectrumAutoPairPreferenceStorage | null = browserStorage(),
): FullSpectrumAutoPairGenerationPreferences {
  if (!storage) return Object.freeze({ enabled: false });
  let enabled: boolean;
  try {
    const parsed = JSON.parse(storage.getItem(FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY) ?? 'null') as unknown;
    enabled = isRecord(parsed) && parsed.enabled === true;
  } catch {
    enabled = false;
  }
  const preferences = Object.freeze({ enabled });
  rewriteSanitized(storage, preferences);
  return preferences;
}

/** Persist only the reviewed boolean opt-in used by the pinned desktop preference. */
export function saveFullSpectrumAutoPairPreferences(
  preferences: FullSpectrumAutoPairGenerationPreferences,
  storage: FullSpectrumAutoPairPreferenceStorage | null = browserStorage(),
): void {
  if (preferences.enabled !== true && preferences.enabled !== false) {
    throw new Error('Automatic FullSpectrum pair preference must be boolean');
  }
  if (!storage) return;
  storage.setItem(FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY, JSON.stringify({ enabled: preferences.enabled }));
}

function browserStorage(): FullSpectrumAutoPairPreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rewriteSanitized(
  storage: FullSpectrumAutoPairPreferenceStorage,
  preferences: FullSpectrumAutoPairGenerationPreferences,
): void {
  try {
    storage.setItem(FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A blocked or quota-limited preference store leaves the fail-closed in-memory value intact.
  }
}
