/**
 * Paint facets: what a paint overlay draws (`PaintOverlay.ts`), arranged for a
 * renderer that colours a volume's own facets instead of drawing a second
 * mesh over them. Whole source facets come as runs of one state in source
 * order; the leaves of subdivided facets come with their corners and source
 * facet, to draw over the facet they split; each state comes with the colour
 * the workspace draws it in (`paintOverlayColors.ts`). An unrefined channel is
 * read from its sparse assignments alone, without decoding the mesh. The
 * Rust core serves the same captures over live sessions
 * (`orcaxr_project::facets::paint_facets`).
 */
import type {
  ProjectPaintOverlayRequestWire,
  ProjectPaintStrokeOpenWire,
} from '../../../../contracts/generated/project-intents';
import { wireText } from '../annotations/FacetRegionExchange';
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
import type {
  FacetAnnotations,
  FacetRefinementEncoding,
  JsonValue,
  ProjectState,
  ProjectVolume,
} from '../domain/model';
import type { ProjectSnapshot } from '../store';
import { decodedSelectionMesh, type PaintOverlayRegion } from './PaintOverlay';
import { channelOverlayColors, paintStateColor } from './paintOverlayColors';
import { paintPaletteColors, projectPaintPalette } from './paintPalette';

/** The most runs, or leaves, one packet holds. */
export const PAINT_FACETS_PAGE_LIMIT = 16384;
/** Bytes per run: little-endian uint32 first facet, facet count and state index. */
export const PAINT_FACET_RUN_BYTES = 12;
/** Bytes per leaf: nine little-endian float32 corners, then uint32 source facet and state index. */
export const PAINT_FACET_LEAF_BYTES = 44;

export interface PaintFacets {
  /** Whole source facets in ascending order: `[first, count, state]` per run. */
  readonly runs: Uint32Array;
  /** Nine volume-local float32 corners per leaf of a subdivided facet, in draw order. */
  readonly leafPositions: Float32Array;
  /** Per leaf, the source facet it subdivides. */
  readonly leafSources: Uint32Array;
  /** Per leaf, an index into `states`. */
  readonly leafStates: Uint32Array;
  /** Distinct states, in first-drawn order. */
  readonly states: readonly FacetRegionState[];
}

export type PaintFacetsRefusalCode = 'invalid-request' | 'unknown-volume' | 'invalid-mesh' | 'invalid-annotations';

export class PaintFacetsRefusal extends Error {
  constructor(readonly code: PaintFacetsRefusalCode) {
    super(`Paint facets refused (${code})`);
    this.name = 'PaintFacetsRefusal';
  }
}

/**
 * The painted facets of one channel of a volume with [triangleCount] facets.
 * With a refinement every region must be assigned, as canonical assignments
 * are: the refinement is materialized over them over [mesh], each assigned
 * leaf of an unsplit facet is a whole facet and every other assigned leaf is
 * drawn as a leaf. Without one each region's facets are whole facets, a later
 * region drawing over an earlier one. States are numbered in the order they
 * are first drawn, as the overlay numbers them.
 */
export function paintFacets(
  triangleCount: number,
  channel: FacetAnnotationChannel,
  regions: readonly PaintOverlayRegion[],
  options: {
    readonly refinement?: FacetRefinementEncoding;
    readonly topologyRevision?: number;
    readonly mesh?: () => FacetSelectionMesh;
  } = {},
): PaintFacets {
  const facetStates = new Int32Array(triangleCount).fill(-1);
  const states: FacetRegionState[] = [];
  const indexByKey = new Map<string, number>();
  const stateIndex = (state: FacetRegionState): number => {
    const key = canonicalStringify(state as unknown as JsonValue);
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = states.length;
      indexByKey.set(key, index);
      states.push(state);
    }
    return index;
  };
  const leafPositions: number[] = [];
  const leafSources: number[] = [];
  const leafStates: number[] = [];
  if (options.refinement) {
    const mesh = options.mesh?.();
    if (!mesh) throw new PaintFacetsRefusal('invalid-mesh');
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
      if (region.state.kind !== 'assigned') throw new PaintFacetsRefusal('invalid-annotations');
      return { triangles: region.triangles, value: region.state.value };
    });
    const materialized = materializeFacetRefinement({
      mesh,
      annotations,
      channel,
      guard: { topologyRevision, triangleCount },
      refinement: options.refinement,
    });
    for (const leaf of materialized.leaves) {
      if (leaf.state.kind !== 'assigned') continue;
      const index = stateIndex(leaf.state);
      if (leaf.path.length === 0) {
        facetStates[leaf.sourceTriangle] = index;
        continue;
      }
      for (const vertex of leaf.vertexIndices) leafPositions.push(...materialized.vertices[vertex]);
      leafSources.push(leaf.sourceTriangle);
      leafStates.push(index);
    }
  } else {
    for (const region of regions) {
      if (region.triangles.length === 0) continue;
      const index = stateIndex(region.state);
      for (const triangle of region.triangles) {
        if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) {
          throw new PaintFacetsRefusal('invalid-annotations');
        }
        facetStates[triangle] = index;
      }
    }
  }
  const runs: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const state = facetStates[triangle];
    if (state < 0) continue;
    const last = runs.length - 3;
    if (last >= 0 && runs[last] + runs[last + 1] === triangle && runs[last + 2] === state) runs[last + 1] += 1;
    else runs.push(triangle, 1, state);
  }
  return {
    runs: Uint32Array.from(runs),
    leafPositions: Float32Array.from(leafPositions),
    leafSources: Uint32Array.from(leafSources),
    leafStates: Uint32Array.from(leafStates),
    states,
  };
}

