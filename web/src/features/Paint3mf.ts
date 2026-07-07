/**
 * Paint3mf — decode Bambu/Orca `paint_color` triangle strings (PrusaSlicer
 * TriangleSelector bitstream, also written as `slic3rpe:mmu_segmentation`)
 * into subdivided, per-vertex-colored triangles.
 *
 * Format (ported from libslic3r TriangleSelector::serialize/deserialize and
 * FacetsAnnotation::{get,set}_triangle_as_string):
 *  - The hex string read BACK-TO-FRONT is a stream of nibbles; each char's
 *    value is one nibble (the LSB-first bit packing cancels out).
 *  - Each triangle record: nibble `code`. `code & 3` = number of split sides.
 *    - 0 → leaf. State = code >> 2, unless that is 0b11: then the next
 *      nibble holds (state - 3) ("extended" states 3..15 for MMU filaments).
 *    - k>0 → split into k+1 children. `code >> 2` = special side. Children
 *      follow in the stream in REVERSE child-index order.
 *  - State 0 = unpainted (volume's base filament); state N ≥ 1 = filament N
 *    (1-based into the project's filament_colour palette).
 *
 * Split geometry (TriangleSelector::perform_split): with the triangle's
 * vertices rotated so V0 is the special side's first vertex,
 *  - 1 side  → M = mid(V2,V1);              children (V0,V1,M) (M,V2,V0)
 *  - 2 sides → M1 = mid(V1,V0), M2 = mid(V0,V2);
 *              children (V0,M1,M2) (M1,V1,M2) (V1,V2,M2)
 *  - 3 sides → M01 = mid(V1,V0), M12 = mid(V2,V1), M20 = mid(V0,V2);
 *              children (V0,M01,M20) (M01,V1,M12) (M12,V2,M20) (M01,M12,M20)
 *
 * Pure functions, no THREE — unit-testable in isolation.
 */
import * as fflate from 'fflate';
import { virtualFilamentsFromConfig } from './MixedFilamentPreview';

/** Per-mesh paint info, aligned with ThreeMFLoader's mesh traversal order. */
export interface MeshPaint {
  /** paint string per original triangle (file order), null = unpainted. */
  paint: (string | null)[];
  /** How many triangles carry paint (fast pre-check). */
  paintedCount: number;
}

export interface Paint3mfResult {
  /** filament slot colors ('#rrggbb'), 1-based paint states index this - 1. */
  palette: string[];
  /** mesh index (loader traversal order) → paint data; missing = no paint. */
  meshes: Map<number, MeshPaint>;
}

const MAX_PAINT_DEPTH = 32; // matches libslic3r's practical split depth bound

/**
 * Decode one triangle's paint string, emitting leaf sub-triangles.
 * (ax,ay,az)..(cx,cy,cz) are the triangle corners in v1,v2,v3 file order.
 * emit() receives the sub-triangle corners and its paint state.
 * Throws on a malformed string (caller falls back to unpainted).
 */
