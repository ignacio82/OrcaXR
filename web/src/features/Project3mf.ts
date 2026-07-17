/**
 * Project3mf — save/open an OrcaXR *project* as a 3MF (Snapmaker Orca's Save /
 * Open Project). It writes a valid, interoperable 3MF whose geometry is one
 * `<object>` per model (untransformed, in mm), plus an OrcaXR-specific sidecar
 * `Metadata/orcaxr_project.json` carrying everything the geometry can't: per
 * object placement (viewer + display transforms), plate membership, the active
 * plate, and the printer/process/filament profile.
 *
 * Build `<item>`s use identity transforms — placement lives in the JSON — so the
 * geometry still opens cleanly in any other slicer, while OrcaXR restores the
 * full scene. Pure bytes-in / bytes-out; the workspace supplies/consumes it.
 */
import * as fflate from 'fflate';
import { CONTENT_TYPES, RELS, fmtCoord as f } from './Write3mf';

export interface ProjectObjectMeta {
  /** Which plate id this object belongs to. */
  plate: number;
  /** Viewer transform (world metres) — the move/rotate/scale placement. */
  viewer: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
  };
  /** Display-mesh local offset (bbox centring); restored for split/cut fidelity. */
  display: [number, number, number];
}

export interface ProjectMeta {
  version: 1;
  profile: { machine: string; process: string; filament: string };
  activePlate: number;
  plates: { id: number; label: string }[];
  objects: ProjectObjectMeta[];
}

export interface ParsedProject {
  meta: ProjectMeta;
  /** One non-indexed position buffer per object, aligned with meta.objects. */
  geometries: Float32Array[];
}

function objectXml(id: number, positions: ArrayLike<number>): string {
  const triCount = Math.floor(positions.length / 9);
  let v = '',
    t = '';
  for (let i = 0; i < triCount * 3; i++) {
    v += `<vertex x="${f(positions[i * 3])}" y="${f(positions[i * 3 + 1])}" z="${f(positions[i * 3 + 2])}"/>`;
  }
  for (let k = 0; k < triCount; k++) t += `<triangle v1="${k * 3}" v2="${k * 3 + 1}" v3="${k * 3 + 2}"/>`;
  return `<object id="${id}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
}

/** Serialise a project (one object per model + metadata) to 3MF bytes. */
export function writeProject3mf(objects: { positions: ArrayLike<number> }[], meta: ProjectMeta): Uint8Array {
  const objsXml = objects.map((o, i) => objectXml(i + 1, o.positions)).join('');
  const items = objects.map((_, i) => `<item objectid="${i + 1}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>${objsXml}</resources>
 <build>${items}</build>
</model>`;
  const enc = new TextEncoder();
  return fflate.zipSync({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    '_rels/.rels': enc.encode(RELS),
    '3D/3dmodel.model': enc.encode(model),
    'Metadata/orcaxr_project.json': enc.encode(JSON.stringify(meta)),
  });
}

/**
 * Parse an OrcaXR project 3MF back into metadata + per-object geometry. Returns
 * null when the sidecar is absent (i.e. it's a plain 3MF, not an OrcaXR project
 * — the caller should fall back to normal model import).
 */
export function parseProject3mf(bytes: Uint8Array): ParsedProject | null {
  let zip: Record<string, Uint8Array>;
  try {
    zip = fflate.unzipSync(bytes);
  } catch {
    return null;
  }
  const metaBytes = zip['Metadata/orcaxr_project.json'];
  const modelBytes = zip['3D/3dmodel.model'];
  if (!metaBytes || !modelBytes) return null;
  let meta: ProjectMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch {
    return null;
  }

  const xml = new TextDecoder().decode(modelBytes);
  const geometries: Float32Array[] = [];
  const objRe = /<object\b[^>]*>([\s\S]*?)<\/object>/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(xml))) {
    const block = om[1];
    const vlist: [number, number, number][] = [];
    const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    let vm: RegExpExecArray | null;
    while ((vm = vRe.exec(block))) vlist.push([+vm[1], +vm[2], +vm[3]]);
    const pos: number[] = [];
    const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(block))) {
      for (const idx of [+tm[1], +tm[2], +tm[3]]) {
        const pt = vlist[idx];
        if (pt) pos.push(pt[0], pt[1], pt[2]);
      }
    }
    geometries.push(new Float32Array(pos));
  }
  return { meta, geometries };
}
