import { InMemoryAssetRepository, contentDigest, type AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, fnv1a64 } from '../domain/canonical';
import { entityId, type AssetId } from '../domain/ids';
import type { ExtensionBlob, ProjectState, SourceAssetDescriptor } from '../domain/model';
import { refinementNodeBudget } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import type { CancellationToken, ProjectArchiveSnapshot, ProjectSerializerPort, SerializedProject } from '../ports';
import {
  CORE_MODEL_PATH,
  GENERATED_STANDARD_PATHS,
  LAYER_EVENTS_PATH,
  LAYER_RANGES_PATH,
  MODEL_RELS_PATH,
  MODEL_SETTINGS_PATH,
  PROJECT_SETTINGS_PATH,
  BbsPlateCoordinateError,
  buildBbsCore,
  importBbsCore,
} from './bbsCore';
import { readSafeZip, validatePackagePath, writeDeterministicZip, type ZipSafetyLimits } from './deterministicZip';

export { BbsPlateCoordinateError, type BbsPlateCoordinateErrorCode } from './bbsCore';

export const ORCAXR_EXTENSION_PATH = 'Metadata/orcaxr/project-v1.json';
export const ORCAXR_EXTENSION_FORMAT = 'https://orcaxr.martinez.fyi/3mf/project/1';

const CONTENT_TYPES_PATH = '[Content_Types].xml';
const ROOT_RELATIONSHIPS_PATH = '_rels/.rels';
const OPC_RELATIONSHIPS_KEY = `${ORCAXR_EXTENSION_FORMAT}/opc-relationships`;
const OPC_CONTENT_TYPES_KEY = `${ORCAXR_EXTENSION_FORMAT}/opc-content-types`;
const PRESERVABLE_GENERATED_METADATA = new Set([
  PROJECT_SETTINGS_PATH,
  MODEL_SETTINGS_PATH,
  LAYER_RANGES_PATH,
  LAYER_EVENTS_PATH,
]);

interface PreservedOpcRelationship {
  source: '/' | typeof CORE_MODEL_PATH;
  id: string;
  type: string;
  target: string;
  targetMode: 'Internal' | 'External';
}

type PreservedContentType =
  | { kind: 'default'; extension: string; contentType: string }
  | { kind: 'override'; partName: string; contentType: string };

interface CanonicalExtensionEnvelope {
  format: typeof ORCAXR_EXTENSION_FORMAT;
  version: 1;
  state: ProjectState;
  assetEntries: Array<{ assetId: AssetId; path: string }>;
}

export interface Bbs3mfProjectSerializerOptions {
  zipLimits?: Partial<ZipSafetyLimits>;
  /** Optional stricter cap for constrained import surfaces; never exceeds the canonical hard limit. */
  maxImportedFacetRefinementNodes?: number;
  /** Optional stricter cap on annotation payload cloned through expanded component graphs. */
  maxImportedFacetAnnotationMaterializationUnits?: number;
}

/**
 * Browser-compatible 3MF adapter. The standard/BBS projection is deliberately
 * secondary to the namespaced canonical envelope: OrcaXR can round-trip every
 * canonical field even when BBS has no exact representation for that field.
 */
export class Bbs3mfProjectSerializer implements ProjectSerializerPort {
  private readonly zipLimits: Partial<ZipSafetyLimits>;
  private readonly maxImportedFacetRefinementNodes: number | undefined;
  private readonly maxImportedFacetAnnotationMaterializationUnits: number | undefined;

  constructor(options: Bbs3mfProjectSerializerOptions = {}) {
    this.zipLimits = { ...options.zipLimits };
    this.maxImportedFacetRefinementNodes = options.maxImportedFacetRefinementNodes;
    this.maxImportedFacetAnnotationMaterializationUnits = options.maxImportedFacetAnnotationMaterializationUnits;
  }

  async serialize(snapshot: ProjectArchiveSnapshot, cancellation?: CancellationToken): Promise<SerializedProject> {
    throwIfCancelled(cancellation);
    assertSafeJsonTree(snapshot.state, 'project state', projectStateJsonNodeBudget(snapshot.state));
    assertValidProjectState(snapshot.state);
    const warnings: string[] = [];
    const payloads = validateSnapshotAssets(snapshot, warnings);
    const projection = buildBbsCore(snapshot.state, payloads);
    warnings.push(...projection.warnings);
    const files = new Map(projection.files);
    const assetEntries = writeAssetEntries(snapshot.state, payloads, files);
    writeExtensionBlobs(snapshot.state, payloads, files, warnings);
    files.set(MODEL_RELS_PATH, encodeText(buildPartRelationships(snapshot.state, CORE_MODEL_PATH, files)));

    const envelope: CanonicalExtensionEnvelope = {
      format: ORCAXR_EXTENSION_FORMAT,
      version: 1,
      state: cloneJson(snapshot.state),
      assetEntries,
    };
    files.set(ORCAXR_EXTENSION_PATH, encodeText(`${canonicalStringify(envelope)}\n`));
    files.set(ROOT_RELATIONSHIPS_PATH, encodeText(buildRootRelationships(snapshot.state, files, warnings)));
    files.set(CONTENT_TYPES_PATH, encodeText(buildContentTypes(files, snapshot.state)));
    throwIfCancelled(cancellation);
    const bytes = writeDeterministicZip(files, this.zipLimits);
    throwIfCancelled(cancellation);
    return {
      bytes,
      mediaType: 'model/3mf',
      suggestedFilename: suggestedFilename(snapshot.state.name),
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
      warnings: uniqueSorted(warnings),
    };
  }

