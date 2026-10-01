import assert from 'node:assert/strict';
import { ExternalSlicerConnectionController } from '../ExternalSlicerConnectionController';
import { SLICER_CONNECTION_KEY, SLICER_URL_KEY, SLICER_ENABLED_KEY } from '../../settings/Preferences';
import { PINNED_ENGINE_PROVENANCE } from '../pinnedEngineProvenance';
import type { EngineAttestation } from '../ExternalEngineAttestation';

const proof: EngineAttestation = { attested: true, commit: PINNED_ENGINE_PROVENANCE.commit };
const good = async () => proof;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture(initial: Record<string, string> = {}, timeout = 8_000) {
  const values = new Map(Object.entries(initial));
  let readFails = false,
    writeFails = false;
  const writes: [string, string][] = [];
  const storage = {
    getItem(key: string) {
      if (readFails) throw new Error('blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (writeFails) throw new Error('full');
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  const controller = new ExternalSlicerConnectionController(() => storage, timeout);
  return {
    controller,
    values,
    writes,
    storage,
    failReads: () => {
      readFails = true;
    },
    failWrites: () => {
      writeFails = true;
    },
  };
}
let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('pending discovery leaves the route and all persisted preferences untouched', async () => {
  const f = fixture();
  const delayed = deferred<EngineAttestation>();
  const pending = f.controller.discover('http://container.local:3000', () => delayed.promise);
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.controller.snapshot.endpoint, '');
  assert.equal(f.values.size, 0);
  assert.equal(f.writes.length, 0);
  delayed.resolve(proof);
  assert.equal((await pending).discovered, true);
  assert.equal(f.controller.snapshot.enabled, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], SLICER_CONNECTION_KEY);
  const record = JSON.parse(f.writes[0][1]);
  assert.equal(record.endpoint, 'http://container.local:3000');
  assert.equal(record.enabled, true);
  assert.deepEqual(record.attestation, { commit: PINNED_ENGINE_PROVENANCE.commit });
  f.controller.dispose();
});

for (const success of [true, false]) {
  await test(`late discovery ${success ? 'success' : 'failure'} cannot replace a manual connection`, async () => {
    const f = fixture();
    const delayed = deferred<EngineAttestation>();
    const discovery = f.controller.discover('http://container.local', () => delayed.promise);
    await f.controller.connect('http://chosen.local', good);
    delayed.resolve(success ? proof : { attested: false, reason: 'Offline' });
    assert.equal((await discovery).discovered, false);
    assert.equal(f.controller.snapshot.endpoint, 'http://chosen.local');
    assert.equal(f.controller.snapshot.enabled, true);
    f.controller.dispose();
  });
}
for (const action of ['disable', 'clear', 'invalidate', 'dispose'] as const) {
  await test(`${action} aborts discovery and rejects a late success`, async () => {
    const f = fixture();
    const delayed = deferred<EngineAttestation>();
    let signal: AbortSignal | undefined;
    const discovery = f.controller.discover('http://container.local', (_, s) => {
      signal = s;
      return delayed.promise;
    });
    await Promise.resolve();
    f.controller[action]();
    assert.equal(signal?.aborted, true);
    // The probe ignores abort, but the caller still settles promptly.
    assert.equal((await discovery).discovered, false);
    delayed.resolve(proof);
    await Promise.resolve();
    assert.equal(f.controller.snapshot.enabled, false);
    f.controller.dispose();
  });
}
await test('a saved disabled automatic route stays disabled after reload without a probe', async () => {
  const f = fixture();
  await f.controller.discover('http://container.local', good);
  f.controller.disable();
  const reloaded = new ExternalSlicerConnectionController(() => f.storage);
  let probes = 0;
  assert.equal(
    (
      await reloaded.discover('http://container.local', async () => {
        probes++;
        return proof;
      })
    ).discovered,
    false,
  );
  assert.equal(probes, 0);
  assert.equal(reloaded.snapshot.endpoint, 'http://container.local');
  assert.equal(reloaded.snapshot.enabled, false);
  reloaded.dispose();
  f.controller.dispose();
});
await test('forget stays local on reload even though a previously saved legacy route exists', async () => {
  const f = fixture({ [SLICER_URL_KEY]: 'http://old.local', [SLICER_ENABLED_KEY]: 'true' });
  f.controller.clear();
  const reloaded = new ExternalSlicerConnectionController(() => f.storage);
  assert.equal((await reloaded.discover('http://container.local', good)).discovered, false);
  assert.equal(reloaded.snapshot.endpoint, '');
  reloaded.dispose();
  f.controller.dispose();
});
await test('preference changes in another tab supersede discovery before its commit', async () => {
  const f = fixture();
  const delayed = deferred<EngineAttestation>();
  const discovery = f.controller.discover('http://container.local', () => delayed.promise);
  f.values.set(SLICER_URL_KEY, 'http://other-tab.local');
  f.values.set(SLICER_ENABLED_KEY, 'false');
  delayed.resolve(proof);
  assert.equal((await discovery).discovered, false);
  assert.equal(f.controller.snapshot.endpoint, 'http://other-tab.local');
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.writes.length, 0);
  f.controller.dispose();
});
await test('a preference reset invalidates pending work even when the stored bytes were already absent', async () => {
  const f = fixture();
  const delayed = deferred<EngineAttestation>();
  const pending = f.controller.discover('http://container.local', () => delayed.promise);
  f.controller.preferencesChanged(true);
  assert.equal((await pending).discovered, false);
  delayed.resolve(proof);
  assert.equal(f.controller.snapshot.enabled, false);
  f.controller.dispose();
});
await test('a failed replacement preserves the saved endpoint and never re-enables it', async () => {
  const f = fixture();
  await f.controller.connect('http://old.local', good);
  await assert.rejects(
    f.controller.connect('http://wrong.local', async () => ({ attested: false, reason: 'Different engine' })),
    /Different engine/,
  );
  assert.equal(f.controller.snapshot.endpoint, 'http://old.local');
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.controller.snapshot.attestation, null);
  f.controller.dispose();
});
await test('manual attempts are latest-wins and settle when superseded', async () => {
  const f = fixture();
  const delayed = deferred<EngineAttestation>();
  const old = f.controller.connect('http://first.local', () => delayed.promise);
  const rejected = assert.rejects(old, /superseded/);
  await f.controller.connect('http://second.local', good);
  await rejected;
  delayed.resolve(proof);
  assert.equal(f.controller.snapshot.endpoint, 'http://second.local');
  assert.equal(f.controller.snapshot.enabled, true);
  f.controller.dispose();
});
await test('a hung probe times out and never activates its eventual result', async () => {
  const f = fixture({}, 20);
  const delayed = deferred<EngineAttestation>();
  await assert.rejects(
    f.controller.connect('http://slow.local', () => delayed.promise),
    /timed out/,
  );
  delayed.resolve(proof);
  await Promise.resolve();
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.controller.snapshot.phase, 'failed');
  f.controller.dispose();
});
for (const mode of ['read', 'write', 'unavailable'] as const) {
  await test(`${mode} storage failure keeps an attested session operational and reports persistence loss`, async () => {
    const f = fixture();
    if (mode === 'read') f.failReads();
    if (mode === 'write') f.failWrites();
    const controller = mode === 'unavailable' ? new ExternalSlicerConnectionController(() => null) : f.controller;
    await controller.connect('http://chosen.local', good);
    assert.equal(controller.snapshot.endpoint, 'http://chosen.local');
    assert.equal(controller.snapshot.enabled, true);
    assert.equal(controller.snapshot.persistence, 'session-only');
    controller.disable();
    assert.equal(controller.snapshot.enabled, false);
    controller.dispose();
    f.controller.dispose();
  });
}
await test('a malformed or future connection record never falls through to enabled legacy preferences', () => {
  for (const raw of ['null', '{}', '{"version":2}', 'broken']) {
    const f = fixture({
      [SLICER_CONNECTION_KEY]: raw,
      [SLICER_URL_KEY]: 'http://old.local',
      [SLICER_ENABLED_KEY]: 'true',
    });
    assert.equal(f.controller.snapshot.enabled, false);
    assert.equal(f.controller.snapshot.explicitlyDisabled, true);
    f.controller.dispose();
  }
});
await test('disposal prevents future probes and notifications and is idempotent', async () => {
  const f = fixture();
  let calls = 0;
  f.controller.subscribe(() => calls++);
  f.controller.dispose();
  const before = calls;
  f.controller.dispose();
  f.controller.disable();
  f.controller.clear();
  f.controller.invalidate();
  await assert.rejects(f.controller.connect('http://chosen.local', good), /superseded/);
  assert.equal(calls, before);
});
await test('a rejected preference reset cannot revive the previously persisted active route', async () => {
  const f = fixture();
  await f.controller.connect('http://old.local', good);
  // Browser storage still contains the old record because removals were rejected.
  f.controller.preferencesChanged(true);
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.controller.snapshot.endpoint, '');
  f.controller.dispose();
});

await test('an unrelated import notification preserves a session-only route after a failed write', async () => {
  const f = fixture();
  await f.controller.connect('http://old.local', good);
  f.failWrites();
  f.controller.disable();
  f.controller.preferencesChanged();
  assert.equal(f.controller.snapshot.enabled, false);
  assert.equal(f.controller.snapshot.persistence, 'session-only');
  f.controller.dispose();
});

console.log(`\nExternal slicer connection: ${passed} tests passed.`);
