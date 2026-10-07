import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from '../domain/canonical';
import {
  collapseFacetRefinementRoots,
  facetRefinementHasSplits,
  normalizeFacetRefinementEncoding,
  replaceFacetRefinementRoots,
  validateFacetRefinementChannel,
  type FacetRefinedRootSet,
} from '../domain/facetRefinement';
import type { VolumeId } from '../domain/ids';
import type {
  FacetAnnotationRefinements,
  FacetAnnotations,
  FacetRefinementEncoding,
  FacetRefinementNode,
  JsonValue,
} from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import type { CommandBus } from '../history/commandBus';
import {
  applyFacetChannelStroke,
  facetAnnotationsBytes,
  normalizeFacetChannel,
  normalizeTriangleRanges,
  validateFacetAnnotations,
} from './sparse';
import {
  FacetAnnotationValidationError,
  StaleFacetAnnotationResultError,
  type FacetAnnotationChannel,
  type FacetAnnotationGuard,
  type FacetStrokeCommitResult,
  type FacetStrokeRequest,
} from './types';

export class FacetAnnotationStrokeCommand implements ProjectCommand {
  readonly type = 'facet-annotation-stroke';
  readonly dirtyCategories = ['projectData'] as const;
  private appliedOnce = false;
  private readonly guard: FacetAnnotationGuard;
  private readonly before: FacetAnnotations;
  private readonly after: FacetAnnotations;

  constructor(
    guard: FacetAnnotationGuard,
    before: FacetAnnotations,
    after: FacetAnnotations,
    readonly label: string,
  ) {
    this.guard = Object.freeze({ ...guard });
    this.before = deepFreeze(cloneJson(before));
    this.after = deepFreeze(cloneJson(after));
  }

  apply(context: CommandContext): void {
    if (!this.appliedOnce && !context.project.isCurrent(this.guard)) {
      throw new StaleFacetAnnotationResultError('project');
    }
    this.replace(context, this.before, this.after, this.appliedOnce ? 'annotations' : 'project');
    this.appliedOnce = true;
  }

  revert(context: CommandContext): void {
    this.replace(context, this.after, this.before, 'annotations');
  }

  estimateBytes(): number {
    return canonicalStringify(this.before).length + canonicalStringify(this.after).length;
  }

  private replace(
    context: CommandContext,
    expected: FacetAnnotations,
    replacement: FacetAnnotations,
    mismatchReason: 'project' | 'annotations',
  ): void {
    const current = context.project.getSnapshot().state;
    const found = findVolume(current, this.guard.volumeId);
    if (
      !found ||
      found.volume.source.topologyRevision !== this.guard.topologyRevision ||
      found.volume.source.triangleCount !== this.guard.triangleCount ||
      found.volume.annotations.topologyRevision !== this.guard.topologyRevision
    ) {
      throw new StaleFacetAnnotationResultError('topology');
    }
    if (facetAnnotationsBytes(found.volume.annotations) !== facetAnnotationsBytes(expected)) {
      throw new StaleFacetAnnotationResultError(mismatchReason);
    }
    const next = cloneProjectState(current);
    const nextVolume = findVolume(next, this.guard.volumeId)?.volume;
    if (!nextVolume) throw new StaleFacetAnnotationResultError('project');
    nextVolume.annotations = cloneJson(replacement);
    context.project.replaceState(next, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
  }
}

export function captureFacetAnnotationGuard(commands: CommandBus, volumeId: VolumeId): FacetAnnotationGuard {
  const snapshot = commands.context.project.getSnapshot();
  const found = findVolume(snapshot.state, volumeId);
  if (!found) throw new Error(`Unknown volume ${volumeId}`);
  return {
    revision: snapshot.revision,
    hash: snapshot.hash,
    volumeId,
    topologyRevision: found.volume.source.topologyRevision,
    triangleCount: found.volume.source.triangleCount,
  };
}

export function commitFacetAnnotationStroke<Channel extends FacetAnnotationChannel>(
  commands: CommandBus,
  request: FacetStrokeRequest<Channel>,
): FacetStrokeCommitResult {
  if (request.cancellation?.aborted) {
    return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
  }
  const context = commands.context;
  const prepared = prepareFacetAnnotationStroke(context, request);
  if (prepared === 'noop') return { status: 'noop' };
  commands.execute(
    new FacetAnnotationStrokeCommand(request.guard, prepared.before, prepared.after, strokeLabel(request)),
    { coalesce: false },
  );
  const committed = context.project.getSnapshot();
  return { status: 'applied', revision: committed.revision, hash: committed.hash };
}

/**
 * The before/after annotations one stroke produces against the current state,
 * or `'noop'`. Every refusal a stroke can meet happens here: a stale guard or
 * topology, a non-model volume, invalid stored or resulting annotations.
 */
export function prepareFacetAnnotationStroke<Channel extends FacetAnnotationChannel>(
  context: CommandContext,
  request: Pick<FacetStrokeRequest<Channel>, 'guard' | 'channel' | 'operation'>,
): { before: FacetAnnotations; after: FacetAnnotations } | 'noop' {
  if (!context.project.isCurrent(request.guard)) throw new StaleFacetAnnotationResultError('project');
  const found = findVolume(context.project.getSnapshot().state, request.guard.volumeId);
  if (!found) throw new StaleFacetAnnotationResultError('project');
  if (
    found.volume.source.topologyRevision !== request.guard.topologyRevision ||
    found.volume.source.triangleCount !== request.guard.triangleCount ||
    found.volume.annotations.topologyRevision !== request.guard.topologyRevision
  ) {
    throw new StaleFacetAnnotationResultError('topology');
  }
  if (found.volume.role !== 'model') {
    throw new FacetAnnotationValidationError([
      {
        code: 'incompatible-modifier-annotations',
        path: 'volume.role',
        message: `${found.volume.role} volumes cannot own facet annotations`,
      },
    ]);
  }
  const filamentIds = new Set(
    [
      ...context.project.getSnapshot().state.filaments.physical,
      ...context.project.getSnapshot().state.filaments.mixed,
    ].map((filament) => filament.id),
  );
  const issues = validateFacetAnnotations(found.volume.annotations, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
    filamentIds,
  });
  if (issues.length > 0) throw new FacetAnnotationValidationError(issues);