  async deserialize(
    bytes: Uint8Array,
    cancellation?: CancellationToken,
  ): Promise<{ state: ProjectState; assets: AssetPayload[]; warnings: string[] }> {
    throwIfCancelled(cancellation);
    const files = readSafeZip(bytes, this.zipLimits);
    throwIfCancelled(cancellation);
    const archiveHash = fnv1a64(bytes);
    const extension = files.get(ORCAXR_EXTENSION_PATH);
    const result = extension
      ? this.deserializeCanonical(files, extension, archiveHash)
      : this.deserializeForeign(files, archiveHash);
    throwIfCancelled(cancellation);
    return result;
  }

  private deserializeCanonical(
    files: ReadonlyMap<string, Uint8Array>,
    extensionBytes: Uint8Array,
    archiveHash: string,
  ): { state: ProjectState; assets: AssetPayload[]; warnings: string[] } {
    const envelope = parseEnvelope(extensionBytes);
    const state = cloneJson(envelope.state);
    const warnings: string[] = [];
    const legacyFalseFuzzyAssignments = countLegacyFalseFuzzyAssignments(state);
    if (legacyFalseFuzzyAssignments > 0) {
      const validationState = cloneJson(state);
      coerceLegacyFalseFuzzyAssignments(validationState);
      assertValidProjectState(validationState);
      removeLegacyFalseFuzzyAssignments(state);
      warnings.push(
        `Removed ${legacyFalseFuzzyAssignments} legacy false fuzzy-skin facet assignment${
          legacyFalseFuzzyAssignments === 1 ? '' : 's'
        }; false represented the inherited/unpainted state`,
      );
    }
    assertValidProjectState(state);
    mergePackageRelationships(state, files, warnings);
    mergePackageContentTypes(state, files, warnings);
    const descriptors = new Map(state.sourceAssets.map((entry) => [entry.id, entry]));
    const mappings = new Map<AssetId, string>();
    const paths = new Set<string>();
    for (const mapping of envelope.assetEntries) {
      if (mappings.has(mapping.assetId)) {
        throw new Error(`OrcaXR metadata contains duplicate asset ${mapping.assetId}`);
      }
      if (!descriptors.has(mapping.assetId)) {
        throw new Error(`OrcaXR metadata maps undeclared asset ${mapping.assetId}`);
      }
      validatePackagePath(mapping.path);
      if (isStructuralPath(mapping.path)) {
        throw new Error(`OrcaXR asset ${mapping.assetId} aliases structural entry ${mapping.path}`);
      }
      if (paths.has(mapping.path)) {
        throw new Error(`OrcaXR metadata maps multiple assets to ${mapping.path}`);
      }
      mappings.set(mapping.assetId, mapping.path);
      paths.add(mapping.path);
    }
    if (mappings.size !== descriptors.size) {
      const missing = state.sourceAssets.find((descriptor) => !mappings.has(descriptor.id));
      throw new Error(`OrcaXR metadata has no package entry for asset ${missing?.id ?? ''}`);
    }

    const repository = new InMemoryAssetRepository();
    for (const descriptor of state.sourceAssets) {
      const path = mappings.get(descriptor.id)!;
      const payload = files.get(path);
      if (!payload) throw new Error(`3MF is missing canonical asset entry ${path}`);
      verifyAssetDigest(descriptor, payload, warnings);
      repository.put(descriptor, payload);
    }

    const owned = new Set<string>([...GENERATED_STANDARD_PATHS, ORCAXR_EXTENSION_PATH, ...mappings.values()]);
    const preserveOriginalPaths = new Set<string>();
    let regenerated: ReadonlyMap<string, Uint8Array> = new Map();
    try {
      regenerated = buildBbsCore(
        state,
        new Map(repository.list().map((payload) => [payload.descriptor.id, payload])),
      ).files;
    } catch (error) {
      if (!(error instanceof BbsPlateCoordinateError)) throw error;
      warnings.push(
        `Opened the canonical OrcaXR envelope safely, but standard BBS metadata cannot be regenerated until its plate coordinates are resolvable: ${error.message}`,
      );
    }
    const declaredBlobPaths = new Set(state.extensionBlobs.map((blob) => blob.path));
    for (const path of PRESERVABLE_GENERATED_METADATA) {
      const packageBytes = files.get(path);
      const expectedBytes = regenerated.get(path);
      if (
        packageBytes &&
        !declaredBlobPaths.has(path) &&
        (!expectedBytes || !equalBytes(packageBytes, expectedBytes))
      ) {
        owned.delete(path);
        preserveOriginalPaths.add(path);
        warnings.push(`Detected externally modified ${path}; preserving its original bytes as opaque BBS metadata`);
      }
    }
    for (const blob of state.extensionBlobs) {
      validatePackagePath(blob.path);
      const payload = repository.get(blob.assetId);
      if (!payload) throw new Error(`Extension ${blob.id} references missing asset ${blob.assetId}`);
      const packageBytes = files.get(blob.path);
      if (!packageBytes) throw new Error(`3MF is missing extension entry ${blob.path}`);
      if (!equalBytes(payload.bytes, packageBytes)) {
        throw new Error(`Extension entry ${blob.path} differs from its canonical asset payload`);
      }
      owned.add(blob.path);
    }

    preserveUnownedEntries(state, repository, files, owned, archiveHash, warnings, preserveOriginalPaths);
    assertValidProjectState(state);
    return { state, assets: repository.list(), warnings: uniqueSorted(warnings) };
  }

