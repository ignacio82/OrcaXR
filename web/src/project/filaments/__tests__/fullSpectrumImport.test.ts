import assert from 'node:assert/strict';

import { entityId } from '../../domain/ids';
import type { PhysicalFilament } from '../../domain/model';
import { importFullSpectrumDefinitions } from '../fullSpectrumImport';
import { serializeFullSpectrumDefinition } from '../fullSpectrumRecipe';

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

function parse(rows: string, physical = physicalLibrary(4)) {
  return {
    physical,
    result: importFullSpectrumDefinitions(rows, physical, {
      createId: (rowIndex, stableId) => entityId<'mixed-filament'>(`import:test:mixed-${rowIndex + 1}-${stableId}`),
      mixedMaterials: [
        { name: 'Imported ratio', color: '#AABBCC' },
        { name: 'Imported cycle', color: '#BBCCDD' },
        { name: 'Imported match', color: '#CCDDEE' },
        { name: 'Imported gradient', color: '#DDEEFF' },
      ],
    }),
  };
}

test('reconstructs and canonically reserializes Ratio, grouped Cycle, Match, and Gradient rows', () => {
  const rows = [
    '1,2,1,1,42,0,g123,w25/50/25,m0,z0,xa0.125,xb-2,d0,o0,u42,cm0',
    '1,2,1,1,17,0,g,w,m2,z0,xa0,xb0,d0,o0,u77,cm1,31,243',
    '2,3,1,1,50,0,g231,w50/30/20,m0,z0,xa0,xb0,d0,o0,u88,cm2',
    '1,2,1,1,50,0,g,w,m0,z2,xa0,xb0,d0,o0,u99,cm3,r1/0.8000/0.2000',
  ].join(';');
  const { physical, result } = parse(rows);
  assert.equal(result.filaments.length, 4);
  assert.deepEqual(
    result.filaments.map((filament) => filament.distribution.mode),
    ['ratio', 'cycle', 'match', 'gradient'],
  );
  assert.deepEqual(result.filaments[1].fullSpectrum?.manualPatternGroups, [
    [physical[2].id, physical[0].id],
    [physical[1].id, physical[3].id, physical[2].id],
  ]);
  assert.deepEqual(
    result.filaments.map((filament) => serializeFullSpectrumDefinition(filament, physical)),
    rows.split(';'),
  );
  assert.equal(result.filaments[0].name, 'Imported ratio');
  assert.equal(result.filaments[0].displayColor, '#AABBCC');
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /does not persist the Match target/);
});

test('normalizes legacy rows, zero and duplicate stable IDs, and compiled-out pointillisme', () => {
  const rows = ['1,2,1,25', '1,2,1,1,50,1,g,m1,z0,xa0,xb0,d0,o0,u0', '1,2,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u1'].join(
    ';',
  );
  const { physical, result } = parse(rows);
  assert.equal(result.filaments.length, 3);
  const stableIds = result.filaments.map((filament) => filament.fullSpectrum?.upstreamStableId);
  assert.equal(new Set(stableIds).size, 3);
  assert.ok(stableIds.every((id) => id !== '0'));
  assert.equal(result.filaments[1].fullSpectrum?.pointillismAllFilaments, false);
  assert.equal(result.filaments[1].fullSpectrum?.distributionMode, 2);
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /pointillisme|stable ID/i);
  for (const filament of result.filaments) {
    assert.doesNotThrow(() => serializeFullSpectrumDefinition(filament, physical));
  }
});

test('keeps deleted/auto-origin lifecycle distinct and does not consume an enabled material row', () => {
  const physical = physicalLibrary(2);
  const result = importFullSpectrumDefinitions(
    ['1,2,1,0,50,0,g,w,m2,z0,xa0,xb0,d1,o1,u5', '1,2,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u6'].join(';'),
    physical,
    {
      createId: (rowIndex) => entityId<'mixed-filament'>(`import:test:lifecycle-${rowIndex}`),
      mixedMaterials: [{ name: 'Only enabled material', color: '#123456' }],
    },
  );
  assert.equal(result.filaments[0].enabled, false);
  assert.equal(result.filaments[0].fullSpectrum?.deleted, true);
  assert.equal(result.filaments[0].fullSpectrum?.custom, false);
  assert.equal(result.filaments[0].fullSpectrum?.originAuto, true);
  assert.equal(result.filaments[1].name, 'Only enabled material');
});

test('skips malformed pairs, missing gradient tools, and invalid manual patterns with located row issues', () => {
  const { result } = parse(
    [
      '1,1,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u1',
      '1,2,1,1,50,0,g9,w100,m2,z0,xa0,xb0,d0,o0,u2',
      '1,2,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u3,cm1,[100]',
    ].join(';'),
  );
  assert.equal(result.filaments.length, 0);
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.rowIndex),
    [0, 1, 2],
  );
});

test('decodes extended physical IDs and preserves grouped stable intent', () => {
  const physical = physicalLibrary(12);
  const row = '1,2,1,1,0,0,g1/12/3,w20/30/50,m0,z0,xa0,xb0,d0,o0,u12,cm0';
  const result = importFullSpectrumDefinitions(row, physical, {
    createId: () => entityId<'mixed-filament'>('import:test:extended'),
  });
  assert.equal(result.filaments.length, 1);
  assert.deepEqual(result.filaments[0].fullSpectrum?.gradientComponentIds, [
    physical[0].id,
    physical[11].id,
    physical[2].id,
  ]);
  assert.equal(serializeFullSpectrumDefinition(result.filaments[0], physical), row);
});

console.log(`fullSpectrumImport: ${passed} tests passed`);
