/**
 * G-code → three.js toolpath geometry. Walks the sliced G-code, tracks
 * the toolhead, and emits extrusion moves as line segments colored by
 * feature type (the `;TYPE:` comments libslic3r writes — same tags the
 * Android app's GcodeParser consumes).
 */
import * as THREE from 'three';

/** OrcaSlicer-ish feature colors. */
const TYPE_COLORS: Record<string, number> = {
  'Outer wall': 0xff4d00,
  'Inner wall': 0xffc800,
  'Overhang wall': 0x4d80ff,
  'Sparse infill': 0xb03ade,
  'Internal solid infill': 0xf07dc2,
  'Top surface': 0xf25844,
  'Bottom surface': 0x3a6df0,
  Ironing: 0x3a6df0,
  Bridge: 0x4d80ff,
  'Gap infill': 0xffffff,
  Skirt: 0x7dd4c0,
  Brim: 0x7dd4c0,
  Support: 0x00ff7f,
  'Support interface': 0x00c060,
  Custom: 0x888888,
};
const DEFAULT_COLOR = 0x66d9ef;

/** Hard cap so a pathological G-code can't OOM the tab. */
const MAX_SEGMENTS = 1_500_000;

export interface Toolpath {
  /** One LineSegments-ready geometry (positions in printer mm, Z-up). */
  geometry: THREE.BufferGeometry;
  layerCount: number;
  segmentCount: number;
}

export function parseGcodeToolpath(gcode: string, filamentColors?: string[]): Toolpath {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();

  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let absoluteE = false;
  let currentFilamentColor =
    filamentColors && filamentColors.length > 0 ? new THREE.Color(filamentColors[0]).getHex() : DEFAULT_COLOR;
  let currentColor = currentFilamentColor;
  let currentType = '';
  let layers = 0;
  let segments = 0;

  for (let start = 0; start < gcode.length && segments < MAX_SEGMENTS;) {
    let end = gcode.indexOf('\n', start);
    if (end < 0) end = gcode.length;
    const line = gcode.slice(start, end);
    start = end + 1;

    if (line.startsWith(';')) {
      if (line.startsWith(';TYPE:')) {
        currentType = line.slice(6).trim();
        if (currentType === 'Support' || currentType === 'Support interface') {
          currentColor = TYPE_COLORS[currentType] ?? DEFAULT_COLOR;
        } else {
          currentColor =
            !filamentColors || filamentColors.length === 0
              ? (TYPE_COLORS[currentType] ?? DEFAULT_COLOR)
              : currentFilamentColor;
        }
      } else if (line.startsWith('; CHANGE_LAYER') || line.startsWith(';LAYER_CHANGE')) {
        layers += 1;
      }
      continue;
    }

    if (line.startsWith('T') && filamentColors && filamentColors.length > 0) {
      const match = /^T(\d+)/.exec(line);
      if (match) {
        const toolIndex = parseInt(match[1], 10);
        if (toolIndex >= 0 && toolIndex < filamentColors.length) {
          currentFilamentColor = new THREE.Color(filamentColors[toolIndex]).getHex();
          if (currentType !== 'Support' && currentType !== 'Support interface') {
            currentColor = currentFilamentColor;
          }
        }
      }
      continue;
    }

    // Cheap dispatch before regex-free parsing.
    if (line.startsWith('G92')) {
      const em = / E(-?\d*\.?\d+)/.exec(line);
      if (em) e = Number(em[1]);
      continue;
    }
    if (line.startsWith('M82')) {
      absoluteE = true;
      continue;
    }
    if (line.startsWith('M83')) {
      absoluteE = false;
      continue;
    }
    if (!(line.startsWith('G1') || line.startsWith('G0'))) continue;

    let nx = x;
    let ny = y;
    let nz = z;
    let de = 0;
    // Tokenize: G1 X1.2 Y3 E0.5 F1200 ; comment
    for (let i = 2; i < line.length;) {
      const c = line.charCodeAt(i);
      if (c === 59 /* ; */) break;
      if (c === 32 /* space */) {
        i += 1;
        continue;
      }
      const letter = line[i];
      let j = i + 1;
      while (j < line.length && line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 59) j += 1;
      const v = Number(line.slice(i + 1, j));
      if (Number.isFinite(v)) {
        if (letter === 'X') nx = v;
        else if (letter === 'Y') ny = v;
        else if (letter === 'Z') nz = v;
        else if (letter === 'E') de = absoluteE ? v - e : v;
        if (letter === 'E') e = absoluteE ? v : e + v;
      }
      i = j;
    }

    if (de > 0 && (nx !== x || ny !== y || nz !== z)) {
      positions.push(x, y, z, nx, ny, nz);
      color.setHex(currentColor);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      segments += 1;
    }
    x = nx;
    y = ny;
    z = nz;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return { geometry, layerCount: layers, segmentCount: segments };
}
