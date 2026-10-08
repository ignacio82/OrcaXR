/**
 * Surface measurement over a live session, in the shared contract's encoding:
 * the workspace's Measure tool (`measure.ts`) answered for a host.
 *
 * A volume is captured from an acknowledged state and its assets into its
 * pinned plane/border/feature decomposition; a pick on one of its facets
 * resolves to the feature the workspace would claim there — moved into the
 * frame of the host's row-major transform when one is given — with the
 * workspace's one-line readout. Any two features then measure to the
 * workspace's distances and angle. A volume or pick the workspace cannot
 * measure refuses with a code and a message. The Rust core answers the same
 * requests (`orcaxr_project::measure`).
 */
import type {
  ProjectMeasureFeatureReplyWire,
  ProjectMeasureFeatureRequestWire,
  ProjectMeasureRefusalCodeWire,
  ProjectMeasureReplyWire,
  ProjectMeasureRequestWire,
  ProjectMeasureVolumeReplyWire,
  ProjectMeasureVolumeRequestWire,
  ProjectSurfaceFeatureWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { VolumeId } from '../domain/ids';
import type { ProjectState, Vec3 } from '../domain/model';
import { findVolume } from '../domain/selectors';
import { decodeIndexedMeshAsset } from '../meshCodec';
import {
  MeasureError,
  SurfaceFeatureExtractor,
  describeSurfaceFeature,
  measureSurfaceFeatures,
  transformSurfaceFeature,
  type DistanceAndPoints,
  type FeatureWorldTransform,
  type SurfaceFeature,
} from './measure';

/** Why a volume, pick or pair does not measure. */
export class MeasureRefusal extends Error {
  constructor(
    message: string,
    readonly code: ProjectMeasureRefusalCodeWire,
  ) {
    super(message);
    this.name = 'MeasureRefusal';
  }
}

const vector = (value: readonly number[]): Vec3 => [value[0], value[1], value[2]];
const finite = (...values: readonly number[]): boolean => values.every(Number.isFinite);

export function featureToWire(feature: SurfaceFeature): ProjectSurfaceFeatureWire {
  switch (feature.kind) {
    case 'point':
      return { point: { point: vector(feature.point) } };
    case 'edge':
      return {
        edge: {
          from: vector(feature.from),
          to: vector(feature.to),
          extraPoint: feature.extraPoint ? { value: vector(feature.extraPoint) } : { absent: {} },
        },
      };
    case 'circle':
      return { circle: { center: vector(feature.center), normal: vector(feature.normal), radius: feature.radius } };
    case 'plane':
      return { plane: { index: feature.index, normal: vector(feature.normal), origin: vector(feature.origin) } };
  }
}

export function featureFromWire(wire: ProjectSurfaceFeatureWire): SurfaceFeature {
  if ('point' in wire) return { kind: 'point', point: vector(wire.point.point) };
  if ('edge' in wire) {
    const { from, to, extraPoint } = wire.edge;
    return {
      kind: 'edge',
      from: vector(from),
      to: vector(to),
      ...('value' in extraPoint ? { extraPoint: vector(extraPoint.value) } : {}),
    };
  }
  if ('circle' in wire) {
    const { center, normal, radius } = wire.circle;
    return { kind: 'circle', center: vector(center), normal: vector(normal), radius };
  }
  const { index, normal, origin } = wire.plane;
  return { kind: 'plane', index, normal: vector(normal), origin: vector(origin) };
}

function featureIsFinite(feature: SurfaceFeature): boolean {
  switch (feature.kind) {
    case 'point':
      return finite(...feature.point);
    case 'edge':
      return finite(...feature.from, ...feature.to, ...(feature.extraPoint ?? []));
    case 'circle':
      return finite(...feature.center, ...feature.normal, feature.radius);
    case 'plane':
      return finite(...feature.normal, ...feature.origin);
  }
}

/** One volume's features, captured for picking off the session. */
export class MeasureVolume {
  constructor(
    private readonly extractor: SurfaceFeatureExtractor,
    readonly triangleCount: number,
  ) {}

  summary(): { planeCount: number; triangleCount: number } {
    return { planeCount: this.extractor.planeCount, triangleCount: this.triangleCount };
  }

  /** The workspace's pick: the feature at a volume-local point on a facet. */
  feature(request: ProjectMeasureFeatureRequestWire): ProjectMeasureFeatureReplyWire {
    let feature: SurfaceFeature | undefined;
    try {
      feature = this.extractor.featureAt(request.faceIndex, vector(request.point), { onlyPlane: request.onlyPlane });
    } catch (error) {
      if (!(error instanceof MeasureError) || error.code !== 'unknown-face') throw error;
      return { refused: { code: 'unknownFace', message: wireUnits(error.message) } };
    }
    if ('value' in request.transform) {
      feature = transformSurfaceFeature(feature, request.transform.value as unknown as FeatureWorldTransform);
      if (!feature) {
        return {
          refused: {
            code: 'unevenScale',
            message: wireUnits('That hole is scaled unevenly, so it has no single radius to measure.'),
          },
        };
      }
    }
    if (!featureIsFinite(feature)) {
      return { refused: { code: 'nonFinite', message: wireUnits('The picked feature is not finite') } };
    }
    return { feature: { feature: featureToWire(feature), summary: wireUnits(describeSurfaceFeature(feature)) } };
  }
}

/**
 * Capture one volume's features from a state and its assets. Throws
 * `MeasureRefusal`.
 */
export function captureMeasureVolume(state: ProjectState, assets: AssetRepository, volumeId: VolumeId): MeasureVolume {
  const found = findVolume(state, volumeId);
  if (!found) throw new MeasureRefusal(`Unknown volume ${volumeId}`, 'unknownVolume');
  const payload = assets.get(found.volume.source.assetId);
  if (!payload) throw new MeasureRefusal(`Volume ${volumeId} has no stored mesh asset`, 'missingAsset');
  let mesh;
  try {
    mesh = decodeIndexedMeshAsset(payload);
  } catch (error) {
    throw new MeasureRefusal((error as Error).message, 'invalidMesh');
  }
  try {
    return new MeasureVolume(
      new SurfaceFeatureExtractor({ vertices: mesh.vertices, triangles: mesh.triangles }),
      mesh.triangles.length,
    );
  } catch (error) {
    if (!(error instanceof MeasureError)) throw error;
    throw new MeasureRefusal(error.message, 'degenerateMesh');
  }
}

/** `MeasureVolumeRequest` → `MeasureVolumeReply`, with the captured volume. */
export function captureMeasureVolumeWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectMeasureVolumeRequestWire,
): { reply: ProjectMeasureVolumeReplyWire; volume?: MeasureVolume } {
  try {
    const volume = captureMeasureVolume(state, assets, wireText(request.volumeId) as VolumeId);
    return { reply: { captured: volume.summary() }, volume };
  } catch (error) {
    if (!(error instanceof MeasureRefusal)) throw error;
    return { reply: { refused: { code: error.code, message: wireUnits(error.message) } } };
  }
}

