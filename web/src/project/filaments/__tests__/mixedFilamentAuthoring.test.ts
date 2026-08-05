import assert from 'node:assert/strict';

import {
  MATCH_RECIPE_SEARCH_COVERAGE,
  MixedFilamentAuthoringValidationError,
  buildColorMatchSequence,
  colorDeltaE2000,
  colorMatchWeightsWithinRange,
  deltaE2000Lab,
  isValidColorMatchHex,
  normalizeColorMatchHex,
  normalizeColorMatchWeights,
  normalizeRatioTriangleWeights,
  projectMixedFilamentAuthoring,
  rankColorMatchCandidates,
  ratioTriangleWireWeights,
  requireMixedFilamentAuthoring,
  type MixedFilamentAuthoringIssueCode,
} from '../mixedFilamentAuthoring';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function gcd(first: number, second: number): number {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function issueCodes(result: ReturnType<typeof projectMixedFilamentAuthoring>): MixedFilamentAuthoringIssueCode[] {
  return result.issues.map((issue) => issue.code);
}

test('exhaustively converts every two-color Ratio percent to the pinned gcd cadence', () => {
  for (let mixBPercent = 0; mixBPercent <= 100; mixBPercent += 1) {
    const projection = requireMixedFilamentAuthoring(
      { mode: 'ratio', componentIds: [1, 2], mixBPercent },
      { physicalToolCount: 2 },
    );
    const expected =
      mixBPercent === 0
        ? [1, 0]
        : mixBPercent === 100
          ? [0, 1]
          : [
              (100 - mixBPercent) / gcd(100 - mixBPercent, mixBPercent),
              mixBPercent / gcd(100 - mixBPercent, mixBPercent),
            ];
    assert.deepEqual([projection.ratio_a, projection.ratio_b], expected, `${mixBPercent}% B`);
    assert.equal(projection.mix_b_percent, mixBPercent);
    assert.equal(projection.distribution_mode, 2);
    assert.equal(projection.gradient_component_ids, '');
  }
});

test('runs the exact four-pass Ratio triangle clamp and emits integer wire weights', () => {
  assert.deepEqual(ratioTriangleWireWeights([80, 10, 10]), [80, 10, 10]);
  assert.deepEqual(ratioTriangleWireWeights([100, 0, 0]), [80, 10, 10]);
  assert.deepEqual(ratioTriangleWireWeights([0, 50, 50]), [10, 45, 45]);
  // Four passes intentionally stop here; there is no extra post-rounding clamp.
  assert.deepEqual(ratioTriangleWireWeights([15, 85, 0]), [14, 77, 9]);

  const fractional = normalizeRatioTriangleWeights([0.25, 0.25, 0.5]);
  assert.ok(Math.abs(fractional[0] - 0.25) < 1e-12);
  assert.ok(Math.abs(fractional[1] - 0.25) < 1e-12);
  assert.ok(Math.abs(fractional[2] - 0.5) < 1e-12);

  for (let first = 0; first <= 100; first += 5) {
    for (let second = 0; second <= 100 - first; second += 5) {
      const third = 100 - first - second;
      const wire = ratioTriangleWireWeights([first, second, third]);
      assert.equal(wire[0] + wire[1] + wire[2], 100, `${first}/${second}/${third}`);
      assert.deepEqual(ratioTriangleWireWeights([first, second, third]), wire);
    }
  }
});

test('projects three-color Ratio IDs and weights in legacy and extended wire forms', () => {
  const projection = requireMixedFilamentAuthoring(
    {
      mode: 'ratio',
      componentIds: [1, 10, 3],
      mixBPercent: 42,
      triangleWeightsPercent: [25, 50, 25],
    },
    { physicalToolCount: 12 },
  );
  assert.deepEqual(projection, {
    ui_mode: 0,
    component_a: 1,
    component_b: 10,
    mix_b_percent: 42,
    ratio_a: 1,
    ratio_b: 1,
    manual_pattern: '',
    gradient_component_ids: '1/10/3',
    gradient_component_weights: '25/50/25',
    distribution_mode: 0,
    local_z_max_sublayers: 0,
    gradient_enabled: false,
    gradient_start: 0.8,
    gradient_end: 0.2,
    custom: true,
  });
  assert.equal(
    requireMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: [1, 2, 3],
        mixBPercent: 50,
        triangleWeightsPercent: [1, 1, 1],
      },
      { physicalToolCount: 3 },
    ).gradient_component_ids,
    '123',
  );
  assert.equal(
    requireMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: [1, 2, 3],
        mixBPercent: 50,
        triangleWeightsPercent: [0.25, 0.25, 0.5],
      },
      { physicalToolCount: 3 },
    ).gradient_component_weights,
    '25/25/50',
  );
});

