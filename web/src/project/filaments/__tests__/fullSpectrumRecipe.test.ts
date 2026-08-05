import assert from 'node:assert/strict';

import { entityId } from '../../domain/ids';
import type { PhysicalFilament } from '../../domain/model';
import { assertValidProjectState } from '../../domain/validation';
import { createProjectFixture } from '../../__tests__/fixtures';
import {
  FullSpectrumRecipeValidationError,
  createFullSpectrumMixedFilament,
  replaceFullSpectrumMixedFilament,
  serializeFullSpectrumDefinition,
  stableCycleGroupsFromToolIds,
} from '../fullSpectrumRecipe';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function physicalLibrary(count: number): PhysicalFilament[] {
  return Array.from({ length: count }, (_, index) => ({
    id: entityId<'physical-filament'>(`import:test:physical-${index + 1}`),
    name: `Physical ${index + 1}`,
    toolId: index,
    material: 'PLA',
    color: `#${(index + 1).toString(16).padStart(6, '0')}`,
    config: {},
    enabled: true,
  }));
}

test('writes every three-color Ratio field exactly and remaps only transient row numbers after reorder', () => {
  const physical = physicalLibrary(3);
  const mixed = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:test:ratio'),
    physical,
    {
      mode: 'ratio',
      name: 'Three-way ratio',
      displayColor: '#123456',
      componentFilamentIds: [physical[0].id, physical[1].id, physical[2].id],
      mixBPercent: 42,
      triangleWeightsPercent: [25, 50, 25],
      componentASurfaceOffsetMm: 0.125,
      componentBSurfaceOffsetMm: -2,
    },
    '42',
  );
  assert.equal(
    serializeFullSpectrumDefinition(mixed, physical),
    '1,2,1,1,42,0,g123,w25/50/25,m0,z0,xa0.125,xb-2,d0,o0,u42,cm0',
  );

  const reordered = [physical[2], physical[0], physical[1]];
  assert.equal(
    serializeFullSpectrumDefinition(mixed, reordered),
    '2,3,1,1,42,0,g231,w25/50/25,m0,z0,xa0.125,xb-2,d0,o0,u42,cm0',
  );
  assert.deepEqual(
    mixed.components.map((component) => component.filamentId),
    [physical[0].id, physical[1].id, physical[2].id],
  );
});

test('keeps exact Cycle perimeter groups and sequence across physical-row reorder', () => {
  const physical = physicalLibrary(4);
  const groups = stableCycleGroupsFromToolIds(physical, [
    [3, 1],
    [2, 4, 3],
  ]);
  const mixed = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:test:cycle'),
    physical,
    {
      mode: 'cycle',
      name: 'Grouped cycle',
      displayColor: '#334455',
      manualPatternGroups: groups,
    },
    '77',
  );
  assert.equal(serializeFullSpectrumDefinition(mixed, physical), '1,2,1,1,17,0,g,w,m2,z0,xa0,xb0,d0,o0,u77,cm1,31,243');

  const reordered = [physical[2], physical[3], physical[0], physical[1]];
  assert.equal(
    serializeFullSpectrumDefinition(mixed, reordered),
    '1,2,1,1,17,0,g,w,m2,z0,xa0,xb0,d0,o0,u77,cm1,13,421',
  );
  assert.deepEqual(mixed.fullSpectrum?.manualPatternGroups, groups);
});

test('supports exact Ratio endpoints without inventing a non-zero component weight', () => {
  const fixture = createProjectFixture();
  const mixed = createFullSpectrumMixedFilament(
    fixture.ids.mixed,
    fixture.state.filaments.physical,
    {
      mode: 'ratio',
      name: 'All A',
      displayColor: '#FF0000',
      componentFilamentIds: [fixture.ids.physical0, fixture.ids.physical1],
      mixBPercent: 0,
    },
    '1',
  );
  assert.deepEqual(
    mixed.components.map((component) => component.weight),
    [100, 0],
  );
  assert.equal(
    serializeFullSpectrumDefinition(mixed, fixture.state.filaments.physical),
    '1,2,1,1,0,0,g,w,m2,z0,xa0,xb0,d0,o0,u1,cm0',
  );
  fixture.state.filaments.mixed = [mixed];
  assert.doesNotThrow(() => assertValidProjectState(fixture.state));
});

