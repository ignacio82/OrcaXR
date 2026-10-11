/**
 * A paint stroke over a live session, in the shared contract's encoding. A
 * host opens a stroke on one volume and channel with its paint target, streams
 * pointer samples, reads the accumulated overlay, and commits the gesture as
 * one undoable edit, the way the workspace's painter drives
 * `PaintStrokeService`. Each sample selects over the snapshot the stroke was
 * opened against and the tree the samples before it left; nothing reaches
 * canonical state until the commit, which carries that snapshot's facet guard,
 * so a project that changed meanwhile refuses it as stale. The Rust session
 * serves the same strokes (`orcaxr_project::facets::paint_stroke`).
 */
import type {
  ProjectPaintStrokeOpenWire,
  ProjectPaintStrokeOverlayRequestWire,
  ProjectPaintStrokeOverlayWire,
  ProjectPaintStrokeSampleReplyWire,
  ProjectPaintStrokeSampleWire,
} from '../../../../contracts/generated/project-intents';
import type { FacetRefinementCommitRequest } from '../annotations/FacetAnnotationStrokeCommand';
import {
  regionClippingPlane,
  regionSelectionTransform,
  regionState,
  regionTool,
  wireText,
  wireUnits,
} from '../annotations/FacetRegionExchange';
import {
  facetRefinementAfterSelection,
  selectFacetRegion,
  type FacetRegionState,
  type FacetRegionTool,
  type FacetSelectionMesh,
} from '../annotations/FacetRegionSelection';
import { triangleRangesFromIndices } from '../annotations/sparse';
import {
  FacetAnnotationValidationError,
  StaleFacetAnnotationResultError,
  type FacetAnnotationGuard,
  type FacetStrokeRequest,
} from '../annotations/types';
import type { AssetRepository } from '../assets';
import { collapseFacetRefinementRoots, type FacetRefinedRootSet } from '../domain/facetRefinement';
import type { JsonValue, ProjectVolume, Vec3 } from '../domain/model';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { ProjectSnapshot } from '../store';
import { guardedFacets, PaintOverlayCapture, paintOverlayFacets } from './PaintOverlay';
import { guardedPaintFacets, paintFacets, PaintFacetsCapture, strokePaintColors } from './PaintFacets';
import { paintStateColor } from './paintOverlayColors';
import { assertPaintTarget, channelLabel, PaintTargetError, type PaintChannel } from './PaintStrokeService';

/** The most overlay ranges one page holds. */
export const PAINT_STROKE_PAGE_LIMIT = 4096;

export type PaintStrokeRefusalCode =
  | 'invalid-request'
  | 'unknown-volume'
  | 'unsupported-role'
  | 'invalid-mesh'
  | 'invalid-target'
  | 'unknown-filament'
  | 'unavailable-filament';

export class PaintStrokeRefusal extends Error {
  constructor(readonly code: PaintStrokeRefusalCode) {
    super(`Paint stroke refused (${code})`);
    this.name = 'PaintStrokeRefusal';
  }
}

/** What a finished stroke commits: triangle ranges, or the refined tree. */
export type PaintStrokeCommit =
  | { readonly kind: 'stroke'; readonly request: FacetStrokeRequest<PaintChannel> }
  | { readonly kind: 'refinement'; readonly request: FacetRefinementCommitRequest<PaintChannel> };

const PAINT_CHANNELS: readonly string[] = ['color', 'support', 'seam', 'fuzzySkin'];

export class PaintStrokeExchange {
  private readonly triangles = new Set<number>();
  private refinement: FacetRefinedRootSet | undefined;

  private constructor(
    private readonly guard: FacetAnnotationGuard,
    private readonly volume: ProjectVolume,
    private readonly mesh: FacetSelectionMesh,
    private readonly channel: PaintChannel,
    private readonly target: FacetRegionState,
    /** The opened snapshot's palette colours for this channel, as the preview draws them. */
    private readonly colors: ReadonlyMap<string, string>,
  ) {}

