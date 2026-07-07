/**
 * MeshSplit unit tests (run: npx tsx mesh-split.test.ts).
 * Verifies connected-component separation on hand-built triangle soups.
 */
import assert from 'node:assert';
import { splitConnectedComponents } from '../MeshSplit';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

/** One triangle at an x offset (three verts, 9 floats). */
function tri(dx: number): number[] {
  return [dx, 0, 0, dx + 1, 0, 0, dx, 1, 0];
}

test('a single triangle is one component', () => {
  const comps = splitConnectedComponents(new Float32Array(tri(0)));
  assert.strictEqual(comps.length, 1);
  assert.strictEqual(comps[0].positions.length, 9);
});

test('two disjoint triangles split into two components', () => {
  const comps = splitConnectedComponents(new Float32Array([...tri(0), ...tri(100)]));
  assert.strictEqual(comps.length, 2);
  assert.strictEqual(comps[0].positions.length, 9);
  assert.strictEqual(comps[1].positions.length, 9);
});

test('two triangles sharing an edge stay one component', () => {
  // Second triangle reuses two vertices of the first (shared edge) → connected.
  const a = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const b = [1, 0, 0, 0, 1, 0, 1, 1, 0];
  const comps = splitConnectedComponents(new Float32Array([...a, ...b]));
  assert.strictEqual(comps.length, 1);
  assert.strictEqual(comps[0].positions.length, 18);
});

test('components come back largest-first', () => {
  // Body A: 1 tri. Body B: 2 edge-sharing tris far away.
  const a = tri(0);
  const b1 = [50, 0, 0, 51, 0, 0, 50, 1, 0];
  const b2 = [51, 0, 0, 50, 1, 0, 51, 1, 0];
  const comps = splitConnectedComponents(new Float32Array([...a, ...b1, ...b2]));
  assert.strictEqual(comps.length, 2);
  assert.strictEqual(comps[0].positions.length, 18, 'largest (2-tri body) first');
  assert.strictEqual(comps[1].positions.length, 9);
});

test('vertex colors travel with their triangles', () => {
  const pos = new Float32Array([...tri(0), ...tri(100)]);
  const col = new Float32Array(18);
  for (let i = 0; i < 9; i++) col[i] = 1;          // first tri red-ish (all 1s)
  for (let i = 9; i < 18; i++) col[i] = 0;         // second tri black
  const comps = splitConnectedComponents(pos, col);
  assert.strictEqual(comps.length, 2);
  // Largest-first tie (both 1 tri) is stable insertion order → first body first.
  assert.ok(comps[0].colors && comps[1].colors, 'colors preserved');
  const sum0 = comps[0].colors!.reduce((s, v) => s + v, 0);
  const sum1 = comps[1].colors!.reduce((s, v) => s + v, 0);
  assert.notStrictEqual(sum0, sum1, 'each body kept its own colors');
});

test('empty input yields no components', () => {
  assert.deepStrictEqual(splitConnectedComponents(new Float32Array(0)), []);
});

console.log(`\nMeshSplit: ${passed} tests passed.`);
