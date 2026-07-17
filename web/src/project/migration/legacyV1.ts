import { InMemoryAssetRepository, contentDigest, type AssetPayload, type AssetRepository } from '../assets';
import type { AssetId, PhysicalFilamentId } from '../domain/ids';
import {
  emptyFacetAnnotations,
  identityTransform,
  type ConfigMap,
  type JsonValue,
  type PhysicalFilament,
  type ProjectObject,
  type ProjectPlate,
  type ProjectState,
  type SourceAssetDescriptor,
  type Transform,
  type Vec3,
} from '../domain/model';
import { validateProjectState } from '../domain/validation';
import { stableImportedId, stableUnknownDigest } from './stableImportedIds';
import {
  LEGACY_FLAT_PROJECT_V1_ADAPTER_ID,
  LEGACY_PROJECT_3MF_V1_ADAPTER_ID,
  type LegacyFilamentSlotV1,
  type LegacyFlatProjectV1,
  type LegacyGeometryInputV1,
  type LegacyMigrationAdapter,
  type LegacyMigrationAdapterId,
  type LegacyMigrationOptions,
  type LegacyMigrationResult,
  type LegacyMigrationSource,
  type LegacyViewerTransformV1,
  type MigrationDiagnostic,
  type MigrationDiagnosticSeverity,
  type MigrationRecoveryDisposition,
  type MigrationRecoveryEntry,
  type OrcaXrProject3mfV1MigrationInput,
} from './types';

const DEFAULT_MIGRATION_TIME = '1970-01-01T00:00:00.000Z';
const DEFAULT_WORLD_METRES_PER_PRINTER_MM = 0.001 * 1.75;
const DEFAULT_FILAMENT_COLOR = '#cccccc';

interface NormalizedPlateInput {
  value: unknown;
  path: string;
  format: 'project-3mf' | 'flat';
}

interface NormalizedModelInput {
  value: unknown;
  geometry: unknown;
  path: string;
  geometryPath: string;
  format: 'project-3mf' | 'flat';
  index: number;
}

interface NormalizedLegacyProject {
  adapter: LegacyMigrationAdapterId;
  name: unknown;
  profile: unknown;
  activePlate: unknown;
  plates: NormalizedPlateInput[];
  models: NormalizedModelInput[];
  filaments: unknown[];
  config: unknown;
}

interface MigrationContext {
  adapter: LegacyMigrationAdapterId;
  source: LegacyMigrationSource;
  sourceKey: string;
  timestamp: string;
  worldMetresPerPrinterMm: number;
  originOffsetMm: Vec3;
  diagnostics: MigrationDiagnostic[];
  recoveryEntries: MigrationRecoveryEntry[];
  repository: InMemoryAssetRepository;
  assetsByDigest: Map<string, AssetPayload[]>;
}

interface MigratedGeometry {
  assetId: AssetId;
  triangleCount: number;
  bbox: { min: Vec3; max: Vec3 };
  digest: string;
  sourceFilename?: string;
  legacyId?: JsonValue;
}

interface MigratedProfile {
  machine?: string;
  process?: string;
  filament?: string;
}

export const orcaXrProject3mfV1Adapter: LegacyMigrationAdapter<OrcaXrProject3mfV1MigrationInput> = {
  id: LEGACY_PROJECT_3MF_V1_ADAPTER_ID,
  sourceVersion: 1,
  migrate: migrateOrcaXrProject3mfV1,
};

export const legacyFlatProjectV1Adapter: LegacyMigrationAdapter<LegacyFlatProjectV1> = {
  id: LEGACY_FLAT_PROJECT_V1_ADAPTER_ID,
  sourceVersion: 1,
  migrate: migrateLegacyFlatProjectV1,
};

/** Migrate the JSON sidecar + aligned raw geometries written by Project3mf.ts. */
export function migrateOrcaXrProject3mfV1(
  input: OrcaXrProject3mfV1MigrationInput,
  options: LegacyMigrationOptions = {},
): LegacyMigrationResult {
  const envelope: Record<string, unknown> = isRecord(input) ? input : {};
  const metadataValue = envelope.metadata;
  const geometryValues = Array.isArray(envelope.geometries) ? envelope.geometries : [];
  const filamentValues = Array.isArray(envelope.filaments) ? envelope.filaments : [];
  const context = createContext(LEGACY_PROJECT_3MF_V1_ADAPTER_ID, input, options);
  const metadata = isRecord(metadataValue) ? metadataValue : {};

  if (!isRecord(metadataValue)) {
    recover(
      context,
      'invalid-project-metadata',
      'metadata',
      'Project sidecar is not an object; an empty project shell was recovered.',
      metadataValue,
      'rejected',
      'error',
    );
  }
  if (metadata.version !== 1) {
    recover(
      context,
      'unexpected-source-version',
      'metadata.version',
      'The v1 adapter received a missing or different version; known v1 fields were recovered best-effort.',
      metadata.version,
      'repaired',
      'error',
    );
  }
  if (!Array.isArray(envelope.geometries)) {
    recover(
      context,
      'invalid-geometry-list',
      'geometries',
      'Geometry list is missing or malformed.',
      envelope.geometries,
      'rejected',
      'error',
    );
  }
  captureUnknownFields(context, metadata, ['version', 'profile', 'activePlate', 'plates', 'objects'], 'metadata');
  captureUnknownFields(context, envelope, ['metadata', 'geometries', 'filaments'], '$');

  const plateValues = readArray(metadata.plates, 'metadata.plates', context);
  const objectValues = readArray(metadata.objects, 'metadata.objects', context);
  const models: NormalizedModelInput[] = [];
  const count = Math.max(objectValues.length, geometryValues.length);
  for (let index = 0; index < count; index += 1) {
    const objectPresent = index < objectValues.length;
    const geometryPresent = index < geometryValues.length;
    if (!objectPresent) {
      diagnostic(
        context,
        'orphan-geometry-recovered',
        `geometries[${index}]`,
        'Geometry had no aligned metadata object and was recovered onto the active plate.',
        'warning',
        true,
      );
    }
    if (!geometryPresent) {
      recover(
        context,
        'object-without-geometry',
        `metadata.objects[${index}]`,
        'Object metadata has no aligned geometry and cannot become a printable object.',
        objectValues[index],
        'rejected',
        'error',
      );
    }
    models.push({
      value: objectPresent ? objectValues[index] : {},
      geometry: geometryPresent ? geometryValues[index] : undefined,
      path: `metadata.objects[${index}]`,
      geometryPath: `geometries[${index}]`,
      format: 'project-3mf',
      index,
    });
  }

  const normalized: NormalizedLegacyProject = {
    adapter: LEGACY_PROJECT_3MF_V1_ADAPTER_ID,
    name: options.source?.filename ? stripProjectExtension(options.source.filename) : 'Migrated OrcaXR project',
    profile: metadata.profile,
    activePlate: metadata.activePlate,
    plates: plateValues.map((value, index) => ({
      value,
      path: `metadata.plates[${index}]`,
      format: 'project-3mf',
    })),
    models,
    filaments: filamentValues,
    config: {},
  };
  return migrateNormalizedProject(context, normalized);
}

