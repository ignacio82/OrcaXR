/**
 * Canonical projection for AI/semantic painting (P4.9).
 *
 * An assistant never paints. It returns a bounded, strictly typed *proposal*
 * of surface regions; this module resolves that proposal against the volume's
 * own canonical mesh into exact source-triangle sets, and the session commits
 * those through the same `PaintStrokeService` a manual stroke uses. Nothing
 * here touches display colours, and a proposal that cannot be resolved
 * deterministically is rejected rather than approximated — an assistant
 * failure must never change what the slicer sees.
 *
 * Region kinds are deliberately limited to the two shapes a model can state
 * unambiguously and we can project exactly: a box in the volume's normalized
 * bounding-box space, and a normal-direction cone. Free-form polygons are not
 * accepted, because projecting them would require inventing a camera the
 * proposal never declared.
 */

import type { FacetSelectionMesh, FacetTriangle } from '../annotations';
import type { VolumeId } from '../domain/ids';
import type { Vec3 } from '../domain/model';

/** Bounded so one malformed or hostile response cannot exhaust the tab. */
export const AI_PAINT_MAX_REGIONS = 32;
export const AI_PAINT_MAX_LABEL_LENGTH = 64;
export const AI_PAINT_PROPOSAL_VERSION = 1;

export type AiPaintRegionShape =
  | {
      readonly kind: 'box';
      /** Inclusive corners in the volume AABB's normalized `[0, 1]` space. */
      readonly min: Vec3;
      readonly max: Vec3;
    }
  | {
      readonly kind: 'direction';
      /** Outward direction the facet normal is compared against. */
      readonly axis: Vec3;
      /** Half-angle of the acceptance cone, in degrees. */
      readonly maxAngleDeg: number;
    };

export interface AiPaintRegionProposal {
  /** Stable within one proposal; assigned by index so a provider cannot collide them. */
  readonly id: string;
  readonly label: string;
  readonly shape: AiPaintRegionShape;
  /** Provider confidence in `[0, 1]`. */
  readonly confidence: number;
}

export interface AiPaintProposal {
  readonly schemaVersion: typeof AI_PAINT_PROPOSAL_VERSION;
  readonly regions: readonly AiPaintRegionProposal[];
}

export class AiPaintProposalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed-proposal'
      | 'unsupported-version'
      | 'empty-proposal'
      | 'too-many-regions'
      | 'malformed-region'
      | 'degenerate-mesh',
  ) {
    super(message);
    this.name = 'AiPaintProposalError';
  }
}

export interface AiPaintResolvedRegion {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  /**
   * Final source-triangle indices after later regions overwrite earlier ones,
   * ascending. This is exactly what a commit would paint.
   */
  readonly triangleIndices: readonly number[];
  /** Share of the volume's facets this region ends up owning, in `[0, 1]`. */
  readonly coverage: number;
}

export interface AiPaintProjection {
  readonly volumeId: VolumeId;
  readonly topologyRevision: number;
  readonly triangleCount: number;
  readonly regions: readonly AiPaintResolvedRegion[];
  /** Share of the volume's facets any region claims, in `[0, 1]`. */
  readonly coverage: number;
  /** Facets no region claims; they keep whatever they already carry. */
  readonly unassignedTriangleCount: number;
  /**
   * Coverage-weighted mean of the surviving regions' confidences, or 0 when
   * nothing was claimed. Never a substitute for the per-region values.
   */
  readonly confidence: number;
}

/**
 * Strictly parse a provider response. Every field is required and bounded;
 * unknown fields are ignored rather than trusted, and no default is invented
 * for a value the provider failed to state.
 */
