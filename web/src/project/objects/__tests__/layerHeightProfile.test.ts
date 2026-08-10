import assert from 'node:assert/strict';

import {
  DEFAULT_HEIGHT_PROFILE_SMOOTHING,
  LayerHeightProfileError,
  PINNED_LAYER_HEIGHT_SOURCE,
  adaptiveLayerHeightProfile,
  adjustLayerHeightProfile,
  baseLayerHeightProfile,
  layerHeightAt,
  objectLayersFromProfile,
  smoothHeightProfile,
  type LayerHeightSlicingParameters,
} from '../layerHeightProfile';
import {
  decodeLayerHeightsProfile,
  encodeLayerHeightsProfile,
  LAYER_HEIGHTS_PROFILE_PATH,
} from '../../serialization/layerHeightsProfile';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PARAMETERS: LayerHeightSlicingParameters = Object.freeze({
  layerHeightMm: 0.2,
  minLayerHeightMm: 0.08,
  maxLayerHeightMm: 0.28,
  firstObjectLayerHeightMm: 0.2,
  firstObjectLayerHeightFixed: true,
  objectHeightMm: 20,
});

function heights(profile: readonly number[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < profile.length; index += 2) result.push(profile[index]);
  return result;
}

function zValues(profile: readonly number[]): number[] {
  const result: number[] = [];
  for (let index = 0; index < profile.length; index += 2) result.push(profile[index]);
  return result;
}

test('pins the upstream source', () => {
  assert.equal(PINNED_LAYER_HEIGHT_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.equal(LAYER_HEIGHTS_PROFILE_PATH, 'Metadata/layer_heights_profile.txt');
  assert.equal(DEFAULT_HEIGHT_PROFILE_SMOOTHING.radius, 5);
  assert.equal(DEFAULT_HEIGHT_PROFILE_SMOOTHING.keepMin, false);
});

test('the base profile pins a fixed first layer and is flat above it', () => {
  const profile = baseLayerHeightProfile(PARAMETERS);
  assert.deepEqual(profile, [0, 0.2, 0.2, 0.2, 20, 0.2]);

  // Without a fixed first layer the profile is just the two end points.
  const free = baseLayerHeightProfile({ ...PARAMETERS, firstObjectLayerHeightFixed: false });
  assert.deepEqual(free, [0, 0.2, 20, 0.2]);
});

test('the height at a Z interpolates between the surrounding pairs', () => {
  const profile = [0, 0.1, 10, 0.3];
  assert.equal(layerHeightAt(profile, 0, 0.2), 0.1);
  assert.ok(Math.abs(layerHeightAt(profile, 5, 0.2) - 0.2) < 1e-12, 'half way is half way');
  assert.equal(layerHeightAt(profile, 10, 0.2), 0.3);
  assert.equal(layerHeightAt(profile, 99, 0.2), 0.3, 'past the end holds the last height');
});

test('increase raises the height locally and leaves the rest alone', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const edited = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.05,
    bandWidthMm: 4,
    action: 'increase',
  });

  assert.ok(layerHeightAt(edited, 10, 0.2) > 0.2 + 1e-6, 'the edit centre rose');
  // Outside the band nothing moved.
  assert.ok(Math.abs(layerHeightAt(edited, 1, 0.2) - 0.2) < 1e-9);
  assert.ok(Math.abs(layerHeightAt(edited, 18, 0.2) - 0.2) < 1e-9);
  // The profile stays sorted, paired, and inside the printer's limits.
  const zs = zValues(edited);
  for (let index = 1; index < zs.length; index += 1) assert.ok(zs[index] >= zs[index - 1], 'Z is monotonic');
  for (const height of heights(edited)) {
    assert.ok(height >= PARAMETERS.minLayerHeightMm - 1e-9 && height <= PARAMETERS.maxLayerHeightMm + 1e-9);
  }
});

