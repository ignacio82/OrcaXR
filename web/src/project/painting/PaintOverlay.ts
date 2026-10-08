/**
 * The facets a paint overlay draws, as data a renderer uploads: every assigned
 * leaf of a channel's materialized refinement when the channel is subdivided,
 * otherwise each region's whole facets in order. The workspace's overlay
 * meshes are built from these facets, and the Rust core serves the same
 * packets over live sessions (`orcaxr_project::facets::overlay`).
 */
import type {
  ProjectPaintOverlayRequestWire,
  ProjectPaintOverlaySummaryWire,
} from '../../../../contracts/generated/project-intents';
import { regionStateWire, wireText, wireUnits } from '../annotations/FacetRegionExchange';
import {
  materializeFacetRefinement,
  type FacetRegionState,
  type FacetSelectionMesh,
} from '../annotations/FacetRegionSelection';
import {
  FacetAnnotationValidationError,
  StaleFacetAnnotationResultError,
  type FacetAnnotationChannel,
  type FacetAnnotationGuard,
} from '../annotations/types';
import type { AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { FacetAnnotations, FacetRefinementEncoding, JsonValue, Vec3 } from '../domain/model';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { ProjectSnapshot } from '../store';

/** One overlay region: whole source facets drawn in one state. */
export interface PaintOverlayRegion {
  readonly triangles: readonly number[];
  readonly state: FacetRegionState;
}

export interface PaintOverlayFacets {
  /** Three volume-local float32 corners per painted facet, in draw order. */
  readonly positions: Float32Array;
  /** Per painted facet, an index into `states`. */
  readonly stateIndices: Uint32Array;
  /** Distinct states, in first-drawn order. */
  readonly states: readonly FacetRegionState[];
}

/** Bytes per facet in a packet: nine little-endian float32 corners and a uint32 state index. */
export const PAINT_OVERLAY_FACET_BYTES = 40;

/**
 * The painted facets of one channel. With a refinement every region must be
 * assigned, as canonical assignments are: the refinement is materialized over
 * them and each assigned leaf is drawn, in leaf order. Without one each region's
 * facets are drawn in region order.
 */
export function paintOverlayFacets(
  mesh: FacetSelectionMesh,
  channel: FacetAnnotationChannel,
  regions: readonly PaintOverlayRegion[],
  options: {
    readonly refinement?: FacetRefinementEncoding;
    readonly topologyRevision?: number;
    readonly triangleCount?: number;
  } = {},
): PaintOverlayFacets {
  const painted: { readonly vertices: readonly number[]; readonly state: FacetRegionState }[] = [];
  let vertices: readonly Vec3[];
  if (options.refinement) {
    const topologyRevision = options.topologyRevision ?? 0;
    const annotations = {
      topologyRevision,
      color: [],
      support: [],
      seam: [],
      fuzzySkin: [],
      brim: [],
      refinement: { [channel]: options.refinement },
    } as unknown as FacetAnnotations;
    (annotations as unknown as Record<string, unknown>)[channel] = regions.map((region) => {
      if (region.state.kind !== 'assigned') throw new TypeError('Refined overlay regions must be assigned');
      return { triangles: region.triangles, value: region.state.value };
    });
    const materialized = materializeFacetRefinement({
      mesh,
      annotations,
      channel,
      guard: { topologyRevision, triangleCount: options.triangleCount ?? mesh.triangles.length },
      refinement: options.refinement,
    });
    vertices = materialized.vertices;
    for (const leaf of materialized.leaves) {
      if (leaf.state.kind === 'assigned') painted.push({ vertices: leaf.vertexIndices, state: leaf.state });
    }
  } else {
    vertices = mesh.vertices;
    for (const region of regions) {
      for (const triangle of region.triangles)
        painted.push({ vertices: mesh.triangles[triangle], state: region.state });
    }
  }
  const positions = new Float32Array(painted.length * 9);
  const stateIndices = new Uint32Array(painted.length);
  const states: FacetRegionState[] = [];
  const indexByKey = new Map<string, number>();
  painted.forEach(({ vertices: corners, state }, slot) => {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = vertices[corners[corner]];
      positions.set(vertex, slot * 9 + corner * 3);
    }
    const key = canonicalStringify(state as unknown as JsonValue);
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = states.length;
      indexByKey.set(key, index);
      states.push(state);
    }
    stateIndices[slot] = index;
  });
  return { positions, stateIndices, states };
}

