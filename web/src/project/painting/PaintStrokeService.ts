import type { AssetRepository } from '../assets';
import {
  ORCA_BRUSH_RADIUS_MAX_MM,
  ORCA_BRUSH_RADIUS_MIN_MM,
  ORCA_GAP_AREA_MAX_MM2,
  ORCA_HEIGHT_RANGE_MAX_MM,
  ORCA_HEIGHT_RANGE_MIN_MM,
  ORCA_OVERHANG_ANGLE_MAX_DEGREES,
  ORCA_SMART_FILL_ANGLE_MAX_DEGREES,
  ORCA_SMART_FILL_ANGLE_MIN_DEGREES,
  commitFacetRefinement,
  commitFacetAnnotationStroke,
  captureFacetAnnotationGuard,
  facetRefinementAfterSelection,
  selectFacetRegion,
  StaleFacetAnnotationResultError,
  triangleRangesFromIndices,
  type FacetAnnotationChannel,
  type FacetAnnotationGuard,
  type FacetAnnotationValue,
  type FacetClippingPlane,
  type FacetRegionSelection,
  type FacetRefinedSelection,
  type FacetRegionState,
  type FacetRegionTool,
  type FacetSelectionMesh,
  type FacetSelectionTransform,
  type FacetStrokeCommitResult,
  type FacetStrokeRequest,
  type TriangleRange,
} from '../annotations';
import type { FacetRefinementCommitRequest } from '../annotations/FacetAnnotationStrokeCommand';
import type { FacetRefinedRootSet } from '../domain/facetRefinement';
import type { FilamentId, VolumeId } from '../domain/ids';
import {
  type FacetRefinementNode,
  JsonValue,
  ProjectState,
  ProjectVolume,
  TriangleAssignments,
  Vec3,
} from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandBus } from '../history/commandBus';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { CancellationToken } from '../ports';
import { projectPaintPalette } from './paintPalette';
import { placePaintHit, type PaintPlacement } from './PaintPlacement';

export type PaintToolKind = 'circle' | 'sphere' | 'triangle' | 'heightRange' | 'fill' | 'gapFill';

/** Facet channels a live paint surface can author. */
export type PaintChannel = Extract<FacetAnnotationChannel, 'color' | 'support' | 'seam' | 'fuzzySkin'>;

/**
 * Pinned upstream state order per channel: unpainted is the implicit state
 * zero, so Gap Fill's neighbour precedence lists only assigned states.
 */
const CHANNEL_STATE_ORDER: Readonly<Record<Exclude<PaintChannel, 'color'>, readonly JsonValue[]>> = Object.freeze({
  support: Object.freeze(['enforce', 'block']),
  seam: Object.freeze(['prefer', 'avoid']),
  fuzzySkin: Object.freeze([true]),
});

/** Default assigned state used when a surface selects a channel. */
export const DEFAULT_CHANNEL_VALUE: Readonly<Record<Exclude<PaintChannel, 'color'>, JsonValue>> = Object.freeze({
  support: 'enforce',
  seam: 'prefer',
  fuzzySkin: true,
});

export interface PaintToolSettings {
  readonly tool: PaintToolKind;
  /** Screen/world brush radius in millimetres (Circle and Sphere). */
  readonly radiusMm?: number;
  /** Upstream smart-fill angle; `undefined` disables edge detection. */
  readonly smartFillAngleDegrees?: number;
  /** Height Range band measured up from the hit. */
  readonly heightRangeMm?: number;
  /** Gap Fill strict maximum patch area. */
  readonly gapAreaMm2?: number;
  /** Upstream `highlight_by_angle_deg` overhang gate; zero disables it. */
  readonly highlightByAngleDegrees?: number;
  /** Reproduce the engine's adaptive triangle subdivision. */
  readonly triangleSplitting?: boolean;
  readonly clippingPlane?: FacetClippingPlane;
}

