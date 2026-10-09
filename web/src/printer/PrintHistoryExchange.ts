/**
 * Print history over the hosts' shared contract (`PrinterHistory.ts`): the
 * request each operation sends or why it is refused, the result an exchange
 * that ended without a reply reads as, a reply read, and how a panel
 * describes a job, the totals and a page. Every answer comes from the
 * production functions over a scripted transport; the Rust core answers the
 * same requests (`orcaxr_printer::history`).
 */
import type {
  ProjectOptionalPrintHistoryTotalsWire,
  ProjectOptionalTextWire,
  ProjectPrintHistoryFailureWire,
  ProjectPrintHistoryFinishWire,
  ProjectPrintHistoryJobViewWire,
  ProjectPrintHistoryJobWire,
  ProjectPrintHistoryOperationWire,
  ProjectPrintHistoryPageShapeWire,
  ProjectPrintHistoryPageViewWire,
  ProjectPrintHistoryPlanWire,
  ProjectPrintHistoryResultWire,
  ProjectPrintHistoryTotalsWire,
  ProjectPrinterTextWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  PrintHistoryError,
  describeHistoryPage,
  describeHistoryStatus,
  describeHistoryTotals,
  describeJobFacts,
  estimateDelta,
  formatFilamentLength,
  formatHistoryDuration,
  historyPageBounds,
  listPrintHistory,
  readPrintHistoryTotals,
  type PrintHistoryJob,
  type PrintHistoryPage,
  type PrintHistoryStatus,
  type PrintHistoryTotals,
  type PrinterHistoryTransport,
} from './PrinterHistory';
import { fromUnits, optionalTextWire, units } from './PrinterWire';

const absent = { absent: {} } as const;
const finite = (value: number | undefined) => (value === undefined ? absent : { value });
const known = (value: { readonly value: number } | { readonly absent: object }) =>
  'value' in value ? value.value : undefined;
const camel = (code: string): string => code.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (code: string): string => code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function failureWire(error: PrintHistoryError): ProjectPrintHistoryFailureWire {
  return { code: camel(error.code) as ProjectPrintHistoryFailureWire['code'], message: units(error.message) };
}

function run(
  operation: ProjectPrintHistoryOperationWire,
  transport: PrinterHistoryTransport,
  signal?: AbortSignal,
): Promise<PrintHistoryPage | PrintHistoryTotals> {
  if ('totals' in operation) return readPrintHistoryTotals(transport, signal);
  const start = known(operation.page.start);
  const limit = known(operation.page.limit);
  return listPrintHistory(transport, {
    ...(start === undefined ? {} : { start }),
    ...(limit === undefined ? {} : { limit }),
    ...(signal ? { signal } : {}),
  });
}

function resultWire(operation: ProjectPrintHistoryOperationWire, value: unknown): ProjectPrintHistoryResultWire {
  if ('totals' in operation) return { totals: totalsWire(value as PrintHistoryTotals) };
  const page = value as PrintHistoryPage;
  return { page: { jobs: page.jobs.map(jobWire), total: page.total, start: page.start, limit: page.limit } };
}

/** What [operation] sends, or why it is refused before anything leaves. */
export async function answerHistoryPlan(
  operation: ProjectPrintHistoryOperationWire,
): Promise<ProjectPrintHistoryPlanWire> {
  let sent: ProjectPrintHistoryPlanWire | undefined;
  const transport: PrinterHistoryTransport = {
    request: async (path, options) => {
      sent = {
        request: {
          path: units(path),
          method: units(options?.method ?? 'GET'),
          operation: units(options?.operation ?? ''),
          timeoutMs: absent,
        },
      };
      throw new Error('sent');
    },
  };
  try {
    await run(operation, transport);
  } catch (error) {
    if (sent) return sent;
    if (error instanceof PrintHistoryError) return { refused: failureWire(error) };
    throw error;
  }
  throw new Error('The operation sent nothing');
}

