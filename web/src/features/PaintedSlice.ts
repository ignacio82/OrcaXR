/**
 * PaintedSlice — derive a per-triangle filament index from a mesh's vertex
 * colors so the WASM engine's painted-slice path (`startSlicePainted`) can
 * split the model into per-filament volumes.
 *
 * Pure functions, no THREE / no workspace deps, so the mapping is unit-testable
 * in isolation. The workspace feeds it the baked printer-space positions +
 * vertex colors and the active palette; it returns the Int32 filament index per
 * triangle plus how many distinct filaments were actually used (>1 ⇒ painted).
 */

/** Parse '#rrggbb' (or 'rrggbb') to a [r,g,b] triple in 0..1. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const n = h.length >= 6 ? h : 'cccccc';
  return [
    parseInt(n.slice(0, 2), 16) / 255,
    parseInt(n.slice(2, 4), 16) / 255,
    parseInt(n.slice(4, 6), 16) / 255,
  ];
}

/** Index of the palette color nearest (squared RGB distance) to (r,g,b). */
export function nearestPaletteIndex(
  r: number, g: number, b: number,
  palette: ReadonlyArray<readonly [number, number, number]>,
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export interface TriangleFilaments {
  /** 0-based filament index per triangle. */
  triFilament: Int32Array;
  /** Number of distinct filament indices used (>1 ⇒ worth a painted slice). */
  distinctCount: number;
}

/**
 * Map a non-indexed mesh's per-vertex colors to a per-triangle filament index
 * by majority vote of the triangle's three vertices (ties → lowest index).
 *
 * `colors` is 3 floats (r,g,b in 0..1) per vertex, i.e. 9 per triangle, aligned
 * with the position buffer's triangle order. `paletteHex` is the filament slot
 * colors. Returns index 0 for every triangle when there are no colors.
 */
export function deriveTriangleFilaments(
  colors: ArrayLike<number> | null | undefined,
  triCount: number,
  paletteHex: readonly string[],
): TriangleFilaments {
  const triFilament = new Int32Array(triCount);
  if (!colors || colors.length < triCount * 9 || paletteHex.length === 0) {
    return { triFilament, distinctCount: triCount > 0 ? 1 : 0 };
  }
  const palette = paletteHex.map(hexToRgb01);
  const used = new Set<number>();
  for (let t = 0; t < triCount; t++) {
    const v0 = nearestPaletteIndex(colors[t * 9 + 0], colors[t * 9 + 1], colors[t * 9 + 2], palette);
    const v1 = nearestPaletteIndex(colors[t * 9 + 3], colors[t * 9 + 4], colors[t * 9 + 5], palette);
    const v2 = nearestPaletteIndex(colors[t * 9 + 6], colors[t * 9 + 7], colors[t * 9 + 8], palette);
    // Majority of the three; ties fall to the lowest index (v0<=v1<=v2 sort).
    const s = [v0, v1, v2].sort((a, b) => a - b);
    const idx = s[0] === s[1] ? s[0] : s[1] === s[2] ? s[1] : s[0];
    triFilament[t] = idx;
    used.add(idx);
  }
  return { triFilament, distinctCount: used.size };
}
