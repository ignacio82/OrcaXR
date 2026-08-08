import {
  GCODE_RECORD_KIND,
  GCODE_RECORD_KIND_NAMES,
  RICH_GCODE_HARD_CAPS,
  parseRichGcodeModel,
  type RichGcodeModel,
  type RichGcodeParseOptions,
} from './RichGcodeModel';
import { validateGcodePathSidecar } from './GcodePathSegments';
import { sha256Utf8 } from './Utf8Sha256';

const VERIFIED_RICH_GCODE_SOURCE = Symbol('verified-rich-gcode-statistics-source');
const GCODE_STATISTICS_PROJECTION = Symbol('gcode-statistics-projection');
const CANONICAL_ARRAY_BEHAVIOR_NAMES = Object.freeze(
  Object.getOwnPropertyNames(Array.prototype).filter((name) => name !== 'length'),
);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length')?.get;
const CANONICAL_TYPED_ARRAY_BEHAVIOR_NAMES = Object.freeze([
  ...new Set([
    ...Object.getOwnPropertyNames(TYPED_ARRAY_PROTOTYPE),
    ...Object.getOwnPropertyNames(Uint8Array.prototype),
  ]),
]);
const GCODE_STATISTICS_ERROR_CODES = Object.freeze([
  'invalid-model',
  'invalid-artifact',
  'binding-mismatch',
  'inconsistent-statistics',
  'aggregation-cap',
  'incompatible-plates',
] as const);
const ISSUE_GCODE_STATISTICS_ERROR = Symbol('issue-gcode-statistics-error');
const issuedGcodeStatisticsErrors = new WeakSet<object>();

interface VerifiedRichGcodeStatisticsSnapshot {
  readonly gcodeOutputHash: string;
  readonly layerCount: number;
  readonly observedEvents: GcodeObservedEventCounts;
}

const verifiedRichGcodeStatisticsSources = new WeakMap<object, VerifiedRichGcodeStatisticsSnapshot>();
const verifiedGcodeStatisticsProjections = new WeakSet<object>();

export const GCODE_STATISTICS_SCHEMA = 'orcaxr.gcode-statistics' as const;
export const GCODE_STATISTICS_VERSION = 1 as const;

/** Pinned engine domains. These intentionally do not inherit the richer viewer-table caps. */
export const GCODE_STATISTICS_HARD_CAPS = Object.freeze({
  plates: 36,
  tools: 255,
  roles: 20,
  moveKinds: 11,
  layers: RICH_GCODE_HARD_CAPS.lines,
  /** Independent exporter contracts, not aliases of rich-viewer prefix budgets. */
  plannerBlocks: 1_500_000,
  materialSamples: 10_000_000,
  customEvents: 100_000,
  diagnostics: 2_048,
  conflicts: 1,
  omissions: 2_048,
  textCharacters: 512,
  seconds: 1_000_000_000_000,
  volumeMm3: 1_000_000_000_000_000,
  minimumDiameterMm: 0.01,
  diameterMm: 100,
  densityGPerCm3: 100,
  costPerKg: 1_000_000_000,
  timeCostPerHour: 1_000_000_000,
  zMm: 1_000_000_000,
  derivedQuantity: 1_000_000_000_000_000_000_000_000_000_000,
});

export type GcodeStatisticsTimeModeId = 'normal' | 'silent';
export type GcodeStatisticsCustomEventKind =
  'color-change' | 'pause' | 'tool-change' | 'template' | 'custom' | 'unknown';

export interface GcodeStatisticsBinding {
  readonly jobId: string;
  readonly plateId: string;
  readonly sourceRevision: number;
  /** Canonical ProjectStore fingerprint (`fnv1a64:<16 lowercase hex>`). */
  readonly sourceHash: string;
  /** Canonical immutable asset-bundle fingerprint (`fnv1a64:<16 lowercase hex>`). */
  readonly sourceAssetHash: string;
  readonly projectInputHash: string;
  readonly gcodeOutputHash: string;
  readonly effectiveConfigHash: string;
  readonly engineCommit: string;
  readonly engineArtifactHash: string;
}

/** Created only by hashing and parsing the same exact UTF-8 G-code text. */
export interface VerifiedRichGcodeStatisticsSource {
  readonly gcodeOutputHash: string;
  readonly [VERIFIED_RICH_GCODE_SOURCE]: true;
}

export interface GcodeStatisticsCostUnit {
  /** Stable project unit identity, such as an ISO-4217 currency code. */
  readonly id: string;
  readonly label: string;
}

export interface GcodeTimeBreakdownRow {
  readonly id: number;
  readonly seconds: number;
}

export interface GcodeCustomTimeBreakdownRow {
  /** Pinned CustomGCode type attached to this accumulated planner segment. */
  readonly kind: GcodeStatisticsCustomEventKind;
  /** Planner duration accumulated since the prior emitted custom event. */
  readonly durationSeconds: number;
  /** Pinned remaining time before subtracting this segment. */
  readonly remainingSeconds: number;
}

export interface GcodeTimeModeArtifact {
  readonly id: GcodeStatisticsTimeModeId;
  /** Processed TimeBlock count used to bound float32 partition-reconciliation error. */
  readonly plannerBlockCount: number;
  readonly totalSeconds: number;
  readonly prepareSeconds: number;
  readonly layerSeconds: readonly number[];
  readonly moveSeconds: readonly GcodeTimeBreakdownRow[];
  readonly roleSeconds: readonly GcodeTimeBreakdownRow[];
  /** Ordered planner segments. Kinds may repeat; the final row may be synthetic. */
  readonly customGcodeSeconds: readonly GcodeCustomTimeBreakdownRow[];
}

export interface GcodeFilamentStatisticsArtifact {
  /** Plate-local engine tool/extruder index, in the pinned 0..254 domain. */
  readonly tool: number;
  readonly profileId: string;
  readonly profileHash: string;
  readonly diameterMm: number | null;
  readonly densityGPerCm3: number | null;
  readonly costPerKg: number | null;
  /** Maximum additions into any compared double material accumulator for this tool. */
  readonly volumeSampleCount: number;
  /** Positive spatial extrusion not classified as support or wipe tower; not object-only material. */
  readonly modelVolumeMm3: number;
  readonly supportVolumeMm3: number;
  readonly wipeTowerVolumeMm3: number;
  readonly flushedVolumeMm3: number;
  readonly totalVolumeMm3: number;
}

/** Required engine extension: pinned aggregate role mass/length cannot recover role x tool usage. */
export interface GcodeRoleToolUsageArtifact {
  readonly role: number;
  readonly tool: number;
  readonly volumeMm3: number;
}

export interface GcodeStatisticsDiagnosticArtifact {
  readonly source: 'engine' | 'export' | 'preflight' | 'conflict-check';
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly params: readonly string[];
}

export type GcodeStatisticsConflictSubjectArtifact =
  | {
      readonly kind: 'object';
      readonly objectId: string;
      readonly name: string;
    }
  | {
      readonly kind: 'wipe-tower';
      readonly name: string;
    };

export interface GcodeStatisticsConflictArtifact {
  readonly code: string;
  readonly message: string;
  readonly subjects: readonly [GcodeStatisticsConflictSubjectArtifact, GcodeStatisticsConflictSubjectArtifact];
  /** Pinned upper-bound layer ordinal. It may equal layerCount. */
  readonly layerUpperBoundOrdinal: number | null;
  readonly zMm: number | null;
}

export interface GcodeStatisticsConflictCheckArtifact {
  readonly outcome: 'checked-none-found' | 'detected' | 'not-run' | 'unsupported';
  readonly exhaustive: boolean;
  readonly reason: string | null;
  readonly suppressionReasons: readonly string[];
}

export interface GcodeStatisticsOmission {
  /** Exact nullable leaf path; aliases and parent/child wildcard paths are rejected. */
  readonly path: string;
  readonly reason: string;
}

/**
 * JSON-safe, versioned sidecar captured in the same export call as the bound
 * G-code. It carries authoritative planner values and exact material inputs;
 * presentation totals are derived without guessing from feedrate or Float32
 * viewer columns.
 */
export interface AuthoritativeGcodeStatisticsArtifact {
  readonly schema: typeof GCODE_STATISTICS_SCHEMA;
  readonly version: typeof GCODE_STATISTICS_VERSION;
  readonly binding: GcodeStatisticsBinding;
  readonly layerCount: number;
  /** Processor-observed valid transitions; not wipe-tower planning count. */
  readonly processorFilamentChangeCount: number;
  /** Generator/wipe-tower planning statistic, when the engine supplies it. */
  readonly plannedWipeTowerToolChangeCount: number | null;
  readonly costUnit: GcodeStatisticsCostUnit | null;
  readonly timeCostPerHour: number | null;
  readonly timeModes: readonly GcodeTimeModeArtifact[];
  readonly filaments: readonly GcodeFilamentStatisticsArtifact[];
  readonly roleToolUsage: readonly GcodeRoleToolUsageArtifact[];
  readonly diagnostics: readonly GcodeStatisticsDiagnosticArtifact[];
  readonly conflictCheck: GcodeStatisticsConflictCheckArtifact;
  readonly conflicts: readonly GcodeStatisticsConflictArtifact[];
  readonly omissions: readonly GcodeStatisticsOmission[];
}

export interface GcodeMaterialUsageProjection {
  readonly volumeMm3: number;
  readonly filamentLengthMm: number | null;
  readonly filamentWeightG: number | null;
  readonly cost: number | null;
}

export interface GcodeMaterialCategoriesProjection {
  readonly model: GcodeMaterialUsageProjection;
  readonly support: GcodeMaterialUsageProjection;
  readonly wipeTower: GcodeMaterialUsageProjection;
  readonly flushed: GcodeMaterialUsageProjection;
  readonly total: GcodeMaterialUsageProjection;
}

export interface GcodeFilamentStatisticsProjection extends GcodeFilamentStatisticsArtifact {
  readonly usage: GcodeMaterialCategoriesProjection;
  readonly accessibleLabel: string;
}

export interface GcodeRoleToolUsageProjection extends GcodeRoleToolUsageArtifact {
  readonly profileId: string;
  readonly profileHash: string;
  readonly usage: GcodeMaterialUsageProjection;
  readonly accessibleLabel: string;
}

export interface GcodeTimeModeProjection extends GcodeTimeModeArtifact {
  readonly modelSeconds: number;
  readonly accessibleLabel: string;
}

export interface GcodeObservedCoverage {
  readonly kind: 'complete' | 'degraded' | 'prefix';
  readonly exhaustive: boolean;
  readonly terminationReason: string | null;
  readonly warningCodes: readonly string[];
}

export interface GcodeObservedEventCounts {
  readonly coverage: GcodeObservedCoverage;
  readonly toolChangeMarkers: number;
  readonly colorChanges: number;
  readonly pauses: number;
  readonly customGcode: number;
}

export interface GcodeStatisticsTotalsProjection extends GcodeMaterialCategoriesProjection {
  readonly timeCost: number | null;
  readonly totalCost: number | null;
}

export interface GcodeStatisticsLimitation {
  readonly code:
    | 'source-prefix'
    | 'source-degraded'
    | 'authoritative-omission'
    | 'conflict-check-unavailable'
    | 'conflict-check-non-exhaustive'
    | 'silent-mode-partial';
  readonly path: string;
  readonly message: string;
}

