import assert from 'node:assert/strict';
import { PrinterSessionController, type PrinterSessionTransport } from '../PrinterSessionController';
import type { MoonrakerConnectionState, MoonrakerHandshake, MoonrakerNotification } from '../MoonrakerTypes';
import { PRINT_JOB_QUERY_PATH } from '../PrintJobStatus';

const handshake = {} as MoonrakerHandshake;
class FakeTransport implements PrinterSessionTransport {
  state: MoonrakerConnectionState = { status: 'disconnected', generation: 0, reason: 'initial' };
  readonly posts: string[] = [];
  readonly reads: string[] = [];
  readonly states = new Set<(state: MoonrakerConnectionState) => void>();
  readonly notifications = new Set<(notification: MoonrakerNotification) => void>();
  filename = 'part.gcode';
  jobId = '000001';
  startedAt = 1000;
  printState = 'printing';
  failQuery = false;
  partial = false;
  failMetadata = false;
  disposed = false;
  afterRead?: (path: string) => Promise<void>;
  async connect() {
    this.connected();
    return handshake;
  }
  connected() {
    this.transition({
      status: 'connected',
      generation: 1,
      socketEpoch: 1,
      connectedAtMs: 1,
      lastHeartbeatAtMs: 1,
      handshake,
    });
  }
  transition(state: MoonrakerConnectionState) {
    this.state = state;
    for (const listener of this.states) listener(state);
  }
  dispose() {
    this.disposed = true;
  }
  setObjectSubscription() {}
  subscribeState(listener: (state: MoonrakerConnectionState) => void) {
    this.states.add(listener);
    listener(this.state);
    return () => this.states.delete(listener);
  }
  subscribeNotifications(listener: (notification: MoonrakerNotification) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  async requestRecoveryCommand(command: 'emergency-stop' | 'firmware-restart') {
    this.posts.push(command);
  }
  async request<T>(path: string, options?: { method?: string }): Promise<T> {
    if (options?.method === 'POST') {
      this.posts.push(path);
      return 'ok' as T;
    }
    this.reads.push(path);
    let result: unknown;
    if (path === PRINT_JOB_QUERY_PATH) {
      if (this.failQuery) throw new Error('offline');
      result = this.partial
        ? { status: { virtual_sdcard: { progress: 0.4 } } }
        : {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: this.printState, filename: this.filename },
              virtual_sdcard: { is_active: this.printState === 'printing' },
            },
          };
    } else if (path.startsWith('/server/files/metadata?')) {
      if (this.failMetadata) throw new Error('metadata unavailable');
      result = {
        filename: this.filename,
        job_id: this.jobId,
        print_start_time: this.startedAt,
        size: 100,
        modified: 900,
      };
    } else if (path.startsWith('/server/history/job?')) {
      result = {
        job: {
          job_id: this.jobId,
          filename: this.filename,
          start_time: this.startedAt,
          status: 'in_progress',
          end_time: null,
          exists: true,
        },
      };
    } else throw new Error(`Unexpected request: ${path}`);
    await this.afterRead?.(path);
    return result as T;
  }
}
const selection = { id: 'printer-a', endpoint: 'http://printer-a', port: 7125 };
async function fixture() {
  const transport = new FakeTransport();
  const controller = new PrinterSessionController(() => transport);
  controller.select(selection);
  await controller.connect();
  await controller.refresh();
  return { controller, transport };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('captures an immutable history identity and sends once after confirmation', async () => {
  const { controller, transport } = await fixture();
  const intent = controller.captureIntent('cancel');
  assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.job));
  assert.equal(intent.job?.jobId, '000001');
  const confirmation = controller.confirm(intent);
  await controller.execute(intent, confirmation);
  await assert.rejects(controller.execute(intent, confirmation));
  assert.deepEqual(transport.posts, ['/printer/print/cancel']);
  controller.dispose();
});

for (const change of [
  'filename',
  'job-id',
  'start-time',
  'state',
  'partial-query',
  'failed-query',
  'failed-metadata',
] as const) {
  await test(`confirmation rejects ${change} changes without a POST`, async () => {
    const { controller, transport } = await fixture();
    const intent = controller.captureIntent('pause');
    if (change === 'filename') transport.filename = 'other.gcode';
    if (change === 'job-id') transport.jobId = '000002';
    if (change === 'start-time') transport.startedAt++;
    if (change === 'state') transport.printState = 'paused';
    if (change === 'partial-query') transport.partial = true;
    if (change === 'failed-query') transport.failQuery = true;
    if (change === 'failed-metadata') transport.failMetadata = true;
    await assert.rejects(controller.execute(intent));
    assert.deepEqual(transport.posts, []);
    controller.dispose();
  });
}

await test('a dialog for A cannot cancel a newer run of the same filename', async () => {
  const { controller, transport } = await fixture();
  const intent = controller.captureIntent('cancel');
  await assert.rejects(
    controller.execute(intent, async (original) => {
      assert.equal(original, intent);
      transport.jobId = '000002';
      transport.startedAt++;
      return true;
    }),
  );
  assert.deepEqual(transport.posts, []);
  controller.dispose();
});

await test('a rejected job identity stays unavailable until the replacement refresh finishes', async () => {
  const { controller, transport } = await fixture();
  const intent = controller.captureIntent('cancel');
  transport.jobId = '000002';
  transport.startedAt++;
  let queries = 0;
  let release!: () => void;
  transport.afterRead = async (path) => {
    if (path === PRINT_JOB_QUERY_PATH && ++queries === 3) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  };
  await assert.rejects(controller.execute(intent, controller.confirm(intent)), /running job changed/);
  assert.deepEqual(transport.posts, []);
  assert.deepEqual(
    controller
      .availability()
      .filter((action) => action.allowed)
      .map((action) => action.command),
    ['emergency-stop', 'firmware-restart'],
    'releasing the command lock must not republish the rejected identity',
  );
  assert.throws(() => controller.captureIntent('cancel'));
  release();
  await controller.refresh();
  const replacement = controller.captureIntent('cancel');
  assert.equal(replacement.job?.jobId, '000002');
  await controller.execute(replacement, controller.confirm(replacement));
  assert.deepEqual(transport.posts, ['/printer/print/cancel']);
  controller.dispose();
});

