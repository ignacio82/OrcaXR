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
  commitFacetAnnotationStroke,
  captureFacetAnnotationGuard,
  selectFacetRegion,
  triangleRangesFromIndices,
  type FacetClippingPlane,
  type FacetRegionSelection,
  type FacetRegionTool,
  type FacetSelectionMesh,
  type FacetSelectionTransform,
  type FacetStrokeCommitResult,
  type TriangleRange,
} from '../annotations';
import type { FilamentId, VolumeId } from '../domain/ids';
import type { ProjectState, ProjectVolume, Vec3 } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandBus } from '../history/commandBus';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { CancellationToken } from '../ports';
import { projectPaintPalette } from './paintPalette';

export type PaintToolKind = 'circle' | 'sphere' | 'triangle' | 'heightRange' | 'fill' | 'gapFill';

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
  /** Plate Z of the hit, required by Height Range. */
  readonly plateZMm?: number;
  /** Volume-to-plate placement, so radii respect instance scaling. */
  readonly transform?: FacetSelectionTransform;
}

export interface PaintStrokeRequest {
  readonly hit: PaintTargetHit;
  readonly settings: PaintToolSettings;
  /** Stable physical or mixed identity; omitted means erase to inherit. */
  readonly filamentId?: FilamentId;
  readonly mode: 'paint' | 'erase';
  readonly cancellation?: CancellationToken;
  readonly label?: string;
}

export interface PaintStrokePreview {
  readonly volumeId: VolumeId;
  readonly triangleIndices: readonly number[];
  readonly ranges: readonly TriangleRange[];
  readonly topologyRevision: number;
  readonly triangleCount: number;
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

export interface PaintStrokeServiceOptions {
  readonly commands: CommandBus;
  readonly assets: AssetRepository;
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
  previewStroke(request: PaintStrokeRequest): PaintStrokePreview {
    const { volume, state } = this.resolveVolume(request.hit.volumeId);
    this.assertFilament(state, request);
    const mesh = this.meshFor(volume.source.assetId, request.hit.volumeId);
    const selection = this.select(mesh, request, state);
    return Object.freeze({
      volumeId: request.hit.volumeId,
      triangleIndices: Object.freeze([...selection.triangleIndices]),
      ranges: Object.freeze(selection.ranges.map((range) => Object.freeze({ ...range }))),
      topologyRevision: volume.source.topologyRevision,
      triangleCount: volume.source.triangleCount,
    });
  }

  /** Apply the current sample as one atomic, undoable canonical command. */
  commitStroke(request: PaintStrokeRequest): FacetStrokeCommitResult {
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    const { volume, state } = this.resolveVolume(request.hit.volumeId);
    this.assertFilament(state, request);
    const mesh = this.meshFor(volume.source.assetId, request.hit.volumeId);
    const selection = this.select(mesh, request, state);
    if (selection.ranges.length === 0) return { status: 'noop' };
    const guard = captureFacetAnnotationGuard(this.options.commands, request.hit.volumeId);
    if (request.mode === 'erase' || !request.filamentId) {
      return commitFacetAnnotationStroke(this.options.commands, {
        guard,
        channel: 'color',
        operation: { mode: 'erase', ranges: selection.ranges },
        ...(request.cancellation ? { cancellation: request.cancellation } : {}),
        label: request.label ?? 'Erase colour facets',
      });
    }
    return commitFacetAnnotationStroke(this.options.commands, {
      guard,
      channel: 'color',
      operation: { mode: 'paint', ranges: selection.ranges, value: request.filamentId },
      ...(request.cancellation ? { cancellation: request.cancellation } : {}),
      label: request.label ?? 'Paint colour facets',
    });
  }

