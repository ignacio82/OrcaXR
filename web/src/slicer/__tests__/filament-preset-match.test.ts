import assert from 'node:assert/strict';

import {
  filamentPresetAgreesWithSlot,
  filamentPresetGrade,
  matchFilamentPreset,
  type FilamentPresetCandidate,
} from '../filamentPresetMatch';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** The U1's own PLA shelf, in the order the compiled corpus lists it. */
const U1_PLA: readonly FilamentPresetCandidate[] = Object.freeze([
  { presetId: 'generic-pla', presetName: 'Generic PLA', material: 'PLA', vendor: 'Generic' },
  { presetId: 'generic-silk', presetName: 'Generic PLA Silk', material: 'PLA', vendor: 'Generic' },
  { presetId: 'generic-support', presetName: 'Generic Support For PLA', material: 'PLA', vendor: 'Generic' },
  { presetId: 'snap-pla', presetName: 'Snapmaker PLA @U1', material: 'PLA', vendor: 'Snapmaker' },
  { presetId: 'snap-matte', presetName: 'Snapmaker PLA Matte @U1', material: 'PLA', vendor: 'Snapmaker' },
  { presetId: 'snap-snapspeed', presetName: 'Snapmaker PLA SnapSpeed @U1', material: 'PLA', vendor: 'Snapmaker' },
  { presetId: 'snap-silk', presetName: 'Snapmaker PLA Silk @U1', material: 'PLA', vendor: 'Snapmaker' },
  { presetId: 'snap-cf', presetName: 'Snapmaker PLA-CF @U1', material: 'PLA', vendor: 'Snapmaker' },
  { presetId: 'snap-petg', presetName: 'Snapmaker PETG @U1', material: 'PETG', vendor: 'Snapmaker' },
]);

test('the reported vendor and grade choose the preset, not corpus order', () => {
  assert.equal(
    matchFilamentPreset(U1_PLA, { material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' })?.presetId,
    'snap-matte',
  );
  assert.equal(
    matchFilamentPreset(U1_PLA, { material: 'PLA', subType: 'SnapSpeed', vendor: 'Snapmaker' })?.presetId,
    'snap-snapspeed',
  );
  // Separators and case are the machine's business, not an identity.
  assert.equal(
    matchFilamentPreset(U1_PLA, { material: 'pla', subType: 'snap speed', vendor: 'SNAPMAKER' })?.presetId,
    'snap-snapspeed',
  );
});

test('an unreported grade prefers the vendor’s plain preset over any grade', () => {
  assert.equal(matchFilamentPreset(U1_PLA, { material: 'PLA', vendor: 'Snapmaker' })?.presetId, 'snap-pla');
  assert.equal(matchFilamentPreset(U1_PLA, { material: 'PLA', vendor: 'Generic' })?.presetId, 'generic-pla');
});

test('a grade with no preset of its own keeps the vendor and type', () => {
  const match = matchFilamentPreset(U1_PLA, { material: 'PLA', subType: 'Nebula', vendor: 'Snapmaker' });
  assert.equal(match?.presetId, 'snap-pla');
  assert.equal(match?.vendorMatched, true);
  assert.equal(match?.gradeMatched, false);
});

test('an unreported vendor still lands on a plain preset of the reported type', () => {
  assert.equal(matchFilamentPreset(U1_PLA, { material: 'PLA' })?.presetId, 'generic-pla');
});

test('a material nothing declares is unmatched rather than guessed', () => {
  assert.equal(matchFilamentPreset(U1_PLA, { material: 'Unobtainium', vendor: 'Nobody' }), undefined);
  assert.equal(matchFilamentPreset(U1_PLA, { material: '' }), undefined);
});

test('a composite name is not read as the plain material', () => {
  // `Snapmaker PLA-CF` declares the material PLA, so a prefix test would read
  // its grade as "-CF" and offer carbon fibre as though it were plain PLA.
  assert.equal(filamentPresetGrade(U1_PLA[7]), 'PLA-CF');
  assert.equal(filamentPresetGrade(U1_PLA[3]), '');
  assert.equal(filamentPresetGrade(U1_PLA[4]), 'Matte');
  assert.equal(filamentPresetGrade(U1_PLA[2]), 'Support For PLA');
  assert.notEqual(matchFilamentPreset(U1_PLA, { material: 'PLA', vendor: 'Snapmaker' })?.presetId, 'snap-cf');
});

test('the vendor falls back to the leading name word when the preset declares none', () => {
  const undeclared: FilamentPresetCandidate = {
    presetId: 'undeclared',
    presetName: 'Snapmaker PLA Matte @U1',
    material: 'PLA',
  };
  assert.equal(
    matchFilamentPreset([undeclared], { material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' })?.vendorMatched,
    true,
  );
});

test('agreement is checked only against the facts the machine reported', () => {
  const silk = U1_PLA[6];
  assert.equal(filamentPresetAgreesWithSlot(silk, { material: 'PLA', vendor: 'Snapmaker' }), true);
  assert.equal(filamentPresetAgreesWithSlot(silk, { material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' }), false);
  assert.equal(filamentPresetAgreesWithSlot(U1_PLA[0], { material: 'PLA', vendor: 'Snapmaker' }), false);
  assert.equal(filamentPresetAgreesWithSlot(U1_PLA[0], { material: 'PLA' }), true);
  assert.equal(filamentPresetAgreesWithSlot(U1_PLA[8], { material: 'PLA', vendor: 'Snapmaker' }), false);
});

test('ranking is deterministic whatever order the corpus was compiled in', () => {
  const reversed = [...U1_PLA].reverse();
  for (const slot of [
    { material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { material: 'PLA', vendor: 'Snapmaker' },
    { material: 'PLA' },
  ]) {
    assert.equal(matchFilamentPreset(reversed, slot)?.presetId, matchFilamentPreset(U1_PLA, slot)?.presetId);
  }
});

console.log(`\nFilament preset matching: ${passed} tests passed.`);