test('writes Match and both Gradient directions using pinned fields', () => {
  const physical = physicalLibrary(3);
  const match = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:test:match'),
    physical,
    {
      mode: 'match',
      name: 'Chosen match',
      displayColor: '#445566',
      components: [
        { filamentId: physical[0].id, weight: 20 },
        { filamentId: physical[1].id, weight: 50 },
        { filamentId: physical[2].id, weight: 30 },
      ],
      targetColor: '#445566',
      minComponentPercent: 10,
    },
    '88',
  );
  assert.equal(
    serializeFullSpectrumDefinition(match, physical),
    '2,3,1,1,50,0,g231,w50/30/20,m0,z0,xa0,xb0,d0,o0,u88,cm2',
  );
  assert.equal(match.distribution.mode, 'match');

  for (const [direction, expected] of [
    ['a-to-b', 'r1/0.8000/0.2000'],
    ['b-to-a', 'r1/0.2000/0.8000'],
  ] as const) {
    const gradient = createFullSpectrumMixedFilament(
      entityId<'mixed-filament'>(`import:test:gradient-${direction}`),
      physical,
      {
        mode: 'gradient',
        name: direction,
        displayColor: '#778899',
        componentFilamentIds: [physical[0].id, physical[1].id],
        direction,
        localZMaxSublayers: 0,
      },
      '99',
    );
    assert.equal(
      serializeFullSpectrumDefinition(gradient, physical),
      `1,2,1,1,50,0,g,w,m0,z2,xa0,xb0,d0,o0,u99,cm3,${expected}`,
    );
  }
});

test('edit replacement preserves identity, upstream stable ID, config, and opaque lifecycle metadata', () => {
  const physical = physicalLibrary(2);
  const original = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:test:edit'),
    physical,
    {
      mode: 'ratio',
      name: 'Before',
      displayColor: '#111111',
      componentFilamentIds: [physical[0].id, physical[1].id],
      mixBPercent: 50,
    },
    '12345678901234567890',
  );
  original.config = { preserved: true };
  original.extensionData = { vendor: { keep: true } };
  const edited = replaceFullSpectrumMixedFilament(original, physical, {
    mode: 'gradient',
    name: 'After',
    displayColor: '#222222',
    componentFilamentIds: [physical[1].id, physical[0].id],
    direction: 'b-to-a',
    localZMaxSublayers: 6,
    enabled: false,
  });
  assert.equal(edited.id, original.id);
  assert.equal(edited.fullSpectrum?.upstreamStableId, '12345678901234567890');
  assert.deepEqual(edited.config, { preserved: true });
  assert.deepEqual(edited.extensionData, { vendor: { keep: true } });
  assert.equal(edited.enabled, false);
  assert.equal(original.name, 'Before');
});

test('rejects disabled/missing tools, malformed groups, unsafe offsets, and uint64 overflow', () => {
  const physical = physicalLibrary(2);
  physical[1].enabled = false;
  const base = {
    mode: 'ratio' as const,
    name: 'Invalid',
    displayColor: '#123456',
    componentFilamentIds: [physical[0].id, physical[1].id],
    mixBPercent: 50,
  };
  assert.throws(
    () => createFullSpectrumMixedFilament(entityId<'mixed-filament'>('import:test:invalid'), physical, base),
    FullSpectrumRecipeValidationError,
  );
  physical[1].enabled = true;
  assert.throws(
    () =>
      createFullSpectrumMixedFilament(entityId<'mixed-filament'>('import:test:invalid-groups'), physical, {
        mode: 'cycle',
        name: 'Invalid',
        displayColor: '#123456',
        manualPatternGroups: [[]],
      }),
    /non-empty perimeter group/,
  );
  assert.throws(
    () =>
      createFullSpectrumMixedFilament(entityId<'mixed-filament'>('import:test:invalid-offset'), physical, {
        ...base,
        componentASurfaceOffsetMm: 2.01,
      }),
    /within -2 mm and 2 mm/,
  );
  assert.throws(
    () =>
      createFullSpectrumMixedFilament(
        entityId<'mixed-filament'>('import:test:invalid-stable'),
        physical,
        base,
        '18446744073709551616',
      ),
    /exceeds uint64/,
  );
});

console.log(`fullSpectrumRecipe: ${passed} tests passed`);