  private deserializeForeign(
    files: ReadonlyMap<string, Uint8Array>,
    archiveHash: string,
  ): { state: ProjectState; assets: AssetPayload[]; warnings: string[] } {
    const imported = importBbsCore(files, archiveHash, {
      ...(this.maxImportedFacetRefinementNodes !== undefined
        ? { maxFacetRefinementNodes: this.maxImportedFacetRefinementNodes }
        : {}),
      ...(this.maxImportedFacetAnnotationMaterializationUnits !== undefined
        ? { maxFacetAnnotationMaterializationUnits: this.maxImportedFacetAnnotationMaterializationUnits }
        : {}),
    });
    const state = imported.state;
    mergePackageRelationships(state, files, imported.warnings);
    mergePackageContentTypes(state, files, imported.warnings);
    const repository = new InMemoryAssetRepository();
    for (const payload of imported.assets) repository.put(payload.descriptor, payload.bytes);
    // A consumed path that the canonical writer regenerates is owned from here
    // on. Preserving it as an opaque blob as well would put the original bytes
    // back over the generated file on save, silently discarding every edit —
    // and, for model_settings.config, reinstating object ids the regenerated
    // core no longer has, which makes the pinned engine reject the archive.
    // A consumed path the writer does *not* regenerate is still the only
    // carrier of that data, so it stays preserved.
    const excluded = new Set([CONTENT_TYPES_PATH, ROOT_RELATIONSHIPS_PATH, CORE_MODEL_PATH, MODEL_RELS_PATH]);
    let regeneratedPaths: ReadonlySet<string> = new Set();
    try {
      regeneratedPaths = new Set(
        buildBbsCore(state, new Map(repository.list().map((payload) => [payload.descriptor.id, payload]))).files.keys(),
      );
    } catch (error) {
      if (!(error instanceof BbsPlateCoordinateError)) throw error;
      imported.warnings.push(
        `Imported metadata is preserved as-is because standard BBS metadata cannot be regenerated yet: ${error.message}`,
      );
    }
    for (const path of imported.consumedPaths) {
      if (regeneratedPaths.has(path)) excluded.add(path);
    }
    preserveUnownedEntries(state, repository, files, excluded, archiveHash, imported.warnings);
    assertValidProjectState(state);
    return {
      state,
      assets: repository.list(),
      warnings: uniqueSorted(imported.warnings),
    };
  }
}

function validateSnapshotAssets(snapshot: ProjectArchiveSnapshot, warnings: string[]): Map<string, AssetPayload> {
  const expected = new Map(snapshot.state.sourceAssets.map((entry) => [entry.id, entry]));
  const payloads = new Map<string, AssetPayload>();
  for (const payload of snapshot.assets) {
    if (payloads.has(payload.descriptor.id)) {
      throw new Error(`Project bundle contains duplicate asset ${payload.descriptor.id}`);
    }
    const descriptor = expected.get(payload.descriptor.id);
    if (!descriptor) throw new Error(`Project bundle contains undeclared asset ${payload.descriptor.id}`);
    if (canonicalStringify(descriptor) !== canonicalStringify(payload.descriptor)) {
      throw new Error(`Project bundle metadata differs for source asset ${descriptor.id}`);
    }
    verifyAssetDigest(descriptor, payload.bytes, warnings);
    payloads.set(payload.descriptor.id, {
      descriptor: cloneJson(payload.descriptor),
      bytes: payload.bytes.slice(),
    });
  }
  for (const descriptor of snapshot.state.sourceAssets) {
    if (!payloads.has(descriptor.id)) {
      throw new Error(`Project bundle is missing source asset ${descriptor.id}`);
    }
  }
  return payloads;
}

function writeAssetEntries(
  state: ProjectState,
  payloads: ReadonlyMap<string, AssetPayload>,
  files: Map<string, Uint8Array>,
): CanonicalExtensionEnvelope['assetEntries'] {
  const candidatesByAsset = new Map<string, string[]>();
  for (const blob of state.extensionBlobs) {
    const candidates = candidatesByAsset.get(blob.assetId) ?? [];
    candidates.push(blob.path);
    candidatesByAsset.set(blob.assetId, candidates);
  }
  const thumbnailsByAsset = new Map(state.thumbnails.map((thumbnail) => [thumbnail.assetId, thumbnail]));
  const used = new Set([...files.keys(), CONTENT_TYPES_PATH, ROOT_RELATIONSHIPS_PATH, ORCAXR_EXTENSION_PATH]);
  return [...state.sourceAssets]
    .sort((left, right) => compareText(left.id, right.id))
    .map((descriptor, index) => {
      const payload = payloads.get(descriptor.id)!;
      let path: string | undefined;
      const opaqueCandidates = [...(candidatesByAsset.get(descriptor.id) ?? [])].sort(compareText);
      for (const candidate of opaqueCandidates) {
        validatePackagePath(candidate);
        if (!used.has(candidate) && !isStructuralPath(candidate)) {
          path = candidate;
          break;
        }
      }
      const thumbnail = thumbnailsByAsset.get(descriptor.id);
      if (!path && thumbnail && descriptor.mediaType === 'image/png') {
        const plate = thumbnail.plateId
          ? state.plates.find((candidate) => candidate.id === thumbnail.plateId)
          : undefined;
        const number = (plate?.order ?? state.thumbnails.indexOf(thumbnail)) + 1;
        const candidate = `Metadata/plate_${number}.png`;
        if (!used.has(candidate)) path = candidate;
      }
      if (!path) {
        const digestLabel = descriptor.digest.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'asset';
        const digest = `${digestLabel.slice(0, 64)}-${fnv1a64(encodeText(descriptor.digest))}`;
        const extension = extensionForAsset(descriptor);
        path = `Metadata/orcaxr/assets/${String(index + 1).padStart(4, '0')}-${digest}.${extension}`;
      }
      validatePackagePath(path);
      if (used.has(path)) throw new Error(`Canonical asset path collision at ${path}`);
      used.add(path);
      files.set(path, payload.bytes.slice());
      return { assetId: descriptor.id, path };
    });
}

