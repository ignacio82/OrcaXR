import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  PrintSubmissionError,
  queryPrintReadiness,
  sanitizeGcodeFilename,
  submitPrintJob,
  type PrintSubmissionTransport,
} from '../PrintJobSubmission';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

interface FakeOptions {
  klippy?: string;
  printState?: string;
  files?: readonly string[];
  storedSize?: number | null;
  failUpload?: MoonrakerTransportError;
  failStart?: MoonrakerTransportError;
  failQuery?: boolean;
}

function fakeTransport(options: FakeOptions = {}) {
  const calls: string[] = [];
  const uploads: { filename: string; size: number }[] = [];
  const transport: PrintSubmissionTransport = {
    async request<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.startsWith('/printer/objects/query')) {
        if (options.failQuery) throw new MoonrakerTransportError('network', 'print_readiness');
        return {
          status: {
            webhooks: { state: options.klippy ?? 'ready' },
            print_stats: { state: options.printState ?? 'standby', filename: '' },
          },
        } as T;
      }
      if (path.startsWith('/server/files/list')) {
        return (options.files ?? []).map((name) => ({ path: name })) as T;
      }
      if (path.startsWith('/server/files/metadata')) {
        if (options.storedSize === null) return {} as T;
        return { size: options.storedSize ?? uploads.at(-1)?.size ?? 0 } as T;
      }
      if (path.startsWith('/printer/print/start')) {
        if (options.failStart) throw options.failStart;
        return {} as T;
      }
      throw new Error(`unexpected request ${path}`);
    },
    async upload<T>(path: string, body: FormData): Promise<T> {
      calls.push(path);
      if (options.failUpload) throw options.failUpload;
      const file = body.get('file') as File;
      uploads.push({ filename: file.name, size: file.size });
      return { item: { path: file.name, root: 'gcodes' } } as T;
    },
  };
  return { transport, calls, uploads };
}

await test('sanitizes a filename into something Klipper accepts', async () => {
  assert.equal(sanitizeGcodeFilename('Peggy Palette (v2).3mf'), 'Peggy_Palette_v2_.gcode');
  assert.equal(sanitizeGcodeFilename('/plates/plate 1.gcode'), 'plate_1.gcode');
  assert.equal(sanitizeGcodeFilename('   '), 'orcaxr_print.gcode');
});

await test('reports exactly why a printer cannot accept a job', async () => {
  const busy = await queryPrintReadiness(fakeTransport({ printState: 'printing' }).transport);
  assert.equal(busy.ready, false);
  assert.deepEqual(
    busy.blockers.map((blocker) => blocker.code),
    ['printer-busy'],
  );
  const shutdown = await queryPrintReadiness(fakeTransport({ klippy: 'shutdown' }).transport);
  assert.deepEqual(
    shutdown.blockers.map((blocker) => blocker.code),
    ['klippy-not-ready'],
  );
  const unreachable = await queryPrintReadiness(fakeTransport({ failQuery: true }).transport);
  assert.deepEqual(
    unreachable.blockers.map((blocker) => blocker.code),
    ['state-unavailable'],
    'an unreadable state blocks instead of assuming readiness',
  );
});

