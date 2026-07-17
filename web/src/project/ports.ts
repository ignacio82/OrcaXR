import type { AssetPayload } from './assets';
import type { JsonValue, ProjectState } from './domain/model';
import type { PlateId } from './domain/ids';
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
  /** Compatibility/projection notes produced while building the archive. */
  warnings?: string[];
}

/** Production implementations adapt this port to the pinned BBS 3MF codec. */
export interface ProjectSerializerPort {
  serialize(snapshot: ProjectArchiveSnapshot, cancellation?: CancellationToken): Promise<SerializedProject>;
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
  renderProject(snapshot: ProjectSnapshot): void;
  renderSelection(snapshot: SelectionSnapshot): void;
  renderHistory?(snapshot: CommandHistorySnapshot): void;
  dispose?(): void;
}
