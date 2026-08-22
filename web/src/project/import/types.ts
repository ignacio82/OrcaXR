import type { AssetPayload } from '../assets';
import type { AssetId } from '../domain/ids';
import type { JsonValue, ProjectState } from '../domain/model';
import type { CommandHistorySnapshot } from '../history/commandBus';
import type { CancellationToken, ProjectArchiveSnapshot } from '../ports';
import type { ProjectSnapshot } from '../store';

export type ProjectImportMode = 'merge' | 'replace';

export interface ProjectImportSource {
  filename: string;
  mediaType?: string;
  uri?: string;
  /** Inject this at the composition root when deterministic provenance matters. */
  importedAt?: string;
}

export interface ProjectImportRequest {
  bytes: Uint8Array;
  source: ProjectImportSource;
  mode?: ProjectImportMode;
  cancellation?: CancellationToken;
}

/**
 * A worker/parser receives copies of the canonical bundle. Merge parsers may
 * build a proposed project from `base`; replace parsers may ignore its content.
 * Neither path receives a live store or repository reference.
 */
export interface ProjectImportParseRequest {
  bytes: Uint8Array;
  source: Readonly<ProjectImportSource>;
  mode: ProjectImportMode;
  base: ProjectArchiveSnapshot;
  cancellation?: CancellationToken;
}

/**
 * Something the importer already fixed, losslessly, on the way in: a unit
 * conversion, byte-identical assets consolidated, a colliding name remapped, a
 * broken mesh made printable.
 *
 * A repair is NOT a decision. The operator's decision is whether to import at
 * all, and the import commits as one undoable command either way, so gating each
 * repair behind its own checkbox asks them to approve work they cannot
 * meaningfully refuse — a 3MF with 24 duplicated meshes turned an open into 24
 * clicks. Repairs are reported after the fact instead. `requiresConfirmation`
 * therefore defaults to FALSE here; set it to `true` only for a repair that
 * genuinely changes what the operator authored, and expect it to interrupt them.
 */
export interface ImportRepairNotice {
  id: string;
  kind: 'unit-conversion' | 'asset-deduplication' | 'identifier-remap' | 'geometry-repair' | 'other';
  path: string;
  message: string;
  before?: JsonValue;
  after?: JsonValue;
  /** Defaults to FALSE — see the note above. */
  requiresConfirmation?: boolean;
}

export interface ImportConflictNotice {
  id: string;
  kind: 'asset' | 'entity-id' | 'preset' | 'project' | 'other';
  path: string;
  message: string;
  /** Missing means the parser could not produce a safe candidate. */
  resolution?: string;
  alternatives?: readonly string[];
  /** Defaults to true for resolved conflicts. */
  requiresConfirmation?: boolean;
}

export interface ImportDroppedFieldNotice {
  id: string;
  path: string;
  field: string;
  message: string;
  value?: JsonValue;
  /** Defaults to true. */
  requiresConfirmation?: boolean;
}

export type ImportDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ImportDiagnostic {
  id: string;
  severity: ImportDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
}

/**
 * Full proposed bundle returned by an injected worker/parser. Asset IDs in
 * `importedAssetIds` identify payloads whose filename/provenance came from the
 * current source rather than the base snapshot.
 */
export interface ParsedProjectImport {
  state: ProjectState;
  assets: AssetPayload[];
  importedAssetIds: readonly AssetId[];
  repairs?: readonly ImportRepairNotice[];
  conflicts?: readonly ImportConflictNotice[];
  droppedFields?: readonly ImportDroppedFieldNotice[];
  diagnostics?: readonly ImportDiagnostic[];
}

/**
 * Production adapters should implement this port with an actual worker for
 * archive parsing, mesh decoding, and repair. The coordinator deliberately has
 * no Worker/DOM dependency so headless and XR surfaces share the same flow.
 */
export interface ProjectImportParserPort {
  parse(request: ProjectImportParseRequest): Promise<ParsedProjectImport>;
}

export interface ProjectImportCounts {
  plates: number;
  objects: number;
  assets: number;
  importedAssets: number;
  deduplicatedAssets: number;
}

export interface ProjectImportPreview {
  source: Readonly<ProjectImportSource>;
  mode: ProjectImportMode;
  baseRevision: number;
  baseHash: string;
  projectName: string;
  counts: Readonly<ProjectImportCounts>;
  blocked: boolean;
  requiredAcknowledgementIds: readonly string[];
  repairs: readonly ImportRepairNotice[];
  conflicts: readonly ImportConflictNotice[];
  droppedFields: readonly ImportDroppedFieldNotice[];
  diagnostics: readonly ImportDiagnostic[];
}

export interface ImportCommitConfirmation {
  confirmed: true;
  acknowledgedNoticeIds: readonly string[];
}

export interface ImportCommitResult {
  project: ProjectSnapshot;
  history: CommandHistorySnapshot;
  diagnostics: readonly ImportDiagnostic[];
}

export class ImportCancelledError extends Error {
  constructor(readonly cancellationReason?: string) {
    super(cancellationReason ? `Import cancelled: ${cancellationReason}` : 'Import cancelled');
    this.name = 'ImportCancelledError';
  }
}

export class ImportPreparationError extends Error {
  constructor(
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'ImportPreparationError';
  }
}

export class ImportConfirmationError extends Error {
  constructor(
    message: string,
    readonly missingAcknowledgementIds: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ImportConfirmationError';
  }
}

export class StaleImportPreviewError extends Error {
  constructor() {
    super('The project or its assets changed after this import preview was prepared');
    this.name = 'StaleImportPreviewError';
  }
}

/** Small platform-neutral cancellation source for parser adapters and tests. */
export class ImportCancellationController {
  private readonly state: { cancelled: boolean; reason?: string } = { cancelled: false };

  readonly token: CancellationToken;

  constructor() {
    const state = this.state;
    this.token = {
      get aborted() {
        return state.cancelled;
      },
      get reason() {
        return state.reason;
      },
    };
  }

  cancel(reason = 'cancelled by user'): void {
    if (this.state.cancelled) return;
    this.state.cancelled = true;
    this.state.reason = reason;
  }
}
