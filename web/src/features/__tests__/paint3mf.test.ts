/**
 * Node tests for the 3MF paint_color decoder (run: npx tsx paint3mf.test.ts).
 * Verifies the TriangleSelector bitstream decode (leaf states, extended MMU
 * states, split geometry, nested splits) and the vertex-color baking.
 */
import assert from 'node:assert';
import { decodePaintedTriangle, applyPaintToPositions } from '../Paint3mf';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

type Leaf = { verts: number[]; state: number };

function decode(str: string): Leaf[] {
  const out: Leaf[] = [];
  decodePaintedTriangle(
    str,
    0, 0, 0, // A
    4, 0, 0, // B
    0, 4, 0, // C
    (ax, ay, az, bx, by, bz, cx, cy, cz, state) =>
      out.push({ verts: [ax, ay, az, bx, by, bz, cx, cy, cz], state }),
  );
  return out;
}

// Bitstream nibbles are the string read back-to-front; a leaf nibble is
// (state << 2) for states 0..2 — state 1 → 0b0100 → "4", state 2 → "8".
test('whole-triangle simple state', () => {
  const leaves = decode('4');
  assert.strictEqual(leaves.length, 1);
  assert.strictEqual(leaves[0].state, 1);
  assert.deepStrictEqual(leaves[0].verts, [0, 0, 0, 4, 0, 0, 0, 4, 0]);
  assert.strictEqual(decode('8')[0].state, 2);
});

// States ≥3 store nibble 0xC then (state-3): "0C" = 3, "1C" = 4 — the exact
// pairs libslic3r's Model.cpp synthesizes ("1C0C2C0C1C13").
test('extended states (MMU filaments 3+)', () => {
  assert.strictEqual(decode('0C')[0].state, 3);
  assert.strictEqual(decode('1C')[0].state, 4);
  assert.strictEqual(decode('CC')[0].state, 15);
});

test('one-side split (special side 0) into two children', () => {
  // Stream (right-to-left) of "841": '1' = 1-side split, then '4' → child1
  // state 1, then '8' → child0 state 2. child1 = (M, C, A) with
  // M = midpoint(C, B) = (2, 2, 0); child0 = (A, B, M).
  const leaves = decode('841');
  assert.strictEqual(leaves.length, 2);
  assert.strictEqual(leaves[0].state, 1);
  assert.deepStrictEqual(leaves[0].verts, [2, 2, 0, 0, 4, 0, 0, 0, 0]);
  assert.strictEqual(leaves[1].state, 2);
  assert.deepStrictEqual(leaves[1].verts, [0, 0, 0, 4, 0, 0, 2, 2, 0]);
});

test('three-side split covers the whole triangle', () => {
  // '3' = 3-side split; four leaf children all state 1 → "44443".
  const leaves = decode('44443');
  assert.strictEqual(leaves.length, 4);
  const area = (v: number[]) =>
    Math.abs((v[3] - v[0]) * (v[7] - v[1]) - (v[6] - v[0]) * (v[4] - v[1])) / 2;
  const total = leaves.reduce((s, l) => s + area(l.verts), 0);
  assert.ok(Math.abs(total - 8) < 1e-9, `area ${total} != 8`);
  assert.deepStrictEqual([...new Set(leaves.map((l) => l.state))], [1]);
});

test('nested splits (Model.cpp synthesized pattern)', () => {
  // Stream (right-to-left): '3' = 3-split root; child3 = '1' (1-side split)
  // consuming '4' and '8' as its two leaves; then '4','4','4' for the
  // root's child2..0. Exhausts exactly.
  const leaves = decode('4448413');
  assert.strictEqual(leaves.length, 5); // 3 corner leaves + 2 center sub-leaves
});

test('throws on truncated bitstreams', () => {
  assert.throws(() => decode('3')); // 3-split with no children
  assert.throws(() => decode('C')); // extended state with no payload
});

const TRI = new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]);

test('bakes palette colors per state', () => {
  const res = applyPaintToPositions(
    TRI, { paint: ['4'], paintedCount: 1 }, ['#ff0000', '#00ff00'], '#0000ff',
  )!;
  assert.deepStrictEqual([...res.positions], [...TRI]);
  // state 1 → palette[0] = red, on all three vertices
  assert.deepStrictEqual([...res.colors], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
});

test('base color for unpainted triangles and state 0', () => {
  const res = applyPaintToPositions(
    TRI, { paint: [null], paintedCount: 1 }, ['#ff0000'], '#0000ff',
  )!;
  assert.deepStrictEqual([...res.colors], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('null on triangle-count mismatch', () => {
  assert.strictEqual(
    applyPaintToPositions(TRI, { paint: ['4', '4'], paintedCount: 2 }, [], '#fff'),
    null,
  );
});

test('malformed paint string degrades to unpainted', () => {
  const res = applyPaintToPositions(
    TRI, { paint: ['Z'], paintedCount: 1 }, ['#ff0000'], '#0000ff',
  )!;
  assert.deepStrictEqual([...res.positions], [...TRI]);
  assert.deepStrictEqual([...res.colors], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

console.log(`\nPaint3mf: ${passed} tests passed.`);
