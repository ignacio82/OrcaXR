import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type AssetId, type ObjectId, type VolumeId } from '../domain/ids';
import { emptyFacetAnnotations, type ProjectState, type ProjectVolume, type Transform } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { decodeIndexedMeshAsset } from '../meshCodec';
import type { SelectionRef } from '../selection';
import type { MeshTopologyReplacementGuard } from './topologyCommands';

const CORE_FACET_ATTRIBUTES_KEY = 'https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes';

/**
 * Full source-volume identity captured before an asynchronous engine split.
 * The complete volume fingerprint is needed because centering the generated
 * parts depends on the source transform, not topology alone.
 */
export interface VolumeSplitGuard extends MeshTopologyReplacementGuard {
  readonly volumeFingerprint: string;
}

/**
 * One engine-prepared output in the pinned TriangleMesh::split order.
 * sourceTriangleIndices must identify a lossless, non-overlapping partition of
 * the guarded source; geometry bytes and the recentered transform are staged
 * outside the synchronous command.
 */
export interface PreparedVolumeSplitPart {
  readonly volumeId: VolumeId;
  readonly asset: AssetPayload;
  readonly transform: Transform;
  readonly sourceTriangleIndices: readonly number[];
}

interface NormalizedSplitPart {
  readonly volumeId: VolumeId;
  readonly assetId: AssetId;
  readonly transform: Transform;
  readonly sourceTriangleIndices: readonly number[];
  readonly triangleCount: number;
}

interface PreviousVolumeSplit {
  readonly objectId: ObjectId;
  readonly volumeIndex: number;
  readonly originalVolume: ProjectVolume;
  readonly generatedVolumes: readonly ProjectVolume[];
  readonly ownedAssets: readonly AssetPayload[];
  readonly oldDescriptorIndex: number;
  readonly removedOldAsset?: AssetPayload;
}

export function captureVolumeSplitGuard(state: ProjectState, volumeId: VolumeId): VolumeSplitGuard {
  const found = findVolume(state, volumeId);
  if (!found) throw new Error(`Unknown volume ${volumeId}`);
  const descriptors = state.sourceAssets.filter((asset) => asset.id === found.volume.source.assetId);
  if (descriptors.length !== 1) {
    throw new Error(`Volume ${volumeId} source asset is not declared exactly once`);
  }
  return {
    volumeId,
    assetId: found.volume.source.assetId,
    assetDigest: descriptors[0].digest,
    topologyRevision: found.volume.source.topologyRevision,
    triangleCount: found.volume.source.triangleCount,
    volumeFingerprint: canonicalStringify(found.volume),
  };
}

/**
 * Commit a lossless, pre-staged "Split to parts" result into one canonical
 * object. Every resulting part receives a fresh stable volume ID, an immutable
 * mesh source, reset triangle annotations, and the exact staged transform.
 *
 * This command deliberately does not invoke the legacy web MeshSplit helper:
 * its vertex-touch connectivity differs from the pinned engine's shared-edge
 * connectivity. Engine work must finish before this synchronous commit.
 */
export class SplitVolumeToPartsCommand implements ProjectCommand {
  readonly type = 'split-volume-to-parts';
  readonly label = 'Split volume to parts';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly guard: VolumeSplitGuard;
  private readonly parts: readonly NormalizedSplitPart[];
  private readonly assets: readonly AssetPayload[];
  private previous?: PreviousVolumeSplit;

  constructor(guard: VolumeSplitGuard, parts: readonly PreparedVolumeSplitPart[]) {
    assertGuardShape(guard);
    this.guard = { ...guard };
    const normalized = normalizePreparedParts(guard, parts);
    this.parts = normalized.parts;
    this.assets = normalized.assets;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireGuardedVolume(context, state, this.guard);
    assertRepresentableMetadata(found.volume);
    const ownedAssets = classifyPreparedAssets(context, state, this.parts, this.assets);

    const originalVolume = cloneJson(found.volume);
    const volumeIndex = found.object.volumes.findIndex((volume) => volume.id === this.guard.volumeId);
    const oldDescriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === this.guard.assetId);
    const oldAsset = requireCanonicalMeshAsset(context, state, this.guard.assetId);
    const generatedVolumes = this.parts.map((part, index): ProjectVolume => {
      const generated = cloneJson(originalVolume);
      generated.id = part.volumeId;
      generated.name = `${originalVolume.name}_${index + 1}`;
      generated.source = {
        assetId: part.assetId,
        topologyRevision: 0,
        triangleCount: part.triangleCount,
      };
      generated.transform = cloneJson(part.transform);
      generated.annotations = emptyFacetAnnotations(0);
      return generated;
    });

