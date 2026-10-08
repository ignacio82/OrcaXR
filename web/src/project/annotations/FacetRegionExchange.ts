/**
 * Region selection over a live session, in the shared contract's encoding: a
 * host names a volume and a tool, the session decodes that volume's mesh and
 * reads its annotations, and the reply is a page of the selected ranges with
 * the facet guard a `facetStroke` intent commits them under. Invalid tool
 * input is reported with the selector's own issues; a request the session
 * cannot answer (an oversized page, an unknown volume, an unreadable mesh)
 * refuses. The Rust session serves the same pages
 * (`orcaxr_project::facets::region_exchange`).
 */
import type {
  ProjectFacetRegionReplyWire,
  ProjectFacetRegionRequestWire,
  ProjectFacetRegionStateWire,
  ProjectPaintValueInputWire,
} from '../../../../contracts/generated/project-intents';
import type { AssetRepository } from '../assets';
import type { JsonValue, Vec3 } from '../domain/model';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { ProjectSnapshot } from '../store';
import {
  selectFacetRegion,
  type FacetClippingPlane,
  type FacetRegionState,
  type FacetRegionTool,
  type FacetSelectionTransform,
} from './FacetRegionSelection';
import { FacetAnnotationValidationError, StaleFacetAnnotationResultError, type FacetAnnotationChannel } from './types';

/** The most ranges, and the most Gap Fill replacements, one page holds. */
export const FACET_REGION_PAGE_LIMIT = 4096;

export type FacetRegionRefusalCode = 'invalid-request' | 'unknown-volume' | 'invalid-mesh';

export class FacetRegionRefusal extends Error {
  constructor(readonly code: FacetRegionRefusalCode) {
    super(`Facet region request refused (${code})`);
    this.name = 'FacetRegionRefusal';
  }
}

/** Answer one wire request against an acknowledged snapshot and its assets. */
export function answerFacetRegion(
  snapshot: ProjectSnapshot,
  assets: Pick<AssetRepository, 'peek'>,
  request: ProjectFacetRegionRequestWire,
): ProjectFacetRegionReplyWire {
  if (request.count > FACET_REGION_PAGE_LIMIT) throw new FacetRegionRefusal('invalid-request');
  const volumeId = text(request.volumeId);
  const volume = snapshot.state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .find((candidate) => candidate.id === volumeId);
  if (!volume) throw new FacetRegionRefusal('unknown-volume');
  const payload = assets.peek(volume.source.assetId);
  if (!payload) throw new FacetRegionRefusal('invalid-mesh');
  let positions: Float32Array, indices: Uint32Array;
  try {
    ({ positions, indices } = decodeIndexedMeshAsset(payload));
  } catch {
    throw new FacetRegionRefusal('invalid-mesh');
  }
  const vertices = Array.from({ length: positions.length / 3 }, (_, i): Vec3 => [
    positions[i * 3],
    positions[i * 3 + 1],
    positions[i * 3 + 2],
  ]);
  const triangles = Array.from(
    { length: indices.length / 3 },
    (_, i) => [indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]] as const,
  );
  const guard = { topologyRevision: volume.source.topologyRevision, triangleCount: volume.source.triangleCount };
  const clippingPlane = 'value' in request.clippingPlane ? clipping(request.clippingPlane.value) : undefined;
  const transform = 'value' in request.transform ? selectionTransform(request.transform.value) : undefined;
  let selection;
  try {
    selection = selectFacetRegion({
      mesh: { vertices, triangles },
      annotations: volume.annotations,
      channel: request.channel as FacetAnnotationChannel,
      guard,
      seedTriangle: request.seedTriangle,
      tool: tool(request.tool),
      ...(clippingPlane ? { clippingPlane } : {}),
      ...(transform ? { transform } : {}),
      ...('value' in request.highlightByAngleDegrees
        ? { highlightByAngleDegrees: request.highlightByAngleDegrees.value }
        : {}),
    });
  } catch (error) {
    if (error instanceof FacetAnnotationValidationError) {
      return {
        invalid: error.issues.map((issue) => ({
          code: units(issue.code),
          path: units(issue.path),
          message: units(issue.message),
        })),
      };
    }
    if (error instanceof StaleFacetAnnotationResultError) return { stale: {} };
    throw error;
  }
  const end = request.start + request.count;
  const replacements = selection.gapFillReplacements ?? [];
  return {
    page: {
      guard: {
        revision: snapshot.revision,
        hash: units(snapshot.hash),
        volumeId: units(volume.id),
        topologyRevision: guard.topologyRevision,
        triangleCount: guard.triangleCount,
      },
      selectedTriangles: selection.triangleIndices.length,
      totalRanges: selection.ranges.length,
      ranges: selection.ranges.slice(request.start, end).map((r) => ({ start: r.start, endExclusive: r.endExclusive })),
      totalReplacements: replacements.length,
      replacements: replacements.slice(request.start, end).map((r) => ({
        areaMm2: r.areaMm2,
        source: stateWire(r.source),
        target: stateWire(r.target),
        triangleCount: r.triangleIndices.length,
        ranges: r.ranges.map((x) => ({ start: x.start, endExclusive: x.endExclusive })),
      })),
    },
  };
}