export interface PaintTargetHit {
  readonly volumeId: VolumeId;
  /** Canonical source-triangle index under the ray. */
  readonly triangleIndex: number;
  /** Ray hit in volume-local mesh coordinates. */
  readonly localPoint: Vec3;
  /** Ray origin in volume-local mesh coordinates. */
  readonly localCameraPosition: Vec3;
  /** Previous drag sample, so a dragged brush sweeps a capsule. */
  readonly previousLocalPoint?: Vec3;
  /**
   * Where the part sits on the bed — the instance the hit met and the part's
   * own transform — so the brush and the band measure bed millimetres. A hit
   * without one is a part at the bed's origin, unscaled and unrotated.
   */
  readonly placement?: PaintPlacement;
}

export interface PaintStrokeRequest<Channel extends PaintChannel = 'color'> {
  readonly hit: PaintTargetHit;
  readonly settings: PaintToolSettings;
  /** Facet channel this stroke authors; colour when omitted. */
  readonly channel?: Channel;
  /**
   * Assigned state for the channel: a stable physical or mixed filament ID for
   * colour, `enforce`/`block`, `prefer`/`avoid`, or `true`. Omitting it erases
   * back to the channel's inherited/unpainted state.
   */
  readonly value?: FacetAnnotationValue<Channel>;
  readonly mode: 'paint' | 'erase';
  readonly cancellation?: CancellationToken;
  readonly label?: string;
  /** Transient post-sample tree used while one streamed gesture is still open. */
  readonly refinement?: FacetRefinedRootSet<FacetAnnotationValue<Channel>>;
  /** First-sample guard for a streamed gesture. */
  readonly guard?: FacetAnnotationGuard;
}

export interface PaintStrokePreview {
  readonly volumeId: VolumeId;
  readonly triangleIndices: readonly number[];
  readonly ranges: readonly TriangleRange[];
  readonly topologyRevision: number;
  readonly triangleCount: number;
  /** Stable leaf paths and pre-stroke tree when this sample used adaptive refinement. */
  readonly refinement?: FacetRefinedSelection;
  /** Post-sample tree for accumulating a streamed gesture without mutating canonical state. */
  readonly refinementAfter?: FacetRefinedRootSet;
  readonly guard: FacetAnnotationGuard;
}

export class PaintTargetError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unknown-volume'
      | 'unsupported-role'
      | 'missing-asset'
      | 'unknown-filament'
      | 'unavailable-filament'
      | 'invalid-settings'
      | 'invalid-hit',
  ) {
    super(message);
    this.name = 'PaintTargetError';
  }
}

/**
 * Where a committed stroke goes. A workspace supplies its guarded asynchronous
 * session route; without one, strokes execute directly on the local bus.
 */
export interface PaintCommitPort {
  stroke(request: FacetStrokeRequest<FacetAnnotationChannel>): Promise<FacetStrokeCommitResult>;
  refinement(request: FacetRefinementCommitRequest<FacetAnnotationChannel>): Promise<FacetStrokeCommitResult>;
  /**
   * Strokes as one labelled transaction, each guarded by the state the one
   * before it leaves; reports which of them changed anything.
   */
  strokes(
    label: string,
    requests: readonly PaintStrokeIntent[],
  ): Promise<{ readonly result: FacetStrokeCommitResult; readonly applied: readonly boolean[] }>;
}

/** One stroke before it is guarded: the guard is the state it will meet. */
export type PaintStrokeIntent = Omit<FacetStrokeRequest<FacetAnnotationChannel>, 'guard'> & {
  readonly volumeId: VolumeId;
};

export interface PaintStrokeServiceOptions {
  readonly commands: CommandBus;
  readonly assets: AssetRepository;
  readonly submit?: PaintCommitPort;
}