await test('uploads without starting a print by default and verifies the stored size', async () => {
  const { transport, uploads, calls } = fakeTransport();
  const phases: string[] = [];
  const result = await submitPrintJob(transport, {
    filename: 'plate.gcode',
    gcode: 'G28\nG1 X10\n',
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(result.startedPrint, false, 'uploading never starts a print implicitly');
  assert.equal(result.uploadedBytes, result.verifiedBytes);
  assert.equal(uploads[0].filename, 'plate.gcode');
  assert.deepEqual(phases, ['checking', 'uploading', 'verifying', 'done']);
  assert.ok(!calls.some((call) => call.startsWith('/printer/print/start')));
});

await test('never overwrites an existing name unless asked', async () => {
  const existing = fakeTransport({ files: ['plate.gcode', 'plate_2.gcode'] });
  const renamed = await submitPrintJob(existing.transport, { filename: 'plate.gcode', gcode: 'G28\n' });
  assert.equal(renamed.path, 'plate_3.gcode');
  assert.equal(renamed.renamedFrom, 'plate.gcode');

  const overwriting = fakeTransport({ files: ['plate.gcode'] });
  const replaced = await submitPrintJob(overwriting.transport, {
    filename: 'plate.gcode',
    gcode: 'G28\n',
    overwrite: true,
  });
  assert.equal(replaced.path, 'plate.gcode');
  assert.equal(replaced.renamedFrom, undefined);
});

await test('starts the print only when explicitly requested', async () => {
  const { transport, calls } = fakeTransport();
  const result = await submitPrintJob(transport, { filename: 'plate.gcode', gcode: 'G28\n', startPrint: true });
  assert.equal(result.startedPrint, true);
  assert.ok(calls.some((call) => call.startsWith('/printer/print/start?filename=plate.gcode')));
});

await test('refuses to start a print when the printer is not ready', async () => {
  const { transport, calls } = fakeTransport({ printState: 'printing' });
  await assert.rejects(
    () => submitPrintJob(transport, { filename: 'plate.gcode', gcode: 'G28\n', startPrint: true }),
    (error: unknown) =>
      error instanceof PrintSubmissionError &&
      error.code === 'not-ready' &&
      error.blockers.some((blocker) => blocker.code === 'printer-busy'),
  );
  assert.ok(!calls.includes('/server/files/upload'), 'a blocked start never uploads');
});

await test('still stores a file while the printer is busy when no print is started', async () => {
  const { transport, calls } = fakeTransport({ printState: 'printing' });
  const result = await submitPrintJob(transport, { filename: 'next.gcode', gcode: 'G28\n' });
  assert.equal(result.startedPrint, false);
  assert.ok(calls.includes('/server/files/upload'), 'queueing the next plate is not blocked by a running print');
});

await test('never starts a print when the stored size does not match', async () => {
  const { transport, calls } = fakeTransport({ storedSize: 3 });
  await assert.rejects(
    () => submitPrintJob(transport, { filename: 'plate.gcode', gcode: 'G28\nG1 X10\n', startPrint: true }),
    (error: unknown) => error instanceof PrintSubmissionError && error.code === 'verification-failed',
  );
  assert.ok(!calls.some((call) => call.startsWith('/printer/print/start')));

  const unverifiable = fakeTransport({ storedSize: null });
  await assert.rejects(
    () => submitPrintJob(unverifiable.transport, { filename: 'plate.gcode', gcode: 'G28\n', startPrint: true }),
    (error: unknown) => error instanceof PrintSubmissionError && error.code === 'verification-failed',
  );
});

await test('surfaces upload and start failures without claiming success', async () => {
  const failedUpload = fakeTransport({ failUpload: new MoonrakerTransportError('network', 'upload_gcode') });
  await assert.rejects(
    () => submitPrintJob(failedUpload.transport, { filename: 'plate.gcode', gcode: 'G28\n' }),
    (error: unknown) => error instanceof PrintSubmissionError && error.code === 'upload-failed',
  );

  const failedStart = fakeTransport({ failStart: new MoonrakerTransportError('protocol_error', 'start_print') });
  await assert.rejects(
    () => submitPrintJob(failedStart.transport, { filename: 'plate.gcode', gcode: 'G28\n', startPrint: true }),
    (error: unknown) =>
      error instanceof PrintSubmissionError &&
      error.code === 'start-failed' &&
      /uploaded, but starting/.test(error.message),
  );
});

await test('rejects an empty artifact and honours cancellation', async () => {
  const { transport, calls } = fakeTransport();
  await assert.rejects(
    () => submitPrintJob(transport, { filename: 'plate.gcode', gcode: '' }),
    (error: unknown) => error instanceof PrintSubmissionError && error.code === 'empty-artifact',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => submitPrintJob(transport, { filename: 'plate.gcode', gcode: 'G28\n', signal: controller.signal }),
    (error: unknown) => error instanceof PrintSubmissionError && error.code === 'cancelled',
  );
  assert.ok(!calls.includes('/server/files/upload'));
});

console.log(`\nPrint job submission: ${passed} tests passed.`);
