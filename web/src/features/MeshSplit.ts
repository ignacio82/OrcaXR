/**
 * MeshSplit — split a non-indexed triangle soup into its connected components
 * (Snapmaker Orca's "Split to Objects"). Two triangles are connected when they
 * share a welded vertex (same position within a quantisation epsilon), so a mesh
 * built from several disjoint bodies (e.g. a boolean union of separated solids)
 * separates back into one component per body.
 *
 * Pure array-in / array-out (no THREE), so the graph logic is unit-testable in
 * isolation — the workspace wraps the results back into BufferGeometries.
 */

export interface MeshComponent {
  /** Non-indexed positions, 9 floats (3 verts) per triangle. */
  positions: Float32Array;
  /** Matching vertex colors (9 per triangle) when the source had them. */
  colors: Float32Array | null;
}

/** Quantise a coordinate to an integer grid so coincident verts weld together. */
function key(x: number, y: number, z: number): string {
  const q = 1e4; // 0.1 µm grid in mm space — well below any real feature size
  return `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
}

/** Union-Find with path compression + union by size. */
class DSU {
  private parent: number[];
  private size: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }
  find(a: number): number {
    let r = a;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[a] !== r) {
      const n = this.parent[a];
      this.parent[a] = r;
      a = n;
    }
    return r;
  }
  union(a: number, b: number): void {
    let ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }
}

/**
 * Group a non-indexed mesh's triangles into connected components.
 *
 * Returns one {@link MeshComponent} per body, largest first. A fully-connected
 * mesh yields a single component (the caller treats that as "nothing to split").
 */
export function splitConnectedComponents(
  positions: ArrayLike<number>,
  colors?: ArrayLike<number> | null,
): MeshComponent[] {
  const triCount = Math.floor(positions.length / 9);
  if (triCount === 0) return [];

  // 1. Weld vertices: map each corner to a representative welded-vertex id.
  const weld = new Map<string, number>();
  const cornerRep = new Int32Array(triCount * 3);
  let nextRep = 0;
  for (let c = 0; c < triCount * 3; c++) {
    const k = key(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
    let rep = weld.get(k);
    if (rep === undefined) {
      rep = nextRep++;
      weld.set(k, rep);
    }
    cornerRep[c] = rep;
  }

  // 2. Union the three welded corners of every triangle.
  const dsu = new DSU(nextRep);
  for (let t = 0; t < triCount; t++) {
    const a = cornerRep[t * 3],
      b = cornerRep[t * 3 + 1],
      d = cornerRep[t * 3 + 2];
    dsu.union(a, b);
    dsu.union(b, d);
  }

  // 3. Bucket triangles by their component root.
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = dsu.find(cornerRep[t * 3]);
    let arr = buckets.get(root);
    if (!arr) {
      arr = [];
      buckets.set(root, arr);
    }
    arr.push(t);
  }

  // 4. Emit a component per bucket, largest first (stable, deterministic).
  const hasColor = !!colors && colors.length >= triCount * 9;
  const comps: MeshComponent[] = [];
  for (const tris of buckets.values()) {
    const pos = new Float32Array(tris.length * 9);
    const col = hasColor ? new Float32Array(tris.length * 9) : null;
    tris.forEach((t, i) => {
      for (let j = 0; j < 9; j++) {
        pos[i * 9 + j] = positions[t * 9 + j];
        if (col) col[i * 9 + j] = colors![t * 9 + j];
      }
    });
    comps.push({ positions: pos, colors: col });
  }
  comps.sort((a, b) => b.positions.length - a.positions.length);
  return comps;
}