/** Migrate serializable projections of ModelEntry, PlateStore, and FilamentPalette. */
export function migrateLegacyFlatProjectV1(
  input: LegacyFlatProjectV1,
  options: LegacyMigrationOptions = {},
): LegacyMigrationResult {
  const root: Record<string, unknown> = isRecord(input) ? input : {};
  const context = createContext(LEGACY_FLAT_PROJECT_V1_ADAPTER_ID, input, options);
  if (!isRecord(input)) {
    recover(
      context,
      'invalid-flat-project',
      '$',
      'Flat legacy project is not an object; an empty project shell was recovered.',
      input,
      'rejected',
      'error',
    );
  }
  if (root.version !== 1) {
    recover(
      context,
      'unexpected-source-version',
      'version',
      'The v1 adapter received a missing or different version; known v1 fields were recovered best-effort.',
      root.version,
      'repaired',
      'error',
    );
  }
  captureUnknownFields(
    context,
    root,
    ['version', 'name', 'profile', 'activePlateId', 'plates', 'models', 'filaments', 'config'],
    '$',
  );
  const plateValues = readArray(root.plates, 'plates', context);
  const modelValues = readArray(root.models, 'models', context);
  const filamentValues = readArray(root.filaments, 'filaments', context);
  const models = modelValues.map((value, index) => {
    const record = isRecord(value) ? value : {};
    return {
      value,
      geometry: record.geometry,
      path: `models[${index}]`,
      geometryPath: `models[${index}].geometry`,
      format: 'flat' as const,
      index,
    };
  });
  return migrateNormalizedProject(context, {
    adapter: LEGACY_FLAT_PROJECT_V1_ADAPTER_ID,
    name: root.name,
    profile: root.profile,
    activePlate: root.activePlateId,
    plates: plateValues.map((value, index) => ({ value, path: `plates[${index}]`, format: 'flat' })),
    models,
    filaments: filamentValues,
    config: root.config,
  });
}

/** Restore the owned migration snapshot into an immutable-by-contract repository. */
export function restoreMigratedAssets(result: LegacyMigrationResult, repository: AssetRepository): void {
  repository.restore(result.assets);
}

