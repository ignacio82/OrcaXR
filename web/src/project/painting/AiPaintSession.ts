/**
 * UI-independent lifecycle for AI/semantic painting (P4.9).
 *
 * The session is the only thing allowed to talk to an assistant on the paint
 * path, and it enforces the order the parity plan requires: informed consent,
 * then a request, then a preview mask the user can correct, then an *explicit*
 * apply that commits exactly one labelled undoable command through the same
 * `PaintStrokeService` a manual stroke uses. Cancel, provider failure, and a
 * stale topology all leave canonical state byte-identical, so an assistant can
 * never change or degrade slice output.
 */

import type { AssetRepository } from '../assets';
import {
  captureFacetAnnotationGuard,
  type FacetAnnotationGuard,
  type FacetAnnotationValue,
  type FacetSelectionMesh,
} from '../annotations';
import type { VolumeId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandBus } from '../history/commandBus';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { CancellationToken } from '../ports';
import {
  parseAiPaintProposal,
  projectAiPaintProposal,
  AiPaintProposalError,
  type AiPaintProjection,
} from './aiPaintProposal';
import { channelLabel, type PaintChannel, type PaintStrokeService } from './PaintStrokeService';

/**
 * What the user agreed to send, captured at the moment they agreed. Absent or
 * partial consent fails the request closed before anything leaves the device.
 */
export interface AiPaintConsent {
  /** Send a derived description of the selected volume's geometry. */
  readonly geometry: boolean;
  /** Send the user-supplied reference image, when the flow uses one. */
  readonly image: boolean;
  /** Exact provider this consent was given for; a different one re-asks. */
  readonly providerId: string;
  readonly grantedAt: string;
}

export interface AiPaintRequest {
  readonly volumeId: VolumeId;
  readonly channel: PaintChannel;
  readonly prompt: string;
  /** Base64 reference image; requires `consent.image`. */
  readonly imageBase64?: string;
  readonly consent: AiPaintConsent;
  readonly cancellation?: CancellationToken;
}

/** Exactly what the session sends. Nothing else about the project leaves. */
export interface AiPaintPortRequest {
  readonly prompt: string;
  readonly imageBase64?: string;
  /** Facet count and normalized bounding box only — never vertices or IDs. */
  readonly geometry?: {
    readonly triangleCount: number;
    readonly extentMm: readonly [number, number, number];
  };
  readonly signal?: AbortSignal;
}

export interface AiPaintPort {
  readonly providerId: string;
  /** Returns the raw provider payload; the session parses it strictly. */
  propose(request: AiPaintPortRequest): Promise<unknown>;
}

export class AiPaintConsentError extends Error {
  constructor(
    message: string,
    readonly code: 'geometry-not-consented' | 'image-not-consented' | 'provider-mismatch',
  ) {
    super(message);
    this.name = 'AiPaintConsentError';
  }
}

export type AiPaintPreviewOutcome =
  | { readonly status: 'preview'; readonly preview: AiPaintPreview }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type AiPaintApplyOutcome =
  | { readonly status: 'applied'; readonly revision: number; readonly hash: string; readonly facetCount: number }
  | { readonly status: 'noop' }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | { readonly status: 'stale' };

/**
 * One region of a preview, plus the destination the user chose for it. A
 * region with no destination is not painted — the preview is a proposal, not
 * an assignment.
 */
export interface AiPaintPreviewRegion {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  readonly coverage: number;
  readonly triangleIndices: readonly number[];
  /**
   * Canonical destination state for the session's channel: a stable filament
   * ID for colour, `enforce`/`block`, `prefer`/`avoid`, or `true`. Undefined
   * means the user has not assigned this region yet.
   */
  readonly value?: FacetAnnotationValue<PaintChannel>;
}

