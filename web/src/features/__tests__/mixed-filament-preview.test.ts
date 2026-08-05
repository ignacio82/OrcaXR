/**
 * Node tests for the FullSpectrum mixed-filament preview port
 * (run: npx tsx mixed-filament-preview.test.ts).
 *
 * Anchors:
 *  - filament_mixer_model.h's own documented example (blue+yellow → green).
 *  - The PeggyPalette.3mf wire format (auto rows tombstoned with d1, custom
 *    rows with u-ids and manual patterns).
 */
import assert from 'node:assert';
import {
  filamentMixerLerp,
  blendColor,
  normalizeManualPattern,
  parseMixedFilamentDefinitions,
  mixedFilamentDisplayColor,
  virtualFilamentsFromConfig,
  fullDisplayPalette,
} from '../MixedFilamentPreview';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---- filament_mixer polynomial --------------------------------------------
test('mixer: header example blue+yellow @0.5 → (47,141,56) green', () => {
  const [r, g, b] = filamentMixerLerp(0, 33, 133, 252, 211, 0, 0.5);
  assert.deepEqual([r, g, b], [47, 141, 56]);
});
test('mixer: t=0 and t=1 return the endpoints exactly', () => {
  assert.deepEqual(filamentMixerLerp(10, 20, 30, 200, 210, 220, 0), [10, 20, 30]);
  assert.deepEqual(filamentMixerLerp(10, 20, 30, 200, 210, 220, 1), [200, 210, 220]);
});
test('blendColor: pigment blend, not sRGB average (blue+yellow is green)', () => {
  const hex = blendColor('#0000FF', '#FFFF00', 50, 50);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  assert.ok(g > b, `expected green-dominant mix, got ${hex}`);
});

// ---- manual patterns --------------------------------------------------------
test('pattern: pinned compact/bracket syntax and slash authoring normalize canonically', () => {
  assert.equal(normalizeManualPattern('14343434'), '14343434');
  assert.equal(normalizeManualPattern('[10]/2'), '[10]2');
  assert.equal(normalizeManualPattern('12,21'), '12,21');
  assert.equal(normalizeManualPattern('Ab'), '');
  assert.equal(normalizeManualPattern('1 2'), '');
  assert.equal(normalizeManualPattern('1q2'), '');
  assert.equal(normalizeManualPattern('12,'), '');
});

// ---- wire-format parsing ----------------------------------------------------
const PEGGY_DEFS =
  '1,2,0,0,50,0,g,w,m2,d1,o1,u1;1,3,0,0,50,0,g,w,m2,d1,o1,u2;' +
  '1,2,1,1,33,0,g,w,m2,d0,o0,u19,123;1,2,1,1,13,0,g,w,m2,d0,o0,u20;' +
  '1,2,1,1,0,0,g,w,m2,d0,o0,u44,14343434';

test('parse: deleted auto rows load but are disabled', () => {
  const defs = parseMixedFilamentDefinitions(PEGGY_DEFS, 4);
  assert.equal(defs.length, 5);
  assert.equal(defs[0].enabled, false);
  assert.equal(defs[0].deleted, true);
  assert.equal(defs[0].custom, false);
});
test('parse: trailing pattern token survives, u-token sets stableId', () => {
  const defs = parseMixedFilamentDefinitions(PEGGY_DEFS, 4);
  assert.equal(defs[2].manualPattern, '123');
  assert.equal(defs[2].stableId, 19);
  assert.equal(defs[4].manualPattern, '14343434');
  assert.equal(defs[4].stableId, 44);
});
test('parse: pattern overrides mixBPercent (mix_percent_from_normalized_pattern)', () => {
  const defs = parseMixedFilamentDefinitions(PEGGY_DEFS, 4);
  // "14343434": one '2'-token? none — count of '2' steps is 0 → 0%.
  assert.equal(defs[4].mixBPercent, 0);
  // "123": one of three steps is '2' → 33%.
  assert.equal(defs[2].mixBPercent, 33);
});
test('parse: rows with out-of-range or equal components are rejected', () => {
  assert.equal(parseMixedFilamentDefinitions('1,9,1,1,50', 4).length, 0);
  assert.equal(parseMixedFilamentDefinitions('2,2,1,1,50', 4).length, 0);
});

// ---- display colors ---------------------------------------------------------
const PHYS = ['#0000FF', '#FF0000', '#FFFF00', '#FFFFFF'];

test('display: simple 50/50 pair blends both components', () => {
  const defs = parseMixedFilamentDefinitions('1,3,1,1,50,0,g,w,m2,d0,o0,u5', 4);
  const hex = mixedFilamentDisplayColor(defs[0], PHYS);
  // blue+yellow at 50% — must be green-ish, i.e. G channel dominates B.
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  assert.ok(g > b, `expected green-ish, got ${hex}`);
});
test('display: 0% mix of pattern-free pair returns component A exactly', () => {
  const defs = parseMixedFilamentDefinitions('1,2,1,1,0,0,g,w,m2,d0,o0,u5', 4);
  assert.equal(mixedFilamentDisplayColor(defs[0], PHYS), '#0000FF');
});
test('display: 100% mix returns component B exactly', () => {
  const defs = parseMixedFilamentDefinitions('1,2,1,1,100,0,g,w,m2,d0,o0,u5', 4);
  assert.equal(mixedFilamentDisplayColor(defs[0], PHYS), '#FF0000');
});

// ---- project-level mapping --------------------------------------------------
const PEGGY_CFG = {
  filament_colour: PHYS,
  mixed_filament_definitions: PEGGY_DEFS,
  dithering_local_z_mode: 0,
};

test('virtuals: only enabled rows get IDs, continuing after physical', () => {
  const v = virtualFilamentsFromConfig(PEGGY_CFG);
  assert.equal(v.length, 3); // two deleted auto rows skipped
  assert.deepEqual(
    v.map((x) => x.id),
    [5, 6, 7],
  );
});
test('fullDisplayPalette: physical + virtual display colors', () => {
  const full = fullDisplayPalette(PEGGY_CFG);
  assert.equal(full.length, 7);
  assert.deepEqual(full.slice(0, 4), PHYS);
  for (const c of full.slice(4)) assert.match(c, /^#[0-9A-F]{6}$/);
});
test('virtuals: no definitions or single filament → empty', () => {
  assert.equal(virtualFilamentsFromConfig({ filament_colour: PHYS }).length, 0);
  assert.equal(
    virtualFilamentsFromConfig({ filament_colour: ['#111111'], mixed_filament_definitions: '1,2,1,1,50' }).length,
    0,
  );
});

console.log(`\nmixed-filament-preview: ${passed} tests passed`);