export function parseAiPaintProposal(raw: unknown): AiPaintProposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AiPaintProposalError('The assistant response is not a JSON object', 'malformed-proposal');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== AI_PAINT_PROPOSAL_VERSION) {
    throw new AiPaintProposalError(
      `Expected proposal schema ${AI_PAINT_PROPOSAL_VERSION}, received ${String(record['schemaVersion'])}`,
      'unsupported-version',
    );
  }
  const rawRegions = record['regions'];
  if (!Array.isArray(rawRegions)) {
    throw new AiPaintProposalError('The assistant response has no region list', 'malformed-proposal');
  }
  if (rawRegions.length === 0) {
    throw new AiPaintProposalError('The assistant proposed no regions', 'empty-proposal');
  }
  if (rawRegions.length > AI_PAINT_MAX_REGIONS) {
    throw new AiPaintProposalError(
      `The assistant proposed ${rawRegions.length} regions; at most ${AI_PAINT_MAX_REGIONS} are accepted`,
      'too-many-regions',
    );
  }
  const regions = rawRegions.map((region, index) => parseRegion(region, index));
  return Object.freeze({
    schemaVersion: AI_PAINT_PROPOSAL_VERSION,
    regions: Object.freeze(regions),
  });
}

/**
 * Resolve a proposal against the volume's canonical mesh. Regions are applied
 * in declared order and a later region overwrites an earlier one, matching how
 * successive manual strokes layer.
 */
export function projectAiPaintProposal(request: {
  readonly proposal: AiPaintProposal;
  readonly mesh: FacetSelectionMesh;
  readonly volumeId: VolumeId;
  readonly topologyRevision: number;
}): AiPaintProjection {
  const { mesh, proposal } = request;
  const triangleCount = mesh.triangles.length;
  if (triangleCount === 0) {
    throw new AiPaintProposalError('The target volume has no facets to paint', 'degenerate-mesh');
  }
  const bounds = meshBounds(mesh);

  // -1 means "no region claims this facet"; a later region overwrites.
  const owner = new Int32Array(triangleCount).fill(-1);
  for (const [regionIndex, region] of proposal.regions.entries()) {
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      if (matchesRegion(region.shape, mesh, mesh.triangles[triangle], bounds)) owner[triangle] = regionIndex;
    }
  }

  const perRegion: number[][] = proposal.regions.map(() => []);
  let claimed = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const regionIndex = owner[triangle];
    if (regionIndex < 0) continue;
    perRegion[regionIndex].push(triangle);
    claimed += 1;
  }

  const regions = proposal.regions.map((region, index) =>
    Object.freeze({
      id: region.id,
      label: region.label,
      confidence: region.confidence,
      triangleIndices: Object.freeze(perRegion[index]),
      coverage: perRegion[index].length / triangleCount,
    } satisfies AiPaintResolvedRegion),
  );
  const weighted = regions.reduce((total, region) => total + region.confidence * region.triangleIndices.length, 0);

  return Object.freeze({
    volumeId: request.volumeId,
    topologyRevision: request.topologyRevision,
    triangleCount,
    regions: Object.freeze(regions),
    coverage: claimed / triangleCount,
    unassignedTriangleCount: triangleCount - claimed,
    confidence: claimed === 0 ? 0 : weighted / claimed,
  });
}

interface MeshBounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly span: Vec3;
}

function meshBounds(mesh: FacetSelectionMesh): MeshBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const vertex of mesh.vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (vertex[axis] < min[axis]) min[axis] = vertex[axis];
      if (vertex[axis] > max[axis]) max[axis] = vertex[axis];
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) {
    throw new AiPaintProposalError('The target volume has no finite bounds', 'degenerate-mesh');
  }
  // A flat axis keeps a zero span; normalization maps it to 0 rather than NaN.
  const span: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min: Object.freeze(min) as Vec3, max: Object.freeze(max) as Vec3, span: Object.freeze(span) as Vec3 };
}

