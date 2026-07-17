import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from '../domain/canonical';
import type { VolumeId } from '../domain/ids';
import type { FacetAnnotations } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import type { CommandBus } from '../history/commandBus';
import {
  applyFacetChannelStroke,
  facetAnnotationsBytes,
  normalizeFacetChannel,
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
  const afterChannel = applyFacetChannelStroke(normalizedBeforeChannel, request.operation, request.guard.triangleCount);
  if (canonicalStringify(normalizedBeforeChannel) === canonicalStringify(afterChannel)) {
    return { status: 'noop' };
  }
  const after = cloneJson(before);
  after[request.channel] = afterChannel;
  const afterIssues = validateFacetAnnotations(after, {
    topologyRevision: request.guard.topologyRevision,
    triangleCount: request.guard.triangleCount,
    filamentIds,
  });
  if (afterIssues.length > 0) throw new FacetAnnotationValidationError(afterIssues);
  const label = request.label ?? defaultStrokeLabel(request.channel, request.operation.mode);
  commands.execute(new FacetAnnotationStrokeCommand(request.guard, before, after, label), {
    coalesce: false,
  });
  const committed = context.project.getSnapshot();
  return { status: 'applied', revision: committed.revision, hash: committed.hash };
}

function defaultStrokeLabel(channel: FacetAnnotationChannel, mode: 'paint' | 'erase' | 'reset'): string {
  const action = mode === 'paint' ? 'Paint' : mode === 'erase' ? 'Erase' : 'Reset';
  return `${action} ${channel} facets`;
}