/** The colour of each state, as the workspace draws [channel] with [state]'s filament library. */
export function paintFacetColors(
  state: Pick<ProjectState, 'filaments'>,
  channel: FacetAnnotationChannel,
  states: readonly FacetRegionState[],
): string[] {
  const colors = channelOverlayColors(
    channel,
    paintPaletteColors(projectPaintPalette(state as ProjectState, { includeUnavailable: true })),
  );
  return states.map((value) => paintStateColor(colors, value));
}

/** A state as the summary lists it: its assigned value, or `null` unpainted. */
function stateJson(state: FacetRegionState): JsonValue {
  return state.kind === 'assigned' ? state.value : null;
}

/**
 * One volume's paint facets under the facet guard of the state they were
 * read from, with each state's colour: a summary, then packets of runs and of
 * leaves a renderer pages through.
 */
export class PaintFacetsCapture {
  constructor(
    readonly guard: FacetAnnotationGuard,
    readonly facets: PaintFacets,
    readonly colors: readonly string[],
  ) {}

  /** `{"colors","facets","guard","leaves","runs","states"}`, canonical JSON. */
  summary(): string {
    let whole = 0;
    for (let run = 0; run < this.facets.runs.length; run += 3) whole += this.facets.runs[run + 1];
    return canonicalStringify({
      colors: [...this.colors],
      facets: whole,
      guard: {
        hash: this.guard.hash,
        revision: this.guard.revision,
        topologyRevision: this.guard.topologyRevision,
        triangleCount: this.guard.triangleCount,
        volumeId: this.guard.volumeId,
      },
      leaves: this.facets.leafSources.length,
      runs: this.facets.runs.length / 3,
      states: this.facets.states.map(stateJson),
    });
  }

  /** Runs `[start, start + count)` as one packet, clamped to the runs. */
  runs(start: number, count: number): Uint8Array {
    if (count > PAINT_FACETS_PAGE_LIMIT) throw new PaintFacetsRefusal('invalid-request');
    const total = this.facets.runs.length / 3;
    const from = Math.min(start, total);
    const to = Math.min(from + count, total);
    const packet = new Uint8Array((to - from) * PAINT_FACET_RUN_BYTES);
    const view = new DataView(packet.buffer);
    for (let run = from; run < to; run += 1) {
      for (let k = 0; k < 3; k += 1) {
        view.setUint32((run - from) * PAINT_FACET_RUN_BYTES + k * 4, this.facets.runs[run * 3 + k], true);
      }
    }
    return packet;
  }

  /** Leaves `[start, start + count)` as one packet, clamped to the leaves. */
  leaves(start: number, count: number): Uint8Array {
    if (count > PAINT_FACETS_PAGE_LIMIT) throw new PaintFacetsRefusal('invalid-request');
    const total = this.facets.leafSources.length;
    const from = Math.min(start, total);
    const to = Math.min(from + count, total);
    const packet = new Uint8Array((to - from) * PAINT_FACET_LEAF_BYTES);
    const view = new DataView(packet.buffer);
    for (let leaf = from; leaf < to; leaf += 1) {
      const offset = (leaf - from) * PAINT_FACET_LEAF_BYTES;
      for (let k = 0; k < 9; k += 1) view.setFloat32(offset + k * 4, this.facets.leafPositions[leaf * 9 + k], true);
      view.setUint32(offset + 36, this.facets.leafSources[leaf], true);
      view.setUint32(offset + 40, this.facets.leafStates[leaf], true);
    }
    return packet;
  }
}

