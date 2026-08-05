import type { AssetPayload } from '../assets';
import { cloneJson, cloneProjectState, deepFreeze, projectFingerprint } from '../domain/canonical';
import type { AssetId, PlateId } from '../domain/ids';
import { assertValidProjectState } from '../domain/validation';
import type { ProjectArchiveSnapshot } from '../ports';
import type { CanonicalProjectSliceGuard, CanonicalProjectSliceSnapshot } from './types';

export interface PlateArchiveProjection {
  readonly plateId: PlateId;
  /** Guard for the complete live project and asset bundle that produced this projection. */
  readonly source: CanonicalProjectSliceGuard;
  /** One-plate canonical bundle. Its sourceHash identifies the projected state. */
  readonly archive: ProjectArchiveSnapshot;
}

/**
 * Produce a deterministic one-plate archive for engines that always load
 * plate zero. The complete source guard remains separate from the projected
 * state's hash so a route can retain live-project provenance.
 */
export function projectPlateArchiveForSlice(
  snapshot: CanonicalProjectSliceSnapshot,
  plateId: PlateId,
): PlateArchiveProjection {
  const state = cloneProjectState(snapshot.state);
  const plate = state.plates.find((candidate) => candidate.id === plateId);
  if (!plate) throw new Error(`Unknown plate ${plateId}`);
  if (!plate.printable) throw new Error(`Plate ${plateId} is not printable`);

  plate.order = 0;
  state.plates = [plate];
  state.activePlateId = plateId;
  state.customGcode = state.customGcode.filter(
    (entry) => entry.scope === 'project' || (entry.scope === 'plate' && entry.plateId === plateId),
  );
  state.thumbnails = state.thumbnails.filter((thumbnail) => !thumbnail.plateId || thumbnail.plateId === plateId);

  // Opaque package entries are round-trip data, not canonical slice inputs.
  // In particular, a preserved model_settings.config must not replace the
  // freshly generated one-plate metadata.
  state.extensionBlobs = [];

  const referencedAssets = collectReferencedAssets(state);
  state.sourceAssets = state.sourceAssets.filter((descriptor) => referencedAssets.has(descriptor.id));
  const payloads = new Map(snapshot.assets.map((asset) => [asset.descriptor.id, asset]));
  const assets = state.sourceAssets.map((descriptor) => {
    const payload = payloads.get(descriptor.id);
    if (!payload) throw new Error(`One-plate projection is missing source asset ${descriptor.id}`);
    return cloneAsset(payload);
  });

  assertValidProjectState(state);
  const frozenState = deepFreeze(state);
  const archive: ProjectArchiveSnapshot = {
    state: frozenState,
    assets,
    sourceRevision: snapshot.sourceRevision,
    sourceHash: projectFingerprint(frozenState),
  };
  return {
    plateId,
    source: {
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
      sourceAssetHash: snapshot.sourceAssetHash,
    },
    archive,
  };
}

function collectReferencedAssets(state: CanonicalProjectSliceSnapshot['state']): Set<AssetId> {
  const ids = new Set<AssetId>();
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) ids.add(volume.source.assetId);
    }
  }
  for (const thumbnail of state.thumbnails) ids.add(thumbnail.assetId);
  return ids;
}

function cloneAsset(asset: AssetPayload): AssetPayload {
  return { descriptor: deepFreeze(cloneJson(asset.descriptor)), bytes: asset.bytes.slice() };
}