test('enforces per-mode component counts, uniqueness, available IDs, and weight shape', () => {
  const duplicate = projectMixedFilamentAuthoring(
    { mode: 'ratio', componentIds: [1, 1], mixBPercent: 50 },
    { physicalToolCount: 2 },
  );
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.issues[0].location, { path: 'componentIds[1]', componentIndex: 1 });
  assert.deepEqual(issueCodes(duplicate), ['duplicate-component']);

  const unavailable = projectMixedFilamentAuthoring(
    { mode: 'ratio', componentIds: [1, 3], mixBPercent: 50 },
    { physicalToolCount: 2 },
  );
  assert.deepEqual(unavailable.issues[0].location, { path: 'componentIds[1]', componentIndex: 1 });
  assert.deepEqual(issueCodes(unavailable), ['invalid-component-id']);

  const engineLimit = projectMixedFilamentAuthoring(
    { mode: 'ratio', componentIds: [1, 65], mixBPercent: 50 },
    { physicalToolCount: 65 },
  );
  assert.deepEqual(issueCodes(engineLimit), ['invalid-physical-tool-count', 'invalid-component-id']);
  assert.deepEqual(
    engineLimit.issues.map((issue) => issue.location.path),
    ['$options.physicalToolCount', 'componentIds[1]'],
  );

  assert.deepEqual(
    issueCodes(
      projectMixedFilamentAuthoring(
        { mode: 'ratio', componentIds: [1, 2], mixBPercent: 50, triangleWeightsPercent: [50, 50] },
        { physicalToolCount: 2 },
      ),
    ),
    ['unexpected-triangle-weights'],
  );
  assert.deepEqual(
    issueCodes(
      projectMixedFilamentAuthoring(
        { mode: 'ratio', componentIds: [1, 2, 3], mixBPercent: 50 },
        { physicalToolCount: 3 },
      ),
    ),
    ['triangle-weights-required'],
  );
});

test('projects both Gradient directions with exact endpoints, midpoint, and two-sublayer floor', () => {
  const aToB = requireMixedFilamentAuthoring(
    { mode: 'gradient', componentIds: [1, 2], direction: 'a-to-b', localZMaxSublayers: 0 },
    { physicalToolCount: 2 },
  );
  assert.deepEqual(
    [aToB.gradient_start, aToB.gradient_end, aToB.mix_b_percent, aToB.ratio_a, aToB.ratio_b],
    [0.8, 0.2, 50, 1, 1],
  );
  assert.equal(aToB.local_z_max_sublayers, 2);
  assert.equal(aToB.gradient_enabled, true);
  assert.equal(aToB.distribution_mode, 0);

  const bToA = requireMixedFilamentAuthoring(
    { mode: 'gradient', componentIds: [2, 1], direction: 'b-to-a', localZMaxSublayers: 7 },
    { physicalToolCount: 2 },
  );
  assert.deepEqual([bToA.gradient_start, bToA.gradient_end], [0.2, 0.8]);
  assert.equal(bToA.local_z_max_sublayers, 7);
});

test('reports source-located Gradient validation failures without emitting a projection', () => {
  const result = projectMixedFilamentAuthoring(
    {
      mode: 'gradient',
      componentIds: [1, 1],
      direction: 'sideways' as 'a-to-b',
      localZMaxSublayers: -1,
    },
    { physicalToolCount: 2 },
  );
  assert.equal(result.projection, null);
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.location.path]),
    [
      ['duplicate-component', 'componentIds[1]'],
      ['invalid-gradient-direction', 'direction'],
      ['invalid-sublayer-count', 'localZMaxSublayers'],
    ],
  );
});

test('matches pinned Match hex and largest-remainder normalization helpers', () => {
  assert.equal(normalizeColorMatchHex(' ab12ef '), '#AB12EF');
  assert.equal(normalizeColorMatchHex(' #a0B1c2 '), '#A0B1C2');
  assert.equal(isValidColorMatchHex('00ff88'), true);
  for (const value of ['', '#12345', '#1234567', '#12GG56', '##123456']) {
    assert.equal(isValidColorMatchHex(value), false, value);
  }

  assert.deepEqual(normalizeColorMatchWeights([1, 1, 1], 3), [34, 33, 33]);
  assert.deepEqual(normalizeColorMatchWeights([9], 3), [34, 33, 33]);
  assert.deepEqual(normalizeColorMatchWeights([0, 0, 0], 3), [100, 0, 0]);
  assert.deepEqual(normalizeColorMatchWeights([-1, 1], 2), [0, 100]);
  assert.deepEqual(normalizeColorMatchWeights([], 0), []);
  assert.throws(() => normalizeColorMatchWeights([Number.NaN], 1), RangeError);
});

