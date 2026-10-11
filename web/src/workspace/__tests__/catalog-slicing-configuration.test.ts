import assert from 'node:assert/strict';

import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { createEmptyProject } from '../../project/domain/model';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import {
  editFilamentSlots,
  liveSlicingConfiguration,
  nextSlicingState,
  projectFilamentSlots,
  resolvedProfileSlots,
  resolveProfileSelection,
} from '../CatalogSlicingConfiguration';
import { FILAMENT_PALETTE_MAX_SLOTS, FilamentPalette } from '../FilamentPalette';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const catalog = ProfileCatalog.fromRaw({
  Acme: {
    machine: [
      { name: 'Mono', from: 'system', nozzle_diameter: ['0.4'] },
      { name: 'Many', from: 'system', nozzle_diameter: Array.from({ length: 17 }, () => '0.4') },
    ],
    process: [{ name: 'Std', from: 'system' }],
    filament: [{ name: '@Nameless', from: 'system', filament_type: ['PLA'] }],
  },
});
const profileOf = (machine: string) => {
  const profile = catalog.profiles.find((candidate) => candidate.machineName === machine);
  assert.ok(profile);
  return profile;
};
const policy = { allowed: () => false, createId: () => assert.fail('no pairs') };

test('a slot with neither a preset nor a name records no preset and commits', () => {
  // A filament preset named only by its qualifier has an empty short name.
  const profile = profileOf('Mono');
  assert.equal(profile.filamentName, '');
  const palette = new FilamentPalette().list();
  const state = createEmptyProject({ idSource: new UuidIdSource(seededRandom(7)), now: '2026-10-10T00:00:00.000Z' });
  const configuration = liveSlicingConfiguration(
    catalog,
    { profile, palette, heads: palette.map(() => ({ name: '' })), nozzles: [] },
    state,
  );
  assert.ok(configuration);
  for (const filament of configuration.filaments.physical) assert.equal('presetId' in filament, false);
  // Recording `presetId: undefined` made the canonical comparison throw
  // "Canonical JSON cannot contain undefined", so the profile never committed.
  const next = nextSlicingState(state, configuration, policy);
  assert.ok(next);
  assert.deepEqual(
    next.filaments.physical.map((filament) => filament.name),
    ['Filament 1', 'Filament 2', 'Filament 3', 'Filament 4'],
  );
});

test('a printer with more extruders than palette slots fills the palette and stops', () => {
  // The workspace grew its palette with `add()` until it matched the
  // extruder count; past the palette's limit `add()` does nothing, so a
  // seventeen-nozzle printer never left that loop.
  const profile = profileOf('Many');
  const outcome = resolveProfileSelection(
    catalog,
    { profile: null, heads: [] },
    { machinePresetId: profile.machinePresetId },
  );
  assert.equal(outcome.feedback.applied, true);
  const slots = resolvedProfileSlots(profile, [], new FilamentPalette().list());
  assert.equal(slots.palette.length, FILAMENT_PALETTE_MAX_SLOTS);
  assert.equal(slots.heads.length, FILAMENT_PALETTE_MAX_SLOTS);
  assert.equal(slots.nozzles.length, FILAMENT_PALETTE_MAX_SLOTS);
  const palette = new FilamentPalette();
  while (palette.count() < slots.palette.length) palette.add();
  assert.equal(palette.count(), FILAMENT_PALETTE_MAX_SLOTS);
});

test("the Filament tab's slot edits keep each slot's filament and nozzle beside it", () => {
  const profile = profileOf('Mono');
  const palette = new FilamentPalette().list();
  const live = { profile, palette, heads: [], nozzles: [] };
  // Adding synchronizes the slots first, then appends the profile's own filament in grey PLA.
  const added = editFilamentSlots(live, { kind: 'add' });
  assert.equal(added.kind, 'edited');
  if (added.kind !== 'edited') return;
  assert.equal(added.slots.palette.length, 5);
  assert.deepEqual(added.slots.palette[4], { color: '#cccccc', type: 'PLA' });
  assert.equal(added.slots.heads.length, 5);
  assert.deepEqual(added.slots.nozzles, ['0.4', '0.4', '0.4', '0.4', '0.4']);
  // Only a slot past the printer's one head can be removed.
  assert.deepEqual(editFilamentSlots(live, { kind: 'remove', index: 0 }), { kind: 'unchanged' });
  assert.deepEqual(editFilamentSlots(live, { kind: 'remove', index: 4 }), { kind: 'unchanged' });
  const removed = editFilamentSlots({ ...live, ...added.slots }, { kind: 'remove', index: 1 });
  assert.equal(removed.kind === 'edited' && removed.slots.palette.length, 4);
  // Colours change a slot that exists; a nozzle only when it differs.
  const recoloured = editFilamentSlots(live, { kind: 'color', index: 3, color: '#123abc' });
  assert.equal(recoloured.kind === 'edited' && recoloured.slots.palette[3].color, '#123abc');
  assert.deepEqual(editFilamentSlots(live, { kind: 'color', index: 4, color: '#123abc' }), { kind: 'unchanged' });
  assert.deepEqual(editFilamentSlots(live, { kind: 'nozzle', index: 0, nozzle: '0.4' }), { kind: 'unchanged' });
  assert.equal(editFilamentSlots(live, { kind: 'nozzle', index: 0, nozzle: '0.6' }).kind, 'edited');
  // Sixteen slots at most, refused in the workspace's words.
  const full = {
    ...live,
    palette: Array.from({ length: FILAMENT_PALETTE_MAX_SLOTS }, () => ({ color: '#000000', type: 'PLA' })),
  };
  assert.deepEqual(editFilamentSlots(full, { kind: 'add' }), {
    kind: 'refused',
    message: 'The 16-slot filament limit has been reached.',
  });
});

test("an opened project's own filaments become the slots, as the palette takes them", () => {
  const filament = (toolId: number, color: string, presetId?: string, nozzleDiameterMm?: number) => ({
    name: `Tool ${toolId + 1}`,
    toolId,
    material: toolId === 1 ? 'PETG' : 'PLA',
    color,
    ...(presetId === undefined ? {} : { presetId }),
    ...(nozzleDiameterMm === undefined ? {} : { nozzleDiameterMm }),
  });
  const slots = projectFilamentSlots(
    [filament(1, 'ff0000', 'Generic PETG', 0.6), filament(0, '#00ff00aa', 'preset:Acme:filament:PLA')],
    [],
  );
  assert.deepEqual(slots.palette, [
    { color: '#00ff00', type: 'PLA' },
    { color: '#ff0000', type: 'PETG' },
  ]);
  assert.deepEqual(slots.heads, [{ name: 'Tool 1', presetId: 'preset:Acme:filament:PLA' }, { name: 'Tool 2' }]);
  assert.deepEqual(slots.nozzles, ['0.4', '0.6']);
  // Without physical filaments the palette is kept.
  const kept = new FilamentPalette().list();
  assert.deepEqual(projectFilamentSlots([], kept).palette, kept);
});

console.log(`\n${passed} catalog slicing configuration tests passed.`);
