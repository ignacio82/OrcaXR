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
  /** Bind one head to a preset by its full catalog name. */
  readonly bindPreset: (toolId: number, name: string) => void;
  /** The full name of the preset currently bound to `toolId`. */
  readonly boundPreset: (toolId: number) => string | undefined;
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

  // Pinned to the 0.4 mm U1: it is the variant the Snapmaker filament library
  // is written for, and picking "the first U1" silently follows corpus order.
  const u1 = catalog.profiles.filter((profile) => profile.machineName === 'Snapmaker U1 (0.4 nozzle)');
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
  const presetNamed = (name: string): string => {
    const found = u1.find(
      (profile) =>
        profile.machinePresetId === seed.machinePresetId &&
        profile.processPresetId === seed.processPresetId &&
        profile.filamentPresetName === name,
    );
    assert.ok(found?.filamentPresetId, `catalog must expose ${name}`);
    return found.filamentPresetId;
  };
  const bindPreset = (toolId: number, name: string): void => {
    const ids = [...Array(workspace.extruderCount).keys()].map((index) => workspace.getHeadFilamentPresetId(index));
    ids[toolId] = presetNamed(name) as (typeof ids)[number];
    workspace.selectProfilePresets({ filamentPresetIds: ids });
  };
  const boundPreset = (toolId: number): string | undefined => {
    const presetId = workspace.getHeadFilamentPresetId(toolId);
    return catalog.profiles.find(
      (candidate) =>
        candidate.machinePresetId === seed.machinePresetId &&
        candidate.processPresetId === seed.processPresetId &&
        candidate.filamentPresetId === presetId,
    )?.filamentPresetName;
  };
  return {
    workspace,
    status: () => latest,
    unsupported: () => [...unsupported],
    boundMaterial,
    bindPreset,
    boundPreset,
  };
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

test('a preset the report does not contradict is the operator’s to keep', () => {
  // The machine names a vendor and a type and no grade. A deliberate Silk
  // choice satisfies every fact it reported, so nothing about it is wrong and
  // the sync must not drag it back to the plain preset.
  const { workspace, bindPreset, boundPreset } = build('PLA');
  bindPreset(0, 'Snapmaker PLA Silk @U1');
  workspace.syncFilamentsFromPrinter([{ slotIndex: 0, colorHex: '#0f0f0f', material: 'PLA', vendor: 'Snapmaker' }]);
  assert.equal(
    boundPreset(0),
    'Snapmaker PLA Silk @U1',
    'an unreported grade is not a reason to overwrite a deliberate preset',
  );
  workspace.dispose();
});

test('the vendor and grade the machine reports pick the preset, not the first of that type', () => {
  // The reported bug, exactly: four heads of Snapmaker PLA Matte and SnapSpeed
  // all came back as Generic PLA, because matching looked at `filament_type`
  // alone and took whichever PLA preset the catalog listed first.
  const { workspace, bindPreset, boundPreset } = build('PLA');
  for (let toolId = 0; toolId < 4; toolId += 1) bindPreset(toolId, 'Generic PLA');
  assert.equal(boundPreset(0), 'Generic PLA', 'precondition: every head starts on the generic preset');

  workspace.syncFilamentsFromPrinter([
    { slotIndex: 0, colorHex: '#1E88E5', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { slotIndex: 1, colorHex: '#000000', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { slotIndex: 2, colorHex: '#E2DEDB', material: 'PLA', subType: 'SnapSpeed', vendor: 'Snapmaker' },
    { slotIndex: 3, colorHex: '#F8F81C', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
  ]);

  assert.deepEqual(
    [boundPreset(0), boundPreset(1), boundPreset(2), boundPreset(3)],
    ['Snapmaker PLA Matte @U1', 'Snapmaker PLA Matte @U1', 'Snapmaker PLA SnapSpeed @U1', 'Snapmaker PLA Matte @U1'],
    'each head lands on the preset that declares the vendor, type and grade the machine reported',
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((toolId) => workspace.palette.colorAt(toolId).toUpperCase()),
    ['#1E88E5', '#000000', '#E2DEDB', '#F8F81C'],
    'and each head carries the colour of the spool that is actually loaded',
  );
  workspace.dispose();
});

test('a reported grade with no preset of its own falls back to the vendor’s plain preset', () => {
  const { workspace, bindPreset, boundPreset } = build('PLA');
  bindPreset(0, 'Generic PLA');
  workspace.syncFilamentsFromPrinter([
    { slotIndex: 0, colorHex: '#0f0f0f', material: 'PLA', subType: 'Nebula', vendor: 'Snapmaker' },
  ]);
  assert.equal(
    boundPreset(0),
    'Snapmaker PLA @U1',
    'an unknown grade still keeps the vendor and type the machine reported',
  );
  workspace.dispose();
});

console.log(`\nPrinter filament sync: ${passed} tests passed.`);
