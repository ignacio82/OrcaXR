import assert from 'node:assert/strict';

import { SlicerClient } from '../SlicerClient';
import { PINNED_ENGINE_PROVENANCE } from '../pinnedEngineProvenance';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Minimal localStorage so the client's persisted route can be exercised. */
function installStorage(entries: Record<string, string> = {}): void {
  const store = new Map(Object.entries(entries));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function enabledExternal(): void {
  installStorage({ external_slicer_url: 'http://127.0.0.1:8787', external_slicer_enabled: 'true' });
}

const attested = {
  schemaVersion: 1,
  engine: 'wasm',
  attested: true,
  upstream: { commit: PINNED_ENGINE_PROVENANCE.commit },
  artifacts: { ...PINNED_ENGINE_PROVENANCE.artifacts },
};

const respond =
  (payload: unknown, ok = true) =>
  async () => ({ ok, json: async () => payload });

await test('an engine matching the verified build is attested', async () => {
  enabledExternal();
  const result = await SlicerClient.attestExternalEngine(respond(attested));
  assert.deepEqual(result, { attested: true, commit: PINNED_ENGINE_PROVENANCE.commit });
});

await test('an unproven engine is refused with the server’s own reason', async () => {
  enabledExternal();
  const result = await SlicerClient.attestExternalEngine(
    respond({ schemaVersion: 1, engine: 'cli', attested: false, reason: 'CLI build cannot be proven.' }),
  );
  assert.equal(result.attested, false);
  if (!result.attested) assert.equal(result.reason, 'CLI build cannot be proven.');
});

/**
 * The CLI route exists precisely to produce what desktop Snapmaker Orca
 * produces, so it must be able to attest. Its identity is the upstream commit
 * plus the OrcaXR patches applied on top — never the WASM artifact digests,
 * which a native binary does not have.
 */
const attestedCli = {
  schemaVersion: 1,
  engine: 'cli',
  attested: true,
  upstream: {
    name: 'snapmaker-orca',
    version: PINNED_ENGINE_PROVENANCE.cliVersion,
    commit: PINNED_ENGINE_PROVENANCE.commit,
  },
  patches: Object.entries(PINNED_ENGINE_PROVENANCE.cliPatches).map(([name, sha256]) => ({ name, sha256 })),
  artifacts: { 'snapmaker-orca': 'c0ffee' },
};

await test('a CLI engine on the pinned commit with the pinned patches is attested', async () => {
  enabledExternal();
  assert.deepEqual(await SlicerClient.attestExternalEngine(respond(attestedCli)), {
    attested: true,
    commit: PINNED_ENGINE_PROVENANCE.commit,
  });
});

await test('a CLI engine whose patch set differs is refused by name', async () => {
  enabledExternal();
  const [firstPatch, ...restPatches] = attestedCli.patches;

  const extra = await SlicerClient.attestExternalEngine(
    respond({ ...attestedCli, patches: [...attestedCli.patches, { name: '0099-rogue.patch', sha256: 'x' }] }),
  );
  assert.equal(extra.attested, false);
  if (!extra.attested) assert.match(extra.reason, /does not know: 0099-rogue\.patch/);

  const missing = await SlicerClient.attestExternalEngine(respond({ ...attestedCli, patches: restPatches }));
  assert.equal(missing.attested, false);
  if (!missing.attested) assert.match(missing.reason, /built without the .*0001-cli-safe/);

  const tampered = await SlicerClient.attestExternalEngine(
    respond({ ...attestedCli, patches: [{ ...firstPatch, sha256: 'deadbeef' }, ...restPatches] }),
  );
  assert.equal(tampered.attested, false);
  if (!tampered.attested) assert.match(tampered.reason, /carries a different .*0001-cli-safe/);

  // A build that reports no patch list at all proves nothing about its engine.
  const silent = await SlicerClient.attestExternalEngine(respond({ ...attestedCli, patches: undefined }));
  assert.equal(silent.attested, false);
  if (!silent.attested) assert.match(silent.reason, /did not report which engine patches/);
});

await test('a CLI engine off the pinned commit is refused whatever its patches say', async () => {
  enabledExternal();
  const result = await SlicerClient.attestExternalEngine(
    respond({ ...attestedCli, upstream: { commit: '0000000000000000000000000000000000000000' } }),
  );
  assert.equal(result.attested, false);
  if (!result.attested) assert.match(result.reason, /different pinned engine commit/);
});

await test('a different engine artifact names the artifact that differs', async () => {
  enabledExternal();
  const result = await SlicerClient.attestExternalEngine(
    respond({
      ...attested,
      artifacts: {
        ...attested.artifacts,
        'slic3r.wasm': 'da3940122ea5096f75e0b5d9379db235b30e628f37b33a5d8dba08796d2a710d',
      },
    }),
  );
  assert.equal(result.attested, false);
  if (!result.attested) assert.match(result.reason, /different slic3r\.wasm/);
});

await test('a different pinned commit is refused even when the hashes line up', async () => {
  enabledExternal();
  const result = await SlicerClient.attestExternalEngine(
    respond({ ...attested, upstream: { commit: '0000000000000000000000000000000000000000' } }),
  );
  assert.equal(result.attested, false);
  if (!result.attested) assert.match(result.reason, /different pinned engine commit/);
});

await test('an unreachable, failing, or malformed server is refused, never assumed', async () => {
  enabledExternal();
  const unreachable = await SlicerClient.attestExternalEngine(async () => {
    throw new Error('network down');
  });
  assert.equal(unreachable.attested, false);
  if (!unreachable.attested) assert.match(unreachable.reason, /could not be reached/);

  const failing = await SlicerClient.attestExternalEngine(respond(attested, false));
  assert.equal(failing.attested, false);
  if (!failing.attested) assert.match(failing.reason, /did not report its engine provenance/);

  const malformed = await SlicerClient.attestExternalEngine(respond('not-an-object'));
  assert.equal(malformed.attested, false);
  if (!malformed.attested) assert.match(malformed.reason, /malformed engine attestation/);

  const noArtifacts = await SlicerClient.attestExternalEngine(
    respond({
      schemaVersion: 1,
      engine: 'wasm',
      attested: true,
      upstream: { commit: PINNED_ENGINE_PROVENANCE.commit },
    }),
  );
  assert.equal(noArtifacts.attested, false);
  if (!noArtifacts.attested) assert.match(noArtifacts.reason, /attested no engine artifacts/);
});

await test('with no external slicer enabled there is nothing to attest', async () => {
  installStorage();
  const result = await SlicerClient.attestExternalEngine(respond(attested));
  assert.equal(result.attested, false);
  if (!result.attested) assert.match(result.reason, /No external slicer is enabled/);
});

/**
 * A server published beyond loopback refuses to start without a token, so the
 * client must be able to send one. Without this the attestation probe 401s and
 * canonical slicing is blocked on every correctly secured deployment.
 */
await test('a secured server is reached with the token the operator supplied', async () => {
  enabledExternal();
  SlicerClient.setExternalSlicerToken('  secret-token  ');
  assert.equal(SlicerClient.hasExternalSlicerToken(), true);
  assert.deepEqual(SlicerClient.externalAuthHeaders(), { Authorization: 'Bearer secret-token' }, 'trimmed');

  let seen: string | undefined;
  const result = await SlicerClient.attestExternalEngine(async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => attested };
  });
  assert.equal(result.attested, true);
  assert.match(seen ?? '', /\/engine$/);

  SlicerClient.setExternalSlicerToken('');
  assert.equal(SlicerClient.hasExternalSlicerToken(), false);
  assert.deepEqual(SlicerClient.externalAuthHeaders(), {}, 'clearing the token sends no header at all');
});

