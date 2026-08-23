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
  /** wipe_tower_x — printer-frame X of the tower's left-front corner (mm). */
  xMm: number;
  /** wipe_tower_y — printer-frame Y of the tower's left-front corner (mm). */
  yMm: number;
  /** Minimum L∞ clearance (mm) to any part at this position (Infinity if none). */
  clearanceMm: number;
  /** Which candidate won (e.g. "back-left"). */
  label: string;
}

/** L∞ (Chebyshev) distance between two AABBs; negative on overlap. */
export function aabbLInfClearance(a: AabbXY, b: AabbXY): number {
  const dx = Math.max(a.xMin - b.xMax, b.xMin - a.xMax);
  const dy = Math.max(a.yMin - b.yMax, b.yMin - a.yMax);
  return Math.max(dx, dy);
}

const COMPARE_EPS_MM = 5;

export interface WipeTowerOpts {
  towerW?: number;
  towerD?: number;
  safetyMm?: number;
  bias?: WipeTowerBias;
}

/** Score the 8 candidates and return the best placement. */
export function scoreWipeTower(parts: AabbXY[], bedW: number, bedD: number, opts: WipeTowerOpts = {}): WipeTowerPick {
  const towerW = opts.towerW ?? 60;
  const towerD = opts.towerD ?? towerW;
  const safetyMm = opts.safetyMm ?? 5;
  const bias = opts.bias ?? 'back_left';

  const tw = Math.max(towerW + 2 * safetyMm, 1);
  const td = Math.max(towerD + 2 * safetyMm, 1);

  const inset = 1;
  const xLeft = inset;
  const xRight = Math.max(bedW - towerW - inset, 0);
  const xMid = Math.max((bedW - towerW) / 2, 0);
  const yFront = inset;
  const yBack = Math.max(bedD - towerD - inset, 0);
  const yMid = Math.max((bedD - towerD) / 2, 0);

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
    const tower: AabbXY = { xMin: x, yMin: y, xMax: x + tw, yMax: y + td };
    const minClearance = parts.length === 0 ? Infinity : Math.min(...parts.map((p) => aabbLInfClearance(tower, p)));
    return { label, x, y, clearance: minClearance };
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

  return { xMm: best.x, yMm: best.y, clearanceMm: best.clearance, label: best.label };
}

export interface WipeTowerPlanOptions extends WipeTowerOpts {
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

  let bedW = options?.bedSizeMm?.[0];
  let bedD = options?.bedSizeMm?.[1];

  if (bedW === undefined || bedD === undefined || !(bedW > 0) || !(bedD > 0)) {
    const bedFromConfig = printableAreaDimensions(plate.config.printable_area ?? state.config.printable_area);
    if (bedFromConfig) {
      bedW = bedFromConfig.x;
      bedD = bedFromConfig.y;
    }
  }

  if (bedW === undefined || bedD === undefined || !(bedW > 0) || !(bedD > 0)) {
    throw new WipeTowerPlacementError('Wipe-tower placement requires positive bed dimensions', 'invalid-bed');
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

  const pick = scoreWipeTower(parts, bedW, bedD, {
    ...options,
    towerW,
    towerD,
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

function printableAreaDimensions(value: unknown): { x: number; y: number } | undefined {
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
  const x = Math.max(...xs) - Math.min(...xs);
  const y = Math.max(...ys) - Math.min(...ys);
  return x > 0 && y > 0 ? { x, y } : undefined;
}
