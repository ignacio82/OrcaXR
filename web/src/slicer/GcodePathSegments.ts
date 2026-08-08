import { GCODE_PATH_KIND, GCODE_RECORD_KIND, RICH_GCODE_HARD_CAPS, type RichGcodeModel } from './RichGcodeModel';

export const GCODE_RENDER_HARD_CAPS = Object.freeze({
  segments: 1_500_000,
});

export class GcodePathSidecarError extends Error {
  readonly name = 'GcodePathSidecarError';

  constructor(message: string) {
    super(message);
  }
}

export type GcodePathSegmentVisitor = (
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
) => void;

/**
 * Validate the compact path-point sidecar shared by preview, inspection, and
 * legacy geometry consumers. Offsets are a dense prefix sum over semantic
 * records; a record therefore cannot alias, skip, or claim another record's
 * interpolation points.
 */
export function validateGcodePathSidecar(model: RichGcodeModel): void {
  const columns = model?.columns;
  const points = model?.pathPoints;
  const recordCount = columns?.count;
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > RICH_GCODE_HARD_CAPS.records) {
    invalid('Rich G-code record count is outside the bounded path domain');
  }
  if (
    !(columns.pathKind instanceof Uint8Array) ||
    columns.pathKind.length !== recordCount ||
    !(columns.pathPointOffset instanceof Uint32Array) ||
    columns.pathPointOffset.length !== recordCount ||
    !(columns.pathPointCount instanceof Uint32Array) ||
    columns.pathPointCount.length !== recordCount ||
    !(columns.arcCenterX instanceof Float32Array) ||
    columns.arcCenterX.length !== recordCount ||
    !(columns.arcCenterY instanceof Float32Array) ||
    columns.arcCenterY.length !== recordCount
  ) {
    invalid('Rich G-code path columns are missing or differ in length');
  }
  if (
    !points ||
    !Number.isSafeInteger(points.count) ||
    points.count < 0 ||
    points.count > RICH_GCODE_HARD_CAPS.pathPoints ||
    !Number.isSafeInteger(model.limits?.pathPoints) ||
    model.limits.pathPoints < 1 ||
    model.limits.pathPoints > RICH_GCODE_HARD_CAPS.pathPoints ||
    points.count > model.limits.pathPoints ||
    !(points.x instanceof Float32Array) ||
    points.x.length !== points.count ||
    !(points.y instanceof Float32Array) ||
    points.y.length !== points.count ||
    !(points.z instanceof Float32Array) ||
    points.z.length !== points.count
  ) {
    invalid('Rich G-code path points are outside their bounded typed-array domain');
  }

  let runningPointCount = 0;
  for (let record = 0; record < recordCount; record += 1) {
    const kind = columns.pathKind[record];
    const offset = columns.pathPointOffset[record];
    const count = columns.pathPointCount[record];
    if (kind !== GCODE_PATH_KIND.DIRECT && kind !== GCODE_PATH_KIND.ARC_CW && kind !== GCODE_PATH_KIND.ARC_CCW) {
      invalid(`Rich G-code record ${record} has an invalid path kind`);
    }
    if (offset !== runningPointCount || count > points.count - runningPointCount) {
      invalid(`Rich G-code record ${record} has a non-canonical path-point slice`);
    }
    if (kind === GCODE_PATH_KIND.DIRECT && count !== 0) {
      invalid(`Rich G-code direct record ${record} cannot own interpolation points`);
    }
    if (kind === GCODE_PATH_KIND.ARC_CW || kind === GCODE_PATH_KIND.ARC_CCW) {
      const semanticKind = columns.kind[record];
      const deltaE = columns.deltaE[record];
      if (semanticKind !== GCODE_RECORD_KIND.TRAVEL && semanticKind !== GCODE_RECORD_KIND.EXTRUDE) {
        invalid(`Rich G-code arc record ${record} has an invalid semantic move kind`);
      }
      if (
        !Number.isFinite(deltaE) ||
        (semanticKind === GCODE_RECORD_KIND.TRAVEL && deltaE !== 0) ||
        (semanticKind === GCODE_RECORD_KIND.EXTRUDE && deltaE === 0)
      ) {
        invalid(`Rich G-code arc record ${record} has inconsistent extrusion semantics`);
      }
    }
    if (!Number.isFinite(columns.arcCenterX[record]) || !Number.isFinite(columns.arcCenterY[record])) {
      invalid(`Rich G-code record ${record} has a non-finite arc center`);
    }
    if (kind === GCODE_PATH_KIND.DIRECT && (columns.arcCenterX[record] !== 0 || columns.arcCenterY[record] !== 0)) {
      invalid(`Rich G-code direct record ${record} has non-canonical arc-center metadata`);
    }
    runningPointCount += count;
  }
  if (runningPointCount !== points.count) {
    invalid('Rich G-code path-point slices do not cover the dense sidecar exactly');
  }
  for (let point = 0; point < points.count; point += 1) {
    if (!Number.isFinite(points.x[point]) || !Number.isFinite(points.y[point]) || !Number.isFinite(points.z[point])) {
      invalid(`Rich G-code path point ${point} contains a non-finite coordinate`);
    }
  }
}

