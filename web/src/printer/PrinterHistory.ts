/**
 * What this printer has already printed (P9.6).
 *
 * Moonraker keeps a job record for every print it has run: what was printed,
 * how it ended, how long it took, and how much filament it consumed. That is
 * the answer to questions a slicer cannot answer from the project alone —
 * "did that one actually finish?", "how far off was the estimate?", "how much
 * PLA has this machine eaten this month?".
 *
 * Two rules, the same ones the rest of the printer boundary follows:
 *
 * - **A page is a page.** The history of a machine in daily service is
 *   thousands of jobs, so this pages explicitly and reports the total count
 *   rather than fetching everything and trimming client-side.
 *
 * - **Reported or absent, never zero.** A job Klipper never finished has no end
 *   time and no filament total. Rendering those as `0 s` and `0 mm` would state
 *   that a print took no time and used no material, which is a different claim
 *   from "the printer did not say".
 */

import { MoonrakerTransportError } from './MoonrakerTypes';

export interface PrinterHistoryTransport {
  request<T>(
    path: string,
    options?: { readonly signal?: AbortSignal; readonly operation?: string; readonly method?: string },
  ): Promise<T>;
}

/**
 * Outcomes Moonraker records. `in_progress` is a real stored state — a job
 * interrupted by a host crash stays that way — so it is kept rather than
 * folded into an error.
 */
export type PrintHistoryStatus =
  'completed' | 'cancelled' | 'error' | 'klippy_shutdown' | 'klippy_disconnect' | 'in_progress' | 'interrupted';

export interface PrintHistoryJob {
  readonly id: string;
  readonly filename: string;
  readonly status: PrintHistoryStatus;
  /** Unknown to this build of Moonraker; shown verbatim rather than dropped. */
  readonly rawStatus?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  /** Time spent printing, excluding pauses, as the printer measured it. */
  readonly printSeconds?: number;
  /** Wall-clock time from start to end, including pauses. */
  readonly totalSeconds?: number;
  readonly filamentUsedMm?: number;
  /** False once the file has been deleted from the printer. */
  readonly fileExists: boolean;
  /** The slicer's own estimate, when the file was scanned. */
  readonly estimatedSeconds?: number;
}

export interface PrintHistoryPage {
  readonly jobs: readonly PrintHistoryJob[];
  /** Total jobs the printer holds, which is what makes paging meaningful. */
  readonly total: number;
  readonly start: number;
  readonly limit: number;
}

export interface PrintHistoryTotals {
  readonly jobs?: number;
  readonly totalSeconds?: number;
  readonly printSeconds?: number;
  readonly filamentUsedMm?: number;
  readonly longestJobSeconds?: number;
  readonly longestPrintSeconds?: number;
}

export class PrintHistoryError extends Error {
  override readonly name = 'PrintHistoryError';

  constructor(
    message: string,
    readonly code: 'unavailable' | 'invalid-page' | 'cancelled',
  ) {
    super(message);
  }
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'error',
  'klippy_shutdown',
  'klippy_disconnect',
  'in_progress',
  'interrupted',
]);

/** Requesting more than this at once is a slow query on a real machine. */
export const MAX_HISTORY_PAGE = 100;

export interface PrintHistoryPageRequest {
  readonly start?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export async function listPrintHistory(
  transport: PrinterHistoryTransport,
  request: PrintHistoryPageRequest = {},
): Promise<PrintHistoryPage> {
  const limit = request.limit ?? 20;
  const start = request.start ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) {
    throw new PrintHistoryError(`A history page must hold between 1 and ${MAX_HISTORY_PAGE} jobs.`, 'invalid-page');
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new PrintHistoryError('A history page cannot start before the first job.', 'invalid-page');
  }

