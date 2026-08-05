/**
 * G-code → three.js toolpath geometry. Walks the sliced G-code, tracks
 * the toolhead, and emits extrusion moves as line segments colored by
 * feature type (the `;TYPE:` comments libslic3r writes — same tags the
 * Android app's GcodeParser consumes).
 */
import * as THREE from 'three';

import { GCODE_RECORD_KIND, parseRichGcodeModel } from './RichGcodeModel';

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
  const model = parseRichGcodeModel(gcode, { filamentColors });
  const columns = model.columns;
  let currentFilamentColor =
    filamentColors && filamentColors.length > 0 ? new THREE.Color(filamentColors[0]).getHex() : DEFAULT_COLOR;
  let segments = 0;

  for (let index = 0; index < columns.count && segments < MAX_SEGMENTS; index += 1) {
    const kind = columns.kind[index];
    if (kind === GCODE_RECORD_KIND.TOOL_CHANGE && filamentColors && filamentColors.length > 0) {
      const tool = columns.tool[index];
      if (tool < filamentColors.length) currentFilamentColor = new THREE.Color(filamentColors[tool]).getHex();
      continue;
    }
    if (kind !== GCODE_RECORD_KIND.EXTRUDE) continue;

    positions.push(
      columns.startX[index],
      columns.startY[index],
      columns.startZ[index],
      columns.endX[index],
      columns.endY[index],
      columns.endZ[index],
    );
    const currentType = model.roles[columns.role[index]] ?? 'Undefined';
    const currentColor =
      currentType === 'Support' || currentType === 'Support interface'
        ? (TYPE_COLORS[currentType] ?? DEFAULT_COLOR)
        : !filamentColors || filamentColors.length === 0
          ? (TYPE_COLORS[currentType] ?? DEFAULT_COLOR)
          : currentFilamentColor;
    color.setHex(currentColor);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    segments += 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return { geometry, layerCount: model.layerCount, segmentCount: segments };
}
