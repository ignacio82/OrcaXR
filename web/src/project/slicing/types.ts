import type { JsonValue, ProjectState } from '../domain/model';
import type { PlateId } from '../domain/ids';
import type { ProjectArchiveSnapshot } from '../ports';
import type { SlicePreflightIssue } from './preflight';

export const SLICE_PROTOCOL_VERSION = 1 as const;
export type SliceProtocolVersion = typeof SLICE_PROTOCOL_VERSION;

export type SliceRouteKind = 'browser-wasm' | 'external-server' | 'test';

export interface SliceEngineMetadata {
  readonly commit: string;
  readonly artifactHash: string;
}

export interface SliceRouteMetadata {
  readonly id: string;
  readonly kind: SliceRouteKind;
  readonly protocolVersion: SliceProtocolVersion;
  readonly engine: SliceEngineMetadata;
}

export type SliceProfileKind = 'printer' | 'process' | 'filament';

export interface SlicePrinterProfileReference {
  readonly kind: 'printer';
  readonly id: string;
  readonly hash: string;
}

export interface SliceProcessProfileReference {
  readonly kind: 'process';
  readonly id: string;
  readonly hash: string;
}

export interface SliceFilamentProfileReference {
  readonly kind: 'filament';
  readonly id: string;
  readonly hash: string;
  /** Exact zero-based filament slot submitted to the slicing engine. */
  readonly tool: number;
}

export type SliceProfileReference =
  SlicePrinterProfileReference | SliceProcessProfileReference | SliceFilamentProfileReference;

/**
 * Immutable identity of the effective profile set used for one plate. The
 * compatible project archive remains the source of actual slicing settings;
 * this snapshot makes profile drift visible and auditable.
 */
export interface SliceProfileSnapshot {
  readonly references: readonly SliceProfileReference[];
  readonly effectiveConfigHash: string;
}

export interface SliceProfileResolverPort {
  capture(state: ProjectState, plateId: PlateId): SliceProfileSnapshot | Promise<SliceProfileSnapshot>;
}

export interface CanonicalProjectSliceGuard {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly sourceAssetHash: string;
}

export interface CanonicalProjectSliceSnapshot extends ProjectArchiveSnapshot {
  readonly sourceAssetHash: string;
}

export interface CanonicalProjectSliceSourcePort {
  capture(): CanonicalProjectSliceSnapshot;
  isCurrent(guard: CanonicalProjectSliceGuard): boolean;
}

export interface SliceRouteProjectInput {
  /** A fresh copy is supplied for every attempt. Adapters may transfer it. */
  readonly bytes: Uint8Array;
  readonly mediaType: 'model/3mf';
  readonly inputHash: string;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly sourceAssetHash: string;
}

export interface SliceRouteRequest {
  readonly protocolVersion: SliceProtocolVersion;
  readonly jobId: string;
  readonly attempt: number;
  readonly plateId: PlateId;
  readonly project: SliceRouteProjectInput;
  readonly profiles: SliceProfileSnapshot;
  readonly engine: SliceEngineMetadata;
}

export interface SliceRouteResponse {
  readonly protocolVersion: SliceProtocolVersion;
  readonly jobId: string;
  readonly plateId: PlateId;
  readonly inputHash: string;
  readonly engine: SliceEngineMetadata;
  readonly gcode: Uint8Array;
  readonly warnings: readonly string[];
  readonly statistics: Readonly<Record<string, JsonValue>>;
}

export interface SliceRouteProgress {
  readonly percent?: number;
  readonly message?: string;
}

export type SliceRecoveryReason = 'retryable-error' | 'timeout';

export interface SliceRouteRecoveryContext {
  readonly jobId: string;
  readonly plateId: PlateId;
  readonly failedAttempt: number;
  readonly reason: SliceRecoveryReason;
}

/** One adapter instance represents one semantic route; retries may not switch it. */
export interface SliceRouteAdapterPort {
  readonly metadata: SliceRouteMetadata;
  /**
   * When present, abort is terminal only after execute settles with an explicit
   * SliceRouteCancellationError or this cleanup bound expires.
   */
  readonly cancellation?: {
    readonly mode: 'confirmed-cleanup';
    readonly cleanupTimeoutMs: number;
  };
  execute(
    request: SliceRouteRequest,
    signal: AbortSignal,
    onProgress?: (progress: SliceRouteProgress) => void,
  ): Promise<SliceRouteResponse>;
  isRetryable?(error: unknown): boolean;
  recover?(context: SliceRouteRecoveryContext, signal: AbortSignal): Promise<void>;
}

export type SliceJobScope = 'current-plate' | 'all-plates';
export type SliceJobPhase =
  | 'queued'
  | 'preflighting'
  | 'serializing'
  | 'submitting'
  | 'retrying'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'timed-out'
  | 'stale'
  | 'failed';

export interface SliceJobStatus {
  readonly id: string;
  readonly scope: SliceJobScope;
  readonly phase: SliceJobPhase;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly sourceAssetHash: string;
  readonly plateIds: readonly PlateId[];
  readonly completedPlateCount: number;
  readonly totalPlateCount: number;
  readonly activePlateId?: PlateId;
  readonly attempt: number;
  readonly progressPercent?: number;
  readonly progressMessage?: string;
  readonly cancellationConfirmed?: boolean;
  readonly errorName?: string;
}

export interface SlicePlateResult {
  readonly plateId: PlateId;
  readonly projectInputHash: string;
  readonly outputHash: string;
  readonly profiles: SliceProfileSnapshot;
  readonly preflightIssues: readonly SlicePreflightIssue[];
  readonly serializerWarnings: readonly string[];
  readonly gcode: Uint8Array;
  readonly warnings: readonly string[];
  readonly statistics: Readonly<Record<string, JsonValue>>;
  readonly attempts: number;
}

export interface CanonicalSliceJobResult {
  readonly protocolVersion: SliceProtocolVersion;
  readonly jobId: string;
  readonly scope: SliceJobScope;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly sourceAssetHash: string;
  readonly route: SliceRouteMetadata;
  readonly serializerWarnings: readonly string[];
  readonly warnings: readonly string[];
  readonly plates: readonly SlicePlateResult[];
  readonly completedAt: string;
}

export interface SliceResultPublisherPort {
  publish(result: CanonicalSliceJobResult): void;
}

export interface SliceJobOptions {
  /** Attempts per plate, including the initial attempt. */
  readonly maxAttempts?: number;
  readonly preflightTimeoutMs?: number;
  /** Per route attempt. */
  /**
   * How long one attempt may go **without reporting progress** before it is
   * treated as stuck. It is not a cap on how long a slice may take: a large
   * model legitimately runs for many minutes, and both routes report progress
   * throughout, so a duration cap would cancel healthy work.
   */
  readonly attemptIdleTimeoutMs?: number;
  readonly serializationTimeoutMs?: number;
  readonly recoveryTimeoutMs?: number;
}

export interface SliceJobHandle {
  readonly id: string;
  readonly completion: Promise<CanonicalSliceJobResult>;
  cancel(reason?: string): void;
  getStatus(): SliceJobStatus;
}

export type SliceJobSubscriber = (status: SliceJobStatus) => void;

export interface SliceContentHasherPort {
  digest(bytes: Uint8Array): Promise<string>;
}