  /** Open a stroke against an acknowledged snapshot and its assets. */
  static open(
    snapshot: ProjectSnapshot,
    assets: Pick<AssetRepository, 'peek'>,
    request: ProjectPaintStrokeOpenWire,
  ): PaintStrokeExchange {
    if (!PAINT_CHANNELS.includes(request.channel)) throw new PaintStrokeRefusal('invalid-request');
    const channel = request.channel as PaintChannel;
    const volumeId = wireText(request.volumeId);
    const volume = snapshot.state.plates
      .flatMap((plate) => plate.objects)
      .flatMap((object) => object.volumes)
      .find((candidate) => candidate.id === volumeId);
    if (!volume) throw new PaintStrokeRefusal('unknown-volume');
    if (volume.role !== 'model') throw new PaintStrokeRefusal('unsupported-role');
    const target = regionState(request.target);
    try {
      assertPaintTarget(snapshot.state, {
        mode: target.kind === 'unpainted' ? 'erase' : 'paint',
        channel,
        ...(target.kind === 'assigned' ? { value: target.value as never } : {}),
      });
    } catch (error) {
      if (!(error instanceof PaintTargetError)) throw error;
      throw new PaintStrokeRefusal(error.code === 'invalid-settings' ? 'invalid-target' : (error.code as never));
    }
    const payload = assets.peek(volume.source.assetId);
    if (!payload) throw new PaintStrokeRefusal('invalid-mesh');
    let positions: Float32Array, indices: Uint32Array;
    try {
      ({ positions, indices } = decodeIndexedMeshAsset(payload));
    } catch {
      throw new PaintStrokeRefusal('invalid-mesh');
    }
    const mesh: FacetSelectionMesh = {
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
    const guard: FacetAnnotationGuard = {
      revision: snapshot.revision,
      hash: snapshot.hash,
      volumeId: volume.id,
      topologyRevision: volume.source.topologyRevision,
      triangleCount: volume.source.triangleCount,
    };
    return new PaintStrokeExchange(guard, volume, mesh, channel, target, strokePaintColors(snapshot.state, request));
  }

  /**
   * One pointer sample: select over the opened snapshot and the tree the
   * samples before it left, then accumulate the facets and the post-sample
   * tree. Invalid tool input reports the selector's issues and leaves the
   * stroke as it was.
   */
  sample(request: ProjectPaintStrokeSampleWire): ProjectPaintStrokeSampleReplyWire {
    const tool = regionTool(request.tool);
    const splitting: FacetRegionTool =
      request.triangleSplitting && (tool.kind === 'circle' || tool.kind === 'sphere' || tool.kind === 'heightRange')
        ? { ...tool, triangleSplitting: true }
        : tool;
    const persisted = this.volume.annotations.refinement?.[this.channel];
    let selection;
    let after;
    try {
      selection = selectFacetRegion({
        mesh: this.mesh,
        annotations: this.volume.annotations,
        channel: this.channel,
        guard: { topologyRevision: this.guard.topologyRevision, triangleCount: this.guard.triangleCount },
        seedTriangle: request.seedTriangle,
        ...(this.refinement
          ? { refinedRoots: this.refinement.roots }
          : persisted
            ? { refinement: persisted as never }
            : {}),
        tool: splitting,
        ...('value' in request.clippingPlane
          ? { clippingPlane: regionClippingPlane(request.clippingPlane.value) }
          : {}),
        ...('value' in request.transform ? { transform: regionSelectionTransform(request.transform.value) } : {}),
        ...('value' in request.highlightByAngleDegrees
          ? { highlightByAngleDegrees: request.highlightByAngleDegrees.value }
          : {}),
      });
      after = facetRefinementAfterSelection(
        this.channel,
        selection,
        this.volume.annotations[this.channel] as never,
        this.guard.triangleCount,
        this.target,
      );
    } catch (error) {
      if (error instanceof FacetAnnotationValidationError) {
        return {
          invalid: error.issues.map((issue) => ({
            code: wireUnits(issue.code),
            path: wireUnits(issue.path),
            message: wireUnits(issue.message),
          })),
        };
      }
      if (error instanceof StaleFacetAnnotationResultError) return { stale: {} };
      throw error;
    }
    for (const triangle of selection.triangleIndices) this.triangles.add(triangle);
    if (after) this.refinement = after;
    const leaves = selection.refinement?.leaves ?? [];
    return {
      sampled: {
        selectedTriangles: selection.triangleIndices.length,
        leaves: leaves.length,
        selectedLeaves: leaves.filter((leaf) => leaf.selected).length,
        strokeTriangles: this.triangles.size,
        refined: this.refinement !== undefined,
      },
    };
  }

  /** A page of the facets the stroke has touched so far, as ranges. */
  overlay(request: ProjectPaintStrokeOverlayRequestWire): ProjectPaintStrokeOverlayWire {
    if (request.count > PAINT_STROKE_PAGE_LIMIT) throw new PaintStrokeRefusal('invalid-request');
    const ranges = this.ranges();
    return {
      guard: {
        revision: this.guard.revision,
        hash: wireUnits(this.guard.hash),
        volumeId: wireUnits(this.guard.volumeId),
        topologyRevision: this.guard.topologyRevision,
        triangleCount: this.guard.triangleCount,
      },
      strokeTriangles: this.triangles.size,
      refined: this.refinement !== undefined,
      totalRanges: ranges.length,
      ranges: ranges
        .slice(request.start, request.start + request.count)
        .map((range) => ({ start: range.start, endExclusive: range.endExclusive })),
    };
  }

  /**
   * The stroke's live preview as the workspace draws it: the refined tree a
   * sample left, collapsed and materialized, or the touched facets in the
   * target state, in the order they were first touched.
   */
  preview(): PaintOverlayCapture {
    if (this.refinement) {
      const collapsed = collapseFacetRefinementRoots(this.refinement.roots);
      return new PaintOverlayCapture(
        this.guard,
        guardedFacets(() =>
          paintOverlayFacets(
            this.mesh,
            this.channel,
            collapsed.assignments.map((assignment) => ({
              triangles: assignment.triangles,
              state: { kind: 'assigned', value: assignment.value },
            })),
            collapsed.encoding
              ? {
                  refinement: collapsed.encoding,
                  topologyRevision: this.guard.topologyRevision,
                  triangleCount: this.guard.triangleCount,
                }
              : {},
          ),
        ),
      );
    }
    return new PaintOverlayCapture(
      this.guard,
      paintOverlayFacets(
        this.mesh,
        this.channel,
        this.triangles.size === 0 ? [] : [{ triangles: [...this.triangles], state: this.target }],
      ),
    );
  }

  /**
   * The live preview as paint facets ({@link preview}'s facets arranged for
   * a renderer colouring the volume's own facets), each state with the colour
   * the workspace previews it in.
   */
  previewFacets(): PaintFacetsCapture {
    const triangleCount = this.guard.triangleCount;
    let facets;
    if (this.refinement) {
      const collapsed = collapseFacetRefinementRoots(this.refinement.roots);
      facets = guardedPaintFacets(() =>
        paintFacets(
          triangleCount,
          this.channel,
          collapsed.assignments.map((assignment) => ({
            triangles: assignment.triangles,
            state: { kind: 'assigned', value: assignment.value },
          })),
          collapsed.encoding
            ? { refinement: collapsed.encoding, topologyRevision: this.guard.topologyRevision, mesh: () => this.mesh }
            : {},
        ),
      );
    } else {
      facets = paintFacets(
        triangleCount,
        this.channel,
        this.triangles.size === 0 ? [] : [{ triangles: [...this.triangles], state: this.target }],
      );
    }
    return new PaintFacetsCapture(
      this.guard,
      facets,
      facets.states.map((state) => paintStateColor(this.colors, state)),
    );
  }

  /**
   * The whole gesture as one edit under the opened snapshot's guard, or
   * nothing when it touched no facet: the refined tree when any sample left
   * one, otherwise the touched facets as ranges.
   */
  commit(label?: string): PaintStrokeCommit | undefined {
    if (this.triangles.size === 0) return undefined;
    const erasing = this.target.kind === 'unpainted';
    const name = channelLabel(this.channel);
    if (this.refinement) {
      return {
        kind: 'refinement',
        request: {
          guard: { ...this.guard },
          channel: this.channel,
          encoding: this.refinement as never,
          label: label ?? `${erasing ? 'Erase' : 'Paint'} refined ${name} facets`,
        },
      };
    }
    const ranges = this.ranges();
    return {
      kind: 'stroke',
      request: {
        guard: { ...this.guard },
        channel: this.channel,
        operation:
          this.target.kind === 'unpainted'
            ? { mode: 'erase', ranges }
            : { mode: 'paint', ranges, value: this.target.value as JsonValue as never },
        label: label ?? `${erasing ? 'Erase' : 'Paint'} ${name} facets`,
      },
    };
  }

  private ranges() {
    return triangleRangesFromIndices(
      [...this.triangles].sort((left, right) => left - right),
      this.guard.triangleCount,
    );
  }
}
