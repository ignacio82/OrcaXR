import * as THREE from 'three';

import { GCODE_RECORD_KIND, type RichGcodeModel } from '../../slicer/RichGcodeModel';
import type { ReadyGcodePreviewProjection } from '../../slicer/GcodePreviewModel';

export interface GcodePreviewSurfaceOptions {
  readonly parent: THREE.Object3D;
  /** Printer millimetres → world units, matching the canonical plate mapping. */
  readonly worldUnitsPerMm: number;
  /** Printer-space origin offset applied before scaling, in millimetres. */
  readonly originOffsetMm?: readonly [number, number, number];
}

export interface GcodePreviewRenderResult {
  readonly segmentCount: number;
  readonly recordCount: number;
  readonly skippedRecordCount: number;
}

/** Record kinds that describe a drawable head movement. */
const DRAWABLE_KINDS = new Set<number>([
  GCODE_RECORD_KIND.EXTRUDE,
  GCODE_RECORD_KIND.TRAVEL,
  GCODE_RECORD_KIND.WIPE,
  GCODE_RECORD_KIND.RETRACT,
  GCODE_RECORD_KIND.UNRETRACT,
]);

/**
 * One-way Three projection of a rich G-code model plus a preview projection.
 *
 * The surface never decides colour, filtering, or ordering: it draws exactly
 * the records the projection selected, in its order, with its RGBA. Markers
 * without movement (layer/tool/colour changes, pauses) carry no geometry and
 * are reported as skipped rather than drawn at the origin.
 */
export class GcodePreviewSurface {
  private lines: THREE.LineSegments | null = null;
  private readonly group = new THREE.Group();

  constructor(private readonly options: GcodePreviewSurfaceOptions) {
    this.group.name = 'gcode-preview';
    this.options.parent.add(this.group);
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  render(model: RichGcodeModel, projection: ReadyGcodePreviewProjection): GcodePreviewRenderResult {
    this.clear();
    const columns = model.columns;
    const scale = this.options.worldUnitsPerMm;
    const [offsetX, offsetY, offsetZ] = this.options.originOffsetMm ?? [0, 0, 0];
    const positions = new Float32Array(projection.count * 6);
    const colors = new Float32Array(projection.count * 6);
    let segments = 0;
    let skipped = 0;

    for (let index = 0; index < projection.count; index += 1) {
      const record = projection.recordIndices[index];
      if (record >= columns.count) {
        skipped += 1;
        continue;
      }
      if (!DRAWABLE_KINDS.has(columns.kind[record])) {
        skipped += 1;
        continue;
      }
      const startX = columns.startX[record];
      const startY = columns.startY[record];
      const startZ = columns.startZ[record];
      const endX = columns.endX[record];
      const endY = columns.endY[record];
      const endZ = columns.endZ[record];
      if (
        ![startX, startY, startZ, endX, endY, endZ].every((value) => Number.isFinite(value)) ||
        (startX === endX && startY === endY && startZ === endZ)
      ) {
        skipped += 1;
        continue;
      }
      const vertex = segments * 6;
      // Printer frame (Z up, bed-corner origin) → world (Y up, centred).
      positions[vertex] = (startX + offsetX) * scale;
      positions[vertex + 1] = (startZ + offsetZ) * scale;
      positions[vertex + 2] = -(startY + offsetY) * scale;
      positions[vertex + 3] = (endX + offsetX) * scale;
      positions[vertex + 4] = (endZ + offsetZ) * scale;
      positions[vertex + 5] = -(endY + offsetY) * scale;
      const rgba = index * 4;
      for (const corner of [0, 3]) {
        colors[vertex + corner] = projection.colorsRgba[rgba];
        colors[vertex + corner + 1] = projection.colorsRgba[rgba + 1];
        colors[vertex + corner + 2] = projection.colorsRgba[rgba + 2];
      }
      segments += 1;
    }

    if (segments === 0) {
      return Object.freeze({ segmentCount: 0, recordCount: projection.count, skippedRecordCount: skipped });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, segments * 6), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, segments * 6), 3));
    geometry.computeBoundingSphere();
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'gcode-preview-lines';
    // Display only: a preview must never intercept selection or paint rays.
    lines.raycast = () => {};
    this.group.add(lines);
    this.lines = lines;
    return Object.freeze({ segmentCount: segments, recordCount: projection.count, skippedRecordCount: skipped });
  }

  clear(): void {
    if (!this.lines) return;
    this.group.remove(this.lines);
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.lines = null;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
