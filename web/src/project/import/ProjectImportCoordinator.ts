import { InMemoryAssetRepository, contentDigest, type AssetPayload, type AssetRepositorySnapshot } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from '../domain/canonical';
import type { AssetId } from '../domain/ids';
import type { JsonValue, ProjectState, SourceAssetDescriptor } from '../domain/model';
import { validateProjectState } from '../domain/validation';
import type { CommandBus } from '../history/commandBus';
import { ImportProjectCommand } from './ImportProjectCommand';
import {
  ImportCancelledError,
  ImportConfirmationError,
  ImportPreparationError,
  StaleImportPreviewError,
  type ImportCommitConfirmation,
  type ImportCommitResult,
  type ImportConflictNotice,
  type ImportDiagnostic,
  type ImportDroppedFieldNotice,
  type ImportRepairNotice,
  type ParsedProjectImport,
  type ProjectImportCounts,
  type ProjectImportParserPort,
  type ProjectImportPreview,
  type ProjectImportRequest,
  type ProjectImportSource,
} from './types';

interface NormalizedImport {
  state: ProjectState;
  assets: AssetPayload[];
  importedAssetCount: number;
  deduplicatedAssetCount: number;
  repairs: ImportRepairNotice[];
  conflicts: ImportConflictNotice[];
  droppedFields: ImportDroppedFieldNotice[];
  diagnostics: ImportDiagnostic[];
}

interface StagedBundle {
  state: ProjectState;
  assets: AssetPayload[];
}

export interface ProjectImportCoordinatorOptions {
  parser: ProjectImportParserPort;
  commands: CommandBus;
  now?: () => string;
}

/**
 * Coordinates parse -> preview -> explicit confirm without exposing a live
 * mutable store to the parser. Only confirm creates a command/history entry.
 */
export class ProjectImportCoordinator {
  private readonly now: () => string;

  constructor(private readonly options: ProjectImportCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(request: ProjectImportRequest): Promise<PreparedProjectImport> {
    const source = normalizeSource(request.source, this.now);
    throwIfCancelled(request.cancellation);

    const context = this.options.commands.context;
    const baseProject = context.project.getSnapshot();
    const baseAssets = context.assets.list();
    const baseAssetHash = assetBundleFingerprint(baseAssets);

    let parsed: ParsedProjectImport;
    try {
      parsed = await this.options.parser.parse({
        bytes: request.bytes.slice(),
        source: deepFreeze(cloneJson(source)),
        mode: request.mode ?? 'merge',
        base: {
          state: cloneProjectState(baseProject.state),
          assets: cloneAssetPayloads(baseAssets),
          sourceRevision: baseProject.revision,
          sourceHash: baseProject.hash,
        },
        cancellation: request.cancellation,
      });
    } catch (error) {
      if (request.cancellation?.aborted || error instanceof ImportCancelledError) {
        const reason =
          request.cancellation?.reason ??
          (error instanceof ImportCancelledError ? error.cancellationReason : undefined);
        throw new ImportCancelledError(reason);
      }
      throw new ImportPreparationError(`Could not parse ${source.filename}`, error);
    }

    throwIfCancelled(request.cancellation);
    let normalized: NormalizedImport;
    try {
      normalized = normalizeParsedImport(parsed, source, baseAssets);
    } catch (error) {
      throw new ImportPreparationError(`Could not validate the staged import for ${source.filename}`, error);
    }
    if (!context.project.isCurrent(baseProject) || assetBundleFingerprint(context.assets.list()) !== baseAssetHash) {
      normalized.diagnostics.push({
        id: nextNoticeId(normalized, 'stale-base'),
        severity: 'error',
        code: 'stale-import-base',
        path: '$',
        message: 'The project changed while the import was being parsed; prepare a new preview',
      });
    }

    const counts: ProjectImportCounts = {
      plates: normalized.state.plates.length,
      objects: normalized.state.plates.reduce((total, plate) => total + plate.objects.length, 0),
      assets: normalized.assets.length,
      importedAssets: normalized.importedAssetCount,
      deduplicatedAssets: normalized.deduplicatedAssetCount,
    };
    const unresolvedConflict = normalized.conflicts.some((conflict) => !conflict.resolution);
    const blocked = unresolvedConflict || normalized.diagnostics.some((item) => item.severity === 'error');
    const preview = deepFreeze<ProjectImportPreview>({
      source: cloneJson(source),
      mode: request.mode ?? 'merge',
      baseRevision: baseProject.revision,
      baseHash: baseProject.hash,
      projectName: normalized.state.name,
      counts,
      blocked,
      requiredAcknowledgementIds: collectRequiredAcknowledgements(normalized),
      repairs: normalized.repairs.map((notice) => cloneJson(notice)),
      conflicts: normalized.conflicts.map((notice) => cloneJson(notice)),
      droppedFields: normalized.droppedFields.map((notice) => cloneJson(notice)),
      diagnostics: normalized.diagnostics.map((notice) => cloneJson(notice)),
    });

    return new PreparedProjectImport(
      this.options.commands,
      preview,
      { state: normalized.state, assets: normalized.assets },
      baseAssetHash,
      request.cancellation,
    );
  }
}

export class PreparedProjectImport {
  private status: 'prepared' | 'committed' | 'cancelled' = 'prepared';
  private staged?: StagedBundle;
  private cancellationReason?: string;

