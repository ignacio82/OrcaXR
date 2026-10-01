import type { AssetPayload } from './assets';
import type { JsonValue, ProjectState } from './domain/model';
import type { PlateId, ProjectId } from './domain/ids';
import type { SelectionSnapshot } from './selection';
import type { CommandHistorySnapshot } from './history/commandBus';
import type { ProjectSnapshot } from './store';

export interface CancellationToken {
  readonly aborted: boolean;
  readonly reason?: string;
}

export interface ProjectArchiveSnapshot {
  state: ProjectState;
  assets: AssetPayload[];
  sourceRevision: number;
  sourceHash: string;
}

export interface SerializedProject {
  bytes: Uint8Array;
  mediaType: string;
  suggestedFilename: string;
  sourceRevision: number;
  sourceHash: string;
  /** Optional archive integrity proof computed on the serializer's worker. */
  archiveDigest?: string;
  /** Compatibility/projection notes produced while building the archive. */
  warnings?: string[];
}

/** Exact authority represented by a serialized archive, independent of saved state. */
export interface ProjectExportGuard {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly semanticHash: string;
  readonly assetFingerprint: string;
}

/** Recovery metadata is checked against the raw archive before import normalization. */
export interface ProjectRecoveryProof {
  readonly guard: ProjectExportGuard;
  readonly archiveDigest: string;
}

export interface SerializedProjectSnapshot {
  readonly serialized: SerializedProject;
  readonly guard: ProjectExportGuard;
}

export interface ProjectSerializationOptions {
  /** Recovery must stay off the UI thread; explicit manual export may use a fallback. */
  readonly purpose?: 'manual' | 'recovery' | 'slice';
}

/** Production implementations adapt this port to the pinned BBS 3MF codec. */
export interface ProjectSerializerPort {
  serialize(
    snapshot: ProjectArchiveSnapshot,
    cancellation?: CancellationToken,
    options?: ProjectSerializationOptions,
  ): Promise<SerializedProject>;
  deserialize(
    bytes: Uint8Array,
    cancellation?: CancellationToken,
  ): Promise<{
    state: ProjectState;
    assets: AssetPayload[];
    warnings: string[];
  }>;
}

export interface SliceRequest extends ProjectArchiveSnapshot {
  plateId: PlateId;
  cancellation?: CancellationToken;
}

export interface SliceResult {
  sourceRevision: number;
  sourceHash: string;
  plateId: PlateId;
  gcode: Uint8Array;
  warnings: string[];
  statistics: Record<string, JsonValue>;
}

/** Production implementations adapt this to browser-worker or server slicing. */
export interface SliceAdapterPort {
  slice(request: SliceRequest): Promise<SliceResult>;
}

/** Thin DOM/XR/headless projections consume the same store/session snapshots. */
export interface EditorSurfacePort {
  /** Bounded human-readable identity used only for projection diagnostics. */
  readonly projectionLabel?: string;
  renderProject(snapshot: ProjectSnapshot): void;
  renderSelection(snapshot: SelectionSnapshot): void;
  renderHistory?(snapshot: CommandHistorySnapshot): void;
  dispose?(): void;
}

export interface ProjectProjectionFailure {
  /** Stable only for this attachment's lifetime. */
  readonly surfaceId: number;
  readonly surfaceLabel: string;
  readonly projectRevision: number;
  readonly message: string;
}

/** Read-only health of every attached surface's latest project projection. */
export interface ProjectProjectionHealthSnapshot {
  readonly healthy: boolean;
  readonly projectFailures: readonly ProjectProjectionFailure[];
}

export type ProjectProjectionHealthSubscriber = (
  current: ProjectProjectionHealthSnapshot,
  previous: ProjectProjectionHealthSnapshot,
) => void;
