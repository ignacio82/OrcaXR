/**
 * MeshCut unit tests (run: npx tsx mesh-cut.test.ts).
 * Cuts a unit cube by its mid-plane and checks the halves are clean.
 */
import assert from 'node:assert';
import { cutByPlane } from '../MeshCut';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

/** Non-indexed 20 mm cube centred at origin (12 triangles, 108 floats). */
function cube(): Float32Array {
  const h = 10;
  const c: [number, number, number][] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const q = [
    // faces as quads (CCW), split into 2 tris each
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 0, 3, 7],
    [1, 5, 6, 2],
    [4, 5, 1, 0],
    [3, 2, 6, 7],
  ];
  const out: number[] = [];
  for (const [a, b, cc, d] of q) {
    out.push(...c[a], ...c[b], ...c[cc]);
    out.push(...c[a], ...c[cc], ...c[d]);
  }
  return new Float32Array(out);
}

test('mid-Z cut produces two non-empty watertight-ish halves', () => {
  const r = cutByPlane(cube(), 0, 0, 1, 0); // plane z = 0
  assert.ok(r.didCut, 'plane crossed the cube');
  assert.ok(r.positive.length > 0 && r.negative.length > 0);
  // Every positive-half vertex sits on or above z=0; negative on or below.
  for (let i = 2; i < r.positive.length; i += 3) assert.ok(r.positive[i] >= -1e-4, 'pos z>=0');
  for (let i = 2; i < r.negative.length; i += 3) assert.ok(r.negative[i] <= 1e-4, 'neg z<=0');
});

test('a cap was added on both halves (cross-section closed)', () => {
  const r = cutByPlane(cube(), 0, 0, 1, 0);
  // Count triangles lying exactly on the cut plane (the cap) in each half.
  const capTris = (a: Float32Array) => {
    let n = 0;
    for (let t = 0; t < a.length / 9; t++) {
      let onPlane = true;
      for (let k = 0; k < 3; k++)
        if (Math.abs(a[t * 9 + k * 3 + 2]) > 1e-4) {
          onPlane = false;
          break;
        }
      if (onPlane) n++;
    }
    return n;
  };
  assert.ok(capTris(r.positive) >= 1, 'positive half capped');
  assert.ok(capTris(r.negative) >= 1, 'negative half capped');
});

test('a plane missing the mesh leaves one side empty and didCut=false', () => {
  const r = cutByPlane(cube(), 0, 0, 1, 1000); // far above the cube
  assert.strictEqual(r.didCut, false);
  assert.strictEqual(r.positive.length, 0);
  assert.ok(r.negative.length > 0);
});

test('cut triangle count grows (straddlers were split, not dropped)', () => {
  const before = cube().length / 9; // 12
  const r = cutByPlane(cube(), 0, 0, 1, 0);
  const after = (r.positive.length + r.negative.length) / 9;
  assert.ok(after > before, `expected split to add triangles (${before} -> ${after})`);
});

console.log(`\nMeshCut: ${passed} tests passed.`);
