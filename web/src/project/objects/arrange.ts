import type { AssetRepository } from '../assets';
import type { InstanceId, PlateId } from '../domain/ids';
import type { ProjectState, Transform, VolumeRole } from '../domain/model';
import { computeCanonicalInstanceBounds } from './bounds';
import type { InstanceTransformChange } from './transformCommands';

/** Axis-aligned keep-out rectangle in plate millimetres. */
export interface ArrangeRegion {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface ArrangeConstraints {
  /** Printable area, matching the canonical `printable_area` origin at (0, 0). */
  readonly bedSizeMm: readonly [number, number];
  /** Clear gap kept between placed footprints. */
  readonly spacingMm?: number;
  /** Clear gap kept from the printable-area border. */
  readonly bedMarginMm?: number;
  /** Wipe tower, exclusion zones, and any other forbidden rectangle. */
  readonly exclusions?: readonly ArrangeRegion[];
  /** Instances that keep their exact placement and reserve their footprint. */
  readonly lockedInstanceIds?: readonly InstanceId[];
  /** Volume roles included in the footprint; defaults to printable roles. */
  readonly volumeRoles?: readonly VolumeRole[];
}

export interface ArrangePlacement {
  readonly instanceId: InstanceId;
  readonly transform: Transform;
  /** Footprint after placement, for callers that render or verify it. */
  readonly footprint: ArrangeRegion;
}

export interface ArrangeResult {
  readonly plateId: PlateId;
  /** Only instances whose placement actually changes. */
  readonly placements: readonly ArrangePlacement[];
  /** Instances that do not fit and were deliberately left untouched. */
  readonly unplacedInstanceIds: readonly InstanceId[];
  /** Instances excluded because the caller locked them. */
  readonly lockedInstanceIds: readonly InstanceId[];
}

export class ArrangeConstraintError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-bed' | 'invalid-spacing' | 'unknown-plate' | 'invalid-exclusion',
  ) {
    super(message);
    this.name = 'ArrangeConstraintError';
  }
}

/** Upstream's default minimum object distance for non-sequential printing. */
export const DEFAULT_ARRANGE_SPACING_MM = 6;
export const DEFAULT_ARRANGE_BED_MARGIN_MM = 2;
/** Footprints below this size are treated as degenerate and left in place. */
const MIN_FOOTPRINT_MM = 1e-6;
const PRINTABLE_ROLES: readonly VolumeRole[] = Object.freeze(['model', 'support-enforcer', 'support-blocker']);

/**
 * Deterministic shelf arrangement over canonical bounds.
 *
 * Placement reads only immutable asset bytes and canonical transforms, sorts
 * by footprint so the same project always produces the same layout, keeps
 * locked instances and every declared exclusion clear, and rotates nothing —
 * an instance keeps its orientation, Z, and printable state. Instances that
 * cannot fit are reported instead of being stacked or pushed off the bed.
 */