/** Facets `[start, start + count)` as one packet, clamped to the facets drawn. */
export function paintOverlayPacket(facets: PaintOverlayFacets, start: number, count: number): Uint8Array {
  const total = facets.stateIndices.length;
  const from = Math.min(start, total);
  const to = Math.min(from + count, total);
  const packet = new Uint8Array((to - from) * PAINT_OVERLAY_FACET_BYTES);
  const view = new DataView(packet.buffer);
  for (let facet = from; facet < to; facet += 1) {
    const offset = (facet - from) * PAINT_OVERLAY_FACET_BYTES;
    for (let k = 0; k < 9; k += 1) view.setFloat32(offset + k * 4, facets.positions[facet * 9 + k], true);
    view.setUint32(offset + 36, facets.stateIndices[facet], true);
  }
  return packet;
}

/** The most facets one packet holds. */
export const PAINT_OVERLAY_PAGE_LIMIT = 16384;

export type PaintOverlayRefusalCode = 'invalid-request' | 'unknown-volume' | 'invalid-mesh' | 'invalid-annotations';

export class PaintOverlayRefusal extends Error {
  constructor(readonly code: PaintOverlayRefusalCode) {
    super(`Paint overlay refused (${code})`);
    this.name = 'PaintOverlayRefusal';
  }
}

/**
 * One overlay's facets under the facet guard of the state they were drawn
 * from: a summary of the states, then packets a renderer pages through.
 */
export class PaintOverlayCapture {
  constructor(
    readonly guard: FacetAnnotationGuard,
    readonly facets: PaintOverlayFacets,
  ) {}

  summary(): ProjectPaintOverlaySummaryWire {
    return {
      guard: {
        revision: this.guard.revision,
        hash: wireUnits(this.guard.hash),
        volumeId: wireUnits(this.guard.volumeId),
        topologyRevision: this.guard.topologyRevision,
        triangleCount: this.guard.triangleCount,
      },
      facets: this.facets.stateIndices.length,
      states: this.facets.states.map(regionStateWire),
    };
  }

  packet(start: number, count: number): Uint8Array {
    if (count > PAINT_OVERLAY_PAGE_LIMIT) throw new PaintOverlayRefusal('invalid-request');
    return paintOverlayPacket(this.facets, start, count);
  }
}

/**
 * The canonical overlay of one volume's channel in an acknowledged snapshot,
 * as the workspace draws it: the channel's assignments, materialized through
 * its refinement when it has one.
 */
export function capturePaintOverlay(
  snapshot: ProjectSnapshot,
  assets: Pick<AssetRepository, 'peek'>,
  request: ProjectPaintOverlayRequestWire,
): PaintOverlayCapture {
  const volumeId = wireText(request.volumeId);
  const volume = snapshot.state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .find((candidate) => candidate.id === volumeId);
  if (!volume) throw new PaintOverlayRefusal('unknown-volume');
  const mesh = decodedSelectionMesh(assets, volume.source.assetId);
  const channel = request.channel as FacetAnnotationChannel;
  const refinement = volume.annotations.refinement?.[channel] as FacetRefinementEncoding | undefined;
  const guard: FacetAnnotationGuard = {
    revision: snapshot.revision,
    hash: snapshot.hash,
    volumeId: volume.id,
    topologyRevision: volume.source.topologyRevision,
    triangleCount: volume.source.triangleCount,
  };
  return new PaintOverlayCapture(
    guard,
    guardedFacets(() =>
      paintOverlayFacets(
        mesh,
        channel,
        (volume.annotations[channel] as readonly { triangles: readonly number[]; value: JsonValue }[]).map(
          (assignment) => ({ triangles: assignment.triangles, state: { kind: 'assigned', value: assignment.value } }),
        ),
        refinement
          ? {
              refinement,
              topologyRevision: volume.source.topologyRevision,
              triangleCount: volume.source.triangleCount,
            }
          : {},
      ),
    ),
  );
}

/** A volume's mesh as the selector reads it, or `invalid-mesh`. */
export function decodedSelectionMesh(assets: Pick<AssetRepository, 'peek'>, assetId: string): FacetSelectionMesh {
  const payload = assets.peek(assetId as never);
  if (!payload) throw new PaintOverlayRefusal('invalid-mesh');
  let positions: Float32Array, indices: Uint32Array;
  try {
    ({ positions, indices } = decodeIndexedMeshAsset(payload));
  } catch {
    throw new PaintOverlayRefusal('invalid-mesh');
  }
  return {
    vertices: Array.from({ length: positions.length / 3 }, (_, i): Vec3 => [
      positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
    ]),
    triangles: Array.from(
      { length: indices.length / 3 },
      (_, i) => [indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]] as const,
    ),
  };
}

/** Annotations the materializer refuses are an overlay refusal, not a crash. */
export function guardedFacets(draw: () => PaintOverlayFacets): PaintOverlayFacets {
  try {
    return draw();
  } catch (error) {
    if (error instanceof FacetAnnotationValidationError || error instanceof StaleFacetAnnotationResultError) {
      throw new PaintOverlayRefusal('invalid-annotations');
    }
    throw error;
  }
}
