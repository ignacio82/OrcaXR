/**
 * Wipe-tower auto-placement over a live session, in the shared contract's
 * encoding: the workspace's "Auto-place wipe tower" planned from an
 * acknowledged state and its assets. A plan carries the winning candidate and
 * the plate's wipe tower as one `setPlateWipeTower` intent sets it; an
 * unbounded clearance (no printable part) is absent. A request the planner
 * refuses reports the planner's own code and message. The Rust session plans
 * the same placements (`orcaxr_project::placement::wipe_tower`).
 */
import type {
  ProjectVolumeRoleNameWire,
  ProjectWipeTowerBiasNameWire,
  ProjectWipeTowerReplyWire,
  ProjectWipeTowerRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetRepository } from '../assets';
import type { PlateId } from '../domain/ids';
import type { ProjectState, VolumeRole } from '../domain/model';
import {
  WipeTowerPlacementError,
  planWipeTowerPlacement,
  type AabbXY,
  type WipeTowerBias,
  type WipeTowerPlanOptions,
} from './wipeTowerPlacement';

const BIASES: Readonly<Record<ProjectWipeTowerBiasNameWire, WipeTowerBias>> = {
  backLeft: 'back_left',
  backRight: 'back_right',
  frontLeft: 'front_left',
  frontRight: 'front_right',
  largestClearance: 'largest_clearance',
};

const ROLES: Readonly<Record<ProjectVolumeRoleNameWire, VolumeRole>> = {
  model: 'model',
  negativeVolume: 'negative-volume',
  parameterModifier: 'parameter-modifier',
  supportBlocker: 'support-blocker',
  supportEnforcer: 'support-enforcer',
};

export function planWipeTowerWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectWipeTowerRequestWire,
): ProjectWipeTowerReplyWire {
  const options: WipeTowerPlanOptions = {
    ...('value' in request.bedRectMm ? { bedRectMm: { ...request.bedRectMm.value } } : {}),
    ...('value' in request.bedSizeMm
      ? { bedSizeMm: [request.bedSizeMm.value[0], request.bedSizeMm.value[1]] as const }
      : {}),
    ...('value' in request.towerW ? { towerW: request.towerW.value } : {}),
    ...('value' in request.towerD ? { towerD: request.towerD.value } : {}),
    ...('value' in request.safetyMm ? { safetyMm: request.safetyMm.value } : {}),
    ...('value' in request.marginMm ? { marginMm: request.marginMm.value } : {}),
    ...('value' in request.bias ? { bias: BIASES[request.bias.value] } : {}),
    ...('value' in request.volumeRoles ? { volumeRoles: request.volumeRoles.value.map((role) => ROLES[role]) } : {}),
  };
  let result;
  try {
    result = planWipeTowerPlacement(state, assets, wireText(request.plateId) as PlateId, options);
  } catch (error) {
    if (!(error instanceof WipeTowerPlacementError)) throw error;
    return {
      refused: {
        code: error.code === 'unknown-plate' ? 'unknownPlate' : 'invalidBed',
        message: wireUnits(error.message),
      },
    };
  }
  const { pick, state: tower } = result;
  return {
    plan: {
      pick: {
        xMm: pick.xMm,
        yMm: pick.yMm,
        clearanceMm: Number.isFinite(pick.clearanceMm) ? { value: pick.clearanceMm } : { absent: {} },
        label: wireUnits(pick.label),
        footprint: rectWire(pick.footprint),
      },
      wipeTower: {
        enabled: tower.enabled,
        positionMm: [tower.positionMm[0], tower.positionMm[1]],
        rotationDeg: tower.rotationDeg,
        filamentId: tower.filamentId === undefined ? { absent: {} } : { value: wireUnits(tower.filamentId) },
      },
    },
  };
}

function rectWire(rect: AabbXY) {
  return { xMin: rect.xMin, yMin: rect.yMin, xMax: rect.xMax, yMax: rect.yMax };
}