export function planPlateArrangement(
  state: ProjectState,
  assets: AssetRepository,
  plateId: PlateId,
  constraints: ArrangeConstraints,
): ArrangeResult {
  const plate = state.plates.find((candidate) => candidate.id === plateId);
  if (!plate) throw new ArrangeConstraintError(`Unknown plate ${plateId}`, 'unknown-plate');
  const [bedX, bedY] = constraints.bedSizeMm;
  if (!Number.isFinite(bedX) || !Number.isFinite(bedY) || bedX <= 0 || bedY <= 0) {
    throw new ArrangeConstraintError('Arrangement needs a positive printable area', 'invalid-bed');
  }
  const spacing = constraints.spacingMm ?? DEFAULT_ARRANGE_SPACING_MM;
  const margin = constraints.bedMarginMm ?? DEFAULT_ARRANGE_BED_MARGIN_MM;
  if (!Number.isFinite(spacing) || spacing < 0 || !Number.isFinite(margin) || margin < 0) {
    throw new ArrangeConstraintError('Arrangement spacing and margin must be non-negative', 'invalid-spacing');
  }
  for (const region of constraints.exclusions ?? []) {
    if (
      ![region.minX, region.minY, region.maxX, region.maxY].every((value) => Number.isFinite(value)) ||
      region.maxX < region.minX ||
      region.maxY < region.minY
    ) {
      throw new ArrangeConstraintError('An arrangement exclusion is not a valid rectangle', 'invalid-exclusion');
    }
  }

  const locked = new Set(constraints.lockedInstanceIds ?? []);
  const roles = constraints.volumeRoles ?? PRINTABLE_ROLES;
  const candidates: {
    instanceId: InstanceId;
    width: number;
    depth: number;
    transform: Transform;
    origin: ArrangeRegion;
  }[] = [];
  const reserved: ArrangeRegion[] = [...(constraints.exclusions ?? []).map((region) => ({ ...region }))];
  const lockedIds: InstanceId[] = [];

  for (const object of plate.objects) {
    for (const instance of object.instances) {
      let bounds;
      try {
        bounds = computeCanonicalInstanceBounds(state, assets, [instance.id], { volumeRoles: roles });
      } catch {
        // A volume with no printable role or unreadable asset is not arrangeable.
        continue;
      }
      const width = bounds.max[0] - bounds.min[0];
      const depth = bounds.max[1] - bounds.min[1];
      if (!(width > MIN_FOOTPRINT_MM) || !(depth > MIN_FOOTPRINT_MM)) continue;
      const footprint: ArrangeRegion = {
        minX: bounds.min[0],
        minY: bounds.min[1],
        maxX: bounds.max[0],
        maxY: bounds.max[1],
      };
      if (locked.has(instance.id) || !instance.printable) {
        lockedIds.push(instance.id);
        reserved.push(inflate(footprint, spacing / 2));
        continue;
      }
      candidates.push({ instanceId: instance.id, width, depth, transform: instance.transform, origin: footprint });
    }
  }

  // Deterministic order: largest depth, then width, then stable ID.
  candidates.sort(
    (left, right) =>
      right.depth - left.depth || right.width - left.width || left.instanceId.localeCompare(right.instanceId),
  );

  const usable: ArrangeRegion = { minX: margin, minY: margin, maxX: bedX - margin, maxY: bedY - margin };
  const placements: ArrangePlacement[] = [];
  const unplaced: InstanceId[] = [];
  let shelfMinY = usable.minY;
  let shelfDepth = 0;
  let cursorX = usable.minX;

  for (const candidate of candidates) {
    let placed: ArrangeRegion | undefined;
    // Walk shelves left to right, opening a new one when the row is full.
    for (let attempt = 0; attempt < 2 && !placed; attempt += 1) {
      if (cursorX + candidate.width > usable.maxX + MIN_FOOTPRINT_MM) {
        shelfMinY += shelfDepth > 0 ? shelfDepth + spacing : 0;
        shelfDepth = 0;
        cursorX = usable.minX;
      }
      if (
        cursorX + candidate.width <= usable.maxX + MIN_FOOTPRINT_MM &&
        shelfMinY + candidate.depth <= usable.maxY + MIN_FOOTPRINT_MM
      ) {
        let slot: ArrangeRegion = {
          minX: cursorX,
          minY: shelfMinY,
          maxX: cursorX + candidate.width,
          maxY: shelfMinY + candidate.depth,
        };
        // Slide right past reserved regions inside this shelf.
        let guard = 0;
        while (guard < 256) {
          const blocker = reserved.find((region) => overlaps(region, inflate(slot, spacing / 2)));
          if (!blocker) break;
          const nextX = blocker.maxX + spacing / 2;
          slot = { ...slot, minX: nextX, maxX: nextX + candidate.width };
          if (slot.maxX > usable.maxX + MIN_FOOTPRINT_MM) break;
          guard += 1;
        }
        if (
          slot.maxX <= usable.maxX + MIN_FOOTPRINT_MM &&
          !reserved.some((region) => overlaps(region, inflate(slot, spacing / 2)))
        ) {
          placed = slot;
          cursorX = slot.maxX + spacing;
          shelfDepth = Math.max(shelfDepth, candidate.depth);
        } else {
          // Force a new shelf on the next attempt.
          cursorX = usable.maxX + 1;
        }
      } else if (shelfMinY + candidate.depth > usable.maxY + MIN_FOOTPRINT_MM) {
        break;
      }
    }
    if (!placed) {
      unplaced.push(candidate.instanceId);
      continue;
    }
    reserved.push(inflate(placed, spacing / 2));
    const deltaX = placed.minX - candidate.origin.minX;
    const deltaY = placed.minY - candidate.origin.minY;
    if (Math.abs(deltaX) < MIN_FOOTPRINT_MM && Math.abs(deltaY) < MIN_FOOTPRINT_MM) continue;
    placements.push(
      Object.freeze({
        instanceId: candidate.instanceId,
        transform: Object.freeze({
          translationMm: Object.freeze([
            candidate.transform.translationMm[0] + deltaX,
            candidate.transform.translationMm[1] + deltaY,
            candidate.transform.translationMm[2],
          ]) as unknown as Transform['translationMm'],
          rotation: Object.freeze([...candidate.transform.rotation]) as unknown as Transform['rotation'],
          scale: Object.freeze([...candidate.transform.scale]) as unknown as Transform['scale'],
        }),
        footprint: Object.freeze(placed),
      }),
    );
  }

  // Centre the packed block on the plate when nothing else reserves space, so
  // an arranged plate looks like upstream's centred layout instead of a corner
  // cluster. With exclusions or locked instances the packed layout is kept as
  // is, because shifting it could push a model into reserved space.
  const centred =
    reserved.length === 0 || (constraints.exclusions ?? []).length + lockedIds.length === 0
      ? centrePlacements(placements, usable)
      : placements;

  return Object.freeze({
    plateId,
    placements: Object.freeze(centred),
    unplacedInstanceIds: Object.freeze(unplaced),
    lockedInstanceIds: Object.freeze(lockedIds),
  });
}