export interface AiPaintPreview {
  readonly volumeId: VolumeId;
  readonly channel: PaintChannel;
  readonly guard: FacetAnnotationGuard;
  readonly triangleCount: number;
  readonly coverage: number;
  readonly confidence: number;
  readonly unassignedTriangleCount: number;
  readonly regions: readonly AiPaintPreviewRegion[];
  /** True once at least one region has a destination, so apply can do work. */
  readonly assignable: boolean;
}

export interface AiPaintSessionOptions {
  readonly commands: CommandBus;
  readonly assets: AssetRepository;
  readonly strokes: PaintStrokeService;
  readonly port: AiPaintPort;
}

export class AiPaintSession {
  private preview?: AiPaintPreview;
  private projection?: AiPaintProjection;
  private controller?: AbortController;

  constructor(private readonly options: AiPaintSessionOptions) {}

  /** The current preview mask, or undefined before a request or after cancel. */
  get current(): AiPaintPreview | undefined {
    return this.preview;
  }

  /**
   * Ask the assistant and project its answer. Canonical state is never touched
   * here — on every outcome, including success, the project is unchanged until
   * {@link apply} runs.
   */
  async request(request: AiPaintRequest): Promise<AiPaintPreviewOutcome> {
    try {
      this.assertConsent(request);
    } catch (error) {
      if (error instanceof AiPaintConsentError) {
        return { status: 'failed', code: error.code, message: error.message };
      }
      throw error;
    }
    if (request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
    }

    const state = this.options.commands.context.project.getSnapshot().state;
    const located = findVolume(state, request.volumeId);
    if (!located) {
      return { status: 'failed', code: 'unknown-volume', message: `Volume ${request.volumeId} is not in the project` };
    }
    const mesh = this.meshFor(state, request.volumeId);
    if (!mesh) {
      return {
        status: 'failed',
        code: 'missing-asset',
        message: `Volume ${request.volumeId} has no stored mesh asset`,
      };
    }
    const guard = captureFacetAnnotationGuard(this.options.commands, request.volumeId);

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    let raw: unknown;
    try {
      raw = await this.options.port.propose({
        prompt: request.prompt,
        ...(request.imageBase64 !== undefined ? { imageBase64: request.imageBase64 } : {}),
        ...(request.consent.geometry ? { geometry: describeGeometry(mesh) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || request.cancellation?.aborted) {
        return {
          status: 'cancelled',
          ...(request.cancellation?.reason ? { reason: request.cancellation.reason } : {}),
        };
      }
      return {
        status: 'failed',
        code: 'provider-error',
        message: error instanceof Error ? error.message : 'The assistant request failed',
      };
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }

    if (controller.signal.aborted || request.cancellation?.aborted) {
      return { status: 'cancelled', ...(request.cancellation?.reason ? { reason: request.cancellation.reason } : {}) };
    }

    let projection: AiPaintProjection;
    try {
      projection = projectAiPaintProposal({
        proposal: parseAiPaintProposal(raw),
        mesh,
        volumeId: request.volumeId,
        topologyRevision: located.volume.source.topologyRevision,
      });
    } catch (error) {
      if (error instanceof AiPaintProposalError) {
        return { status: 'failed', code: error.code, message: error.message };
      }
      throw error;
    }

    this.projection = projection;
    this.preview = freezePreview({
      volumeId: request.volumeId,
      channel: request.channel,
      guard,
      projection,
      valueById: new Map(),
    });
    return { status: 'preview', preview: this.preview };
  }

  /**
   * Manual correction: choose (or clear) the destination for one region.
   * Passing `undefined` leaves the region out of the commit entirely.
   */
  assignRegion(regionId: string, value: FacetAnnotationValue<PaintChannel> | undefined): AiPaintPreview {
    const preview = this.requirePreview();
    if (!preview.regions.some((region) => region.id === regionId)) {
      throw new Error(`Region ${regionId} is not in the current preview`);
    }
    const valueById = new Map<string, FacetAnnotationValue<PaintChannel>>();
    for (const region of preview.regions) {
      const next = region.id === regionId ? value : region.value;
      if (next !== undefined) valueById.set(region.id, next);
    }
    this.preview = freezePreview({
      volumeId: preview.volumeId,
      channel: preview.channel,
      guard: preview.guard,
      projection: this.requireProjection(),
      valueById,
    });
    return this.preview;
  }

  /**
   * Manual correction: drop facets from a region's mask. Excluded facets keep
   * whatever they already carry — this never paints an erase.
   */
  excludeTriangles(regionId: string, triangleIndices: Iterable<number>): AiPaintPreview {
    const preview = this.requirePreview();
    const target = preview.regions.find((region) => region.id === regionId);
    if (!target) throw new Error(`Region ${regionId} is not in the current preview`);
    const excluded = new Set(triangleIndices);
    const regions = preview.regions.map((region) =>
      region.id === regionId
        ? {
            ...region,
            triangleIndices: region.triangleIndices.filter((triangle) => !excluded.has(triangle)),
          }
        : region,
    );
    this.preview = freezeRegions(preview, regions);
    return this.preview;
  }

  /** Drop the preview. Canonical state was never touched, so nothing unwinds. */
  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.preview = undefined;
    this.projection = undefined;
  }

  /**
   * Commit the corrected mask as exactly one labelled undoable command. A
   * topology or annotation change since the preview fails closed rather than
   * painting a mask that no longer describes this mesh.
   */
  apply(cancellation?: CancellationToken): AiPaintApplyOutcome {
    const preview = this.requirePreview();
    if (cancellation?.aborted) {
      return { status: 'cancelled', ...(cancellation.reason ? { reason: cancellation.reason } : {}) };
    }
    const assigned = preview.regions.filter(
      (region) => region.value !== undefined && region.triangleIndices.length > 0,
    );
    if (assigned.length === 0) return { status: 'noop' };

    const current = captureFacetAnnotationGuard(this.options.commands, preview.volumeId);
    if (
      current.revision !== preview.guard.revision ||
      current.hash !== preview.guard.hash ||
      current.topologyRevision !== preview.guard.topologyRevision ||
      current.triangleCount !== preview.guard.triangleCount
    ) {
      return { status: 'stale' };
    }

    // One command per region would put several entries on the undo stack for a
    // single user action, so the whole mask commits as one transaction. A throw
    // inside it rolls the project back atomically.
    const label = `Smart Paint ${channelLabel(preview.channel)} facets`;
    let facetCount = 0;
    let applied: { revision: number; hash: string } | undefined;
    try {
      this.options.commands.transaction(label, () => {
        for (const region of assigned) {
          const outcome = this.options.strokes.commitTriangles({
            volumeId: preview.volumeId,
            triangleIndices: region.triangleIndices,
            channel: preview.channel,
            value: region.value as never,
            mode: 'paint',
            label,
            ...(cancellation ? { cancellation } : {}),
          });
          if (outcome.status === 'cancelled') throw new AiPaintCancelledError(outcome.reason);
          if (outcome.status !== 'applied') continue;
          facetCount += region.triangleIndices.length;
          applied = { revision: outcome.revision, hash: outcome.hash };
        }
      });
    } catch (error) {
      if (error instanceof AiPaintCancelledError) {
        facetCount = 0;
        return { status: 'cancelled', ...(error.reason ? { reason: error.reason } : {}) };
      }
      throw error;
    }

    if (!applied || facetCount === 0) return { status: 'noop' };
    this.preview = undefined;
    this.projection = undefined;
    return { status: 'applied', revision: applied.revision, hash: applied.hash, facetCount };
  }

  private assertConsent(request: AiPaintRequest): void {
    if (request.consent.providerId !== this.options.port.providerId) {
      throw new AiPaintConsentError(
        `Consent was given for ${request.consent.providerId}, but the configured assistant is ${this.options.port.providerId}`,
        'provider-mismatch',
      );
    }
    if (!request.consent.geometry) {
      throw new AiPaintConsentError(
        'Smart Paint needs explicit consent to describe the selected model to the assistant',
        'geometry-not-consented',
      );
    }
    if (request.imageBase64 !== undefined && !request.consent.image) {
      throw new AiPaintConsentError(
        'Smart Paint needs explicit consent to send the reference image to the assistant',
        'image-not-consented',
      );
    }
  }

  private meshFor(state: ProjectState, volumeId: VolumeId): FacetSelectionMesh | undefined {
    const located = findVolume(state, volumeId);
    if (!located) return undefined;
    const payload = this.options.assets.get(located.volume.source.assetId as never);
    if (!payload) return undefined;
    const decoded = decodeIndexedMeshAsset(payload);
    return Object.freeze({ vertices: decoded.vertices, triangles: decoded.triangles });
  }

  private requirePreview(): AiPaintPreview {
    if (!this.preview) throw new Error('There is no Smart Paint preview to act on');
    return this.preview;
  }

  private requireProjection(): AiPaintProjection {
    if (!this.projection) throw new Error('There is no Smart Paint projection to act on');
    return this.projection;
  }
}

class AiPaintCancelledError extends Error {
  constructor(readonly reason?: string) {
    super(reason ?? 'cancelled');
    this.name = 'AiPaintCancelledError';
  }
}

/** Facet count and extent only — enough to size a proposal, not to rebuild a model. */
function describeGeometry(mesh: FacetSelectionMesh): AiPaintPortRequest['geometry'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const vertex of mesh.vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (vertex[axis] < min[axis]) min[axis] = vertex[axis];
      if (vertex[axis] > max[axis]) max[axis] = vertex[axis];
    }
  }
  const extent = min.every(Number.isFinite)
    ? ([max[0] - min[0], max[1] - min[1], max[2] - min[2]] as const)
    : ([0, 0, 0] as const);
  return Object.freeze({ triangleCount: mesh.triangles.length, extentMm: Object.freeze(extent) });
}