export interface GcodeStatisticsProjection {
  readonly [GCODE_STATISTICS_PROJECTION]: true;
  readonly status: 'ready' | 'partial';
  readonly binding: GcodeStatisticsBinding;
  readonly layerCount: number;
  readonly processorFilamentChangeCount: number;
  readonly plannedWipeTowerToolChangeCount: number | null;
  readonly costUnit: GcodeStatisticsCostUnit | null;
  readonly timeCostPerHour: number | null;
  readonly observedEvents: GcodeObservedEventCounts;
  readonly timeModes: readonly GcodeTimeModeProjection[];
  readonly filaments: readonly GcodeFilamentStatisticsProjection[];
  readonly roleToolUsage: readonly GcodeRoleToolUsageProjection[];
  readonly totals: GcodeStatisticsTotalsProjection;
  readonly diagnostics: readonly GcodeStatisticsDiagnosticArtifact[];
  readonly conflictCheck: GcodeStatisticsConflictCheckArtifact;
  readonly conflicts: readonly GcodeStatisticsConflictArtifact[];
  readonly limitations: readonly GcodeStatisticsLimitation[];
  readonly accessibleLabel: string;
}

export interface GcodePlateToolReference {
  readonly plateId: string;
  readonly tool: number;
}

export interface AggregatedGcodeFilamentStatisticsProjection {
  readonly tool: number;
  readonly profileId: string;
  readonly profileHash: string;
  readonly diameterMm: number | null;
  readonly densityGPerCm3: number | null;
  readonly costPerKg: number | null;
  readonly volumeSampleCount: number;
  readonly sources: readonly GcodePlateToolReference[];
  readonly usage: GcodeMaterialCategoriesProjection;
  readonly accessibleLabel: string;
}

export interface AggregatedGcodeRoleToolUsageProjection {
  readonly role: number;
  readonly tool: number;
  readonly profileId: string;
  readonly profileHash: string;
  readonly sources: readonly GcodePlateToolReference[];
  readonly usage: GcodeMaterialUsageProjection;
  readonly accessibleLabel: string;
}

export interface AggregatedGcodeCustomTimeBreakdownRow extends GcodeCustomTimeBreakdownRow {
  readonly plateId: string;
}

export interface AggregatedGcodeTimeModeProjection {
  readonly id: GcodeStatisticsTimeModeId;
  readonly plannerBlockCount: number;
  readonly totalSeconds: number;
  readonly prepareSeconds: number;
  readonly modelSeconds: number;
  readonly moveSeconds: readonly GcodeTimeBreakdownRow[];
  readonly roleSeconds: readonly GcodeTimeBreakdownRow[];
  /** Plate-scoped ordered events; no fictitious all-plate event timeline is created. */
  readonly customGcodeSeconds: readonly AggregatedGcodeCustomTimeBreakdownRow[];
  readonly accessibleLabel: string;
}

export interface AllPlateGcodeStatisticsProjection {
  readonly status: 'ready' | 'partial';
  readonly plateCount: number;
  readonly bindings: readonly GcodeStatisticsBinding[];
  readonly layerCount: number;
  readonly processorFilamentChangeCount: number;
  readonly plannedWipeTowerToolChangeCount: number | null;
  readonly costUnit: GcodeStatisticsCostUnit | null;
  readonly timeCostAssumptions: readonly {
    readonly plateId: string;
    readonly costPerHour: number | null;
  }[];
  readonly observedEvents: GcodeObservedEventCounts;
  readonly timeModes: readonly AggregatedGcodeTimeModeProjection[];
  readonly filaments: readonly AggregatedGcodeFilamentStatisticsProjection[];
  readonly roleToolUsage: readonly AggregatedGcodeRoleToolUsageProjection[];
  readonly totals: GcodeStatisticsTotalsProjection;
  readonly diagnostics: readonly (GcodeStatisticsDiagnosticArtifact & { readonly plateId: string })[];
  readonly conflictChecks: readonly (GcodeStatisticsConflictCheckArtifact & { readonly plateId: string })[];
  readonly conflicts: readonly (GcodeStatisticsConflictArtifact & { readonly plateId: string })[];
  readonly limitations: readonly (GcodeStatisticsLimitation & { readonly plateId: string })[];
  readonly accessibleLabel: string;
}

export type GcodeStatisticsErrorCode =
  | 'invalid-model'
  | 'invalid-artifact'
  | 'binding-mismatch'
  | 'inconsistent-statistics'
  | 'aggregation-cap'
  | 'incompatible-plates';

export class GcodeStatisticsError extends Error {
  readonly name = 'GcodeStatisticsError';

  constructor(
    readonly code: GcodeStatisticsErrorCode,
    message: string,
    issuanceToken?: symbol,
  ) {
    super(message);
    if (!(GCODE_STATISTICS_ERROR_CODES as readonly string[]).includes(code)) {
      throw new TypeError('Unknown G-code statistics error code');
    }
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    if (issuanceToken === ISSUE_GCODE_STATISTICS_ERROR) issuedGcodeStatisticsErrors.add(this);
  }
}

function statisticsError(code: GcodeStatisticsErrorCode, message: string): GcodeStatisticsError {
  return new GcodeStatisticsError(code, message, ISSUE_GCODE_STATISTICS_ERROR);
}

/** Hash and parse one exact output so observational rows cannot be mixed with another artifact. */
export async function createVerifiedRichGcodeStatisticsSource(
  gcode: string,
  expectedOutputHash: string,
  options: RichGcodeParseOptions = {},
): Promise<VerifiedRichGcodeStatisticsSource> {
  try {
    if (typeof gcode !== 'string') invalidModel();
    if (!isSha256(expectedOutputHash)) invalidArtifact('Expected G-code output hash must be a SHA-256 identity');
    const actualOutputHash = await sha256Utf8(gcode);
    if (actualOutputHash !== expectedOutputHash) {
      throw statisticsError('binding-mismatch', 'Exact parsed G-code bytes do not match the output identity');
    }
    const model = parseRichGcodeModel(gcode, options);
    validateModel(model);
    const coverage = classifyValidatedRichGcodeObservationCoverage(model);
    const source = Object.freeze({
      gcodeOutputHash: actualOutputHash,
      [VERIFIED_RICH_GCODE_SOURCE]: true as const,
    });
    verifiedRichGcodeStatisticsSources.set(
      source,
      freeze({
        gcodeOutputHash: actualOutputHash,
        layerCount: model.layerCount,
        observedEvents: observedEventCounts(model, coverage),
      }),
    );
    return source;
  } catch (error) {
    rethrowStatisticsError(error, 'invalid-model', 'G-code verification failed outside the bounded model domain');
  }
}

/** Project one plate's bound engine sidecar without estimating planner values from G-code. */
export function projectGcodeStatistics(
  source: VerifiedRichGcodeStatisticsSource,
  artifact: AuthoritativeGcodeStatisticsArtifact,
  expectedBinding: GcodeStatisticsBinding,
): GcodeStatisticsProjection {
  try {
    return projectGcodeStatisticsInternal(source, artifact, expectedBinding);
  } catch (error) {
    rethrowStatisticsError(
      error,
      'invalid-artifact',
      'Statistics projection failed outside the bounded artifact domain',
    );
  }
}

function projectGcodeStatisticsInternal(
  source: VerifiedRichGcodeStatisticsSource,
  artifact: AuthoritativeGcodeStatisticsArtifact,
  expectedBinding: GcodeStatisticsBinding,
): GcodeStatisticsProjection {
  const sourceSnapshot = isObject(source) ? verifiedRichGcodeStatisticsSources.get(source) : undefined;
  if (sourceSnapshot === undefined) invalidModel();
  validateBinding(expectedBinding, 'expected binding');
  validateArtifact(artifact, sourceSnapshot);
  artifact = snapshotStructuredValue(artifact, 'statistics artifact');
  expectedBinding = snapshotStructuredValue(expectedBinding, 'expected binding');
  if (!sameBinding(artifact.binding, expectedBinding)) {
    throw statisticsError(
      'binding-mismatch',
      'Statistics do not belong to the selected job/plate/source/profile/engine/G-code artifact',
    );
  }
  if (sourceSnapshot.gcodeOutputHash !== artifact.binding.gcodeOutputHash) {
    throw statisticsError(
      'binding-mismatch',
      'Rich G-code observations do not belong to the authoritative output artifact',
    );
  }

  const coverage = sourceSnapshot.observedEvents.coverage;
  const limitations = buildLimitations(artifact, coverage);
  const filaments = artifact.filaments.map((filament) => projectFilament(filament, artifact.costUnit));
  const filamentByTool = new Map(filaments.map((filament) => [filament.tool, filament]));
  const roleToolUsage = artifact.roleToolUsage.map((row) => {
    const filament = filamentByTool.get(row.tool)!;
    const usage = deriveMaterialUsage(row.volumeMm3, filament, artifact.costUnit);
    return freeze({
      ...row,
      profileId: filament.profileId,
      profileHash: filament.profileHash,
      usage,
      accessibleLabel: roleUsageLabel(row.role, row.tool, usage, artifact.costUnit),
    });
  });
  const timeModes = artifact.timeModes.map(projectTimeMode);
  const totals = projectTotals(filaments, timeModes, artifact.timeCostPerHour, artifact.costUnit);
  const observedEvents = sourceSnapshot.observedEvents;

  const projection: GcodeStatisticsProjection = freeze({
    [GCODE_STATISTICS_PROJECTION]: true as const,
    status: limitations.length === 0 ? 'ready' : 'partial',
    binding: { ...artifact.binding },
    layerCount: artifact.layerCount,
    processorFilamentChangeCount: artifact.processorFilamentChangeCount,
    plannedWipeTowerToolChangeCount: artifact.plannedWipeTowerToolChangeCount,
    costUnit: artifact.costUnit === null ? null : { ...artifact.costUnit },
    timeCostPerHour: artifact.timeCostPerHour,
    observedEvents,
    timeModes,
    filaments,
    roleToolUsage,
    totals,
    diagnostics: artifact.diagnostics.map((row) => ({ ...row, params: [...row.params] })),
    conflictCheck: {
      ...artifact.conflictCheck,
      suppressionReasons: [...artifact.conflictCheck.suppressionReasons],
    },
    conflicts: artifact.conflicts.map(copyConflict),
    limitations,
    accessibleLabel: plateLabel(artifact.binding.plateId, totals, timeModes, artifact.costUnit),
  });
  verifiedGcodeStatisticsProjections.add(projection);
  return projection;
}

/** Aggregate exact per-plate projections without inventing a global layer or event sequence. */
export function aggregateGcodeStatistics(
  plates: readonly GcodeStatisticsProjection[],
): AllPlateGcodeStatisticsProjection {
  try {
    return aggregateGcodeStatisticsInternal(plates);
  } catch (error) {
    rethrowStatisticsError(error, 'incompatible-plates', 'Statistics aggregation received malformed plate data');
  }
}

