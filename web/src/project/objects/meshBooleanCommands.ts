import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import {
  isStableEntityId,
  type AssetId,
  type InstanceId,
  type ObjectId,
  type PlateId,
  type VolumeId,
} from '../domain/ids';
import {
  emptyFacetAnnotations,
  identityTransform,
  type FacetAnnotations,
  type MeshSourceRef,
  type ProjectInstance,
  type ProjectObject,
  type ProjectState,
  type Transform,
} from '../domain/model';
import { findInstance, findObject } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { decodeIndexedMeshAsset } from '../meshCodec';

export type MeshBooleanOp = 'UNION' | 'A_NOT_B' | 'INTERSECTION';

export interface MeshBooleanGuard {
  readonly targetInstanceId: InstanceId;
  readonly targetVolumeId: VolumeId;
  readonly targetAssetId: AssetId;
  readonly targetAssetDigest: string;
  readonly targetTopologyRevision: number;
  readonly targetTriangleCount: number;
  readonly otherInstanceId: InstanceId;
}

interface PreviousTargetState {
  readonly source: MeshSourceRef;
  readonly annotations: FacetAnnotations;
  readonly volumeTransform: Transform;
  readonly instanceTransform: Transform;
  readonly oldDescriptorIndex: number;
  readonly removedOldAsset?: AssetPayload;
}

interface RemovedOtherObject {
  readonly kind: 'object';
  readonly plateId: PlateId;
  readonly objectIndex: number;
  readonly object: ProjectObject;
  readonly removedAssets: readonly { readonly descriptorIndex: number; readonly payload: AssetPayload }[];
}

interface RemovedOtherInstance {
  readonly kind: 'instance';
  readonly objectId: ObjectId;
  readonly instanceIndex: number;
  readonly instance: ProjectInstance;
}

type RemovedOtherState = RemovedOtherObject | RemovedOtherInstance;

export class MeshBooleanCommand implements ProjectCommand {
  readonly type = 'mesh-boolean';
  readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;

  private readonly guard: MeshBooleanGuard;
  private readonly replacement: AssetPayload;
  private readonly replacementTriangleCount: number;
  private readonly op: MeshBooleanOp;
  private previousTarget?: PreviousTargetState;
  private removedOther?: RemovedOtherState;

