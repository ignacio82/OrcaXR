/**
 * G-code → three.js toolpath geometry. Walks the sliced G-code, tracks
 * the toolhead, and emits extrusion moves as line segments colored by
 * feature type (the `;TYPE:` comments libslic3r writes — same tags the
 * Android app's GcodeParser consumes).
 */
import * as THREE from 'three';

import {
  GCODE_RENDER_HARD_CAPS,
  countGcodeRecordPathSegments,
  validateGcodePathSidecar,
  visitGcodeRecordPathSegments,
} from './GcodePathSegments';
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

export interface Toolpath {
  /** One LineSegments-ready geometry (positions in printer mm, Z-up). */
  geometry: THREE.BufferGeometry;
  layerCount: number;
  segmentCount: number;
}

export function parseGcodeToolpath(gcode: string, filamentColors?: string[]): Toolpath {
  const model = parseRichGcodeModel(gcode, { filamentColors });
  validateGcodePathSidecar(model);
  const columns = model.columns;
  let segments = 0;
  for (let index = 0; index < columns.count; index += 1) {
    if (columns.kind[index] !== GCODE_RECORD_KIND.EXTRUDE) continue;
    const recordSegments = countGcodeRecordPathSegments(model, index);
    if (recordSegments > GCODE_RENDER_HARD_CAPS.segments - segments) {
      throw new Error(`G-code toolpath requires more than ${GCODE_RENDER_HARD_CAPS.segments} rendered segments`);
    }
    segments += recordSegments;
  }

  const positions = new Float32Array(segments * 6);
  const colors = new Float32Array(segments * 6);
  const color = new THREE.Color();
  let currentFilamentColor =
    filamentColors && filamentColors.length > 0 ? new THREE.Color(filamentColors[0]).getHex() : DEFAULT_COLOR;
  let output = 0;

  for (let index = 0; index < columns.count; index += 1) {
    const kind = columns.kind[index];
    if (kind === GCODE_RECORD_KIND.TOOL_CHANGE && filamentColors && filamentColors.length > 0) {
      const tool = columns.tool[index];
      if (tool < filamentColors.length) currentFilamentColor = new THREE.Color(filamentColors[tool]).getHex();
      continue;
    }
    if (kind !== GCODE_RECORD_KIND.EXTRUDE) continue;

    const currentType = model.roles[columns.role[index]] ?? 'Undefined';
    const currentColor =
      currentType === 'Support' || currentType === 'Support interface'
        ? (TYPE_COLORS[currentType] ?? DEFAULT_COLOR)
        : !filamentColors || filamentColors.length === 0
          ? (TYPE_COLORS[currentType] ?? DEFAULT_COLOR)
          : currentFilamentColor;
    color.setHex(currentColor);
    visitGcodeRecordPathSegments(model, index, (startX, startY, startZ, endX, endY, endZ) => {
      const vertex = output * 6;
      positions[vertex] = startX;
      positions[vertex + 1] = startY;
      positions[vertex + 2] = startZ;
      positions[vertex + 3] = endX;
      positions[vertex + 4] = endY;
      positions[vertex + 5] = endZ;
      colors[vertex] = color.r;
      colors[vertex + 1] = color.g;
      colors[vertex + 2] = color.b;
      colors[vertex + 3] = color.r;
      colors[vertex + 4] = color.g;
      colors[vertex + 5] = color.b;
      output += 1;
    });
  }
  if (output !== segments) {
    throw new Error('G-code path sidecar changed while constructing legacy geometry');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return { geometry, layerCount: model.layerCount, segmentCount: segments };
}

/** Export sliced extrusion toolpaths as a Wavefront OBJ string. */
export function exportToolpathsToObj(gcode: string): string {
  const model = parseRichGcodeModel(gcode);
  validateGcodePathSidecar(model);
  const columns = model.columns;
  const lines: string[] = ['# Sliced Toolpaths exported by OrcaXR'];
  let vertexIndex = 1;
  const lineIndices: string[] = [];

  for (let index = 0; index < columns.count; index += 1) {
    if (columns.kind[index] !== GCODE_RECORD_KIND.EXTRUDE) continue;
    visitGcodeRecordPathSegments(model, index, (startX, startY, startZ, endX, endY, endZ) => {
      lines.push(`v ${startX.toFixed(4)} ${startY.toFixed(4)} ${startZ.toFixed(4)}`);
      lines.push(`v ${endX.toFixed(4)} ${endY.toFixed(4)} ${endZ.toFixed(4)}`);
      lineIndices.push(`l ${vertexIndex} ${vertexIndex + 1}`);
      vertexIndex += 2;
    });
  }
  return lines.concat(lineIndices).join('\n');
}
