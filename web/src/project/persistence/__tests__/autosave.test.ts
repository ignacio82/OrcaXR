import assert from 'node:assert/strict';

import {
  AutosaveQuotaError,
  AutosaveStore,
  autosaveDigest,
  type AutosaveSnapshot,
  type AutosaveStorage,
} from '../autosave';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class MemoryStorage implements AutosaveStorage {
  readonly snapshots = new Map<number, AutosaveSnapshot>();
  /** Bytes the fake store can hold, so quota handling is exercised exactly. */
  capacityBytes = Number.POSITIVE_INFINITY;
  writes = 0;

  async list(): Promise<readonly AutosaveSnapshot[]> {
    return [...this.snapshots.values()];
  }

  async put(snapshot: AutosaveSnapshot): Promise<void> {
    this.writes += 1;
    const used = [...this.snapshots.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    if (used + snapshot.bytes.byteLength > this.capacityBytes) {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.snapshots.set(snapshot.sequence, snapshot);
  }

  async remove(sequence: number): Promise<void> {
    this.snapshots.delete(sequence);
  }

  async clear(): Promise<void> {
    this.snapshots.clear();
  }
}

function payload(size: number, fill = 7): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function createStore(storage = new MemoryStorage(), maxSnapshots = 3) {
  let tick = 0;
  const store = new AutosaveStore({
    storage,
    maxSnapshots,
    now: () => new Date(Date.UTC(2026, 7, 8, 0, 0, (tick += 1))).toISOString(),
  });
  return { store, storage };
}

await test('captures a snapshot per real change and skips unchanged state', async () => {
  const { store, storage } = createStore();
  const first = await store.capture({
    projectName: 'Bracket',
    projectRevision: 4,
    projectHash: 'hash-a',
    bytes: payload(64),
  });
  assert.ok(first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.digest, autosaveDigest(payload(64)));

  const unchanged = await store.capture({
    projectName: 'Bracket',
    projectRevision: 4,
    projectHash: 'hash-a',
    bytes: payload(64),
  });
  assert.equal(unchanged, undefined, 'an unchanged project never rewrites its snapshot');
  assert.equal(storage.snapshots.size, 1);
});

await test('retains a bounded ring of the newest snapshots', async () => {
  const { store, storage } = createStore(new MemoryStorage(), 2);
  for (const hash of ['a', 'b', 'c', 'd']) {
    await store.capture({ projectName: 'Ring', projectRevision: 1, projectHash: hash, bytes: payload(32) });
  }
  const kept = [...storage.snapshots.values()].map((snapshot) => snapshot.sequence).sort((l, r) => l - r);
  assert.deepEqual(kept, [3, 4], 'only the newest two snapshots survive');
});

await test('prunes and retries when the store is full, then fails explicitly', async () => {
  const storage = new MemoryStorage();
  storage.capacityBytes = 2048;
  const { store } = createStore(storage, 5);
  await store.capture({ projectName: 'Full', projectRevision: 1, projectHash: 'a', bytes: payload(1024) });
  await store.capture({ projectName: 'Full', projectRevision: 2, projectHash: 'b', bytes: payload(1024) });
  const third = await store.capture({
    projectName: 'Full',
    projectRevision: 3,
    projectHash: 'c',
    bytes: payload(1024),
  });
  assert.ok(third, 'a full store prunes the oldest snapshot and retries');
  assert.equal(storage.snapshots.size, 2);

  storage.capacityBytes = 512;
  await assert.rejects(
    () => store.capture({ projectName: 'Full', projectRevision: 4, projectHash: 'd', bytes: payload(1024) }),
    (error: unknown) => error instanceof AutosaveQuotaError && error.code === 'storage-full',
  );
});

await test('rejects a payload above the configured limit before writing', async () => {
  const storage = new MemoryStorage();
  const store = new AutosaveStore({ storage, maxSnapshotBytes: 128 });
  await assert.rejects(
    () => store.capture({ projectName: 'Big', projectRevision: 1, projectHash: 'a', bytes: payload(256) }),
    (error: unknown) => error instanceof AutosaveQuotaError && error.code === 'snapshot-too-large',
  );
  assert.equal(storage.writes, 0, 'an oversized payload never reaches storage');
});

await test('offers the newest valid snapshot for explicit recovery', async () => {
  const { store, storage } = createStore();
  await store.capture({ projectName: 'Recover', projectRevision: 1, projectHash: 'a', bytes: payload(48, 1) });
  await store.capture({ projectName: 'Recover', projectRevision: 2, projectHash: 'b', bytes: payload(48, 2) });
  const state = await store.inspectRecovery();
  assert.equal(state.status, 'available');
  if (state.status !== 'available') return;
  assert.equal(state.snapshot.projectRevision, 2);
  assert.equal(state.snapshot.bytes[0], 2);
  assert.equal(storage.snapshots.size, 2, 'inspection never consumes a good snapshot');
});

await test('reports corruption and falls back to an older good snapshot', async () => {
  const { store, storage } = createStore();
  await store.capture({ projectName: 'Corrupt', projectRevision: 1, projectHash: 'a', bytes: payload(48, 1) });
  await store.capture({ projectName: 'Corrupt', projectRevision: 2, projectHash: 'b', bytes: payload(48, 2) });
  const newest = storage.snapshots.get(2) as AutosaveSnapshot;
  storage.snapshots.set(2, { ...newest, bytes: payload(48, 9) });

  const state = await store.inspectRecovery();
  assert.equal(state.status, 'available');
  if (state.status !== 'available') return;
  assert.equal(state.snapshot.sequence, 1, 'the corrupted newest record is skipped');
  assert.equal(storage.snapshots.has(2), false, 'the corrupted record is removed');
});

await test('reports a corrupt-only store instead of pretending it is empty', async () => {
  const { store, storage } = createStore();
  await store.capture({ projectName: 'Only', projectRevision: 1, projectHash: 'a', bytes: payload(48) });
  const only = storage.snapshots.get(1) as AutosaveSnapshot;
  storage.snapshots.set(1, { ...only, schemaVersion: 99 as never });
  const state = await store.inspectRecovery();
  assert.equal(state.status, 'corrupt');
  if (state.status !== 'corrupt') return;
  assert.match(state.reason, /schema/i);
  assert.equal((await store.inspectRecovery()).status, 'none', 'the unusable record is cleared');
});

await test('discard clears the store and re-arms capture', async () => {
  const { store, storage } = createStore();
  await store.capture({ projectName: 'Discard', projectRevision: 1, projectHash: 'a', bytes: payload(16) });
  await store.discard();
  assert.equal(storage.snapshots.size, 0);
  assert.equal((await store.inspectRecovery()).status, 'none');
  const again = await store.capture({
    projectName: 'Discard',
    projectRevision: 1,
    projectHash: 'a',
    bytes: payload(16),
  });
  assert.ok(again, 'the same project can be captured again after a discard');
});

await test('markCaptured suppresses a redundant write after save or open', async () => {
  const { store, storage } = createStore();
  store.markCaptured('hash-open');
  const skipped = await store.capture({
    projectName: 'Opened',
    projectRevision: 9,
    projectHash: 'hash-open',
    bytes: payload(16),
  });
  assert.equal(skipped, undefined);
  assert.equal(storage.snapshots.size, 0);
});

console.log(`\nAutosave store: ${passed} tests passed.`);