function migrateNormalizedProject(context: MigrationContext, input: NormalizedLegacyProject): LegacyMigrationResult {
  const profile = migrateProfile(context, input.profile);
  const filaments = migrateFilaments(context, input.filaments, profile);
  const plates: ProjectPlate[] = [];
  const exactPlateMap = new Map<string, ProjectPlate>();
  const loosePlateMap = new Map<string, ProjectPlate | null>();

  input.plates.forEach((candidate, index) => {
    const record = isRecord(candidate.value) ? candidate.value : {};
    if (!isRecord(candidate.value)) {
      recover(
        context,
        'invalid-plate',
        candidate.path,
        'Plate entry is not an object; a numbered plate was created.',
        candidate.value,
        'repaired',
        'warning',
      );
    }
    const known = candidate.format === 'flat' ? ['id', 'label', 'createdAt', 'printable', 'config'] : ['id', 'label'];
    captureUnknownFields(context, record, known, candidate.path);
    const legacyId = record.id ?? index + 1;
    const exactKey = referenceKey(legacyId);
    const duplicate = exactPlateMap.has(exactKey);
    if (duplicate) {
      recover(
        context,
        'duplicate-legacy-plate-id',
        `${candidate.path}.id`,
        'Duplicate legacy plate id was assigned a distinct canonical id; ambiguous references keep targeting the first.',
        legacyId,
        'repaired',
        'warning',
      );
    }
    const id = stableImportedId(context.adapter, 'plate', [
      context.sourceKey,
      'plate',
      snapshot(legacyId),
      duplicate ? index : 0,
    ]);
    const label = repairedName(record.label, `Plate ${index + 1}`, `${candidate.path}.label`, context);
    const config = sanitizeConfig(record.config, `${candidate.path}.config`, context);
    const createdAt = finiteNumber(record.createdAt);
    if (record.createdAt !== undefined && createdAt === undefined) {
      recover(
        context,
        'invalid-plate-created-at',
        `${candidate.path}.createdAt`,
        'Invalid PlateStore createdAt value was retained only in recovery.',
        record.createdAt,
        'rejected',
        'warning',
      );
    }
    const plate: ProjectPlate = {
      id,
      name: label,
      order: plates.length,
      printable: typeof record.printable === 'boolean' ? record.printable : true,
      config,
      objects: [],
      extensionData: {
        legacyMigration: {
          adapter: context.adapter,
          legacyId: snapshot(legacyId),
          ...(createdAt === undefined ? {} : { createdAt }),
        },
      },
    };
    plates.push(plate);
    if (!duplicate) exactPlateMap.set(exactKey, plate);
    indexLoosePlate(loosePlateMap, legacyId, plate);
  });

  if (plates.length === 0) {
    const plate = createRecoveredPlate(context, plates, 'default', 'Plate 1');
    exactPlateMap.set(referenceKey(1), plate);
    indexLoosePlate(loosePlateMap, 1, plate);
    diagnostic(
      context,
      'missing-plates-repaired',
      'plates',
      'No valid legacy plate list was available; a default plate was created.',
      'warning',
      true,
    );
  }

  const ensurePlate = (reference: unknown, path: string): ProjectPlate => {
    const exact = exactPlateMap.get(referenceKey(reference));
    if (exact) return exact;
    const loose = loosePlateMap.get(String(reference));
    if (loose) return loose;
    if (reference === undefined || reference === null || reference === '') return plates[0];
    const plate = createRecoveredPlate(
      context,
      plates,
      `missing:${referenceKey(reference)}`,
      `Recovered plate ${String(reference)}`,
    );
    exactPlateMap.set(referenceKey(reference), plate);
    indexLoosePlate(loosePlateMap, reference, plate);
    recover(
      context,
      'missing-referenced-plate',
      path,
      'A referenced plate was absent from PlateStore metadata and was recreated.',
      reference,
      'repaired',
      'warning',
    );
    return plate;
  };

  input.models.forEach((candidate) => {
    const migrated = migrateModel(context, candidate, filaments);
    if (!migrated) return;
    const record = isRecord(candidate.value) ? candidate.value : {};
    const plateReference = candidate.format === 'project-3mf' ? record.plate : record.plateId;
    ensurePlate(
      plateReference,
      `${candidate.path}.${candidate.format === 'project-3mf' ? 'plate' : 'plateId'}`,
    ).objects.push(migrated);
  });

  const activePlate = ensurePlate(
    input.activePlate,
    input.adapter === LEGACY_PROJECT_3MF_V1_ADAPTER_ID ? 'metadata.activePlate' : 'activePlateId',
  );
  const name = repairedName(
    input.name,
    context.source.filename ? stripProjectExtension(context.source.filename) : 'Migrated OrcaXR project',
    'name',
    context,
  );
  const repositoryEntries = context.repository.list();
  const state: ProjectState = {
    schemaVersion: 1,
    id: stableImportedId(context.adapter, 'project', [context.sourceKey, 'project']),
    name,
    createdAt: context.timestamp,
    updatedAt: context.timestamp,
    printer: {
      ...(profile.machine ? { profileId: profile.machine } : {}),
      toolCount: Math.max(1, filaments.length),
    },
    config: sanitizeConfig(input.config, 'config', context),
    activePlateId: activePlate.id,
    plates,
    filaments: { physical: filaments, mixed: [] },
    sourceAssets: repositoryEntries.map((entry) => entry.descriptor),
    customGcode: [],
    thumbnails: [],
    extensionBlobs: [],
    extensionData: {
      legacyMigration: {
        adapter: context.adapter,
        sourceVersion: 1,
        sourceKey: context.sourceKey,
        sourceUri: context.source.uri ?? null,
        rawGeometryUnits: 'millimetre',
        rawGeometryAxes: 'printer-x-y-z-up',
        legacyTransformUnits: 'world-metre',
        legacyTransformAxes: 'x-right-y-up-z-toward-user',
        canonicalTransformUnits: 'millimetre',
        canonicalTransformAxes: 'printer-x-right-y-back-z-up',
        legacyWorldMetresPerPrinterMm: context.worldMetresPerPrinterMm,
        originOffsetMm: [...context.originOffsetMm],
        profile: {
          machine: profile.machine ?? null,
          process: profile.process ?? null,
          filament: profile.filament ?? null,
        },
      },
    },
  };

  const validationIssues = validateProjectState(state);
  validationIssues.forEach((issue) =>
    diagnostic(context, `canonical-${issue.code}`, issue.path, issue.message, issue.severity, false),
  );
  const errors = validationIssues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Legacy migration produced invalid canonical state: ${errors.map((issue) => issue.code).join(', ')}`,
    );
  }
  return {
    state,
    assets: context.repository.capture(),
    diagnostics: context.diagnostics,
    recovery: {
      version: 1,
      adapter: context.adapter,
      sourceKey: context.sourceKey,
      entries: context.recoveryEntries,
    },
    validationIssues,
  };
}

function migrateProfile(context: MigrationContext, value: unknown): MigratedProfile {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    recover(
      context,
      'invalid-profile',
      'profile',
      'Legacy profile selection is not an object and was retained in recovery.',
      value,
      'rejected',
      'warning',
    );
    return {};
  }
  captureUnknownFields(context, value, ['machine', 'process', 'filament'], 'profile');
  return {
    machine: optionalString(value.machine, 'profile.machine', context),
    process: optionalString(value.process, 'profile.process', context),
    filament: optionalString(value.filament, 'profile.filament', context),
  };
}

function migrateFilaments(context: MigrationContext, values: unknown[], profile: MigratedProfile): PhysicalFilament[] {
  if (values.length === 0) {
    if (profile.filament) {
      diagnostic(
        context,
        'palette-not-persisted',
        'filaments',
        'The v1 project sidecar stored a profile name but not FilamentPalette colors/slots; no palette was invented.',
        'warning',
        false,
      );
    }
    return [];
  }
  const filaments: PhysicalFilament[] = [];
  values.forEach((value, index) => {
    const path = `filaments[${index}]`;
    const record = isRecord(value) ? value : {};
    if (!isRecord(value)) {
      recover(
        context,
        'invalid-filament-slot',
        path,
        'Filament slot is not an object; a default slot was created.',
        value,
        'repaired',
        'warning',
      );
    }
    captureUnknownFields(context, record, ['legacyId', 'name', 'color', 'type', 'presetId', 'enabled', 'config'], path);
    const legacyId = record.legacyId ?? index;
    const color = normalizeColor(record.color, `${path}.color`, context);
    const material = repairedName(record.type, 'PLA', `${path}.type`, context);
    const name = repairedName(record.name, `Tool ${index + 1} ${material}`, `${path}.name`, context);
    const presetId =
      optionalString(record.presetId, `${path}.presetId`, context) ?? (index === 0 ? profile.filament : undefined);
    const id = stableImportedId(context.adapter, 'physical-filament', [
      context.sourceKey,
      'filament',
      snapshot(legacyId),
      index,
    ]) as PhysicalFilamentId;
    filaments.push({
      id,
      name,
      toolId: index,
      ...(presetId ? { presetId } : {}),
      material,
      color,
      config: sanitizeConfig(record.config, `${path}.config`, context),
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
      extensionData: {
        legacyMigration: {
          adapter: context.adapter,
          legacyId: snapshot(legacyId),
          originalColor: snapshot(record.color),
          slotIndex: index,
        },
      },
    });
  });
  return filaments;
}

function migrateModel(
  context: MigrationContext,
  candidate: NormalizedModelInput,
  filaments: PhysicalFilament[],
): ProjectObject | null {
  const record = isRecord(candidate.value) ? candidate.value : {};
  if (!isRecord(candidate.value)) {
    recover(
      context,
      'invalid-model-entry',
      candidate.path,
      'Model metadata is not an object; geometry was recovered with default metadata.',
      candidate.value,
      'repaired',
      'warning',
    );
  }
  const known =
    candidate.format === 'flat'
      ? [
          'legacyId',
          'name',
          'plateId',
          'geometry',
          'viewer',
          'display',
          'filamentSlot',
          'printable',
          'objectConfig',
          'volumeConfig',
        ]
      : ['plate', 'viewer', 'display', 'name', 'filamentSlot', 'legacyId'];
  captureUnknownFields(context, record, known, candidate.path);
  if (candidate.geometry === undefined) return null;
  const geometry = migrateGeometry(context, candidate.geometry, candidate.geometryPath, candidate.index);
  if (!geometry) {
    recover(
      context,
      'model-geometry-unrecoverable',
      candidate.path,
      'Model could not be mapped because it has no valid triangles.',
      candidate.value,
      'rejected',
      'error',
    );
    return null;
  }

  const legacyId = record.legacyId ?? geometry.legacyId ?? candidate.index;
  const name = repairedName(record.name, `Model ${candidate.index + 1}`, `${candidate.path}.name`, context);
  const viewer = migrateViewerTransform(record.viewer, `${candidate.path}.viewer`, context);
  const display = migrateDisplayTransform(record.display, geometry.bbox, `${candidate.path}.display`, context);
  let filamentId: PhysicalFilamentId | undefined;
  if (record.filamentSlot !== undefined) {
    const slot = integerNumber(record.filamentSlot);
    if (slot === undefined || slot < 0 || slot >= filaments.length) {
      recover(
        context,
        'invalid-model-filament-slot',
        `${candidate.path}.filamentSlot`,
        'Model filament slot does not reference a migrated palette entry; assignment was left unset.',
        record.filamentSlot,
        'rejected',
        'warning',
      );
    } else {
      filamentId = filaments[slot].id;
    }
  }

  const objectId = stableImportedId(context.adapter, 'object', [
    context.sourceKey,
    'object',
    snapshot(legacyId),
    candidate.index,
  ]);
  const volumeId = stableImportedId(context.adapter, 'volume', [context.sourceKey, 'volume', candidate.index]);
  const instanceId = stableImportedId(context.adapter, 'instance', [context.sourceKey, 'instance', candidate.index]);
  return {
    id: objectId,
    name,
    config: sanitizeConfig(record.objectConfig, `${candidate.path}.objectConfig`, context),
    ...(filamentId ? { filamentId } : {}),
    volumes: [
      {
        id: volumeId,
        name: `${name} body`,
        role: 'model',
        source: { assetId: geometry.assetId, topologyRevision: 0, triangleCount: geometry.triangleCount },
        transform: display,
        config: sanitizeConfig(record.volumeConfig, `${candidate.path}.volumeConfig`, context),
        annotations: emptyFacetAnnotations(0),
        extensionData: {
          legacyMigration: {
            sourceFilename: geometry.sourceFilename ?? null,
            geometryDigest: geometry.digest,
            displayOffsetWorldM: snapshot(record.display),
          },
        },
      },
    ],
    instances: [
      {
        id: instanceId,
        transform: viewer,
        printable: typeof record.printable === 'boolean' ? record.printable : true,
        extensionData: {
          legacyMigration: {
            viewerTransformWorld: snapshot(record.viewer),
          },
        },
      },
    ],
    layerRanges: [],
    extensionData: {
      legacyMigration: {
        adapter: context.adapter,
        sourceObjectIndex: candidate.index,
        legacyId: snapshot(legacyId),
      },
    },
  };
}

function migrateGeometry(
  context: MigrationContext,
  value: unknown,
  path: string,
  modelIndex: number,
): MigratedGeometry | null {
  const wrapper = isRecord(value) && 'positions' in value ? value : null;
  const positionsValue = wrapper ? wrapper.positions : value;
  if (wrapper) captureUnknownFields(context, wrapper, ['positions', 'legacyId', 'name', 'sourceFilename'], path);
  if (!isArrayLike(positionsValue)) {
    recover(
      context,
      'invalid-geometry-buffer',
      `${path}${wrapper ? '.positions' : ''}`,
      'Geometry positions are not an array-like numeric buffer.',
      positionsValue,
      'rejected',
      'error',
    );
    return null;
  }
  const positionsPath = `${path}${wrapper ? '.positions' : ''}`;
  const length = Number(positionsValue.length);
  if (!Number.isSafeInteger(length) || length < 0) {
    recover(
      context,
      'invalid-geometry-length',
      `${positionsPath}.length`,
      'Geometry length is not a non-negative safe integer.',
      positionsValue.length,
      'rejected',
      'error',
    );
    return null;
  }
  const output: number[] = [];
  const rejectedTriangles: JsonValue[] = [];
  const coerced: JsonValue[] = [];
  const precisionChanges: JsonValue[] = [];
  const completeLength = length - (length % 9);
  for (let base = 0; base < completeLength; base += 9) {
    const triangle: number[] = [];
    const originals: unknown[] = [];
    let valid = true;
    for (let offset = 0; offset < 9; offset += 1) {
      const original = positionsValue[base + offset];
      originals.push(original);
      const numeric = finiteNumber(original);
      if (numeric === undefined) {
        valid = false;
        continue;
      }
      if (typeof original !== 'number') {
        coerced.push({ index: base + offset, from: snapshot(original), to: numeric });
      }
      const float = Math.fround(numeric);
      if (!Object.is(float, numeric)) {
        precisionChanges.push({ index: base + offset, from: numeric, to: float });
      }
      triangle.push(float);
    }
    if (valid) output.push(...triangle);
    else rejectedTriangles.push({ triangle: base / 9, values: snapshot(originals) });
  }
  if (length !== completeLength) {
    recover(
      context,
      'trailing-geometry-components',
      positionsPath,
      'Trailing coordinates did not form a complete triangle and were retained in recovery.',
      Array.from({ length: length - completeLength }, (_, index) => positionsValue[completeLength + index]),
      'rejected',
      'warning',
    );
  }
  if (rejectedTriangles.length > 0) {
    recover(
      context,
      'invalid-geometry-triangles',
      positionsPath,
      'Triangles containing non-finite or non-numeric coordinates were retained in recovery and omitted.',
      rejectedTriangles,
      'rejected',
      'error',
    );
  }
  if (coerced.length > 0) {
    recover(
      context,
      'numeric-geometry-coercion',
      positionsPath,
      'Numeric string coordinates were converted explicitly.',
      coerced,
      'repaired',
      'warning',
    );
  }
  if (precisionChanges.length > 0) {
    recover(
      context,
      'geometry-float32-quantization',
      positionsPath,
      'Higher-precision coordinates were quantized to the canonical float32 mesh layout.',
      precisionChanges,
      'repaired',
      'info',
    );
  }
  if (output.length === 0) return null;

  const bytes = float32LittleEndianBytes(output);
  const digest = contentDigest(bytes);
  const candidates = context.assetsByDigest.get(digest) ?? [];
  const existing = candidates.find((candidate) => equalBytes(candidate.bytes, bytes));
  const sourceFilename = optionalRawString(wrapper?.sourceFilename);
  const legacyId = wrapper?.legacyId === undefined ? undefined : snapshot(wrapper.legacyId);
  if (existing) {
    diagnostic(
      context,
      'geometry-deduplicated',
      path,
      `Geometry reuses immutable asset ${existing.descriptor.id}.`,
      'info',
      true,
    );
    return {
      assetId: existing.descriptor.id,
      triangleCount: output.length / 9,
      bbox: boundsOf(output),
      digest,
      sourceFilename,
      legacyId,
    };
  }

  const collisionKey = stableUnknownDigest(Array.from(bytes));
  const assetId = stableImportedId('legacy-mesh-v1', 'asset', [digest, bytes.byteLength, collisionKey]);
  const descriptor: SourceAssetDescriptor = {
    id: assetId,
    kind: 'mesh',
    digest,
    byteLength: bytes.byteLength,
    mediaType: 'application/vnd.orcaxr.non-indexed-triangle-mesh',
    ...(sourceFilename ? { sourceFilename } : {}),
    provenance: {
      source: 'import',
      uri: context.source.uri ?? `${context.adapter}:${context.sourceKey}#geometry-${modelIndex}`,
      importedAt: context.timestamp,
    },
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: bytes.byteLength,
        componentType: 'float32',
        componentCount: 3,
        count: output.length / 3,
      },
      triangleCount: output.length / 9,
    },
  };
  context.repository.put(descriptor, bytes);
  const payload = context.repository.get(assetId);
  if (!payload) throw new Error(`Failed to retain migrated asset ${assetId}`);
  candidates.push(payload);
  context.assetsByDigest.set(digest, candidates);
  return {
    assetId,
    triangleCount: output.length / 9,
    bbox: boundsOf(output),
    digest,
    sourceFilename,
    legacyId,
  };
}