  constructor(guard: MeshBooleanGuard, replacement: AssetPayload, op: MeshBooleanOp) {
    assertBooleanGuard(guard);
    this.guard = { ...guard };
    this.op = op;
    this.label = op === 'UNION' ? 'Union meshes' : op === 'A_NOT_B' ? 'Subtract mesh' : 'Intersect meshes';
    this.replacement = cloneAssetPayload(replacement);
    this.replacementTriangleCount = validateReplacementMesh(this.replacement);
    if (this.replacement.descriptor.id === this.guard.targetAssetId) {
      throw new Error(`Replacement asset ${this.replacement.descriptor.id} collides with the current mesh asset`);
    }
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const target = requireGuardedTarget(context, state, this.guard);
    const other = requireOtherInstance(state, this.guard.otherInstanceId);
    assertReplacementAvailable(context, state, this.replacement);

    // Save previous target state
    const oldDescriptorIndex = state.sourceAssets.findIndex((a) => a.id === this.guard.targetAssetId);
    const oldAsset = requireCanonicalMeshAsset(context, state, this.guard.targetAssetId);
    const previousSource = cloneJson(target.volume.source);
    const previousAnnotations = cloneJson(target.volume.annotations);
    const previousVolumeTransform = cloneJson(target.volume.transform);
    const previousInstanceTransform = cloneJson(target.instance.transform);
    const nextRevision = this.guard.targetTopologyRevision + 1;

    // Mutate target volume & instance
    target.volume.source = {
      assetId: this.replacement.descriptor.id,
      topologyRevision: nextRevision,
      triangleCount: this.replacementTriangleCount,
    };
    target.volume.annotations = emptyFacetAnnotations(nextRevision);
    target.volume.transform = identityTransform();
    target.instance.transform = identityTransform();
    state.sourceAssets.push(cloneJson(this.replacement.descriptor));

    // Handle removal of other instance / object
    let removedOther: RemovedOtherState;
    if (other.object.instances.length <= 1) {
      const plate = other.plate;
      const objectIndex = plate.objects.findIndex((o) => o.id === other.object.id);
      if (objectIndex < 0) throw new Error(`Object ${other.object.id} index not found`);
      const removedObject = cloneJson(other.object);
      plate.objects.splice(objectIndex, 1);

      // Check which assets from the removed object are now completely unreferenced
      const removedAssets: { descriptorIndex: number; payload: AssetPayload }[] = [];
      for (const vol of removedObject.volumes) {
        if (!projectReferencesAsset(state, vol.source.assetId) && vol.source.assetId !== this.guard.targetAssetId) {
          const descIdx = state.sourceAssets.findIndex((a) => a.id === vol.source.assetId);
          if (descIdx >= 0) {
            const assetPayload = requireCanonicalMeshAsset(context, state, vol.source.assetId);
            removedAssets.push({ descriptorIndex: descIdx, payload: assetPayload });
            state.sourceAssets.splice(descIdx, 1);
          }
        }
      }
      removedOther = {
        kind: 'object',
        plateId: plate.id,
        objectIndex,
        object: removedObject,
        removedAssets,
      };
    } else {
      const instanceIndex = other.object.instances.findIndex((i) => i.id === this.guard.otherInstanceId);
      if (instanceIndex < 0) throw new Error(`Instance ${this.guard.otherInstanceId} index not found`);
      const removedInstance = cloneJson(other.instance);
      other.object.instances.splice(instanceIndex, 1);
      removedOther = {
        kind: 'instance',
        objectId: other.object.id,
        instanceIndex,
        instance: removedInstance,
      };
    }

    // Check if target old asset is unreferenced
    const removeOldTargetAsset = !projectReferencesAsset(state, this.guard.targetAssetId);
    if (removeOldTargetAsset) {
      const idx = state.sourceAssets.findIndex((a) => a.id === this.guard.targetAssetId);
      if (idx >= 0) state.sourceAssets.splice(idx, 1);
    }

    // Commit assets and state
    context.assets.put(this.replacement.descriptor, this.replacement.bytes);
    context.project.replaceState(state, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    if (removeOldTargetAsset) context.assets.remove(this.guard.targetAssetId);
    if (removedOther.kind === 'object') {
      for (const rem of removedOther.removedAssets) {
        context.assets.remove(rem.payload.descriptor.id);
      }
    }

    // Set selection to target instance
    context.selection.set([{ kind: 'instance', id: this.guard.targetInstanceId }]);

    this.previousTarget = {
      source: previousSource,
      annotations: previousAnnotations,
      volumeTransform: previousVolumeTransform,
      instanceTransform: previousInstanceTransform,
      oldDescriptorIndex,
      ...(removeOldTargetAsset ? { removedOldAsset: oldAsset } : {}),
    };
    this.removedOther = removedOther;
  }

  revert(context: CommandContext): void {
    if (!this.previousTarget || !this.removedOther) {
      throw new Error('MeshBooleanCommand has not been applied');
    }

    const state = cloneProjectState(context.project.getSnapshot().state);
    const target = findInstance(state, this.guard.targetInstanceId);
    if (!target) throw new Error(`Target instance ${this.guard.targetInstanceId} missing on revert`);
    const targetVol = target.object.volumes.find((v) => v.id === this.guard.targetVolumeId);
    if (!targetVol) throw new Error(`Target volume ${this.guard.targetVolumeId} missing on revert`);

    // Restore target
    targetVol.source = cloneJson(this.previousTarget.source);
    targetVol.annotations = cloneJson(this.previousTarget.annotations);
    targetVol.transform = cloneJson(this.previousTarget.volumeTransform);
    target.instance.transform = cloneJson(this.previousTarget.instanceTransform);

    const replacementIndex = state.sourceAssets.findIndex((a) => a.id === this.replacement.descriptor.id);
    if (replacementIndex >= 0) state.sourceAssets.splice(replacementIndex, 1);

    // Restore target old asset if removed
    if (this.previousTarget.removedOldAsset) {
      state.sourceAssets.splice(
        this.previousTarget.oldDescriptorIndex,
        0,
        cloneJson(this.previousTarget.removedOldAsset.descriptor),
      );
      context.assets.put(this.previousTarget.removedOldAsset.descriptor, this.previousTarget.removedOldAsset.bytes);
    }

    // Restore other object / instance
    if (this.removedOther.kind === 'object') {
      const plate = state.plates.find((p) => p.id === (this.removedOther as RemovedOtherObject).plateId);
      if (!plate) throw new Error(`Plate ${(this.removedOther as RemovedOtherObject).plateId} missing on revert`);
      plate.objects.splice(
        (this.removedOther as RemovedOtherObject).objectIndex,
        0,
        cloneJson((this.removedOther as RemovedOtherObject).object),
      );
      for (const rem of (this.removedOther as RemovedOtherObject).removedAssets) {
        state.sourceAssets.splice(rem.descriptorIndex, 0, cloneJson(rem.payload.descriptor));
        context.assets.put(rem.payload.descriptor, rem.payload.bytes);
      }
    } else {
      const object = findObject(state, (this.removedOther as RemovedOtherInstance).objectId);
      if (!object) {
        throw new Error(`Object ${(this.removedOther as RemovedOtherInstance).objectId} missing on revert`);
      }
      object.object.instances.splice(
        (this.removedOther as RemovedOtherInstance).instanceIndex,
        0,
        cloneJson((this.removedOther as RemovedOtherInstance).instance),
      );
    }

    context.project.replaceState(state, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
    context.assets.remove(this.replacement.descriptor.id);

    // Set selection back to target instance
    context.selection.set([{ kind: 'instance', id: this.guard.targetInstanceId }]);
  }

  estimateBytes(): number {
    let estimate =
      canonicalStringify(this.guard).length +
      canonicalStringify(this.replacement.descriptor).length +
      this.replacement.bytes.byteLength;
    if (this.previousTarget) {
      estimate += canonicalStringify(this.previousTarget).length;
    }
    if (this.removedOther) {
      estimate += canonicalStringify(this.removedOther).length;
    }
    return Math.max(1, estimate);
  }
}

function assertBooleanGuard(guard: MeshBooleanGuard): void {
  if (!isStableEntityId(guard.targetInstanceId)) throw new Error(`Target instance ID is not stable`);
  if (!isStableEntityId(guard.targetVolumeId)) throw new Error(`Target volume ID is not stable`);
  if (!isStableEntityId(guard.targetAssetId)) throw new Error(`Target asset ID is not stable`);
  if (!isStableEntityId(guard.otherInstanceId)) throw new Error(`Other instance ID is not stable`);
  if (!guard.targetAssetDigest.trim()) throw new Error('Topology guard asset digest is required');
  if (!Number.isSafeInteger(guard.targetTopologyRevision) || guard.targetTopologyRevision < 0) {
    throw new Error('Topology guard revision must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(guard.targetTriangleCount) || guard.targetTriangleCount < 0) {
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

function requireGuardedTarget(context: CommandContext, state: ProjectState, guard: MeshBooleanGuard) {
  const foundInstance = findInstance(state, guard.targetInstanceId);
  if (!foundInstance) throw new Error(`Target instance ${guard.targetInstanceId} is missing`);
  const foundVolume = foundInstance.object.volumes.find((v) => v.id === guard.targetVolumeId);
  if (!foundVolume) throw new Error(`Target volume ${guard.targetVolumeId} is missing`);

  const source = foundVolume.source;
  if (source.assetId !== guard.targetAssetId) {
    throw new Error(`Target volume ${guard.targetVolumeId} changed mesh asset`);
  }
  if (source.topologyRevision !== guard.targetTopologyRevision) {
    throw new Error(`Target volume ${guard.targetVolumeId} changed topology revision`);
  }
  if (source.triangleCount !== guard.targetTriangleCount) {
    throw new Error(`Target volume ${guard.targetVolumeId} changed triangle count`);
  }
  const asset = requireCanonicalMeshAsset(context, state, guard.targetAssetId);
  if (asset.descriptor.digest !== guard.targetAssetDigest) {
    throw new Error(`Target volume ${guard.targetVolumeId} changed asset digest`);
  }
  return {
    plate: foundInstance.plate,
    object: foundInstance.object,
    instance: foundInstance.instance,
    volume: foundVolume,
  };
}

function requireOtherInstance(state: ProjectState, instanceId: InstanceId) {
  const found = findInstance(state, instanceId);
  if (!found) throw new Error(`Other instance ${instanceId} is missing`);
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