  constructor(
    private readonly commands: CommandBus,
    readonly preview: ProjectImportPreview,
    staged: StagedBundle,
    private readonly baseAssetHash: string,
    private readonly cancellation?: ProjectImportRequest['cancellation'],
  ) {
    this.staged = {
      state: cloneProjectState(staged.state),
      assets: cloneAssetPayloads(staged.assets),
    };
  }

  cancel(reason = 'cancelled by user'): void {
    if (this.status === 'committed') throw new ImportConfirmationError('A committed import cannot be cancelled');
    if (this.status === 'cancelled') return;
    this.status = 'cancelled';
    this.cancellationReason = reason;
    this.staged = undefined;
  }

  confirm(confirmation: ImportCommitConfirmation): ImportCommitResult {
    if (this.status === 'committed') throw new ImportConfirmationError('This import was already committed');
    if (this.status === 'cancelled' || this.cancellation?.aborted) {
      this.cancel(this.cancellation?.reason ?? this.cancellationReason);
      throw new ImportCancelledError(this.cancellation?.reason ?? this.cancellationReason);
    }
    if (this.preview.blocked) {
      throw new ImportConfirmationError('This import preview contains unresolved errors or conflicts');
    }
    if (confirmation.confirmed !== true) {
      throw new ImportConfirmationError('Import confirmation must be explicit');
    }
    const acknowledged = new Set(confirmation.acknowledgedNoticeIds);
    const missing = this.preview.requiredAcknowledgementIds.filter((id) => !acknowledged.has(id));
    if (missing.length > 0) {
      throw new ImportConfirmationError(
        'Every reported repair, conflict, and dropped field must be acknowledged',
        missing,
      );
    }

    const context = this.commands.context;
    if (
      !context.project.isCurrent({ revision: this.preview.baseRevision, hash: this.preview.baseHash }) ||
      assetBundleFingerprint(context.assets.list()) !== this.baseAssetHash
    ) {
      throw new StaleImportPreviewError();
    }
    const staged = this.staged;
    if (!staged) throw new ImportConfirmationError('The staged import is no longer available');

    this.commands.execute(
      new ImportProjectCommand(staged.state, staged.assets, `Import ${this.preview.source.filename}`),
      { coalesce: false },
    );
    this.status = 'committed';
    this.staged = undefined;
    return {
      project: context.project.getSnapshot(),
      history: this.commands.getHistorySnapshot(),
      diagnostics: this.preview.diagnostics.map((item) => cloneJson(item)),
    };
  }
}

function normalizeParsedImport(
  parsed: ParsedProjectImport,
  source: ProjectImportSource,
  baseAssets: readonly AssetPayload[],
): NormalizedImport {
  const state = cloneProjectState(parsed.state);
  const assets = cloneAssetPayloads(parsed.assets);
  const repairs = (parsed.repairs ?? []).map((notice) => cloneJson(notice));
  const conflicts = (parsed.conflicts ?? []).map((notice) => cloneJson(notice));
  const droppedFields = (parsed.droppedFields ?? []).map((notice) => cloneJson(notice));
  const diagnostics = (parsed.diagnostics ?? []).map((notice) => cloneJson(notice));
  const normalized: NormalizedImport = {
    state,
    assets,
    importedAssetCount: 0,
    deduplicatedAssetCount: 0,
    repairs,
    conflicts,
    droppedFields,
    diagnostics,
  };
  validateNoticeIds(normalized);

  const importedIds = new Set<AssetId>(parsed.importedAssetIds);
  const descriptorById = new Map<AssetId, SourceAssetDescriptor>();
  const descriptorIndex = new Map<AssetId, number>();
  state.sourceAssets.forEach((descriptor, index) => {
    if (descriptorById.has(descriptor.id)) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'duplicate-state-asset'),
        severity: 'error',
        code: 'duplicate-asset-id',
        path: `sourceAssets[${index}].id`,
        message: `Asset ID ${descriptor.id} is declared more than once`,
      });
    } else {
      descriptorById.set(descriptor.id, descriptor);
      descriptorIndex.set(descriptor.id, index);
    }
  });

  const payloadById = new Map<AssetId, AssetPayload>();
  assets.forEach((payload, index) => {
    if (payloadById.has(payload.descriptor.id)) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'duplicate-payload-asset'),
        severity: 'error',
        code: 'duplicate-asset-payload',
        path: `assets[${index}].descriptor.id`,
        message: `Asset payload ${payload.descriptor.id} is returned more than once`,
      });
      return;
    }
    payloadById.set(payload.descriptor.id, payload);
    const declared = descriptorById.get(payload.descriptor.id);
    if (!declared) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'undeclared-payload'),
        severity: 'error',
        code: 'undeclared-asset-payload',
        path: `assets[${index}]`,
        message: `Asset payload ${payload.descriptor.id} has no sourceAssets declaration`,
      });
    } else if (!canonicalEqual(declared, payload.descriptor)) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'asset-metadata-mismatch'),
        severity: 'error',
        code: 'asset-metadata-mismatch',
        path: `assets[${index}].descriptor`,
        message: `Asset payload metadata for ${payload.descriptor.id} differs from canonical state`,
      });
    }
    if (payload.descriptor.byteLength !== payload.bytes.byteLength) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'asset-length'),
        severity: 'error',
        code: 'asset-byte-length-mismatch',
        path: `assets[${index}].bytes`,
        message: `Asset ${payload.descriptor.id} declares ${payload.descriptor.byteLength} bytes but contains ${payload.bytes.byteLength}`,
      });
    }
    const actualDigest = contentDigest(payload.bytes);
    if (payload.descriptor.digest.startsWith('fnv1a64:') && payload.descriptor.digest !== actualDigest) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'asset-digest'),
        severity: 'error',
        code: 'asset-digest-mismatch',
        path: `assets[${index}].descriptor.digest`,
        message: `Asset ${payload.descriptor.id} does not match its declared digest`,
      });
    }
  });
  state.sourceAssets.forEach((descriptor, index) => {
    if (!payloadById.has(descriptor.id)) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'missing-payload'),
        severity: 'error',
        code: 'missing-asset-payload',
        path: `sourceAssets[${index}]`,
        message: `Asset ${descriptor.id} has no payload`,
      });
    }
  });
  for (const importedId of importedIds) {
    if (!payloadById.has(importedId)) {
      diagnostics.push({
        id: nextNoticeId(normalized, 'unknown-imported-asset'),
        severity: 'error',
        code: 'unknown-imported-asset',
        path: 'importedAssetIds',
        message: `Imported asset ID ${importedId} does not name a returned payload`,
      });
    }
  }

  for (const importedId of importedIds) {
    const payload = payloadById.get(importedId);
    const stateDescriptor = descriptorById.get(importedId);
    if (!payload || !stateDescriptor) continue;
    const descriptor = normalizeImportedDescriptor(payload.descriptor, source);
    payload.descriptor = cloneJson(descriptor);
    const index = descriptorIndex.get(importedId);
    if (index !== undefined) state.sourceAssets[index] = cloneJson(descriptor);
  }

  const grouped = groupAssetsByContent(assets, importedIds, normalized);
  const aliases = new Map<AssetId, AssetId>();
  const baseContentById = new Map(baseAssets.map((asset) => [asset.descriptor.id, contentDigest(asset.bytes)]));
  const finalGroups: Array<{ order: number; payload: AssetPayload }> = [];
  const mappedImportedIds = new Set<AssetId>();

  for (const group of grouped) {
    if (!group.compatible) {
      for (const item of group.items) {
        aliases.set(item.payload.descriptor.id, item.payload.descriptor.id);
        finalGroups.push({ order: item.order, payload: item.payload });
        if (item.imported) mappedImportedIds.add(item.payload.descriptor.id);
      }
      continue;
    }
    const existing = group.items.find(
      (item) => !item.imported && baseContentById.get(item.payload.descriptor.id) === group.digest,
    );
    const canonicalItem = existing ?? group.items[0];
    const importedMetadata = group.items.find((item) => item.imported);
    const metadataSource = importedMetadata ?? canonicalItem;
    const canonicalId = canonicalItem.payload.descriptor.id;
    const descriptor: SourceAssetDescriptor = {
      ...cloneJson(metadataSource.payload.descriptor),
      id: canonicalId,
      byteLength: canonicalItem.payload.bytes.byteLength,
    };
    const payload: AssetPayload = { descriptor, bytes: canonicalItem.payload.bytes.slice() };
    for (const item of group.items) {
      aliases.set(item.payload.descriptor.id, canonicalId);
      if (item.imported) mappedImportedIds.add(canonicalId);
      if (item === metadataSource) continue;
      const kept = sourceMetadata(metadataSource.payload.descriptor);
      const discarded = sourceMetadata(item.payload.descriptor);
      if (Object.keys(discarded).length > 0 && !canonicalEqual(kept, discarded)) {
        droppedFields.push({
          id: nextNoticeId(normalized, 'deduplicated-provenance'),
          path: `sourceAssets[id=${item.payload.descriptor.id}]`,
          field: 'sourceFilename/provenance',
          message: `Duplicate asset metadata was superseded by the provenance retained for ${canonicalId}`,
          value: discarded,
        });
      }
    }
    if (group.items.length > 1) {
      repairs.push({
        id: nextNoticeId(normalized, 'asset-deduplication'),
        kind: 'asset-deduplication',
        path: 'sourceAssets',
        message: `${group.items.length} byte-identical assets were consolidated as ${canonicalId}`,
        before: group.items.map((item) => item.payload.descriptor.id),
        after: canonicalId,
      });
      normalized.deduplicatedAssetCount += group.items.length - 1;
    }
    finalGroups.push({
      order: Math.min(...group.items.map((item) => item.order)),
      payload,
    });
  }

  finalGroups.sort((left, right) => left.order - right.order);
  normalized.assets = finalGroups.map((entry) => ({
    descriptor: cloneJson(entry.payload.descriptor),
    bytes: entry.payload.bytes.slice(),
  }));
  normalized.state.sourceAssets = normalized.assets.map((entry) => cloneJson(entry.descriptor));
  normalized.importedAssetCount = mappedImportedIds.size;
  rewriteAssetReferences(normalized.state, aliases);

  for (const issue of validateProjectState(normalized.state)) {
    diagnostics.push({
      id: nextNoticeId(normalized, `validation-${issue.code}`),
      severity: issue.severity,
      code: issue.code,
      path: issue.path,
      message: issue.message,
    });
  }
  validateStagedRepository(normalized);
  return normalized;
}

