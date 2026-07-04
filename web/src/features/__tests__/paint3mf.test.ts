import { describe, it, expect } from 'vitest';
import { decodePaintedTriangle, applyPaintToPositions } from '../Paint3mf';

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

describe('decodePaintedTriangle', () => {
  // Bitstream nibbles are the string read back-to-front; a leaf nibble is
  // (state << 2) for states 0..2 — state 1 → 0b0100 → "4", state 2 → "8".
  it('decodes a whole-triangle simple state', () => {
    const leaves = decode('4');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].state).toBe(1);
    expect(leaves[0].verts).toEqual([0, 0, 0, 4, 0, 0, 0, 4, 0]);
    expect(decode('8')[0].state).toBe(2);
  });

  // States ≥3 store nibble 0xC then (state-3): "0C" = 3, "1C" = 4 — the
  // exact pairs libslic3r's Model.cpp synthesizes ("1C0C2C0C1C13").
  it('decodes extended states (MMU filaments 3+)', () => {
    expect(decode('0C')[0].state).toBe(3);
    expect(decode('1C')[0].state).toBe(4);
    expect(decode('CC')[0].state).toBe(15);
  });

  it('splits one side (special side 0) into two children', () => {
    // Root nibble 0b0001 = 1-side split, special side 0 → "…1".
    // Children in stream order = reverse index: child1 then child0.
    // "48" reversed-read gives child1 state 2 ("8"), child0 state 1 ("4")?
    // Stream order is right-to-left: "841" → '1' split, then '4' → child1
    // state 1, then '8' → child0 state 2.
    const leaves = decode('841');
    expect(leaves).toHaveLength(2);
    // child1 = (M, C, A) with M = midpoint(C, B) = (2, 2, 0) — emitted first
    expect(leaves[0].state).toBe(1);
    expect(leaves[0].verts).toEqual([2, 2, 0, 0, 4, 0, 0, 0, 0]);
    // child0 = (A, B, M)
    expect(leaves[1].state).toBe(2);
    expect(leaves[1].verts).toEqual([0, 0, 0, 4, 0, 0, 2, 2, 0]);
  });

  it('splits three sides into four children covering the triangle', () => {
    // '3' = 3-side split; four leaf children all state 1 → "44443".
    const leaves = decode('44443');
    expect(leaves).toHaveLength(4);
    // Total area must equal the parent triangle (8): each corner+center = 2.
    const area = (v: number[]) => {
      const [ax, ay, , bx, by, , cx, cy] = [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]];
      return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    };
    const total = leaves.reduce((s, l) => s + area(l.verts), 0);
    expect(total).toBeCloseTo(8);
    expect(new Set(leaves.map((l) => l.state))).toEqual(new Set([1]));
  });

  it('decodes nested splits (Model.cpp synthesized pattern)', () => {
    // Stream (right-to-left): '3' = 3-split root; child3 = '1' (1-side split)
    // consuming '4' and '8' as its two leaves; then '4','4','4' for the
    // root's child2..0. Exhausts exactly.
    const leaves = decode('4448413');
    expect(leaves.length).toBe(5); // 3 corner leaves + 2 sub-leaves of center
  });

  it('throws on truncated bitstreams', () => {
    expect(() => decode('3')).toThrow(); // 3-split with no children
    expect(() => decode('C')).toThrow(); // extended state with no payload
  });
});

describe('applyPaintToPositions', () => {
  const tri = new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]);

  it('bakes palette colors per state', () => {
    const res = applyPaintToPositions(
      tri,
      { paint: ['4'], paintedCount: 1 },
      ['#ff0000', '#00ff00'],
      '#0000ff',
    )!;
    expect(res.positions).toEqual(tri);
    // state 1 → palette[0] = red, on all three vertices
    expect(Array.from(res.colors)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('uses the base color for unpainted triangles and state 0', () => {
    const res = applyPaintToPositions(
      tri,
      { paint: [null], paintedCount: 1 },
      ['#ff0000'],
      '#0000ff',
    )!;
    expect(Array.from(res.colors)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('returns null on triangle-count mismatch', () => {
    expect(
      applyPaintToPositions(tri, { paint: ['4', '4'], paintedCount: 2 }, [], '#fff'),
    ).toBeNull();
  });

  it('keeps the triangle unpainted when its string is malformed', () => {
    const res = applyPaintToPositions(
      tri,
      { paint: ['Z'], paintedCount: 1 },
      ['#ff0000'],
      '#0000ff',
    )!;
    expect(res.positions).toEqual(tri);
    expect(Array.from(res.colors)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });
});
