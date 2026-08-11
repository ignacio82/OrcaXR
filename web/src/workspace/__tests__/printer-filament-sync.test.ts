import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [{ OrcaWorkspace }, { buildRegistry }, { ProfileCatalog }] = await Promise.all([
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
  import('../../slicer/ProfileLoader'),
]);

// The shipped corpus, so the preset graph under test is the real one.
const catalogRaw: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../public/profiles/catalog.json', import.meta.url)), 'utf8'),
);

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * The machine reports what is actually loaded. Adopting that has to move the
 * *bound filament preset* too, because the preset is what declares the material
 * a slice is checked against — writing canonical filaments alone is not enough.
 *
 * The symptom this pins: open a project, choose the Snapmaker profile, press
 * Sync filaments, and the printer's own filament came back reported as
 * unsupported ("PLA is not supported on tool 1"), because the tool stayed bound
 * to whichever preset the profile had defaulted to.
 */
type Workspace = InstanceType<typeof OrcaWorkspace>;

interface Harness {
  readonly workspace: Workspace;
  readonly status: () => string;
  readonly unsupported: () => string[];
  /** What the preset currently bound to `toolId` declares it is made of. */
  readonly boundMaterial: (toolId: number) => string | undefined;
}

/** A U1 selected with `filamentType` bound to tool 1. */
function build(filamentType: string): Harness {
  const catalog = ProfileCatalog.fromRaw(catalogRaw);
  const workspace = new OrcaWorkspace(buildRegistry(), { catalog });
  let latest = '';
  const unsupported: string[] = [];
  workspace.onStatusChanged = (text) => {
    latest = text;
  };
  workspace.onPreflight = (result) => {
    unsupported.length = 0;
    for (const issue of result.issues) {
      if (issue.code === 'unsupported-filament-material') unsupported.push(issue.message);
    }
  };

  const u1 = catalog.profiles.filter((profile) => profile.machineName.includes('U1'));
  const seed = u1[0];
  assert.ok(seed?.machinePresetId && seed.processPresetId, 'catalog must expose a U1 machine and process');
  const bound = u1.find(
    (profile) =>
      profile.machinePresetId === seed.machinePresetId &&
      profile.processPresetId === seed.processPresetId &&
      profile.config['filament_type'] === filamentType,
  );
  assert.ok(bound?.filamentPresetId, `catalog must expose a ${filamentType} filament for this U1 process`);
  workspace.selectProfilePresets({
    machinePresetId: seed.machinePresetId,
    processPresetId: seed.processPresetId,
    filamentPresetIds: [bound.filamentPresetId],
  });
  const boundMaterial = (toolId: number): string | undefined => {
    const presetId = workspace.getHeadFilamentPresetId(toolId);
    const profile = catalog.profiles.find(
      (candidate) =>
        candidate.machinePresetId === seed.machinePresetId &&
        candidate.processPresetId === seed.processPresetId &&
        candidate.filamentPresetId === presetId,
    );
    return profile?.config['filament_type'];
  };
  return { workspace, status: () => latest, unsupported: () => [...unsupported], boundMaterial };
}

test('adopting the printer’s filament rebinds the tool to a preset that declares that material', () => {
  // The pre-sync state is the bug's precondition: the tool is bound to ABS
  // while the machine has PLA loaded. The bound preset is what supplies the
  // material preflight checks a slice against, so leaving it on ABS is exactly
  // what reported "PLA is not supported on tool 1".
  const { workspace, unsupported, boundMaterial } = build('ABS');
  assert.equal(boundMaterial(0), 'ABS', 'precondition: the tool starts bound to a different material');

  const applied = workspace.syncFilamentsFromPrinter([
    { slotIndex: 0, colorHex: '#112233', material: 'PLA', vendor: 'Snapmaker' },
  ]);
  assert.equal(applied, true, 'a reported slot is adopted');
  assert.equal(boundMaterial(0), 'PLA', 'the bound preset now declares the material the printer reported');
  assert.deepEqual(unsupported(), [], 'and nothing reports the printer’s own filament as unsupported');
  workspace.dispose();
});

test('the adopted material and colour survive the next profile touch', () => {
  const { workspace } = build('ABS');
  workspace.syncFilamentsFromPrinter([{ slotIndex: 0, colorHex: '#abcdef', material: 'PLA', vendor: 'Snapmaker' }]);
  // `applyLiveSlicingConfiguration` rebuilds canonical filaments from the live
  // palette and head presets, so a sync that only wrote canonical state is
  // silently reverted the moment anything else re-applies the profile.
  workspace.setHeadNozzle(0, '0.4');
  const first = workspace
    .getFilamentAssignmentSnapshot()
    .options.find((option) => option.kind === 'physical' && option.toolId === 0);
  assert.equal(first?.material, 'PLA', 'the tool still reports the material the printer reported');
  assert.equal(first?.color.toLowerCase(), '#abcdef', 'the reported colour reaches the live palette, not around it');
  workspace.dispose();
});

test('a reported material with no compatible preset is named instead of silently mismatched', () => {
  const { workspace, status } = build('ABS');
  const applied = workspace.syncFilamentsFromPrinter([
    { slotIndex: 0, colorHex: '#445566', material: 'Unobtainium', vendor: 'Nobody' },
  ]);
  assert.equal(applied, true);
  assert.match(status(), /Unobtainium on tool 1/, 'the unmatched material and tool are both named');
  assert.match(status(), /keeps the previous preset/, 'the consequence is stated rather than implied');
  workspace.dispose();
});

test('a tool already bound to the reported material keeps the preset the user chose', () => {
  const { workspace } = build('PLA');
  const before = workspace.getHeadFilamentPresetId(0);
  workspace.syncFilamentsFromPrinter([{ slotIndex: 0, colorHex: '#0f0f0f', material: 'PLA', vendor: 'Snapmaker' }]);
  assert.equal(
    workspace.getHeadFilamentPresetId(0),
    before,
    'a matching material must not swap a deliberate preset for another of the same type',
  );
  workspace.dispose();
});

console.log(`\nPrinter filament sync: ${passed} tests passed.`);
