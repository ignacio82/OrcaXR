import assert from 'node:assert/strict';

import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { createEmptyProject } from '../../project/domain/model';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import {
  liveSlicingConfiguration,
  nextSlicingState,
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

console.log(`\n${passed} catalog slicing configuration tests passed.`);
