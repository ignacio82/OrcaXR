/**
 * Adding and re-cutting embossed text volumes (P5.3.3).
 *
 * The text recipe travels with the volume, so an embossed part stays editable:
 * `EditEmbossTextCommand` re-cuts the mesh from a changed recipe rather than
 * treating the triangles as the only record of what the text said.
 */

import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type AssetId, type IdSource, type ObjectId, type VolumeId } from '../domain/ids';
import { emptyFacetAnnotations, type ProjectState, type ProjectVolume, type Transform } from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { encodeIndexedMeshAsset } from '../meshCodec';
import {
  assertEmbossConfiguration,
  buildEmbossedMesh,
  EmbossError,
  type EmbossTextConfiguration,
  type EmbossedMesh,
  type GlyphOutlineSource,
} from './emboss';

/** Identity of the placement, so an undo can prove nothing moved underneath it. */
export interface EmbossPlacement {
  readonly objectId: ObjectId;
  readonly volumeId: VolumeId;
  readonly assetId: AssetId;
  readonly transform: Transform;
}

/**
 * Cut the mesh for a recipe and package it as a canonical asset.
 *
 * Kept separate from the commands so a caller can preview the geometry, and
 * report a text that produced nothing, before committing anything to history.
 */
export function prepareEmbossedVolume(
  configuration: EmbossTextConfiguration,
  source: GlyphOutlineSource,
  assetId: AssetId,
): { asset: AssetPayload; mesh: EmbossedMesh } {
  assertEmbossConfiguration(configuration);
  if (!isStableEntityId(assetId)) throw new Error(`Asset ID ${assetId} is not stable`);
  const mesh = buildEmbossedMesh(configuration, source);
  const asset = encodeIndexedMeshAsset({
    id: assetId,
    positions: mesh.positions,
    indices: mesh.indices,
    sourceFilename: `${configuration.text.split('\n')[0].slice(0, 40) || 'text'}.emboss`,
  });
  return { asset, mesh };
}

/** Mint the identities a new embossed volume needs, from the session's source. */
export function embossVolumeIdentity(ids: IdSource): { volumeId: VolumeId; assetId: AssetId } {
  return { volumeId: ids.next<'volume'>('volume'), assetId: ids.next<'asset'>('asset') };
}

/** Add an embossed text volume to an existing object. */
export class AddEmbossTextCommand implements ProjectCommand {
  readonly type = 'add-emboss-text';
  readonly label = 'Add embossed text';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly placement: EmbossPlacement;
  private readonly configuration: EmbossTextConfiguration;
  private readonly asset: AssetPayload;
  private readonly triangleCount: number;
  private applied?: { volumeIndex: number; descriptorIndex: number };

  constructor(
    placement: EmbossPlacement,
    configuration: EmbossTextConfiguration,
    prepared: { asset: AssetPayload; mesh: EmbossedMesh },
  ) {
    if (prepared.asset.descriptor.id !== placement.assetId) {
      throw new Error(`Prepared asset ${prepared.asset.descriptor.id} does not match placement ${placement.assetId}`);
    }
    if (prepared.mesh.triangleCount === 0) {
      throw new EmbossError('This text produced no geometry to add', 'no-glyphs');
    }
    this.placement = { ...placement, transform: cloneJson(placement.transform) };
    this.configuration = cloneJson(configuration);
    this.asset = cloneAsset(prepared.asset);
    this.triangleCount = prepared.mesh.triangleCount;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.placement.objectId);
    if (findVolume(state, this.placement.volumeId)) {
      throw new Error(`Volume ${this.placement.volumeId} already exists`);
    }
    if (state.sourceAssets.some((asset) => asset.id === this.placement.assetId)) {
      throw new Error(`Asset ${this.placement.assetId} already exists`);
    }

    const volume: ProjectVolume = {
      id: this.placement.volumeId,
      name: firstLine(this.configuration.text),
      role: 'model',
      source: { assetId: this.placement.assetId, topologyRevision: 0, triangleCount: this.triangleCount },
      transform: cloneJson(this.placement.transform),
      config: {},
      annotations: emptyFacetAnnotations(0),
      embossText: cloneJson(this.configuration),
    };
    object.volumes.push(volume);
    state.sourceAssets.push(cloneJson(this.asset.descriptor));
    context.assets.put(this.asset.descriptor, this.asset.bytes);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    this.applied = { volumeIndex: object.volumes.length - 1, descriptorIndex: state.sourceAssets.length - 1 };
  }

  revert(context: CommandContext): void {
    if (!this.applied) throw new Error('AddEmbossTextCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.placement.objectId);
    const volumeIndex = object.volumes.findIndex((candidate) => candidate.id === this.placement.volumeId);
    if (volumeIndex === -1) throw new Error(`Embossed volume ${this.placement.volumeId} is missing during undo`);
    object.volumes.splice(volumeIndex, 1);
    const descriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === this.placement.assetId);
    if (descriptorIndex !== -1) state.sourceAssets.splice(descriptorIndex, 1);
    context.project.replaceState(state, { reason: `${this.type}:undo`, dirtyCategories: this.dirtyCategories });
    context.assets.remove(this.placement.assetId);
  }
}