function aggregateGcodeStatisticsInternal(
  plates: readonly GcodeStatisticsProjection[],
): AllPlateGcodeStatisticsProjection {
  if (!runtimeArray(plates)) invalidPlateArray('Plate collection must be an array');
  plates = snapshotProjectionArray(plates);
  validateAggregateBindings(plates);
  const diagnosticCount = sumSafeIntegers(
    plates.map((plate) => plate.diagnostics.length),
    'diagnostic count',
  );
  const conflictCount = sumSafeIntegers(
    plates.map((plate) => plate.conflicts.length),
    'conflict count',
  );
  if (
    diagnosticCount > GCODE_STATISTICS_HARD_CAPS.diagnostics * GCODE_STATISTICS_HARD_CAPS.plates ||
    conflictCount > GCODE_STATISTICS_HARD_CAPS.conflicts * GCODE_STATISTICS_HARD_CAPS.plates
  ) {
    throw statisticsError('aggregation-cap', 'All-plate diagnostics exceed the bounded domain');
  }
  const costUnit = aggregateCostUnit(plates);
  const timeModes = aggregateTimeModes(plates);
  const filaments = aggregateFilaments(plates, costUnit);
  const roleToolUsage = aggregateRoleToolUsage(plates, costUnit);
  const totals = aggregateTotals(plates);
  const observedEvents = aggregateObservedEvents(plates);
  const diagnostics = plates.flatMap((plate) =>
    plate.diagnostics.map((row) => ({
      ...row,
      params: [...row.params],
      plateId: plate.binding.plateId,
    })),
  );
  const conflictChecks = plates.map((plate) => ({
    ...plate.conflictCheck,
    suppressionReasons: [...plate.conflictCheck.suppressionReasons],
    plateId: plate.binding.plateId,
  }));
  const conflicts = plates.flatMap((plate) =>
    plate.conflicts.map((row) => ({ ...copyConflict(row), plateId: plate.binding.plateId })),
  );
  const limitations: (GcodeStatisticsLimitation & { readonly plateId: string })[] = plates.flatMap((plate) =>
    plate.limitations.map((row) => ({ ...row, plateId: plate.binding.plateId })),
  );
  const silentPlateCount = plates.filter((plate) => plate.timeModes.some((mode) => mode.id === 'silent')).length;
  if (silentPlateCount > 0 && silentPlateCount < plates.length) {
    for (const plate of plates.filter((candidate) => !candidate.timeModes.some((mode) => mode.id === 'silent'))) {
      limitations.push({
        code: 'silent-mode-partial',
        path: 'timeModes.silent',
        message: 'Silent-mode planner time is unavailable for this plate, so no all-plate silent subtotal is shown.',
        plateId: plate.binding.plateId,
      });
    }
  }
  return freeze({
    status: plates.every((plate) => plate.status === 'ready') && limitations.length === 0 ? 'ready' : 'partial',
    plateCount: plates.length,
    bindings: plates.map((plate) => ({ ...plate.binding })),
    layerCount: sumSafeIntegers(
      plates.map((plate) => plate.layerCount),
      'layer count',
    ),
    processorFilamentChangeCount: sumSafeIntegers(
      plates.map((plate) => plate.processorFilamentChangeCount),
      'processor filament-change count',
    ),
    plannedWipeTowerToolChangeCount: sumOptionalSafeIntegers(
      plates.map((plate) => plate.plannedWipeTowerToolChangeCount),
      'planned wipe-tower tool-change count',
    ),
    costUnit,
    timeCostAssumptions: plates.map((plate) => ({
      plateId: plate.binding.plateId,
      costPerHour: plate.timeCostPerHour,
    })),
    observedEvents,
    timeModes,
    filaments,
    roleToolUsage,
    totals,
    diagnostics,
    conflictChecks,
    conflicts,
    limitations,
    accessibleLabel: allPlateLabel(plates.length, totals, timeModes, costUnit),
  });
}

export function classifyRichGcodeObservationCoverage(model: RichGcodeModel): GcodeObservedCoverage {
  try {
    validateModel(model);
    model = snapshotRichGcodeModel(model);
    return classifyValidatedRichGcodeObservationCoverage(model);
  } catch (error) {
    rethrowStatisticsError(error, 'invalid-model', 'Rich G-code coverage classification received malformed data');
  }
}

function classifyValidatedRichGcodeObservationCoverage(model: RichGcodeModel): GcodeObservedCoverage {
  const warningCodes = [...new Set(model.warnings.map((warning) => warning.code))];
  const exhaustive = model.complete && model.warnings.length === 0;
  return freeze({
    kind: !model.complete ? 'prefix' : model.warnings.length > 0 ? 'degraded' : 'complete',
    exhaustive,
    terminationReason: model.terminationReason ?? null,
    warningCodes,
  });
}

function validateModel(model: RichGcodeModel): void {
  if (!isObject(model) || !isObject(model.columns)) invalidModel();
  validateExactObjectKeys(
    model,
    [
      'columns',
      'pathPoints',
      'roles',
      'filaments',
      'layerCount',
      'warnings',
      'sourceLength',
      'parsedCharacters',
      'parsedLines',
      'complete',
      ...(Object.hasOwn(model, 'terminationReason') ? (['terminationReason'] as const) : []),
      'limits',
    ],
    'rich G-code model',
    invalidModel,
  );
  const columns = model.columns;
  validateExactObjectKeys(
    columns,
    [
      'count',
      'kind',
      'startX',
      'startY',
      'startZ',
      'endX',
      'endY',
      'endZ',
      'deltaE',
      'feedrateMmPerSecond',
      'widthMm',
      'heightMm',
      'mm3PerMm',
      'volumetricFlowMm3PerSecond',
      'fanPercent',
      'hotendTemperatureC',
      'layer',
      'role',
      'tool',
      'filament',
      'sourceLine',
      'sourceStartOffset',
      'sourceEndOffset',
      'commandLineNumber',
      'pathKind',
      'pathPointOffset',
      'pathPointCount',
      'arcCenterX',
      'arcCenterY',
    ],
    'rich G-code columns',
    invalidModel,
  );
  const count = columns.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > RICH_GCODE_HARD_CAPS.records) invalidModel();
  if (!hasExactTypedArrayLength(columns.kind, Uint8Array, count)) {
    invalidModel();
  }
  if (!hasExactTypedArrayLength(columns.pathKind, Uint8Array, count)) invalidModel();
  const floatColumnNames = [
    'startX',
    'startY',
    'startZ',
    'endX',
    'endY',
    'endZ',
    'deltaE',
    'feedrateMmPerSecond',
    'widthMm',
    'heightMm',
    'mm3PerMm',
    'volumetricFlowMm3PerSecond',
    'fanPercent',
    'hotendTemperatureC',
    'arcCenterX',
    'arcCenterY',
  ] as const;
  for (const name of floatColumnNames) {
    const column = columns[name];
    if (!hasExactTypedArrayLength(column, Float32Array, count)) {
      invalidModel();
    }
  }
  for (const name of [
    'layer',
    'sourceLine',
    'sourceStartOffset',
    'sourceEndOffset',
    'pathPointOffset',
    'pathPointCount',
  ] as const) {
    const column = columns[name];
    if (!hasExactTypedArrayLength(column, Uint32Array, count)) {
      invalidModel();
    }
  }
  for (const name of ['role', 'tool', 'filament'] as const) {
    const column = columns[name];
    if (!hasExactTypedArrayLength(column, Uint16Array, count)) {
      invalidModel();
    }
  }
  if (!hasExactTypedArrayLength(columns.commandLineNumber, Int32Array, count)) {
    invalidModel();
  }
  if (!isObject(model.pathPoints)) invalidModel();
  validateExactObjectKeys(model.pathPoints, ['count', 'x', 'y', 'z'], 'rich G-code path points', invalidModel);
  if (
    !Number.isSafeInteger(model.pathPoints.count) ||
    model.pathPoints.count < 0 ||
    model.pathPoints.count > RICH_GCODE_HARD_CAPS.pathPoints ||
    !hasExactTypedArrayLength(model.pathPoints.x, Float32Array, model.pathPoints.count) ||
    !hasExactTypedArrayLength(model.pathPoints.y, Float32Array, model.pathPoints.count) ||
    !hasExactTypedArrayLength(model.pathPoints.z, Float32Array, model.pathPoints.count)
  ) {
    invalidModel();
  }
  for (let index = 0; index < count; index += 1) {
    const kind = columns.kind[index]!;
    if (kind >= GCODE_RECORD_KIND_NAMES.length) invalidModel();
  }
  if (
    !Number.isSafeInteger(model.layerCount) ||
    model.layerCount < 0 ||
    model.layerCount > count ||
    !Number.isSafeInteger(model.sourceLength) ||
    model.sourceLength < 0 ||
    !Number.isSafeInteger(model.parsedCharacters) ||
    model.parsedCharacters < 0 ||
    model.parsedCharacters > model.sourceLength ||
    model.parsedCharacters > RICH_GCODE_HARD_CAPS.inputCharacters ||
    !Number.isSafeInteger(model.parsedLines) ||
    model.parsedLines < 0 ||
    model.parsedLines > RICH_GCODE_HARD_CAPS.lines ||
    typeof model.complete !== 'boolean' ||
    (model.complete && model.terminationReason !== undefined) ||
    (!model.complete &&
      !['input-cap', 'line-cap', 'record-cap', 'path-point-cap', 'numeric-cap'].includes(model.terminationReason ?? ''))
  ) {
    invalidModel();
  }
  validateDenseArray(model.roles, 'rich G-code roles', RICH_GCODE_HARD_CAPS.roles, 1, invalidModel);
  for (const role of model.roles) {
    if (typeof role !== 'string' || role.length > RICH_GCODE_HARD_CAPS.lineCharacters) invalidModel();
  }
  validateDenseArray(model.filaments, 'rich G-code filaments', RICH_GCODE_HARD_CAPS.filaments, 1, invalidModel);
  for (const [index, filament] of model.filaments.entries()) {
    if (!isObject(filament)) invalidModel();
    validateExactObjectKeys(
      filament,
      ['id', 'tool', 'source', ...(Object.hasOwn(filament, 'color') ? (['color'] as const) : [])],
      'rich G-code filament identity',
      invalidModel,
    );
    if (
      filament.id !== index ||
      !Number.isSafeInteger(filament.tool) ||
      filament.tool < 0 ||
      filament.tool >= GCODE_STATISTICS_HARD_CAPS.tools ||
      (filament.source !== 'tool' && filament.source !== 'color-change') ||
      (filament.color !== undefined &&
        (typeof filament.color !== 'string' || filament.color.length > GCODE_STATISTICS_HARD_CAPS.textCharacters))
    ) {
      invalidModel();
    }
  }
  if (!isObject(model.limits)) invalidModel();
  const limitKeys = [
    'inputCharacters',
    'lines',
    'records',
    'pathPoints',
    'warnings',
    'lineCharacters',
    'roles',
    'filaments',
  ] as const;
  validateExactObjectKeys(model.limits, limitKeys, 'rich G-code limits', invalidModel);
  for (const key of limitKeys) {
    const value = model.limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > RICH_GCODE_HARD_CAPS[key]) invalidModel();
  }
  if (
    count > model.limits.records ||
    model.pathPoints.count > model.limits.pathPoints ||
    model.parsedCharacters > model.limits.inputCharacters ||
    model.parsedLines > model.limits.lines ||
    model.roles.length > model.limits.roles ||
    model.filaments.length > model.limits.filaments ||
    (model.complete && model.parsedCharacters !== model.sourceLength)
  ) {
    invalidModel();
  }
  try {
    validateGcodePathSidecar(model);
  } catch {
    invalidModel();
  }
  validateDenseArray(model.warnings, 'rich G-code warnings', RICH_GCODE_HARD_CAPS.warnings, 0, invalidModel);
  if (model.warnings.length > model.limits.warnings) invalidModel();
  for (const warning of model.warnings) {
    if (
      !isObject(warning) ||
      (warning.severity !== 'warning' && warning.severity !== 'error') ||
      typeof warning.code !== 'string' ||
      warning.code.length < 1 ||
      warning.code.length > GCODE_STATISTICS_HARD_CAPS.textCharacters ||
      typeof warning.message !== 'string' ||
      warning.message.length > RICH_GCODE_HARD_CAPS.lineCharacters + GCODE_STATISTICS_HARD_CAPS.textCharacters ||
      !Number.isSafeInteger(warning.line) ||
      warning.line < 0 ||
      warning.line > model.parsedLines + 1 ||
      !Number.isSafeInteger(warning.startOffset) ||
      warning.startOffset < 0 ||
      !Number.isSafeInteger(warning.endOffset) ||
      warning.endOffset < warning.startOffset ||
      warning.endOffset > model.sourceLength
    ) {
      invalidModel();
    }
    validateExactObjectKeys(
      warning,
      ['severity', 'code', 'message', 'line', 'startOffset', 'endOffset'],
      'rich G-code warning',
      invalidModel,
    );
  }
}