function tool(wire: ProjectFacetRegionRequestWire['tool']): FacetRegionTool {
  const vector = (value: readonly number[]): Vec3 => [value[0], value[1], value[2]];
  const hit = (value: { readonly absent: unknown } | { readonly value: readonly number[] }) =>
    'value' in value ? { hit: vector(value.value) } : {};
  if ('triangle' in wire) return { kind: 'triangle', ...hit(wire.triangle.hit) };
  if ('fill' in wire) {
    const angle = wire.fill.maxAdjacentAngleDegrees;
    return {
      kind: 'fill',
      ...hit(wire.fill.hit),
      edgeDetection: 'value' in angle ? { maxAdjacentAngleDegrees: angle.value } : false,
    };
  }
  if ('heightRange' in wire)
    return { kind: 'heightRange', startZMm: wire.heightRange.startZMm, heightMm: wire.heightRange.heightMm };
  if ('gapFill' in wire)
    return { kind: 'gapFill', maxAreaMm2: wire.gapFill.maxAreaMm2, stateOrder: wire.gapFill.stateOrder.map(paint) };
  const brush = 'circle' in wire ? wire.circle : wire.sphere;
  return {
    kind: 'circle' in wire ? 'circle' : 'sphere',
    center: vector(brush.center),
    ...('value' in brush.previousCenter ? { previousCenter: vector(brush.previousCenter.value) } : {}),
    cameraPosition: vector(brush.cameraPosition),
    radiusMm: brush.radiusMm,
  };
}

function clipping(wire: { readonly normal: readonly number[]; readonly offset: number }): FacetClippingPlane {
  return { normal: [wire.normal[0], wire.normal[1], wire.normal[2]], offset: wire.offset };
}

function selectionTransform(wire: {
  readonly linear: readonly (readonly number[])[];
  readonly translation: readonly number[];
  readonly scalingFactors: readonly number[];
}): FacetSelectionTransform {
  const vector = (value: readonly number[]): Vec3 => [value[0], value[1], value[2]];
  return {
    linear: [vector(wire.linear[0]), vector(wire.linear[1]), vector(wire.linear[2])],
    translation: vector(wire.translation),
    scalingFactors: vector(wire.scalingFactors),
  };
}

function paint(value: ProjectPaintValueInputWire): JsonValue {
  return 'text' in value ? text(value.text) : value.flag;
}

function stateWire(state: FacetRegionState): ProjectFacetRegionStateWire {
  if (state.kind === 'unpainted') return { unpainted: {} };
  const value = state.value;
  return { assigned: typeof value === 'boolean' ? { flag: value } : { text: units(String(value)) } };
}

function text(value: readonly number[]): string {
  let out = '';
  for (let offset = 0; offset < value.length; offset += 4096)
    out += String.fromCharCode(...value.slice(offset, offset + 4096));
  return out;
}

function units(value: string): number[] {
  return Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
}
