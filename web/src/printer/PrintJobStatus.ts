import type { MoonrakerObjectSubscription } from './MoonrakerTransport';

/**
 * What the machine is doing right now, projected from the exact Klipper
 * objects Moonraker reports. Nothing here is inferred from a previous command:
 * a field the printer does not report stays absent rather than defaulting, so
 * a control surface can distinguish "not printing" from "not known".
 */
export type PrintJobState = 'standby' | 'printing' | 'paused' | 'complete' | 'cancelled' | 'error' | 'unknown';

export interface PrintJobTemperature {
  readonly actualC: number;
  readonly targetC: number;
}

export interface PrintJobSnapshot {
  readonly state: PrintJobState;
  /** Klippy's own readiness, which gates every lifecycle command. */
  readonly klippyState?: string;
  readonly filename?: string;
  /** `print_stats.message` — the failure text when the state is `error`. */
  readonly message?: string;
  /** 0–1, from the file position the printer reports. */
  readonly progress?: number;
  readonly currentLayer?: number;
  readonly totalLayers?: number;
  readonly printDurationS?: number;
  readonly totalDurationS?: number;
  readonly filamentUsedMm?: number;
  /**
   * File-progress extrapolation, not a firmware estimate: Moonraker reports no
   * remaining time, so this is `printDuration / progress - printDuration` and
   * is only produced once enough of the file has run for that to mean anything.
   * Present it as an approximation.
   */
  readonly estimatedRemainingS?: number;
  readonly extruder?: PrintJobTemperature;
  readonly bed?: PrintJobTemperature;
  readonly updatedAtMs: number;
}

/** Exactly the objects this model reads; the subscription mirrors the query. */
export const PRINT_JOB_OBJECTS: MoonrakerObjectSubscription = Object.freeze({
  webhooks: null,
  print_stats: null,
  virtual_sdcard: null,
  display_status: null,
  extruder: null,
  heater_bed: null,
});

export const PRINT_JOB_QUERY_PATH =
  '/printer/objects/query?webhooks&print_stats&virtual_sdcard&display_status&extruder&heater_bed';

const EMPTY_SNAPSHOT: PrintJobSnapshot = Object.freeze({ state: 'unknown', updatedAtMs: 0 });

/**
 * Accumulates Klipper object state across one full query plus any number of
 * partial `notify_status_update` patches, and projects it into one immutable
 * snapshot. Patches are partial by design — Moonraker sends only what changed —
 * so the accumulator, not the projection, is the thing that must be merged.
 */
export class PrintJobStatusModel {
  private raw: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  private current: PrintJobSnapshot = EMPTY_SNAPSHOT;

  get snapshot(): PrintJobSnapshot {
    return this.current;
  }

  reset(): PrintJobSnapshot {
    this.raw = Object.create(null) as Record<string, Record<string, unknown>>;
    this.current = EMPTY_SNAPSHOT;
    return this.current;
  }

  /** Seed from `/printer/objects/query`, whose result wraps a `status` map. */
  applyQuery(payload: unknown, nowMs = Date.now()): PrintJobSnapshot {
    const status = isRecord(payload) && isRecord(payload.status) ? payload.status : payload;
    return this.applyStatus(status, nowMs);
  }

  /** Apply one `notify_status_update` params array (`[status, eventtime]`). */
  applyNotification(params: unknown, nowMs = Date.now()): PrintJobSnapshot | null {
    const status = Array.isArray(params) ? params[0] : params;
    if (!isRecord(status)) return null;
    if (!Object.keys(status).some((key) => key in PRINT_JOB_OBJECTS)) return null;
    return this.applyStatus(status, nowMs);
  }

  private applyStatus(status: unknown, nowMs: number): PrintJobSnapshot {
    if (isRecord(status)) {
      for (const [object, value] of Object.entries(status)) {
        if (!isRecord(value)) continue;
        this.raw[object] = mergeRecords(this.raw[object] ?? {}, value);
      }
    }
    this.current = projectSnapshot(this.raw, nowMs);
    return this.current;
  }
}

/** Project one accumulated object map; exported for tests and headless callers. */
export function projectPrintJobSnapshot(
  status: Readonly<Record<string, Record<string, unknown>>>,
  nowMs = Date.now(),
): PrintJobSnapshot {
  return projectSnapshot(status, nowMs);
}

