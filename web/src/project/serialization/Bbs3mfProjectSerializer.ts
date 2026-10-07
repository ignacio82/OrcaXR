import {
  buildRootRelationships,
  buildPartRelationships,
  buildContentTypes,
  mergePackageRelationships,
  mergePackageContentTypes,
  mediaTypeForPath,
} from './opcPackage';
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

import {
  ORCAXR_EXTENSION_PATH,
  ORCAXR_EXTENSION_FORMAT,
  DEFAULT_JSON_NODE_LIMIT,
  assertSafeJsonTree,
  readCanonicalEnvelope,
} from './CanonicalEnvelope';
export { ORCAXR_EXTENSION_PATH, ORCAXR_EXTENSION_FORMAT } from './CanonicalEnvelope';

const CONTENT_TYPES_PATH = '[Content_Types].xml';
const ROOT_RELATIONSHIPS_PATH = '_rels/.rels';
const PRESERVABLE_GENERATED_METADATA = new Set([
  PROJECT_SETTINGS_PATH,
  MODEL_SETTINGS_PATH,
  LAYER_RANGES_PATH,
  LAYER_EVENTS_PATH,
]);

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
    const envelope = readCanonicalEnvelope(extensionBytes);
    const { state, warnings } = envelope;
    mergePackageRelationships(state, files, warnings);
    mergePackageContentTypes(state, files, warnings);
    const { repository, mappings } = readCanonicalAssets(state, envelope.assetEntries, files, warnings);

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
    verifyCanonicalBlobs(state, repository, files);
    for (const blob of state.extensionBlobs) owned.add(blob.path);

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
    // Parts the generated core absorbed rather than reproduced under their own
    // name. They are only superseded if the core was actually regenerated: when
    // `buildBbsCore` could not run, the originals are still the only carrier of
    // that geometry and must stay preserved.
    if (regeneratedPaths.has(CORE_MODEL_PATH)) {
      for (const path of imported.absorbedIntoCorePaths) excluded.add(path);
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

/** The canonical asset stage, shared with the native differential reference.
 * This is not BBS/OPC reconciliation or unknown-member adoption. */
export function readCanonicalAssets(
  state: ProjectState,
  assetEntries: CanonicalExtensionEnvelope['assetEntries'],
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): { repository: InMemoryAssetRepository; mappings: Map<AssetId, string> } {
  const descriptors = new Map(state.sourceAssets.map((entry) => [entry.id, entry]));
  const mappings = new Map<AssetId, string>();
  const paths = new Set<string>();
  for (const mapping of assetEntries) {
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

  return { repository, mappings };
}

export function verifyCanonicalBlobs(
  state: ProjectState,
  repository: InMemoryAssetRepository,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  for (const blob of state.extensionBlobs) {
    validatePackagePath(blob.path);
    const payload = repository.get(blob.assetId);
    if (!payload) throw new Error(`Extension ${blob.id} references missing asset ${blob.assetId}`);
    const packageBytes = files.get(blob.path);
    if (!packageBytes) throw new Error(`3MF is missing extension entry ${blob.path}`);
    if (!equalBytes(payload.bytes, packageBytes)) {
      throw new Error(`Extension entry ${blob.path} differs from its canonical asset payload`);
    }
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

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