  const before = cloneJson(found.volume.annotations);
  const normalizedBeforeChannel = normalizeFacetChannel(before[request.channel]);
  const after = cloneJson(before);
  const storedRefinement = before.refinement?.[request.channel] as FacetRefinementEncoding<JsonValue> | undefined;
  if (storedRefinement) {
    if (request.operation.mode === 'reset') {
      after[request.channel] = [] as unknown as FacetAnnotations[Channel];
      setRefinementChannel(after, request.channel, undefined);
    } else {
      const ranges = normalizeTriangleRanges(request.operation.ranges, request.guard.triangleCount);
      const triangles = new Set<number>();
      for (const range of ranges) {
        for (let triangle = range.start; triangle < range.endExclusive; triangle += 1) triangles.add(triangle);
      }
      // A whole-facet stroke says the same thing about every facet it covers,
      // so those facets stop being subdivided and their new value lives in the
      // sparse assignments, exactly as it would on a volume that never carried
      // a refinement.
      const nextRefinement = replaceFacetRefinementRoots(storedRefinement, triangles);
      after[request.channel] = applyFacetChannelStroke(
        normalizedBeforeChannel,
        request.operation,
        request.guard.triangleCount,
      );
      setRefinementChannel(
        after,
        request.channel,
        facetRefinementHasSplits(nextRefinement) ? nextRefinement : undefined,
      );
    }
  } else {
    const afterChannel = applyFacetChannelStroke(
      normalizedBeforeChannel,
      request.operation,
      request.guard.triangleCount,
    );
    if (canonicalStringify(normalizedBeforeChannel) === canonicalStringify(afterChannel)) return 'noop';
    after[request.channel] = afterChannel;
  }
  if (facetAnnotationsBytes(before) === facetAnnotationsBytes(after)) return 'noop';
  const afterIssues = validateFacetAnnotations(after, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
    filamentIds,
  });
  if (afterIssues.length > 0) throw new FacetAnnotationValidationError(afterIssues);
  return { before, after };
}

/**
 * A stroke described by its request rather than by precomputed annotations, for
 * hosts that send intents. The first apply prepares it against the current
 * state exactly as `commitFacetAnnotationStroke` does; later applies and
 * reverts are those of the resulting `FacetAnnotationStrokeCommand`.
 */
export class FacetStrokeRequestCommand<Channel extends FacetAnnotationChannel> implements ProjectCommand {
  readonly type = 'facet-annotation-stroke';
  readonly dirtyCategories = ['projectData'] as const;
  readonly label: string;
  private stroke?: FacetAnnotationStrokeCommand;

  constructor(
    private readonly request: Pick<FacetStrokeRequest<Channel>, 'guard' | 'channel' | 'operation' | 'label'>,
  ) {
    this.label = strokeLabel(request);
  }

  isNoop(context: CommandContext): boolean {
    return !this.stroke && prepareFacetAnnotationStroke(context, this.request) === 'noop';
  }

  apply(context: CommandContext): void {
    if (!this.stroke) {
      const prepared = prepareFacetAnnotationStroke(context, this.request);
      if (prepared === 'noop') throw new StaleFacetAnnotationResultError('annotations');
      this.stroke = new FacetAnnotationStrokeCommand(this.request.guard, prepared.before, prepared.after, this.label);
    }
    this.stroke.apply(context);
  }

  revert(context: CommandContext): void {
    if (!this.stroke) throw new Error('FacetStrokeRequestCommand has not been applied');
    this.stroke.revert(context);
  }

  estimateBytes(): number {
    return this.stroke ? this.stroke.estimateBytes() : 1;
  }
}

function strokeLabel(
  request: Pick<FacetStrokeRequest<FacetAnnotationChannel>, 'channel' | 'operation' | 'label'>,
): string {
  return request.label ?? defaultStrokeLabel(request.channel, request.operation.mode);
}