interface ContentGroupItem {
  payload: AssetPayload;
  imported: boolean;
  order: number;
}

interface ContentGroup {
  digest: string;
  items: ContentGroupItem[];
  compatible: boolean;
}

function groupAssetsByContent(
  assets: AssetPayload[],
  importedIds: ReadonlySet<AssetId>,
  normalized: NormalizedImport,
): ContentGroup[] {
  const byDigest = new Map<string, ContentGroupItem[]>();
  assets.forEach((payload, order) => {
    const digest = contentDigest(payload.bytes);
    const bucket = byDigest.get(digest) ?? [];
    bucket.push({ payload, imported: importedIds.has(payload.descriptor.id), order });
    byDigest.set(digest, bucket);
  });
  return Array.from(byDigest, ([digest, items]) => {
    const bytesMatch = items.every((item) => bytesEqual(item.payload.bytes, items[0].payload.bytes));
    const semanticKey = assetSemanticKey(items[0].payload.descriptor);
    const metadataCompatible = items.every((item) => assetSemanticKey(item.payload.descriptor) === semanticKey);
    const compatible = bytesMatch && metadataCompatible;
    if (!bytesMatch) {
      normalized.diagnostics.push({
        id: nextNoticeId(normalized, 'content-digest-collision'),
        severity: 'error',
        code: 'asset-content-digest-collision',
        path: 'assets',
        message: `Assets sharing computed digest ${digest} contain different bytes`,
      });
    } else if (!metadataCompatible) {
      normalized.diagnostics.push({
        id: nextNoticeId(normalized, 'asset-semantic-conflict'),
        severity: 'error',
        code: 'asset-digest-semantic-conflict',
        path: 'sourceAssets',
        message: `Byte-identical assets ${items.map((item) => item.payload.descriptor.id).join(', ')} have incompatible kinds or mesh metadata`,
      });
    }
    return { digest, items, compatible };
  });
}

