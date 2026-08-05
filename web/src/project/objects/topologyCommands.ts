import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type AssetId, type VolumeId } from '../domain/ids';
import { emptyFacetAnnotations, type FacetAnnotations, type MeshSourceRef, type ProjectState } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { decodeIndexedMeshAsset } from '../meshCodec';

/**
 * Identity and topology captured when an asynchronous mesh operation starts.
 * A staged result may commit only while every field still describes the live
 * canonical volume.
 */
export interface MeshTopologyReplacementGuard {
  readonly volumeId: VolumeId;
  readonly assetId: AssetId;
  readonly assetDigest: string;
  readonly topologyRevision: number;
  readonly triangleCount: number;
}

interface PreviousTopology {
  readonly source: MeshSourceRef;
  readonly annotations: FacetAnnotations;
  readonly oldDescriptorIndex: number;
  readonly removedOldAsset?: AssetPayload;
}

/**
 * Atomically replace one volume's immutable mesh and invalidate every
 * triangle-indexed annotation channel. Mesh work must be staged before this
 * synchronous command is executed; engine actions remain gated until such a
 * coordinator exists.
 */
export class ReplaceVolumeMeshCommand implements ProjectCommand {
  readonly type = 'replace-volume-mesh';
  readonly label = 'Replace mesh topology';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly guard: MeshTopologyReplacementGuard;
  private readonly replacement: AssetPayload;
  private readonly replacementTriangleCount: number;
  private previous?: PreviousTopology;

  constructor(guard: MeshTopologyReplacementGuard, replacement: AssetPayload) {
    assertGuardShape(guard);
    this.guard = { ...guard };
    this.replacement = cloneAssetPayload(replacement);
    this.replacementTriangleCount = validateReplacementMesh(this.replacement);
    if (this.replacement.descriptor.id === this.guard.assetId) {
      throw new Error(`Replacement asset ${this.replacement.descriptor.id} collides with the current mesh asset`);
    }
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireGuardedVolume(context, state, this.guard);
    assertReplacementAvailable(context, state, this.replacement);

    const oldDescriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === this.guard.assetId);
    const oldAsset = requireCanonicalMeshAsset(context, state, this.guard.assetId);
    const previousSource = cloneJson(found.volume.source);
    const previousAnnotations = cloneJson(found.volume.annotations);
    const nextRevision = this.guard.topologyRevision + 1;

    found.volume.source = {
      assetId: this.replacement.descriptor.id,
      topologyRevision: nextRevision,
      triangleCount: this.replacementTriangleCount,
    };
    found.volume.annotations = emptyFacetAnnotations(nextRevision);
    state.sourceAssets.push(cloneJson(this.replacement.descriptor));

    const removeOldAsset = !projectReferencesAsset(state, this.guard.assetId);
    if (removeOldAsset) state.sourceAssets.splice(oldDescriptorIndex, 1);