function freezePreview(input: {
  volumeId: VolumeId;
  channel: PaintChannel;
  guard: FacetAnnotationGuard;
  projection: AiPaintProjection;
  valueById: ReadonlyMap<string, FacetAnnotationValue<PaintChannel>>;
}): AiPaintPreview {
  const regions = input.projection.regions.map((region) => {
    const value = input.valueById.get(region.id);
    return {
      id: region.id,
      label: region.label,
      confidence: region.confidence,
      coverage: region.coverage,
      triangleIndices: region.triangleIndices,
      ...(value !== undefined ? { value } : {}),
    } satisfies AiPaintPreviewRegion;
  });
  return freezeRegions(
    {
      volumeId: input.volumeId,
      channel: input.channel,
      guard: input.guard,
      triangleCount: input.projection.triangleCount,
      coverage: input.projection.coverage,
      confidence: input.projection.confidence,
      unassignedTriangleCount: input.projection.unassignedTriangleCount,
      regions,
      assignable: false,
    },
    regions,
  );
}

/** Recompute the derived totals so a correction never leaves a stale coverage. */
function freezeRegions(preview: AiPaintPreview, regions: readonly AiPaintPreviewRegion[]): AiPaintPreview {
  const claimed = regions.reduce((total, region) => total + region.triangleIndices.length, 0);
  const weighted = regions.reduce((total, region) => total + region.confidence * region.triangleIndices.length, 0);
  return Object.freeze({
    volumeId: preview.volumeId,
    channel: preview.channel,
    guard: preview.guard,
    triangleCount: preview.triangleCount,
    coverage: preview.triangleCount === 0 ? 0 : claimed / preview.triangleCount,
    confidence: claimed === 0 ? 0 : weighted / claimed,
    unassignedTriangleCount: preview.triangleCount - claimed,
    regions: Object.freeze(regions.map((region) => Object.freeze({ ...region }))),
    assignable: regions.some((region) => region.value !== undefined && region.triangleIndices.length > 0),
  });
}