function writeExtensionBlobs(
  state: ProjectState,
  payloads: ReadonlyMap<string, AssetPayload>,
  files: Map<string, Uint8Array>,
  warnings: string[],
): void {
  const paths = new Set<string>();
  const sorted = [...state.extensionBlobs].sort(
    (left, right) => compareText(left.path, right.path) || compareText(left.id, right.id),
  );
  for (const blob of sorted) {
    validatePackagePath(blob.path);
    if (paths.has(blob.path)) throw new Error(`Project has duplicate extension path ${blob.path}`);
    paths.add(blob.path);
    if (isStructuralPath(blob.path) && !PRESERVABLE_GENERATED_METADATA.has(blob.path)) {
      throw new Error(`Extension ${blob.id} cannot replace structural entry ${blob.path}`);
    }
    const payload = payloads.get(blob.assetId);
    if (!payload) throw new Error(`Extension ${blob.id} references missing asset ${blob.assetId}`);
    const existing = files.get(blob.path);
    if (!existing) {
      files.set(blob.path, payload.bytes.slice());
      continue;
    }
    if (equalBytes(existing, payload.bytes)) continue;
    if (PRESERVABLE_GENERATED_METADATA.has(blob.path) && blob.relationships.includes('orcaxr:preserve-original')) {
      files.set(blob.path, payload.bytes.slice());
      warnings.push(
        `Preserved original ${blob.path} byte-for-byte; OrcaXR canonical metadata remains authoritative for edits that the BBS fallback importer could not merge safely`,
      );
      continue;
    }
    throw new Error(`Extension path ${blob.path} conflicts with generated 3MF content`);
  }
}

function preserveUnownedEntries(
  state: ProjectState,
  repository: InMemoryAssetRepository,
  files: ReadonlyMap<string, Uint8Array>,
  ownedOrExcluded: ReadonlySet<string>,
  archiveHash: string,
  warnings: string[],
  preserveOriginalPaths: ReadonlySet<string> = new Set(),
): void {
  const occupiedIds = collectIds(state);
  const occupiedPaths = new Set(state.extensionBlobs.map((blob) => blob.path));
  const entries = [...files.entries()].sort(([left], [right]) => compareText(left, right));
  let ordinal = 0;
  for (const [path, bytes] of entries) {
    if (ownedOrExcluded.has(path) || occupiedPaths.has(path)) continue;
    validatePackagePath(path);
    ordinal += 1;
    const token = `${fnv1a64(encodeText(path))}-${ordinal}`;
    const assetId = uniqueImportedId<'asset'>(`import:zip:${archiveHash}-asset-${token}`, occupiedIds);
    const descriptor: SourceAssetDescriptor = {
      id: assetId,
      kind: inferAssetKind(path),
      digest: contentDigest(bytes),
      byteLength: bytes.byteLength,
      mediaType: mediaTypeForPath(path),
      sourceFilename: path,
      provenance: { source: 'import', uri: `3mf:${path}` },
    };
    repository.put(descriptor, bytes);
    state.sourceAssets.push(descriptor);
    const thumbnail = standardPlateThumbnail(path, bytes, state);
    if (thumbnail) {
      state.thumbnails.push({
        id: uniqueImportedId<'thumbnail'>(`import:zip:${archiveHash}-thumbnail-${token}`, occupiedIds),
        assetId,
        plateId: thumbnail.plateId,
        width: thumbnail.width,
        height: thumbnail.height,
      });
    }
    const blobId = uniqueImportedId<'extension-blob'>(`import:zip:${archiveHash}-extension-${token}`, occupiedIds);
    const relationships = ['orcaxr:preserve-package-entry'];
    if (preserveOriginalPaths.has(path)) relationships.push('orcaxr:preserve-original');
    const blob: ExtensionBlob = {
      id: blobId,
      namespace: preserveOriginalPaths.has(path)
        ? 'urn:orcaxr:preserved-bbs-metadata'
        : 'urn:orcaxr:preserved-3mf-entry',
      path,
      assetId,
      relationships,
    };
    state.extensionBlobs.push(blob);
    occupiedPaths.add(path);
  }
  if (ordinal > 0) {
    warnings.push(`Preserved ${ordinal} package entr${ordinal === 1 ? 'y' : 'ies'} as opaque canonical assets`);
  }
}

