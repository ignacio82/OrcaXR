export interface FixedVirtualWindowOptions {
  readonly rowCount: number;
  readonly scrollOffsetPx: number;
  readonly viewportHeightPx: number;
  readonly rowHeightPx: number;
  readonly overscanRows?: number;
}

export interface FixedVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTopPx: number;
  readonly offsetBottomPx: number;
  readonly totalHeightPx: number;
}

/** O(1) fixed-row window calculation; endIndex is exclusive. */
export function computeFixedVirtualWindow(options: FixedVirtualWindowOptions): FixedVirtualWindow {
  const count = nonNegativeInteger(options.rowCount, 'rowCount');
  const height = positiveFinite(options.rowHeightPx, 'rowHeightPx');
  const viewport = nonNegativeFinite(options.viewportHeightPx, 'viewportHeightPx');
  const overscan = nonNegativeInteger(options.overscanRows ?? 4, 'overscanRows');
  const total = count * height;
  const maxOffset = Math.max(0, total - viewport);
  const offset = Math.min(Math.max(0, finite(options.scrollOffsetPx, 'scrollOffsetPx')), maxOffset);
  const first = Math.min(count, Math.floor(offset / height));
  const visibleEnd = Math.min(count, Math.ceil((offset + viewport) / height));
  const startIndex = Math.max(0, first - overscan);
  const endIndex = Math.min(count, visibleEnd + overscan);
  return {
    startIndex,
    endIndex,
    offsetTopPx: startIndex * height,
    offsetBottomPx: Math.max(0, total - endIndex * height),
    totalHeightPx: total,
  };
}

export function sliceVirtualRows<T>(rows: readonly T[], window: FixedVirtualWindow): readonly T[] {
  return rows.slice(window.startIndex, window.endIndex);
}

export function scrollOffsetToRevealRow(
  index: number,
  currentOffsetPx: number,
  viewportHeightPx: number,
  rowHeightPx: number,
  rowCount: number,
): number {
  const count = nonNegativeInteger(rowCount, 'rowCount');
  if (count === 0) return 0;
  const target = Math.min(nonNegativeInteger(index, 'index'), count - 1);
  const height = positiveFinite(rowHeightPx, 'rowHeightPx');
  const viewport = nonNegativeFinite(viewportHeightPx, 'viewportHeightPx');
  const maxOffset = Math.max(0, count * height - viewport);
  const current = Math.min(Math.max(0, finite(currentOffsetPx, 'currentOffsetPx')), maxOffset);
  const top = target * height;
  const bottom = top + height;
  if (top < current) return top;
  if (bottom > current + viewport) return Math.min(maxOffset, bottom - viewport);
  return current;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
