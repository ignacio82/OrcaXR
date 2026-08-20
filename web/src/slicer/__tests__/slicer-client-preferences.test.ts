import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SlicerClient } from '../SlicerClient.ts';
import { PINNED_ENGINE_PROVENANCE } from '../pinnedEngineProvenance.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

try {
  storage.setItem('external_slicer_url', 'http://saved.local:3000');
  assert.equal(
    SlicerClient.isExternalSlicerEnabled(),
    false,
    'a legacy saved URL without an explicit enabled=true preference must fail closed',
  );
  assert.equal(SlicerClient.useExternalSlicer(), false);

  SlicerClient.disableExternalSlicer();
  assert.equal(SlicerClient.useExternalSlicer(), false, 'a saved-but-disabled URL must keep slicing local');

  await SlicerClient.connectExternalSlicer('http://saved.local:3000', async () => ({ ok: true }));
  assert.equal(SlicerClient.useExternalSlicer(), true);
  let releaseSuccessfulProbe: ((response: { ok: boolean }) => void) | undefined;
  const successfulProbe = new Promise<{ ok: boolean }>((resolve) => {
    releaseSuccessfulProbe = resolve;
  });
  const connecting = SlicerClient.connectExternalSlicer('candidate.local:4000/', async (url) => {
    assert.equal(url, 'http://candidate.local:4000/ping');
    assert.equal(
      SlicerClient.useExternalSlicer(),
      false,
      'the previously enabled route must be disabled before probing a replacement',
    );
    return successfulProbe;
  });
  assert.equal(SlicerClient.useExternalSlicer(), false);
  releaseSuccessfulProbe?.({ ok: true });
  assert.equal(await connecting, 'http://candidate.local:4000');
  assert.equal(SlicerClient.getExternalSlicerUrl(), 'http://candidate.local:4000');
  assert.equal(SlicerClient.useExternalSlicer(), true, 'only a successful probe may activate the candidate');

  await SlicerClient.connectExternalSlicer('http://route-a.local:3000', async () => ({ ok: true }));
  await assert.rejects(
    SlicerClient.connectExternalSlicer('http://candidate-b.local:3000', async (url) => {
      assert.equal(url, 'http://candidate-b.local:3000/ping');
      return { ok: false };
    }),
    /did not accept/,
  );
  assert.equal(
    SlicerClient.getExternalSlicerUrl(),
    'http://route-a.local:3000',
    'a failed candidate must not replace the last verified URL',
  );
  assert.equal(
    SlicerClient.useExternalSlicer(),
    false,
    'a failed candidate must not leave the previous route silently enabled',
  );

  let releaseCancelledProbe: ((response: { ok: boolean }) => void) | undefined;
  const cancelledProbe = new Promise<{ ok: boolean }>((resolve) => {
    releaseCancelledProbe = resolve;
  });
  const cancelledConnection = SlicerClient.connectExternalSlicer('http://late.local:3000', () => cancelledProbe);
  SlicerClient.clearExternalSlicer();
  releaseCancelledProbe?.({ ok: true });
  await assert.rejects(cancelledConnection, /superseded/);
  assert.equal(SlicerClient.getExternalSlicerUrl(), '', 'deleting during a probe must not resurrect the endpoint');
  assert.equal(SlicerClient.useExternalSlicer(), false);

  // ---- Auto-Discovery Tests ----
  const originalWindow = globalThis.window;
  try {
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

    // 1. Successful auto-discovery
    storage.clear();
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'http://localhost:3000',
        hostname: 'localhost',
        protocol: 'http:',
      },
    };

    const discovery = await SlicerClient.autoDiscoverExternalSlicer(async () => ({
      ok: true,
      json: async () => attestedCli,
    }));
    assert.equal(discovery.discovered, true);
    assert.equal(SlicerClient.getExternalSlicerUrl(), 'http://localhost:3000');
    assert.equal(SlicerClient.isExternalSlicerEnabled(), true);
    assert.equal(SlicerClient.getExternalSlicerOriginType(), 'auto-discovered');

    // 2. Explicit user configuration is NOT overwritten by auto-discovery
    await SlicerClient.connectExternalSlicer('http://user-configured.local:3000', async () => ({ ok: true }));
    assert.equal(SlicerClient.getExternalSlicerOriginType(), 'user');
    assert.equal(SlicerClient.getExternalSlicerUrl(), 'http://user-configured.local:3000');

    const discoveryAttempt = await SlicerClient.autoDiscoverExternalSlicer(async () => ({
      ok: true,
      json: async () => attestedCli,
    }));
    assert.equal(discoveryAttempt.discovered, false, 'user-configured endpoints must not be overwritten');
    assert.equal(SlicerClient.getExternalSlicerUrl(), 'http://user-configured.local:3000');
    assert.equal(SlicerClient.getExternalSlicerOriginType(), 'user');

    // 3. Failed attestation reverts and leaves route disabled
    storage.clear();
    const failedDiscovery = await SlicerClient.autoDiscoverExternalSlicer(async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 1, engine: 'cli', attested: false, reason: 'Drift detected' }),
    }));
    assert.equal(failedDiscovery.discovered, false);
    assert.equal(SlicerClient.useExternalSlicer(), false);
    assert.equal(SlicerClient.getExternalSlicerUrl(), '');

    // 4. Static hosting environment skips discovery
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'https://ignacio82.github.io',
        hostname: 'ignacio82.github.io',
        protocol: 'https:',
      },
    };
    const ghPagesDiscovery = await SlicerClient.autoDiscoverExternalSlicer();
    assert.equal(ghPagesDiscovery.discovered, false);
    assert.match(ghPagesDiscovery.reason, /Static hosting environment/);
  } finally {
    if (originalWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else Reflect.deleteProperty(globalThis, 'window');
  }

  const mainSource = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8');
  assert.match(
    mainSource,
    /if \(SlicerClient\.useExternalSlicer\(\)\) \{[\s\S]{0,240}connectExternalSlicerCandidate/,
    'startup probing must be gated by the persisted explicit opt-in, not merely by a saved URL',
  );
  assert.doesNotMatch(
    mainSource,
    /if \(externalSlicerUrl\.value\) \{[\s\S]{0,160}(?:\.click\(|connectExternalSlicerCandidate)/,
    'a saved URL alone must not trigger a startup probe',
  );
  assert.match(
    mainSource,
    /externalSlicerUrl\.value = SlicerClient\.getExternalSlicerUrl\(\);[\s\S]{0,180}updateExternalSlicerStatus\(false\)/,
    'a failed replacement must restore the URL that matches the disabled saved route',
  );
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('SlicerClient external-slicer consent tests passed.');