test('the edit falls off as a raised cosine across the band', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const edited = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.06,
    bandWidthMm: 4,
    action: 'increase',
  });
  const centre = layerHeightAt(edited, 10, 0.2) - 0.2;
  const quarter = layerHeightAt(edited, 11, 0.2) - 0.2;
  const edge = layerHeightAt(edited, 12, 0.2) - 0.2;
  assert.ok(centre > quarter && quarter > edge, 'the effect decreases outward');
  // cos at a quarter band is exactly half the peak.
  assert.ok(Math.abs(quarter / centre - 0.5) < 0.05, `quarter/centre was ${quarter / centre}`);
  assert.ok(Math.abs(edge) < 1e-6, 'the band edge is untouched');
});

test('an edit already at a limit changes nothing at all', () => {
  const maxed = [0, 0.28, 0.28, 0.28, 20, 0.28];
  const unchanged = adjustLayerHeightProfile(
    maxed,
    { ...PARAMETERS, firstObjectLayerHeightMm: 0.28 },
    {
      zMm: 10,
      thicknessDeltaMm: 0.05,
      bandWidthMm: 4,
      action: 'increase',
    },
  );
  assert.deepEqual(unchanged, maxed, 'no resampling for an edit that cannot apply');

  // Outside the editable span is also a no-op, not an error.
  const base = baseLayerHeightProfile(PARAMETERS);
  assert.deepEqual(
    adjustLayerHeightProfile(base, PARAMETERS, {
      zMm: 25,
      thicknessDeltaMm: 0.05,
      bandWidthMm: 4,
      action: 'increase',
    }),
    base,
  );
});

test('reduce moves an edited profile back toward the base height', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const raised = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.06,
    bandWidthMm: 4,
    action: 'increase',
  });
  const before = layerHeightAt(raised, 10, 0.2);
  const reduced = adjustLayerHeightProfile(raised, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.06,
    bandWidthMm: 4,
    action: 'reduce',
  });
  const after = layerHeightAt(reduced, 10, 0.2);
  assert.ok(after < before, 'reduce moved it down');
  assert.ok(after >= 0.2 - 1e-6, 'but never past the base height');
});

test('decrease is increase with the sign flipped', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const lowered = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.05,
    bandWidthMm: 4,
    action: 'decrease',
  });
  assert.ok(layerHeightAt(lowered, 10, 0.2) < 0.2 - 1e-6);
});

test('the smooth action evens out a step without changing the ends', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const stepped = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.08,
    bandWidthMm: 1,
    action: 'increase',
  });
  const roughness = (profile: readonly number[]) => {
    const values = heights(profile);
    let total = 0;
    for (let index = 1; index < values.length; index += 1) total += Math.abs(values[index] - values[index - 1]);
    return total;
  };
  const smoothed = adjustLayerHeightProfile(stepped, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.08,
    bandWidthMm: 4,
    action: 'smooth',
  });
  assert.ok(roughness(smoothed) < roughness(stepped), 'the profile got smoother');
  assert.ok(Math.abs(layerHeightAt(smoothed, 1, 0.2) - 0.2) < 1e-6, 'far below is untouched');
});

test('the standalone smoother respects keepMin and the fixed first layer', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const varied = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.07,
    bandWidthMm: 3,
    action: 'increase',
  });
  const smoothed = smoothHeightProfile(varied, PARAMETERS);
  assert.equal(smoothed.length, varied.length, 'smoothing never changes the sample positions');
  assert.deepEqual(smoothed.slice(0, 4), varied.slice(0, 4), 'the fixed first layer is left exactly alone');

  // keepMin may only ever lower a sample.
  const kept = smoothHeightProfile(varied, PARAMETERS, { radius: 5, keepMin: true });
  for (const [index, height] of heights(kept).entries()) {
    assert.ok(height <= heights(varied)[index] + 1e-12, `sample ${index} rose under keepMin`);
  }
});