function migrateViewerTransform(value: unknown, path: string, context: MigrationContext): Transform {
  if (value === undefined || value === null) return identityTransform();
  if (!isRecord(value)) {
    recover(
      context,
      'invalid-viewer-transform',
      path,
      'Viewer transform is not an object; identity was used.',
      value,
      'repaired',
      'warning',
    );
    return identityTransform();
  }
  captureUnknownFields(context, value, ['position', 'quaternion', 'scale'], path);
  const position = repairedTuple(value.position, 3, [0, 0, 0], `${path}.position`, context);
  const quaternion = normalizeQuaternion(
    repairedTuple(value.quaternion, 4, [0, 0, 0, 1], `${path}.quaternion`, context),
    `${path}.quaternion`,
    context,
  );
  const legacyScale = repairedTuple(value.scale, 3, [1, 1, 1], `${path}.scale`, context).map((component, index) => {
    if (Math.abs(component) >= 1e-12) return component;
    recover(
      context,
      'zero-viewer-scale',
      `${path}.scale[${index}]`,
      'Zero scale is not invertible and was repaired to 1.',
      component,
      'repaired',
      'warning',
    );
    return 1;
  }) as [number, number, number];
  return {
    translationMm: worldVectorToPrinterMm(position, context, true),
    rotation: legacyQuaternionToPrinter(quaternion),
    scale: [legacyScale[0], legacyScale[2], legacyScale[1]],
  };
}