/** Count the non-degenerate line segments represented by one semantic record. */
export function countGcodeRecordPathSegments(model: RichGcodeModel, record: number): number {
  assertRecord(model, record);
  if (model.columns.pathKind[record] !== GCODE_PATH_KIND.DIRECT) {
    // The pinned viewer emits every interpolation edge plus the final edge,
    // including an exact zero-length final edge when the last point is the
    // command endpoint.
    return model.columns.pathPointCount[record] + 1;
  }
  return samePoint(
    model.columns.startX[record],
    model.columns.startY[record],
    model.columns.startZ[record],
    model.columns.endX[record],
    model.columns.endY[record],
    model.columns.endZ[record],
  )
    ? 0
    : 1;
}

/**
 * Visit one record's path in traversal order. Arc points inherit the record's
 * metadata; callers must not create new semantic record identities for them.
 */
export function visitGcodeRecordPathSegments(
  model: RichGcodeModel,
  record: number,
  visitor: GcodePathSegmentVisitor,
): void {
  const columns = model.columns;
  assertRecord(model, record);
  let startX = columns.startX[record];
  let startY = columns.startY[record];
  let startZ = columns.startZ[record];
  if (columns.pathKind[record] === GCODE_PATH_KIND.DIRECT) {
    const endX = columns.endX[record];
    const endY = columns.endY[record];
    const endZ = columns.endZ[record];
    if (!samePoint(startX, startY, startZ, endX, endY, endZ)) {
      visitor(startX, startY, startZ, endX, endY, endZ);
    }
    return;
  }
  const offset = columns.pathPointOffset[record];
  const count = columns.pathPointCount[record];
  const end = offset + count;
  for (let point = offset; point < end; point += 1) {
    const endX = model.pathPoints.x[point];
    const endY = model.pathPoints.y[point];
    const endZ = model.pathPoints.z[point];
    visitor(startX, startY, startZ, endX, endY, endZ);
    startX = endX;
    startY = endY;
    startZ = endZ;
  }
  const endX = columns.endX[record];
  const endY = columns.endY[record];
  const endZ = columns.endZ[record];
  visitor(startX, startY, startZ, endX, endY, endZ);
}

function assertRecord(model: RichGcodeModel, record: number): void {
  if (!Number.isSafeInteger(record) || record < 0 || record >= model.columns.count) {
    invalid('Rich G-code path record is outside the semantic record domain');
  }
}

function samePoint(
  leftX: number,
  leftY: number,
  leftZ: number,
  rightX: number,
  rightY: number,
  rightZ: number,
): boolean {
  return leftX === rightX && leftY === rightY && leftZ === rightZ;
}

function invalid(message: string): never {
  throw new GcodePathSidecarError(message);
}