/** The result an operation reads as once its exchange ended without a reply to read. */
export async function answerHistoryFinish(
  request: ProjectPrintHistoryFinishWire,
): Promise<ProjectPrintHistoryResultWire> {
  const { operation, outcome } = request;
  const abort = new AbortController();
  const transport: PrinterHistoryTransport = {
    request: async () => {
      if ('done' in outcome) return undefined as never;
      if ('cancelled' in outcome) {
        abort.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const failure = outcome.failed;
      if (!('value' in failure.code)) throw new Error('request failed');
      throw new MoonrakerTransportError(snake(failure.code.value) as MoonrakerErrorCode, 'history', {
        ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
        ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
      });
    },
  };
  try {
    return resultWire(operation, await run(operation, transport, abort.signal));
  } catch (error) {
    if (error instanceof PrintHistoryError) return { failed: failureWire(error) };
    throw error;
  }
}

/** A reply (Moonraker's `result`, as JSON) read as the shell reads it. */
export async function answerHistoryRead(
  operation: ProjectPrintHistoryOperationWire,
  reply: string,
): Promise<ProjectPrintHistoryResultWire> {
  const transport: PrinterHistoryTransport = { request: async () => JSON.parse(reply) };
  try {
    return resultWire(operation, await run(operation, transport));
  } catch (error) {
    if (error instanceof PrintHistoryError) return { failed: failureWire(error) };
    throw error;
  }
}

export function answerHistoryDuration(seconds: number): ProjectOptionalTextWire {
  return optionalTextWire(formatHistoryDuration(seconds));
}

export function answerHistoryFilament(millimetres: number): ProjectOptionalTextWire {
  return optionalTextWire(formatFilamentLength(millimetres));
}

export function answerHistoryJobView(job: ProjectPrintHistoryJobWire): ProjectPrintHistoryJobViewWire {
  const read = jobFromWire(job);
  return {
    status: units(describeHistoryStatus(read)),
    facts: units(describeJobFacts(read)),
    estimateDelta: finite(estimateDelta(read)),
  };
}

export function answerHistoryTotalsText(totals: ProjectOptionalPrintHistoryTotalsWire): ProjectPrinterTextWire {
  return { text: units(describeHistoryTotals('value' in totals ? totalsFromWire(totals.value) : undefined)) };
}

export function answerHistoryPageView(shape: ProjectPrintHistoryPageShapeWire): ProjectPrintHistoryPageViewWire {
  const page: PrintHistoryPage = {
    jobs: new Array(shape.jobCount).fill(null) as never[],
    total: shape.total,
    start: shape.start,
    limit: shape.limit,
  };
  return { ...historyPageBounds(page), label: units(describeHistoryPage(page)) };
}

/** A job carries the printer's id only where it is not the filename the id falls back to. */
export function jobWire(job: PrintHistoryJob): ProjectPrintHistoryJobWire {
  return {
    jobId: job.id === job.filename ? absent : { value: units(job.id) },
    filename: units(job.filename),
    status: camel(job.status) as ProjectPrintHistoryJobWire['status'],
    rawStatus: job.rawStatus === undefined ? absent : { value: units(job.rawStatus) },
    startedAtMs: finite(job.startedAtMs),
    endedAtMs: finite(job.endedAtMs),
    printSeconds: finite(job.printSeconds),
    totalSeconds: finite(job.totalSeconds),
    filamentUsedMm: finite(job.filamentUsedMm),
    fileExists: job.fileExists,
    estimatedSeconds: finite(job.estimatedSeconds),
  };
}

function jobFromWire(job: ProjectPrintHistoryJobWire): PrintHistoryJob {
  const filename = fromUnits(job.filename);
  const optional = <K extends string>(key: K, value: number | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, number>);
  return {
    id: 'value' in job.jobId ? fromUnits(job.jobId.value) : filename,
    filename,
    status: snake(job.status) as PrintHistoryStatus,
    ...('value' in job.rawStatus ? { rawStatus: fromUnits(job.rawStatus.value) } : {}),
    ...optional('startedAtMs', known(job.startedAtMs)),
    ...optional('endedAtMs', known(job.endedAtMs)),
    ...optional('printSeconds', known(job.printSeconds)),
    ...optional('totalSeconds', known(job.totalSeconds)),
    ...optional('filamentUsedMm', known(job.filamentUsedMm)),
    fileExists: job.fileExists,
    ...optional('estimatedSeconds', known(job.estimatedSeconds)),
  };
}

function totalsWire(totals: PrintHistoryTotals): ProjectPrintHistoryTotalsWire {
  return {
    jobs: finite(totals.jobs),
    totalSeconds: finite(totals.totalSeconds),
    printSeconds: finite(totals.printSeconds),
    filamentUsedMm: finite(totals.filamentUsedMm),
    longestJobSeconds: finite(totals.longestJobSeconds),
    longestPrintSeconds: finite(totals.longestPrintSeconds),
  };
}

function totalsFromWire(totals: ProjectPrintHistoryTotalsWire): PrintHistoryTotals {
  const entries = Object.entries(totals).flatMap(([key, value]) => {
    const number = known(value as ProjectPrintHistoryTotalsWire['jobs']);
    return number === undefined ? [] : [[key, number] as const];
  });
  return Object.fromEntries(entries) as PrintHistoryTotals;
}