function migrateDisplayTransform(
  value: unknown,
  bbox: { min: Vec3; max: Vec3 },
  path: string,
  context: MigrationContext,
): Transform {
  let display: [number, number, number];
  if (value === undefined || value === null) {
    const vis = context.worldMetresPerPrinterMm;
    display = [(-(bbox.min[0] + bbox.max[0]) / 2) * vis, -bbox.min[2] * vis, ((bbox.min[1] + bbox.max[1]) / 2) * vis];
    diagnostic(
      context,
      'display-offset-derived',
      path,
      'Missing legacy display centering was deterministically derived from the geometry bounds.',
      'info',
      true,
    );
  } else {
    display = repairedTuple(value, 3, [0, 0, 0], path, context);
  }
  return {
    translationMm: worldVectorToPrinterMm(display, context, false),
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function worldVectorToPrinterMm(value: readonly number[], context: MigrationContext, includeOrigin: boolean): Vec3 {
  const divisor = context.worldMetresPerPrinterMm;
  const origin = includeOrigin ? context.originOffsetMm : ([0, 0, 0] as const);
  return [value[0] / divisor + origin[0], -value[2] / divisor + origin[1], value[1] / divisor + origin[2]];
}

/** Conjugate legacy Y-up rotation by +90 degrees around X into printer Z-up. */
function legacyQuaternionToPrinter(value: readonly number[]): readonly [number, number, number, number] {
  const rootHalf = Math.SQRT1_2;
  const basis: [number, number, number, number] = [rootHalf, 0, 0, rootHalf];
  const inverse: [number, number, number, number] = [-rootHalf, 0, 0, rootHalf];
  return quaternionMultiply(quaternionMultiply(basis, value), inverse);
}

function quaternionMultiply(left: readonly number[], right: readonly number[]): [number, number, number, number] {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ];
}

function normalizeQuaternion(
  tuple: [number, number, number, number],
  path: string,
  context: MigrationContext,
): [number, number, number, number] {
  const norm = Math.hypot(...tuple);
  if (!Number.isFinite(norm) || norm < 1e-12) {
    recover(
      context,
      'zero-viewer-quaternion',
      path,
      'Zero or invalid quaternion was repaired to identity.',
      tuple,
      'repaired',
      'warning',
    );
    return [0, 0, 0, 1];
  }
  if (Math.abs(norm - 1) <= 1e-9) return tuple;
  const normalized = tuple.map((component) => component / norm) as [number, number, number, number];
  recover(
    context,
    'viewer-quaternion-normalized',
    path,
    'Non-unit quaternion was normalized.',
    { from: tuple, to: normalized },
    'repaired',
    'info',
  );
  return normalized;
}

function createContext(
  adapter: LegacyMigrationAdapterId,
  seed: unknown,
  options: LegacyMigrationOptions,
): MigrationContext {
  const source = options.source ?? {};
  const derivedSourceKey = `payload-${stableUnknownDigest(seed)}`;
  const sourceKey = source.sourceKey?.trim() || source.uri?.trim() || derivedSourceKey;
  const timestampCandidate = source.importedAt ?? options.migratedAt;
  const timestamp = validTimestamp(timestampCandidate) ?? DEFAULT_MIGRATION_TIME;
  const worldScale =
    Number.isFinite(options.legacyWorldMetresPerPrinterMm) && (options.legacyWorldMetresPerPrinterMm ?? 0) > 0
      ? options.legacyWorldMetresPerPrinterMm!
      : DEFAULT_WORLD_METRES_PER_PRINTER_MM;
  const origin = repairOptionOrigin(options.originOffsetMm);
  const context: MigrationContext = {
    adapter,
    source,
    sourceKey,
    timestamp,
    worldMetresPerPrinterMm: worldScale,
    originOffsetMm: origin,
    diagnostics: [],
    recoveryEntries: [],
    repository: new InMemoryAssetRepository(),
    assetsByDigest: new Map(),
  };
  if (!timestampCandidate || !validTimestamp(timestampCandidate)) {
    diagnostic(
      context,
      'migration-time-defaulted',
      'createdAt',
      `No valid persisted import time was available; ${DEFAULT_MIGRATION_TIME} keeps reruns deterministic.`,
      'info',
      true,
    );
  }
  if (
    options.legacyWorldMetresPerPrinterMm !== undefined &&
    (!Number.isFinite(options.legacyWorldMetresPerPrinterMm) || options.legacyWorldMetresPerPrinterMm <= 0)
  ) {
    recover(
      context,
      'invalid-legacy-world-scale',
      'options.legacyWorldMetresPerPrinterMm',
      `Invalid legacy scale was repaired to ${DEFAULT_WORLD_METRES_PER_PRINTER_MM}.`,
      options.legacyWorldMetresPerPrinterMm,
      'repaired',
      'warning',
    );
  }
  if (options.originOffsetMm && origin.some((component, index) => component !== options.originOffsetMm![index])) {
    recover(
      context,
      'invalid-origin-offset',
      'options.originOffsetMm',
      'Non-finite origin components were repaired to zero.',
      options.originOffsetMm,
      'repaired',
      'warning',
    );
  }
  return context;
}

function createRecoveredPlate(
  context: MigrationContext,
  plates: ProjectPlate[],
  key: string,
  name: string,
): ProjectPlate {
  const plate: ProjectPlate = {
    id: stableImportedId(context.adapter, 'plate', [context.sourceKey, 'recovered-plate', key]),
    name,
    order: plates.length,
    printable: true,
    config: {},
    objects: [],
    extensionData: { legacyMigration: { adapter: context.adapter, recovered: true, reference: key } },
  };
  plates.push(plate);
  return plate;
}

function indexLoosePlate(map: Map<string, ProjectPlate | null>, reference: unknown, plate: ProjectPlate): void {
  const key = String(reference);
  if (!map.has(key)) map.set(key, plate);
  else if (map.get(key) !== plate) map.set(key, null);
}

function referenceKey(value: unknown): string {
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'string') return `string:${value}`;
  return `${typeof value}:${stableUnknownDigest(value)}`;
}