test('enforces the exact Match active-component minimum rule', () => {
  assert.equal(colorMatchWeightsWithinRange([100, 0], 0), true);
  assert.equal(colorMatchWeightsWithinRange([15, 85], 15), true);
  assert.equal(colorMatchWeightsWithinRange([14, 86], 15), false);
  assert.equal(colorMatchWeightsWithinRange([100, 0], 15), false);
  assert.equal(colorMatchWeightsWithinRange([50, 50], 99), true, 'the pinned helper clamps its int input to 50');

  const below = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 14 },
        { toolId: 2, weight: 86 },
      ],
      targetColor: '#123456',
      minComponentPercent: 15,
    },
    { physicalToolCount: 2 },
  );
  assert.equal(below.ok, false);
  assert.deepEqual(
    below.issues.map((issue) => [issue.code, issue.location.path, issue.location.componentIndex]),
    [['component-below-minimum', 'components[0].weight', 0]],
  );

  const invalidMinimum = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 50 },
        { toolId: 2, weight: 50 },
      ],
      targetColor: '#123456',
      minComponentPercent: 51,
    },
    { physicalToolCount: 2 },
  );
  assert.deepEqual(
    invalidMinimum.issues.map((issue) => [issue.code, issue.location.path]),
    [['invalid-min-component-percent', 'minComponentPercent']],
  );
});

test('builds the pinned bounded and evenly distributed Match sequence', () => {
  const equal = buildColorMatchSequence([1, 2], [50, 50]);
  assert.equal(equal.length, 48);
  assert.deepEqual(equal.slice(0, 12), [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
  assert.equal(equal.filter((id) => id === 1).length, 24);
  assert.equal(equal.filter((id) => id === 2).length, 24);

  const uneven = buildColorMatchSequence([3, 1, 2], [50, 25, 25]);
  assert.equal(uneven.length, 48);
  assert.deepEqual(
    [3, 1, 2].map((id) => uneven.filter((candidate) => candidate === id).length),
    [24, 12, 12],
  );
  assert.deepEqual(buildColorMatchSequence([1], [100]), new Array<number>(48).fill(1));
  assert.deepEqual(buildColorMatchSequence([1, 2], [100]), []);
});

test('projects pair and multi-color Match recipes with deterministic wire ordering', () => {
  const pair = requireMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 15 },
        { toolId: 10, weight: 85 },
      ],
      targetColor: ' ab12ef ',
      minComponentPercent: 15,
    },
    { physicalToolCount: 10 },
  );
  assert.equal(pair.component_a, 1);
  assert.equal(pair.component_b, 10);
  assert.equal(pair.mix_b_percent, 85);
  assert.equal(pair.gradient_component_ids, '1/10');
  assert.equal(pair.gradient_component_weights, '');
  assert.equal(pair.distribution_mode, 2);

  const multiResult = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 4, weight: 10 },
        { toolId: 2, weight: 40 },
        { toolId: 3, weight: 30 },
        { toolId: 1, weight: 20 },
      ],
      targetColor: '#00ff88',
      minComponentPercent: 10,
    },
    { physicalToolCount: 4 },
  );
  assert.equal(multiResult.ok, true);
  assert.equal(multiResult.normalizedTargetColor, '#00FF88');
  assert.equal(multiResult.projection?.component_a, 2);
  assert.equal(multiResult.projection?.component_b, 3);
  assert.equal(multiResult.projection?.gradient_component_ids, '2314');
  assert.equal(multiResult.projection?.gradient_component_weights, '40/30/20/10');
  assert.equal(multiResult.projection?.distribution_mode, 0);
});

test('pinpoints invalid Match colors and rejects duplicate, excess, and inactive multi recipes', () => {
  const badColor = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 50 },
        { toolId: 2, weight: 50 },
      ],
      targetColor: ' 12XZ ',
      minComponentPercent: 0,
    },
    { physicalToolCount: 2 },
  );
  assert.deepEqual(badColor.issues[0].location, {
    path: 'targetColor',
    startOffset: 0,
    endOffset: 6,
  });

  const invalid = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 50 },
        { toolId: 1, weight: 50 },
        { toolId: 2, weight: 0 },
        { toolId: 3, weight: 0 },
        { toolId: 4, weight: 0 },
      ],
      targetColor: '#123456',
      minComponentPercent: 0,
    },
    { physicalToolCount: 4 },
  );
  assert.deepEqual(issueCodes(invalid), ['component-count', 'duplicate-component']);

  const inactiveMulti = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components: [
        { toolId: 1, weight: 100 },
        { toolId: 2, weight: 0 },
        { toolId: 3, weight: 0 },
      ],
      targetColor: '#123456',
      minComponentPercent: 0,
    },
    { physicalToolCount: 3 },
  );
  assert.deepEqual(issueCodes(inactiveMulti), ['insufficient-active-components']);
});