/**
 * UI-independent colour-painting service. It resolves a canonical volume, runs
 * the pinned facet selector for the active tool, and commits exactly one
 * undoable stroke that stores stable filament identities — never a palette
 * index or a predicted RGB value. Rendering, input, and cursors belong to the
 * surfaces that call it.
 */
export class PaintStrokeService {
  private readonly meshCache = new Map<string, FacetSelectionMesh>();

  constructor(private readonly options: PaintStrokeServiceOptions) {}

  /** Selection for the current pointer sample; never mutates the project. */
  previewStroke<Channel extends PaintChannel>(request: PaintStrokeRequest<Channel>): PaintStrokePreview {
    assertGuardTargetsVolume(request.guard, request.hit.volumeId);
    const guard = request.guard ?? captureFacetAnnotationGuard(this.options.commands, request.hit.volumeId);
    if (!this.options.commands.context.project.isCurrent(guard)) throw new StaleFacetAnnotationResultError('project');
    const { volume, state } = this.resolveVolume(request.hit.volumeId);
    if (
      volume.source.topologyRevision !== guard.topologyRevision ||
      volume.source.triangleCount !== guard.triangleCount
    ) {
      throw new StaleFacetAnnotationResultError('topology');
    }
    this.assertValue(state, request);
    const mesh = this.meshFor(volume.source.assetId, request.hit.volumeId);
    const selection = this.select(mesh, request, state);
    const channel = (request.channel ?? 'color') as PaintChannel;
    const target: FacetRegionState =
      request.mode === 'erase' || request.value === undefined
        ? { kind: 'unpainted' }
        : { kind: 'assigned', value: request.value as JsonValue };
    const refinementAfter = facetRefinementAfterSelection(
      channel,
      selection,
      volume.annotations[channel] as readonly TriangleAssignments<JsonValue>[],
      volume.source.triangleCount,
      target,
    );
    return Object.freeze({
      volumeId: request.hit.volumeId,
      triangleIndices: Object.freeze([...selection.triangleIndices]),
      ranges: Object.freeze(selection.ranges.map((range) => Object.freeze({ ...range }))),
      topologyRevision: volume.source.topologyRevision,
      triangleCount: volume.source.triangleCount,
      ...(selection.refinement ? { refinement: selection.refinement } : {}),
      ...(refinementAfter ? { refinementAfter } : {}),
      guard: Object.freeze({ ...guard }),
    });
  }

  /** Apply the current sample as one atomic, undoable canonical command. */
  commitStroke<Channel extends PaintChannel>(request: PaintStrokeRequest<Channel>): FacetStrokeCommitResult {
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    assertGuardTargetsVolume(request.guard, request.hit.volumeId);
    const { volume, state } = this.resolveVolume(request.hit.volumeId);
    this.assertValue(state, request);
    const mesh = this.meshFor(volume.source.assetId, request.hit.volumeId);
    const selection = this.select(mesh, request, state);
    if (selection.ranges.length === 0) return { status: 'noop' };
    const channel = (request.channel ?? 'color') as PaintChannel;
    const target: FacetRegionState =
      request.mode === 'erase' || request.value === undefined
        ? { kind: 'unpainted' }
        : { kind: 'assigned', value: request.value as JsonValue };
    const refinementAfter = facetRefinementAfterSelection(
      channel,
      selection,
      volume.annotations[channel] as readonly TriangleAssignments<JsonValue>[],
      volume.source.triangleCount,
      target,
    );
    if (refinementAfter) {
      return commitFacetRefinement(this.options.commands, {
        guard: request.guard ?? captureFacetAnnotationGuard(this.options.commands, request.hit.volumeId),
        channel,
        encoding: refinementAfter as never,
        ...(request.cancellation ? { cancellation: request.cancellation } : {}),
        label:
          request.label ?? `${target.kind === 'unpainted' ? 'Erase' : 'Paint'} refined ${channelLabel(channel)} facets`,
      });
    }
    return this.commitRanges(request.hit.volumeId, selection.ranges, request);
  }

