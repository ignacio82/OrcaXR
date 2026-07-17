import { AiMaskProjection, DepthMode } from './AiMaskProjection';

export interface RegionStat {
  name: string;
  slot: number;
  triangleCount: number;
}

export interface ResolvedPlan {
  perTriangleSlot: Int8Array;
  baseSlot: number;
  regions: RegionStat[];
}

export interface CameraSpec {
  widthPx: number;
  heightPx: number;
  projMatrixRowMajor: Float32Array;
  viewMatrixRowMajor: Float32Array;
}

export interface PaletteSlot {
  slot: number;
  lab: { l: number; a: number; b: number };
}

// Basic stub for ColorScience CIEDE2000
const ciede2000 = (lab1: any, lab2: any) => {
  const dl = lab1.l - lab2.l;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dl * dl + da * da + db * db); // simplified fallback
};

const parseLab = (_hex: string) => {
  return { l: 50, a: 0, b: 0 }; // stub
};

export class SemanticPaintPlanner {
  public static resolve(bvh: any, camera: CameraSpec, plan: any, palette: PaletteSlot[]): ResolvedPlan | null {
    const n = bvh.triCount;
    if (n === 0 || palette.length === 0) return null;
    if (camera.widthPx <= 0 || camera.heightPx <= 0) return null;

    const baseColorStr = (plan.base_color || '').trim();
    const baseLab = parseLab(baseColorStr);
    if (!baseLab) return null;

    const baseSlot = this.nearestSlot(baseLab, palette);
    const out = new Int8Array(n);
    out.fill(baseSlot);

    const stats: RegionStat[] = [];
    const regions = plan.regions || [];

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const name = (r.name || '').trim() || `region_${i}`;
      const colLab = parseLab((r.color || '').trim());
      if (!colLab) {
        stats.push({ name, slot: 0, triangleCount: 0 });
        continue;
      }
      const slot = this.nearestSlot(colLab, palette);
      const polys = this.parsePolygons(r.polygons);
      if (polys.length === 0) {
        stats.push({ name, slot, triangleCount: 0 });
        continue;
      }
      const mask = AiMaskProjection.rasterizePolygons(polys, camera.widthPx, camera.heightPx);
      const tris = AiMaskProjection.project(bvh, camera, mask, DepthMode.FrontFacingOnly, true);
      for (const t of tris) {
        if (t >= 0 && t < n) {
          out[t] = slot;
        }
      }
      stats.push({ name, slot, triangleCount: tris.length });
    }

    return { perTriangleSlot: out, baseSlot, regions: stats };
  }

  private static nearestSlot(lab: any, palette: PaletteSlot[]): number {
    let best = palette[0].slot;
    let bestD = Infinity;
    for (const p of palette) {
      const d = ciede2000(lab, p.lab);
      if (d < bestD) {
        bestD = d;
        best = p.slot;
      }
    }
    return best;
  }

  private static parsePolygons(arr: any[]): Float32Array[] {
    if (!arr || !Array.isArray(arr)) return [];
    const out: Float32Array[] = [];
    for (const poly of arr) {
      if (!Array.isArray(poly)) continue;
      const len = poly.length;
      if (len < 6 || len % 2 !== 0) continue;

      const fa = new Float32Array(len);
      let valid = true;
      for (let i = 0; i < len; i++) {
        const v = parseFloat(poly[i]);
        if (isNaN(v)) {
          valid = false;
          break;
        }
        fa[i] = v;
      }
      if (valid) out.push(fa);
    }
    return out;
  }
}