test('ports the pinned DeltaE2000 formula and strict sRGB conversion', () => {
  // Published CIEDE2000 conformance pairs also exercise the same pinned formula.
  const pairs: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
    [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
    [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
    [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
    [50, -1.3802, -84.2814, 50, 0, -82.7485, 1],
  ];
  for (const [l1, a1, b1, l2, a2, b2, expected] of pairs) {
    const actual = deltaE2000Lab({ L: l1, a: a1, b: b1 }, { L: l2, a: a2, b: b2 });
    assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} vs ${expected}`);
  }
  assert.equal(colorDeltaE2000('#000000', '#000000'), 0);
  assert.ok(Math.abs(colorDeltaE2000('#FFFFFF', '#000000') - 100) < 0.000001);
  assert.equal(colorDeltaE2000('#123456', '#ABCDEF'), colorDeltaE2000('#ABCDEF', '#123456'));
  assert.throws(() => colorDeltaE2000('#12345', '#000000'), RangeError);
});

test('deterministically ranks supplied pigment previews and applies the pinned pair preference', () => {
  const input = {
    physicalToolCount: 3,
    targetColor: '#808080',
    minComponentPercent: 1,
    candidates: [
      {
        components: [
          { toolId: 1, weight: 34 },
          { toolId: 2, weight: 33 },
          { toolId: 3, weight: 33 },
        ],
        previewColor: '#808080',
      },
      {
        components: [
          { toolId: 1, weight: 50 },
          { toolId: 2, weight: 50 },
        ],
        previewColor: '#808080',
      },
    ],
  } as const;
  const ranked = rankColorMatchCandidates(input);
  assert.equal(ranked.ok, true);
  assert.equal(ranked.coverage, MATCH_RECIPE_SEARCH_COVERAGE);
  assert.equal(ranked.coverage, 'supplied-candidates-only');
  assert.deepEqual(
    ranked.candidates.map((candidate) => candidate.sourceIndex),
    [1, 0],
  );
  assert.equal(ranked.candidates[0].projection.distribution_mode, 2);
  assert.equal(JSON.stringify(rankColorMatchCandidates(input)), JSON.stringify(ranked));

  const betterMulti = rankColorMatchCandidates({
    ...input,
    targetColor: '#000000',
    candidates: [
      { ...input.candidates[0], previewColor: '#000000' },
      { ...input.candidates[1], previewColor: '#FFFFFF' },
    ],
  });
  assert.equal(betterMulti.candidates[0].sourceIndex, 0);
});

test('source-locates invalid supplied previews and reports the explicit Match-search residual', () => {
  const invalid = rankColorMatchCandidates({
    physicalToolCount: 2,
    targetColor: ' 00ff88 ',
    minComponentPercent: 0,
    candidates: [
      {
        components: [
          { toolId: 1, weight: 50 },
          { toolId: 2, weight: 50 },
        ],
        previewColor: '#nope',
      },
    ],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.coverage, 'supplied-candidates-only');
  assert.deepEqual(invalid.issues[0].location, {
    path: 'candidates[0].previewColor',
    startOffset: 0,
    endOffset: 5,
  });

  const none = rankColorMatchCandidates({
    physicalToolCount: 2,
    targetColor: '#00FF88',
    minComponentPercent: 0,
    candidates: [],
  });
  assert.deepEqual(
    none.issues.map((issue) => issue.code),
    ['no-valid-candidates'],
  );
});

test('returns frozen deterministic projections and exposes a typed throwing boundary', () => {
  const input = { mode: 'ratio', componentIds: [1, 2], mixBPercent: 35 } as const;
  const first = projectMixedFilamentAuthoring(input, { physicalToolCount: 2 });
  const second = projectMixedFilamentAuthoring(input, { physicalToolCount: 2 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.issues), true);
  assert.equal(Object.isFrozen(first.projection), true);

  assert.throws(
    () =>
      requireMixedFilamentAuthoring({ mode: 'ratio', componentIds: [1, 1], mixBPercent: 50 }, { physicalToolCount: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof MixedFilamentAuthoringValidationError);
      assert.deepEqual(
        error.result.issues.map((issue) => issue.code),
        ['duplicate-component'],
      );
      return true;
    },
  );
});

console.log(`\nMixed-filament authoring: ${passed} tests passed.`);
