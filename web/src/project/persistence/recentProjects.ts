/**
 * Recent project entries and storage (P11.1).
 *
 * Persists a bounded list of recently opened or saved projects with storage
 * origin, timestamp, model/plate counts, and optional preview thumbnails.
 * Storage errors degrade gracefully to an in-memory session list so headless
 * runs and private browsing modes never crash on recent-project operations.
 */

export interface RecentProjectEntry {
  readonly id: string;
  readonly name: string;
  readonly openedAt: string;
  readonly sizeBytes?: number;
  readonly plateCount?: number;
  readonly modelCount?: number;
  readonly thumbnailDataUrl?: string;
  readonly storageOrigin: 'local-file' | 'imported-archive' | 'session-autosave' | 'example-project';
  readonly projectHash?: string;
}

export interface RecentProjectsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const RECENT_PROJECTS_STORAGE_KEY = 'orcaxr:recent-projects:v1';
export const MAX_RECENT_PROJECTS = 10;

class MemoryRecentStorage implements RecentProjectsStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function defaultStorage(): RecentProjectsStorage {
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) {
      // Probe availability in case of private mode or restricted iframe
      const probeKey = '__orcaxr_recent_probe__';
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
      return localStorage;
    }
  } catch {
    // Fall back to in-memory storage on quota / security errors
  }
  return new MemoryRecentStorage();
}

export class RecentProjectsStore {
  private readonly storage: RecentProjectsStorage;
  private readonly maxEntries: number;

  constructor(storage?: RecentProjectsStorage, maxEntries = MAX_RECENT_PROJECTS) {
    this.storage = storage ?? defaultStorage();
    this.maxEntries = maxEntries;
  }

  list(): readonly RecentProjectEntry[] {
    try {
      const raw = this.storage.getItem(RECENT_PROJECTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidRecentProjectEntry);
    } catch {
      return [];
    }
  }

  add(entry: Omit<RecentProjectEntry, 'id' | 'openedAt'> & { id?: string; openedAt?: string }): RecentProjectEntry {
    const fullEntry: RecentProjectEntry = Object.freeze({
      ...entry,
      id: entry.id || `recent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      openedAt: entry.openedAt || new Date().toISOString(),
    });

    const current = this.list().filter((item) => item.name !== fullEntry.name && item.id !== fullEntry.id);
    const updated = [fullEntry, ...current].slice(0, this.maxEntries);
    try {
      this.storage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Non-fatal if storage quota is exceeded
    }
    return fullEntry;
  }

  remove(id: string): void {
    const updated = this.list().filter((item) => item.id !== id);
    try {
      this.storage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Non-fatal
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(RECENT_PROJECTS_STORAGE_KEY);
    } catch {
      // Non-fatal
    }
  }
}

function isValidRecentProjectEntry(value: unknown): value is RecentProjectEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.openedAt === 'string' &&
    typeof entry.storageOrigin === 'string'
  );
}

export const recentProjectsStore = new RecentProjectsStore();
