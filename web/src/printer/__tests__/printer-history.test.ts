/**
 * Print history and statistics (P9.6).
 *
 * The cases worth pinning are the ones where a plausible reading is wrong: a
 * job the printer never finished has no duration and no filament total rather
 * than zeroes, an unrecognised outcome stays visible instead of being relabelled,
 * and paging is driven by the count the printer reports rather than by how many
 * rows happened to come back.
 */
import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  MAX_HISTORY_PAGE,
  PrintHistoryError,
  describeHistoryStatus,
  estimateDelta,
  formatFilamentLength,
  formatHistoryDuration,
  historyPageBounds,
  listPrintHistory,
  readPrintHistoryTotals,
} from '../PrinterHistory';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeTransport {
  readonly calls: string[] = [];
  constructor(
    private readonly reply: unknown = {},
    private readonly failure?: Error,
  ) {}
  async request<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (this.failure) throw this.failure;
    return this.reply as T;
  }
}

const JOBS = {
  count: 57,
  jobs: [
    {
      job_id: '000001',
      filename: 'projects/tower.gcode',
      status: 'completed',
      start_time: 1_800_000_000,
      end_time: 1_800_005_400,
      print_duration: 5100,
      total_duration: 5400,
      filament_used: 4210.5,
      exists: true,
      metadata: { estimated_time: 4800 },
    },
    {
      job_id: '000002',
      filename: 'cube.gcode',
      status: 'in_progress',
      start_time: 1_800_010_000,
      end_time: 0,
      exists: false,
    },
    { job_id: '000003', filename: 'odd.gcode', status: 'server_exit', start_time: 1_700_000_000 },
    { job_id: '000004', status: 'completed' },
  ],
};

await test('reads a page of jobs with the printer’s own count', async () => {
  const transport = new FakeTransport(JOBS);
  const page = await listPrintHistory(transport, { start: 20, limit: 10 });
  assert.equal(transport.calls[0], '/server/history/list?limit=10&start=20&order=desc');
  assert.equal(page.total, 57);
  assert.equal(page.start, 20);
  // The nameless record is dropped: a job with no filename identifies nothing.
  assert.deepEqual(
    page.jobs.map((job) => job.id),
    ['000001', '000002', '000003'],
  );

  const finished = page.jobs[0];
  assert.equal(finished.status, 'completed');
  assert.equal(finished.printSeconds, 5100);
  assert.equal(finished.filamentUsedMm, 4210.5);
  assert.equal(finished.startedAtMs, 1_800_000_000_000);
  assert.equal(finished.fileExists, true);
});

await test('an unfinished job reports nothing rather than zeroes', async () => {
  const page = await listPrintHistory(new FakeTransport(JOBS));
  const running = page.jobs.find((job) => job.id === '000002')!;
  assert.equal(running.status, 'in_progress');
  assert.equal(running.endedAtMs, undefined, 'end_time 0 means "not ended", not 1970');
  assert.equal(running.printSeconds, undefined);
  assert.equal(running.filamentUsedMm, undefined);
  // The file was deleted from the printer after the run; that is worth knowing
  // before offering to reprint it.
  assert.equal(running.fileExists, false);
});

await test('an outcome this build does not know stays visible', async () => {
  const page = await listPrintHistory(new FakeTransport(JOBS));
  const odd = page.jobs.find((job) => job.id === '000003')!;
  assert.equal(odd.status, 'interrupted');
  assert.equal(odd.rawStatus, 'server_exit');
  assert.equal(describeHistoryStatus(odd), 'Interrupted (server_exit)');
  assert.equal(describeHistoryStatus(page.jobs[0]), 'Completed');
});

await test('refuses a page the printer should never be asked for', async () => {
  const transport = new FakeTransport(JOBS);
  for (const request of [{ limit: 0 }, { limit: MAX_HISTORY_PAGE + 1 }, { limit: 1.5 }, { start: -1 }]) {
    await assert.rejects(
      () => listPrintHistory(transport, request),
      (error: unknown) => error instanceof PrintHistoryError && error.code === 'invalid-page',
    );
  }
  assert.equal(transport.calls.length, 0, 'a refused page never reaches the printer');
});

await test('reports a printer that keeps no history instead of showing an empty one', async () => {
  await assert.rejects(
    () => listPrintHistory(new FakeTransport(['not', 'a', 'record'])),
    (error: unknown) => error instanceof PrintHistoryError && error.code === 'unavailable',
  );
  await assert.rejects(
    () => readPrintHistoryTotals(new FakeTransport({})),
    (error: unknown) => error instanceof PrintHistoryError && error.code === 'unavailable',
  );
  await assert.rejects(
    () => readPrintHistoryTotals(new FakeTransport({}, new MoonrakerTransportError('http_error', 'totals'))),
    (error: unknown) => error instanceof PrintHistoryError && error.code === 'unavailable',
  );
});

await test('totals carry only what the printer reported', async () => {
  const totals = await readPrintHistoryTotals(
    new FakeTransport({
      job_totals: { total_jobs: 57, total_time: 720_000, total_print_time: 690_000, longest_print: 32_400 },
    }),
  );
  assert.deepEqual(totals, {
    jobs: 57,
    totalSeconds: 720_000,
    printSeconds: 690_000,
    longestPrintSeconds: 32_400,
  });
});

await test('paging is driven by the reported total, not by the rows that came back', () => {
  const bounds = historyPageBounds({ jobs: new Array(20).fill(null) as never[], total: 57, start: 20, limit: 20 });
  assert.deepEqual(bounds, {
    pageIndex: 1,
    pageCount: 3,
    hasPrevious: true,
    hasNext: true,
    previousStart: 0,
    nextStart: 40,
  });
  const last = historyPageBounds({ jobs: new Array(17).fill(null) as never[], total: 57, start: 40, limit: 20 });
  assert.equal(last.hasNext, false);
  const only = historyPageBounds({ jobs: [], total: 0, start: 0, limit: 20 });
  assert.deepEqual([only.pageCount, only.hasPrevious, only.hasNext], [1, false, false]);
});

await test('formats durations, lengths, and the gap against the estimate', () => {
  assert.equal(formatHistoryDuration(5400), '1 h 30 min');
  assert.equal(formatHistoryDuration(90), '1 min');
  assert.equal(formatHistoryDuration(9), '9 s');
  assert.equal(formatHistoryDuration(undefined), undefined);
  assert.equal(formatFilamentLength(4210.5), '4.21 m');
  assert.equal(formatFilamentLength(420), '420 mm');
  assert.equal(formatFilamentLength(undefined), undefined);

  const job = { printSeconds: 5100, estimatedSeconds: 4800 } as never;
  assert.equal(Math.round(estimateDelta(job)!), 6);
  // No estimate, or a zero one, is not a 100 % overrun — it is no answer.
  assert.equal(estimateDelta({ printSeconds: 5100 } as never), undefined);
  assert.equal(estimateDelta({ printSeconds: 5100, estimatedSeconds: 0 } as never), undefined);
});

console.log(`\nPrint history: ${passed} tests passed.`);