function validateStagedRepository(normalized: NormalizedImport): void {
  try {
    const repository = new InMemoryAssetRepository();
    const snapshot: AssetRepositorySnapshot = { entries: cloneAssetPayloads(normalized.assets) };
    repository.restore(snapshot);
    const payloads = repository.list();
    if (payloads.length !== normalized.state.sourceAssets.length) {
      throw new Error('Canonical asset declarations and payloads differ in length');
    }
    for (const descriptor of normalized.state.sourceAssets) {
      const payload = repository.get(descriptor.id);
      if (!payload || !canonicalEqual(payload.descriptor, descriptor)) {
        throw new Error(`Canonical asset bundle differs for ${descriptor.id}`);
      }
    }
  } catch (error) {
    normalized.diagnostics.push({
      id: nextNoticeId(normalized, 'invalid-staged-assets'),
      severity: 'error',
      code: 'invalid-staged-asset-repository',
      path: 'assets',
      message: error instanceof Error ? error.message : 'The staged asset repository is invalid',
    });
  }
}

function normalizeImportedDescriptor(
  descriptor: SourceAssetDescriptor,
  source: ProjectImportSource,
): SourceAssetDescriptor {
  const normalized = cloneJson(descriptor);
  normalized.sourceFilename ??= source.filename;
  if (!normalized.provenance) {
    normalized.provenance = {
      source: 'import',
      ...(source.uri ? { uri: source.uri } : {}),
      ...(source.importedAt ? { importedAt: source.importedAt } : {}),
    };
  } else if (normalized.provenance.source === 'import') {
    normalized.provenance = {
      ...normalized.provenance,
      ...(normalized.provenance.uri || !source.uri ? {} : { uri: source.uri }),
      ...(normalized.provenance.importedAt || !source.importedAt ? {} : { importedAt: source.importedAt }),
    };
  }
  return normalized;
}