function readArray(value: unknown, path: string, context: MigrationContext): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  recover(
    context,
    'invalid-list',
    path,
    'Expected an array; the value was retained in recovery.',
    value,
    'rejected',
    'error',
  );
  return [];
}

function sanitizeConfig(value: unknown, path: string, context: MigrationContext): ConfigMap {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    recover(
      context,
      'invalid-config-map',
      path,
      'Configuration is not an object and was retained in recovery.',
      value,
      'rejected',
      'warning',
    );
    return {};
  }
  const result: ConfigMap = {};
  const active = new WeakSet<object>();
  for (const [key, child] of Object.entries(value)) {
    if (!key.trim()) {
      recover(
        context,
        'empty-config-key',
        path,
        'Configuration entry with an empty key was retained in recovery.',
        { key, value: snapshot(child) },
        'rejected',
        'warning',
      );
      continue;
    }
    const migrated = sanitizeJson(child, `${path}.${key}`, context, active);
    if (migrated !== undefined) result[key] = migrated;
  }
  return result;
}

function sanitizeJson(
  value: unknown,
  path: string,
  context: MigrationContext,
  active: WeakSet<object>,
): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
  } else if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = sanitizeJson(value[index], `${path}[${index}]`, context, active);
      if (child !== undefined) output.push(child);
    }
    return output;
  } else if (isRecord(value)) {
    if (active.has(value)) {
      recover(context, 'cyclic-config', path, 'Cyclic configuration value was rejected.', value, 'rejected', 'warning');
      return undefined;
    }
    active.add(value);
    const output: Record<string, JsonValue> = {};
    for (const [key, childValue] of Object.entries(value)) {
      const child = sanitizeJson(childValue, `${path}.${key}`, context, active);
      if (child !== undefined) output[key] = child;
    }
    active.delete(value);
    return output;
  }
  recover(
    context,
    'non-json-config-value',
    path,
    'Non-JSON configuration value was retained in recovery.',
    value,
    'rejected',
    'warning',
  );
  return undefined;
}