  /**
   * Commit facets accumulated across one pointer/controller drag. Surfaces
   * stream `previewStroke` samples while the gesture runs and call this once on
   * release, so a stroke is exactly one history entry no matter how many
   * samples it contained.
   */
  commitTriangles<Channel extends PaintChannel>(request: {
    readonly volumeId: VolumeId;
    readonly triangleIndices: readonly number[];
    readonly channel?: Channel;
    readonly value?: FacetAnnotationValue<Channel>;
    readonly mode: 'paint' | 'erase';
    readonly cancellation?: CancellationToken;
    readonly label?: string;
    readonly guard?: FacetAnnotationGuard;
  }): FacetStrokeCommitResult {
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    assertGuardTargetsVolume(request.guard, request.volumeId);
    const { volume, state } = this.resolveVolume(request.volumeId);
    this.assertValue(state, {
      mode: request.mode,
      ...(request.channel ? { channel: request.channel } : {}),
      ...(request.value !== undefined ? { value: request.value } : {}),
    });
    const ranges = triangleRangesFromIndices([...request.triangleIndices], volume.source.triangleCount);
    if (ranges.length === 0) return { status: 'noop' };
    return this.commitRanges(request.volumeId, ranges, request);
  }

  /** Commit the accumulated post-sample tree of one streamed gesture. */
  commitRefinement<Channel extends PaintChannel>(request: {
    readonly volumeId: VolumeId;
    readonly channel?: Channel;
    readonly encoding: FacetRefinedRootSet<FacetAnnotationValue<Channel>>;
    readonly mode?: 'paint' | 'erase';
    readonly cancellation?: CancellationToken;
    readonly label?: string;
    readonly guard?: FacetAnnotationGuard;
  }): FacetStrokeCommitResult {
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    assertGuardTargetsVolume(request.guard, request.volumeId);
    this.resolveVolume(request.volumeId);
    const channel = (request.channel ?? 'color') as PaintChannel;
    return commitFacetRefinement(this.options.commands, {
      guard: request.guard ?? captureFacetAnnotationGuard(this.options.commands, request.volumeId),
      channel,
      encoding: request.encoding as never,
      ...(request.cancellation ? { cancellation: request.cancellation } : {}),
      label: request.label ?? `${request.mode === 'erase' ? 'Erase' : 'Paint'} refined ${channelLabel(channel)} facets`,
    });
  }

  /** {@link commitTriangles} through the commit port: one acknowledged stroke. */
  async submitTriangles<Channel extends PaintChannel>(
    request: Parameters<PaintStrokeService['commitTriangles']>[0] & { readonly channel?: Channel },
  ): Promise<FacetStrokeCommitResult> {
    if (!this.options.submit) return this.commitTriangles(request);
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    const stroke = this.trianglesRequest(request);
    if (stroke === 'noop') return { status: 'noop' };
    const { volumeId, ...rest } = stroke;
    return this.options.submit.stroke({
      ...rest,
      guard: request.guard ?? captureFacetAnnotationGuard(this.options.commands, volumeId),
    });
  }

  /** {@link commitRefinement} through the commit port. */
  async submitRefinement<Channel extends PaintChannel>(
    request: Parameters<PaintStrokeService['commitRefinement']>[0] & { readonly channel?: Channel },
  ): Promise<FacetStrokeCommitResult> {
    if (!this.options.submit) return this.commitRefinement(request);
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    assertGuardTargetsVolume(request.guard, request.volumeId);
    this.resolveVolume(request.volumeId);
    const channel = (request.channel ?? 'color') as PaintChannel;
    return this.options.submit.refinement({
      guard: request.guard ?? captureFacetAnnotationGuard(this.options.commands, request.volumeId),
      channel,
      encoding: request.encoding as never,
      label: request.label ?? `${request.mode === 'erase' ? 'Erase' : 'Paint'} refined ${channelLabel(channel)} facets`,
    });
  }