function rewriteAssetReferences(state: ProjectState, aliases: ReadonlyMap<AssetId, AssetId>): void {
  const resolve = (id: AssetId): AssetId => aliases.get(id) ?? id;
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) volume.source.assetId = resolve(volume.source.assetId);
    }
  }
  for (const thumbnail of state.thumbnails) thumbnail.assetId = resolve(thumbnail.assetId);
  for (const extension of state.extensionBlobs) extension.assetId = resolve(extension.assetId);
}

function validateNoticeIds(normalized: NormalizedImport): void {
  const seen = new Set<string>();
  const notices = [
    ...normalized.repairs,
    ...normalized.conflicts,
    ...normalized.droppedFields,
    ...normalized.diagnostics,
  ];
  for (const notice of notices) {
    if (!notice.id.trim() || seen.has(notice.id)) {
      normalized.diagnostics.push({
        id: nextNoticeId(normalized, 'invalid-notice'),
        severity: 'error',
        code: 'invalid-import-notice-id',
        path: 'notices',
        message: !notice.id.trim() ? 'Import notice IDs cannot be empty' : `Duplicate import notice ID ${notice.id}`,
      });
    }
    seen.add(notice.id);
  }
}

function collectRequiredAcknowledgements(normalized: NormalizedImport): string[] {
  const result: string[] = [];
  for (const repair of normalized.repairs) {
    if (repair.requiresConfirmation !== false) result.push(repair.id);
  }
  for (const conflict of normalized.conflicts) {
    if (conflict.resolution && conflict.requiresConfirmation !== false) result.push(conflict.id);
  }
  for (const dropped of normalized.droppedFields) {
    if (dropped.requiresConfirmation !== false) result.push(dropped.id);
  }
  return Array.from(new Set(result)).sort();
}

