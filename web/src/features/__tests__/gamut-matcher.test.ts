import assert from 'node:assert';
import { GamutMatcher, MatchQuality } from '../GamutMatcher';
import { MixedFilamentStore } from '../MixedFilamentStore';
import { FullSpectrumGamut } from '../FullSpectrumGamut';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---- GamutMatcher Tests ---------------------------------------------------

test('GamutMatcher: enumerateGamut generates physical and blend candidates', () => {
  const physical = ['#FF0000', '#0000FF'];
  const gamut = GamutMatcher.enumerateGamut(physical, 25);
  // Physical: 2 candidates
  // Blend: 1 pair (0, 1) with steps 25%, 50%, 75% -> 3 candidates
  // Total = 5 candidates
  assert.equal(gamut.length, 5);
  assert.equal(gamut[0].recipe.type, 'Physical');
  assert.equal(gamut[1].recipe.type, 'Physical');
  assert.equal(gamut[2].recipe.type, 'Blend');
  if (gamut[2].recipe.type === 'Blend') {
    assert.equal(gamut[2].recipe.componentA1, 1);
    assert.equal(gamut[2].recipe.componentB1, 2);
    assert.equal(gamut[2].recipe.mixBPercent, 25);
  }
});

test('GamutMatcher: matchModelColors matches exact physical filament', () => {
  const physical = ['#FF0000', '#0000FF', '#00FF00', '#FFFFFF'];
  const modelColors = ['#FF0000', '#0000FF'];
  const matches = GamutMatcher.matchModelColors(modelColors, physical);

  assert.equal(matches.length, 2);
  assert.equal(matches[0].recipe.type, 'Physical');
  assert.equal(matches[0].quality, MatchQuality.EXACT);
  assert.ok(matches[0].deltaE <= 1.0);

  assert.equal(matches[1].recipe.type, 'Physical');
  assert.equal(matches[1].quality, MatchQuality.EXACT);
});

test('GamutMatcher: matchModelColors creates Blend recipe for non-matching color', () => {
  const physical = ['#FF0000', '#0000FF']; // Red and Blue installed
  const modelColors = ['#800080']; // Purple model color (blend of Red and Blue)
  const matches = GamutMatcher.matchModelColors(modelColors, physical, 10);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].recipe.type, 'Blend');
  if (matches[0].recipe.type === 'Blend') {
    assert.equal(matches[0].recipe.componentA1, 1);
    assert.equal(matches[0].recipe.componentB1, 2);
    assert.ok(matches[0].recipe.mixBPercent > 0 && matches[0].recipe.mixBPercent < 100);
  }
});

test('GamutMatcher: applyGamutMatches generates valid virtual rows', () => {
  const physical = ['#FF0000', '#0000FF'];
  const modelColors = ['#800080'];
  const matches = GamutMatcher.matchModelColors(modelColors, physical, 10);
  const result = GamutMatcher.applyGamutMatches([{ colorHex: '#800080' }], [], matches);

  assert.equal(result.virtualRows.length, 1);
  assert.equal(result.virtualRows[0].componentA, 1);
  assert.equal(result.virtualRows[0].componentB, 2);
  assert.equal(result.virtualRows[0].custom, true);

  const store = new MixedFilamentStore();
  const serialized = store.serializeMixedFilamentDefinitions(result.virtualRows);
  assert.ok(serialized.includes('1,2,1,1,'));
});

test('FullSpectrumGamut: build and materialize gamut mappings', () => {
  const physical = ['#FF0000', '#0000FF'];
  const built = FullSpectrumGamut.build(physical);
  assert.equal(built.physicalCount, 2);
  assert.equal(built.paletteSlots.length, 2);
});

console.log(`\ngamut-matcher.test.ts: ${passed} tests passed`);