await test('printer changes and reconnects invalidate captured holds', async () => {
  for (const change of ['printer', 'reconnect', 'dispose']) {
    const { controller, transport } = await fixture();
    const intent = controller.captureIntent('cancel');
    const confirmation = controller.confirm(intent);
    if (change === 'printer') controller.select({ ...selection, id: 'printer-b' });
    else if (change === 'dispose') controller.dispose();
    else {
      transport.transition({ status: 'disconnected', generation: 1, reason: 'user' });
      transport.connected();
      await controller.refresh();
    }
    await assert.rejects(controller.execute(intent, confirmation));
    assert.deepEqual(transport.posts, []);
    controller.dispose();
  }
});

await test('rejects a boolean, a forged token, and another intent confirmation', async () => {
  const { controller, transport } = await fixture();
  const other = controller.captureIntent('cancel');
  for (const token of [true, { intent: other }, controller.confirm(other)]) {
    const intent = controller.captureIntent('cancel');
    await assert.rejects(controller.execute(intent, token as never));
  }
  assert.deepEqual(transport.posts, []);
  controller.dispose();
});

await test('serializes commands across an open dialog and keeps emergency stop reachable', async () => {
  const { controller, transport } = await fixture();
  const cancel = controller.captureIntent('cancel');
  const pause = controller.captureIntent('pause');
  let answer!: (confirmed: boolean) => void;
  const pending = controller.execute(
    cancel,
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  await assert.rejects(controller.execute(pause), /pending/);
  assert.throws(() => controller.captureIntent('pause'), /pending/);
  const emergency = controller.captureIntent('emergency-stop');
  await controller.execute(emergency, controller.confirm(emergency));
  answer(false);
  await assert.rejects(pending, /dismissed/);
  assert.deepEqual(transport.posts, ['emergency-stop']);
  controller.dispose();
});

await test('recovery needs the exact confirmation but no connection, readiness, or history query', async () => {
  const transport = new FakeTransport();
  transport.failQuery = true;
  const controller = new PrinterSessionController(() => transport);
  controller.select(selection);
  for (const command of ['emergency-stop', 'firmware-restart'] as const) {
    const intent = controller.captureIntent(command);
    await controller.execute(intent, controller.confirm(intent));
  }
  assert.deepEqual(transport.reads, []);
  assert.deepEqual(transport.posts, ['emergency-stop', 'firmware-restart']);
  controller.dispose();
});

await test('late queries from a cleared printer cannot republish or dispatch', async () => {
  const { controller, transport } = await fixture();
  let release!: () => void;
  transport.afterRead = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = controller.refresh();
  controller.clear();
  release();
  await assert.rejects(pending);
  assert.equal(controller.snapshot, null);
  assert.equal(transport.states.size, 0);
  assert.equal(transport.notifications.size, 0);
  assert.equal(transport.disposed, true);
});

await test('a replacement during metadata/history reads cannot authorize a command', async () => {
  const { controller, transport } = await fixture();
  const intent = controller.captureIntent('cancel');
  transport.afterRead = async (path) => {
    if (path.startsWith('/server/history/job')) {
      transport.jobId = '000002';
      transport.startedAt++;
    }
  };
  await assert.rejects(controller.execute(intent, controller.confirm(intent)));
  assert.deepEqual(transport.posts, []);
  controller.dispose();
});
await test('switching printers aborts an open confirmation without blocking the new session', async () => {
  const { controller, transport } = await fixture();
  const intent = controller.captureIntent('cancel');
  let answer!: (value: boolean) => void;
  const pending = controller.execute(
    intent,
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  controller.select({ ...selection, id: 'printer-b' });
  await assert.rejects(pending, /session changed/);
  await controller.connect();
  await controller.refresh();
  const fresh = controller.captureIntent('pause');
  answer(true);
  await controller.execute(fresh);
  assert.deepEqual(transport.posts, ['/printer/print/pause']);
  controller.dispose();
});

await test('failed identity refresh disables ordinary controls but retains the reported status', async () => {
  const { controller, transport } = await fixture();
  transport.failMetadata = true;
  await assert.rejects(controller.refresh());
  assert.equal(controller.snapshot?.state, 'printing');
  const actions = controller.availability();
  assert.deepEqual(
    actions.filter((action) => action.allowed).map((action) => action.command),
    ['emergency-stop', 'firmware-restart'],
  );
  assert.match(actions.find((action) => action.command === 'pause')?.reason ?? '', /Enable Moonraker history/);
  controller.dispose();
});

await test('a superseded slow refresh cannot erase the newer printer reading', async () => {
  const { controller, transport } = await fixture();
  let release!: () => void;
  let first = true;
  transport.afterRead = async (path) => {
    if (first && path === PRINT_JOB_QUERY_PATH) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  };
  const old = controller.refresh();
  transport.filename = 'new.gcode';
  transport.jobId = '000002';
  transport.startedAt++;
  await controller.refresh();
  release();
  await assert.rejects(old);
  assert.equal(controller.snapshot?.filename, 'new.gcode');
  assert.equal(controller.captureIntent('pause').job?.jobId, '000002');
  controller.dispose();
});

console.log(`\nPrinter session controller: ${passed} tests passed.`);
