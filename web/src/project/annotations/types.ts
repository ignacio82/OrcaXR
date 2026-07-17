import type { FilamentId, VolumeId } from '../domain/ids';
import type { FacetAnnotations } from '../domain/model';
import type { CancellationToken } from '../ports';
import type { ProjectRevisionGuard } from '../store';

export type FacetAnnotationChannel = 'color' | 'support' | 'seam' | 'fuzzySkin' | 'brim';

export type FacetAnnotationValue<Channel extends FacetAnnotationChannel> = FacetAnnotations[Channel][number]['value'];

export interface TriangleRange {
  start: number;
  endExclusive: number;
}

export interface FacetAnnotationIssue {
  code: string;
  path: string;
  message: string;
}

export interface FacetAnnotationValidationOptions {
  topologyRevision: number;
  triangleCount: number;
  filamentIds?: ReadonlySet<string>;
}

export interface FacetAnnotationGuard extends ProjectRevisionGuard {
  volumeId: VolumeId;
  topologyRevision: number;
  triangleCount: number;
}

export type FacetStrokeOperation<Channel extends FacetAnnotationChannel> =
  | {
      mode: 'paint';
      ranges: readonly TriangleRange[];
      value: FacetAnnotationValue<Channel>;
    }
  | { mode: 'erase'; ranges: readonly TriangleRange[] }
  | { mode: 'reset' };

export interface FacetStrokeRequest<Channel extends FacetAnnotationChannel> {
  guard: FacetAnnotationGuard;
  channel: Channel;
  operation: FacetStrokeOperation<Channel>;
  cancellation?: CancellationToken;
  label?: string;
}

export type FacetStrokeCommitResult =
  { status: 'applied'; revision: number; hash: string } | { status: 'noop' } | { status: 'cancelled'; reason?: string };

export class FacetAnnotationValidationError extends Error {
  constructor(readonly issues: readonly FacetAnnotationIssue[]) {
    super(`Invalid facet annotations (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'FacetAnnotationValidationError';
  }
}

export class StaleFacetAnnotationResultError extends Error {
  constructor(readonly reason: 'project' | 'topology' | 'annotations') {
    super(`Facet annotation result is stale (${reason})`);
    this.name = 'StaleFacetAnnotationResultError';
  }
}

export type ColorFacetValue = FilamentId;