function projectSnapshot(raw: Readonly<Record<string, Record<string, unknown>>>, nowMs: number): PrintJobSnapshot {
  const printStats = raw.print_stats ?? {};
  const virtualSd = raw.virtual_sdcard ?? {};
  const display = raw.display_status ?? {};
  const info = isRecord(printStats.info) ? printStats.info : {};

  const progress = firstFinite([virtualSd.progress, display.progress]);
  const printDurationS = finiteOrUndefined(printStats.print_duration);
  const snapshot: {
    state: PrintJobState;
    updatedAtMs: number;
    [key: string]: unknown;
  } = {
    state: normalizeState(printStats.state),
    updatedAtMs: nowMs,
  };

  assign(snapshot, 'klippyState', stringOrUndefined((raw.webhooks ?? {}).state));
  assign(snapshot, 'filename', nonEmptyString(printStats.filename));
  assign(snapshot, 'message', nonEmptyString(printStats.message));
  assign(snapshot, 'progress', progress === undefined ? undefined : clamp01(progress));
  assign(snapshot, 'currentLayer', positiveInteger(info.current_layer));
  assign(snapshot, 'totalLayers', positiveInteger(info.total_layer));
  assign(snapshot, 'printDurationS', printDurationS);
  assign(snapshot, 'totalDurationS', finiteOrUndefined(printStats.total_duration));
  assign(snapshot, 'filamentUsedMm', finiteOrUndefined(printStats.filament_used));
  assign(snapshot, 'estimatedRemainingS', estimateRemaining(progress, printDurationS));
  assign(snapshot, 'extruder', temperature(raw.extruder));
  assign(snapshot, 'bed', temperature(raw.heater_bed));
  return Object.freeze(snapshot) as PrintJobSnapshot;
}

/** True when the machine is running or holding a job the operator can control. */
export function isActivePrintState(state: PrintJobState): boolean {
  return state === 'printing' || state === 'paused';
}

export function describePrintJobState(snapshot: PrintJobSnapshot): string {
  switch (snapshot.state) {
    case 'printing':
      return snapshot.filename ? `Printing ${snapshot.filename}` : 'Printing';
    case 'paused':
      return snapshot.filename ? `Paused — ${snapshot.filename}` : 'Paused';
    case 'complete':
      return snapshot.filename ? `Finished ${snapshot.filename}` : 'Finished';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return snapshot.message ? `Error: ${snapshot.message}` : 'Error';
    case 'standby':
      return 'Idle';
    default:
      return 'State not reported';
  }
}

/** `1h 04m` / `12m 30s` / `45s`, or an em dash when the printer reports nothing. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

function estimateRemaining(progress: number | undefined, printDurationS: number | undefined): number | undefined {
  // Below a couple of percent the extrapolation is dominated by heat-up and
  // start G-code, and would report a wildly wrong number with false precision.
  if (progress === undefined || printDurationS === undefined) return undefined;
  if (progress <= 0.02 || progress >= 1 || printDurationS <= 0) return undefined;
  const remaining = printDurationS / progress - printDurationS;
  return Number.isFinite(remaining) && remaining >= 0 ? remaining : undefined;
}

function normalizeState(value: unknown): PrintJobState {
  const state = typeof value === 'string' ? value.toLowerCase() : '';
  switch (state) {
    case 'printing':
    case 'paused':
    case 'complete':
    case 'cancelled':
    case 'error':
    case 'standby':
      return state;
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function temperature(source: Record<string, unknown> | undefined): PrintJobTemperature | undefined {
  const actualC = finiteOrUndefined(source?.temperature);
  if (actualC === undefined) return undefined;
  return Object.freeze({ actualC, targetC: finiteOrUndefined(source?.target) ?? 0 });
}

/**
 * Merge one status patch into an accumulated object. Nested records (notably
 * `print_stats.info`) merge field-by-field: Moonraker may report only the
 * layer that changed, and replacing the record wholesale would drop the total.
 */
function mergeRecords(previous: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? mergeRecords(existing, value) : value;
  }
  return merged;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function firstFinite(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteOrUndefined(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
