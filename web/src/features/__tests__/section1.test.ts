/**
 * Node tests for Section 1 pre-flight logic (run: npx tsx section1.test.ts).
 * Mirrors the Android instrumented expectations for each ported module.
 */
import assert from 'node:assert';
import { detectBedCollision, bedCollisionBanner } from '../BedCollision';
import { parseFilamentRules, bedKeyFor, evaluateFilamentRules } from '../FilamentRules';
import { evaluateTopCover } from '../TopCoverRule';
import { scoreWipeTower, aabbOf, aabbLInfClearance } from '../WipeTowerPlacement';
import { detectBambu, normalizeFilamentType, translateBambu } from '../BambuImportTranslator';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---- BedCollision ----------------------------------------------------------
// A single centered triangle well inside a 200mm bed → ok.
function tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number[] {
  return [x0, y0, 0, x1, y1, 0, x2, y2, 0];
}
test('bed: centered small mesh is ok', () => {
  const r = detectBedCollision(tri(-5, -5, 5, -5, 0, 5), 200, 200);
  assert.equal(r.kind, 'ok');
});
test('bed: recenter makes off-origin-but-fitting mesh ok', () => {
  // Positioned at x≈90..100 on a 200 bed: fits after recenter.
  const r = detectBedCollision(tri(90, -5, 100, -5, 95, 5), 200, 200);
  assert.equal(r.kind, 'ok');
});
test('bed: a wide mesh overflows X with correct worst overflow', () => {
  // 260mm-wide triangle centered → ±130, bed half=100 → worst = 30mm each side.
  const r = detectBedCollision(tri(-130, 0, 130, 0, 0, 10), 200, 200);
  assert.equal(r.kind, 'off');
  if (r.kind === 'off') {
    assert.ok(r.overflowX);
    assert.ok(!r.overflowY);
    assert.equal(r.offendingTriCount, 1);
    assert.ok(Math.abs(Math.abs(r.worstOverflowXmm) - 30) < 1e-3, `worst=${r.worstOverflowXmm}`);
  }
  assert.ok(bedCollisionBanner(r)!.includes('off-bed'));
});

// ---- FilamentRules ---------------------------------------------------------
const RULES_JSON = JSON.stringify({
  btPEI: { support: ['PLA'], warning: ['TPU'] },
  btGESP: { support: ['PLA', 'TPU'] },
  '0.4mm': { support: ['PLA'] }, // nozzle band ignored
});
test('filament: parse skips nozzle-band keys', () => {
  const rules = parseFilamentRules(RULES_JSON);
  assert.ok(rules.supportByBed['btPEI']);
  assert.ok(!rules.supportByBed['0.4mm']);
});
test('filament: bedKeyFor maps PEI/GESP', () => {
  assert.equal(bedKeyFor('Textured PEI Plate'), 'btPEI');
  assert.equal(bedKeyFor('Engineering Plate'), 'btGESP');
  assert.equal(bedKeyFor('Cool Plate'), null);
});
test('filament: PLA-CF supported on PEI (substring)', () => {
  const rules = parseFilamentRules(RULES_JSON);
  assert.equal(evaluateFilamentRules(rules, 'btPEI', ['PLA-CF']).kind, 'ok');
});
test('filament: TPU warns on PEI', () => {
  const rules = parseFilamentRules(RULES_JSON);
  assert.equal(evaluateFilamentRules(rules, 'btPEI', ['TPU 95A']).kind, 'warning');
});
test('filament: ABS forbidden on PEI, forbidden beats warning', () => {
  const rules = parseFilamentRules(RULES_JSON);
  assert.equal(evaluateFilamentRules(rules, 'btPEI', ['TPU', 'ABS']).kind, 'forbidden');
});
test('filament: null bed → ok', () => {
  const rules = parseFilamentRules(RULES_JSON);
  assert.equal(evaluateFilamentRules(rules, null, ['ABS']).kind, 'ok');
});

