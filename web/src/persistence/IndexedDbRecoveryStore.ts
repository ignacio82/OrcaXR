import type { CancellationToken, ProjectExportGuard } from '../project/ports';
import { DEFAULT_ZIP_LIMITS } from '../project/serialization/deterministicZip';
import { Sha256SliceContentHasher } from '../project/slicing/hash';

export const RECOVERY_SCHEMA_VERSION = 1;
export const DEFAULT_RECOVERY_BUDGET_BYTES = 512 * 1024 * 1024;
export type RecoveryKey = readonly [projectId: string, sessionId: string, sequence: number];
export interface RecoveryMetadata {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly key: RecoveryKey;
  readonly guard: ProjectExportGuard;
  readonly projectName: string;
  readonly filename: string;
  readonly capturedAt: string;
  readonly byteLength: number;
  readonly digest: string;
}
export interface RecoveryWrite {
  readonly guard: ProjectExportGuard;
  readonly sessionId: string;
  readonly projectName: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** Computed by the serializer worker before opening a storage transaction. */
  readonly digest: string;
}
export interface RecoveryListing {
  readonly key: RecoveryKey;
  readonly metadata?: RecoveryMetadata;
  readonly problem?: string;
}
export interface RecoveryStoreOptions {
  readonly indexedDB?: IDBFactory;
  readonly name?: string;
  readonly budgetBytes?: number;
  readonly now?: () => string;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
}

/** Metadata and archives commit/prune together; writes never evict another editing session. */
export class IndexedDbRecoveryStore {
  private database?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private rejectOpening?: (error: Error) => void;
  private readonly transactions = new Set<IDBTransaction>();
  private disposed = false;
  private budget: number;
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  constructor(private readonly options: RecoveryStoreOptions = {}) {
    this.budget = checkedBudget(options.budgetBytes ?? DEFAULT_RECOVERY_BUDGET_BYTES);
    const hasher = new Sha256SliceContentHasher();
    this.digest = options.digest ?? ((bytes) => hasher.digest(bytes));
  }
  setBudget(bytes: number, availableQuota?: number): number {
    this.assertActive();
    this.budget = checkedBudget(availableQuota === undefined ? bytes : Math.min(bytes, availableQuota));
    return this.budget;
  }
  get budgetBytes(): number {
    return this.budget;
  }

