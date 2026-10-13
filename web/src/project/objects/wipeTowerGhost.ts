/**
 * The wipe tower the workspace draws on the plate before slicing: a placement
 * ghost, as the desktop plate shows one, from the plate's canonical tower and
 * the footprint the slice preflight checks ([wipeTowerFootprint]).
 *
 * The body is square (the real tower's depth depends on purge volumes the
 * engine works out while slicing), its front-left corner at `wipe_tower_x/y`
 * in the libslic3r frame (millimetres from the bed's corner), exactly where
 * the engine prints it — never clamped onto the bed, so a tower whose brim
 * hangs off the edge looks it. It rises to the top of the tallest model part
 * on the plate: every instance's model parts, as placed, never a modifier,
 * support enforcer or blocker, or negative part, which print nothing of their
 * own. A plate with no model part above the bed gets a stand-in height.
 */
import type { AssetRepository } from '../assets';
import type { PlateId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { computeCanonicalInstanceBounds } from './bounds';
import { wipeTowerFootprint } from './wipeTowerPlacement';

/** The ghost's height on a plate with no model part above the bed (mm). */
export const WIPE_TOWER_GHOST_STAND_IN_MM = 30;

/** The smallest side the ghost's body is drawn with (mm). */
export const WIPE_TOWER_GHOST_MIN_WIDTH_MM = 1;

export interface WipeTowerGhost {
  /** The body's front-left corner on the bed (`wipe_tower_x/y`), printer millimetres. */
  readonly positionMm: readonly [number, number];
  /** The body's side: the footprint's width, drawn at least [WIPE_TOWER_GHOST_MIN_WIDTH_MM]. */
  readonly widthMm: number;
  /** The tallest model part's top on the plate, or the stand-in. */
  readonly heightMm: number;
  /** Whether [heightMm] is the stand-in: no model part on the plate rises above the bed. */
  readonly standIn: boolean;
  /** What the engine prints outside the body on every side (brim, rib wall); outlined on the bed when positive. */
  readonly marginMm: number;
}

export class WipeTowerGhostError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown-plate' | 'non-finite',
  ) {
    super(message);
    this.name = 'WipeTowerGhostError';
  }
}

/**
 * The ghost of plate [plateId]'s wipe tower, or undefined when the plate has
 * no enabled tower. Throws for an unknown plate, and for a tower whose
 * configuration gives no finite box to draw.
 */
export function planWipeTowerGhost(
  state: ProjectState,
  assets: AssetRepository,
  plateId: PlateId,
): WipeTowerGhost | undefined {
  const plate = state.plates.find((candidate) => candidate.id === plateId);
  if (!plate) throw new WipeTowerGhostError(`Unknown plate ${plateId}`, 'unknown-plate');
  const tower = plate.wipeTower;
  if (!tower?.enabled) return undefined;
  const footprint = wipeTowerFootprint(state, plate, tower.positionMm);
  let top = Number.NEGATIVE_INFINITY;
  for (const object of plate.objects) {
    for (const instance of object.instances) {
      try {
        const bounds = computeCanonicalInstanceBounds(state, assets, [instance.id], { volumeRoles: ['model'] });
        top = Math.max(top, bounds.max[2]);
      } catch {
        // An instance with no readable model part gives the tower no height.
      }
    }
  }
  const standIn = !(top > 0);
  const ghost: WipeTowerGhost = {
    positionMm: [tower.positionMm[0], tower.positionMm[1]],
    widthMm: Math.max(WIPE_TOWER_GHOST_MIN_WIDTH_MM, footprint.widthMm),
    heightMm: standIn ? WIPE_TOWER_GHOST_STAND_IN_MM : top,
    standIn,
    marginMm: footprint.marginMm,
  };
  if (![...ghost.positionMm, ghost.widthMm, ghost.heightMm, ghost.marginMm].every(Number.isFinite)) {
    throw new WipeTowerGhostError('The wipe tower has no finite size to draw', 'non-finite');
  }
  return Object.freeze(ghost);
}