  /** {@link clearVolume} through the commit port. */
  async submitClear(volumeId: VolumeId, channel: PaintChannel = 'color'): Promise<FacetStrokeCommitResult> {
    if (!this.options.submit) return this.clearVolume(volumeId, channel);
    this.resolveVolume(volumeId);
    return this.options.submit.stroke({
      guard: captureFacetAnnotationGuard(this.options.commands, volumeId),
      channel,
      operation: { mode: 'reset' },
      label: `Erase all ${channelLabel(channel)} facets`,
    });
  }

  /**
   * Several triangle strokes as one labelled undoable transaction, each
   * guarded by the state the one before it leaves. Without a commit port they
   * run as one transaction on the local bus.
   */
  async submitTriangleSet<Channel extends PaintChannel>(
    label: string,
    requests: readonly (Parameters<PaintStrokeService['commitTriangles']>[0] & { readonly channel?: Channel })[],
    cancellation?: CancellationToken,
  ): Promise<{ readonly result: FacetStrokeCommitResult; readonly applied: readonly boolean[] }> {
    if (cancellation?.aborted) {
      return {
        result: { status: 'cancelled', ...(cancellation.reason ? { reason: cancellation.reason } : {}) },
        applied: requests.map(() => false),
      };
    }
    if (!this.options.submit) {
      const applied: boolean[] = [];
      let last: FacetStrokeCommitResult = { status: 'noop' };
      this.options.commands.transaction(label, () => {
        for (const request of requests) {
          const outcome = this.commitTriangles({ ...request, label });
          applied.push(outcome.status === 'applied');
          if (outcome.status === 'applied') last = outcome;
        }
      });
      return { result: last, applied };
    }
    const strokes: PaintStrokeIntent[] = [];
    const positions: number[] = [];
    requests.forEach((request, index) => {
      const stroke = this.trianglesRequest({ ...request, label });
      if (stroke === 'noop') return;
      strokes.push(stroke);
      positions.push(index);
    });
    if (strokes.length === 0) return { result: { status: 'noop' }, applied: requests.map(() => false) };
    const submitted = await this.options.submit.strokes(label, strokes);
    const applied = requests.map(() => false);
    submitted.applied.forEach((changed, index) => (applied[positions[index]] = changed));
    return { result: submitted.result, applied };
  }

  /** The guardless stroke one set of triangles makes, or `'noop'`. */
  private trianglesRequest<Channel extends PaintChannel>(
    request: Parameters<PaintStrokeService['commitTriangles']>[0] & { readonly channel?: Channel },
  ): PaintStrokeIntent | 'noop' {
    assertGuardTargetsVolume(request.guard, request.volumeId);
    const { volume, state } = this.resolveVolume(request.volumeId);
    this.assertValue(state, {
      mode: request.mode,
      ...(request.channel ? { channel: request.channel } : {}),
      ...(request.value !== undefined ? { value: request.value } : {}),
    });
    const ranges = triangleRangesFromIndices([...request.triangleIndices], volume.source.triangleCount);
    if (ranges.length === 0) return 'noop';
    const channel = (request.channel ?? 'color') as PaintChannel;
    const erasing = request.mode === 'erase' || request.value === undefined;
    return {
      volumeId: request.volumeId,
      channel,
      operation: erasing ? { mode: 'erase', ranges } : { mode: 'paint', ranges, value: request.value as never },
      label: request.label ?? `${erasing ? 'Erase' : 'Paint'} ${channelLabel(channel)} facets`,
    } as PaintStrokeIntent;
  }

