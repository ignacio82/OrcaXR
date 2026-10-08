/**
 * Placement over a live session, in the shared contract's encoding: the
 * instance transforms the workspace's mirror, reset, centre, scale-to-fit,
 * lay-flat and drop-to-bed edits submit, planned from an acknowledged state
 * and its assets. A plan's changes are one `setInstanceTransforms` intent;
 * drop to bed also reports each instance's lowest point and move. A request
 * the operation refuses reports the operation's own code and message. The
 * Rust session plans the same placements (`orcaxr_project::placement`).
 */
import type {
  ProjectPlacementReplyWire,
  ProjectPlacementRequestWire,
  ProjectPlacementRefusalCodeWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { InstanceId, VolumeId } from '../domain/ids';
import type { ProjectState, Transform, Vec3 } from '../domain/model';
import { CanonicalBoundsError } from './bounds';
import type { InstanceTransformChange } from './transformCommands';
import {
  TransformOperationError,
  centerInstancesOnPlate,
  dropInstancesToBed,
  layInstanceOnFace,
  layInstanceOnFacet,
  mirrorInstances,
  resetInstanceRotations,
  resetInstanceScales,
  resetInstanceTransforms,
  scaleInstancesToFitPrintVolume,
  type DropToBedResult,
} from './transformOperations';

export function planPlacement(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectPlacementRequestWire,
): ProjectPlacementReplyWire {
  let changes: InstanceTransformChange[];
  let drops: DropToBedResult[] = [];
  const ids = (wire: readonly (readonly number[])[]) => wire.map((id) => wireText(id) as InstanceId);
  const vector = (wire: readonly number[]): Vec3 => [wire[0], wire[1], wire[2]];
  try {
    if ('mirror' in request) changes = mirrorInstances(state, ids(request.mirror.instanceIds), request.mirror.axis);
    else if ('resetRotation' in request)
      changes = resetInstanceRotations(state, ids(request.resetRotation.instanceIds));
    else if ('resetScale' in request) changes = resetInstanceScales(state, ids(request.resetScale.instanceIds));
    else if ('resetTransform' in request)
      changes = resetInstanceTransforms(state, ids(request.resetTransform.instanceIds));
    else if ('centerOnPlate' in request)
      changes = centerInstancesOnPlate(state, assets, ids(request.centerOnPlate.instanceIds), [
        request.centerOnPlate.bedSizeMm[0],
        request.centerOnPlate.bedSizeMm[1],
      ]);
    else if ('scaleToFit' in request) {
      const [x, y, z] = request.scaleToFit.volumeMm;
      changes = scaleInstancesToFitPrintVolume(state, assets, ids(request.scaleToFit.instanceIds), { x, y, z });
    } else if ('layOnFace' in request)
      changes = layInstanceOnFace(state, assets, {
        instanceId: wireText(request.layOnFace.instanceId) as InstanceId,
        localNormal: vector(request.layOnFace.localNormal),
      });
    else if ('layOnFacet' in request)
      changes = layInstanceOnFacet(state, assets, {
        instanceId: wireText(request.layOnFacet.instanceId) as InstanceId,
        volumeId: wireText(request.layOnFacet.volumeId) as VolumeId,
        triangle: request.layOnFacet.triangle,
      });
    else ({ changes, results: drops } = dropInstancesToBed(state, assets, ids(request.dropToBed.instanceIds)));
  } catch (error) {
    if (error instanceof TransformOperationError || error instanceof CanonicalBoundsError) {
      return { refused: { code: refusalCode(error.code), message: wireUnits(error.message) } };
    }
    throw error;
  }
  return {
    plan: {
      changes: changes.map((change) => ({
        instanceId: wireUnits(change.instanceId),
        transform: transformWire(change.transform),
      })),
      drops: drops.map((drop) => ({
        instanceId: wireUnits(drop.instanceId),
        minZBeforeMm: drop.minZBeforeMm,
        deltaZMm: drop.deltaZMm,
      })),
    },
  };
}

function transformWire(transform: Transform) {
  return {
    translationMm: [...transform.translationMm],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function refusalCode(code: string): ProjectPlacementRefusalCodeWire {
  return code.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as ProjectPlacementRefusalCodeWire;
}