// ---- TopCoverRule ----------------------------------------------------------
test('topcover: absent key → ok', () => {
  assert.equal(evaluateTopCover({}).kind, 'ok');
});
test('topcover: all zero → ok', () => {
  assert.equal(evaluateTopCover({ requires_top_cover: '0,0,0,0' }).kind, 'ok');
});
test('topcover: slot 2 set → warning listing T3', () => {
  const r = evaluateTopCover({ requires_top_cover: '0,0,1,0' });
  assert.equal(r.kind, 'warning');
  if (r.kind === 'warning') {
    assert.deepEqual(r.slots, [2]);
    assert.ok(r.message.includes('T3'));
  }
});

// ---- WipeTowerPlacement ----------------------------------------------------
test('wipe: empty parts → back-left with infinite clearance', () => {
  const p = scoreWipeTower([], { xMin: 0, yMin: 0, xMax: 256, yMax: 256 });
  assert.equal(p.label, 'back-left');
  assert.equal(p.clearanceMm, Infinity);
});
test('wipe: part front-left pushes tower to back-right area', () => {
  // Big part occupying the front-left quadrant.
  const part = aabbOf(60, 60, 100, 100); // centered at (60,60)
  const p = scoreWipeTower([part], { xMin: 0, yMin: 0, xMax: 256, yMax: 256 }, { bias: 'largest_clearance' });
  // Winner must have positive clearance and be away from the part.
  assert.ok(p.clearanceMm > 0, `clearance=${p.clearanceMm}`);
  assert.ok(p.label.includes('back') || p.label.includes('right'), p.label);
});
test('wipe: L∞ clearance of disjoint boxes', () => {
  const a = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
  const b = { xMin: 20, yMin: 0, xMax: 30, yMax: 10 };
  assert.equal(aabbLInfClearance(a, b), 10);
});

// ---- BambuImportTranslator -------------------------------------------------
test('bambu: detect via printer_model', () => {
  assert.ok(detectBambu({ printerModel: 'Bambu Lab P1S', printerSettingsId: '', filamentTypes: [] }));
});
test('bambu: detect via settings marker', () => {
  assert.ok(detectBambu({ printerModel: '', printerSettingsId: '0.20mm Standard @BBL X1C', filamentTypes: [] }));
});
test('bambu: non-bambu passes through unchanged', () => {
  const r = translateBambu(
    { nozzle_temperature: '220', wall_loops: '3' },
    { printerModel: 'Snapmaker U1', printerSettingsId: '', filamentTypes: [] },
    4,
  );
  assert.equal(r.wasBambu, false);
  assert.deepEqual(r.translatedOverrides, { nozzle_temperature: '220', wall_loops: '3' });
});
test('bambu: strips filament tunings, keeps object tunings', () => {
  const r = translateBambu(
    { nozzle_temperature: '220', filament_flow_ratio: '0.98', wall_loops: '3' },
    { printerModel: 'Bambu Lab X1 Carbon', printerSettingsId: '', filamentTypes: ['Bambu PLA Basic'] },
    4,
  );
  assert.equal(r.wasBambu, true);
  assert.ok(!('nozzle_temperature' in r.translatedOverrides));
  assert.ok(!('filament_flow_ratio' in r.translatedOverrides));
  assert.equal(r.translatedOverrides['wall_loops'], '3');
  assert.deepEqual(r.droppedKeys, ['filament_flow_ratio', 'nozzle_temperature']);
  assert.equal(r.filamentProfileSuggestion.length, 4);
  assert.equal(r.filamentProfileSuggestion[0], 'Snapmaker PLA SnapSpeed @U1');
  assert.ok(r.bannerText.includes('Bambu Studio'));
});
test('bambu: normalizeFilamentType folds brand + finish', () => {
  assert.equal(normalizeFilamentType('Bambu PLA Matte'), 'PLA');
  assert.equal(normalizeFilamentType('"PETG-HF"'), 'PETG-HF');
});

console.log(`\nSection 1: ${passed} tests passed.`);