  /** Clear every facet of one channel on one volume ("Erase all"). */
  clearVolume(
    volumeId: VolumeId,
    channel: PaintChannel = 'color',
    cancellation?: CancellationToken,
  ): FacetStrokeCommitResult {
    this.resolveVolume(volumeId);
    return commitFacetAnnotationStroke(this.options.commands, {
      guard: captureFacetAnnotationGuard(this.options.commands, volumeId),
      channel,
      operation: { mode: 'reset' },
      ...(cancellation ? { cancellation } : {}),
      label: `Erase all ${channelLabel(channel)} facets`,
    });
  }

  private commitRanges<Channel extends PaintChannel>(
    volumeId: VolumeId,
    ranges: readonly TriangleRange[],
    request: {
      readonly channel?: Channel;
      readonly value?: FacetAnnotationValue<Channel>;
      readonly mode: 'paint' | 'erase';
      readonly cancellation?: CancellationToken;
      readonly label?: string;
      readonly guard?: FacetAnnotationGuard;
    },
  ): FacetStrokeCommitResult {
    const channel = (request.channel ?? 'color') as PaintChannel;
    const guard = request.guard ?? captureFacetAnnotationGuard(this.options.commands, volumeId);
    const erasing = request.mode === 'erase' || request.value === undefined;
    const operation = erasing
      ? ({ mode: 'erase', ranges } as const)
      : ({ mode: 'paint', ranges, value: request.value } as const);
    return commitFacetAnnotationStroke(this.options.commands, {
      guard,
      channel,
      operation,
      ...(request.cancellation ? { cancellation: request.cancellation } : {}),
      label: request.label ?? `${erasing ? 'Erase' : 'Paint'} ${channelLabel(channel)} facets`,
    } as Parameters<typeof commitFacetAnnotationStroke>[1]);
  }

  /** Drop cached decoded meshes, e.g. after topology-changing operations. */
  invalidate(): void {
    this.meshCache.clear();
  }

  private resolveVolume(volumeId: VolumeId): { volume: ProjectVolume; state: ProjectState } {
    const state = this.options.commands.context.project.getSnapshot().state;
    const found = findVolume(state, volumeId);
    if (!found) throw new PaintTargetError(`Unknown volume ${volumeId}`, 'unknown-volume');
    if (found.volume.role !== 'model') {
      throw new PaintTargetError(`${found.volume.role} volumes cannot be colour painted`, 'unsupported-role');
    }
    return { volume: found.volume, state };
  }

  private assertValue<Channel extends PaintChannel>(
    state: ProjectState,
    request: {
      readonly mode: 'paint' | 'erase';
      readonly channel?: Channel;
      readonly value?: FacetAnnotationValue<Channel>;
    },
  ): void {
    assertPaintTarget(state, request);
  }

  private meshFor(assetId: string, volumeId: VolumeId): FacetSelectionMesh {
    const payload = this.options.assets.get(assetId as never);
    if (!payload) throw new PaintTargetError(`Volume ${volumeId} has no stored mesh asset`, 'missing-asset');
    const key = `${assetId}:${payload.descriptor.digest}`;
    const cached = this.meshCache.get(key);
    if (cached) return cached;
    const decoded = decodeIndexedMeshAsset(payload);
    const mesh: FacetSelectionMesh = Object.freeze({
      vertices: decoded.vertices,
      triangles: decoded.triangles,
    });
    this.meshCache.set(key, mesh);
    return mesh;
  }