function repairedTuple<const Length extends 3 | 4>(
  value: unknown,
  length: Length,
  fallback: Length extends 3 ? [number, number, number] : [number, number, number, number],
  path: string,
  context: MigrationContext,
): Length extends 3 ? [number, number, number] : [number, number, number, number] {
  const result = [...fallback] as number[];
  if (!isArrayLike(value)) {
    recover(
      context,
      'invalid-transform-tuple',
      path,
      `Expected ${length} finite components; defaults were used.`,
      value,
      'repaired',
      'warning',
    );
    return result as Length extends 3 ? [number, number, number] : [number, number, number, number];
  }
  let repaired = Number(value.length) !== length;
  for (let index = 0; index < length; index += 1) {
    const number = finiteNumber(value[index]);
    if (number === undefined) repaired = true;
    else result[index] = number;
  }
  if (repaired) {
    recover(
      context,
      'invalid-transform-tuple',
      path,
      `Invalid transform components were repaired against a ${length}-component default.`,
      value,
      'repaired',
      'warning',
    );
  }
  return result as Length extends 3 ? [number, number, number] : [number, number, number, number];
}

function repairedName(value: unknown, fallback: string, path: string, context: MigrationContext): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim()) return value.trim();
  recover(
    context,
    'invalid-name',
    path,
    `Invalid or empty name was repaired to "${fallback}".`,
    value,
    'repaired',
    'warning',
  );
  return fallback;
}