function validateArtifact(
  artifact: AuthoritativeGcodeStatisticsArtifact,
  source: VerifiedRichGcodeStatisticsSnapshot,
): void {
  if (
    !isObject(artifact) ||
    artifact.schema !== GCODE_STATISTICS_SCHEMA ||
    artifact.version !== GCODE_STATISTICS_VERSION
  ) {
    invalidArtifact('Statistics schema/version is stale or unknown');
  }
  validateExactObjectKeys(
    artifact,
    [
      'schema',
      'version',
      'binding',
      'layerCount',
      'processorFilamentChangeCount',
      'plannedWipeTowerToolChangeCount',
      'costUnit',
      'timeCostPerHour',
      'timeModes',
      'filaments',
      'roleToolUsage',
      'diagnostics',
      'conflictCheck',
      'conflicts',
      'omissions',
    ],
    'statistics artifact',
  );
  validateBinding(artifact.binding, 'artifact binding');
  nonNegativeInteger(artifact.layerCount, 'layerCount');
  nonNegativeInteger(
    artifact.processorFilamentChangeCount,
    'processorFilamentChangeCount',
    RICH_GCODE_HARD_CAPS.records,
  );
  optionalNonNegativeInteger(
    artifact.plannedWipeTowerToolChangeCount,
    'plannedWipeTowerToolChangeCount',
    RICH_GCODE_HARD_CAPS.records,
  );
  if (artifact.layerCount > GCODE_STATISTICS_HARD_CAPS.layers) invalidArtifact('Layer count exceeds the hard domain');
  validateCostUnit(artifact.costUnit);
  optionalNonNegative(artifact.timeCostPerHour, 'timeCostPerHour', GCODE_STATISTICS_HARD_CAPS.timeCostPerHour);
  if (artifact.costUnit === null && artifact.timeCostPerHour !== null) {
    invalidArtifact('Hourly machine cost has no canonical unit');
  }
  validateTimeModes(artifact.timeModes, artifact.layerCount);
  validateFilaments(artifact.filaments, artifact.costUnit);
  validateRoleToolUsage(artifact.roleToolUsage, artifact.filaments);
  validateDiagnostics(artifact.diagnostics);
  validateConflicts(artifact.conflicts, artifact.layerCount);
  validateConflictCheck(artifact.conflictCheck, artifact.conflicts.length);
  validateOmissions(artifact);

  if (source.observedEvents.coverage.exhaustive && artifact.layerCount !== source.layerCount) {
    throw statisticsError(
      'inconsistent-statistics',
      `Engine statistics report ${artifact.layerCount} layers but warning-free rich G-code reports ${source.layerCount}`,
    );
  }
}

function validateBinding(binding: GcodeStatisticsBinding, label: string): void {
  if (!isObject(binding)) invalidArtifact(`${label} is missing`);
  validateExactObjectKeys(
    binding,
    [
      'jobId',
      'plateId',
      'sourceRevision',
      'sourceHash',
      'sourceAssetHash',
      'projectInputHash',
      'gcodeOutputHash',
      'effectiveConfigHash',
      'engineCommit',
      'engineArtifactHash',
    ],
    label,
  );
  boundedText(binding.jobId, `${label}.jobId`);
  boundedText(binding.plateId, `${label}.plateId`);
  nonNegativeInteger(binding.sourceRevision, `${label}.sourceRevision`);
  boundedText(binding.engineCommit, `${label}.engineCommit`);
  for (const key of ['sourceHash', 'sourceAssetHash'] as const) {
    if (!isFnv1a64(binding[key])) invalidArtifact(`${label}.${key} must be a canonical FNV-1a identity`);
  }
  for (const key of ['projectInputHash', 'gcodeOutputHash', 'effectiveConfigHash', 'engineArtifactHash'] as const) {
    if (!isSha256(binding[key])) invalidArtifact(`${label}.${key} must be a SHA-256 identity`);
  }
  if (!/^[0-9a-f]{40}$/.test(binding.engineCommit)) invalidArtifact(`${label}.engineCommit must be a full Git commit`);
}

function validateCostUnit(unit: GcodeStatisticsCostUnit | null): void {
  if (unit === null) return;
  if (!isObject(unit)) invalidArtifact('costUnit must be null or a canonical unit');
  validateExactObjectKeys(unit, ['id', 'label'], 'costUnit');
  boundedText(unit.id, 'costUnit.id');
  boundedText(unit.label, 'costUnit.label');
}

function validateTimeModes(modes: readonly GcodeTimeModeArtifact[], layerCount: number): void {
  validateDenseArray(modes, 'timeModes', 2, 1);
  const ids = new Set<GcodeStatisticsTimeModeId>();
  for (const mode of modes) {
    if (!isObject(mode) || (mode.id !== 'normal' && mode.id !== 'silent') || ids.has(mode.id)) {
      invalidArtifact('Time mode IDs are invalid or duplicated');
    }
    validateExactObjectKeys(
      mode,
      [
        'id',
        'plannerBlockCount',
        'totalSeconds',
        'prepareSeconds',
        'layerSeconds',
        'moveSeconds',
        'roleSeconds',
        'customGcodeSeconds',
      ],
      `${mode.id} time mode`,
    );
    ids.add(mode.id);
    nonNegativeInteger(
      mode.plannerBlockCount,
      `${mode.id}.plannerBlockCount`,
      GCODE_STATISTICS_HARD_CAPS.plannerBlocks,
    );
    plannerNonNegative(mode.totalSeconds, `${mode.id}.totalSeconds`);
    plannerNonNegative(mode.prepareSeconds, `${mode.id}.prepareSeconds`);
    if (mode.totalSeconds > 0 && mode.plannerBlockCount === 0) {
      invalidArtifact(`${mode.id} positive planner time requires processed blocks`);
    }
    if (mode.prepareSeconds > mode.totalSeconds) invalidArtifact(`${mode.id} prepare time exceeds total time`);
    validateDenseArray(mode.layerSeconds, `${mode.id}.layerSeconds`, layerCount, layerCount);
    mode.layerSeconds.forEach((value: number, index: number) =>
      plannerNonNegative(value, `${mode.id}.layerSeconds[${index}]`),
    );
    validatePlannerPartition(
      mode.layerSeconds,
      mode.totalSeconds,
      mode.plannerBlockCount,
      `${mode.id} layer durations`,
    );
    validateTimeRows(
      mode.moveSeconds,
      GCODE_STATISTICS_HARD_CAPS.moveKinds,
      mode.plannerBlockCount,
      `${mode.id}.moveSeconds`,
    );
    validatePlannerSubset(
      mode.moveSeconds.map((row) => row.seconds),
      mode.totalSeconds,
      mode.plannerBlockCount,
      `${mode.id} move durations`,
    );
    validateTimeRows(
      mode.roleSeconds,
      GCODE_STATISTICS_HARD_CAPS.roles,
      mode.plannerBlockCount,
      `${mode.id}.roleSeconds`,
    );
    validatePlannerPartition(
      mode.roleSeconds.map((row) => row.seconds),
      mode.totalSeconds,
      mode.plannerBlockCount,
      `${mode.id} role durations`,
    );
    validateDenseArray(
      mode.customGcodeSeconds,
      `${mode.id}.customGcodeSeconds`,
      Math.min(GCODE_STATISTICS_HARD_CAPS.customEvents, mode.plannerBlockCount),
    );
    let cumulativeDuration = 0;
    for (const [index, row] of mode.customGcodeSeconds.entries()) {
      if (!isObject(row)) invalidArtifact(`${mode.id} custom G-code row is malformed`);
      validateExactObjectKeys(
        row,
        ['kind', 'durationSeconds', 'remainingSeconds'],
        `${mode.id} custom G-code segment ${index}`,
      );
      if (!['color-change', 'pause', 'tool-change', 'template', 'custom', 'unknown'].includes(row.kind)) {
        invalidArtifact(`${mode.id} custom G-code kind is invalid`);
      }
      plannerPositive(row.durationSeconds, `${mode.id}.customGcodeSeconds[${index}].durationSeconds`);
      plannerFinite(row.remainingSeconds, `${mode.id}.customGcodeSeconds[${index}].remainingSeconds`);
      const expectedRemaining = Math.fround(mode.totalSeconds - cumulativeDuration);
      if (!plannerFloatEqual(row.remainingSeconds, expectedRemaining)) {
        throw statisticsError(
          'inconsistent-statistics',
          `${mode.id} custom segment ${index} has inconsistent remaining planner time`,
        );
      }
      cumulativeDuration = Math.fround(cumulativeDuration + row.durationSeconds);
    }
    if (mode.customGcodeSeconds.length > 0) {
      validatePlannerPartition(
        mode.customGcodeSeconds.map((row) => row.durationSeconds),
        mode.totalSeconds,
        mode.plannerBlockCount,
        `${mode.id} custom segment durations`,
      );
    }
  }
  if (!ids.has('normal')) invalidArtifact('Normal time mode is required');
  if (modes[0]?.id !== 'normal' || modes[1]?.id === 'normal') {
    invalidArtifact('Time modes must use canonical normal-then-silent order');
  }
  const normal = modes.find((mode) => mode.id === 'normal')!;
  const silent = modes.find((mode) => mode.id === 'silent');
  if (silent !== undefined && silent.plannerBlockCount !== normal.plannerBlockCount) {
    throw statisticsError(
      'inconsistent-statistics',
      'Normal and silent planner modes disagree on processed block count',
    );
  }
  if (
    silent !== undefined &&
    (silent.customGcodeSeconds.length !== normal.customGcodeSeconds.length ||
      silent.customGcodeSeconds.some((row, index) => row.kind !== normal.customGcodeSeconds[index]?.kind))
  ) {
    throw statisticsError(
      'inconsistent-statistics',
      'Normal and silent planner modes disagree on ordered custom segment identity',
    );
  }
}

function validateTimeRows(
  rows: readonly GcodeTimeBreakdownRow[],
  maximumId: number,
  plannerBlockCount: number,
  label: string,
): void {
  validateDenseArray(rows, label, Math.min(maximumId, plannerBlockCount));
  const ids = new Set<number>();
  for (const row of rows) {
    if (!isObject(row) || !Number.isSafeInteger(row.id) || row.id < 0 || row.id >= maximumId || ids.has(row.id)) {
      invalidArtifact(`${label} IDs are invalid or duplicated`);
    }
    validateExactObjectKeys(row, ['id', 'seconds'], `${label} row`);
    ids.add(row.id);
    plannerPositive(row.seconds, `${label}[${row.id}]`);
  }
}

