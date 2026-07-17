import type { AssetRepositorySnapshot } from '../assets';
import type { ConfigMap, JsonValue, ProjectState, Vec3 } from '../domain/model';
import type { ValidationIssue } from '../domain/validation';

export const LEGACY_PROJECT_3MF_V1_ADAPTER_ID = 'orcaxr-project-3mf-v1' as const;
export const LEGACY_FLAT_PROJECT_V1_ADAPTER_ID = 'orcaxr-flat-project-v1' as const;

export type LegacyMigrationAdapterId =
  typeof LEGACY_PROJECT_3MF_V1_ADAPTER_ID | typeof LEGACY_FLAT_PROJECT_V1_ADAPTER_ID;

export interface LegacyMigrationSource {
  /** Stable caller-owned identity, such as a persisted-project key. */
  sourceKey?: string;
  uri?: string;
  filename?: string;
  /** Used for deterministic project timestamps and asset provenance. */
  importedAt?: string;
}

export interface LegacyMigrationOptions {
  source?: LegacyMigrationSource;
  /** Deterministic fallback when the source has no persisted timestamp. */
  migratedAt?: string;
  /**
   * The legacy workspace magnifies printer millimetres into world metres by
   * 0.001 * 1.75. Override only when migrating a differently scaled snapshot.
   */
  legacyWorldMetresPerPrinterMm?: number;
  /** Optional printer-space origin shift, e.g. half the bed size for corner origin. */
  originOffsetMm?: Vec3;
}

export interface LegacyViewerTransformV1 {
  position: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  scale: readonly [number, number, number];
}

export interface OrcaXrProjectObjectMetadataV1 {
  plate: number;
  viewer: LegacyViewerTransformV1;
  display: readonly [number, number, number];
}

/** Exact persisted sidecar shape written by features/Project3mf.ts. */
export interface OrcaXrProjectMetadataV1 {
  version: 1;
  profile: { machine: string; process: string; filament: string };
  activePlate: number;
  plates: { id: number; label: string }[];
  objects: OrcaXrProjectObjectMetadataV1[];
}

export interface LegacyGeometryV1 {
  positions: ArrayLike<number>;
  legacyId?: string | number;
  name?: string;
  sourceFilename?: string;
}

export type LegacyGeometryInputV1 = ArrayLike<number> | LegacyGeometryV1;

export interface OrcaXrProject3mfV1MigrationInput {
  /** Kept unknown so malformed/future persisted JSON can be repaired honestly. */
  metadata: unknown;
  geometries: readonly LegacyGeometryInputV1[];
  /** The old sidecar omitted the live palette; callers may supply it when available. */
  filaments?: readonly LegacyFilamentSlotV1[];
}

export interface LegacyPlateV1 {
  id: string | number;
  label?: string;
  createdAt?: number;
  printable?: boolean;
  config?: ConfigMap;
}

export interface LegacyFilamentSlotV1 {
  legacyId?: string | number;
  name?: string;
  color: string;
  type: string;
  presetId?: string;
  enabled?: boolean;
  config?: ConfigMap;
}

/**
 * Serializable projection of the old ModelEntry. `viewer` and `display`
 * retain the same units/axes as ProjectObjectMeta; raw positions remain mm/Z-up.
 */
export interface LegacyFlatModelV1 {
  legacyId?: string | number;
  name?: string;
  plateId?: string | number;
  geometry: LegacyGeometryInputV1;
  viewer?: LegacyViewerTransformV1;
  display?: readonly [number, number, number];
  filamentSlot?: number;
  printable?: boolean;
  objectConfig?: ConfigMap;
  volumeConfig?: ConfigMap;
}

/** Flat projections of ModelEntry, PlateStore, and FilamentPalette. */
export interface LegacyFlatProjectV1 {
  version: 1;
  name?: string;
  profile?: { machine?: string; process?: string; filament?: string };
  activePlateId?: string | number;
  plates?: readonly LegacyPlateV1[];
  models?: readonly LegacyFlatModelV1[];
  filaments?: readonly LegacyFilamentSlotV1[];
  config?: ConfigMap;
}

export type MigrationDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface MigrationDiagnostic {
  severity: MigrationDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
  /** True when output remains usable because a deterministic repair was applied. */
  repaired: boolean;
  recoveryEntry?: number;
}

export type MigrationRecoveryDisposition = 'unmapped' | 'repaired' | 'rejected';

export interface MigrationRecoveryEntry {
  path: string;
  reason: string;
  disposition: MigrationRecoveryDisposition;
  /** JSON-safe exact snapshot; non-JSON JS values use tagged objects. */
  value: JsonValue;
}

export interface MigrationRecoveryPayloadV1 {
  version: 1;
  adapter: LegacyMigrationAdapterId;
  sourceKey: string;
  entries: MigrationRecoveryEntry[];
}

export interface LegacyMigrationResult {
  state: ProjectState;
  /** Owned snapshot accepted directly by AssetRepository.restore(). */
  assets: AssetRepositorySnapshot;
  diagnostics: MigrationDiagnostic[];
  recovery: MigrationRecoveryPayloadV1;
  validationIssues: ValidationIssue[];
}

export interface LegacyMigrationAdapter<Input> {
  readonly id: LegacyMigrationAdapterId;
  readonly sourceVersion: 1;
  migrate(input: Input, options?: LegacyMigrationOptions): LegacyMigrationResult;
}