function distanceToWire(value: DistanceAndPoints | undefined) {
  return value
    ? { value: { distance: value.distance, from: vector(value.from), to: vector(value.to) } }
    : { absent: {} };
}

/** `MeasureRequest` → `MeasureReply`: the workspace's measurement of a pair. */
export function measureFeaturesWire(request: ProjectMeasureRequestWire): ProjectMeasureReplyWire {
  const result = measureSurfaceFeatures(featureFromWire(request.first), featureFromWire(request.second));
  const numbers = [
    ...(result.angle ? [result.angle.angle, ...result.angle.center, result.angle.radius] : []),
    ...[result.distanceInfinite, result.distanceStrict].flatMap((d) => (d ? [d.distance, ...d.from, ...d.to] : [])),
    ...(result.distanceXyz ?? []),
  ];
  if (!finite(...numbers)) {
    return { refused: { code: 'nonFinite', message: wireUnits('The measurement is not finite') } };
  }
  return {
    measured: {
      angle: result.angle
        ? {
            value: {
              angle: result.angle.angle,
              center: vector(result.angle.center),
              radius: result.angle.radius,
              coplanar: result.angle.coplanar,
            },
          }
        : { absent: {} },
      distanceInfinite: distanceToWire(result.distanceInfinite),
      distanceStrict: distanceToWire(result.distanceStrict),
      distanceXyz: result.distanceXyz ? { value: vector(result.distanceXyz) } : { absent: {} },
      unsupported: result.unsupported === 'non-parallel-circle-pair',
    },
  };
}