function validateFilaments(
  filaments: readonly GcodeFilamentStatisticsArtifact[],
  costUnit: GcodeStatisticsCostUnit | null,
): void {
  validateDenseArray(filaments, 'filaments', GCODE_STATISTICS_HARD_CAPS.tools);
  const tools = new Set<number>();
  for (const filament of filaments) {
    if (
      !isObject(filament) ||
      !Number.isSafeInteger(filament.tool) ||
      filament.tool < 0 ||
      filament.tool >= GCODE_STATISTICS_HARD_CAPS.tools ||
      tools.has(filament.tool)
    ) {
      invalidArtifact('Filament tool IDs are invalid or duplicated');
    }
    validateExactObjectKeys(
      filament,
      [
        'tool',
        'profileId',
        'profileHash',
        'diameterMm',
        'densityGPerCm3',
        'costPerKg',
        'volumeSampleCount',
        'modelVolumeMm3',
        'supportVolumeMm3',
        'wipeTowerVolumeMm3',
        'flushedVolumeMm3',
        'totalVolumeMm3',
      ],
      `tool ${filament.tool} filament statistics`,
    );
    tools.add(filament.tool);
    boundedText(filament.profileId, `tool ${filament.tool} profileId`);
    if (!isSha256(filament.profileHash))
      invalidArtifact(`Tool ${filament.tool} profileHash must be a SHA-256 identity`);
    optionalPositive(
      filament.diameterMm,
      `tool ${filament.tool} diameter`,
      GCODE_STATISTICS_HARD_CAPS.minimumDiameterMm,
      GCODE_STATISTICS_HARD_CAPS.diameterMm,
    );
    optionalPositive(
      filament.densityGPerCm3,
      `tool ${filament.tool} density`,
      0,
      GCODE_STATISTICS_HARD_CAPS.densityGPerCm3,
    );
    optionalNonNegative(filament.costPerKg, `tool ${filament.tool} cost`, GCODE_STATISTICS_HARD_CAPS.costPerKg);
    if (costUnit === null && filament.costPerKg !== null) {
      invalidArtifact(`Tool ${filament.tool} cost has no canonical unit`);
    }
    nonNegativeInteger(
      filament.volumeSampleCount,
      `tool ${filament.tool} volumeSampleCount`,
      GCODE_STATISTICS_HARD_CAPS.materialSamples,
    );
    for (const key of [
      'modelVolumeMm3',
      'supportVolumeMm3',
      'wipeTowerVolumeMm3',
      'flushedVolumeMm3',
      'totalVolumeMm3',
    ] as const) {
      nonNegative(filament[key], `tool ${filament.tool} ${key}`, GCODE_STATISTICS_HARD_CAPS.volumeMm3);
    }
    const categoryVolumes = [
      filament.modelVolumeMm3,
      filament.supportVolumeMm3,
      filament.wipeTowerVolumeMm3,
      filament.flushedVolumeMm3,
    ];
    if (
      filament.totalVolumeMm3 > 0 !== filament.volumeSampleCount > 0 ||
      categoryVolumes.filter((volume) => volume > 0).length > filament.volumeSampleCount
    ) {
      invalidArtifact(`Tool ${filament.tool} material sample count is inconsistent with its volume caches`);
    }
    validateDoublePartition(
      categoryVolumes,
      filament.totalVolumeMm3,
      filament.volumeSampleCount,
      `tool ${filament.tool} category volumes`,
    );
  }
}

function validateRoleToolUsage(
  rows: readonly GcodeRoleToolUsageArtifact[],
  filaments: readonly GcodeFilamentStatisticsArtifact[],
): void {
  validateDenseArray(rows, 'roleToolUsage', GCODE_STATISTICS_HARD_CAPS.roles * GCODE_STATISTICS_HARD_CAPS.tools);
  const tools = new Set(filaments.map((filament) => filament.tool));
  const identities = new Set<string>();
  for (const row of rows) {
    if (
      !isObject(row) ||
      !Number.isSafeInteger(row.role) ||
      row.role < 0 ||
      row.role >= GCODE_STATISTICS_HARD_CAPS.roles ||
      !Number.isSafeInteger(row.tool) ||
      !tools.has(row.tool)
    ) {
      invalidArtifact('Role/tool usage identity is outside the artifact domain');
    }
    validateExactObjectKeys(row, ['role', 'tool', 'volumeMm3'], 'role/tool usage row');
    const identity = `${row.role}:${row.tool}`;
    if (identities.has(identity)) invalidArtifact('Role/tool usage identity is duplicated');
    identities.add(identity);
    nonNegative(row.volumeMm3, `role ${row.role}, tool ${row.tool} volume`, GCODE_STATISTICS_HARD_CAPS.volumeMm3);
    if (row.volumeMm3 === 0) invalidArtifact('Role/tool usage rows are sparse and must have positive volume');
  }
  for (const filament of filaments) {
    const roleVolumes = rows.filter((row) => row.tool === filament.tool).map((row) => row.volumeMm3);
    if (roleVolumes.length > filament.volumeSampleCount) {
      invalidArtifact(`Tool ${filament.tool} has more populated role caches than material samples`);
    }
    const classifiedPathVolume = finiteSum(
      [filament.modelVolumeMm3, filament.supportVolumeMm3, filament.wipeTowerVolumeMm3],
      `tool ${filament.tool} non-flush path volume`,
    );
    validateDoublePartition(
      roleVolumes,
      classifiedPathVolume,
      filament.volumeSampleCount,
      `tool ${filament.tool} role volumes`,
    );
  }
}

function validateDiagnostics(rows: readonly GcodeStatisticsDiagnosticArtifact[]): void {
  validateDenseArray(rows, 'diagnostics', GCODE_STATISTICS_HARD_CAPS.diagnostics);
  for (const row of rows) {
    if (
      !isObject(row) ||
      !['engine', 'export', 'preflight', 'conflict-check'].includes(row.source) ||
      !['info', 'warning', 'error'].includes(row.severity)
    ) {
      invalidArtifact('Diagnostic source or severity is invalid');
    }
    validateExactObjectKeys(row, ['source', 'severity', 'code', 'message', 'params'], 'diagnostic row');
    boundedText(row.code, 'diagnostic code');
    boundedText(row.message, 'diagnostic message');
    validateDenseArray(row.params, 'diagnostic params', 32);
    row.params.forEach((value: string) => boundedText(value, 'diagnostic param'));
  }
}

function validateConflictCheck(check: GcodeStatisticsConflictCheckArtifact, conflictCount: number): void {
  if (!isObject(check) || !['checked-none-found', 'detected', 'not-run', 'unsupported'].includes(check.outcome)) {
    invalidArtifact('Conflict-check outcome is invalid');
  }
  validateExactObjectKeys(check, ['outcome', 'exhaustive', 'reason', 'suppressionReasons'], 'conflictCheck');
  if (typeof check.exhaustive !== 'boolean') invalidArtifact('Conflict-check exhaustiveness is invalid');
  if (check.reason !== null) boundedText(check.reason, 'conflict-check reason');
  validateDenseArray(check.suppressionReasons, 'conflict-check suppression reasons', 32);
  check.suppressionReasons.forEach((reason) => boundedText(reason, 'conflict-check suppression reason'));
  if (check.outcome === 'detected' && conflictCount < 1)
    invalidArtifact('Detected conflict outcome requires a finding');
  if (check.outcome !== 'detected' && conflictCount !== 0)
    invalidArtifact('Only a detected outcome may carry findings');
  if (check.outcome === 'checked-none-found' && !check.exhaustive) {
    invalidArtifact('A clear conflict result must be exhaustive');
  }
  if (check.outcome === 'checked-none-found' && check.suppressionReasons.length > 0) {
    invalidArtifact('An exhaustive clear conflict result cannot carry suppression reasons');
  }
  if (check.outcome === 'checked-none-found' && check.reason !== null) {
    invalidArtifact('An exhaustive clear conflict result cannot carry an availability reason');
  }
  if ((check.outcome === 'not-run' || check.outcome === 'unsupported') && (check.exhaustive || check.reason === null)) {
    invalidArtifact('Unavailable conflict checks require a non-exhaustive reason');
  }
  if (check.outcome === 'detected' && !check.exhaustive && check.reason === null) {
    invalidArtifact('Non-exhaustive detected conflicts require a coverage reason');
  }
  if (check.outcome === 'detected' && check.exhaustive) {
    invalidArtifact('The pinned detected-conflict result is never exhaustive');
  }
}

function validateConflicts(rows: readonly GcodeStatisticsConflictArtifact[], layerCount: number): void {
  validateDenseArray(rows, 'conflicts', GCODE_STATISTICS_HARD_CAPS.conflicts);
  for (const row of rows) {
    if (!isObject(row)) invalidArtifact('Conflict row is malformed');
    validateExactObjectKeys(row, ['code', 'message', 'subjects', 'layerUpperBoundOrdinal', 'zMm'], 'conflict row');
    boundedText(row.code, 'conflict code');
    boundedText(row.message, 'conflict message');
    validateDenseArray(row.subjects, 'conflict subjects', 2, 2);
    row.subjects.forEach(validateConflictSubject);
    if (sameConflictSubject(row.subjects[0], row.subjects[1])) {
      invalidArtifact('A conflict must identify two distinct canonical subjects');
    }
    if (
      row.layerUpperBoundOrdinal !== null &&
      (!Number.isSafeInteger(row.layerUpperBoundOrdinal) ||
        row.layerUpperBoundOrdinal < 0 ||
        row.layerUpperBoundOrdinal > layerCount)
    ) {
      invalidArtifact('Conflict layer ordinal is outside the artifact domain');
    }
    if (row.zMm !== null) nonNegative(row.zMm, 'conflict Z', GCODE_STATISTICS_HARD_CAPS.zMm);
  }
}

function validateConflictSubject(subject: GcodeStatisticsConflictSubjectArtifact): void {
  if (!isObject(subject) || (subject.kind !== 'object' && subject.kind !== 'wipe-tower')) {
    invalidArtifact('Conflict subject is malformed');
  }
  validateExactObjectKeys(
    subject,
    subject.kind === 'object' ? ['kind', 'objectId', 'name'] : ['kind', 'name'],
    'conflict subject',
  );
  boundedText(subject.name, 'conflict subject name');
  if (subject.kind === 'object') boundedText(subject.objectId, 'conflict object ID');
}

function validateOmissions(artifact: AuthoritativeGcodeStatisticsArtifact): void {
  validateDenseArray(artifact.omissions, 'omissions', GCODE_STATISTICS_HARD_CAPS.omissions);
  const allowed = new Set<string>();
  const required = new Set<string>();
  nullableLeaf('costUnit', artifact.costUnit, allowed, required, true);
  nullableLeaf('timeCostPerHour', artifact.timeCostPerHour, allowed, required, true);
  nullableLeaf('plannedWipeTowerToolChangeCount', artifact.plannedWipeTowerToolChangeCount, allowed, required, true);
  for (const filament of artifact.filaments) {
    const materialUsed = filament.totalVolumeMm3 > 0;
    nullableLeaf(`filaments[${filament.tool}].diameterMm`, filament.diameterMm, allowed, required, materialUsed);
    nullableLeaf(
      `filaments[${filament.tool}].densityGPerCm3`,
      filament.densityGPerCm3,
      allowed,
      required,
      materialUsed,
    );
    nullableLeaf(`filaments[${filament.tool}].costPerKg`, filament.costPerKg, allowed, required, materialUsed);
  }

  const paths = new Set<string>();
  for (const row of artifact.omissions) {
    if (!isObject(row)) invalidArtifact('Omission row is malformed');
    validateExactObjectKeys(row, ['path', 'reason'], 'omission row');
    boundedText(row.path, 'omission path');
    boundedText(row.reason, 'omission reason');
    if (!allowed.has(row.path)) invalidArtifact(`Unknown or non-null omission path ${row.path}`);
    if (paths.has(row.path)) invalidArtifact(`Duplicate omission path ${row.path}`);
    paths.add(row.path);
  }
  for (const path of required) {
    if (!paths.has(path)) invalidArtifact(`Missing omission reason for ${path}`);
  }
}