/** Convert a plan into the exact batch a canonical transform command takes. */
export function arrangementTransformChanges(result: ArrangeResult): InstanceTransformChange[] {
  return result.placements.map((placement) => ({
    instanceId: placement.instanceId,
    transform: placement.transform,
  }));
}

function centrePlacements(placements: readonly ArrangePlacement[], usable: ArrangeRegion): ArrangePlacement[] {
  if (placements.length === 0) return [...placements];
  const block = placements.reduce<ArrangeRegion>(
    (bounds, placement) => ({
      minX: Math.min(bounds.minX, placement.footprint.minX),
      minY: Math.min(bounds.minY, placement.footprint.minY),
      maxX: Math.max(bounds.maxX, placement.footprint.maxX),
      maxY: Math.max(bounds.maxY, placement.footprint.maxY),
    }),
    { ...placements[0].footprint },
  );
  const shiftX = (usable.minX + usable.maxX) / 2 - (block.minX + block.maxX) / 2;
  const shiftY = (usable.minY + usable.maxY) / 2 - (block.minY + block.maxY) / 2;
  if (Math.abs(shiftX) < MIN_FOOTPRINT_MM && Math.abs(shiftY) < MIN_FOOTPRINT_MM) return [...placements];
  if (
    block.minX + shiftX < usable.minX - MIN_FOOTPRINT_MM ||
    block.maxX + shiftX > usable.maxX + MIN_FOOTPRINT_MM ||
    block.minY + shiftY < usable.minY - MIN_FOOTPRINT_MM ||
    block.maxY + shiftY > usable.maxY + MIN_FOOTPRINT_MM
  ) {
    return [...placements];
  }
  return placements.map((placement) =>
    Object.freeze({
      instanceId: placement.instanceId,
      transform: Object.freeze({
        translationMm: Object.freeze([
          placement.transform.translationMm[0] + shiftX,
          placement.transform.translationMm[1] + shiftY,
          placement.transform.translationMm[2],
        ]) as unknown as Transform['translationMm'],
        rotation: placement.transform.rotation,
        scale: placement.transform.scale,
      }),
      footprint: Object.freeze({
        minX: placement.footprint.minX + shiftX,
        minY: placement.footprint.minY + shiftY,
        maxX: placement.footprint.maxX + shiftX,
        maxY: placement.footprint.maxY + shiftY,
      }),
    }),
  );
}

function inflate(region: ArrangeRegion, amount: number): ArrangeRegion {
  return {
    minX: region.minX - amount,
    minY: region.minY - amount,
    maxX: region.maxX + amount,
    maxY: region.maxY + amount,
  };
}

function overlaps(left: ArrangeRegion, right: ArrangeRegion): boolean {
  return (
    left.minX < right.maxX - MIN_FOOTPRINT_MM &&
    right.minX < left.maxX - MIN_FOOTPRINT_MM &&
    left.minY < right.maxY - MIN_FOOTPRINT_MM &&
    right.minY < left.maxY - MIN_FOOTPRINT_MM
  );
}
