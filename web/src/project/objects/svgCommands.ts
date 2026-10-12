/**
 * Adding and re-cutting SVG parts (P5.3.4).
 *
 * Mirrors the text emboss commands: the drawing's parameters travel with the
 * volume so a saved project reopens with the part still editable, and re-cutting
 * from a changed width or depth is one undoable command rather than a delete
 * and a re-import.
 */

import { contentDigest, type AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { isStableEntityId, type AssetId, type IdSource, type ObjectId, type VolumeId } from '../domain/ids';
import {
  emptyFacetAnnotations,
  type EmbossSvgPart,
  type ProjectState,
  type ProjectVolume,
  type Transform,
} from '../domain/model';
import { findVolume } from '../domain/selectors';
import type { CommandContext, ProjectCommand } from '../history/command';
import { encodeIndexedMeshAsset } from '../meshCodec';
import { extrudeContours, type ExtrudedMesh } from './extrude';
import { readSvgShapes, SvgError, type SvgShapes, type SvgUnsupportedFeature } from './svgShapes';

/** Everything needed to place a newly cut SVG part. */
export interface SvgPlacement {
  readonly objectId: ObjectId;
  readonly volumeId: VolumeId;
  readonly assetId: AssetId;
  readonly transform: Transform;
}

export interface PreparedSvgPart {
  readonly asset: AssetPayload;
  /** The drawing itself, stored beside the mesh so the part can be re-cut. */
  readonly drawing: AssetPayload;
  readonly mesh: ExtrudedMesh;
  readonly part: EmbossSvgPart;
  /** The drawing's own bytes, stored in the archive beside the project. */
  readonly svgBytes: Uint8Array;
  /** What the drawing contained that could not become solid geometry. */
  readonly unsupported: readonly SvgUnsupportedFeature[];
  /** Resolved size in millimetres, after any requested width. */
  readonly sizeMm: readonly [number, number];
}

/** Mint the identities a new SVG part needs, from the session's source. */
export function svgVolumeIdentity(ids: IdSource): {
  volumeId: VolumeId;
  assetId: AssetId;
  drawingAssetId: AssetId;
} {
  return {
    volumeId: ids.next<'volume'>('volume'),
    assetId: ids.next<'asset'>('asset'),
    drawingAssetId: ids.next<'asset'>('asset'),
  };
}

/**
 * The archive path a drawing is stored at.
 *
 * Namespaced per volume so two parts cut from differently-named files, or from
 * the same name in different folders, cannot overwrite one another.
 */
export function svgArchivePath(volumeId: VolumeId, fileName: string): string {
  const safe = fileName.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'drawing.svg';
  return `Metadata/svg/${String(volumeId).replaceAll(/[^A-Za-z0-9._-]/g, '_')}/${safe}`;
}

/** A part's name from its file: the name without a final `.svg`. */
export function svgPartName(fileName: string): string {
  return fileName.replace(/\.svg$/i, '') || 'SVG part';
}

/** The asset ID a cut is encoded under until it is packaged. */
const PREVIEW_ASSET_ID = 'import:svg:preview' as AssetId;

/** The depth an SVG part tool starts with, in millimetres. */
export const DEFAULT_SVG_PART_DEPTH_MM = 2;

/**
 * Read a drawing the operator picked, at its own size, refusing what cannot
 * be cut: what the SVG part tool checks when a drawing is loaded, before any
 * depth or width is chosen. Throws `SvgError`.
 */
export function readSvgDrawing(source: string): SvgShapes {
  const shapes = readSvgShapes(source);
  // A size past float64 range cannot be recorded as the part's width.
  if (!shapes.sizeMm.every(Number.isFinite)) throw new SvgError('That drawing is too large to cut', 'invalid-svg');
  return shapes;
}

/** A drawing cut into a mesh, before anything names it. */
export interface SvgCut {
  readonly shapes: SvgShapes;
  readonly mesh: ExtrudedMesh;
  /** The mesh encoded under a placeholder asset ID. */
  readonly preview: AssetPayload;
  /** The drawing's text as the part stores it. */
  readonly svgBytes: Uint8Array;
}

/**
 * Cut a drawing into a mesh: the half of preparation that needs no IDs, so a
 * host can preview a cut before naming it. Throws `SvgError`.
 */
export function cutSvgDrawing(
  source: string,
  options: { readonly fileName: string; readonly depthMm: number; readonly widthMm?: number },
): SvgCut {
  if (!Number.isFinite(options.depthMm) || options.depthMm <= 0) {
    throw new SvgError('An SVG part needs a depth greater than zero', 'invalid-svg');
  }
  const shapes = readSvgShapes(source, options.widthMm);
  // A size past float64 range cannot be recorded as the part's width.
  if (!shapes.sizeMm.every(Number.isFinite)) throw new SvgError('That drawing is too large to cut', 'invalid-svg');
  const mesh = extrudeContours(shapes.contours, options.depthMm);
  if (mesh.triangleCount === 0) {
    throw new SvgError('That drawing produced no geometry to cut', 'no-geometry');
  }
  let preview: AssetPayload;
  try {
    preview = encodeIndexedMeshAsset({
      id: PREVIEW_ASSET_ID,
      positions: mesh.positions,
      indices: mesh.indices,
      sourceFilename: options.fileName,
    });
  } catch (error) {
    // A shape scaled past float32 range.
    throw new SvgError((error as Error).message, 'invalid-mesh');
  }
  return { shapes, mesh, preview, svgBytes: new TextEncoder().encode(source) };
}

/** Name a cut: the mesh and drawing under their asset IDs, and the recipe. */
export function packageSvgPart(
  cut: SvgCut,
  options: {
    readonly fileName: string;
    readonly volumeId: VolumeId;
    readonly assetId: AssetId;
    readonly drawingAssetId: AssetId;
    readonly depthMm: number;
    readonly useSurface?: boolean;
    readonly sourcePath?: string;
  },
): PreparedSvgPart {
  return {
    drawing: {
      descriptor: {
        id: options.drawingAssetId,
        kind: 'extension',
        digest: contentDigest(cut.svgBytes),
        byteLength: cut.svgBytes.byteLength,
        mediaType: 'image/svg+xml',
        sourceFilename: options.fileName,
      },
      bytes: cut.svgBytes,
    },
    asset: { descriptor: { ...cut.preview.descriptor, id: options.assetId }, bytes: cut.preview.bytes },
    mesh: cut.mesh,
    part: Object.freeze({
      pathIn3mf: svgArchivePath(options.volumeId, options.fileName),
      drawingAssetId: options.drawingAssetId,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      depthMm: options.depthMm,
      useSurface: options.useSurface ?? false,
      widthMm: cut.shapes.sizeMm[0],
    }),
    svgBytes: cut.svgBytes,
    unsupported: cut.shapes.unsupported,
    sizeMm: cut.shapes.sizeMm,
  };
}

/**
 * Cut a drawing into a mesh and package it, without touching project state.
 *
 * Separate from the commands so a caller can show the size and the unsupported
 * notes before anything is committed to history.
 */
export function prepareSvgPart(
  source: string,
  options: {
    readonly fileName: string;
    readonly volumeId: VolumeId;
    readonly assetId: AssetId;
    readonly drawingAssetId: AssetId;
    readonly depthMm: number;
    readonly widthMm?: number;
    readonly useSurface?: boolean;
    readonly sourcePath?: string;
  },
): PreparedSvgPart {
  if (!isStableEntityId(options.assetId)) throw new Error(`Asset ID ${options.assetId} is not stable`);
  return packageSvgPart(cutSvgDrawing(source, options), options);
}

/** Add an SVG part to an existing object. */
export class AddSvgPartCommand implements ProjectCommand {
  readonly type = 'add-svg-part';
  readonly label = 'Add SVG part';
  readonly dirtyCategories = ['projectData'] as const;

  private readonly placement: SvgPlacement;
  private readonly prepared: PreparedSvgPart;
  private readonly name: string;
  private applied = false;

  constructor(placement: SvgPlacement, prepared: PreparedSvgPart, name: string) {
    if (prepared.asset.descriptor.id !== placement.assetId) {
      throw new Error(`Prepared asset ${prepared.asset.descriptor.id} does not match placement ${placement.assetId}`);
    }
    requireOwnDrawing(prepared);
    this.placement = { ...placement, transform: cloneJson(placement.transform) };
    this.prepared = prepared;
    this.name = name.trim() || 'SVG part';
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.placement.objectId);
    if (findVolume(state, this.placement.volumeId)) {
      throw new Error(`Volume ${this.placement.volumeId} already exists`);
    }

    const volume: ProjectVolume = {
      id: this.placement.volumeId,
      name: this.name,
      role: 'model',
      source: {
        assetId: this.placement.assetId,
        topologyRevision: 0,
        triangleCount: this.prepared.mesh.triangleCount,
      },
      transform: cloneJson(this.placement.transform),
      config: {},
      annotations: emptyFacetAnnotations(0),
      embossSvg: cloneJson(this.prepared.part),
    };
    object.volumes.push(volume);
    state.sourceAssets.push(cloneJson(this.prepared.asset.descriptor), cloneJson(this.prepared.drawing.descriptor));
    context.assets.put(this.prepared.asset.descriptor, this.prepared.asset.bytes);
    context.assets.put(this.prepared.drawing.descriptor, this.prepared.drawing.bytes);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    this.applied = true;
  }

  revert(context: CommandContext): void {
    if (!this.applied) throw new Error('AddSvgPartCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const object = requireObject(state, this.placement.objectId);
    const index = object.volumes.findIndex((candidate) => candidate.id === this.placement.volumeId);
    if (index === -1) throw new Error(`SVG volume ${this.placement.volumeId} is missing during undo`);
    object.volumes.splice(index, 1);
    for (const assetId of [this.placement.assetId, this.prepared.drawing.descriptor.id]) {
      const descriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === assetId);
      if (descriptorIndex !== -1) state.sourceAssets.splice(descriptorIndex, 1);
    }
    context.project.replaceState(state, { reason: `${this.type}:undo`, dirtyCategories: this.dirtyCategories });
    context.assets.remove(this.placement.assetId);
    context.assets.remove(this.prepared.drawing.descriptor.id);
  }
}

