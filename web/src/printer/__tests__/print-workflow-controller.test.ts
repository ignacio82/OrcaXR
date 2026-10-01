import assert from 'node:assert/strict';
import {
  PrintWorkflowController,
  type PrintWorkflowConfirmation,
  type PrintWorkflowDecision,
} from '../PrintWorkflowController';
import {
  PrintSubmissionError,
  preparePrintUpload,
  submitPrintJob,
  type PrintJobIntent,
  type PrintSubmissionTransport,
} from '../PrintJobSubmission';
import { summarizeGcodeToolUsage } from '../PrintToolMapping';
import { sha256Bytes } from '../../slicer/Utf8Sha256';

const gcode = 'T0\nG1 X10 E1\n; filament_type = PLA\n; filament_colour = #FF0000\n';
class Printer implements PrintSubmissionTransport {
  printState = 'standby';
  filename = '';
  klippy = 'ready';
  material = 'PLA';
  command = 'BED_MESH_CALIBRATE';
  fileManagement = true;
  failListing = false;
  failPreparation = false;
  failStart = false;
  responsePatch: Record<string, unknown> = {};
  readonly files = new Map<string, { size: number; modified: number }>();
  readonly mutations: string[] = [];
  readonly queries: string[] = [];
  onUploaded?: () => void;
  onMutation?: (operation: string) => void;
  async request<T>(path: string, options?: { method?: string; signal?: AbortSignal }): Promise<T> {
    if (options?.signal?.aborted) throw new Error('cancelled');
    const url = new URL(path, 'http://printer');
    if (options?.method === 'POST') {
      const operation =
        url.pathname === '/printer/print/start'
          ? 'start'
          : url.pathname.includes('timelapse')
            ? 'timelapse'
            : 'leveling';
      this.mutations.push(operation);
      this.onMutation?.(operation);
      if (operation === 'start') {
        this.printState = 'printing';
        this.filename = url.searchParams.get('filename')!;
        if (this.failStart) throw new Error('reply lost');
      } else if (this.failPreparation) throw new Error('reply lost');
      return 'ok' as T;
    }
    this.queries.push(path);
    if (url.pathname === '/server/files/list') {
      if (this.failListing) throw new Error('file list unavailable');
      return [...this.files].map(([path, metadata]) => ({ path, ...metadata })) as T;
    }
    if (url.pathname === '/server/files/metadata') {
      const filename = url.searchParams.get('filename')!;
      return { filename, ...this.files.get(filename) } as T;
    }
    if (url.pathname === '/server/info')
      return { components: [...(this.fileManagement ? ['file_manager'] : []), 'timelapse'] } as T;
    if (url.pathname === '/printer/objects/list') return { objects: ['print_stats'] } as T;
    if (url.pathname === '/printer/gcode/help') return { [this.command]: 'Level plate' } as T;
    if (url.searchParams.has('print_task_config'))
      return {
        status: {
          print_task_config: {
            filament_color_rgba: ['FF0000FF'],
            filament_type: [this.material],
            filament_vendor: ['Test'],
            filament_exist: [1],
          },
        },
      } as T;
    if (url.pathname === '/printer/objects/query')
      return {
        status: {
          webhooks: { state: this.klippy },
          print_stats: { state: this.printState, filename: this.filename },
          virtual_sdcard: { is_active: this.printState === 'printing' },
        },
      } as T;
    throw new Error(`Unexpected query ${path}`);
  }
  async upload<T>(_path: string, body: FormData, options?: { signal?: AbortSignal }): Promise<T> {
    if (options?.signal?.aborted) throw new Error('cancelled');
    const file = body.get('file') as File;
    assert.equal(body.get('print'), 'false');
    assert.equal(body.get('checksum'), sha256Bytes(new TextEncoder().encode(await file.text())).slice(7));
    this.mutations.push('upload');
    this.files.set(file.name, { size: file.size, modified: 100 });
    this.onUploaded?.();
    return {
      item: { path: file.name, root: 'gcodes', size: file.size, ...this.responsePatch },
      print_started: false,
      print_queued: false,
    } as T;
  }
}
function setup(choice: 'upload' | 'upload-and-print' = 'upload-and-print') {
  const printer = new Printer();
  const epoch = new AbortController();
  let current = true;
  let confirm: (input: PrintWorkflowConfirmation) => Promise<PrintWorkflowDecision> = async () => ({
    choice,
    overwrite: false,
    startOptions: ['timelapse', 'bed-leveling'],
  });
  let confirmations = 0;
  const flow = new PrintWorkflowController({
    captureSession: async () => ({
      printerId: 'printer-a',
      generation: 1,
      label: 'Printer A',
      transport: printer,
      signal: epoch.signal,
      assertCurrent: () => {
        if (epoch.signal.aborted) throw new Error('session changed');
      },
    }),
    confirm: async (input) => {
      confirmations++;
      return confirm(input);
    },
  });
  const intent: PrintJobIntent = {
    filename: 'part.gcode',
    plateName: 'Plate A',
    gcode,
    usage: summarizeGcodeToolUsage(gcode),
    artifact: {
      outputHash: sha256Bytes(new TextEncoder().encode(gcode)),
      sourceHash: 'source',
      sourceAssetHash: 'assets',
      sourceRevision: 1,
      plateId: 'plate-a',
    },
    isCurrent: () => current,
  };
  return {
    printer,
    flow,
    epoch,
    intent,
    edit: () => {
      current = false;
    },
    confirm: (value: typeof confirm) => {
      confirm = value;
    },
    confirmations: () => confirmations,
  };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('orders confirmed preparation after verification and before starting', async () => {
  const { flow, intent, printer } = setup();
  const phases: string[] = [];
  const result = await flow.run(intent, { onPhase: (phase) => phases.push(phase) });
  assert.equal(result?.startedPrint, true);
  assert.match(result!.path, /^part_[a-f0-9]{32}\.gcode$/);
  assert.deepEqual(phases, [
    'checking',
    'confirming',
    'uploading',
    'verifying',
    'preparing',
    'preparing',
    'starting',
    'completed',
  ]);
  assert.deepEqual(printer.mutations, ['upload', 'timelapse', 'leveling', 'start']);
});

await test('upload-only never applies preparation or starts, even when options are selected', async () => {
  const { flow, intent, printer } = setup('upload');
  assert.equal((await flow.run(intent))?.startedPrint, false);
  assert.deepEqual(printer.mutations, ['upload']);
});

for (const change of ['artifact', 'mapping', 'readiness', 'capabilities', 'session'] as const) {
  await test(`${change} drift after upload retains the file and sends no preparation or start`, async () => {
    const context = setup();
    const { printer, flow, intent } = context;
    printer.onUploaded = () => {
      if (change === 'artifact') context.edit();
      if (change === 'mapping') printer.material = 'PETG';
      if (change === 'readiness') printer.printState = 'printing';
      if (change === 'capabilities') printer.fileManagement = false;
      if (change === 'session') context.epoch.abort();
    };
    await assert.rejects(flow.run(intent));
    assert.deepEqual(printer.mutations, ['upload']);
    assert.equal(printer.files.size, 1);
    assert.equal(flow.busy, false);
  });
}

await test('cancel between preparation steps prevents the next step and start', async () => {
  const { flow, intent, printer } = setup();
  printer.onMutation = (operation) => {
    if (operation === 'timelapse') flow.cancel();
  };
  await assert.rejects(flow.run(intent));
  assert.deepEqual(printer.mutations, ['upload', 'timelapse']);
});

await test('changed preparation command requires a new confirmation', async () => {
  const { flow, intent, printer } = setup();
  printer.onMutation = (operation) => {
    if (operation === 'timelapse') printer.command = 'G29';
  };
  await assert.rejects(flow.run(intent), /preparation option changed/);
  assert.deepEqual(printer.mutations, ['upload', 'timelapse']);
});

await test('ambiguous preparation is never retried and triggers a fresh status query', async () => {
  const { flow, intent, printer } = setup();
  printer.failPreparation = true;
  await assert.rejects(flow.run(intent), /uncertain outcome.*Fresh printer state: standby/);
  assert.equal(flow.phase, 'uncertain');
  assert.deepEqual(printer.mutations, ['upload', 'timelapse']);
  assert.match(printer.queries.at(-1)!, /objects\/query\?webhooks/);
});

await test('a lost start response is reconciled as printing without retrying', async () => {
  const { flow, intent, printer } = setup();
  printer.failStart = true;
  await assert.rejects(flow.run(intent), /uncertain outcome.*Fresh printer state: printing/);
  assert.deepEqual(printer.mutations, ['upload', 'timelapse', 'leveling', 'start']);
});

await test('failed listing prevents confirmation and upload', async () => {
  const context = setup();
  context.printer.failListing = true;
  await assert.rejects(context.flow.run(context.intent), /file list/);
  assert.deepEqual(context.printer.mutations, []);
  assert.equal(context.confirmations(), 0);
});

for (const patch of [{ root: 'config' }, { path: 'other.gcode' }, { size: 1 }]) {
  await test(`unverified upload response ${JSON.stringify(patch)} prevents preparation/start`, async () => {
    const { flow, intent, printer } = setup();
    printer.responsePatch = patch;
    await assert.rejects(
      flow.run(intent),
      (error: unknown) => error instanceof PrintSubmissionError && error.code === 'verification-failed',
    );
    assert.deepEqual(printer.mutations, ['upload']);
  });
}

await test('overwrite confirmation names the captured file, and replacement during the dialog is rejected', async () => {
  const context = setup('upload');
  context.printer.files.set('part.gcode', { size: 20, modified: 10 });
  context.confirm(async (input) => {
    assert.equal(input.overwrite.filename, 'part.gcode');
    assert.deepEqual(input.overwrite.existing, { filename: 'part.gcode', size: 20, modified: 10 });
    context.printer.files.set('part.gcode', { size: 30, modified: 20 });
    return { choice: 'upload', overwrite: true, startOptions: [] };
  });
  await assert.rejects(context.flow.run(context.intent), /overwrite target changed/);
  assert.deepEqual(context.printer.mutations, []);
});

await test('even upload-only cannot replace an active file', async () => {
  const context = setup('upload');
  context.printer.files.set('part.gcode', { size: 20, modified: 10 });
  context.printer.printState = 'printing';
  context.printer.filename = 'part.gcode';
  context.confirm(async () => ({ choice: 'upload', overwrite: true, startOptions: [] }));
  await assert.rejects(context.flow.run(context.intent), /active file/);
  assert.deepEqual(context.printer.mutations, []);
});

await test('128-bit names regenerate on a known collision, without using a timestamp or counter', async () => {
  const printer = new Printer();
  printer.files.set(`part_${'00'.repeat(16)}.gcode`, { size: 1, modified: 1 });
  let attempt = 0;
  const target = await preparePrintUpload(printer, '../part.gcode', undefined, () =>
    new Uint8Array(16).fill(attempt++),
  );
  assert.equal(target.unique, `part_${'01'.repeat(16)}.gcode`);
  assert.equal(attempt, 2);
});

await test('session loss aborts an open confirmation and suppresses duplicates', async () => {
  const context = setup();
  let answer!: (decision: PrintWorkflowDecision) => void;
  context.confirm(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const pending = context.flow.run(context.intent);
  while (!answer) await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(context.flow.run(context.intent), /already pending/);
  context.epoch.abort();
  await assert.rejects(pending, /cancelled/);
  answer({ choice: 'upload-and-print', overwrite: false, startOptions: [] });
  assert.deepEqual(context.printer.mutations, []);
  assert.equal(context.flow.busy, false);
});
await test('cancellation at the start boundary sends no start request', async () => {
  const { flow, intent, printer } = setup();
  await assert.rejects(
    flow.run(intent, {
      onPhase: (phase) => {
        if (phase === 'starting') flow.cancel();
      },
    }),
  );
  assert.deepEqual(printer.mutations, ['upload', 'timelapse', 'leveling']);
  assert.equal(flow.phase, 'cancelled');
});

await test('a newly created overwrite target requires another confirmation', async () => {
  const context = setup('upload');
  context.confirm(async (input) => {
    assert.equal(input.overwrite.existing, null);
    context.printer.files.set('part.gcode', { size: 12, modified: 12 });
    return { choice: 'upload', overwrite: true, startOptions: [] };
  });
  await assert.rejects(context.flow.run(context.intent), /overwrite target changed/);
  assert.deepEqual(context.printer.mutations, []);
});

await test('unknown readiness blocks upload-only before confirmation', async () => {
  const context = setup('upload');
  context.printer.printState = 'future-state';
  await assert.rejects(context.flow.run(context.intent), /complete readiness/);
  assert.equal(context.confirmations(), 0);
  assert.deepEqual(context.printer.mutations, []);
});

for (const change of ['file', 'readiness', 'session', 'none'] as const) {
  await test(`a stored reprint revalidates ${change} after its own confirmation`, async () => {
    const context = setup();
    context.printer.files.set('part.gcode', { size: 20, modified: 10 });
    context.confirm(async (input) => {
      assert.equal(input.mode, 'stored');
      assert.equal(input.filename, 'part.gcode');
      assert.equal(input.byteLength, 20);
      if (change === 'file') context.printer.files.set('part.gcode', { size: 20, modified: 11 });
      if (change === 'readiness') context.printer.printState = 'printing';
      if (change === 'session') context.epoch.abort();
      return { choice: 'upload-and-print', overwrite: false, startOptions: [] };
    });
    if (change === 'none') {
      assert.equal(await context.flow.startStored('part.gcode'), 'part.gcode');
      assert.deepEqual(context.printer.mutations, ['start']);
    } else {
      await assert.rejects(context.flow.startStored('part.gcode'));
      assert.deepEqual(context.printer.mutations, []);
    }
  });
}
await test('two confirmations that picked the same random name cannot replace each other', async () => {
  const printer = new Printer();
  const plans = await Promise.all(
    [0, 1].map(() => preparePrintUpload(printer, 'part.gcode', undefined, () => new Uint8Array(16))),
  );
  const request = { filename: 'part.gcode', gcode, checksum: sha256Bytes(new TextEncoder().encode(gcode)).slice(7) };
  await submitPrintJob(printer, { ...request, uploadPlan: plans[0] });
  await assert.rejects(
    submitPrintJob(printer, { ...request, uploadPlan: plans[1] }),
    /name was taken after confirmation/,
  );
  assert.deepEqual(printer.mutations, ['upload']);
});

for (const phase of ['checking', 'confirming', 'uploading', 'verifying', 'preparing'] as const) {
  await test(`cancellation in ${phase} prevents every later mutation`, async () => {
    const { flow, printer, intent } = setup();
    await assert.rejects(
      flow.run(intent, {
        onPhase: (value) => {
          if (value === phase) flow.cancel();
        },
      }),
    );
    assert.deepEqual(printer.mutations, phase === 'verifying' || phase === 'preparing' ? ['upload'] : []);
    assert.equal(flow.phase, 'cancelled');
    assert.equal(flow.busy, false);
  });
}
console.log(`\nPrint workflow controller: ${passed} tests passed.`);