  /**
   * Commit facets accumulated across one pointer/controller drag. Surfaces
   * stream `previewStroke` samples while the gesture runs and call this once on
   * release, so a stroke is exactly one history entry no matter how many
   * samples it contained.
   */
  commitTriangles(request: {
    readonly volumeId: VolumeId;
    readonly triangleIndices: readonly number[];
    readonly filamentId?: FilamentId;
    readonly mode: 'paint' | 'erase';
    readonly cancellation?: CancellationToken;
    readonly label?: string;
  }): FacetStrokeCommitResult {
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }
    const { volume, state } = this.resolveVolume(request.volumeId);
    this.assertFilament(state, {
      hit: { volumeId: request.volumeId, triangleIndex: 0, localPoint: [0, 0, 0], localCameraPosition: [0, 0, 0] },
      settings: { tool: 'triangle' },
      mode: request.mode,
      ...(request.filamentId ? { filamentId: request.filamentId } : {}),
    });
    const ranges = triangleRangesFromIndices([...request.triangleIndices], volume.source.triangleCount);
    if (ranges.length === 0) return { status: 'noop' };
    const guard = captureFacetAnnotationGuard(this.options.commands, request.volumeId);
    const operation =
      request.mode === 'erase' || !request.filamentId
        ? ({ mode: 'erase', ranges } as const)
        : ({ mode: 'paint', ranges, value: request.filamentId } as const);
    return commitFacetAnnotationStroke(this.options.commands, {
      guard,
      channel: 'color',
      operation,
      ...(request.cancellation ? { cancellation: request.cancellation } : {}),
      label: request.label ?? (request.mode === 'erase' ? 'Erase colour facets' : 'Paint colour facets'),
    });
  }

  /** Clear every colour facet on one volume ("Erase all"). */
  clearVolume(volumeId: VolumeId, cancellation?: CancellationToken): FacetStrokeCommitResult {
    this.resolveVolume(volumeId);
    return commitFacetAnnotationStroke(this.options.commands, {
      guard: captureFacetAnnotationGuard(this.options.commands, volumeId),
      channel: 'color',
      operation: { mode: 'reset' },
      ...(cancellation ? { cancellation } : {}),
      label: 'Erase all colour facets',
    });
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

  private assertFilament(state: ProjectState, request: PaintStrokeRequest): void {
    if (request.mode === 'erase' || !request.filamentId) return;
    const palette = projectPaintPalette(state, { includeUnavailable: true });
    const entry = palette.entries.find((candidate) => candidate.filamentId === request.filamentId);
    if (!entry) throw new PaintTargetError(`Unknown filament ${request.filamentId}`, 'unknown-filament');
    if (!entry.selectable) {
      throw new PaintTargetError(
        entry.unavailableReason ?? `Filament ${request.filamentId} cannot be painted`,
        'unavailable-filament',
      );
    }
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

  private select(mesh: FacetSelectionMesh, request: PaintStrokeRequest, state: ProjectState): FacetRegionSelection {
    const { volume } = this.resolveVolume(request.hit.volumeId);
    if (!Number.isInteger(request.hit.triangleIndex) || request.hit.triangleIndex < 0) {
      throw new PaintTargetError('The paint hit does not reference a source triangle', 'invalid-hit');
    }
    return selectFacetRegion({
      mesh,
      annotations: volume.annotations,
      channel: 'color',
      guard: {
        topologyRevision: volume.source.topologyRevision,
        triangleCount: volume.source.triangleCount,
      },
      seedTriangle: request.hit.triangleIndex,
      tool: this.tool(request, state),
      ...(request.settings.clippingPlane ? { clippingPlane: request.settings.clippingPlane } : {}),
      ...(request.hit.transform ? { transform: request.hit.transform } : {}),
      ...(request.settings.highlightByAngleDegrees
        ? {
            highlightByAngleDegrees: clamp(
              request.settings.highlightByAngleDegrees,
              0,
              ORCA_OVERHANG_ANGLE_MAX_DEGREES,
            ),
          }
        : {}),
    });
  }

  private tool(request: PaintStrokeRequest, state: ProjectState): FacetRegionTool {
    const settings = request.settings;
    const hit = request.hit;
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
        if (hit.plateZMm === undefined || !Number.isFinite(hit.plateZMm)) {
          throw new PaintTargetError('Height Range needs the plate Z of the hit', 'invalid-hit');
        }
        return {
          kind: 'heightRange',
          startZMm: hit.plateZMm,
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
          stateOrder: paintStateOrder(state),
        };
      default:
        throw new PaintTargetError(`Unsupported paint tool ${String(settings.tool)}`, 'invalid-settings');
    }
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

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    throw new PaintTargetError('Paint tool settings must be finite numbers', 'invalid-settings');
  }
  return Math.min(maximum, Math.max(minimum, value));
}
