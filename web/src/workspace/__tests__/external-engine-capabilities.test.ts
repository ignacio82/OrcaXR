import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import type { ConfigMap } from '../../project/domain/model';

class TestAudioContext {
  readonly destination = {};
  readonly listener = {};
  readonly currentTime = 0;

  createGain() {
    return {
      gain: { value: 1, setTargetAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}

class TestHtmlElement {}

const store = new Map<string, string>([
  ['external_slicer_url', 'http://127.0.0.1:9'],
  ['external_slicer_enabled', 'true'],
]);
const browserGlobals: Readonly<Record<string, unknown>> = {
  window: {
    location: { search: '' },
    AudioContext: TestAudioContext,
    addEventListener() {},
    removeEventListener() {},
  },
  document: {},
  navigator: {},
  HTMLElement: TestHtmlElement,
  customElements: { define() {}, get() {} },
  crypto: webcrypto,
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [{ OrcaWorkspace }, { buildRegistry }, { SlicerClient }, { PINNED_ENGINE_PROVENANCE, engineSupports }] =
  await Promise.all([
    import('../OrcaWorkspace'),
    import('../../actions/catalog'),
    import('../../slicer/SlicerClient'),
    import('../../slicer/pinnedEngineProvenance'),
  ]);

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * An attested external server is a route the operator chose, so it is used —
 * unless its engine would quietly ignore part of the project. The native CLI
 * build has no wave-overhang port: it accepts a project with waves on, reads
 * none of the wave keys, and returns G-code that prints those overhangs as if
 * the switch were off. That has to be refused before anything is sent.
 */
let attestedEngine: 'wasm' | 'cli' = 'cli';
let attestations = 0;
SlicerClient.attestCapturedProjectRoute = async () => {
  attestations += 1;
  return {
    attested: true,
    route: { kind: 'external-server', endpoint: 'http://127.0.0.1:9', connectionGeneration: 1 },
    engine: attestedEngine,
    externalEngine: { commit: PINNED_ENGINE_PROVENANCE.commit, artifactHash: `sha256:${'ab'.repeat(32)}` },
  };
};

const WAVE_REFUSAL = /native Snapmaker Orca CLI, which has no wave-overhang support/;

function harness() {
  const workspace = new OrcaWorkspace(buildRegistry());
  const statuses: string[] = [];
  workspace.onStatusChanged = (text) => statuses.push(text);
  workspace.addPrimitive('cube');
  const setWaves = (on: boolean) => {
    const snapshot = workspace.getProjectSettingsOverrideSnapshot();
    workspace.setProjectSettingsOverrides(
      snapshot.inheritedConfig as unknown as Readonly<ConfigMap>,
      { ...(snapshot.overrides as unknown as Readonly<ConfigMap>), wave_overhangs: on ? '1' : '0' },
      { sourceRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
    );
  };
  return { workspace, statuses, setWaves };
}

await test('only the WASM engine carries the wave-overhang port', () => {
  assert.equal(engineSupports('wasm', 'wave-overhangs'), true);
  assert.equal(engineSupports('cli', 'wave-overhangs'), false);
});

await test('slicing every plate on the CLI engine with waves on is refused, with the way out named', async () => {
  attestedEngine = 'cli';
  const { workspace, statuses, setWaves } = harness();
  setWaves(true);
  const before = attestations;
  assert.equal(await workspace.sliceAllPlates(), 0);
  assert.equal(attestations, before + 1, 'the engine was asked to prove itself first');
  assert.match(statuses.at(-1) ?? '', WAVE_REFUSAL);
  assert.match(statuses.at(-1) ?? '', /Disable the external slicer to slice in the browser engine/);

  // Slicing the active plate takes the same attested route, so it is refused the same way.
  await workspace.sliceNow();
  assert.equal(attestations, before + 2);
  assert.match(statuses.at(-1) ?? '', WAVE_REFUSAL);
});

await test('the same project is not refused for waves when they are off, or when the engine has them', async () => {
  attestedEngine = 'cli';
  const off = harness();
  off.setWaves(false);
  await off.workspace.sliceAllPlates();
  assert.ok(
    off.statuses.every((status) => !WAVE_REFUSAL.test(status)),
    'waves off: the CLI route is not refused',
  );
  // Not refused means the job itself starts on the attested route.
  assert.ok(off.statuses.includes('Slicing: preflighting'), `the external job started: ${off.statuses.join(' | ')}`);

  attestedEngine = 'wasm';
  const wasm = harness();
  wasm.setWaves(true);
  await wasm.workspace.sliceAllPlates();
  assert.ok(
    wasm.statuses.every((status) => !WAVE_REFUSAL.test(status)),
    'a WASM server runs the wave port',
  );
  assert.ok(wasm.statuses.includes('Slicing: preflighting'));
});

console.log(`${passed} external engine capability checks passed`);