function parseEnvelope(bytes: Uint8Array): CanonicalExtensionEnvelope {
  let parsed: unknown;
  let text: string;
  try {
    text = decodeText(bytes, ORCAXR_EXTENSION_PATH);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid OrcaXR canonical metadata: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  // Every JSON node costs at least one character, and the ZIP guards already
  // bound how many characters this entry may contain, so the text length is an
  // exact ceiling on the node count. A flat cap instead would refuse to reopen
  // a project this same serializer had just written, once the model carried
  // more painted triangles than the constant allowed.
  assertSafeJsonTree(parsed, ORCAXR_EXTENSION_PATH, Math.max(DEFAULT_JSON_NODE_LIMIT, text.length));
  if (!isRecord(parsed)) throw new Error('OrcaXR canonical metadata must be a JSON object');
  if (parsed.format !== ORCAXR_EXTENSION_FORMAT || parsed.version !== 1) {
    throw new Error(`Unsupported OrcaXR 3MF extension ${String(parsed.format)} version ${String(parsed.version)}`);
  }
  if (!isRecord(parsed.state) || !Array.isArray(parsed.assetEntries)) {
    throw new Error('OrcaXR canonical metadata is missing state or asset entries');
  }
  const assetEntries = parsed.assetEntries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.assetId !== 'string' || typeof entry.path !== 'string') {
      throw new Error(`Invalid OrcaXR asset mapping at index ${index}`);
    }
    return { assetId: entry.assetId as AssetId, path: entry.path };
  });
  return {
    format: ORCAXR_EXTENSION_FORMAT,
    version: 1,
    state: parsed.state as unknown as ProjectState,
    assetEntries,
  };
}

function countLegacyFalseFuzzyAssignments(state: ProjectState): number {
  let count = 0;
  visitLegacyFalseFuzzyAssignments(state, () => {
    count += 1;
  });
  return count;
}

function coerceLegacyFalseFuzzyAssignments(state: ProjectState): number {
  let coerced = 0;
  visitLegacyFalseFuzzyAssignments(state, (assignment) => {
    assignment.value = true;
    coerced += 1;
  });
  return coerced;
}

function visitLegacyFalseFuzzyAssignments(
  state: ProjectState,
  visitor: (assignment: Record<string, unknown>) => void,
): void {
  const plates = (state as unknown as Record<string, unknown>).plates;
  if (!Array.isArray(plates)) return;
  for (const plate of plates) {
    if (!isRecord(plate) || !Array.isArray(plate.objects)) continue;
    for (const object of plate.objects) {
      if (!isRecord(object) || !Array.isArray(object.volumes)) continue;
      for (const volume of object.volumes) {
        if (!isRecord(volume) || !isRecord(volume.annotations) || !Array.isArray(volume.annotations.fuzzySkin)) {
          continue;
        }
        for (const assignment of volume.annotations.fuzzySkin) {
          if (!isRecord(assignment) || assignment.value !== false) continue;
          visitor(assignment);
        }
      }
    }
  }
}

function removeLegacyFalseFuzzyAssignments(state: ProjectState): void {
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) {
        volume.annotations.fuzzySkin = (volume.annotations.fuzzySkin as unknown as Array<{ value: boolean }>).filter(
          (assignment) => assignment.value !== false,
        ) as typeof volume.annotations.fuzzySkin;
      }
    }
  }
}

function buildRootRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): string {
  const fixed: PreservedOpcRelationship[] = [
    {
      source: '/',
      id: 'rel-3dmodel',
      type: 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel',
      target: '/3D/3dmodel.model',
      targetMode: 'Internal',
    },
    {
      source: '/',
      id: 'rel-orcaxr-project',
      type: `${ORCAXR_EXTENSION_FORMAT}/relationships/project-state`,
      target: `/${ORCAXR_EXTENSION_PATH}`,
      targetMode: 'Internal',
    },
  ];
  return relationshipDocument('/', fixed, resolvableRelationships(state, files, warnings));
}

function buildPartRelationships(
  state: ProjectState,
  source: typeof CORE_MODEL_PATH,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  return relationshipDocument(source, [], resolvableRelationships(state, files, []));
}

/**
 * Preserved relationships whose target is actually in this package.
 *
 * A projection may legitimately omit preserved members — the one-plate slice
 * archive drops every opaque entry — and an OPC relationship to a missing part
 * makes the whole package unreadable: the pinned engine reports
 * "Archive does not contain a valid model" and loads nothing. Dropping the
 * dangling row keeps the package loadable and records what was dropped.
 */
function resolvableRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): PreservedOpcRelationship[] {
  const kept: PreservedOpcRelationship[] = [];
  const dropped: string[] = [];
  for (const relationship of readPreservedRelationships(state)) {
    if (
      relationship.targetMode === 'External' ||
      files.has(resolveOpcTarget(relationship.source, relationship.target))
    ) {
      kept.push(relationship);
      continue;
    }
    dropped.push(relationship.target);
  }
  if (dropped.length > 0) {
    warnings.push(
      `Dropped ${dropped.length} preserved package relationship(s) whose target is not part of this archive: ${[
        ...new Set(dropped),
      ]
        .sort()
        .join(', ')}`,
    );
  }
  return kept;
}

/**
 * Resolve an OPC relationship target to its package path. Targets are either
 * package-absolute (`/3D/x.model`) or relative to the source part's folder
 * (`../Metadata/x.xml` from `3D/3dmodel.model`).
 */
function resolveOpcTarget(source: string, target: string): string {
  const segments = target.startsWith('/')
    ? target.slice(1).split('/')
    : [...(source === '/' ? [] : source.split('/').slice(0, -1)), ...target.split('/')];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/');
}

