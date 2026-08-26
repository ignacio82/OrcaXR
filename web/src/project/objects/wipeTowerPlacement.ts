import type { AssetRepository } from '../assets';
import type { PlateId } from '../domain/ids';
import type { ProjectState, VolumeRole, WipeTowerState } from '../domain/model';
import { computeCanonicalInstanceBounds } from './bounds';

export const PRINTABLE_ROLES: readonly VolumeRole[] = Object.freeze(['model', 'support-enforcer', 'support-blocker']);

export interface AabbXY {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export function aabbOf(cx: number, cy: number, w: number, d: number): AabbXY {
  return { xMin: cx - w / 2, yMin: cy - d / 2, xMax: cx + w / 2, yMax: cy + d / 2 };
}

/** Grow an AABB by `margin` on all four sides. Negative shrinks it. */
export function expandAabb(box: AabbXY, margin: number): AabbXY {
  return {
    xMin: box.xMin - margin,
    yMin: box.yMin - margin,
    xMax: box.xMax + margin,
    yMax: box.yMax + margin,
  };
}

export type WipeTowerBias = 'back_left' | 'back_right' | 'front_left' | 'front_right' | 'largest_clearance';

export function parseBias(name: string | null | undefined): WipeTowerBias {
  if (!name) return 'back_left';
  switch (name.toLowerCase().replace(/-/g, '_')) {
    case 'back_left':
      return 'back_left';
    case 'back_right':
      return 'back_right';
    case 'front_left':
      return 'front_left';
    case 'front_right':
      return 'front_right';
    case 'largest_clearance':
    case 'largest':
    case 'max':
      return 'largest_clearance';
    default:
      return 'back_left';
  }
}

export interface WipeTowerPick {
  /** wipe_tower_x — printer-frame X of the tower body's left-front corner (mm). */
  xMm: number;
  /** wipe_tower_y — printer-frame Y of the tower body's left-front corner (mm). */
  yMm: number;
  /** Minimum L∞ clearance (mm) to any part at this position (Infinity if none). */
  clearanceMm: number;
  /** Which candidate won (e.g. "back-left"). */
  label: string;
  /**
   * The whole printed footprint this placement reserves — body plus everything
   * the engine draws outside it. Exposed so a caller can show or verify the
   * area the tower will actually occupy rather than re-deriving it.
   */
  footprint: AabbXY;
}

/** L∞ (Chebyshev) distance between two AABBs; negative on overlap. */
export function aabbLInfClearance(a: AabbXY, b: AabbXY): number {
  const dx = Math.max(a.xMin - b.xMax, b.xMin - a.xMax);
  const dy = Math.max(a.yMin - b.yMax, b.yMin - a.yMax);
  return Math.max(dx, dy);
}

const COMPARE_EPS_MM = 5;

/**
 * How far the printed prime tower reaches outside `prime_tower_width`.
 *
 * The engine draws more than the tower body, and none of it was reserved:
 *
 *  - **The brim.** `WipeTower2::toolchange_Brim` offsets the wall polygon
 *    outward by `prime_tower_brim_width`, so the first layer is that much wider
 *    than the body on every side.
 *  - **The rib wall.** When `wipe_tower_wall_type` is `rib`, `generate_rib_polygon`
 *    unions two diagonals of half-width `wipe_tower_rib_width / 2` across the
 *    body, each extended by up to `wipe_tower_extra_rib_length / 2`. Their
 *    corners stick out past the body's, and the brim is then offset from *that*.
 *
 * The rib term is an upper bound rather than the exact polygon: the true
 * overhang is the diagonal extension resolved onto X and Y, which is always at
 * most the extension itself. Reserving the bound keeps the tower on the bed for
 * every rib angle, and over-reserving only moves it a few millimetres inward.
 * Reproducing `generate_rib_polygon` here would be a second geometry that has
 * to be kept in step with the engine's; a bound cannot drift.
 */
export function wipeTowerFootprintMarginMm(config: Readonly<Record<string, unknown>>): number {
  const brim = Math.max(0, numeric(config['prime_tower_brim_width']) ?? 0);
  const wallType = String(config['wipe_tower_wall_type'] ?? '')
    .trim()
    .toLowerCase();
  if (wallType !== 'rib') return brim;
  const ribWidth = Math.max(0, numeric(config['wipe_tower_rib_width']) ?? 0);
  const extraRibLength = Math.max(0, numeric(config['wipe_tower_extra_rib_length']) ?? 0);
  return brim + ribWidth / 2 + extraRibLength / 2;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface WipeTowerOpts {
  towerW?: number;
  towerD?: number;
  safetyMm?: number;
  bias?: WipeTowerBias;
  /**
   * Printed overhang outside the body, on every side (mm).
   *
   * Reserved so the tower's *footprint* — not merely its body — lands on the
   * bed. `wipe_tower_x/y` still addresses the body corner, because that is what
   * the engine reads.
   */
  marginMm?: number;
}

/**
 * Score the 8 candidates and return the best placement.
 *
 * `bed` is the printable rectangle in printer coordinates, **not** a size: a
 * bed whose printable area starts away from the origin (the Snapmaker U1's is
 * `0.5x1 … 270.5x271`) is the ordinary case, and treating its far corner as a
 * size silently places the tower against a wall that is not where the code
 * thought it was.
 */
export function scoreWipeTower(parts: AabbXY[], bed: AabbXY, opts: WipeTowerOpts = {}): WipeTowerPick {
  const towerW = opts.towerW ?? 60;
  const towerD = opts.towerD ?? towerW;
  const safetyMm = opts.safetyMm ?? 5;
  const bias = opts.bias ?? 'back_left';
  const margin = Math.max(0, opts.marginMm ?? 0);

  // What the tower actually prints, and therefore what has to fit on the bed.
  const footW = towerW + 2 * margin;
  const footD = towerD + 2 * margin;

  const inset = 1;
  // Candidate corners are the *footprint's*, converted back to body corners on
  // the way out. Clamped so a bed too small for the inset still lands the
  // footprint inside it rather than hanging the tower off the edge.
  const spanX = bed.xMax - bed.xMin;
  const spanY = bed.yMax - bed.yMin;
  const slackX = Math.max(spanX - footW, 0);
  const slackY = Math.max(spanY - footD, 0);
  const xLeft = bed.xMin + Math.min(inset, slackX);
  const xRight = bed.xMin + Math.max(slackX - inset, 0);
  const xMid = bed.xMin + slackX / 2;
  const yFront = bed.yMin + Math.min(inset, slackY);
  const yBack = bed.yMin + Math.max(slackY - inset, 0);
  const yMid = bed.yMin + slackY / 2;

  const candidates: Array<[string, number, number]> = [
    ['back-left', xLeft, yBack],
    ['back-right', xRight, yBack],
    ['front-left', xLeft, yFront],
    ['front-right', xRight, yFront],
    ['back-mid', xMid, yBack],
    ['front-mid', xMid, yFront],
    ['left-mid', xLeft, yMid],
    ['right-mid', xRight, yMid],
  ];

  const biasOrders: Record<WipeTowerBias, string[]> = {
    back_left: [
      'back-left',
      'back-mid',
      'back-right',
      'left-mid',
      'right-mid',
      'front-left',
      'front-mid',
      'front-right',
    ],
    back_right: [
      'back-right',
      'back-mid',
      'back-left',
      'right-mid',
      'left-mid',
      'front-right',
      'front-mid',
      'front-left',
    ],
    front_left: [
      'front-left',
      'front-mid',
      'front-right',
      'left-mid',
      'right-mid',
      'back-left',
      'back-mid',
      'back-right',
    ],
    front_right: [
      'front-right',
      'front-mid',
      'front-left',
      'right-mid',
      'left-mid',
      'back-right',
      'back-mid',
      'back-left',
    ],
    largest_clearance: [],
  };
  const biasOrder = biasOrders[bias];

  const ranked = candidates.map(([label, x, y]) => {
    const footprint: AabbXY = { xMin: x, yMin: y, xMax: x + footW, yMax: y + footD };
    // The clearance box is the footprint grown by the safety margin on *all
    // four* sides. It used to be anchored at the corner and grown only toward
    // +X/+Y, so a part to the left of the tower read as `safetyMm` closer than
    // it was and a part to the right as that much further away.
    const guard = expandAabb(footprint, safetyMm);
    const minClearance = parts.length === 0 ? Infinity : Math.min(...parts.map((p) => aabbLInfClearance(guard, p)));
    return { label, x, y, clearance: minClearance, footprint };
  });

  let best: (typeof ranked)[number];
  if (bias === 'largest_clearance') {
    best = ranked.reduce((a, b) => (b.clearance > a.clearance ? b : a));
  } else {
    const byBias = new Map(biasOrder.map((lbl, i) => [lbl, i] as const));
    const sorted = [...ranked].sort((a, b) => {
      // Bucket clearances within COMPARE_EPS_MM so the bias can win ties.
      const bucketA = Math.trunc((a.clearance === Infinity ? 1e9 : a.clearance) / COMPARE_EPS_MM);
      const bucketB = Math.trunc((b.clearance === Infinity ? 1e9 : b.clearance) / COMPARE_EPS_MM);
      if (bucketA !== bucketB) return bucketB - bucketA;
      return (byBias.get(a.label) ?? Number.MAX_SAFE_INTEGER) - (byBias.get(b.label) ?? Number.MAX_SAFE_INTEGER);
    });
    best = sorted[0];
  }

  // `wipe_tower_x/y` addresses the body, so the reserved margin comes back off
  // the winning footprint corner before it is handed to the engine.
  return {
    xMm: best.x + margin,
    yMm: best.y + margin,
    clearanceMm: best.clearance,
    label: best.label,
    footprint: best.footprint,
  };
}

export interface WipeTowerPlanOptions extends WipeTowerOpts {
  /** The printable rectangle in printer coordinates; wins over everything else. */
  readonly bedRectMm?: AabbXY;
  /**
   * Legacy bed extent, taken as a rectangle at the origin.
   *
   * Kept for callers that only know a size, and deliberately *below*
   * `printable_area` in precedence: a caller passing the printable area's far
   * corner as a "size" is how the tower came to be placed against an edge the
   * bed does not have.
   */
  readonly bedSizeMm?: readonly [number, number];
  readonly volumeRoles?: readonly VolumeRole[];
}

export interface WipeTowerPlacementResult {
  readonly plateId: PlateId;
  readonly pick: WipeTowerPick;
  readonly state: WipeTowerState;
}

export class WipeTowerPlacementError extends Error {
  readonly code: 'unknown-plate' | 'invalid-bed';

  constructor(message: string, code: 'unknown-plate' | 'invalid-bed') {
    super(message);
    this.name = 'WipeTowerPlacementError';
    this.code = code;
  }
}

export function planWipeTowerPlacement(
  state: ProjectState,
  assets: AssetRepository,
  plateId: PlateId,
  options?: WipeTowerPlanOptions,
): WipeTowerPlacementResult {
  const plate = state.plates.find((candidate) => candidate.id === plateId);
  if (!plate) {
    throw new WipeTowerPlacementError(`Unknown plate ${plateId}`, 'unknown-plate');
  }

  // The printable area is the authority: it carries the origin as well as the
  // extent, and a bed whose printable region starts away from (0, 0) is the
  // ordinary case rather than an exotic one.
  const bed =
    validBedRect(options?.bedRectMm) ??
    printableAreaRect(plate.config.printable_area ?? state.config.printable_area) ??
    validBedRect(bedRectFromSize(options?.bedSizeMm));

  if (!bed) {
    throw new WipeTowerPlacementError('Wipe-tower placement requires a positive printable area', 'invalid-bed');
  }

  const towerW =
    options?.towerW ??
    (Number(
      plate.config.prime_tower_width ??
        state.config.prime_tower_width ??
        plate.config.wipe_tower_width ??
        state.config.wipe_tower_width,
    ) ||
      60);
  const towerD = options?.towerD ?? towerW;

  const roles = options?.volumeRoles ?? PRINTABLE_ROLES;
  const parts: AabbXY[] = [];

  for (const object of plate.objects) {
    for (const instance of object.instances) {
      if (!instance.printable) continue;
      try {
        const bounds = computeCanonicalInstanceBounds(state, assets, [instance.id], { volumeRoles: roles });
        parts.push({
          xMin: bounds.min[0],
          yMin: bounds.min[1],
          xMax: bounds.max[0],
          yMax: bounds.max[1],
        });
      } catch {
        // Skip unreadable or non-printable instances
      }
    }
  }

  const pick = scoreWipeTower(parts, bed, {
    ...options,
    towerW,
    towerD,
    marginMm: options?.marginMm ?? wipeTowerFootprintMarginMm({ ...state.config, ...plate.config }),
  });

  const nextState: WipeTowerState = {
    enabled: true,
    positionMm: [pick.xMm, pick.yMm],
    rotationDeg: plate.wipeTower?.rotationDeg ?? 0,
    ...(plate.wipeTower?.filamentId ? { filamentId: plate.wipeTower.filamentId } : {}),
  };

  return {
    plateId,
    pick,
    state: nextState,
  };
}

function validBedRect(rect: AabbXY | undefined): AabbXY | undefined {
  if (!rect) return undefined;
  return rect.xMax > rect.xMin && rect.yMax > rect.yMin ? rect : undefined;
}

function bedRectFromSize(size: readonly [number, number] | undefined): AabbXY | undefined {
  if (!size) return undefined;
  const [x, y] = size;
  if (!(x > 0) || !(y > 0)) return undefined;
  return { xMin: 0, yMin: 0, xMax: x, yMax: y };
}

/** The printable rectangle a `printable_area` polygon encloses. */
export function printableAreaRect(value: unknown): AabbXY | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/).map((entry) => entry.trim())
      : [];
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*x\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/i.exec(entry);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (points.length < 2) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const rect: AabbXY = {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
  return validBedRect(rect);
}