export function decodePaintedTriangle(
  str: string,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  emit: (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    state: number,
  ) => void,
): void {
  let pos = str.length - 1; // nibbles are read back-to-front
  const next = (): number => {
    if (pos < 0) throw new Error('paint bitstream underrun');
    const c = str.charCodeAt(pos--);
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : -1;
    if (v < 0) throw new Error('bad paint hex char');
    return v;
  };

  const walk = (
    vax: number, vay: number, vaz: number,
    vbx: number, vby: number, vbz: number,
    vcx: number, vcy: number, vcz: number,
    depth: number,
  ): void => {
    if (depth > MAX_PAINT_DEPTH) throw new Error('paint split too deep');
    const code = next();
    const splitSides = code & 3;
    if (splitSides === 0) {
      const state = (code & 0b1100) === 0b1100 ? next() + 3 : code >> 2;
      emit(vax, vay, vaz, vbx, vby, vbz, vcx, vcy, vcz, state);
      return;
    }
    // Rotate so V0 is the special side's first vertex.
    const special = code >> 2;
    const V = [vax, vay, vaz, vbx, vby, vbz, vcx, vcy, vcz];
    const o0 = (special % 3) * 3, o1 = ((special + 1) % 3) * 3, o2 = ((special + 2) % 3) * 3;
    const x0 = V[o0], y0 = V[o0 + 1], z0 = V[o0 + 2];
    const x1 = V[o1], y1 = V[o1 + 1], z1 = V[o1 + 2];
    const x2 = V[o2], y2 = V[o2 + 1], z2 = V[o2 + 2];

    // children[i] = 9 floats; stream order is reverse child index.
    let children: number[][];
    if (splitSides === 1) {
      const mx = (x2 + x1) / 2, my = (y2 + y1) / 2, mz = (z2 + z1) / 2;
      children = [
        [x0, y0, z0, x1, y1, z1, mx, my, mz],
        [mx, my, mz, x2, y2, z2, x0, y0, z0],
      ];
    } else if (splitSides === 2) {
      const m1x = (x1 + x0) / 2, m1y = (y1 + y0) / 2, m1z = (z1 + z0) / 2;
      const m2x = (x0 + x2) / 2, m2y = (y0 + y2) / 2, m2z = (z0 + z2) / 2;
      children = [
        [x0, y0, z0, m1x, m1y, m1z, m2x, m2y, m2z],
        [m1x, m1y, m1z, x1, y1, z1, m2x, m2y, m2z],
        [x1, y1, z1, x2, y2, z2, m2x, m2y, m2z],
      ];
    } else {
      const m01x = (x1 + x0) / 2, m01y = (y1 + y0) / 2, m01z = (z1 + z0) / 2;
      const m12x = (x2 + x1) / 2, m12y = (y2 + y1) / 2, m12z = (z2 + z1) / 2;
      const m20x = (x0 + x2) / 2, m20y = (y0 + y2) / 2, m20z = (z0 + z2) / 2;
      children = [
        [x0, y0, z0, m01x, m01y, m01z, m20x, m20y, m20z],
        [m01x, m01y, m01z, x1, y1, z1, m12x, m12y, m12z],
        [m12x, m12y, m12z, x2, y2, z2, m20x, m20y, m20z],
        [m01x, m01y, m01z, m12x, m12y, m12z, m20x, m20y, m20z],
      ];
    }
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      walk(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], depth + 1);
    }
  };

  walk(ax, ay, az, bx, by, bz, cx, cy, cz, 0);
}

/**
 * Rebuild a mesh's non-indexed position buffer with paint applied: unpainted
 * triangles pass through; painted ones are subdivided per their paint tree.
 * `positions` is the loader's non-indexed triangle soup (9 floats/tri, file
 * order — three's ThreeMFLoader preserves triangle order and winding).
 * Returns null when nothing is painted or on a triangle-count mismatch.
 */
export function applyPaintToPositions(
  positions: Float32Array,
  meshPaint: MeshPaint,
  palette: string[],
  baseHex: string,
): { positions: Float32Array; colors: Float32Array } | null {
  const triCount = positions.length / 9;
  if (meshPaint.paint.length !== triCount || meshPaint.paintedCount === 0) {
    if (meshPaint.paint.length !== triCount) {
      console.warn(`[paint3mf] triangle count mismatch: loader ${triCount}, 3mf ${meshPaint.paint.length} — skipping paint`);
    }
    return null;
  }

  const rgb = (hex: string): [number, number, number] => {
    const h = (hex || '#cccccc').replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  };
  const base = rgb(baseHex);
  const stateColor: [number, number, number][] = [base];
  for (const hex of palette) stateColor.push(rgb(hex));

  const pos: number[] = [];
  const col: number[] = [];
  const emit = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    state: number,
  ) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const c = stateColor[state] ?? base;
    for (let i = 0; i < 3; i++) col.push(c[0], c[1], c[2]);
  };

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const str = meshPaint.paint[t];
    if (!str) {
      emit(
        positions[o], positions[o + 1], positions[o + 2],
        positions[o + 3], positions[o + 4], positions[o + 5],
        positions[o + 6], positions[o + 7], positions[o + 8], 0,
      );
      continue;
    }
    try {
      decodePaintedTriangle(
        str,
        positions[o], positions[o + 1], positions[o + 2],
        positions[o + 3], positions[o + 4], positions[o + 5],
        positions[o + 6], positions[o + 7], positions[o + 8],
        emit,
      );
    } catch (e) {
      // Malformed string — keep the triangle, just unpainted.
      console.warn('[paint3mf] bad paint string on triangle', t, e);
      emit(
        positions[o], positions[o + 1], positions[o + 2],
        positions[o + 3], positions[o + 4], positions[o + 5],
        positions[o + 6], positions[o + 7], positions[o + 8], 0,
      );
    }
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col) };
}

/**
 * Extract per-mesh paint strings from an Orca/Bambu 3MF, aligned with
 * ThreeMFLoader's mesh order (build items → components → leaf objects with
 * triangles, matching extract3mfColors's walk). Objects are keyed by
 * (file, id) — the production extension's `p:path` components reference
 * objects in other .model files and ids are only unique per file.
 */
