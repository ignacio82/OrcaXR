import assert from 'node:assert/strict';

import { cloneProjectState } from '../domain/canonical';
import { CanonicalStateProfileResolver } from '../slicing/profileResolver';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

await test('captures the exact serializer slot order and canonical physical and mixed profile identities', async () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const plate = state.plates[0];
  state.printer.profileId = 'printer-u1';
  state.printer.profileHash = hash('a');
  state.config.print_settings_id = '0.20 Standard';
  state.filaments.physical[0].presetId = 'Snapmaker PLA';
  state.filaments.physical[0].presetHash = hash('b');
  state.filaments.physical[0].toolId = 17;
  state.filaments.physical[1].presetHash = 'legacy-profile-fingerprint';
  state.filaments.physical[1].toolId = 3;
  state.filaments.physical[1].enabled = false;

  const resolver = new CanonicalStateProfileResolver();
  const first = await resolver.capture(state, plate.id);
  const second = await resolver.capture(state, plate.id);
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.references), true);
  assert.ok(first.references.every(Object.isFrozen));
  assert.deepEqual(
    first.references.map((reference) => [
      reference.kind,
      reference.id,
      reference.kind === 'filament' ? reference.tool : null,
    ]),
    [
      ['printer', 'printer-u1', null],
      ['process', '0.20 Standard', null],
      ['filament', 'Snapmaker PLA', 0],
      ['filament', state.filaments.physical[1].id, 1],
      ['filament', state.filaments.mixed[0].id, 2],
    ],
  );
  assert.equal(first.references[0].hash, hash('a'));
  assert.equal(first.references[2].hash, hash('b'));
  assert.notEqual(first.references[3].hash, state.filaments.physical[1].presetHash);
  assert.ok(first.references.every((reference) => /^sha256:[0-9a-f]{64}$/.test(reference.hash)));
  assert.match(first.effectiveConfigHash, /^sha256:[0-9a-f]{64}$/);

  plate.config.layer_height = 0.12;
  const changed = await resolver.capture(state, plate.id);
  assert.notEqual(changed.effectiveConfigHash, first.effectiveConfigHash);
  assert.notEqual(
    changed.references.find((reference) => reference.kind === 'process')?.hash,
    first.references.find((reference) => reference.kind === 'process')?.hash,
  );

  state.filaments.mixed[0].components[0].weight = 3;
  const changedRecipe = await resolver.capture(state, plate.id);
  assert.notEqual(
    changedRecipe.references.find((reference) => reference.kind === 'filament' && reference.tool === 2)?.hash,
    changed.references.find((reference) => reference.kind === 'filament' && reference.tool === 2)?.hash,
  );
});

await test('canonicalizes legacy hashes, retains every physical slot, and omits disabled mixed rows', async () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const plateId = state.plates[0].id;
  state.printer.profileHash = 'sha256:legacy-printer';
  state.filaments.physical[0].presetHash = 'sha256:legacy-filament';
  delete state.filaments.physical[1].presetHash;
  state.filaments.physical[1].enabled = false;
  state.filaments.mixed[0].enabled = false;

  const snapshot = await new CanonicalStateProfileResolver().capture(state, plateId);
  assert.deepEqual(
    snapshot.references
      .filter((reference) => reference.kind === 'filament')
      .map((reference) => [reference.tool, reference.id]),
    [
      [0, state.filaments.physical[0].id],
      [1, state.filaments.physical[1].id],
    ],
  );
  assert.ok(snapshot.references.every((reference) => /^sha256:[0-9a-f]{64}$/.test(reference.hash)));
  assert.notEqual(snapshot.references[0].hash, state.printer.profileHash);
  assert.notEqual(snapshot.references[2].hash, state.filaments.physical[0].presetHash);
  await assert.rejects(
    new CanonicalStateProfileResolver().capture(state, 'missing-plate' as typeof plateId),
    /unknown plate/,
  );
});

console.log(`\n${passed} canonical slice profile resolver tests passed.`);
