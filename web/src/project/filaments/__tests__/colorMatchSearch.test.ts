import assert from 'node:assert/strict';

import {
  SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE,
  arePinnedFilamentCategoriesCompatible,
  classifyPinnedFilamentType,
  generateSuppliedPaletteMatchCandidates,
  pinnedColorDeltaE2000,
  searchSuppliedPaletteColorMatch,
} from '../colorMatchSearch';
import {
  ORCA_INVALID_COLOR_FALLBACK,
  blendMultiFilamentPigment,
  blendPairFilamentPigment,
  filamentRgbToHex,
  mixFilamentPigmentRgb,
  parseOrcaMixedColor,
} from '../filamentPigmentMixer';
import { COEF, INTERCEPT, N_FEATURES, N_INPUTS, POWERS } from '../filamentMixerModel';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const RGB_PALETTE = Object.freeze([
  Object.freeze({ color: '#FF0000', filamentType: 'PLA' }),
  Object.freeze({ color: '#00FF00', filamentType: 'PLA' }),
  Object.freeze({ color: '#0000FF', filamentType: 'PLA' }),
]);

test('keeps the generated degree-four pigment model structurally complete', () => {
  assert.equal(N_FEATURES, 330);
  assert.equal(N_INPUTS, 7);
  assert.equal(POWERS.length, 330 * 7);
  assert.equal(COEF.length, 330 * 3);
  assert.equal(INTERCEPT.length, 3);
});

test('matches pinned C++ filament_mixer::lerp byte vectors', () => {
  const vectors = [
    [[0, 33, 133], [252, 211, 0], 0.5, [47, 141, 56]],
    [[255, 0, 0], [0, 0, 255], 0.01, [255, 0, 33]],
    [[255, 0, 0], [0, 0, 255], 0.37, [143, 0, 81]],
    [[12, 34, 56], [210, 180, 90], 0.73, [130, 145, 91]],
    [[38, 166, 154], [255, 255, 255], Math.fround(1 / 3), [97, 200, 191]],
    [[4, 250, 91], [199, 17, 233], 0.99, [179, 22, 238]],
  ] as const;
  for (const [left, right, ratio, expected] of vectors) {
    assert.deepEqual(mixFilamentPigmentRgb(left, right, ratio), expected);
  }
  assert.deepEqual(mixFilamentPigmentRgb([1, 2, 3], [4, 5, 6], 0), [1, 2, 3]);
  assert.deepEqual(mixFilamentPigmentRgb([1, 2, 3], [4, 5, 6], 1), [4, 5, 6]);
});

test('preserves source color fallback, formatting, and sequential multi-blend order', () => {
  assert.deepEqual(parseOrcaMixedColor('not-a-color'), [38, 166, 154]);
  assert.equal(filamentRgbToHex(parseOrcaMixedColor('not-a-color')), ORCA_INVALID_COLOR_FALLBACK);
  assert.equal(blendPairFilamentPigment('#002185', '#FCD300', 0.5), '#2F8D38');
  assert.equal(
    blendMultiFilamentPigment([
      ['#FF0000', 50],
      ['#00FF00', 25],
      ['#0000FF', 25],
    ]),
    '#7A3834',
  );
  assert.notEqual(
    blendMultiFilamentPigment([
      ['#0000FF', 25],
      ['#00FF00', 25],
      ['#FF0000', 50],
    ]),
    '#7A3834',
    'the pinned polynomial blend is deliberately sequential and non-associative',
  );
});