export function extract3mfPaint(buf: ArrayBuffer): Paint3mfResult | null {
  try {
    const unzipped = fflate.unzipSync(new Uint8Array(buf));
    const dec = new TextDecoder();

    let palette: string[] = [];
    const projectSettings = unzipped['Metadata/project_settings.config'];
    if (projectSettings) {
      const config = JSON.parse(dec.decode(projectSettings));
      if (Array.isArray(config.filament_colour)) palette = config.filament_colour;
      else if (Array.isArray(config.extruder_colour)) palette = config.extruder_colour;
      // Paint states may reference FullSpectrum virtual (mixed) filaments,
      // whose IDs continue past the physical palette — append their display
      // colors so those states don't silently fall back to the base color.
      palette = [...palette, ...virtualFilamentsFromConfig(config).map((v) => v.color)];
    }

    interface ObjInfo {
      file: string;
      hasTris: boolean;
      components: { file: string; id: string }[];
      body: string | null; // kept only for objects with triangles
    }
    // key: `${file}#${id}`; byId: bare-id fallback (legacy files w/o p:path).
    const objects = new Map<string, ObjInfo>();
    const byId = new Map<string, ObjInfo>();
    let buildOrder: { file: string; id: string }[] = [];

    const norm = (p: string) => p.replace(/^\//, '');
    for (const [name, data] of Object.entries(unzipped)) {
      if (!name.endsWith('.model')) continue;
      const text = dec.decode(data as Uint8Array);
      const objRe = /<object[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g;
      let m: RegExpExecArray | null;
      while ((m = objRe.exec(text)) !== null) {
        const id = m[1];
        const body = m[2];
        const components = [...body.matchAll(/<component[^>]*/g)].map((c) => {
          const cid = /\bobjectid="([^"]+)"/.exec(c[0])?.[1] ?? '';
          const cpath = /\bp:path="([^"]+)"/.exec(c[0])?.[1];
          return { file: cpath ? norm(cpath) : name, id: cid };
        });
        const hasTris = /<triangle[\s/>]/.test(body);
        const info: ObjInfo = { file: name, hasTris, components, body: hasTris ? body : null };
        objects.set(`${name}#${id}`, info);
        if (!byId.has(id)) byId.set(id, info);
      }
      const items = [...text.matchAll(/<item[^>]*\bobjectid="([^"]+)"/g)]
        .map((it) => ({ file: name, id: it[1] }));
      if (items.length) buildOrder = items;
    }

    const resolve = (file: string, id: string): ObjInfo | undefined =>
      objects.get(`${file}#${id}`) ?? byId.get(id);

    // Flatten build → leaf mesh objects in loader order.
    const orderedLeaves: ObjInfo[] = [];
    const visit = (file: string, id: string, depth: number) => {
      if (depth > 32) return;
      const info = resolve(file, id);
      if (!info) return;
      if (info.components.length) {
        for (const c of info.components) visit(c.file, c.id, depth + 1);
      } else if (info.hasTris) {
        orderedLeaves.push(info);
      }
    };
    for (const b of buildOrder) visit(b.file, b.id, 0);
    if (orderedLeaves.length === 0) {
      for (const info of objects.values()) {
        if (!info.components.length && info.hasTris) orderedLeaves.push(info);
      }
    }
    if (orderedLeaves.length === 0) return null;

    // Parse triangles once per distinct object (instances share paint).
    const paintCache = new Map<ObjInfo, MeshPaint>();
    const meshes = new Map<number, MeshPaint>();
    orderedLeaves.forEach((info, meshIndex) => {
      let mp = paintCache.get(info);
      if (!mp) {
        const paint: (string | null)[] = [];
        let paintedCount = 0;
        const triRe = /<triangle\b[^>]*/g;
        let t: RegExpExecArray | null;
        while ((t = triRe.exec(info.body!)) !== null) {
          const p = /\b(?:paint_color|slic3rpe:mmu_segmentation)="([^"]+)"/.exec(t[0]);
          paint.push(p ? p[1] : null);
          if (p) paintedCount++;
        }
        mp = { paint, paintedCount };
        paintCache.set(info, mp);
      }
      if (mp.paintedCount > 0) meshes.set(meshIndex, mp);
    });

    if (meshes.size === 0) return null;
    console.log(`[paint3mf] ${meshes.size}/${orderedLeaves.length} meshes painted, palette ${palette.length}`);
    return { palette, meshes };
  } catch (e) {
    console.error('[paint3mf] failed to extract paint', e);
    return null;
  }
}