  private select<Channel extends PaintChannel>(
    mesh: FacetSelectionMesh,
    request: PaintStrokeRequest<Channel>,
    state: ProjectState,
  ): FacetRegionSelection {
    const { volume } = this.resolveVolume(request.hit.volumeId);
    const channel = (request.channel ?? 'color') as PaintChannel;
    const inputs = paintSelectionInputs(request.settings, request.hit, channel, () => paintStateOrder(state));
    return selectFacetRegion({
      mesh,
      annotations: volume.annotations,
      guard: {
        topologyRevision: volume.source.topologyRevision,
        triangleCount: volume.source.triangleCount,
      },
      seedTriangle: inputs.seedTriangle,
      channel,
      // A gesture in flight owns the working tree; otherwise the canonical
      // subdivisions plus the sparse channel are the whole prior state.
      ...(request.refinement
        ? { refinedRoots: request.refinement.roots as readonly FacetRefinementNode[] }
        : volume.annotations.refinement?.[channel]
          ? {
              refinement: volume.annotations.refinement[channel] as never,
            }
          : {}),
      tool: inputs.tool,
      ...(inputs.clippingPlane ? { clippingPlane: inputs.clippingPlane } : {}),
      ...(inputs.transform ? { transform: inputs.transform } : {}),
      ...(inputs.highlightByAngleDegrees !== undefined
        ? { highlightByAngleDegrees: inputs.highlightByAngleDegrees }
        : {}),
    });
  }
}

/** What one pointer sample selects with: the seed facet, the tool and its options. */
export interface PaintSelectionInputs {
  readonly seedTriangle: number;
  readonly tool: FacetRegionTool;
  readonly clippingPlane?: FacetClippingPlane;
  readonly transform?: FacetSelectionTransform;
  readonly highlightByAngleDegrees?: number;
}

/**
 * The selector's input for one pointer sample with the painter's settings:
 * the hit's facet, the active tool with its parameters clamped to the pinned
 * gizmo limits and the defaults filled in, and the optional clipping plane,
 * the transform the hit's placement makes (`placePaintHit`: the brush in bed
 * millimetres, the band from the hit's bed Z) and the overhang gate. Gap
 * Fill's colour precedence is the palette's displayed order ([stateOrder]);
 * the other channels use their pinned order.
 * The Rust core maps settings the same way (`orcaxr_project::facets::paint_tool`).
 */
export function paintSelectionInputs(
  settings: PaintToolSettings,
  hit: Omit<PaintTargetHit, 'volumeId'>,
  channel: PaintChannel,
  stateOrder: () => readonly JsonValue[],
): PaintSelectionInputs {
  if (!Number.isInteger(hit.triangleIndex) || hit.triangleIndex < 0) {
    throw new PaintTargetError('The paint hit does not reference a source triangle', 'invalid-hit');
  }
  const placed = hit.placement ? placePaintHit(hit.placement, hit.localPoint) : undefined;
  if (hit.placement && !placed) {
    throw new PaintTargetError('The paint placement must be finite and invertible', 'invalid-hit');
  }
  const tool = paintRegionTool(settings, hit, placed?.plateZMm ?? Math.fround(hit.localPoint[2]), channel, stateOrder);
  return {
    seedTriangle: hit.triangleIndex,
    tool,
    ...(settings.clippingPlane ? { clippingPlane: settings.clippingPlane } : {}),
    ...(placed ? { transform: placed.transform } : {}),
    ...(settings.highlightByAngleDegrees
      ? { highlightByAngleDegrees: clamp(settings.highlightByAngleDegrees, 0, ORCA_OVERHANG_ANGLE_MAX_DEGREES) }
      : {}),
  };
}

