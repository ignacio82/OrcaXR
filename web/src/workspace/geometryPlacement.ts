/**
 * Where the workspace puts a model it builds from a geometry — a primitive, a
 * library model, a calibration piece: centred on the printable area in X and Y
 * (`WorkspaceBed.areaMm`, the midpoint of its corners — a printer may offset it
 * from the bed corner) and resting on the bed, from the geometry's own bounds
 * (`OrcaWorkspace.addModelFromGeometry`).
 *
 * The bounds are three's (`computeBoundingBox` over the Float32 positions, its
 * `Math.min`/`Math.max` expansion), so the shared core reproduces them from the
 * same Float32 coordinates (`orcaxr_project::primitives`).
 */
import type * as THREE from 'three';
import type { Transform } from '../project/domain/model';
import type { AabbXY } from '../project/objects/wipeTowerPlacement';

export interface GeometryPlacementOptions {
  /** Keep the geometry's own X and Y (a model already authored in printer space). */
  readonly preservePrinterXY?: boolean;
  /** Keep the geometry's own Z instead of resting it on the bed. */
  readonly preservePrinterZ?: boolean;
}

/** The instance transform that centres [geometry] on [area] (printer mm) and rests it on the bed. */
export function geometryBedPlacement(
  geometry: THREE.BufferGeometry,
  area: Readonly<AabbXY>,
  options: GeometryPlacementOptions = {},
): Transform {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || bb.isEmpty()) throw new Error('Imported geometry has no finite bounds');
  const centerX = (bb.min.x + bb.max.x) / 2;
  const centerY = (bb.min.y + bb.max.y) / 2;
  return {
    translationMm: [
      options.preservePrinterXY ? 0 : (area.xMin + area.xMax) / 2 - centerX,
      options.preservePrinterXY ? 0 : (area.yMin + area.yMax) / 2 - centerY,
      options.preservePrinterZ ? 0 : -bb.min.z,
    ],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}