function nullableLeaf(
  path: string,
  value: unknown,
  allowed: Set<string>,
  required: Set<string>,
  requireReason: boolean,
): void {
  if (value !== null) return;
  allowed.add(path);
  if (requireReason) required.add(path);
}

function buildLimitations(
  artifact: AuthoritativeGcodeStatisticsArtifact,
  coverage: GcodeObservedCoverage,
): GcodeStatisticsLimitation[] {
  const zeroVolumeMetadata = new Set(
    artifact.filaments
      .filter((filament) => filament.totalVolumeMm3 === 0)
      .flatMap((filament) => [
        `filaments[${filament.tool}].diameterMm`,
        `filaments[${filament.tool}].densityGPerCm3`,
        `filaments[${filament.tool}].costPerKg`,
      ]),
  );
  const limitations: GcodeStatisticsLimitation[] = artifact.omissions
    .filter((omission) => !zeroVolumeMetadata.has(omission.path))
    .map((omission) => ({
      code: 'authoritative-omission',
      path: omission.path,
      message: omission.reason,
    }));
  if (coverage.kind === 'prefix') {
    limitations.push({
      code: 'source-prefix',
      path: 'gcode',
      message: `Observed G-code marker counts cover only a parsed prefix (${coverage.terminationReason ?? 'unknown termination'}); bound engine statistics remain authoritative.`,
    });
  } else if (coverage.kind === 'degraded') {
    const shownCodes = coverage.warningCodes.slice(0, 16);
    const suppressedCodeCount = coverage.warningCodes.length - shownCodes.length;
    limitations.push({
      code: 'source-degraded',
      path: 'gcode',
      message: `Observed G-code marker counts may contain skipped or substituted input (${shownCodes.join(', ')}${suppressedCodeCount > 0 ? `, plus ${suppressedCodeCount} more codes` : ''}); bound engine statistics remain authoritative.`,
    });
  }
  if (artifact.conflictCheck.outcome === 'not-run' || artifact.conflictCheck.outcome === 'unsupported') {
    limitations.push({
      code: 'conflict-check-unavailable',
      path: 'conflictCheck',
      message: artifact.conflictCheck.reason!,
    });
  } else if (!artifact.conflictCheck.exhaustive) {
    limitations.push({
      code: 'conflict-check-non-exhaustive',
      path: 'conflictCheck.exhaustive',
      message: artifact.conflictCheck.reason!,
    });
  }
  return limitations;
}

function projectFilament(
  filament: GcodeFilamentStatisticsArtifact,
  costUnit: GcodeStatisticsCostUnit | null,
): GcodeFilamentStatisticsProjection {
  const usage = freeze({
    model: deriveMaterialUsage(filament.modelVolumeMm3, filament, costUnit),
    support: deriveMaterialUsage(filament.supportVolumeMm3, filament, costUnit),
    wipeTower: deriveMaterialUsage(filament.wipeTowerVolumeMm3, filament, costUnit),
    flushed: deriveMaterialUsage(filament.flushedVolumeMm3, filament, costUnit),
    total: deriveMaterialUsage(filament.totalVolumeMm3, filament, costUnit),
  });
  return freeze({ ...filament, usage, accessibleLabel: filamentLabel(filament, usage.total, costUnit) });
}

function deriveMaterialUsage(
  volumeMm3: number,
  filament: Pick<GcodeFilamentStatisticsArtifact, 'diameterMm' | 'densityGPerCm3' | 'costPerKg'>,
  costUnit: GcodeStatisticsCostUnit | null,
): GcodeMaterialUsageProjection {
  const rawFilamentLengthMm =
    volumeMm3 === 0
      ? 0
      : filament.diameterMm === null
        ? null
        : volumeMm3 / (Math.PI * (filament.diameterMm * 0.5) ** 2);
  const filamentLengthMm =
    rawFilamentLengthMm === null ? null : finiteProjectionNumber(rawFilamentLengthMm, 'filament length');
  const rawFilamentWeightG =
    volumeMm3 === 0 ? 0 : filament.densityGPerCm3 === null ? null : volumeMm3 * filament.densityGPerCm3 * 0.001;
  const filamentWeightG =
    rawFilamentWeightG === null ? null : finiteProjectionNumber(rawFilamentWeightG, 'filament weight');
  const rawCost =
    costUnit === null
      ? null
      : volumeMm3 === 0
        ? 0
        : filamentWeightG === null || filament.costPerKg === null
          ? null
          : filamentWeightG * filament.costPerKg * 0.001;
  const cost = rawCost === null ? null : finiteProjectionNumber(rawCost, 'material cost');
  return freeze({ volumeMm3, filamentLengthMm, filamentWeightG, cost });
}

function projectTimeMode(mode: GcodeTimeModeArtifact): GcodeTimeModeProjection {
  const modelSeconds = Math.fround(mode.totalSeconds - mode.prepareSeconds);
  return freeze({
    ...mode,
    layerSeconds: [...mode.layerSeconds],
    moveSeconds: mode.moveSeconds.map((row) => ({ ...row })),
    roleSeconds: mode.roleSeconds.map((row) => ({ ...row })),
    customGcodeSeconds: mode.customGcodeSeconds.map((row) => ({ ...row })),
    modelSeconds,
    accessibleLabel: timeModeLabel(mode.id, mode.totalSeconds, mode.prepareSeconds, modelSeconds),
  });
}

function projectTotals(
  filaments: readonly GcodeFilamentStatisticsProjection[],
  modes: readonly GcodeTimeModeProjection[],
  timeCostPerHour: number | null,
  costUnit: GcodeStatisticsCostUnit | null,
): GcodeStatisticsTotalsProjection {
  const categories = sumMaterialCategories(filaments.map((filament) => filament.usage));
  const normal = modes.find((mode) => mode.id === 'normal')!;
  const rawTimeCost =
    timeCostPerHour === null || costUnit === null ? null : (normal.totalSeconds / 3_600) * timeCostPerHour;
  const timeCost = rawTimeCost === null ? null : finiteProjectionNumber(rawTimeCost, 'time cost');
  const totalCost =
    categories.total.cost === null || timeCost === null
      ? null
      : finiteProjectionNumber(categories.total.cost + timeCost, 'total cost');
  return freeze({ ...categories, timeCost, totalCost });
}

function observedEventCounts(model: RichGcodeModel, coverage: GcodeObservedCoverage): GcodeObservedEventCounts {
  let toolChangeMarkers = 0;
  let colorChanges = 0;
  let pauses = 0;
  let customGcode = 0;
  for (let index = 0; index < model.columns.count; index += 1) {
    const kind = model.columns.kind[index]!;
    if (kind === GCODE_RECORD_KIND.TOOL_CHANGE) toolChangeMarkers += 1;
    else if (kind === GCODE_RECORD_KIND.COLOR_CHANGE) colorChanges += 1;
    else if (kind === GCODE_RECORD_KIND.PAUSE) pauses += 1;
    else if (kind === GCODE_RECORD_KIND.CUSTOM) customGcode += 1;
  }
  return freeze({ coverage, toolChangeMarkers, colorChanges, pauses, customGcode });
}

function validateAggregateBindings(plates: readonly GcodeStatisticsProjection[]): void {
  const plateIds = new Set<string>();
  const first = plates[0];
  if (!isObject(first) || !verifiedGcodeStatisticsProjections.has(first)) {
    throw statisticsError('incompatible-plates', 'Plate projection is unverified or malformed');
  }
  validateBinding(first.binding, 'plate binding');
  for (const plate of plates) {
    if (!isObject(plate) || !verifiedGcodeStatisticsProjections.has(plate)) {
      throw statisticsError('incompatible-plates', 'Plate projection is unverified or malformed');
    }
    validateBinding(plate.binding, 'plate binding');
    if (plateIds.has(plate.binding.plateId)) {
      throw statisticsError('incompatible-plates', 'All-plate statistics contain a duplicate plate identity');
    }
    plateIds.add(plate.binding.plateId);
    for (const key of [
      'jobId',
      'sourceRevision',
      'sourceHash',
      'sourceAssetHash',
      'engineCommit',
      'engineArtifactHash',
    ] as const) {
      if (plate.binding[key] !== first.binding[key]) {
        throw statisticsError('incompatible-plates', `All-plate statistics cross incompatible ${key} snapshots`);
      }
    }
  }
}

function aggregateCostUnit(plates: readonly GcodeStatisticsProjection[]): GcodeStatisticsCostUnit | null {
  const present = plates.flatMap((plate) => (plate.costUnit === null ? [] : [plate.costUnit]));
  const ids = new Set(present.map((unit) => unit.id));
  if (ids.size > 1) throw statisticsError('incompatible-plates', 'All-plate costs use incompatible units');
  if (present.some((unit) => unit.label !== present[0]?.label)) {
    throw statisticsError('incompatible-plates', 'All-plate cost unit labels disagree');
  }
  return present.length > 0 ? freeze({ ...present[0] }) : null;
}

function aggregateTimeModes(
  plates: readonly GcodeStatisticsProjection[],
): readonly AggregatedGcodeTimeModeProjection[] {
  const ids: GcodeStatisticsTimeModeId[] = ['normal'];
  if (plates.every((plate) => plate.timeModes.some((mode) => mode.id === 'silent'))) ids.push('silent');
  return ids.map((id) => {
    const rows = plates.map((plate) => ({
      plateId: plate.binding.plateId,
      mode: plate.timeModes.find((mode) => mode.id === id)!,
    }));
    const totalSeconds = sumFinite(
      rows.map((row) => row.mode.totalSeconds),
      'mode total seconds',
    );
    const prepareSeconds = sumFinite(
      rows.map((row) => row.mode.prepareSeconds),
      'mode prepare seconds',
    );
    const modelSeconds = sumFinite(
      rows.map((row) => row.mode.modelSeconds),
      'mode model seconds',
    );
    const plannerBlockCount = sumSafeIntegers(
      rows.map((row) => row.mode.plannerBlockCount),
      `${id} planner block count`,
    );
    const customEventCount = sumSafeIntegers(
      rows.map((row) => row.mode.customGcodeSeconds.length),
      `${id} custom G-code event count`,
    );
    if (customEventCount > GCODE_STATISTICS_HARD_CAPS.customEvents) {
      throw statisticsError('aggregation-cap', 'All-plate custom G-code events exceed the bounded domain');
    }
    const customGcodeSeconds = rows.flatMap((row) =>
      row.mode.customGcodeSeconds.map((event) => ({ ...event, plateId: row.plateId })),
    );
    return freeze({
      id,
      plannerBlockCount,
      totalSeconds,
      prepareSeconds,
      modelSeconds,
      moveSeconds: mergeTimeRows(rows.map((row) => row.mode.moveSeconds)),
      roleSeconds: mergeTimeRows(rows.map((row) => row.mode.roleSeconds)),
      customGcodeSeconds,
      accessibleLabel: timeModeLabel(id, totalSeconds, prepareSeconds, modelSeconds),
    });
  });
}