/** Annotations the materializer refuses are a capture refusal, not a crash. */
export function guardedPaintFacets(draw: () => PaintFacets): PaintFacets {
  try {
    return draw();
  } catch (error) {
    if (error instanceof FacetAnnotationValidationError || error instanceof StaleFacetAnnotationResultError) {
      throw new PaintFacetsRefusal('invalid-annotations');
    }
    throw error;
  }
}

/** One volume's channel as paint regions, in canonical order. */
export function paintRegions(volume: ProjectVolume, channel: FacetAnnotationChannel): PaintOverlayRegion[] {
  return (volume.annotations[channel] as readonly { triangles: readonly number[]; value: JsonValue }[]).map(
    (assignment) => ({ triangles: assignment.triangles, state: { kind: 'assigned', value: assignment.value } }),
  );
}

/**
 * The paint facets of one volume's channel in an acknowledged snapshot, as
 * the workspace draws it: the channel's assignments, materialized through its
 * refinement when it has one.
 */
export function capturePaintFacets(
  snapshot: ProjectSnapshot,
  assets: Pick<AssetRepository, 'peek'>,
  request: ProjectPaintOverlayRequestWire,
): PaintFacetsCapture {
  const volumeId = wireText(request.volumeId);
  const volume = snapshot.state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .find((candidate) => candidate.id === volumeId);
  if (!volume) throw new PaintFacetsRefusal('unknown-volume');
  const channel = request.channel as FacetAnnotationChannel;
  const refinement = volume.annotations.refinement?.[channel] as FacetRefinementEncoding | undefined;
  const guard: FacetAnnotationGuard = {
    revision: snapshot.revision,
    hash: snapshot.hash,
    volumeId: volume.id,
    topologyRevision: volume.source.topologyRevision,
    triangleCount: volume.source.triangleCount,
  };
  const facets = guardedPaintFacets(() =>
    paintFacets(volume.source.triangleCount, channel, paintRegions(volume, channel), {
      ...(refinement
        ? {
            refinement,
            topologyRevision: volume.source.topologyRevision,
            mesh: () => {
              try {
                return decodedSelectionMesh(assets, volume.source.assetId);
              } catch {
                throw new PaintFacetsRefusal('invalid-mesh');
              }
            },
          }
        : {}),
    }),
  );
  return new PaintFacetsCapture(guard, facets, paintFacetColors(snapshot.state, channel, facets.states));
}

/**
 * The colours a filament library's palette paints states in, for the hosts:
 * `{"channel","filaments","states"}` → `{"colors"}`, a state being its
 * assigned value or `null` unpainted. A malformed request is refused as
 * `invalid_request`.
 */
export function paintFacetColorsExchange(request: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    throw new Error('invalid_request');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_request');
  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.join(',') !== 'channel,filaments,states') throw new Error('invalid_request');
  const channels: readonly string[] = ['color', 'support', 'seam', 'fuzzySkin', 'brim'];
  if (typeof fields.channel !== 'string' || !channels.includes(fields.channel)) throw new Error('invalid_request');
  const filaments = fields.filaments as ProjectState['filaments'];
  if (
    filaments === null ||
    typeof filaments !== 'object' ||
    !Array.isArray(filaments.physical) ||
    !Array.isArray(filaments.mixed)
  ) {
    throw new Error('invalid_request');
  }
  if (!Array.isArray(fields.states)) throw new Error('invalid_request');
  const states = fields.states.map((value): FacetRegionState => {
    if (value === null) return { kind: 'unpainted' };
    if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('invalid_request');
    return { kind: 'assigned', value };
  });
  return canonicalStringify({
    colors: paintFacetColors({ filaments }, fields.channel as FacetAnnotationChannel, states),
  });
}

/** The colours a stroke opened on [state] previews its channel in. */
export function strokePaintColors(
  state: ProjectState,
  request: Pick<ProjectPaintStrokeOpenWire, 'channel'>,
): ReadonlyMap<string, string> {
  return channelOverlayColors(
    request.channel,
    paintPaletteColors(projectPaintPalette(state, { includeUnavailable: true })),
  );
}
