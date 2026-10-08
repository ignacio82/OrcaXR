/**
 * The domain-to-wire encoders are the exact inverse of the intent decoders: a
 * mixed filament encoded for an `addMixedFilament` intent and prepared again
 * lands in the project byte for byte, for every distribution, recipe and
 * optional field a browser route submits.
 */
import assert from 'node:assert/strict';

import { CommandBus, InMemoryAssetRepository, ProjectStore, SelectionStore, canonicalStringify, entityId } from '..';
import { createIntentTextEncoder, prepareProjectIntent } from '../PreparedProjectCommands';
import type { MixedFilament } from '../domain/model';
import { createFullSpectrumMixedFilament } from '../filaments/fullSpectrumRecipe';
import { mixedFilamentWire } from '../intentWire';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const fixture = createProjectFixture();
const [a, b] = fixture.state.filaments.physical;
const id = (key: string) => entityId<'mixed-filament'>(`import:intent-wire:${key}`);
const recipes: MixedFilament[] = [
  createFullSpectrumMixedFilament(id('ratio'), fixture.state.filaments.physical, {
    mode: 'ratio',
    name: ' Sunset ✓ ',
    displayColor: '#FF8800',
    componentFilamentIds: [a.id, b.id],
    mixBPercent: 30,
  }),
  createFullSpectrumMixedFilament(id('cycle'), fixture.state.filaments.physical, {
    mode: 'cycle',
    name: 'Stripes',
    displayColor: '#AABBCCDD',
    manualPatternGroups: [[a.id], [b.id, a.id]],
  }),
  {
    id: id('gradient'),
    name: 'Fade',
    displayColor: '#808080',
    components: [
      { filamentId: a.id, weight: 1 },
      { filamentId: b.id, weight: 2.5 },
    ],
    distribution: { mode: 'gradient', startZMm: 1, endZMm: 9.5, startWeights: [1, 0], endWeights: [0, 1] },
    config: { note: 'kept', nested: { list: [1, '😀'] } },
    enabled: false,
    extensionData: { kept: true },
  },
  {
    id: id('cycle-length'),
    name: 'Bands',
    displayColor: '#123456',
    components: [
      { filamentId: a.id, weight: 1 },
      { filamentId: b.id, weight: 1 },
    ],
    distribution: { mode: 'cycle', cycleLengthMm: 2.4 },
    config: {},
    enabled: true,
  },
  {
    id: id('match'),
    name: 'Match',
    displayColor: '#ABCDEF',
    components: [
      { filamentId: b.id, weight: 3 },
      { filamentId: a.id, weight: 1 },
    ],
    distribution: { mode: 'match', targetColor: '#ABCDEF' },
    config: {},
    enabled: true,
  },
  {
    id: id('ratio-plain'),
    name: 'Plain',
    displayColor: '#000000',
    components: [
      { filamentId: a.id, weight: 1 },
      { filamentId: b.id, weight: 4 },
    ],
    distribution: { mode: 'ratio' },
    config: {},
    enabled: true,
  },
];

test('every mixed filament a route submits prepares back exactly', () => {
  for (const recipe of recipes) {
    const project = new ProjectStore(fixture.state);
    const assets = new InMemoryAssetRepository();
    assets.put(fixture.asset.descriptor, fixture.asset.bytes);
    const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
    const text = createIntentTextEncoder();
    bus.execute(
      prepareProjectIntent({
        version: 1,
        command: { addMixedFilament: { filament: mixedFilamentWire(recipe, text) } },
      }),
    );
    const stored = project.getSnapshot().state.filaments.mixed.find((filament) => filament.id === recipe.id);
    assert.equal(canonicalStringify(stored), canonicalStringify(recipe), recipe.id);
  }
});

console.log(`intent wire tests passed: ${passed}`);