    context.assets.put(this.replacement.descriptor, this.replacement.bytes);
    context.project.replaceState(state, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    if (removeOldAsset) context.assets.remove(this.guard.assetId);

    this.previous = {
      source: previousSource,
      annotations: previousAnnotations,
      oldDescriptorIndex,
      ...(removeOldAsset ? { removedOldAsset: oldAsset } : {}),
    };
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('ReplaceVolumeMeshCommand has not been applied');

    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = requireReplacementVolume(context, state, this.guard, this.replacement, this.replacementTriangleCount);
    const replacementIndex = state.sourceAssets.findIndex((asset) => asset.id === this.replacement.descriptor.id);

    found.volume.source = cloneJson(this.previous.source);
    found.volume.annotations = cloneJson(this.previous.annotations);
    if (projectReferencesAsset(state, this.replacement.descriptor.id)) {
      throw new Error(
        `Replacement asset ${this.replacement.descriptor.id} acquired another canonical reference before undo`,
      );
    }
    state.sourceAssets.splice(replacementIndex, 1);

    if (this.previous.removedOldAsset) {
      if (
        state.sourceAssets.some((asset) => asset.id === this.guard.assetId) ||
        context.assets.has(this.guard.assetId)
      ) {
        throw new Error(`Old asset ${this.guard.assetId} collides with canonical state during undo`);
      }
      if (this.previous.oldDescriptorIndex > state.sourceAssets.length) {
        throw new Error(`Old asset ${this.guard.assetId} cannot be restored at its original position`);
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
    context.assets.remove(this.replacement.descriptor.id);
  }

  estimateBytes(): number {
    let estimate =
      canonicalStringify(this.guard).length +
      canonicalStringify(this.replacement.descriptor).length +
      this.replacement.bytes.byteLength;
    if (this.previous) {
      estimate += canonicalStringify({
        source: this.previous.source,
        annotations: this.previous.annotations,
      }).length;
      if (this.previous.removedOldAsset) {
        estimate +=
          canonicalStringify(this.previous.removedOldAsset.descriptor).length +
          this.previous.removedOldAsset.bytes.byteLength;
      }
    }
    return Math.max(1, estimate);
  }
}

function assertGuardShape(guard: MeshTopologyReplacementGuard): void {
  if (!isStableEntityId(guard.volumeId)) throw new Error(`Volume ID ${guard.volumeId} is not stable`);
  if (!isStableEntityId(guard.assetId)) throw new Error(`Asset ID ${guard.assetId} is not stable`);
  if (!guard.assetDigest.trim()) throw new Error('Topology guard asset digest is required');
  if (!Number.isSafeInteger(guard.topologyRevision) || guard.topologyRevision < 0) {
    throw new Error('Topology guard revision must be a non-negative safe integer');
  }
  if (guard.topologyRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Topology guard revision cannot be incremented safely');
  }
  if (!Number.isSafeInteger(guard.triangleCount) || guard.triangleCount < 0) {
    throw new Error('Topology guard triangle count must be a non-negative safe integer');
  }
}

function validateReplacementMesh(payload: AssetPayload): number {
  if (!isStableEntityId(payload.descriptor.id)) {
    throw new Error(`Replacement asset ID ${payload.descriptor.id} is not stable`);
  }
  if (!payload.descriptor.digest.trim()) throw new Error('Replacement asset digest is required');
  const mesh = decodeIndexedMeshAsset(payload);
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0) {
    throw new Error('Replacement mesh must contain at least one vertex and one triangle');
  }
  return mesh.triangles.length;
}

function requireGuardedVolume(
  context: CommandContext,
  state: ProjectState,
  guard: MeshTopologyReplacementGuard,
): NonNullable<ReturnType<typeof findVolume>> {
  const found = findVolume(state, guard.volumeId);
  if (!found) throw new Error(`Stale topology guard: volume ${guard.volumeId} is missing`);
  const source = found.volume.source;
  if (source.assetId !== guard.assetId) {
    throw new Error(`Stale topology guard: volume ${guard.volumeId} changed mesh asset`);
  }
  if (source.topologyRevision !== guard.topologyRevision) {
    throw new Error(`Stale topology guard: volume ${guard.volumeId} changed topology revision`);
  }
  if (source.triangleCount !== guard.triangleCount) {
    throw new Error(`Stale topology guard: volume ${guard.volumeId} changed triangle count`);
  }
  const asset = requireCanonicalMeshAsset(context, state, guard.assetId);
  if (asset.descriptor.digest !== guard.assetDigest) {
    throw new Error(`Stale topology guard: volume ${guard.volumeId} changed asset digest`);
  }
  if (asset.descriptor.mesh?.triangleCount !== guard.triangleCount) {
    throw new Error(`Stale topology guard: volume ${guard.volumeId} asset topology changed`);
  }
  return found;
}

function requireReplacementVolume(
  context: CommandContext,
  state: ProjectState,
  guard: MeshTopologyReplacementGuard,
  replacement: AssetPayload,
  replacementTriangleCount: number,
): NonNullable<ReturnType<typeof findVolume>> {
  const found = findVolume(state, guard.volumeId);
  if (!found) throw new Error(`Replacement volume ${guard.volumeId} is missing during undo`);
  const source = found.volume.source;
  if (
    source.assetId !== replacement.descriptor.id ||
    source.topologyRevision !== guard.topologyRevision + 1 ||
    source.triangleCount !== replacementTriangleCount
  ) {
    throw new Error(`Replacement topology for volume ${guard.volumeId} changed before undo`);
  }
  if (
    canonicalStringify(found.volume.annotations) !==
    canonicalStringify(emptyFacetAnnotations(guard.topologyRevision + 1))
  ) {
    throw new Error(`Replacement annotations for volume ${guard.volumeId} changed before undo`);
  }
  const asset = requireCanonicalMeshAsset(context, state, replacement.descriptor.id);
  if (canonicalStringify(asset.descriptor) !== canonicalStringify(replacement.descriptor)) {
    throw new Error(`Replacement asset ${replacement.descriptor.id} metadata changed before undo`);
  }
  return found;
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

function assertReplacementAvailable(context: CommandContext, state: ProjectState, replacement: AssetPayload): void {
  const id = replacement.descriptor.id;
  if (state.sourceAssets.some((asset) => asset.id === id) || context.assets.has(id)) {
    throw new Error(`Replacement asset ${id} collides with an existing immutable asset`);
  }
  const stateDigestCollision = state.sourceAssets.find((asset) => asset.digest === replacement.descriptor.digest);
  if (stateDigestCollision) {
    throw new Error(`Replacement asset digest already exists as ${stateDigestCollision.id}; remap before committing`);
  }
  const repositoryDigestCollision = context.assets.findByDigest(replacement.descriptor.digest);
  if (repositoryDigestCollision) {
    throw new Error(
      `Replacement asset digest collides with repository asset ${repositoryDigestCollision.descriptor.id}`,
    );
  }
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

function cloneAssetPayload(payload: AssetPayload): AssetPayload {
  return {
    descriptor: cloneJson(payload.descriptor),
    bytes: payload.bytes.slice(),
  };
}