    found.object.volumes.splice(volumeIndex, 1, ...generatedVolumes.map(cloneJson));
    const removeOldAsset = !projectReferencesAsset(state, this.guard.assetId);
    const descriptorInsertIndex = removeOldAsset ? oldDescriptorIndex : oldDescriptorIndex + 1;
    if (removeOldAsset) state.sourceAssets.splice(oldDescriptorIndex, 1);
    state.sourceAssets.splice(descriptorInsertIndex, 0, ...ownedAssets.map((asset) => cloneJson(asset.descriptor)));

    for (const asset of ownedAssets) context.assets.put(asset.descriptor, asset.bytes);
    context.project.replaceState(state, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    if (removeOldAsset) context.assets.remove(this.guard.assetId);
    remapSplitSelection(
      context,
      this.guard.volumeId,
      this.parts.map((part) => part.volumeId),
    );

    this.previous = {
      objectId: found.object.id,
      volumeIndex,
      originalVolume,
      generatedVolumes: generatedVolumes.map(cloneJson),
      ownedAssets: ownedAssets.map(cloneAssetPayload),
      oldDescriptorIndex,
      ...(removeOldAsset ? { removedOldAsset: oldAsset } : {}),
    };
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('SplitVolumeToPartsCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = state.plates
      .flatMap((plate) => plate.objects)
      .find((candidate) => candidate.id === this.previous!.objectId);
    if (!object) throw new Error(`Split object ${this.previous.objectId} is missing during undo`);

    const generated = object.volumes.slice(
      this.previous.volumeIndex,
      this.previous.volumeIndex + this.previous.generatedVolumes.length,
    );
    if (canonicalStringify(generated) !== canonicalStringify(this.previous.generatedVolumes)) {
      throw new Error(`Generated split parts for volume ${this.guard.volumeId} changed before undo`);
    }
    if (findVolume(state, this.guard.volumeId)) {
      throw new Error(`Original volume ${this.guard.volumeId} already exists before split undo`);
    }
    for (const asset of this.assets) requireCanonicalMeshAsset(context, state, asset.descriptor.id);

    object.volumes.splice(
      this.previous.volumeIndex,
      this.previous.generatedVolumes.length,
      cloneJson(this.previous.originalVolume),
    );
    for (const asset of this.previous.ownedAssets) {
      if (projectReferencesAsset(state, asset.descriptor.id)) {
        throw new Error(`Split asset ${asset.descriptor.id} acquired another canonical reference before undo`);
      }
      const descriptorCount = state.sourceAssets.filter((descriptor) => descriptor.id === asset.descriptor.id).length;
      if (descriptorCount !== 1) {
        throw new Error(`Split asset ${asset.descriptor.id} is not declared exactly once during undo`);
      }
    }
    const splitAssetIds = new Set(this.previous.ownedAssets.map((asset) => asset.descriptor.id));
    state.sourceAssets = state.sourceAssets.filter((descriptor) => !splitAssetIds.has(descriptor.id));

    if (this.previous.removedOldAsset) {
      if (
        state.sourceAssets.some((asset) => asset.id === this.guard.assetId) ||
        context.assets.has(this.guard.assetId)
      ) {
        throw new Error(`Original asset ${this.guard.assetId} collides with canonical state during undo`);
      }
      if (this.previous.oldDescriptorIndex > state.sourceAssets.length) {
        throw new Error(`Original asset ${this.guard.assetId} cannot be restored at its prior position`);
      }
      state.sourceAssets.splice(
        this.previous.oldDescriptorIndex,
        0,
        cloneJson(this.previous.removedOldAsset.descriptor),
      );
      context.assets.put(this.previous.removedOldAsset.descriptor, this.previous.removedOldAsset.bytes);
    } else {
      requireCanonicalMeshAsset(context, state, this.guard.assetId);
    }

    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    for (const asset of this.previous.ownedAssets) context.assets.remove(asset.descriptor.id);
  }

  estimateBytes(): number {
    let estimate =
      canonicalStringify(this.guard).length +
      canonicalStringify(this.parts).length +
      this.assets.reduce(
        (total, asset) => total + canonicalStringify(asset.descriptor).length + asset.bytes.byteLength,
        0,
      );
    if (this.previous) {
      estimate +=
        canonicalStringify(this.previous.originalVolume).length +
        canonicalStringify(this.previous.generatedVolumes).length;
      if (this.previous.removedOldAsset) {
        estimate +=
          canonicalStringify(this.previous.removedOldAsset.descriptor).length +
          this.previous.removedOldAsset.bytes.byteLength;
      }
    }
    return Math.max(1, estimate);
  }
}

function normalizePreparedParts(
  guard: VolumeSplitGuard,
  parts: readonly PreparedVolumeSplitPart[],
): { parts: readonly NormalizedSplitPart[]; assets: readonly AssetPayload[] } {
  if (parts.length < 2) throw new Error('Split to parts requires at least two prepared components');
  const volumeIds = new Set<VolumeId>();
  const assetsById = new Map<AssetId, AssetPayload>();
  const assetIdByDigest = new Map<string, AssetId>();
  const seenSourceTriangles = new Set<number>();
  const normalized: NormalizedSplitPart[] = [];

  for (const [index, part] of parts.entries()) {
    if (!isStableEntityId(part.volumeId)) {
      throw new Error(`Prepared split volume ID ${part.volumeId} is not stable`);
    }
    if (part.volumeId === guard.volumeId) {
      throw new Error('Pinned split-to-parts semantics require fresh IDs for every generated volume');
    }
    if (volumeIds.has(part.volumeId)) throw new Error(`Prepared split volume ID ${part.volumeId} is duplicated`);
    volumeIds.add(part.volumeId);
    assertTransform(part.transform, `Prepared split part ${index + 1}`);

    const asset = cloneAssetPayload(part.asset);
    if (!isStableEntityId(asset.descriptor.id)) {
      throw new Error(`Prepared split asset ID ${asset.descriptor.id} is not stable`);
    }
    if (asset.descriptor.id === guard.assetId) {
      throw new Error(`Prepared split asset ${asset.descriptor.id} collides with the source asset`);
    }
    if (!asset.descriptor.digest.trim()) throw new Error('Prepared split asset digest is required');
    const mesh = decodeIndexedMeshAsset(asset);
    if (mesh.vertices.length === 0 || mesh.triangles.length === 0) {
      throw new Error(`Prepared split part ${index + 1} must contain a non-empty mesh`);
    }
    if (mesh.triangles.length !== part.sourceTriangleIndices.length) {
      throw new Error(
        `Prepared split part ${index + 1} has ${mesh.triangles.length} triangles but maps ${part.sourceTriangleIndices.length}`,
      );
    }

    for (const triangle of part.sourceTriangleIndices) {
      if (!Number.isSafeInteger(triangle) || triangle < 0 || triangle >= guard.triangleCount) {
        throw new Error(`Prepared split source triangle ${triangle} is outside the guarded topology`);
      }
      if (seenSourceTriangles.has(triangle)) {
        throw new Error(`Prepared split source triangle ${triangle} appears in multiple parts`);
      }
      seenSourceTriangles.add(triangle);
    }

    const existingAsset = assetsById.get(asset.descriptor.id);
    if (existingAsset && !sameAssetPayload(existingAsset, asset)) {
      throw new Error(`Prepared split asset ID ${asset.descriptor.id} has conflicting immutable payloads`);
    }
    const digestOwner = assetIdByDigest.get(asset.descriptor.digest);
    if (digestOwner && digestOwner !== asset.descriptor.id) {
      throw new Error(
        `Prepared split digest ${asset.descriptor.digest} is assigned to both ${digestOwner} and ${asset.descriptor.id}`,
      );
    }
    assetsById.set(asset.descriptor.id, existingAsset ?? asset);
    assetIdByDigest.set(asset.descriptor.digest, asset.descriptor.id);
    normalized.push({
      volumeId: part.volumeId,
      assetId: asset.descriptor.id,
      transform: cloneJson(part.transform),
      sourceTriangleIndices: [...part.sourceTriangleIndices],
      triangleCount: mesh.triangles.length,
    });
  }

  if (seenSourceTriangles.size !== guard.triangleCount) {
    throw new Error(
      `Prepared split maps ${seenSourceTriangles.size} of ${guard.triangleCount} source triangles; lossy splits are not representable`,
    );
  }
  for (const assetId of assetsById.keys()) {
    if (volumeIds.has(assetId as unknown as VolumeId)) {
      throw new Error(`Injected stable ID ${assetId} is reused by a split volume and asset`);
    }
  }
  return { parts: normalized, assets: [...assetsById.values()] };
}

function assertGuardShape(guard: VolumeSplitGuard): void {
  if (!isStableEntityId(guard.volumeId)) throw new Error(`Volume ID ${guard.volumeId} is not stable`);
  if (!isStableEntityId(guard.assetId)) throw new Error(`Asset ID ${guard.assetId} is not stable`);
  if (!guard.assetDigest.trim()) throw new Error('Volume split guard asset digest is required');
  if (!guard.volumeFingerprint) throw new Error('Volume split guard fingerprint is required');
  if (!Number.isSafeInteger(guard.topologyRevision) || guard.topologyRevision < 0) {
    throw new Error('Volume split guard topology revision must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(guard.triangleCount) || guard.triangleCount < 1) {
    throw new Error('Volume split guard triangle count must be a positive safe integer');
  }
}

function requireGuardedVolume(
  context: CommandContext,
  state: ProjectState,
  guard: VolumeSplitGuard,
): NonNullable<ReturnType<typeof findVolume>> {
  const found = findVolume(state, guard.volumeId);
  if (!found) throw new Error(`Stale volume split: source volume ${guard.volumeId} is missing`);
  const source = found.volume.source;
  if (
    source.assetId !== guard.assetId ||
    source.topologyRevision !== guard.topologyRevision ||
    source.triangleCount !== guard.triangleCount
  ) {
    throw new Error(`Stale volume split: source topology for ${guard.volumeId} changed`);
  }
  if (canonicalStringify(found.volume) !== guard.volumeFingerprint) {
    throw new Error(`Stale volume split: source metadata or transform for ${guard.volumeId} changed`);
  }
  const asset = requireCanonicalMeshAsset(context, state, guard.assetId);
  if (asset.descriptor.digest !== guard.assetDigest || asset.descriptor.mesh?.triangleCount !== guard.triangleCount) {
    throw new Error(`Stale volume split: source asset for ${guard.volumeId} changed`);
  }
  return found;
}

function assertRepresentableMetadata(volume: ProjectVolume): void {
  if (Object.prototype.hasOwnProperty.call(volume.extensionData ?? {}, CORE_FACET_ATTRIBUTES_KEY)) {
    throw new Error(
      'Split to parts cannot preserve opaque triangle-indexed 3MF extension metadata without an explicit facet map',
    );
  }
}

function classifyPreparedAssets(
  context: CommandContext,
  state: ProjectState,
  parts: readonly NormalizedSplitPart[],
  assets: readonly AssetPayload[],
): AssetPayload[] {
  const existingIds = collectCanonicalEntityIds(state);
  for (const id of parts.map((part) => part.volumeId)) {
    if (existingIds.has(id)) throw new Error(`Injected split ID ${id} already exists in the project`);
  }
  const ownedAssets: AssetPayload[] = [];
  for (const asset of assets) {
    const descriptor = state.sourceAssets.find((candidate) => candidate.id === asset.descriptor.id);
    const repositoryAsset = context.assets.get(asset.descriptor.id);
    if (Boolean(descriptor) !== Boolean(repositoryAsset)) {
      throw new Error(
        `Prepared split asset ${asset.descriptor.id} is inconsistent between canonical state and repository`,
      );
    }
    if (descriptor && repositoryAsset) {
      if (
        canonicalStringify(descriptor) !== canonicalStringify(asset.descriptor) ||
        !sameAssetPayload(repositoryAsset, asset)
      ) {
        throw new Error(`Prepared split asset ${asset.descriptor.id} collides with a different immutable payload`);
      }
      continue;
    }
    if (existingIds.has(asset.descriptor.id)) {
      throw new Error(`Injected split ID ${asset.descriptor.id} already exists in the project`);
    }
    const stateDigest = state.sourceAssets.find((descriptor) => descriptor.digest === asset.descriptor.digest);
    if (stateDigest) {
      throw new Error(`Prepared split asset digest already exists as ${stateDigest.id}; remap before committing`);
    }
    const repositoryDigest = context.assets.findByDigest(asset.descriptor.digest);
    if (repositoryDigest) {
      throw new Error(`Prepared split asset digest collides with repository asset ${repositoryDigest.descriptor.id}`);
    }
    ownedAssets.push(asset);
  }
  return ownedAssets;
}

function requireCanonicalMeshAsset(context: CommandContext, state: ProjectState, assetId: AssetId): AssetPayload {
  const descriptors = state.sourceAssets.filter((asset) => asset.id === assetId);
  if (descriptors.length !== 1) {
    throw new Error(`Asset ${assetId} is not declared exactly once in canonical state`);
  }
  const payload = context.assets.get(assetId);
  if (!payload) throw new Error(`Asset ${assetId} is missing from the canonical repository`);
  if (canonicalStringify(payload.descriptor) !== canonicalStringify(descriptors[0])) {
    throw new Error(`Asset ${assetId} metadata differs between canonical state and repository`);
  }
  decodeIndexedMeshAsset(payload);
  return payload;
}

function remapSplitSelection(
  context: CommandContext,
  sourceVolumeId: VolumeId,
  generatedVolumeIds: readonly VolumeId[],
): void {
  const before = context.selection.getSnapshot();
  const selectedSource = before.refs.some((ref) => ref.kind === 'volume' && ref.id === sourceVolumeId);
  const primarySource = before.primary?.kind === 'volume' && before.primary.id === sourceVolumeId;
  if (!selectedSource && !primarySource) return;

  const refs: SelectionRef[] = [];
  for (const ref of before.refs) {
    if (ref.kind === 'volume' && ref.id === sourceVolumeId) {
      refs.push(...generatedVolumeIds.map((id): SelectionRef => ({ kind: 'volume', id })));
    } else {
      refs.push(ref);
    }
  }
  const primary = primarySource ? ({ kind: 'volume', id: generatedVolumeIds[0] } as const) : before.primary;
  context.selection.set(refs, primary);
}

function collectCanonicalEntityIds(state: ProjectState): Set<string> {
  const ids = new Set<string>([state.id]);
  for (const plate of state.plates) {
    ids.add(plate.id);
    for (const object of plate.objects) {
      ids.add(object.id);
      object.volumes.forEach((volume) => ids.add(volume.id));
      object.instances.forEach((instance) => ids.add(instance.id));
      object.layerRanges.forEach((range) => ids.add(range.id));
    }
  }
  state.filaments.physical.forEach((filament) => ids.add(filament.id));
  state.filaments.mixed.forEach((filament) => ids.add(filament.id));
  state.sourceAssets.forEach((asset) => ids.add(asset.id));
  state.customGcode.forEach((entry) => ids.add(entry.id));
  state.thumbnails.forEach((thumbnail) => ids.add(thumbnail.id));
  state.extensionBlobs.forEach((blob) => ids.add(blob.id));
  return ids;
}

function projectReferencesAsset(state: ProjectState, assetId: AssetId): boolean {
  return (
    state.plates.some((plate) =>
      plate.objects.some((object) => object.volumes.some((volume) => volume.source.assetId === assetId)),
    ) ||
    state.thumbnails.some((thumbnail) => thumbnail.assetId === assetId) ||
    state.extensionBlobs.some((blob) => blob.assetId === assetId)
  );
}

function assertTransform(transform: Transform, label: string): void {
  if (transform.translationMm.length !== 3 || transform.rotation.length !== 4 || transform.scale.length !== 3) {
    throw new Error(`${label} transform has invalid dimensions`);
  }
  if (
    [...transform.translationMm, ...transform.rotation, ...transform.scale].some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`${label} transform must be finite`);
  }
  if (transform.scale.some((value) => Math.abs(value) < 1e-12)) {
    throw new Error(`${label} transform scale cannot contain zero`);
  }
  const rotationNorm = transform.rotation.reduce((sum, value) => sum + value * value, 0);
  if (rotationNorm < 1e-12) throw new Error(`${label} transform rotation cannot be zero`);
}

function cloneAssetPayload(payload: AssetPayload): AssetPayload {
  return {
    descriptor: cloneJson(payload.descriptor),
    bytes: payload.bytes.slice(),
  };
}

function sameAssetPayload(left: AssetPayload, right: AssetPayload): boolean {
  return (
    canonicalStringify(left.descriptor) === canonicalStringify(right.descriptor) &&
    left.bytes.byteLength === right.bytes.byteLength &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