function relationshipDocument(
  source: '/' | typeof CORE_MODEL_PATH,
  fixed: PreservedOpcRelationship[],
  preserved: PreservedOpcRelationship[],
): string {
  const rows = [...fixed, ...preserved.filter((relationship) => relationship.source === source)];
  const ids = new Set<string>();
  for (const relationship of rows) {
    if (ids.has(relationship.id)) {
      throw new Error(`Duplicate OPC relationship ID ${relationship.id} for ${source}`);
    }
    ids.add(relationship.id);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...rows
      .sort(
        (left, right) =>
          compareText(left.id, right.id) ||
          compareText(left.type, right.type) ||
          compareText(left.target, right.target),
      )
      .map(
        (relationship) =>
          ` <Relationship Id="${xmlAttribute(relationship.id)}" Type="${xmlAttribute(
            relationship.type,
          )}" Target="${xmlAttribute(relationship.target)}"${
            relationship.targetMode === 'External' ? ' TargetMode="External"' : ''
          }/>`,
      ),
    '</Relationships>',
    '',
  ].join('\n');
}

function mergePackageRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): void {
  const merged = new Map<string, PreservedOpcRelationship>();
  for (const relationship of readPreservedRelationships(state)) {
    merged.set(relationshipKey(relationship), relationship);
  }
  for (const [path, source] of [
    [ROOT_RELATIONSHIPS_PATH, '/'],
    [MODEL_RELS_PATH, CORE_MODEL_PATH],
  ] as const) {
    const bytes = files.get(path);
    if (!bytes) continue;
    const xml = decodeText(bytes, path);
    const seenIds = new Set<string>();
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = parseXmlAttributes(match[1]);
      const id = attributes.Id ?? attributes.id;
      const type = attributes.Type ?? attributes.type;
      const target = attributes.Target ?? attributes.target;
      if (!id || !type || !target) {
        warnings.push(`Ignored an incomplete OPC relationship in ${path}`);
        continue;
      }
      if (seenIds.has(id)) throw new Error(`Duplicate OPC relationship ID ${id} in ${path}`);
      seenIds.add(id);
      const targetMode = /^external$/i.test(attributes.TargetMode ?? attributes.targetMode ?? '')
        ? 'External'
        : 'Internal';
      const relationship: PreservedOpcRelationship = { source, id, type, target, targetMode };
      if (isGeneratedRelationship(relationship)) continue;
      if (targetMode === 'Internal') {
        const resolved = resolveRelationshipTarget(source, target);
        if (!files.has(resolved)) {
          warnings.push(`Preserved OPC relationship ${id} from ${path}, but target ${resolved} is missing`);
        }
      }
      merged.set(relationshipKey(relationship), relationship);
    }
  }
  if (merged.size === 0) return;
  state.extensionData = {
    ...(state.extensionData ?? {}),
    [OPC_RELATIONSHIPS_KEY]: [...merged.values()]
      .sort((left, right) => compareText(relationshipKey(left), relationshipKey(right)))
      .map((relationship) => ({ ...relationship })),
  };
}

