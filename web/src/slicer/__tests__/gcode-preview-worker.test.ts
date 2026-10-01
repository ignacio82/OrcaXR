import assert from 'node:assert/strict';
import { GcodePreviewSession } from '../GcodePreviewSession';
import { summarizeGcodeArtifact } from '../GcodeArtifactSummary';
import {
  WorkerGcodePreviewSession,
  PreviewRequestCancelledError,
  type PreviewWorkerPort,
} from '../WorkerGcodePreviewSession';
import type { PreviewWorkerRequest, PreviewWorkerResponse, PreviewWorkerSnapshot } from '../GcodePreviewWorkerProtocol';

const SOURCE = { kind: 'file' as const, name: 'generated.gcode' };
const GCODE = 'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2 F1200\n;TYPE:Outer wall\n' + 'G1 X1 E0.1\nG1 X2 E0.1\n'.repeat(12);
class ControlledWorker implements PreviewWorkerPort {
  onmessage: PreviewWorkerPort['onmessage'] = null;
  onerror: PreviewWorkerPort['onerror'] = null;
  onmessageerror: PreviewWorkerPort['onmessageerror'] = null;
  readonly messages: PreviewWorkerRequest[] = [];
  terminated = 0;
  throwOnPost = false;
  private session?: GcodePreviewSession;
  postMessage(request: PreviewWorkerRequest) {
    if (this.throwOnPost) throw new Error('clone failed');
    this.messages.push(request);
  }
  terminate() {
    this.terminated++;
  }
  reply(request = this.messages.at(-1)!) {
    if (request.type === 'open')
      this.session = GcodePreviewSession.fromGcode(request.gcode, request.source, { limits: { records: 8 } });
    else this.session!.updateView(request.patch);
    const session = this.session!;
    this.deliver({
      version: 1,
      id: request.id,
      type: 'ready',
      snapshot: structuredClone({
        model: session.model,
        view: session.getView(),
        layerBounds: session.layerBounds,
        window: session.windowState,
        notice: session.windowNotice(),
        summary: summarizeGcodeArtifact(GCODE),
        projection: session.project(),
        inspection: session.inspect(),
      }),
    });
  }
  deliver(response: PreviewWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<PreviewWorkerResponse>);
  }
}
async function open(worker = new ControlledWorker(), abort = new AbortController()) {
  const pending = WorkerGcodePreviewSession.create(GCODE, SOURCE, abort.signal, { workerFactory: () => worker });
  worker.reply();
  return { session: await pending, worker, abort };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`  ✓ ${name}`);
  passed++;
}

await test('one in-flight view plus one merged latest request preserves original records and ignores obsolete replies', async () => {
  const { session, worker } = await open();
  assert.equal(session.model.columns.count, 8);
  assert.strictEqual(
    session.project(),
    session.project(),
    'default projections are cached, not rebuilt for every surface',
  );
  assert.strictEqual(session.inspect(), session.inspect());
  const first = session.updateView({ windowStep: 1 });
  const cancelledFirst = assert.rejects(first, PreviewRequestCancelledError);
  const second = session.updateView({ mode: 'Feedrate' });
  const cancelledSecond = assert.rejects(second, PreviewRequestCancelledError);
  const latest = session.updateView({ moveVisibility: { travel: true } });
  assert.equal(worker.messages.length, 2, 'open and one active view only');
  worker.reply();
  await cancelledFirst;
  await cancelledSecond;
  assert.equal(session.model.recordOffset, 0, 'the obsolete window is never published');
  const request = worker.messages.at(-1)!;
  assert.equal(request.type, 'view');
  if (request.type === 'view') {
    assert.equal(request.patch.mode, 'Feedrate');
    assert.equal(request.patch.moveVisibility?.travel, true);
    assert.equal(request.patch.windowStep, undefined, 'an already applied step must not repeat');
  }
  worker.reply();
  await latest;
  assert.equal(session.model.recordOffset, 8);
  assert.equal(session.getView().mode, 'Feedrate');
  assert.equal(session.getView().moveVisibility.travel, true);
  session.dispose();
  session.dispose();
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
});

await test('abort settles opening and later windows, removes listeners and rejects late results', async () => {
  const worker = new ControlledWorker();
  const abort = new AbortController();
  const pending = WorkerGcodePreviewSession.create(GCODE, SOURCE, abort.signal, { workerFactory: () => worker });
  const rejected = assert.rejects(pending, PreviewRequestCancelledError);
  abort.abort();
  await rejected;
  assert.equal(worker.terminated, 1);
  worker.reply();
  const opened = await open();
  const active = assert.rejects(opened.session.updateView({ windowStep: 1 }), PreviewRequestCancelledError);
  const queued = assert.rejects(opened.session.updateView({ mode: 'Feedrate' }), PreviewRequestCancelledError);
  opened.abort.abort();
  await Promise.all([active, queued]);
  assert.throws(() => opened.session.model, /unavailable/);
  await assert.rejects(opened.session.updateView({ mode: 'FeatureType' }), PreviewRequestCancelledError);
});

await test('a crash, malformed message, unreadable message and post failure settle every request', async () => {
  for (const fail of [
    (worker: ControlledWorker) => worker.onerror?.({} as ErrorEvent),
    (worker: ControlledWorker) => worker.onmessageerror?.({} as MessageEvent),
    (worker: ControlledWorker) => worker.deliver({ version: 9 } as unknown as PreviewWorkerResponse),
    (worker: ControlledWorker) =>
      worker.deliver({
        version: 1,
        id: worker.messages.at(-1)!.id,
        type: 'ready',
        snapshot: {} as PreviewWorkerSnapshot,
      }),
  ]) {
    const { session, worker } = await open();
    const active = assert.rejects(session.updateView({ windowStep: 1 }));
    const queued = assert.rejects(session.updateView({ mode: 'Feedrate' }));
    fail(worker);
    await Promise.all([active, queued]);
    assert.equal(worker.terminated, 1);
  }
  const worker = new ControlledWorker();
  worker.throwOnPost = true;
  await assert.rejects(
    WorkerGcodePreviewSession.create(GCODE, SOURCE, new AbortController().signal, { workerFactory: () => worker }),
    /Could not send/,
  );
  assert.equal(worker.terminated, 1);
});

await test('hung opening has a deadline and unavailable workers never trigger a main-thread parse', async () => {
  const worker = new ControlledWorker();
  await assert.rejects(
    WorkerGcodePreviewSession.create(GCODE, SOURCE, new AbortController().signal, {
      workerFactory: () => worker,
      deadlineMs: 10,
    }),
    /timed out/,
  );
  assert.equal(worker.terminated, 1);
  await assert.rejects(
    WorkerGcodePreviewSession.create(GCODE, SOURCE, new AbortController().signal, {
      workerFactory: () => {
        throw new Error('Worker unavailable');
      },
    }),
    /Worker unavailable/,
  );
});
console.log(`\nG-code preview worker ownership: ${passed} tests passed.`);
