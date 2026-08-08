import * as THREE from 'three';

import {
  GCODE_RENDER_HARD_CAPS,
  countGcodeRecordPathSegments,
  validateGcodePathSidecar,
  visitGcodeRecordPathSegments,
} from '../../slicer/GcodePathSegments';
import { GCODE_RECORD_KIND, type RichGcodeModel } from '../../slicer/RichGcodeModel';
import type { ReadyGcodePreviewProjection } from '../../slicer/GcodePreviewModel';

export interface GcodePreviewSurfaceOptions {
  readonly parent: THREE.Object3D;
  /** Printer millimetres → world units, matching the canonical plate mapping. */
  readonly worldUnitsPerMm: number;
  /** Printer-space origin offset applied before scaling, in millimetres. */
  readonly originOffsetMm?: readonly [number, number, number];
  /** Requested values are bounded by the non-negotiable renderer hard cap. */
  readonly maxRenderedSegments?: number;
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
const MAX_FLOAT32 = 3.4028234663852886e38;

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
    validateGcodePathSidecar(model);
    validateProjection(model, projection);
    const columns = model.columns;
    const scale = this.options.worldUnitsPerMm;
    const [offsetX, offsetY, offsetZ] = this.options.originOffsetMm ?? [0, 0, 0];
    if (
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(offsetX) ||
      !Number.isFinite(offsetY) ||
      !Number.isFinite(offsetZ)
    ) {
      throw new Error('G-code preview surface transform must contain finite values and a positive scale');
    }
    const maximum = this.options.maxRenderedSegments ?? GCODE_RENDER_HARD_CAPS.segments;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > GCODE_RENDER_HARD_CAPS.segments) {
      throw new Error(`G-code preview segment limit must be in [1, ${GCODE_RENDER_HARD_CAPS.segments}]`);
    }
    let segments = 0;
    let skipped = 0;

    for (let index = 0; index < projection.count; index += 1) {
      const record = projection.recordIndices[index];
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
      if (![startX, startY, startZ, endX, endY, endZ].every((value) => Number.isFinite(value))) {
        throw new Error(`G-code preview record ${record} contains a non-finite endpoint`);
      }
      const recordSegments = countGcodeRecordPathSegments(model, record);
      if (recordSegments === 0) {
        skipped += 1;
      } else if (recordSegments > maximum - segments) {
        throw new Error(`G-code preview requires more than ${maximum} rendered segments`);
      }
      segments += recordSegments;
    }

    if (segments === 0) {
      return Object.freeze({ segmentCount: 0, recordCount: projection.count, skippedRecordCount: skipped });
    }
    const positions = new Float32Array(segments * 6);
    const colors = new Float32Array(segments * 6);
    let output = 0;
    for (let index = 0; index < projection.count; index += 1) {
      const record = projection.recordIndices[index];
      if (!DRAWABLE_KINDS.has(columns.kind[record]) || countGcodeRecordPathSegments(model, record) === 0) continue;
      const rgba = index * 4;
      visitGcodeRecordPathSegments(model, record, (startX, startY, startZ, endX, endY, endZ) => {
        const vertex = output * 6;
        // Printer frame (Z up, bed-corner origin) → world (Y up, centred).
        const worldStartX = toFiniteFloat32((startX + offsetX) * scale, record);
        const worldStartY = toFiniteFloat32((startZ + offsetZ) * scale, record);
        const worldStartZ = toFiniteFloat32(-(startY + offsetY) * scale, record);
        const worldEndX = toFiniteFloat32((endX + offsetX) * scale, record);
        const worldEndY = toFiniteFloat32((endZ + offsetZ) * scale, record);
        const worldEndZ = toFiniteFloat32(-(endY + offsetY) * scale, record);
        positions[vertex] = worldStartX;
        positions[vertex + 1] = worldStartY;
        positions[vertex + 2] = worldStartZ;
        positions[vertex + 3] = worldEndX;
        positions[vertex + 4] = worldEndY;
        positions[vertex + 5] = worldEndZ;
        const red = projection.colorsRgba[rgba];
        const green = projection.colorsRgba[rgba + 1];
        const blue = projection.colorsRgba[rgba + 2];
        colors[vertex] = red;
        colors[vertex + 1] = green;
        colors[vertex + 2] = blue;
        colors[vertex + 3] = red;
        colors[vertex + 4] = green;
        colors[vertex + 5] = blue;
        output += 1;
      });
    }
    if (output !== segments) {
      throw new Error('G-code preview path sidecar changed during rendering');
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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

function toFiniteFloat32(value: number, record: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_FLOAT32) {
    throw new Error(`G-code preview record ${record} transforms outside the finite Float32 world domain`);
  }
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) {
    throw new Error(`G-code preview record ${record} transforms outside the finite Float32 world domain`);
  }
  return rounded;
}

function validateProjection(model: RichGcodeModel, projection: ReadyGcodePreviewProjection): void {
  if (
    projection.status !== 'ready' ||
    !Number.isSafeInteger(projection.count) ||
    projection.count < 0 ||
    projection.count > model.columns.count ||
    projection.sourceRecordCount !== model.columns.count ||
    !(projection.recordIndices instanceof Uint32Array) ||
    projection.recordIndices.length !== projection.count ||
    !(projection.colorsRgba instanceof Float32Array) ||
    projection.colorsRgba.length !== projection.count * 4
  ) {
    throw new Error('G-code preview projection is outside the bounded renderer domain');
  }
  let previous = -1;
  for (let index = 0; index < projection.count; index += 1) {
    const record = projection.recordIndices[index];
    if (record >= model.columns.count || record <= previous) {
      throw new Error('G-code preview record indices must be unique and strictly source-ordered');
    }
    previous = record;
    const rgba = index * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      const value = projection.colorsRgba[rgba + channel];
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`G-code preview record ${record} has an invalid projection colour`);
      }
    }
  }
}
