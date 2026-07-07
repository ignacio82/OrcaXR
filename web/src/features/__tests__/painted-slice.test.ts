/**
 * Node tests for PaintedSlice derivation (run: npx tsx painted-slice.test.ts).
 * Verifies vertex colours map to the right per-triangle filament index and that
 * distinctCount correctly decides mono vs painted.
 */
import assert from 'node:assert';
import { hexToRgb01, nearestPaletteIndex, deriveTriangleFilaments } from '../PaintedSlice';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

const RED = '#ff0000', GREEN = '#00ff00', BLUE = '#0000ff';
const PALETTE = [RED, GREEN, BLUE];

test('hexToRgb01 parses with and without #', () => {
  assert.deepStrictEqual(hexToRgb01('#ff0000'), [1, 0, 0]);
  assert.deepStrictEqual(hexToRgb01('00ff00'), [0, 1, 0]);
});

test('nearestPaletteIndex picks the closest colour', () => {
  const pal = PALETTE.map(hexToRgb01);
  assert.strictEqual(nearestPaletteIndex(0.9, 0.1, 0.1, pal), 0); // near red
  assert.strictEqual(nearestPaletteIndex(0.1, 0.1, 0.9, pal), 2); // near blue
});

function colorsFor(triColors: [number, number, number][]): number[] {
  // Each triangle gets the same colour on all 3 vertices (9 floats/tri).
  const out: number[] = [];
  for (const [r, g, b] of triColors) for (let k = 0; k < 3; k++) out.push(r, g, b);
  return out;
}

test('single-colour mesh → distinctCount 1 (mono path)', () => {
  const colors = colorsFor([[1, 0, 0], [1, 0, 0], [1, 0, 0]]);
  const { triFilament, distinctCount } = deriveTriangleFilaments(colors, 3, PALETTE);
  assert.strictEqual(distinctCount, 1);
  assert.deepStrictEqual([...triFilament], [0, 0, 0]);
});

test('two-colour mesh → distinctCount 2 with correct indices', () => {
  const colors = colorsFor([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  const { triFilament, distinctCount } = deriveTriangleFilaments(colors, 3, PALETTE);
  assert.strictEqual(distinctCount, 3);
  assert.deepStrictEqual([...triFilament], [0, 1, 2]);
});

test('majority vote resolves mixed-vertex triangles', () => {
  // Triangle with two green verts and one red → green (index 1).
  const g = hexToRgb01(GREEN), r = hexToRgb01(RED);
  const colors = [...g, ...g, ...r];
  const { triFilament } = deriveTriangleFilaments(colors, 1, PALETTE);
  assert.strictEqual(triFilament[0], 1);
});

test('no colours → all index 0, mono', () => {
  const { triFilament, distinctCount } = deriveTriangleFilaments(null, 4, PALETTE);
  assert.deepStrictEqual([...triFilament], [0, 0, 0, 0]);
  assert.strictEqual(distinctCount, 1);
});

console.log(`\nPaintedSlice: ${passed} tests passed.`);