  async write(input: RecoveryWrite, cancellation?: CancellationToken): Promise<RecoveryMetadata> {
    this.assertActive();
    validateInput(input);
    const capturedAt = this.options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('Invalid recovery timestamp');
    // Freeze/copy bounded metadata before the transaction. IndexedDB owns its
    // archive clone; never transfer or detach the serializer's original bytes.
    const guard = Object.freeze({ ...input.guard });
    const database = await this.open();
    this.assertActive();
    assertNotCancelled(cancellation);
    return this.transact(database, ['metadata', 'archives', 'sequences'], 'readwrite', (transaction, resolve, fail) => {
      const metadata = transaction.objectStore('metadata');
      const archives = transaction.objectStore('archives');
      const sequences = transaction.objectStore('sequences');
      const records = metadata.getAll();
      const recordKeys = metadata.getAllKeys();
      const sequence = sequences.get([guard.projectId, input.sessionId]);
      let entries: unknown[] | undefined;
      let keys: IDBValidKey[] | undefined;
      let next: number | undefined;
      const commit = () => {
        if (!entries || !keys || next === undefined) return;
        try {
          assertNotCancelled(cancellation);
          const sameLineage: RecoveryMetadata[] = [];
          let used = 0;
          for (const [index, entry] of entries.entries()) {
            const actualKey = keys[index];
            if (validKey(actualKey) && actualKey[0] === guard.projectId && actualKey[1] === input.sessionId) {
              next = Math.max(next, actualKey[2] + 1);
              if (!Number.isSafeInteger(next)) throw new Error('Recovery sequence is exhausted');
            }
            // Unknown versions stay intact. Their bounded byte length still
            // counts against capacity; unknowable usage refuses a new write.
            const size = (entry as { byteLength?: unknown })?.byteLength;
            if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
              throw new Error(
                'Recovery contains unknown storage metadata; download or discard it explicitly before adding snapshots.',
              );
            used += size;
            if (metadataProblem(entry) || JSON.stringify((entry as RecoveryMetadata).key) !== JSON.stringify(actualKey))
              continue;
            const record = entry as RecoveryMetadata;
            if (record.key[0] === guard.projectId && record.key[1] === input.sessionId) sameLineage.push(record);
          }
          if (!Number.isSafeInteger(used)) throw new Error('Recovery storage size exceeds its supported range');
          sameLineage.sort((a, b) => a.key[2] - b.key[2]);
          const pruned: RecoveryMetadata[] = [];
          while (sameLineage.length >= 3 || (used + input.bytes.byteLength > this.budget && sameLineage.length > 0)) {
            const oldest = sameLineage.shift()!;
            used -= oldest.byteLength;
            pruned.push(oldest);
          }
          if (used + input.bytes.byteLength > this.budget) {
            const error = new Error(
              'Recovery storage budget is full. Download or discard old recovery sessions, or increase the recovery budget.',
            );
            error.name = 'QuotaExceededError';
            throw error;
          }
          const key: RecoveryKey = [guard.projectId, input.sessionId, next];
          const record: RecoveryMetadata = {
            schemaVersion: RECOVERY_SCHEMA_VERSION,
            key,
            guard,
            projectName: input.projectName,
            filename: input.filename,
            capturedAt,
            byteLength: input.bytes.byteLength,
            digest: input.digest,
          };
          for (const old of pruned) {
            metadata.delete([...old.key]);
            archives.delete([...old.key]);
          }
          archives.put(input.bytes, [...key]);
          metadata.put(record, [...key]);
          sequences.put(next, [guard.projectId, input.sessionId]);
          resolve(record);
        } catch (error) {
          fail(error);
        }
      };
      records.onsuccess = () => {
        entries = records.result as unknown[];
        commit();
      };
      recordKeys.onsuccess = () => {
        keys = recordKeys.result;
        commit();
      };
      sequence.onsuccess = () => {
        const current: unknown = sequence.result;
        if (
          current !== undefined &&
          (typeof current !== 'number' ||
            !Number.isSafeInteger(current) ||
            current < 0 ||
            current >= Number.MAX_SAFE_INTEGER)
        ) {
          fail(new Error('Invalid recovery sequence'));
          return;
        }
        next = ((current as number | undefined) ?? 0) + 1;
        commit();
      };
    });
  }