/**
 * Re-cut an existing embossed volume from an edited recipe.
 *
 * The new mesh replaces the old one wholesale, so triangle-indexed annotations
 * on that volume cannot survive and are reset rather than silently remapped
 * onto geometry they no longer describe.
 */
export class EditEmbossTextCommand implements ProjectCommand {
  readonly type = 'edit-emboss-text';
  readonly label = 'Edit embossed text';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly volumeId: VolumeId;
  private readonly configuration: EmbossTextConfiguration;
  private readonly asset: AssetPayload;
  private readonly triangleCount: number;
  private previous?: {
    volume: ProjectVolume;
    descriptorIndex: number;
    removedAsset?: AssetPayload;
  };

  constructor(
    volumeId: VolumeId,
    configuration: EmbossTextConfiguration,
    prepared: { asset: AssetPayload; mesh: EmbossedMesh },
  ) {
    if (prepared.mesh.triangleCount === 0) {
      throw new EmbossError('This text produced no geometry to apply', 'no-glyphs');
    }
    this.volumeId = volumeId;
    this.configuration = cloneJson(configuration);
    this.asset = cloneAsset(prepared.asset);
    this.triangleCount = prepared.mesh.triangleCount;
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findVolume(state, this.volumeId);
    if (!found) throw new Error(`Volume ${this.volumeId} is not in this project`);
    if (!found.volume.embossText) {
      throw new Error(`Volume ${this.volumeId} is not embossed text, so its recipe cannot be edited`);
    }
    const previousVolume = cloneJson(found.volume);
    const oldAssetId = found.volume.source.assetId;
    const descriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === oldAssetId);

    found.volume.source = {
      assetId: this.asset.descriptor.id,
      topologyRevision: found.volume.source.topologyRevision + 1,
      triangleCount: this.triangleCount,
    };
    found.volume.annotations = emptyFacetAnnotations(found.volume.source.topologyRevision);
    found.volume.embossText = cloneJson(this.configuration);
    found.volume.name = firstLine(this.configuration.text);

    if (!state.sourceAssets.some((asset) => asset.id === this.asset.descriptor.id)) {
      state.sourceAssets.push(cloneJson(this.asset.descriptor));
    }
    const stillReferenced = referencesAsset(state, oldAssetId);
    let removedAsset: AssetPayload | undefined;
    if (!stillReferenced && descriptorIndex !== -1) {
      removedAsset = context.assets.get(oldAssetId);
      state.sourceAssets.splice(descriptorIndex, 1);
    }

    context.assets.put(this.asset.descriptor, this.asset.bytes);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    if (removedAsset) context.assets.remove(oldAssetId);
    this.previous = { volume: previousVolume, descriptorIndex, ...(removedAsset ? { removedAsset } : {}) };
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('EditEmbossTextCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findVolume(state, this.volumeId);
    if (!found) throw new Error(`Embossed volume ${this.volumeId} is missing during undo`);
    if (canonicalStringify(found.volume.embossText) !== canonicalStringify(this.configuration)) {
      throw new Error(`Embossed volume ${this.volumeId} changed before undo`);
    }

    const restored = cloneJson(this.previous.volume);
    const volumeIndex = found.object.volumes.findIndex((candidate) => candidate.id === this.volumeId);
    found.object.volumes.splice(volumeIndex, 1, restored);

    if (this.previous.removedAsset) {
      context.assets.put(this.previous.removedAsset.descriptor, this.previous.removedAsset.bytes);
      state.sourceAssets.splice(this.previous.descriptorIndex, 0, cloneJson(this.previous.removedAsset.descriptor));
    }
    const newAssetId = this.asset.descriptor.id;
    const stillReferenced = referencesAsset(state, newAssetId);
    if (!stillReferenced) {
      const index = state.sourceAssets.findIndex((asset) => asset.id === newAssetId);
      if (index !== -1) state.sourceAssets.splice(index, 1);
    }
    context.project.replaceState(state, { reason: `${this.type}:undo`, dirtyCategories: this.dirtyCategories });
    if (!stillReferenced) context.assets.remove(newAssetId);
  }
}

function requireObject(state: ProjectState, objectId: ObjectId) {
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Object ${objectId} is not in this project`);
  return object;
}

function referencesAsset(state: ProjectState, assetId: AssetId): boolean {
  return state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .some((volume) => volume.source.assetId === assetId);
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 0 ? line.slice(0, 60) : 'Text';
}

function cloneAsset(asset: AssetPayload): AssetPayload {
  return { descriptor: cloneJson(asset.descriptor), bytes: asset.bytes.slice() };
}
