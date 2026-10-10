/**
 * The bed the workspace places models on, read from the project's own
 * configuration as the workspace reads it. The shared Rust core answers the
 * same (`orcaxr_project::placement::bed`, through `WorkspaceBedExchange.ts`).
 *
 * - The bed size is the far corner of `printable_area` (`bedSizeFromProfile`
 *   over the polygon as the profile's flattened text), else the 200 mm plate.
 *   The workspace draws the plate from the bed corner to it, maps printer
 *   space with it, and places, centres, scales to fit and arranges on it.
 * - The printable area is the rectangle the polygon encloses
 *   (`printableAreaRect`). Its origin is its own lowest corner, which a
 *   printer may offset from the bed corner (the U1's is at 0.5 × 1 mm).
 * - The printable height is `printable_height` as scale-to-fit reads it.
 * - An enabled wipe tower on a plate keeps a square of its drawn width clear
 *   when that plate is arranged or filled.
 */
import type { WipeTowerState } from '../project/domain/model';
import type { ArrangeRegion } from '../project/objects/arrange';
import { printableAreaRect, type AabbXY } from '../project/objects/wipeTowerPlacement';
import { bedSizeFromProfile } from '../slicer/ProfileLoader';

type Config = Readonly<Record<string, unknown>>;

export interface WorkspaceBed {
  /** Width and depth (mm): the far corner of the printable area, or 200 × 200. */
  readonly sizeMm: readonly [number, number];
  /** The printable rectangle, when the polygon encloses one. */
  readonly printableArea?: AabbXY;
  /** The printable height (mm), when the configuration states a positive one. */
  readonly printableHeightMm?: number;
}

/**
 * `printable_area` as the profile's flattened text: a string as it is, a list
 * of strings joined with commas, anything else empty.
 */
export function printableAreaText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.join(',') : '';
}

/** `printable_height` as scale-to-fit reads it; none unless it is a positive number. */
export function printableHeightMm(config: Config): number | undefined {
  const raw = config['printable_height'];
  const height = Number.parseFloat(String(Array.isArray(raw) ? raw[0] : (raw ?? '')));
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/** The workspace's bed from a project configuration. */
export function workspaceBed(config: Config): WorkspaceBed {
  const size = bedSizeFromProfile({ printable_area: printableAreaText(config['printable_area']) });
  const area = printableAreaRect(config['printable_area']);
  const height = printableHeightMm(config);
  return {
    sizeMm: [size.x, size.y],
    ...(area ? { printableArea: area } : {}),
    ...(height !== undefined ? { printableHeightMm: height } : {}),
  };
}

/** The wipe tower's drawn width: `prime_tower_width`, else `wipe_tower_width`, else 60 mm. */
export function wipeTowerWidthMm(config: Config): number {
  return Number(config['prime_tower_width'] ?? config['wipe_tower_width']) || 60;
}

/**
 * The region an enabled wipe tower keeps clear when its plate is arranged or
 * filled: a square of the tower's drawn width from its front-left corner.
 */
export function wipeTowerKeepOut(config: Config, tower: WipeTowerState | undefined): ArrangeRegion | undefined {
  if (!tower?.enabled) return undefined;
  const widthMm = wipeTowerWidthMm(config);
  return {
    minX: tower.positionMm[0],
    minY: tower.positionMm[1],
    maxX: tower.positionMm[0] + widthMm,
    maxY: tower.positionMm[1] + widthMm,
  };
}