export interface FacetRefinementCommitRequest<Channel extends FacetAnnotationChannel> {
  guard: FacetAnnotationGuard;
  channel: Channel;
  /**
   * The selector result to persist: one root per source facet, dense. It is
   * split here into the two things canonical state keeps — sparse whole-facet
   * assignments, and the subdivided facets alone.
   */
  encoding: FacetRefinedRootSet<FacetAnnotations[Channel][number]['value']>;
  cancellation?: FacetStrokeRequest<Channel>['cancellation'];
  label?: string;
}

/** Persist one already-resolved refined selector result as one exact history entry. */
export function commitFacetRefinement<Channel extends FacetAnnotationChannel>(
  commands: CommandBus,
  request: FacetRefinementCommitRequest<Channel>,
): FacetStrokeCommitResult {
  if (request.cancellation?.aborted) {
    return { status: 'cancelled', ...(request.cancellation.reason ? { reason: request.cancellation.reason } : {}) };
  }
  const context = commands.context;
  if (!context.project.isCurrent(request.guard)) throw new StaleFacetAnnotationResultError('project');
  const found = findVolume(context.project.getSnapshot().state, request.guard.volumeId);
  if (!found) throw new StaleFacetAnnotationResultError('project');
  if (
    found.volume.source.topologyRevision !== request.guard.topologyRevision ||
    found.volume.source.triangleCount !== request.guard.triangleCount ||
    found.volume.annotations.topologyRevision !== request.guard.topologyRevision
  ) {
    throw new StaleFacetAnnotationResultError('topology');
  }
  if (found.volume.role !== 'model') {
    throw new FacetAnnotationValidationError([
      {
        code: 'incompatible-modifier-annotations',
        path: 'volume.role',
        message: `${found.volume.role} volumes cannot own facet annotations`,
      },
    ]);
  }
  const filamentIds = new Set(
    [
      ...context.project.getSnapshot().state.filaments.physical,
      ...context.project.getSnapshot().state.filaments.mixed,
    ].map((filament) => filament.id),
  );
  const beforeIssues = validateFacetAnnotations(found.volume.annotations, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
    filamentIds,
  });
  if (beforeIssues.length > 0) throw new FacetAnnotationValidationError(beforeIssues);

  const before = cloneJson(found.volume.annotations);
  if (request.encoding.roots.length !== request.guard.triangleCount) {
    throw new FacetAnnotationValidationError([
      {
        code: 'invalid-facet-refinement-root-count',
        path: `refinement.${request.channel}.roots`,
        message: 'A refined selector result must contain exactly one root per source triangle',
      },
    ]);
  }
  const collapsed = collapseFacetRefinementRoots(request.encoding.roots as readonly FacetRefinementNode<JsonValue>[]);
  if (collapsed.encoding) {
    const encodingIssues = validateFacetRefinementChannel(request.channel, collapsed.encoding, collapsed.assignments, {
      triangleCount: request.guard.triangleCount,
      filamentIds,
      path: `refinement.${request.channel}`,
      requireSplit: false,
    });
    if (encodingIssues.length > 0) throw new FacetAnnotationValidationError(encodingIssues);
  }
  const encoding = collapsed.encoding ? normalizeFacetRefinementEncoding(collapsed.encoding) : undefined;
  const after = cloneJson(before);
  after[request.channel] = collapsed.assignments as FacetAnnotations[Channel];
  setRefinementChannel(after, request.channel, encoding && facetRefinementHasSplits(encoding) ? encoding : undefined);
  const afterIssues = validateFacetAnnotations(after, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
    filamentIds,
  });
  if (afterIssues.length > 0) throw new FacetAnnotationValidationError(afterIssues);
  if (facetAnnotationsBytes(before) === facetAnnotationsBytes(after)) return { status: 'noop' };

  commands.execute(
    new FacetAnnotationStrokeCommand(
      request.guard,
      before,
      after,
      request.label ?? `Paint refined ${request.channel} facets`,
    ),
    { coalesce: false },
  );
  const committed = context.project.getSnapshot();
  return { status: 'applied', revision: committed.revision, hash: committed.hash };
}

function setRefinementChannel(
  annotations: FacetAnnotations,
  channel: FacetAnnotationChannel,
  encoding: FacetRefinementEncoding<JsonValue> | undefined,
): void {
  const refinement = { ...(annotations.refinement ?? {}) } as Record<FacetAnnotationChannel, unknown>;
  if (encoding) refinement[channel] = encoding;
  else delete refinement[channel];
  if (Object.keys(refinement).length > 0) annotations.refinement = refinement as FacetAnnotationRefinements;
  else delete annotations.refinement;
}

function defaultStrokeLabel(channel: FacetAnnotationChannel, mode: 'paint' | 'erase' | 'reset'): string {
  const action = mode === 'paint' ? 'Paint' : mode === 'erase' ? 'Erase' : 'Reset';
  return `${action} ${channel} facets`;
}
