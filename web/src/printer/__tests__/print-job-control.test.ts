import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  PrintJobCommandError,
  executePrintJobCommand,
  printJobCommandAvailability,
  type PrintJobCommand,
} from '../PrintJobControl';
import { projectPrintJobSnapshot, type PrintJobSnapshot } from '../PrintJobStatus';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function snapshot(state: string, extra: Record<string, unknown> = {}, klippy = 'ready'): PrintJobSnapshot {
  return projectPrintJobSnapshot({ webhooks: { state: klippy }, print_stats: { state, ...extra } }, 0);
}

class RecordingTransport {
  readonly paths: string[] = [];
  constructor(private readonly failure?: MoonrakerTransportError) {}
  async request<T>(path: string): Promise<T> {
    this.paths.push(path);
    if (this.failure) throw this.failure;
    return 'ok' as unknown as T;
  }
}

const allowed = (job: PrintJobSnapshot | null): PrintJobCommand[] =>
  printJobCommandAvailability(job)
    .filter((entry) => entry.allowed)
    .map((entry) => entry.command);

await test('derives availability from the reported state, not from what was last sent', () => {
  assert.deepEqual(allowed(snapshot('printing')), ['pause', 'cancel', 'emergency-stop', 'firmware-restart']);
  assert.deepEqual(allowed(snapshot('paused')), ['resume', 'cancel', 'emergency-stop', 'firmware-restart']);
  assert.deepEqual(allowed(snapshot('standby')), ['emergency-stop', 'firmware-restart']);
  assert.deepEqual(allowed(snapshot('complete')), ['emergency-stop', 'firmware-restart']);
});

await test('keeps the hard stop reachable when nothing else is', () => {
  // An unreadable machine is exactly when an operator needs to halt it.
  assert.deepEqual(allowed(null), ['emergency-stop', 'firmware-restart']);
  assert.deepEqual(allowed(snapshot('printing', {}, 'shutdown')), ['emergency-stop', 'firmware-restart']);
  const halted = printJobCommandAvailability(snapshot('printing', {}, 'shutdown'));
  assert.match(halted.find((entry) => entry.command === 'pause')?.reason ?? '', /shutdown/);
  assert.equal(
    halted.every((entry) => (entry.command === 'pause' || entry.command === 'resume') === !entry.destructive),
    true,
    'only pause and resume are non-destructive',
  );
});

await test('sends exactly one documented endpoint per command', async () => {
  for (const [command, path, state] of [
    ['pause', '/printer/print/pause', 'printing'],
    ['resume', '/printer/print/resume', 'paused'],
    ['cancel', '/printer/print/cancel', 'printing'],
    ['emergency-stop', '/printer/emergency_stop', 'printing'],
    ['firmware-restart', '/printer/firmware_restart', 'standby'],
  ] as const) {
    const transport = new RecordingTransport();
    await executePrintJobCommand(transport, { command, observed: snapshot(state) });
    assert.deepEqual(transport.paths, [path]);
  }
});

await test('refuses a command the reported state does not allow, without any request', async () => {
  const transport = new RecordingTransport();
  await assert.rejects(
    () => executePrintJobCommand(transport, { command: 'resume', observed: snapshot('printing') }),
    (error: unknown) => error instanceof PrintJobCommandError && error.code === 'not-allowed',
  );
  await assert.rejects(
    () => executePrintJobCommand(transport, { command: 'pause', observed: snapshot('standby') }),
    (error: unknown) => error instanceof PrintJobCommandError && error.code === 'not-allowed',
  );
  assert.deepEqual(transport.paths, [], 'a refused command never reaches the printer');
});

await test('refuses to act when the printer moved on to a different file', async () => {
  const transport = new RecordingTransport();
  await assert.rejects(
    () =>
      executePrintJobCommand(transport, {
        command: 'cancel',
        observed: snapshot('printing', { filename: 'someone_elses.gcode' }),
        expectedFilename: 'mine.gcode',
      }),
    (error: unknown) =>
      error instanceof PrintJobCommandError &&
      error.code === 'job-changed' &&
      /someone_elses\.gcode/.test(error.message),
  );
  assert.deepEqual(transport.paths, []);

  await executePrintJobCommand(transport, {
    command: 'cancel',
    observed: snapshot('printing', { filename: 'mine.gcode' }),
    expectedFilename: 'mine.gcode',
  });
  assert.deepEqual(transport.paths, ['/printer/print/cancel']);
});

await test('reports a rejected request and a cancelled one distinctly', async () => {
  const failing = new RecordingTransport(new MoonrakerTransportError('http_error', 'print_pause'));
  await assert.rejects(
    () => executePrintJobCommand(failing, { command: 'pause', observed: snapshot('printing') }),
    (error: unknown) =>
      error instanceof PrintJobCommandError && error.code === 'request-failed' && /http_error/.test(error.message),
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = new RecordingTransport(new MoonrakerTransportError('cancelled', 'print_pause'));
  await assert.rejects(
    () =>
      executePrintJobCommand(aborted, {
        command: 'pause',
        observed: snapshot('printing'),
        signal: controller.signal,
      }),
    (error: unknown) => error instanceof PrintJobCommandError && error.code === 'cancelled',
  );
});

console.log(`\nPrint job control: ${passed} tests passed.`);