test('adaptive thins layers on shallow surfaces, not on steep ones', () => {
  const average = (profile: readonly number[]) => {
    const values = heights(profile).slice(2);
    return values.reduce((total, value) => total + value, 0) / values.length;
  };

  // A vertical wall has no stair-stepping to hide, so it takes the maximum
  // height. This is the opposite of the intuition that steep means detailed.
  const cube = average(adaptiveLayerHeightProfile(boxMesh(20), PARAMETERS, 0.5));
  assert.ok(cube > PARAMETERS.layerHeightMm, `a cube averaged ${cube}`);

  // A 63-degree cone is still steep enough to need nothing extra, so it lands
  // with the vertical wall rather than with the shallow shapes below.
  const steep = average(adaptiveLayerHeightProfile(coneMesh(20, 10), PARAMETERS, 0.5));
  assert.ok(Math.abs(steep - cube) / cube < 0.01, `a steep cone averaged ${steep} against a cube's ${cube}`);

  // Shallower surfaces stair-step worse, and the profile thins to match.
  const shallow = average(adaptiveLayerHeightProfile(coneMesh(20, 60), PARAMETERS, 0.5));
  const veryShallow = average(adaptiveLayerHeightProfile(coneMesh(20, 200), PARAMETERS, 0.5));
  assert.ok(shallow < cube, `a shallow cone averaged ${shallow}`);
  assert.ok(veryShallow < shallow, `a very shallow cone averaged ${veryShallow}`);
  assert.ok(veryShallow >= PARAMETERS.minLayerHeightMm - 1e-9, 'and never goes below the printer minimum');
});

test('the quality slider runs finest at 0 and fastest at 1', () => {
  // Pinned "Quality / Speed": 0 is the quality end. Reading it the other way
  // round would hand an operator the coarsest profile when they asked for the
  // finest.
  const cone = coneMesh(20, 60);
  const average = (factor: number) => {
    const values = heights(adaptiveLayerHeightProfile(cone, PARAMETERS, factor)).slice(2);
    return values.reduce((total, value) => total + value, 0) / values.length;
  };
  const finest = average(0);
  const middle = average(0.5);
  const fastest = average(1);
  assert.ok(finest < middle, `0 (${finest}) must be finer than 0.5 (${middle})`);
  assert.ok(middle < fastest, `0.5 (${middle}) must be finer than 1 (${fastest})`);
});

test('adaptive never steps by more than the pinned change limit', () => {
  const cone = coneMesh(20, 60);
  const profile = adaptiveLayerHeightProfile(cone, PARAMETERS, 0.5);
  const values = heights(profile);
  for (let index = 3; index < values.length; index += 1) {
    // 0.05 mm is upstream's LAYER_HEIGHT_CHANGE_STEP; the last pair is the
    // closing gap and is allowed to differ.
    if (index === values.length - 1) continue;
    assert.ok(
      Math.abs(values[index] - values[index - 1]) <= 0.05 + 1e-9,
      `step ${index} jumped by ${Math.abs(values[index] - values[index - 1])}`,
    );
  }
});

test('the layers a profile produces reach the top of the object', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const layers = objectLayersFromProfile(base, PARAMETERS);
  assert.equal(layers.length, 100, '20 mm at 0.2 mm');
  assert.ok(Math.abs(layers[layers.length - 1].printZMm - 20) < 1e-9);

  // A thinner band means more layers for the same object.
  const detailed = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 10,
    thicknessDeltaMm: 0.1,
    bandWidthMm: 6,
    action: 'decrease',
  });
  assert.ok(objectLayersFromProfile(detailed, PARAMETERS).length > layers.length, 'detail costs layers');
});

