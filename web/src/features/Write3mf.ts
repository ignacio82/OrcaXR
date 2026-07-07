/**
 * Write3mf — serialise a triangle soup into a minimal, valid 3MF package
 * (Snapmaker Orca's "Export Generic 3MF", geometry-only). A 3MF is a zip of:
 *   - [Content_Types].xml   — declares the .model / .rels part types
 *   - _rels/.rels           — points the package at the 3D model part
 *   - 3D/3dmodel.model      — the mesh (vertices + triangles) in mm
 *
 * Vertices are written non-indexed (three per triangle) — bloatier than a welded
 * index but simple and unambiguous; any 3MF reader (incl. three's ThreeMFLoader,
 * which we round-trip against) accepts it. Pure bytes-in / bytes-out.
 */
import * as fflate from 'fflate';

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

export const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** Trim a float to 6 decimals without exponent noise. */
export function fmtCoord(n: number): string {
  return Number.isFinite(n) ? (+n.toFixed(6)).toString() : '0';
}
const f = fmtCoord;

/** Build the `3D/3dmodel.model` XML for a non-indexed position buffer. */
export function build3mfModelXml(positions: ArrayLike<number>): string {
  const triCount = Math.floor(positions.length / 9);
  const verts: string[] = [];
  const tris: string[] = [];
  for (let i = 0; i < triCount * 3; i++) {
    verts.push(`<vertex x="${f(positions[i * 3])}" y="${f(positions[i * 3 + 1])}" z="${f(positions[i * 3 + 2])}"/>`);
  }
  for (let t = 0; t < triCount; t++) {
    tris.push(`<triangle v1="${t * 3}" v2="${t * 3 + 1}" v3="${t * 3 + 2}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>${verts.join('')}</vertices>
    <triangles>${tris.join('')}</triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1"/>
 </build>
</model>`;
}

/** Zip a non-indexed position buffer into 3MF package bytes. */
export function writeMinimal3mf(positions: ArrayLike<number>): Uint8Array {
  const enc = new TextEncoder();
  return fflate.zipSync({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    '_rels/.rels': enc.encode(RELS),
    '3D/3dmodel.model': enc.encode(build3mfModelXml(positions)),
  });
}