/**
 * The token is remembered on this device on purpose. Re-entering it on every
 * reload made a secured external slicer unusable as a daily route, which is
 * the entire point of configuring one; `RememberedCredentials` owns the
 * storage, the off switch, and the reasoning about what that costs.
 */
await test('the token is remembered across sessions, and can be told not to be', async () => {
  enabledExternal();
  const storage = (globalThis as { localStorage: { getItem(key: string): string | null } }).localStorage;

  SlicerClient.setExternalSlicerToken('secret-token');
  assert.match(storage.getItem('orcaxr.credentials') ?? '', /secret-token/, 'a reload must find it again');

  // Not persisting is available for a caller that only wants the live value.
  SlicerClient.setExternalSlicerToken('');
  SlicerClient.setExternalSlicerToken('in-memory-only', { persist: false });
  assert.equal(SlicerClient.hasExternalSlicerToken(), true);
  assert.doesNotMatch(storage.getItem('orcaxr.credentials') ?? '', /in-memory-only/);

  SlicerClient.setExternalSlicerToken('');
});

await test('a server that wants a token says so instead of blaming its provenance', async () => {
  enabledExternal();
  for (const status of [401, 403]) {
    const result = await SlicerClient.attestExternalEngine(async () => ({ ok: false, status }));
    assert.equal(result.attested, false);
    if (!result.attested) assert.match(result.reason, /requires a token/);
  }
  // Any other failure names the status, so a missing route is distinguishable
  // from a rejected one at a glance.
  const missing = await SlicerClient.attestExternalEngine(async () => ({ ok: false, status: 404 }));
  assert.equal(missing.attested, false);
  if (!missing.attested) {
    assert.match(missing.reason, /HTTP 404/);
    assert.match(missing.reason, /serves \/engine/);
  }
});

console.log(`\nExternal engine attestation: ${passed} tests passed.`);
