import assert from 'node:assert/strict';

import { entityId } from '../../domain/ids';
import type { PhysicalFilament } from '../../domain/model';
import { fullSpectrumMaterialCategory, inspectFullSpectrumCompatibility } from '../fullSpectrumCompatibility';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function filament(index: number, material: string): PhysicalFilament {
  return {
    id: entityId<'physical-filament'>(`import:test:compatibility-${index}`),
    name: `${material} ${index}`,
    toolId: index,
    material,
    color: '#123456',
    config: {},
    enabled: true,
  };
}

test('maps every pinned material alias and rejects unknown categories', () => {
  for (const [material, category] of [
    ['PLA', 'PLA'],
    ['pla-cf', 'PLA'],
    ['PETG-CF', 'PETG'],
    ['PCTG', 'PETG'],
    ['PA-CF', 'PA'],
    ['BVOH', 'SUPPORT'],
    ['PVA', 'SUPPORT'],
  ] as const) {
    assert.equal(fullSpectrumMaterialCategory(material), category);
  }
  assert.equal(fullSpectrumMaterialCategory('HIPS'), undefined);
});

test('matches the pinned symmetric category compatibility matrix', () => {
  const categories = ['PLA', 'ABS', 'ASA', 'PETG', 'TPU', 'PET', 'PA', 'PC', 'PVA'] as const;
  const physical = categories.map((material, index) => filament(index, material));
  const expectedCompatible = new Set([
    'PLA/PLA',
    'PLA/PC',
    'ABS/ABS',
    'ABS/ASA',
    'ABS/PETG',
    'ABS/PET',
    'ABS/PC',
    'ABS/PA',
    'ASA/ASA',
    'ASA/PETG',
    'ASA/PET',
    'ASA/PC',
    'ASA/PA',
    'PETG/PETG',
    'PETG/TPU',
    'PETG/PET',
    'PETG/PC',
    'TPU/TPU',
    'TPU/PET',
    'PET/PET',
    'PET/PC',
    'PA/PA',
    'PA/PC',
    'PC/PC',
    'PVA/PVA',
  ]);
  for (let first = 0; first < physical.length; first += 1) {
    for (let second = first; second < physical.length; second += 1) {
      const pair = `${categories[first]}/${categories[second]}`;
      const reverse = `${categories[second]}/${categories[first]}`;
      const expected = expectedCompatible.has(pair) || expectedCompatible.has(reverse);
      assert.equal(
        inspectFullSpectrumCompatibility(physical, [physical[first].id, physical[second].id]).allowed,
        expected,
        pair,
      );
    }
  }
});

test('returns actionable missing, unknown, and incompatible component decisions', () => {
  const physical = [filament(0, 'PLA'), filament(1, 'PETG'), filament(2, 'HIPS')];
  const incompatible = inspectFullSpectrumCompatibility(physical, [physical[0].id, physical[1].id]);
  assert.equal(incompatible.allowed, false);
  if (!incompatible.allowed) assert.match(incompatible.reason, /PLA and PETG/);

  const unknown = inspectFullSpectrumCompatibility(physical, [physical[0].id, physical[2].id]);
  assert.equal(unknown.allowed, false);
  if (!unknown.allowed) assert.match(unknown.reason, /not in the pinned compatibility table/);

  const missing = inspectFullSpectrumCompatibility(physical, [entityId<'physical-filament'>('import:test:missing')]);
  assert.equal(missing.allowed, false);
  if (!missing.allowed) assert.match(missing.reason, /missing/);
});

console.log(`fullSpectrumCompatibility: ${passed} tests passed`);