function aggregateFilaments(
  plates: readonly GcodeStatisticsProjection[],
  costUnit: GcodeStatisticsCostUnit | null,
): readonly AggregatedGcodeFilamentStatisticsProjection[] {
  const groups = new Map<string, AggregatedGcodeFilamentStatisticsProjection>();
  for (const plate of plates) {
    for (const filament of plate.filaments) {
      const source = { plateId: plate.binding.plateId, tool: filament.tool };
      const identity = `${filament.tool}:${filament.profileHash}`;
      const prior = groups.get(identity);
      if (!prior) {
        groups.set(
          identity,
          freeze({
            tool: filament.tool,
            profileId: filament.profileId,
            profileHash: filament.profileHash,
            diameterMm: filament.diameterMm,
            densityGPerCm3: filament.densityGPerCm3,
            costPerKg: filament.costPerKg,
            volumeSampleCount: filament.volumeSampleCount,
            sources: [source],
            usage: filament.usage,
            accessibleLabel: aggregatedFilamentLabel(filament.tool, filament.profileId, filament.usage.total, costUnit),
          }),
        );
        continue;
      }
      assertSameProfileAssumptions(prior, filament);
      const usage = sumMaterialCategories([prior.usage, filament.usage]);
      const volumeSampleCount = sumSafeIntegers(
        [prior.volumeSampleCount, filament.volumeSampleCount],
        'material sample count',
      );
      groups.set(
        identity,
        freeze({
          ...prior,
          diameterMm: prior.diameterMm ?? filament.diameterMm,
          densityGPerCm3: prior.densityGPerCm3 ?? filament.densityGPerCm3,
          costPerKg: prior.costPerKg ?? filament.costPerKg,
          volumeSampleCount,
          sources: [...prior.sources, source],
          usage,
          accessibleLabel: aggregatedFilamentLabel(filament.tool, filament.profileId, usage.total, costUnit),
        }),
      );
    }
  }
  return freeze(
    [...groups.values()].sort(
      (left, right) => left.tool - right.tool || left.profileHash.localeCompare(right.profileHash),
    ),
  );
}

function aggregateRoleToolUsage(
  plates: readonly GcodeStatisticsProjection[],
  costUnit: GcodeStatisticsCostUnit | null,
): readonly AggregatedGcodeRoleToolUsageProjection[] {
  const groups = new Map<string, AggregatedGcodeRoleToolUsageProjection>();
  for (const plate of plates) {
    for (const row of plate.roleToolUsage) {
      const identity = `${row.role}:${row.tool}:${row.profileHash}`;
      const source = { plateId: plate.binding.plateId, tool: row.tool };
      const prior = groups.get(identity);
      const usage = prior === undefined ? row.usage : sumMaterialUsage([prior.usage, row.usage]);
      groups.set(
        identity,
        freeze({
          role: row.role,
          tool: row.tool,
          profileId: row.profileId,
          profileHash: row.profileHash,
          sources: prior === undefined ? [source] : [...prior.sources, source],
          usage,
          accessibleLabel: aggregatedRoleUsageLabel(row.role, row.tool, row.profileId, usage, costUnit),
        }),
      );
    }
  }
  return freeze(
    [...groups.values()].sort(
      (left, right) =>
        left.role - right.role || left.tool - right.tool || left.profileHash.localeCompare(right.profileHash),
    ),
  );
}

function aggregateTotals(plates: readonly GcodeStatisticsProjection[]): GcodeStatisticsTotalsProjection {
  const categories = sumMaterialCategories(plates.map((plate) => plate.totals));
  const timeCost = sumNullable(
    plates.map((plate) => plate.totals.timeCost),
    'time cost',
  );
  const totalCost = sumNullable(
    plates.map((plate) => plate.totals.totalCost),
    'total cost',
  );
  return freeze({ ...categories, timeCost, totalCost });
}

function aggregateObservedEvents(plates: readonly GcodeStatisticsProjection[]): GcodeObservedEventCounts {
  const coverages = plates.map((plate) => plate.observedEvents.coverage);
  const coverage = freeze({
    kind: coverages.some((row) => row.kind === 'prefix')
      ? ('prefix' as const)
      : coverages.some((row) => row.kind === 'degraded')
        ? ('degraded' as const)
        : ('complete' as const),
    exhaustive: coverages.every((row) => row.exhaustive),
    terminationReason: coverages.find((row) => row.terminationReason !== null)?.terminationReason ?? null,
    warningCodes: [...new Set(coverages.flatMap((row) => row.warningCodes))],
  });
  return freeze({
    coverage,
    toolChangeMarkers: sumSafeIntegers(
      plates.map((plate) => plate.observedEvents.toolChangeMarkers),
      'observed tool-change markers',
    ),
    colorChanges: sumSafeIntegers(
      plates.map((plate) => plate.observedEvents.colorChanges),
      'observed color changes',
    ),
    pauses: sumSafeIntegers(
      plates.map((plate) => plate.observedEvents.pauses),
      'observed pauses',
    ),
    customGcode: sumSafeIntegers(
      plates.map((plate) => plate.observedEvents.customGcode),
      'observed custom G-code',
    ),
  });
}

function sumMaterialCategories(rows: readonly GcodeMaterialCategoriesProjection[]): GcodeMaterialCategoriesProjection {
  return freeze({
    model: sumMaterialUsage(rows.map((row) => row.model)),
    support: sumMaterialUsage(rows.map((row) => row.support)),
    wipeTower: sumMaterialUsage(rows.map((row) => row.wipeTower)),
    flushed: sumMaterialUsage(rows.map((row) => row.flushed)),
    total: sumMaterialUsage(rows.map((row) => row.total)),
  });
}

function sumMaterialUsage(rows: readonly GcodeMaterialUsageProjection[]): GcodeMaterialUsageProjection {
  return freeze({
    volumeMm3: sumFinite(
      rows.map((row) => row.volumeMm3),
      'material volume',
    ),
    filamentLengthMm: sumNullable(
      rows.map((row) => row.filamentLengthMm),
      'filament length',
    ),
    filamentWeightG: sumNullable(
      rows.map((row) => row.filamentWeightG),
      'filament weight',
    ),
    cost: sumNullable(
      rows.map((row) => row.cost),
      'material cost',
    ),
  });
}

function mergeTimeRows(groups: readonly (readonly GcodeTimeBreakdownRow[])[]): readonly GcodeTimeBreakdownRow[] {
  const rows = new Map<number, number>();
  for (const group of groups) {
    for (const row of group) rows.set(row.id, sumFinite([rows.get(row.id) ?? 0, row.seconds], 'time breakdown'));
  }
  return freeze([...rows].sort(([left], [right]) => left - right).map(([id, seconds]) => ({ id, seconds })));
}

function assertSameProfileAssumptions(
  prior: AggregatedGcodeFilamentStatisticsProjection,
  filament: GcodeFilamentStatisticsProjection,
): void {
  if (
    prior.profileId !== filament.profileId ||
    !sameKnownOptionalNumber(prior.diameterMm, filament.diameterMm) ||
    !sameKnownOptionalNumber(prior.densityGPerCm3, filament.densityGPerCm3) ||
    !sameKnownOptionalNumber(prior.costPerKg, filament.costPerKg)
  ) {
    throw statisticsError(
      'incompatible-plates',
      `Profile fingerprint ${filament.profileHash} has conflicting assumptions`,
    );
  }
}

function copyConflict(conflict: GcodeStatisticsConflictArtifact): GcodeStatisticsConflictArtifact {
  return {
    ...conflict,
    subjects: conflict.subjects.map((subject) => ({ ...subject })) as [
      GcodeStatisticsConflictSubjectArtifact,
      GcodeStatisticsConflictSubjectArtifact,
    ],
  };
}

function sameConflictSubject(
  left: GcodeStatisticsConflictSubjectArtifact,
  right: GcodeStatisticsConflictSubjectArtifact,
): boolean {
  return (
    (left.kind === 'wipe-tower' && right.kind === 'wipe-tower') ||
    (left.kind === 'object' && right.kind === 'object' && left.objectId === right.objectId)
  );
}

function sameBinding(left: GcodeStatisticsBinding, right: GcodeStatisticsBinding): boolean {
  return (
    left.jobId === right.jobId &&
    left.plateId === right.plateId &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceHash === right.sourceHash &&
    left.sourceAssetHash === right.sourceAssetHash &&
    left.projectInputHash === right.projectInputHash &&
    left.gcodeOutputHash === right.gcodeOutputHash &&
    left.effectiveConfigHash === right.effectiveConfigHash &&
    left.engineCommit === right.engineCommit &&
    left.engineArtifactHash === right.engineArtifactHash
  );
}

function sameKnownOptionalNumber(left: number | null, right: number | null): boolean {
  return left === null || right === null || left === right;
}

function sumOptionalSafeIntegers(values: readonly (number | null)[], label: string): number | null {
  return values.some((value) => value === null) ? null : sumSafeIntegers(values as readonly number[], label);
}

function sumSafeIntegers(values: readonly number[], label: string): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) throw statisticsError('aggregation-cap', `Aggregated ${label} is unsafe`);
  return sum;
}

function sumNullable(values: readonly (number | null)[], label: string): number | null {
  return values.some((value) => value === null) ? null : sumFinite(values as readonly number[], label);
}

function sumFinite(values: readonly number[], label: string): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum < 0 || sum > GCODE_STATISTICS_HARD_CAPS.derivedQuantity) {
    throw statisticsError('aggregation-cap', `Aggregated ${label} is outside the finite domain`);
  }
  return sum;
}

function validateDoublePartition(
  values: readonly number[],
  total: number,
  materialSampleCount: number,
  label: string,
): void {
  const partitionTotal = finiteSum(values, label);
  if (partitionTotal === 0 || total === 0) {
    if (partitionTotal === total) return;
    throw statisticsError('inconsistent-statistics', `${label} do not cover the material total`);
  }
  const operationCount = materialSampleCount + values.length;
  const accumulatedError = operationCount * 2 ** -53;
  const gamma = accumulatedError / (1 - accumulatedError);
  const relativeTolerance = (2 * gamma) / (1 - gamma);
  const absoluteTolerance = Math.max(
    operationCount * Number.MIN_VALUE,
    Math.max(Math.abs(partitionTotal), Math.abs(total)) * relativeTolerance,
  );
  if (Math.abs(partitionTotal - total) > absoluteTolerance) {
    throw statisticsError(
      'inconsistent-statistics',
      `${label} exceed the double reconciliation bound for ${materialSampleCount} material samples`,
    );
  }
}

function plannerFinite(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > GCODE_STATISTICS_HARD_CAPS.seconds ||
    Math.fround(value) !== value
  ) {
    invalidArtifact(`${label} must be a finite float32 planner value inside the bounded domain`);
  }
}

function plannerNonNegative(value: unknown, label: string): asserts value is number {
  plannerFinite(value, label);
  if (value < 0) invalidArtifact(`${label} must be non-negative`);
}

function plannerPositive(value: unknown, label: string): asserts value is number {
  plannerFinite(value, label);
  if (value <= 0) invalidArtifact(`${label} must be positive when present in a sparse planner table`);
}

function plannerFloatEqual(actual: number, expected: number): boolean {
  return actual === expected;
}