/** The active tool with its parameters clamped to the pinned gizmo limits. */
function paintRegionTool(
  settings: PaintToolSettings,
  hit: Omit<PaintTargetHit, 'volumeId'>,
  plateZMm: number,
  channel: PaintChannel,
  stateOrder: () => readonly JsonValue[],
): FacetRegionTool {
  switch (settings.tool) {
    case 'triangle':
      return { kind: 'triangle', hit: hit.localPoint };
    case 'circle':
    case 'sphere': {
      const radiusMm = clamp(settings.radiusMm ?? 2, ORCA_BRUSH_RADIUS_MIN_MM, ORCA_BRUSH_RADIUS_MAX_MM);
      return {
        kind: settings.tool,
        center: hit.localPoint,
        ...(hit.previousLocalPoint ? { previousCenter: hit.previousLocalPoint } : {}),
        cameraPosition: hit.localCameraPosition,
        radiusMm,
        ...(settings.triangleSplitting ? { triangleSplitting: true } : {}),
      };
    }
    case 'heightRange': {
      return {
        kind: 'heightRange',
        startZMm: plateZMm,
        heightMm: clamp(settings.heightRangeMm ?? 1, ORCA_HEIGHT_RANGE_MIN_MM, ORCA_HEIGHT_RANGE_MAX_MM),
        ...(settings.triangleSplitting ? { triangleSplitting: true } : {}),
      };
    }
    case 'fill': {
      const angle = settings.smartFillAngleDegrees;
      return {
        kind: 'fill',
        hit: hit.localPoint,
        edgeDetection:
          angle === undefined || angle <= ORCA_SMART_FILL_ANGLE_MIN_DEGREES
            ? false
            : {
                maxAdjacentAngleDegrees: clamp(
                  angle,
                  ORCA_SMART_FILL_ANGLE_MIN_DEGREES,
                  ORCA_SMART_FILL_ANGLE_MAX_DEGREES,
                ),
              },
      };
    }
    case 'gapFill':
      return {
        kind: 'gapFill',
        maxAreaMm2: clamp(settings.gapAreaMm2 ?? 2, 0, ORCA_GAP_AREA_MAX_MM2),
        stateOrder: channel === 'color' ? stateOrder() : CHANNEL_STATE_ORDER[channel],
      };
    default:
      throw new PaintTargetError(`Unsupported paint tool ${String(settings.tool)}`, 'invalid-settings');
  }
}

function assertGuardTargetsVolume(guard: FacetAnnotationGuard | undefined, volumeId: VolumeId): void {
  if (guard && guard.volumeId !== volumeId) throw new StaleFacetAnnotationResultError('project');
}

/**
 * Refuse a paint target the channel cannot hold: an assigned state outside the
 * channel's pinned order, or a colour that is not a selectable palette entry.
 * Erasing always passes.
 */
export function assertPaintTarget<Channel extends PaintChannel>(
  state: ProjectState,
  request: {
    readonly mode: 'paint' | 'erase';
    readonly channel?: Channel;
    readonly value?: FacetAnnotationValue<Channel>;
  },
): void {
  if (request.mode === 'erase' || request.value === undefined) return;
  const channel = (request.channel ?? 'color') as PaintChannel;
  if (channel !== 'color') {
    const allowed = CHANNEL_STATE_ORDER[channel];
    if (!allowed.includes(request.value as JsonValue)) {
      throw new PaintTargetError(
        `${String(request.value)} is not a valid ${channelLabel(channel)} state`,
        'invalid-settings',
      );
    }
    return;
  }
  const filamentId = request.value as FilamentId;
  const palette = projectPaintPalette(state, { includeUnavailable: true });
  const entry = palette.entries.find((candidate) => candidate.filamentId === filamentId);
  if (!entry) throw new PaintTargetError(`Unknown filament ${filamentId}`, 'unknown-filament');
  if (!entry.selectable) {
    throw new PaintTargetError(
      entry.unavailableReason ?? `Filament ${filamentId} cannot be painted`,
      'unavailable-filament',
    );
  }
}

/** Displayed filament-ID order used by Gap Fill's neighbour precedence. */
export function paintStateOrder(state: ProjectState): readonly string[] {
  return Object.freeze(
    projectPaintPalette(state)
      .entries.filter((entry) => entry.filamentId)
      .map((entry) => entry.filamentId as string),
  );
}

export function channelLabel(channel: PaintChannel): string {
  switch (channel) {
    case 'support':
      return 'support';
    case 'seam':
      return 'seam';
    case 'fuzzySkin':
      return 'fuzzy-skin';
    default:
      return 'colour';
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    throw new PaintTargetError('Paint tool settings must be finite numbers', 'invalid-settings');
  }
  return Math.min(maximum, Math.max(minimum, value));
}