function readPreservedRelationships(state: ProjectState): PreservedOpcRelationship[] {
  const raw = state.extensionData?.[OPC_RELATIONSHIPS_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${OPC_RELATIONSHIPS_KEY} must be an array`);
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      (entry.source !== '/' && entry.source !== CORE_MODEL_PATH) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.type !== 'string' ||
      !entry.type ||
      typeof entry.target !== 'string' ||
      !entry.target ||
      (entry.targetMode !== 'Internal' && entry.targetMode !== 'External')
    ) {
      throw new Error(`Invalid preserved OPC relationship at index ${index}`);
    }
    if (entry.targetMode === 'Internal') resolveRelationshipTarget(entry.source, entry.target);
    return {
      source: entry.source,
      id: entry.id,
      type: entry.type,
      target: entry.target,
      targetMode: entry.targetMode,
    };
  });
}

function isGeneratedRelationship(relationship: PreservedOpcRelationship): boolean {
  if (relationship.source !== '/') return false;
  if (
    relationship.type === 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel' &&
    resolveRelationshipTarget('/', relationship.target) === CORE_MODEL_PATH
  ) {
    return true;
  }
  return (
    relationship.type === `${ORCAXR_EXTENSION_FORMAT}/relationships/project-state` &&
    resolveRelationshipTarget('/', relationship.target) === ORCAXR_EXTENSION_PATH
  );
}

function relationshipKey(relationship: PreservedOpcRelationship): string {
  return [relationship.source, relationship.id, relationship.type, relationship.target, relationship.targetMode].join(
    '\u0000',
  );
}

function resolveRelationshipTarget(source: '/' | typeof CORE_MODEL_PATH, target: string): string {
  const withoutFragment = target.split(/[?#]/, 1)[0];
  const segments = withoutFragment.startsWith('/') ? [] : source === '/' ? [] : source.split('/').slice(0, -1);
  for (const segment of withoutFragment.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`OPC relationship target escapes the package: ${target}`);
      segments.pop();
      continue;
    }
    if (segment.includes('\\') || segment.includes('\u0000')) {
      throw new Error(`Unsafe OPC relationship target ${target}`);
    }
    segments.push(segment);
  }
  const resolved = segments.join('/');
  validatePackagePath(resolved);
  return resolved;
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attributes = Object.create(null) as Record<string, string>;
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (Object.hasOwn(attributes, match[1])) throw new Error(`Duplicate XML attribute ${match[1]}`);
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) return safeCodePoint(Number(decimal), entity);
      if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        default:
          return entity;
      }
    },
  );
}

function safeCodePoint(value: number, original: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10_ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw new Error(`Invalid XML character reference ${original}`);
  }
  return String.fromCodePoint(value);
}

/**
 * Node allowance for a project's own state.
 *
 * A flat cap here is the same mistake as a flat refinement cap: a painted mesh
 * needs one refinement root per triangle, so a legitimate multi-million
 * triangle model exceeds any fixed number and becomes a project that can be
 * opened but never saved. The allowance therefore tracks the geometry the
 * project actually holds, using the same per-triangle budget the refinement
 * validator applies, over a floor that covers everything else in the state.
 */
function projectStateJsonNodeBudget(state: ProjectState): number {
  let budget = DEFAULT_JSON_NODE_LIMIT;
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) budget += refinementNodeBudget(volume.source.triangleCount);
    }
  }
  return budget;
}

const DEFAULT_JSON_NODE_LIMIT = 1_000_000;

function assertSafeJsonTree(root: unknown, label: string, nodeLimit = DEFAULT_JSON_NODE_LIMIT): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > nodeLimit) throw new Error(`${label} exceeds the JSON node limit`);
    if (depth > 256) throw new Error(`${label} exceeds the JSON nesting limit`);
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains unsafe object key ${key}`);
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function mergePackageContentTypes(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): void {
  const bytes = files.get(CONTENT_TYPES_PATH);
  if (!bytes) {
    warnings.push(`3MF is missing ${CONTENT_TYPES_PATH}; a valid content-type manifest will be generated on save`);
    return;
  }
  const xml = decodeText(bytes, CONTENT_TYPES_PATH);
  const preserved = new Map<string, PreservedContentType>();
  for (const entry of readPreservedContentTypes(state)) {
    preserved.set(contentTypeKey(entry), entry);
  }
  for (const match of xml.matchAll(/<(Default|Override)\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseXmlAttributes(match[2]);
    const contentType = attributes.ContentType ?? attributes.contentType;
    if (!contentType) throw new Error(`${CONTENT_TYPES_PATH} contains an entry without ContentType`);
    if (/^default$/i.test(match[1])) {
      const extension = attributes.Extension ?? attributes.extension;
      if (!extension || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(extension)) {
        throw new Error(`${CONTENT_TYPES_PATH} contains an invalid default extension`);
      }
      const expected = inferredContentTypeForExtension(extension, files);
      if (expected === contentType) continue;
      const entry: PreservedContentType = { kind: 'default', extension, contentType };
      preserved.set(contentTypeKey(entry), entry);
      continue;
    }
    const partName = attributes.PartName ?? attributes.partName;
    if (!partName?.startsWith('/')) throw new Error(`${CONTENT_TYPES_PATH} contains an invalid PartName`);
    const resolved = partName.slice(1);
    validatePackagePath(resolved);
    if (resolved === ORCAXR_EXTENSION_PATH && contentType === 'application/vnd.orcaxr.project+json') continue;
    if (!files.has(resolved)) {
      warnings.push(`Preserved content-type override for missing package part ${partName}`);
    }
    const entry: PreservedContentType = { kind: 'override', partName, contentType };
    preserved.set(contentTypeKey(entry), entry);
  }
  if (preserved.size === 0) return;
  state.extensionData = {
    ...(state.extensionData ?? {}),
    [OPC_CONTENT_TYPES_KEY]: [...preserved.values()]
      .sort((left, right) => compareText(contentTypeKey(left), contentTypeKey(right)))
      .map((entry) => ({ ...entry })),
  };
}

function readPreservedContentTypes(state: ProjectState): PreservedContentType[] {
  const raw = state.extensionData?.[OPC_CONTENT_TYPES_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${OPC_CONTENT_TYPES_KEY} must be an array`);
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.contentType !== 'string' ||
      !entry.contentType ||
      (entry.kind !== 'default' && entry.kind !== 'override')
    ) {
      throw new Error(`Invalid preserved content type at index ${index}`);
    }
    if (entry.kind === 'default') {
      if (typeof entry.extension !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(entry.extension)) {
        throw new Error(`Invalid preserved default content type at index ${index}`);
      }
      return { kind: 'default', extension: entry.extension, contentType: entry.contentType };
    }
    if (typeof entry.partName !== 'string' || !entry.partName.startsWith('/')) {
      throw new Error(`Invalid preserved content-type override at index ${index}`);
    }
    validatePackagePath(entry.partName.slice(1));
    return { kind: 'override', partName: entry.partName, contentType: entry.contentType };
  });
}

function contentTypeKey(entry: PreservedContentType): string {
  return entry.kind === 'default' ? `default\u0000${entry.extension.toLowerCase()}` : `override\u0000${entry.partName}`;
}

function inferredContentTypeForExtension(
  extension: string,
  files: ReadonlyMap<string, Uint8Array>,
): string | undefined {
  const suffix = `.${extension.toLowerCase()}`;
  const path = [...files.keys()].find((candidate) => candidate.toLowerCase().endsWith(suffix));
  return path ? mediaTypeForPath(path) : undefined;
}

function buildContentTypes(files: ReadonlyMap<string, Uint8Array>, state: ProjectState): string {
  const preserved = readPreservedContentTypes(state);
  const types = new Map<string, string>(
    preserved
      .filter((entry): entry is Extract<PreservedContentType, { kind: 'default' }> => entry.kind === 'default')
      .map((entry) => [entry.extension.toLowerCase(), entry.contentType]),
  );
  const required = new Map<string, string>([
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['model', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'],
  ]);
  for (const [extension, contentType] of required) {
    const existing = types.get(extension);
    if (existing && existing !== contentType) {
      throw new Error(`Preserved .${extension} content type conflicts with the required OPC/3MF type`);
    }
    types.set(extension, contentType);
  }
  for (const path of files.keys()) {
    if (path === CONTENT_TYPES_PATH) continue;
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    if (extension && !types.has(extension)) types.set(extension, mediaTypeForPath(path));
  }
  const overrides = new Map(
    preserved
      .filter((entry): entry is Extract<PreservedContentType, { kind: 'override' }> => entry.kind === 'override')
      .map((entry) => [entry.partName, entry.contentType]),
  );
  overrides.set(`/${ORCAXR_EXTENSION_PATH}`, 'application/vnd.orcaxr.project+json');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ...[...types.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([extension, mediaType]) =>
          ` <Default Extension="${xmlAttribute(extension)}" ContentType="${xmlAttribute(mediaType)}"/>`,
      ),
    ...[...overrides.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([partName, contentType]) =>
          ` <Override PartName="${xmlAttribute(partName)}" ContentType="${xmlAttribute(contentType)}"/>`,
      ),
    '</Types>',
    '',
  ].join('\n');
}

function verifyAssetDigest(descriptor: SourceAssetDescriptor, bytes: Uint8Array, warnings: string[]): void {
  if (descriptor.byteLength !== bytes.byteLength) {
    throw new Error(`Asset ${descriptor.id} declares ${descriptor.byteLength} bytes but has ${bytes.byteLength}`);
  }
  if (descriptor.digest.startsWith('fnv1a64:')) {
    if (descriptor.digest !== contentDigest(bytes)) {
      throw new Error(`Asset ${descriptor.id} content does not match its digest`);
    }
  } else {
    warnings.push(
      `Asset ${descriptor.id} uses unsupported digest ${descriptor.digest}; ZIP CRC and byte length were validated`,
    );
  }
}

function extensionForAsset(descriptor: SourceAssetDescriptor): string {
  switch (descriptor.mediaType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'application/json':
      return 'json';
    case 'application/xml':
    case 'text/xml':
      return 'xml';
    case 'text/plain':
      return 'txt';
    default:
      return 'bin';
  }
}

function mediaTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.rels')) return 'application/vnd.openxmlformats-package.relationships+xml';
  if (lower.endsWith('.model')) return 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.xml') || lower.endsWith('.config')) return 'text/xml';
  if (lower.endsWith('.txt') || lower.endsWith('.gcode')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function inferAssetKind(path: string): SourceAssetDescriptor['kind'] {
  const type = mediaTypeForPath(path);
  return type.startsWith('image/') ? 'thumbnail' : 'extension';
}

function standardPlateThumbnail(
  path: string,
  bytes: Uint8Array,
  state: ProjectState,
): { plateId: ProjectState['plates'][number]['id']; width: number; height: number } | undefined {
  const match = /^Metadata\/plate_(\d+)\.png$/i.exec(path);
  if (!match) return undefined;
  const plate = state.plates.find((candidate) => candidate.order === Number(match[1]) - 1);
  if (!plate || bytes.byteLength < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1 || width > 100_000 || height > 100_000) return undefined;
  return { plateId: plate.id, width, height };
}

function isStructuralPath(path: string): boolean {
  return GENERATED_STANDARD_PATHS.has(path) || path === ORCAXR_EXTENSION_PATH;
}

function collectIds(state: ProjectState): Set<string> {
  const ids = new Set<string>([state.id]);
  state.sourceAssets.forEach((entry) => ids.add(entry.id));
  state.filaments.physical.forEach((entry) => ids.add(entry.id));
  state.filaments.mixed.forEach((entry) => ids.add(entry.id));
  state.customGcode.forEach((entry) => ids.add(entry.id));
  state.thumbnails.forEach((entry) => ids.add(entry.id));
  state.extensionBlobs.forEach((entry) => ids.add(entry.id));
  for (const plate of state.plates) {
    ids.add(plate.id);
    for (const object of plate.objects) {
      ids.add(object.id);
      object.volumes.forEach((entry) => ids.add(entry.id));
      object.instances.forEach((entry) => ids.add(entry.id));
      object.layerRanges.forEach((entry) => ids.add(entry.id));
    }
  }
  return ids;
}

function uniqueImportedId<Kind extends string>(base: string, occupied: Set<string>) {
  let value = base;
  let suffix = 1;
  while (occupied.has(value)) value = `${base}-${suffix++}`;
  occupied.add(value);
  return entityId<Kind>(value);
}

function suggestedFilename(name: string): string {
  const withoutControls = [...name].map((character) => (character.codePointAt(0)! <= 0x1f ? '-' : character)).join('');
  const stem = withoutControls
    .normalize('NFKC')
    .replace(/\.3mf$/i, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return `${stem || 'OrcaXR-project'}.3mf`;
}

function throwIfCancelled(cancellation: CancellationToken | undefined): void {
  if (!cancellation?.aborted) return;
  const error = new Error(cancellation.reason || 'Operation cancelled');
  error.name = 'AbortError';
  throw error;
}

function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function xmlAttribute(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error('XML attribute contains a character XML 1.0 cannot represent');
    }
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
