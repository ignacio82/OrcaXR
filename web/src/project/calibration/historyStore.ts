/**
 * Persistence for the calibration ledger (parity P8.5).
 *
 * Kept apart from `history.ts` for the same reason `PresetLibraryStore` is kept
 * apart from `PresetLibrary`: the rules stay testable without a browser, and a
 * storage failure — private mode, a full quota — degrades to an in-memory
 * ledger instead of losing the session's measurements.
 *
 * The stored form is the export form, so a device's ledger and a shared file
 * are the same bytes and the secret scan applies to both.
 */

import {
  CALIBRATION_HISTORY_FORMAT,
  CALIBRATION_HISTORY_SCHEMA_VERSION,
  CalibrationHistory,
  exportCalibrationHistory,
  importCalibrationHistory,
  type CalibrationHistoryIssue,
} from './history';

export const CALIBRATION_HISTORY_STORAGE_KEY = 'orcaxr.calibration-history';

export interface CalibrationHistoryKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class CalibrationHistoryStore {
  readonly history: CalibrationHistory;
  readonly loadIssues: readonly CalibrationHistoryIssue[];

  constructor(
    private readonly storage: CalibrationHistoryKeyValueStorage | undefined,
    private readonly key: string = CALIBRATION_HISTORY_STORAGE_KEY,
  ) {
    const raw = safeRead(storage, key);
    if (raw === null) {
      this.history = new CalibrationHistory();
      this.loadIssues = Object.freeze([]);
      return;
    }
    const imported = importCalibrationHistory(raw);
    this.history = new CalibrationHistory(imported.records ?? []);
    this.loadIssues = imported.issues;
  }

  /** Persist the ledger. Returns false when storage refused, or refused to be shared. */
  save(nowIso = new Date().toISOString()): boolean {
    if (!this.storage) return false;
    const exported = exportCalibrationHistory(this.history.list(), nowIso);
    if (!exported.text) return false;
    try {
      this.storage.setItem(this.key, exported.text);
      return true;
    } catch {
      return false;
    }
  }

  clear(): boolean {
    this.history.clear();
    if (!this.storage) return false;
    try {
      this.storage.removeItem(this.key);
      return true;
    } catch {
      return false;
    }
  }

  /** The empty payload, for a caller that wants to seed storage deterministically. */
  static emptyPayload(nowIso: string): string {
    return JSON.stringify({
      format: CALIBRATION_HISTORY_FORMAT,
      schemaVersion: CALIBRATION_HISTORY_SCHEMA_VERSION,
      exportedAt: nowIso,
      records: [],
    });
  }
}

function safeRead(storage: CalibrationHistoryKeyValueStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
