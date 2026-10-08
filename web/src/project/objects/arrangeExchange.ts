/**
 * Plate arrangement and bed fill over a live session, in the shared
 * contract's encoding: the workspace's "Arrange" and "Fill bed with
 * instances" planned from an acknowledged state and its assets. An
 * arrangement's placements are one `setInstanceTransforms` intent; a fill's
 * placements are the transforms of new copies. A request the planner refuses
 * reports the planner's own code and message. The Rust session plans the same
 * layouts (`orcaxr_project::placement::arrange`).
 */
import type {
  ProjectArrangeConstraintsInputWire,
  ProjectArrangeRefusalCodeWire,
  ProjectArrangeReplyWire,
  ProjectArrangeRequestWire,
  ProjectBedFillReplyWire,
  ProjectBedFillRequestWire,
  ProjectVolumeRoleNameWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { InstanceId, PlateId } from '../domain/ids';
import type { ProjectState, Transform, VolumeRole } from '../domain/model';
import {
  ArrangeConstraintError,
  planBedFill,
  planPlateArrangement,
  type ArrangeConstraints,
  type ArrangeRegion,
} from './arrange';
import { CanonicalBoundsError } from './bounds';

export function planArrangementWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectArrangeRequestWire,
): ProjectArrangeReplyWire {
  try {
    const result = planPlateArrangement(
      state,
      assets,
      wireText(request.plateId) as PlateId,
      constraints(request.constraints),
    );
    return {
      arrangement: {
        placements: result.placements.map((placement) => ({
          instanceId: wireUnits(placement.instanceId),
          transform: transformWire(placement.transform),
          footprint: regionWire(placement.footprint),
        })),
        unplacedInstanceIds: result.unplacedInstanceIds.map(wireUnits),
        lockedInstanceIds: result.lockedInstanceIds.map(wireUnits),
      },
    };
  } catch (error) {
    return { refused: refusal(error) };
  }
}

export function planBedFillWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectBedFillRequestWire,
): ProjectBedFillReplyWire {
  try {
    const result = planBedFill(
      state,
      assets,
      wireText(request.plateId) as PlateId,
      {
        instanceId: wireText(request.instanceId) as InstanceId,
        ...('value' in request.maxNewInstances ? { maxNewInstances: request.maxNewInstances.value } : {}),
      },
      constraints(request.constraints),
    );
    return {
      fill: {
        placements: result.placements.map((placement) => ({
          transform: transformWire(placement.transform),
          footprint: regionWire(placement.footprint),
        })),
        withheldSlotCount: result.withheldSlotCount,
      },
    };
  } catch (error) {
    return { refused: refusal(error) };
  }
}

const ROLES: Readonly<Record<ProjectVolumeRoleNameWire, VolumeRole>> = {
  model: 'model',
  negativeVolume: 'negative-volume',
  parameterModifier: 'parameter-modifier',
  supportBlocker: 'support-blocker',
  supportEnforcer: 'support-enforcer',
};

function constraints(wire: ProjectArrangeConstraintsInputWire): ArrangeConstraints {
  return {
    bedSizeMm: [wire.bedSizeMm[0], wire.bedSizeMm[1]],
    ...('value' in wire.spacingMm ? { spacingMm: wire.spacingMm.value } : {}),
    ...('value' in wire.bedMarginMm ? { bedMarginMm: wire.bedMarginMm.value } : {}),
    exclusions: wire.exclusions.map((region) => ({ ...region })),
    lockedInstanceIds: wire.lockedInstanceIds.map((id) => wireText(id) as InstanceId),
    ...('value' in wire.volumeRoles ? { volumeRoles: wire.volumeRoles.value.map((role) => ROLES[role]) } : {}),
  };
}

function refusal(error: unknown) {
  if (error instanceof ArrangeConstraintError || error instanceof CanonicalBoundsError) {
    return {
      code: error.code.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      ) as ProjectArrangeRefusalCodeWire,
      message: wireUnits(error.message),
    };
  }
  throw error;
}

function transformWire(transform: Transform) {
  return {
    translationMm: [...transform.translationMm],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function regionWire(region: ArrangeRegion) {
  return { minX: region.minX, minY: region.minY, maxX: region.maxX, maxY: region.maxY };
}
