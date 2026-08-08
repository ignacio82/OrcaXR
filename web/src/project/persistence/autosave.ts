import { fnv1a64 } from '../domain/canonical';

export const AUTOSAVE_SCHEMA_VERSION = 1;

export interface AutosaveSnapshot {
  readonly schemaVersion: typeof AUTOSAVE_SCHEMA_VERSION;
  /** Monotonic per-store key; the newest snapshot has the highest sequence. */
  readonly sequence: number;
  readonly savedAt: string;
  readonly projectName: string;
  readonly projectRevision: number;
  /** Canonical project hash at capture time, for stale/mismatch reporting. */
  readonly projectHash: string;
  /** Serialized project archive bytes (BBS-compatible 3MF). */
  readonly bytes: Uint8Array;
  /** FNV-1a64 of `bytes`, so a truncated or corrupted record is detectable. */
  readonly digest: string;
}

export type AutosaveRecoveryState =
  | { readonly status: 'none' }
  | { readonly status: 'available'; readonly snapshot: AutosaveSnapshot }
  | { readonly status: 'corrupt'; readonly sequence: number; readonly reason: string };

export interface AutosaveStorage {
  list(): Promise<readonly AutosaveSnapshot[]>;
  put(snapshot: AutosaveSnapshot): Promise<void>;
  remove(sequence: number): Promise<void>;
  clear(): Promise<void>;
}

export interface AutosaveStoreOptions {
  readonly storage: AutosaveStorage;
  /** Snapshots retained; the oldest is pruned first. Defaults to three. */
  readonly maxSnapshots?: number;
  /** Rejects a write whose payload is larger than this. */
  readonly maxSnapshotBytes?: number;
  readonly now?: () => string;
}

export class AutosaveQuotaError extends Error {
  constructor(
    message: string,
    readonly code: 'snapshot-too-large' | 'storage-full',
  ) {
    super(message);
    this.name = 'AutosaveQuotaError';
  }
}

export function autosaveDigest(bytes: Uint8Array): string {
  return `fnv1a64:${fnv1a64(bytes)}`;
}

/** Storage errors that mean "no space", across browsers and shims. */
export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014 ||
    error instanceof AutosaveQuotaError
  );
}

/**
 * Versioned autosave with explicit recovery.
 *
 * A snapshot is written only when the canonical project actually changed, the
 * newest snapshots are retained as a bounded ring, a full store prunes and
 * retries before failing, and a corrupted record is reported rather than
 * restored. Recovery is never automatic: the caller inspects the state and
 * decides, so a crashed session cannot silently overwrite a good project.
 */
export class AutosaveStore {
  private readonly maxSnapshots: number;
  private readonly maxSnapshotBytes: number;
  private readonly now: () => string;
  private lastCapturedHash?: string;

  constructor(private readonly options: AutosaveStoreOptions) {
    this.maxSnapshots = options.maxSnapshots ?? 3;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
    if (!Number.isInteger(this.maxSnapshots) || this.maxSnapshots < 1) {
      throw new Error('Autosave must retain at least one snapshot');
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Write a snapshot unless this exact project hash is already the newest. */
  async capture(input: {
    readonly projectName: string;
    readonly projectRevision: number;
    readonly projectHash: string;
    readonly bytes: Uint8Array;
  }): Promise<AutosaveSnapshot | undefined> {
    if (input.bytes.byteLength > this.maxSnapshotBytes) {
      throw new AutosaveQuotaError(
        `Autosave payload is ${input.bytes.byteLength} bytes, above the ${this.maxSnapshotBytes} byte limit`,
        'snapshot-too-large',
      );
    }
    if (this.lastCapturedHash === input.projectHash) return undefined;
    const existing = await this.options.storage.list();
    const sequence = existing.reduce((highest, snapshot) => Math.max(highest, snapshot.sequence), 0) + 1;
    const snapshot: AutosaveSnapshot = Object.freeze({
      schemaVersion: AUTOSAVE_SCHEMA_VERSION,
      sequence,
      savedAt: this.now(),
      projectName: input.projectName,
      projectRevision: input.projectRevision,
      projectHash: input.projectHash,
      bytes: input.bytes,
      digest: autosaveDigest(input.bytes),
    });

    const retained = [...existing].sort((left, right) => left.sequence - right.sequence);
    for (;;) {
      try {
        await this.options.storage.put(snapshot);
        break;
      } catch (error) {
        // A full store drops its oldest snapshot and retries before failing.
        if (!isQuotaError(error) || retained.length === 0) {
          if (isQuotaError(error)) {
            throw new AutosaveQuotaError('Autosave storage is full and could not be pruned', 'storage-full');
          }
          throw error;
        }
        const oldest = retained.shift();
        if (oldest) await this.options.storage.remove(oldest.sequence);
      }
    }

    for (const stale of retained.slice(0, Math.max(0, retained.length + 1 - this.maxSnapshots))) {
      await this.options.storage.remove(stale.sequence);
    }
    this.lastCapturedHash = input.projectHash;
    return snapshot;
  }

  /**
   * Newest usable snapshot, or an explicit corruption/version report. Records
   * that fail validation are removed so a broken write cannot block recovery
   * of an older good snapshot.
   */
  async inspectRecovery(): Promise<AutosaveRecoveryState> {
    const snapshots = [...(await this.options.storage.list())].sort((left, right) => right.sequence - left.sequence);
    let firstProblem: { sequence: number; reason: string } | undefined;
    for (const snapshot of snapshots) {
      const reason = validationProblem(snapshot);
      if (!reason) return { status: 'available', snapshot };
      firstProblem ??= { sequence: snapshot.sequence, reason };
      await this.options.storage.remove(snapshot.sequence);
    }
    if (firstProblem) return { status: 'corrupt', ...firstProblem };
    return { status: 'none' };
  }

  /** Forget every snapshot, e.g. after an explicit discard or a clean save. */
  async discard(): Promise<void> {
    await this.options.storage.clear();
    this.lastCapturedHash = undefined;
  }

  /** Treat the current project as already captured (after save/open). */
  markCaptured(projectHash: string): void {
    this.lastCapturedHash = projectHash;
  }
}

function validationProblem(snapshot: AutosaveSnapshot): string | undefined {
  if (snapshot?.schemaVersion !== AUTOSAVE_SCHEMA_VERSION) {
    return `unsupported autosave schema ${String(snapshot?.schemaVersion)}`;
  }
  if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 1) return 'invalid sequence';
  if (!(snapshot.bytes instanceof Uint8Array) || snapshot.bytes.byteLength === 0) return 'empty payload';
  if (autosaveDigest(snapshot.bytes) !== snapshot.digest) return 'payload does not match its digest';
  if (typeof snapshot.savedAt !== 'string' || Number.isNaN(Date.parse(snapshot.savedAt))) return 'invalid timestamp';
  return undefined;
}