function optionalString(value: unknown, path: string, context: MigrationContext): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  recover(
    context,
    'invalid-string',
    path,
    'Expected a non-empty string; the value was retained in recovery.',
    value,
    'rejected',
    'warning',
  );
  return undefined;
}

function optionalRawString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeColor(value: unknown, path: string, context: MigrationContext): string {
  if (typeof value !== 'string') {
    recover(
      context,
      'invalid-filament-color',
      path,
      `Invalid color was repaired to ${DEFAULT_FILAMENT_COLOR}.`,
      value,
      'repaired',
      'warning',
    );
    return DEFAULT_FILAMENT_COLOR;
  }
  const original = value;
  let color = value.trim().toLowerCase();
  if (!color.startsWith('#')) color = `#${color}`;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    color = `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  if (/^#[0-9a-f]{8}$/.test(color)) color = color.slice(0, 7);
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    recover(
      context,
      'invalid-filament-color',
      path,
      `Invalid color was repaired to ${DEFAULT_FILAMENT_COLOR}.`,
      original,
      'repaired',
      'warning',
    );
    return DEFAULT_FILAMENT_COLOR;
  }
  if (color !== original) {
    recover(
      context,
      'filament-color-normalized',
      path,
      `Legacy color was normalized to ${color}.`,
      { from: original, to: color },
      'repaired',
      'info',
    );
  }
  return color;
}

function boundsOf(positions: readonly number[]): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let component = 0; component < 3; component += 1) {
      min[component] = Math.min(min[component], positions[index + component]);
      max[component] = Math.max(max[component], positions[index + component]);
    }
  }
  return { min, max };
}

function float32LittleEndianBytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function integerNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function repairOptionOrigin(value: Vec3 | undefined): Vec3 {
  if (!value) return [0, 0, 0];
  return value.map((component) => (Number.isFinite(component) ? component : 0)) as unknown as Vec3;
}

function stripProjectExtension(filename: string): string {
  const stripped = filename.replace(/\.(?:3mf|json)$/i, '').trim();
  return stripped || 'Migrated OrcaXR project';
}

function captureUnknownFields(
  context: MigrationContext,
  value: Record<string, unknown>,
  knownFields: readonly string[],
  path: string,
): void {
  const known = new Set(knownFields);
  for (const [key, child] of Object.entries(value)) {
    if (known.has(key)) continue;
    recover(
      context,
      'unmapped-legacy-field',
      path === '$' ? `$.${key}` : `${path}.${key}`,
      'Field has no canonical v1 mapping and was retained in the recovery payload.',
      child,
      'unmapped',
      'info',
    );
  }
}

function diagnostic(
  context: MigrationContext,
  code: string,
  path: string,
  message: string,
  severity: MigrationDiagnosticSeverity,
  repaired: boolean,
  recoveryEntry?: number,
): void {
  context.diagnostics.push({
    severity,
    code,
    path,
    message,
    repaired,
    ...(recoveryEntry === undefined ? {} : { recoveryEntry }),
  });
}

function recover(
  context: MigrationContext,
  code: string,
  path: string,
  message: string,
  value: unknown,
  disposition: MigrationRecoveryDisposition,
  severity: MigrationDiagnosticSeverity,
): void {
  const recoveryEntry = context.recoveryEntries.length;
  context.recoveryEntries.push({ path, reason: message, disposition, value: snapshot(value) });
  diagnostic(context, code, path, message, severity, disposition === 'repaired', recoveryEntry);
}

function snapshot(value: unknown, active = new WeakMap<object, string>(), path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return { $legacyType: 'number', value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
  }
  if (typeof value === 'undefined') return { $legacyType: 'undefined' };
  if (typeof value === 'bigint') return { $legacyType: 'bigint', value: value.toString() };
  if (typeof value === 'symbol') return { $legacyType: 'symbol', value: String(value) };
  if (typeof value === 'function') return { $legacyType: 'function', value: String(value) };
  if (Array.isArray(value)) {
    if (active.has(value)) return { $legacyType: 'cycle', target: active.get(value)! };
    active.set(value, path);
    const output = value.map((child, index) => snapshot(child, active, `${path}[${index}]`));
    active.delete(value);
    return output;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      $legacyType: value.constructor.name,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { $legacyType: 'ArrayBuffer', bytes: Array.from(new Uint8Array(value)) };
  }
  const object = value as Record<string, unknown>;
  const prior = active.get(object);
  if (prior) return { $legacyType: 'cycle', target: prior };
  active.set(object, path);
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(object).sort()) output[key] = snapshot(object[key], active, `${path}.${key}`);
  active.delete(object);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  if (value === null || value === undefined || typeof value === 'string') return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return true;
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    'length' in value &&
    Number.isSafeInteger(Number((value as { length: unknown }).length))
  );
}

// Compile-time checks that the runtime adapter contracts stay aligned with the
// legacy types without importing UI/Three.js into the canonical project layer.
type _LegacyGeometryContract = LegacyGeometryInputV1;
type _LegacyViewerContract = LegacyViewerTransformV1;
type _LegacyFilamentContract = LegacyFilamentSlotV1;