  let payload: unknown;
  try {
    payload = await transport.request<unknown>(`/server/history/list?limit=${limit}&start=${start}&order=desc`, {
      operation: 'print_history',
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throw historyFailure(error, 'The printer did not report its print history', request.signal);
  }
  if (!isRecord(payload)) {
    throw new PrintHistoryError("The printer's print history was not readable.", 'unavailable');
  }

  const jobs: PrintHistoryJob[] = [];
  for (const entry of asArray(payload.jobs)) {
    const job = readJob(entry);
    if (job) jobs.push(job);
  }
  // A build that omits the count still pages correctly from what it returned.
  const total = readNumber(payload.count) ?? start + jobs.length;
  return Object.freeze({ jobs: Object.freeze(jobs), total, start, limit });
}

export async function readPrintHistoryTotals(
  transport: PrinterHistoryTransport,
  signal?: AbortSignal,
): Promise<PrintHistoryTotals> {
  let payload: unknown;
  try {
    payload = await transport.request<unknown>('/server/history/totals', {
      operation: 'print_history_totals',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw historyFailure(error, 'The printer did not report its print totals', signal);
  }
  const totals = isRecord(payload) && isRecord(payload.job_totals) ? payload.job_totals : undefined;
  if (!totals) throw new PrintHistoryError("The printer's print totals were not readable.", 'unavailable');
  return Object.freeze({
    ...optional('jobs', readNumber(totals.total_jobs)),
    ...optional('totalSeconds', readNumber(totals.total_time)),
    ...optional('printSeconds', readNumber(totals.total_print_time)),
    ...optional('filamentUsedMm', readNumber(totals.total_filament_used)),
    ...optional('longestJobSeconds', readNumber(totals.longest_job)),
    ...optional('longestPrintSeconds', readNumber(totals.longest_print)),
  });
}

function readJob(entry: unknown): PrintHistoryJob | undefined {
  if (!isRecord(entry)) return undefined;
  const filename = readString(entry.filename);
  if (!filename) return undefined;
  const rawStatus = readString(entry.status) ?? '';
  const status = KNOWN_STATUSES.has(rawStatus) ? (rawStatus as PrintHistoryStatus) : 'interrupted';
  const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
  return Object.freeze({
    id: readString(entry.job_id) ?? filename,
    filename,
    status,
    // Keep an unrecognised status visible; a future Moonraker outcome should
    // read as itself, not be silently relabelled.
    ...(KNOWN_STATUSES.has(rawStatus) ? {} : rawStatus ? { rawStatus } : {}),
    ...optional('startedAtMs', secondsToMs(readNumber(entry.start_time))),
    ...optional('endedAtMs', secondsToMs(readNumber(entry.end_time))),
    ...optional('printSeconds', readNumber(entry.print_duration)),
    ...optional('totalSeconds', readNumber(entry.total_duration)),
    ...optional('filamentUsedMm', readNumber(entry.filament_used)),
    ...optional('estimatedSeconds', readNumber(metadata?.estimated_time)),
    fileExists: entry.exists !== false,
  });
}

/** `2 h 14 min`; an unreported duration stays undefined, never "0 s". */
export function formatHistoryDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

/** Metres for anything past a metre; a printer's history is rarely shorter. */
export function formatFilamentLength(millimetres: number | undefined): string | undefined {
  if (millimetres === undefined || !Number.isFinite(millimetres) || millimetres < 0) return undefined;
  return millimetres >= 1000 ? `${(millimetres / 1000).toFixed(2)} m` : `${Math.round(millimetres)} mm`;
}

/**
 * How the actual print compared with the slicer's estimate, as a signed
 * percentage. Undefined unless both numbers exist and the estimate is positive,
 * because a ratio against a missing or zero estimate says nothing.
 */
export function estimateDelta(job: PrintHistoryJob): number | undefined {
  const actual = job.printSeconds;
  const estimated = job.estimatedSeconds;
  if (actual === undefined || estimated === undefined || estimated <= 0) return undefined;
  return ((actual - estimated) / estimated) * 100;
}

export function describeHistoryStatus(job: PrintHistoryJob): string {
  switch (job.status) {
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Failed';
    case 'klippy_shutdown':
      return 'Stopped by a Klipper shutdown';
    case 'klippy_disconnect':
      return 'Stopped when Klipper disconnected';
    case 'in_progress':
      return 'Still running';
    default:
      return job.rawStatus ? `Interrupted (${job.rawStatus})` : 'Interrupted';
  }
}

/** Page bounds for a control that offers previous/next. */
export function historyPageBounds(page: PrintHistoryPage): {
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousStart: number;
  readonly nextStart: number;
} {
  const pageIndex = Math.floor(page.start / page.limit);
  const pageCount = Math.max(1, Math.ceil(page.total / page.limit));
  return {
    pageIndex,
    pageCount,
    hasPrevious: page.start > 0,
    hasNext: page.start + page.jobs.length < page.total,
    previousStart: Math.max(0, page.start - page.limit),
    nextStart: page.start + page.limit,
  };
}

function historyFailure(error: unknown, prefix: string, signal?: AbortSignal): PrintHistoryError {
  if (error instanceof PrintHistoryError) return error;
  if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
    return new PrintHistoryError(`${prefix}: cancelled.`, 'cancelled');
  }
  const detail = error instanceof MoonrakerTransportError ? error.code : 'request failed';
  return new PrintHistoryError(`${prefix} (${detail}).`, 'unavailable');
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined || seconds <= 0 ? undefined : Math.round(seconds * 1000);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