function normalizeSource(source: ProjectImportSource, now: () => string): ProjectImportSource {
  if (!source.filename.trim()) throw new ImportPreparationError('Import source filename cannot be empty');
  const importedAt = source.importedAt ?? now();
  if (!Number.isFinite(Date.parse(importedAt))) {
    throw new ImportPreparationError('Import provenance timestamp must be ISO-compatible');
  }
  return {
    filename: source.filename,
    ...(source.mediaType ? { mediaType: source.mediaType } : {}),
    ...(source.uri ? { uri: source.uri } : {}),
    importedAt,
  };
}

function throwIfCancelled(cancellation?: ProjectImportRequest['cancellation']): void {
  if (cancellation?.aborted) throw new ImportCancelledError(cancellation.reason);
}

function cloneAssetPayloads(assets: readonly AssetPayload[]): AssetPayload[] {
  return assets.map((asset) => ({ descriptor: cloneJson(asset.descriptor), bytes: asset.bytes.slice() }));
}

function assetBundleFingerprint(assets: readonly AssetPayload[]): string {
  return canonicalStringify(
    [...assets]
      .map((asset) => ({ descriptor: asset.descriptor, content: contentDigest(asset.bytes) }))
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id)),
  );
}

function assetSemanticKey(descriptor: SourceAssetDescriptor): string {
  return canonicalStringify({
    kind: descriptor.kind,
    mediaType: descriptor.mediaType,
    mesh: descriptor.mesh ?? null,
  });
}

function sourceMetadata(descriptor: SourceAssetDescriptor): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  if (descriptor.sourceFilename !== undefined) result.sourceFilename = descriptor.sourceFilename;
  if (descriptor.provenance !== undefined) result.provenance = cloneJson(descriptor.provenance) as JsonValue;
  return result;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalStringify(left) === canonicalStringify(right);
  } catch {
    return false;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function nextNoticeId(
  normalized: Pick<NormalizedImport, 'repairs' | 'conflicts' | 'droppedFields' | 'diagnostics'>,
  stem: string,
): string {
  const existing = new Set([
    ...normalized.repairs.map((notice) => notice.id),
    ...normalized.conflicts.map((notice) => notice.id),
    ...normalized.droppedFields.map((notice) => notice.id),
    ...normalized.diagnostics.map((notice) => notice.id),
  ]);
  let sequence = 1;
  let candidate = `coordinator:${stem}:${sequence}`;
  while (existing.has(candidate)) {
    sequence += 1;
    candidate = `coordinator:${stem}:${sequence}`;
  }
  return candidate;
}
