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

const catalogRaw: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../public/profiles/catalog.json', import.meta.url)), 'utf8'),
);

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

type Workspace = InstanceType<typeof OrcaWorkspace>;

/** A workspace with the catalog's U1 chosen and committed. */
async function u1(): Promise<Workspace> {
  const catalog = ProfileCatalog.fromRaw(catalogRaw);
  const workspace = new OrcaWorkspace(buildRegistry(), { catalog });
  const profile = catalog.profiles.find((candidate) => candidate.machineName === 'Snapmaker U1 (0.4 nozzle)');
  assert.ok(profile?.machinePresetId && profile.processPresetId && profile.filamentPresetId);
  workspace.selectProfilePresets({
    machinePresetId: profile.machinePresetId,
    processPresetId: profile.processPresetId,
    filamentPresetIds: [profile.filamentPresetId],
  });
  await workspace.slicingConfigurationSettled();
  return workspace;
}

/** The project's own physical filaments by tool: what a slice and a saved project hold. */
function projectFilaments(workspace: Workspace) {
  return workspace
    .getFilamentAssignmentSnapshot()
    .options.filter((option) => option.kind === 'physical')
    .map((option) => ({ toolId: option.toolId, color: option.color.toLowerCase() }));
}

await test('an undone slot stays undone when the next palette edit commits', async () => {
  const workspace = await u1();
  assert.equal(workspace.palette.count(), 4);
  assert.equal(projectFilaments(workspace).length, 4);
  workspace.addFilamentSlot();
  await workspace.slicingConfigurationSettled();
  assert.equal(projectFilaments(workspace).length, 5, 'the added slot is a filament of the project');

  assert.equal(await workspace.undo(), true);
  // The palette is kept beside the project; it used to stay at five slots
  // here, so the colour edit below committed the undone fifth slot again.
  assert.equal(workspace.palette.count(), 4, 'the palette follows the undo');
  assert.equal(workspace.getHeadFilamentPresetId(4), undefined, 'and so do the slots’ filaments');
  workspace.palette.setColor(1, '#123abc');
  await workspace.slicingConfigurationSettled();
  assert.deepEqual(
    projectFilaments(workspace).map((filament) => filament.toolId),
    [0, 1, 2, 3],
    'the next edit does not bring the undone slot back',
  );
  assert.equal(projectFilaments(workspace)[1].color, '#123abc');
  workspace.dispose();
});

await test('redo brings the slot back to the palette, and undo of a colour restores it', async () => {
  const workspace = await u1();
  const before = workspace.palette.colorAt(2);
  workspace.palette.setColor(2, '#00ff00');
  await workspace.slicingConfigurationSettled();
  workspace.addFilamentSlot();
  await workspace.slicingConfigurationSettled();
  await workspace.undo();
  assert.equal(workspace.palette.count(), 4);
  await workspace.redo();
  assert.equal(workspace.palette.count(), 5, 'redo follows too');
  await workspace.undo();
  await workspace.undo();
  assert.equal(workspace.palette.count(), 4);
  assert.equal(
    workspace.palette.colorAt(2).toLowerCase(),
    before.toLowerCase(),
    'the undone colour leaves the palette',
  );
  // Following history commits nothing of its own: redo is still available.
  assert.equal(await workspace.redo(), true);
  assert.equal(workspace.palette.colorAt(2).toLowerCase(), '#00ff00');
  workspace.dispose();
});

console.log(`\nPalette follows history: ${passed} tests passed.`);