function matchesRegion(
  shape: AiPaintRegionShape,
  mesh: FacetSelectionMesh,
  triangle: FacetTriangle,
  bounds: MeshBounds,
): boolean {
  const a = mesh.vertices[triangle[0]];
  const b = mesh.vertices[triangle[1]];
  const c = mesh.vertices[triangle[2]];
  if (!a || !b || !c) return false;
  if (shape.kind === 'box') {
    for (let axis = 0; axis < 3; axis += 1) {
      const centroid = (a[axis] + b[axis] + c[axis]) / 3;
      const normalized = bounds.span[axis] === 0 ? 0 : (centroid - bounds.min[axis]) / bounds.span[axis];
      if (normalized < shape.min[axis] || normalized > shape.max[axis]) return false;
    }
    return true;
  }
  const normal = triangleNormal(a, b, c);
  if (!normal) return false;
  const axis = normalize(shape.axis);
  if (!axis) return false;
  const dot = clamp(normal[0] * axis[0] + normal[1] * axis[1] + normal[2] * axis[2], -1, 1);
  return Math.acos(dot) <= (shape.maxAngleDeg * Math.PI) / 180;
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
  return normalize([
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ]);
}

function normalize(vector: Vec3 | readonly [number, number, number]): Vec3 | undefined {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length === 0) return undefined;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseRegion(raw: unknown, index: number): AiPaintRegionProposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AiPaintProposalError(`Region ${index + 1} is not an object`, 'malformed-region');
  }
  const record = raw as Record<string, unknown>;
  const label = record['label'];
  if (typeof label !== 'string' || !label.trim() || label.length > AI_PAINT_MAX_LABEL_LENGTH) {
    throw new AiPaintProposalError(
      `Region ${index + 1} needs a label of 1–${AI_PAINT_MAX_LABEL_LENGTH} characters`,
      'malformed-region',
    );
  }
  const confidence = record['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new AiPaintProposalError(`Region ${index + 1} needs a confidence in [0, 1]`, 'malformed-region');
  }
  return Object.freeze({
    // Provider-supplied IDs are ignored: positional identity cannot collide.
    id: `ai-region-${index + 1}`,
    label: label.trim(),
    shape: parseShape(record['shape'], index),
    confidence,
  });
}

function parseShape(raw: unknown, index: number): AiPaintRegionShape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AiPaintProposalError(`Region ${index + 1} has no shape`, 'malformed-region');
  }
  const record = raw as Record<string, unknown>;
  if (record['kind'] === 'box') {
    const min = parseVec3(record['min'], index, 'min');
    const max = parseVec3(record['max'], index, 'max');
    for (let axis = 0; axis < 3; axis += 1) {
      if (min[axis] < 0 || max[axis] > 1 || max[axis] < min[axis]) {
        throw new AiPaintProposalError(
          `Region ${index + 1} needs a non-inverted box inside the normalized [0, 1] volume`,
          'malformed-region',
        );
      }
    }
    return Object.freeze({ kind: 'box', min, max });
  }
  if (record['kind'] === 'direction') {
    const axis = parseVec3(record['axis'], index, 'axis');
    if (!normalize(axis)) {
      throw new AiPaintProposalError(`Region ${index + 1} has a zero-length direction axis`, 'malformed-region');
    }
    const maxAngleDeg = record['maxAngleDeg'];
    if (typeof maxAngleDeg !== 'number' || !Number.isFinite(maxAngleDeg) || maxAngleDeg <= 0 || maxAngleDeg > 180) {
      throw new AiPaintProposalError(
        `Region ${index + 1} needs a direction half-angle in (0, 180] degrees`,
        'malformed-region',
      );
    }
    return Object.freeze({ kind: 'direction', axis, maxAngleDeg });
  }
  throw new AiPaintProposalError(
    `Region ${index + 1} uses unsupported shape kind ${String(record['kind'])}`,
    'malformed-region',
  );
}

function parseVec3(raw: unknown, index: number, field: string): Vec3 {
  if (!Array.isArray(raw) || raw.length !== 3 || raw.some((value) => typeof value !== 'number')) {
    throw new AiPaintProposalError(`Region ${index + 1} field ${field} must be three numbers`, 'malformed-region');
  }
  const vector = raw as number[];
  if (!vector.every(Number.isFinite)) {
    throw new AiPaintProposalError(`Region ${index + 1} field ${field} must be finite`, 'malformed-region');
  }
  return Object.freeze([vector[0], vector[1], vector[2]]) as Vec3;
}