test('classifies every pinned filament family and applies the bundled compatibility matrix', () => {
  assert.equal(classifyPinnedFilamentType(' pla-cf '), 'PLA');
  assert.equal(classifyPinnedFilamentType('pctg'), 'PETG');
  assert.equal(classifyPinnedFilamentType('PA-CF'), 'PA');
  assert.equal(classifyPinnedFilamentType('PVA'), 'SUPPORT');
  assert.equal(classifyPinnedFilamentType('silk'), null);

  assert.equal(arePinnedFilamentCategoriesCompatible('PLA', 'PLA'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('PLA', 'PC'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('PC', 'PLA'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('PLA', 'PETG'), false);
  assert.equal(arePinnedFilamentCategoriesCompatible('PETG', 'TPU'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('TPU', 'PET'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('SUPPORT', 'SUPPORT'), true);
  assert.equal(arePinnedFilamentCategoriesCompatible('SUPPORT', 'PLA'), false);
});

test('matches compiled pinned ColorSpaceConvert ΔE00 vectors within one float epsilon', () => {
  const vectors = [
    ['#FFFFFF', '#000000', 100],
    ['#123456', '#ABCDEF', 59.9352455],
    ['#9E6916', '#A0690E', 0.816827178],
    ['#52513D', '#50533D', 2.34505606],
  ] as const;
  for (const [first, second, expected] of vectors) {
    assert.ok(Math.abs(pinnedColorDeltaE2000(first, second) - expected) < 1e-6);
  }
});

test('generates source-ordered 50:50 pairs and exact cycle-rendered triple presets', () => {
  const result = generateSuppliedPaletteMatchCandidates({
    palette: RGB_PALETTE,
    minComponentPercent: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverage, SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE);
  assert.deepEqual(
    result.candidates.map((candidate) => [
      candidate.kind,
      candidate.components.map(({ toolId, weight }) => [toolId, weight]),
      candidate.previewColor,
    ]),
    [
      [
        'pair',
        [
          [1, 50],
          [2, 50],
        ],
        '#9A7208',
      ],
      [
        'pair',
        [
          [1, 50],
          [3, 50],
        ],
        '#6F006E',
      ],
      [
        'pair',
        [
          [2, 50],
          [3, 50],
        ],
        '#008765',
      ],
      [
        'triple',
        [
          [1, 34],
          [2, 33],
          [3, 33],
        ],
        '#50533D',
      ],
      [
        'triple',
        [
          [1, 50],
          [2, 25],
          [3, 25],
        ],
        '#7A3834',
      ],
      [
        'triple',
        [
          [2, 50],
          [1, 25],
          [3, 25],
        ],
        '#437D30',
      ],
      [
        'triple',
        [
          [3, 50],
          [1, 25],
          [2, 25],
        ],
        '#37445E',
      ],
    ],
  );
  assert.equal(result.candidates[3].projection.gradient_component_ids, '123');
  assert.equal(result.candidates[3].projection.gradient_component_weights, '34/33/33');
  assert.equal(result.candidates[3].deltaE2000, null);

  const highMinimum = generateSuppliedPaletteMatchCandidates({
    palette: RGB_PALETTE,
    minComponentPercent: 34,
  });
  assert.deepEqual(
    highMinimum.candidates.map((candidate) => candidate.kind),
    ['pair', 'pair', 'pair'],
  );
});

test('filters preset candidates by pairwise material compatibility before pigment work', () => {
  const mixed = generateSuppliedPaletteMatchCandidates({
    palette: [
      { color: '#FF0000', filamentType: 'PLA' },
      { color: '#00FF00', filamentType: 'PETG' },
      { color: '#0000FF', filamentType: 'PC' },
    ],
    minComponentPercent: 1,
  });
  assert.equal(mixed.ok, true);
  assert.deepEqual(
    mixed.candidates.map((candidate) => candidate.components.map((component) => component.toolId)),
    [
      [1, 3],
      [2, 3],
    ],
  );
});

test('finds non-coarse pair percentages and exits before triple search at ΔE ≤ 0.5', () => {
  const palette = [
    { color: '#002185', filamentType: 'PLA' },
    { color: '#FCD300', filamentType: 'PLA' },
    { color: '#FF00FF', filamentType: 'PLA' },
  ] as const;
  const target = blendPairFilamentPigment(palette[0].color, palette[1].color, Math.fround(17 / 100));
  const result = searchSuppliedPaletteColorMatch({
    palette,
    targetColor: target,
    minComponentPercent: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipe?.kind, 'pair');
  assert.deepEqual(result.recipe?.components, [
    { toolId: 1, weight: 83 },
    { toolId: 2, weight: 17 },
  ]);
  assert.equal(result.recipe?.previewColor, target);
  assert.equal(result.recipe?.deltaE2000, 0);
  assert.equal(result.stats.earlyPairExit, true);
  assert.equal(result.stats.tripleCoarseEvaluations, 0);
  assert.equal(result.stats.tripleFineEvaluations, 0);
});

test('uses the exact minimum grid and refuses out-of-range component percentages', () => {
  const palette = [
    { color: '#002185', filamentType: 'PLA' },
    { color: '#FCD300', filamentType: 'PLA' },
  ] as const;
  const belowRangeTarget = blendPairFilamentPigment(palette[0].color, palette[1].color, Math.fround(10 / 100));
  const result = searchSuppliedPaletteColorMatch({
    palette,
    targetColor: belowRangeTarget,
    minComponentPercent: 15,
  });
  assert.equal(result.ok, true);
  assert.ok(result.recipe);
  assert.ok(result.recipe.components.every((component) => component.weight >= 15));
  assert.equal(result.stats.pairCoarseEvaluations, 15);
  assert.deepEqual(result.stats.candidatePoolToolIds, [1, 2]);
  assert.equal(result.stats.tripleCoarseEvaluations, 0, 'two colors cannot enter triple search');
});

test('searches exact ascending-ID triple pigment weights and emits the authoring projection', () => {
  const target = blendMultiFilamentPigment([
    [RGB_PALETTE[0].color, 34],
    [RGB_PALETTE[1].color, 33],
    [RGB_PALETTE[2].color, 33],
  ]);
  assert.equal(target, '#52513D');
  const result = searchSuppliedPaletteColorMatch({
    palette: RGB_PALETTE,
    targetColor: target,
    minComponentPercent: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipe?.kind, 'triple');
  assert.deepEqual(result.recipe?.components, [
    { toolId: 1, weight: 34 },
    { toolId: 2, weight: 33 },
    { toolId: 3, weight: 33 },
  ]);
  assert.equal(result.recipe?.previewColor, target);
  assert.equal(result.recipe?.deltaE2000, 0);
  assert.deepEqual(result.stats.candidatePoolToolIds, [1, 2, 3]);
  assert.ok(result.stats.tripleCoarseEvaluations > 0);
  assert.ok(result.stats.tripleFineEvaluations > 0);
  assert.equal(result.recipe?.projection.gradient_component_ids, '123');
  assert.equal(result.recipe?.projection.gradient_component_weights, '34/33/33');
});

test('prefers a pair when a superior triple gains no more than the pinned 0.5 ΔE threshold', () => {
  const palette = [
    { color: '#FF0000', filamentType: 'PLA' },
    { color: '#00FF00', filamentType: 'PLA' },
    { color: '#10F010', filamentType: 'PLA' },
  ] as const;
  const target = '#9E6916';
  const result = searchSuppliedPaletteColorMatch({
    palette,
    targetColor: target,
    minComponentPercent: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipe?.kind, 'pair');
  assert.equal(result.stats.earlyPairExit, false);
  assert.ok(result.stats.tripleFineEvaluations > 0);

  const superiorTriple = blendMultiFilamentPigment([
    [palette[0].color, 55],
    [palette[1].color, 32],
    [palette[2].color, 13],
  ]);
  const tripleDelta = pinnedColorDeltaE2000(target, superiorTriple);
  assert.ok(result.recipe);
  assert.ok(tripleDelta < result.recipe.deltaE2000!);
  assert.ok(result.recipe.deltaE2000! <= tripleDelta + 0.5);
});

test('reports missing compatibility data and incompatible palettes without guessing', () => {
  const unknown = searchSuppliedPaletteColorMatch({
    palette: [
      { color: '#FF0000', filamentType: 'PLA' },
      { color: '#00FF00', filamentType: 'Silk' },
    ],
    targetColor: '#808080',
    minComponentPercent: 1,
  });
  assert.equal(unknown.ok, false);
  assert.deepEqual(
    unknown.issues.map((issue) => [issue.code, issue.path]),
    [['invalid-filament-type', 'palette[1].filamentType']],
  );

  const incompatible = searchSuppliedPaletteColorMatch({
    palette: [
      { color: '#FF0000', filamentType: 'PLA' },
      { color: '#00FF00', filamentType: 'PETG' },
    ],
    targetColor: '#808080',
    minComponentPercent: 1,
  });
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.recipe, null);
  assert.deepEqual(
    incompatible.issues.map((issue) => issue.code),
    ['no-compatible-recipe'],
  );
  assert.equal(incompatible.stats.pairCoarseEvaluations, 0);
});

test('validates supplied palette/target/minimum and returns frozen deterministic results', () => {
  const invalid = searchSuppliedPaletteColorMatch({
    palette: [
      { color: 'red', filamentType: 'PLA' },
      { color: '#00FF00', filamentType: 'PLA' },
    ],
    targetColor: '#12345',
    minComponentPercent: 51,
  });
  assert.deepEqual(
    invalid.issues.map((issue) => [issue.code, issue.path]),
    [
      ['invalid-min-component-percent', 'minComponentPercent'],
      ['invalid-palette-color', 'palette[0].color'],
      ['invalid-target-color', 'targetColor'],
    ],
  );

  const input = {
    palette: RGB_PALETTE,
    targetColor: '#52513D',
    minComponentPercent: 1,
  } as const;
  const first = searchSuppliedPaletteColorMatch(input);
  const second = searchSuppliedPaletteColorMatch(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.stats), true);
  assert.equal(Object.isFrozen(first.stats.candidatePoolToolIds), true);
  assert.equal(Object.isFrozen(first.recipe), true);
  assert.equal(Object.isFrozen(first.recipe?.components), true);
  assert.equal(pinnedColorDeltaE2000('#FFFFFF', '#000000'), 100);
});

console.log(`\nPinned supplied-palette Match search: ${passed} tests passed.`);