/**
 * Re-cut an existing SVG part from changed parameters.
 *
 * The mesh is replaced wholesale, so triangle-indexed annotations on that
 * volume cannot survive and are reset rather than remapped onto geometry they
 * no longer describe.
 */
export class EditSvgPartCommand implements ProjectCommand {
  readonly type = 'edit-svg-part';
  readonly label = 'Edit SVG part';
  readonly dirtyCategories = ['projectData'] as const;

  private previous?: {
    volume: ProjectVolume;
    descriptorIndex: number;
    removedAsset?: AssetPayload;
    /** Whether the re-cut declared its own drawing. */
    addedDrawing: boolean;
    /** The drawing it retired, with the place it was declared at. */
    removedDrawing?: { readonly payload: AssetPayload; readonly index: number };
  };

  constructor(
    private readonly volumeId: VolumeId,
    private readonly prepared: PreparedSvgPart,
  ) {
    requireOwnDrawing(prepared);
  }

  apply(context: CommandContext): void {
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findVolume(state, this.volumeId);
    if (!found) throw new Error(`Volume ${this.volumeId} is not in this project`);
    if (!found.volume.embossSvg) {
      throw new Error(`Volume ${this.volumeId} is not an SVG part, so its drawing cannot be re-cut`);
    }
    const previousVolume = cloneJson(found.volume);
    const oldAssetId = found.volume.source.assetId;
    const descriptorIndex = state.sourceAssets.findIndex((asset) => asset.id === oldAssetId);

    found.volume.source = {
      assetId: this.prepared.asset.descriptor.id,
      topologyRevision: found.volume.source.topologyRevision + 1,
      triangleCount: this.prepared.mesh.triangleCount,
    };
    found.volume.annotations = emptyFacetAnnotations(found.volume.source.topologyRevision);
    found.volume.embossSvg = cloneJson(this.prepared.part);

    if (!state.sourceAssets.some((asset) => asset.id === this.prepared.asset.descriptor.id)) {
      state.sourceAssets.push(cloneJson(this.prepared.asset.descriptor));
    }
    let removedAsset: AssetPayload | undefined;
    if (!referencesAsset(state, oldAssetId) && descriptorIndex !== -1) {
      removedAsset = context.assets.get(oldAssetId);
      state.sourceAssets.splice(descriptorIndex, 1);
    }

    // The re-cut's drawing replaces the part's old one: declared when new, and
    // the old one retired once no SVG part names it. Without this the recipe
    // named a drawing that was never stored and the old one lingered.
    const newDrawingId = this.prepared.part.drawingAssetId;
    const oldDrawingId = previousVolume.embossSvg!.drawingAssetId;
    const addedDrawing = !state.sourceAssets.some((asset) => asset.id === newDrawingId);
    if (addedDrawing) state.sourceAssets.push(cloneJson(this.prepared.drawing.descriptor));
    let removedDrawing: { payload: AssetPayload; index: number } | undefined;
    if (oldDrawingId !== newDrawingId && !referencesDrawing(state, oldDrawingId)) {
      const index = state.sourceAssets.findIndex((asset) => asset.id === oldDrawingId);
      const payload = context.assets.get(oldDrawingId);
      if (index !== -1 && payload) {
        state.sourceAssets.splice(index, 1);
        removedDrawing = { payload, index };
      }
    }

    context.assets.put(this.prepared.asset.descriptor, this.prepared.asset.bytes);
    if (addedDrawing) context.assets.put(this.prepared.drawing.descriptor, this.prepared.drawing.bytes);
    context.project.replaceState(state, { reason: this.type, dirtyCategories: this.dirtyCategories });
    if (removedAsset) context.assets.remove(oldAssetId);
    if (removedDrawing) context.assets.remove(oldDrawingId);
    this.previous = {
      volume: previousVolume,
      descriptorIndex,
      ...(removedAsset ? { removedAsset } : {}),
      addedDrawing,
      ...(removedDrawing ? { removedDrawing } : {}),
    };
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error('EditSvgPartCommand has not been applied');
    const state = cloneProjectState(context.project.getSnapshot().state);
    const found = findVolume(state, this.volumeId);
    if (!found) throw new Error(`SVG volume ${this.volumeId} is missing during undo`);
    if (canonicalStringify(found.volume.embossSvg) !== canonicalStringify(this.prepared.part)) {
      throw new Error(`SVG volume ${this.volumeId} changed before undo`);
    }

    const index = found.object.volumes.findIndex((candidate) => candidate.id === this.volumeId);
    found.object.volumes.splice(index, 1, cloneJson(this.previous.volume));
    // Drawings first, undoing the apply's last steps first.
    const newDrawingId = this.prepared.part.drawingAssetId;
    const removedDrawing = this.previous.removedDrawing;
    if (removedDrawing) {
      state.sourceAssets.splice(removedDrawing.index, 0, cloneJson(removedDrawing.payload.descriptor));
    }
    const dropDrawing = this.previous.addedDrawing && !referencesDrawing(state, newDrawingId);
    if (dropDrawing) {
      const drawingIndex = state.sourceAssets.findIndex((asset) => asset.id === newDrawingId);
      if (drawingIndex !== -1) state.sourceAssets.splice(drawingIndex, 1);
    }
    if (this.previous.removedAsset) {
      context.assets.put(this.previous.removedAsset.descriptor, this.previous.removedAsset.bytes);
      state.sourceAssets.splice(this.previous.descriptorIndex, 0, cloneJson(this.previous.removedAsset.descriptor));
    }
    const newAssetId = this.prepared.asset.descriptor.id;
    const stillReferenced = referencesAsset(state, newAssetId);
    if (!stillReferenced) {
      const assetIndex = state.sourceAssets.findIndex((asset) => asset.id === newAssetId);
      if (assetIndex !== -1) state.sourceAssets.splice(assetIndex, 1);
    }
    if (removedDrawing) context.assets.put(removedDrawing.payload.descriptor, removedDrawing.payload.bytes);
    context.project.replaceState(state, { reason: `${this.type}:undo`, dirtyCategories: this.dirtyCategories });
    if (!stillReferenced) context.assets.remove(newAssetId);
    if (dropDrawing) context.assets.remove(newDrawingId);
  }
}

function requireObject(state: ProjectState, objectId: ObjectId) {
  const object = state.plates.flatMap((plate) => plate.objects).find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Object ${objectId} is not in this project`);
  return object;
}

/**
 * The stored drawing must be the one the recipe names. A host's staged record
 * carries the two separately; apart, the part named a drawing that was never
 * stored and the stored one was an orphan.
 */
function requireOwnDrawing(prepared: PreparedSvgPart): void {
  if (prepared.drawing.descriptor.id !== prepared.part.drawingAssetId) {
    throw new Error(
      `Prepared drawing ${prepared.drawing.descriptor.id} does not match the part's drawing ${prepared.part.drawingAssetId}`,
    );
  }
}

/** Whether any SVG part's recipe names this drawing. */
function referencesDrawing(state: ProjectState, assetId: AssetId): boolean {
  return state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .some((volume) => volume.embossSvg?.drawingAssetId === assetId);
}

function referencesAsset(state: ProjectState, assetId: AssetId): boolean {
  return state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .some((volume) => volume.source.assetId === assetId);
}