  async list(): Promise<readonly RecoveryListing[]> {
    const database = await this.open();
    return this.transact(database, ['metadata'], 'readonly', (transaction, resolve) => {
      const rows: RecoveryListing[] = [];
      const cursor = transaction.objectStore('metadata').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) {
          resolve(rows);
          return;
        }
        const key: unknown = cursor.result.primaryKey;
        const value: unknown = cursor.result.value;
        if (validKey(key)) {
          const problem =
            metadataProblem(value) ||
            (JSON.stringify((value as RecoveryMetadata).key) !== JSON.stringify(key)
              ? 'Recovery key does not match its metadata'
              : undefined);
          rows.push(problem ? { key, problem } : { key, metadata: value as RecoveryMetadata });
        }
        cursor.result.continue();
      };
    });
  }

  /** Integrity verification precedes the separate validated project import/recovery pipeline. */
  async read(key: RecoveryKey): Promise<{ metadata: RecoveryMetadata; bytes: Uint8Array }> {
    const value = await this.readRaw(key);
    const problem = metadataProblem(value.metadata);
    if (problem) throw new Error(problem);
    const metadata = value.metadata as RecoveryMetadata;
    if (JSON.stringify(metadata.key) !== JSON.stringify(key))
      throw new Error('Recovery key does not match its metadata');
    if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== metadata.byteLength)
      throw new Error('Recovery archive is missing or truncated');
    if ((await this.digest(value.bytes)) !== metadata.digest)
      throw new Error('Recovery archive failed its integrity check');
    this.assertActive();
    return { metadata, bytes: value.bytes };
  }

  /** Explicit download can preserve a future-version archive without interpreting it. */
  async readForDownload(key: RecoveryKey): Promise<{ filename: string; bytes: Uint8Array }> {
    const value = await this.readRaw(key);
    if (
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength < 1 ||
      value.bytes.byteLength > DEFAULT_ZIP_LIMITS.maxArchiveBytes
    )
      throw new Error('Recovery archive is missing or exceeds the archive limit');
    const metadata = value.metadata as { filename?: unknown; digest?: unknown } | undefined;
    if (
      typeof metadata?.digest === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(metadata.digest) &&
      (await this.digest(value.bytes)) !== metadata.digest
    )
      throw new Error('Recovery archive failed its integrity check');
    this.assertActive();
    return {
      filename: typeof metadata?.filename === 'string' ? metadata.filename.slice(0, 255) : 'recovery.3mf',
      bytes: value.bytes,
    };
  }

  private async readRaw(key: RecoveryKey): Promise<{ metadata: unknown; bytes: unknown }> {
    if (!validKey(key)) throw new Error('Invalid recovery key');
    const database = await this.open();
    return this.transact<{ metadata: unknown; bytes: unknown }>(
      database,
      ['metadata', 'archives'],
      'readonly',
      (transaction, resolve) => {
        const metadata = transaction.objectStore('metadata').get([...key]);
        const bytes = transaction.objectStore('archives').get([...key]);
        bytes.onsuccess = () =>
          resolve({
            metadata: metadata.result as unknown,
            bytes: bytes.result as unknown,
          });
      },
    );
  }

  async discard(key: RecoveryKey): Promise<void> {
    if (!validKey(key)) throw new Error('Invalid recovery key');
    const database = await this.open();
    await this.transact<void>(database, ['metadata', 'archives'], 'readwrite', (transaction, resolve) => {
      transaction.objectStore('metadata').delete([...key]);
      transaction.objectStore('archives').delete([...key]);
      resolve();
    });
  }

  async discardSession(projectId: string, sessionId: string): Promise<void> {
    const database = await this.open();
    await this.transact<void>(database, ['metadata', 'archives'], 'readwrite', (transaction, resolve) => {
      const metadata = transaction.objectStore('metadata');
      const cursor = metadata.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) {
          resolve();
          return;
        }
        const key: unknown = entry.primaryKey;
        // A navigation discard only owns records of this supported lineage.
        if (validKey(key) && key[0] === projectId && key[1] === sessionId && !metadataProblem(entry.value)) {
          entry.delete();
          transaction.objectStore('archives').delete([...key]);
        }
        entry.continue();
      };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectOpening?.(new Error('Recovery storage is disposed'));
    for (const transaction of this.transactions) {
      try {
        transaction.abort();
      } catch {
        /* Already settled. */
      }
    }
    this.database?.close();
    this.database = undefined;
  }

  private async open(): Promise<IDBDatabase> {
    this.assertActive();
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let factory: IDBFactory | undefined;
      try {
        factory = this.options.indexedDB ?? globalThis.indexedDB;
      } catch {
        /* Storage access itself can throw. */
      }
      if (!factory) {
        reject(new Error('IndexedDB recovery storage is unavailable'));
        return;
      }
      const request = factory.open(this.options.name ?? 'orcaxr-project-recovery', 1);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rejectOpening = undefined;
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Recovery storage did not open in time')), 10_000);
      this.rejectOpening = fail;
      request.onupgradeneeded = () => {
        if (this.disposed || settled) {
          request.transaction?.abort();
          return;
        }
        for (const name of ['metadata', 'archives', 'sequences'])
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onerror = () => fail(request.error ?? new Error('Recovery storage could not open'));
      request.onblocked = () =>
        fail(new Error('Recovery storage is open in another application version. Close that tab and retry.'));
      request.onsuccess = () => {
        if (this.disposed || settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.rejectOpening = undefined;
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (this.database === database) this.database = undefined;
        };
        this.database = database;
        resolve(database);
      };
    }).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private transact<T>(
    database: IDBDatabase,
    stores: string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction, resolve: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    this.assertActive();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(stores, mode);
      this.transactions.add(transaction);
      let result: T;
      let failure: unknown;
      const finish = () => {
        clearTimeout(timer);
        this.transactions.delete(transaction);
      };
      const timer = setTimeout(() => fail(new Error('Recovery storage transaction timed out')), 10_000);
      const fail = (error: unknown) => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          finish();
          reject(error);
        }
      };
      transaction.oncomplete = () => {
        finish();
        if (this.disposed) reject(new Error('Recovery storage is disposed'));
        else resolve(result);
      };
      transaction.onabort = () => {
        finish();
        reject(failure ?? transaction.error ?? new Error('Recovery storage transaction aborted'));
      };
      transaction.onerror = () => {
        failure ??= transaction.error;
      };
      try {
        run(
          transaction,
          (value) => {
            result = value;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Recovery storage is disposed');
  }
}

function checkedBudget(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > DEFAULT_ZIP_LIMITS.maxArchiveBytes)
    throw new Error('Recovery budget must be positive and no larger than the archive limit');
  return bytes;
}
function validKey(value: unknown): value is RecoveryKey {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.slice(0, 2).every((part) => typeof part === 'string' && part.length > 0 && part.length <= 256) &&
    Number.isSafeInteger(value[2]) &&
    value[2] > 0
  );
}
function validGuard(value: unknown): value is ProjectExportGuard {
  if (!value || typeof value !== 'object') return false;
  const guard = value as ProjectExportGuard;
  return (
    typeof guard.projectId === 'string' &&
    guard.projectId.length > 0 &&
    guard.projectId.length <= 256 &&
    Number.isSafeInteger(guard.revision) &&
    guard.revision >= 0 &&
    /^fnv1a64:[0-9a-f]{16}$/.test(guard.semanticHash) &&
    /^fnv1a64:[0-9a-f]{16}$/.test(guard.assetFingerprint)
  );
}
function metadataProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'Recovery metadata is missing';
  const record = value as RecoveryMetadata;
  if (record.schemaVersion !== RECOVERY_SCHEMA_VERSION)
    return `Unsupported recovery schema ${String(record.schemaVersion)}; the record has been preserved`;
  if (!validKey(record.key) || !validGuard(record.guard) || record.key[0] !== record.guard.projectId)
    return 'Recovery identity is invalid';
  if (
    typeof record.projectName !== 'string' ||
    record.projectName.length > 512 ||
    typeof record.filename !== 'string' ||
    record.filename.length > 512 ||
    typeof record.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.capturedAt))
  )
    return 'Recovery description is invalid';
  if (
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1 ||
    record.byteLength > DEFAULT_ZIP_LIMITS.maxArchiveBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(record.digest)
  )
    return 'Recovery archive metadata is invalid';
  return undefined;
}
function validateInput(input: RecoveryWrite): void {
  const problem = metadataProblem({
    ...input,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    key: [input.guard?.projectId, input.sessionId, 1],
    capturedAt: new Date().toISOString(),
    byteLength: input.bytes?.byteLength,
  });
  if (problem || !(input.bytes instanceof Uint8Array)) throw new Error(problem ?? 'Recovery bytes are invalid');
}
function assertNotCancelled(cancellation?: CancellationToken): void {
  if (cancellation?.aborted) throw new Error(cancellation.reason ?? 'Recovery capture was cancelled');
}