function validatePlannerPartition(
  values: readonly number[],
  totalSeconds: number,
  plannerBlockCount: number,
  label: string,
): void {
  const partitionTotal = finiteSum(values, label);
  if (partitionTotal === 0 || totalSeconds === 0) {
    if (partitionTotal === totalSeconds) return;
    throw statisticsError('inconsistent-statistics', `${label} do not cover the planner total`);
  }
  const absoluteTolerance = plannerReconciliationTolerance(partitionTotal, totalSeconds, plannerBlockCount);
  if (Math.abs(partitionTotal - totalSeconds) > absoluteTolerance) {
    throw statisticsError(
      'inconsistent-statistics',
      `${label} exceed the float32 reconciliation bound for ${plannerBlockCount} processed blocks`,
    );
  }
}

function validatePlannerSubset(
  values: readonly number[],
  totalSeconds: number,
  plannerBlockCount: number,
  label: string,
): void {
  const subsetTotal = finiteSum(values, label);
  if (subsetTotal <= totalSeconds) return;
  if (
    totalSeconds === 0 ||
    subsetTotal - totalSeconds > plannerReconciliationTolerance(subsetTotal, totalSeconds, plannerBlockCount)
  ) {
    throw statisticsError(
      'inconsistent-statistics',
      `${label} exceed the planner total outside the float32 reconciliation bound`,
    );
  }
}

function plannerReconciliationTolerance(left: number, right: number, plannerBlockCount: number): number {
  const unitRoundoff = 2 ** -24;
  const accumulatedError = plannerBlockCount * unitRoundoff;
  const gamma = accumulatedError / (1 - accumulatedError);
  const relativeTolerance = (2 * gamma) / (1 - gamma);
  return Math.max(plannerBlockCount * 2 ** -150, Math.max(Math.abs(left), Math.abs(right)) * relativeTolerance);
}

function finiteSum(values: readonly number[], label: string): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const corrected = value - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
  }
  if (!Number.isFinite(sum) || sum < 0 || sum > GCODE_STATISTICS_HARD_CAPS.derivedQuantity) {
    invalidArtifact(`${label} exceeds the finite artifact domain`);
  }
  return sum;
}

function finiteProjectionNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > GCODE_STATISTICS_HARD_CAPS.derivedQuantity) {
    throw statisticsError('inconsistent-statistics', `Derived ${label} exceeds the finite projection domain`);
  }
  return value;
}

function nonNegative(
  value: unknown,
  label: string,
  maximum: number = GCODE_STATISTICS_HARD_CAPS.derivedQuantity,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    invalidArtifact(`${label} must be finite, non-negative, and inside the bounded domain`);
  }
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalidArtifact(`${label} must be a non-negative safe integer inside the bounded domain`);
  }
}

function optionalNonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (value !== null) nonNegativeInteger(value, label, maximum);
}

function optionalPositive(value: unknown, label: string, minimum: number, maximum: number): void {
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value < minimum || value > maximum)
  ) {
    invalidArtifact(`${label} must be null or finite and inside the positive bounded domain`);
  }
}

function optionalNonNegative(
  value: unknown,
  label: string,
  maximum: number = GCODE_STATISTICS_HARD_CAPS.derivedQuantity,
): void {
  if (value !== null) nonNegative(value, label, maximum);
}

function boundedText(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > GCODE_STATISTICS_HARD_CAPS.textCharacters ||
    value.trim() !== value
  ) {
    invalidArtifact(`${label} must be a bounded non-empty canonical string`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isFnv1a64(value: unknown): value is string {
  return typeof value === 'string' && /^fnv1a64:[0-9a-f]{16}$/.test(value);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function runtimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function hasExactTypedArrayLength(
  value: unknown,
  constructor: { readonly prototype: object },
  expectedLength: number,
): boolean {
  try {
    return (
      isObject(value) &&
      TYPED_ARRAY_LENGTH_GETTER !== undefined &&
      Object.getPrototypeOf(value) === constructor.prototype &&
      Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []) === expectedLength &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      !CANONICAL_TYPED_ARRAY_BEHAVIOR_NAMES.some((name) => Object.hasOwn(value, name))
    );
  } catch {
    return false;
  }
}

function snapshotStructuredValue<T>(value: T, label: string): T {
  try {
    return globalThis.structuredClone(value);
  } catch {
    invalidArtifact(`${label} must be a cloneable canonical data value`);
  }
}

function snapshotRichGcodeModel(value: RichGcodeModel): RichGcodeModel {
  try {
    return globalThis.structuredClone(value);
  } catch {
    invalidModel('Rich G-code model must be a cloneable canonical data value');
  }
}

function snapshotProjectionArray(value: readonly GcodeStatisticsProjection[]): readonly GcodeStatisticsProjection[] {
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidPlateArray('Plate collection must be a canonical JSON array');
    }
    if (CANONICAL_ARRAY_BEHAVIOR_NAMES.some((name) => Object.hasOwn(value, name))) {
      invalidPlateArray('Plate collection must not override canonical array behavior');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value)
    ) {
      invalidPlateArray('Plate collection is outside the bounded array domain');
    }
    const length = lengthDescriptor.value;
    if (length < 1 || length > GCODE_STATISTICS_HARD_CAPS.plates) {
      throw statisticsError(
        'aggregation-cap',
        `All-plate statistics require 1-${GCODE_STATISTICS_HARD_CAPS.plates} plates`,
      );
    }
    const snapshot: GcodeStatisticsProjection[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        invalidPlateArray('Plate collection must contain only enumerable data elements');
      }
      snapshot.push(descriptor.value as GcodeStatisticsProjection);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (isIssuedStatisticsError(error)) throw error;
    invalidPlateArray('Plate collection is outside the canonical bounded domain');
  }
}

type InvalidValue = (message: string) => never;

function validateDenseArray(
  value: unknown,
  label: string,
  maximumLength: number,
  minimumLength = 0,
  invalidate: InvalidValue = invalidArtifact,
): void {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    invalidate(`${label} is outside the bounded array domain`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    invalidate(`${label} must be a canonical JSON array`);
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    CANONICAL_ARRAY_BEHAVIOR_NAMES.some((name) => Object.hasOwn(value, name))
  ) {
    invalidate(`${label} must not override canonical array behavior`);
  }
  let index = 0;
  for (const key in value) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !Object.hasOwn(value, key) ||
      key !== String(index) ||
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      invalidate(`${label} must contain only enumerable data elements`);
    }
    index += 1;
  }
  if (index !== value.length) invalidate(`${label} must be a dense canonical array without extra properties`);
}

function validateExactObjectKeys(
  value: object,
  keys: readonly string[],
  label: string,
  invalidate: InvalidValue = invalidArtifact,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidate(`${label} must be a plain JSON object`);
  }
  const allowed = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    invalidate(`${label} fields are missing or unknown`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      invalidate(`${label}.${key} must be an enumerable data field`);
    }
  }
}

function invalidArtifact(message: string): never {
  throw statisticsError('invalid-artifact', message);
}

function invalidPlateArray(message: string): never {
  throw statisticsError('incompatible-plates', message);
}

function invalidModel(message = 'Rich G-code model is outside the bounded statistics domain'): never {
  throw statisticsError('invalid-model', message);
}

function rethrowStatisticsError(
  error: unknown,
  fallbackCode: GcodeStatisticsErrorCode,
  fallbackMessage: string,
): never {
  if (isIssuedStatisticsError(error)) throw error;
  throw statisticsError(fallbackCode, fallbackMessage);
}

function isIssuedStatisticsError(error: unknown): error is GcodeStatisticsError {
  if (!isObject(error) || !issuedGcodeStatisticsErrors.has(error)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      !descriptor.writable &&
      !descriptor.configurable &&
      (GCODE_STATISTICS_ERROR_CODES as readonly unknown[]).includes(descriptor.value)
    );
  } catch {
    return false;
  }
}

function timeModeLabel(
  id: GcodeStatisticsTimeModeId,
  totalSeconds: number,
  prepareSeconds: number,
  modelSeconds: number,
): string {
  return `${id === 'normal' ? 'Normal' : 'Silent'} mode: ${formatDuration(totalSeconds)} total, ${formatDuration(prepareSeconds)} prepare, ${formatDuration(modelSeconds)} model`;
}

function filamentLabel(
  filament: GcodeFilamentStatisticsArtifact,
  usage: GcodeMaterialUsageProjection,
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  return `Tool ${filament.tool + 1}, ${filament.profileId}: ${materialUsageLabel(usage, costUnit)}`;
}

function aggregatedFilamentLabel(
  tool: number,
  profileId: string,
  usage: GcodeMaterialUsageProjection,
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  return `Tool ${tool + 1}, ${profileId}: ${materialUsageLabel(usage, costUnit)}`;
}

function roleUsageLabel(
  role: number,
  tool: number,
  usage: GcodeMaterialUsageProjection,
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  return `Role ${role}, tool ${tool + 1}: ${materialUsageLabel(usage, costUnit)}`;
}

function aggregatedRoleUsageLabel(
  role: number,
  tool: number,
  profileId: string,
  usage: GcodeMaterialUsageProjection,
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  return `Role ${role}, tool ${tool + 1}, ${profileId}: ${materialUsageLabel(usage, costUnit)}`;
}

function materialUsageLabel(usage: GcodeMaterialUsageProjection, costUnit: GcodeStatisticsCostUnit | null): string {
  const length =
    usage.filamentLengthMm === null ? 'length unavailable' : `${formatNumber(usage.filamentLengthMm / 1_000)} m`;
  const weight = usage.filamentWeightG === null ? 'weight unavailable' : `${formatNumber(usage.filamentWeightG)} g`;
  const cost =
    usage.cost === null
      ? 'cost unavailable'
      : costUnit === null
        ? `${formatNumber(usage.cost)} cost units`
        : `${formatNumber(usage.cost)} ${costUnit.label}`;
  return `${length}, ${weight}, ${formatNumber(usage.volumeMm3)} mm³, ${cost}`;
}

function plateLabel(
  plateId: string,
  totals: GcodeStatisticsTotalsProjection,
  modes: readonly GcodeTimeModeProjection[],
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  const weight =
    totals.total.filamentWeightG === null
      ? 'filament weight unavailable'
      : `${formatNumber(totals.total.filamentWeightG)} g filament`;
  const cost =
    totals.totalCost === null || costUnit === null
      ? 'total cost unavailable'
      : `${formatNumber(totals.totalCost)} ${costUnit.label} total cost`;
  return `Plate ${plateId}: ${formatDuration(modes.find((mode) => mode.id === 'normal')!.totalSeconds)}, ${weight}, ${cost}`;
}

function allPlateLabel(
  plateCount: number,
  totals: GcodeStatisticsTotalsProjection,
  modes: readonly AggregatedGcodeTimeModeProjection[],
  costUnit: GcodeStatisticsCostUnit | null,
): string {
  const weight =
    totals.total.filamentWeightG === null
      ? 'filament weight unavailable'
      : `${formatNumber(totals.total.filamentWeightG)} g filament`;
  const cost =
    totals.totalCost === null || costUnit === null
      ? 'total cost unavailable'
      : `${formatNumber(totals.totalCost)} ${costUnit.label} total cost`;
  return `${plateCount} plates, ${formatDuration(modes[0].totalSeconds)}, ${weight}, ${cost}`;
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const rest = rounded % 60;
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', rest || (!hours && !minutes) ? `${rest} s` : '']
    .filter(Boolean)
    .join(' ');
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) freeze(entry);
    return Object.freeze(value) as T;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as object)) freeze(entry);
    return Object.freeze(value);
  }
  return value;
}