test('impossible parameters and profiles fail closed', () => {
  for (const bad of [
    { ...PARAMETERS, minLayerHeightMm: 0 },
    { ...PARAMETERS, maxLayerHeightMm: 0.01 },
    { ...PARAMETERS, objectHeightMm: 0 },
    { ...PARAMETERS, layerHeightMm: Number.NaN },
  ]) {
    assert.throws(
      () => baseLayerHeightProfile(bad),
      (error: unknown) => error instanceof LayerHeightProfileError && error.code === 'invalid-parameters',
    );
  }
  for (const bad of [[], [0, 0.2], [0, 0.2, 1]]) {
    assert.throws(
      () => smoothHeightProfile(bad, PARAMETERS),
      (error: unknown) => error instanceof LayerHeightProfileError && error.code === 'invalid-profile',
    );
  }
  assert.throws(
    () => adaptiveLayerHeightProfile(boxMesh(20), PARAMETERS, 2),
    (error: unknown) => error instanceof LayerHeightProfileError,
  );
});

test('a profile round-trips through the pinned file format', () => {
  const base = baseLayerHeightProfile(PARAMETERS);
  const edited = adjustLayerHeightProfile(base, PARAMETERS, {
    zMm: 8,
    thicknessDeltaMm: 0.05,
    bandWidthMm: 3,
    action: 'increase',
  });
  const text = encodeLayerHeightsProfile([{ objectId: 1, profile: edited }]);
  assert.match(text, /^object_id=1\|/);
  // %f is six decimals, always — desktop Orca parses nothing else.
  assert.match(text, /0\.\d{6}/);
  assert.equal(text.endsWith('\n'), true);

  const decoded = decodeLayerHeightsProfile(text);
  assert.deepEqual(decoded.warnings, []);
  assert.equal(decoded.entries.length, 1);
  assert.equal(decoded.entries[0].objectId, 1);
  assert.equal(decoded.entries[0].profile.length, edited.length);
  for (const [index, value] of decoded.entries[0].profile.entries()) {
    assert.ok(Math.abs(value - edited[index]) < 1e-6, `value ${index} survived to six decimals`);
  }
});

test('a malformed profile line is reported, never half-read', () => {
  const decoded = decodeLayerHeightsProfile(
    [
      'object_id=1|0.000000;0.200000;20.000000;0.200000',
      'garbage',
      'object_id=2|0.1;0.2;0.3',
      'object_id=0|1;2;3;4',
    ].join('\n'),
  );
  assert.equal(decoded.entries.length, 1, 'only the well-formed line is kept');
  assert.equal(decoded.warnings.length, 3);
  assert.match(decoded.warnings.join(' '), /not object_id/);
  assert.match(decoded.warnings.join(' '), /two finite z\/height pairs/);
  assert.match(decoded.warnings.join(' '), /unusable object id/);
});

test('an unwritable profile is skipped exactly as upstream skips it', () => {
  assert.equal(encodeLayerHeightsProfile([{ objectId: 1, profile: [0, 0.2] }]), '');
  assert.equal(encodeLayerHeightsProfile([{ objectId: 1, profile: [0, 0.2, 1] }]), '');
  assert.equal(encodeLayerHeightsProfile([{ objectId: 1, profile: [0, Number.NaN, 1, 0.2] }]), '');
  assert.equal(encodeLayerHeightsProfile([]), '');
});

/** An axis-aligned box from 0 to `size` in every axis. */
function boxMesh(size: number) {
  const v = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size],
    [0, size, size],
  ] as const;
  const t: [number, number, number][] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return { vertices: v.map((entry) => [...entry] as [number, number, number]), triangles: t };
}

/** A cone of `height` and base `radius`, standing on the bed. */
function coneMesh(height: number, radius: number) {
  const segments = 48;
  const vertices: [number, number, number][] = [[0, 0, 0]];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  vertices.push([0, 0, height]);
  const apex = vertices.length - 1;
  const triangles: [number, number, number][] = [];
  for (let index = 0; index < segments; index += 1) {
    const a = 1 + index;
    const b = 1 + ((index + 1) % segments);
    triangles.push([0, b, a]);
    triangles.push([a, b, apex]);
  }
  return { vertices, triangles };
}

console.log(`\nLayer height profiles: ${passed} tests passed.`);
