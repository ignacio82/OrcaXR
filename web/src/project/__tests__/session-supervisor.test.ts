/**
 * Supervision of a worker-hosted project session, over an in-process worker
 * that hosts the TypeScript session: acknowledged checkpoints only, replies
 * from superseded incarnations and foreign generations never accepted, work
 * in flight at a failure rejected as of unknown outcome, recovery from the
 * acknowledged checkpoint under a new generation, and explicit disposal.
 */
import assert from 'node:assert/strict';

import type { ProjectGenerationWire } from '../../../../contracts/generated/project-intents';
import { AsyncEditorSession } from '../AsyncEditorSession';
import { InMemoryAssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { ProjectState } from '../domain/model';
import { ProjectSessionClientError, sessionText } from '../ProjectSessionClient';
import { ProjectSessionEndpoint } from '../ProjectSessionEndpoint';
import {
  ProjectSessionSupervisor,
  ProjectSessionSupervisorError,
  SessionWorkerChannel,
  SessionWorkerFailure,
  type SessionCheckpoint,
  type SessionWorkerPort,
  type SessionWorkerReply,
  type SessionWorkerRequest,
} from '../ProjectSessionWorker';
import { EditorSession } from '../session';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A worker in the same thread: replies arrive asynchronously, in order. */
class FakeWorker {
  readonly ports: SessionWorkerPort[] = [];
  mode: 'normal' | 'hang' | 'lie' | 'foreign-generation' | 'refuse-open' = 'normal';
  terminated = 0;
  private listener?: Parameters<SessionWorkerPort['listen']>[0];
  private session?: EditorSession;
  private endpoint?: ProjectSessionEndpoint;
  private incarnation = -1;
  private queue = Promise.resolve();
  private stopped = false;

  constructor() {
    const port: SessionWorkerPort = {
      postMessage: (message) => {
        this.queue = this.queue.then(() => this.handle(message));
      },
      listen: (listener) => {
        this.listener = listener;
      },
      terminate: () => {
        this.stopped = true;
        this.terminated++;
        this.session?.dispose();
      },
    };
    this.ports.push(port);
  }

  get port(): SessionWorkerPort {
    return this.ports[0];
  }
  crash(reason = 'crashed'): void {
    this.listener?.failure(reason);
  }
  /** Deliver a reply as if from this worker, bypassing its session. */
  inject(reply: SessionWorkerReply): void {
    this.listener?.message(reply);
  }

  private post(reply: SessionWorkerReply): void {
    queueMicrotask(() => {
      if (!this.stopped) this.listener?.message(reply);
    });
  }

  private async handle(request: SessionWorkerRequest): Promise<void> {
    if (this.stopped || this.mode === 'hang') return;
    if (request.kind === 'open') {
      if (this.mode === 'refuse-open') {
        this.post({ kind: 'failed', incarnation: request.incarnation, message: 'cannot open' });
        return;
      }
      const state = JSON.parse(request.checkpoint.stateJson) as ProjectState;
      const assets = new InMemoryAssetRepository();
      state.sourceAssets.forEach((descriptor, position) => assets.put(descriptor, request.checkpoint.assets[position]));
      this.session = new EditorSession({
        initialState: state,
        assets,
        history: { maxEntries: request.limits.historyEntries, maxEstimatedBytes: request.limits.historyBytes },
        serializer: {
          serialize: () => Promise.reject(new Error('unused')),
          deserialize: () => Promise.reject(new Error('unused')),
        },
      });
      this.endpoint = new ProjectSessionEndpoint(new AsyncEditorSession(this.session), request.generation, 1);
      this.incarnation = request.incarnation;
      this.post({ kind: 'opened', incarnation: this.incarnation, id: request.id });
      return;
    }
    if (request.kind === 'exchange') {
      let text = await this.endpoint!.handle(request.text);
      if (this.mode === 'foreign-generation') {
        // A reply that claims another session's generation.
        const generation: ProjectGenerationWire = [9, 9, 9, 9];
        text = JSON.stringify({ ...JSON.parse(text), generation });
      }
      this.post({ kind: 'exchange', incarnation: this.incarnation, id: request.id, text });
      return;
    }
    const session = this.session!;
    const snapshot = session.project.getSnapshot();
    this.post({
      kind: 'checkpoint',
      incarnation: this.incarnation,
      id: request.id,
      checkpoint: {
        revision: snapshot.revision + (this.mode === 'lie' ? 1 : 0),
        semanticHash: snapshot.hash,
        assetFingerprint: session.assets.bundleFingerprint(),
        stateJson: canonicalStringify(snapshot.state),
        assets: snapshot.state.sourceAssets.map((descriptor) => session.assets.peek(descriptor.id)!.bytes.slice()),
      },
    });
  }
}

const LIMITS = {
  documentNodes: 1_000_000,
  documentTextUnits: 2_000_000,
  numberBytes: 1024,
  depth: 128,
  assetBytes: 1 << 24,
  totalAssetBytes: 1 << 25,
  historyEntries: 100,
  historyBytes: 1 << 25,
};
function initial(): SessionCheckpoint {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: {
      serialize: () => Promise.reject(new Error('unused')),
      deserialize: () => Promise.reject(new Error('unused')),
    },
  });
  const snapshot = session.project.getSnapshot();
  const checkpoint = {
    revision: snapshot.revision,
    semanticHash: snapshot.hash,
    assetFingerprint: assets.bundleFingerprint(),
    stateJson: canonicalStringify(snapshot.state),
    assets: [fixture.asset.bytes.slice()],
  };
  session.dispose();
  return checkpoint;
}
function supervise() {
  const workers: FakeWorker[] = [];
  let nonce = 0;
  const supervisor = new ProjectSessionSupervisor({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker.port;
    },
    generation: () => [1, ++nonce, 0, 0],
    schemaVersion: 1,
    limits: LIMITS,
  });
  return { supervisor, workers };
}
const units = (value: string) => Array.from(value, (c) => c.charCodeAt(0));
async function rename(supervisor: ProjectSessionSupervisor, name: string) {
  const query = await supervisor.submit({ query: {} }).result;
  assert.ok('acknowledged' in query);
  const receipt = await supervisor.submit({
    execute: {
      guard: query.acknowledged.guard,
      intent: { version: 1, command: { renameProject: { name: units(name) } } },
    },
  }).result;
  assert.ok('acknowledged' in receipt && receipt.acknowledged.changed);
  return receipt.acknowledged.guard;
}
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a rejection');
}
const unknownOutcome = (error: unknown) =>
  error instanceof ProjectSessionClientError && error.code === 'outcomeUnknown';

await test('acknowledged edits cross the worker; a checkpoint adopts only an acknowledged identity', async () => {
  const { supervisor, workers } = supervise();
  await supervisor.start(initial());
  const guard = await rename(supervisor, 'Checkpointed');
  const identity = await supervisor.checkpoint();
  assert.equal(identity.revision, guard.revision);
  assert.equal(identity.semanticHash, sessionText(guard.semanticHash));
  assert.equal(JSON.parse(supervisor.acknowledgedCheckpoint()!.stateJson).name, 'Checkpointed');

  await rename(supervisor, 'Later');
  workers[0].mode = 'lie';
  const error = await refusal(supervisor.checkpoint());
  assert.ok(error instanceof ProjectSessionSupervisorError && error.code === 'unacknowledged');
  assert.deepEqual(supervisor.checkpointIdentity, identity, 'the previous checkpoint is kept');
  supervisor.dispose();
});

await test('replies from another incarnation or generation are never accepted', async () => {
  // A reply tagged with a superseded incarnation is dropped on a shared port.
  const worker = new FakeWorker();
  const channel = new SessionWorkerChannel(worker.port, 7);
  const opened = channel.open([1, 2, 3, 4], LIMITS, initial());
  worker.inject({ kind: 'opened', incarnation: 6, id: 1 });
  await opened;
  assert.equal(channel.failed, undefined);

  // A session answering under another generation fails the client closed.
  const { supervisor, workers } = supervise();
  const started = supervisor.start(initial());
  workers[0].mode = 'foreign-generation';
  await started;
  assert.ok(unknownOutcome(await refusal(supervisor.submit({ query: {} }).result)));
  assert.ok(supervisor.failed, 'a session that failed closed is a failed incarnation');
  const report = await supervisor.recover();
  assert.equal(workers[0].terminated, 1, 'and its worker is stopped');
  assert.equal(report.unknownOutcomes, 0);
  await rename(supervisor, 'Recovered');
  supervisor.dispose();
});

await test('a failure rejects work in flight; recovery opens a new generation from the checkpoint', async () => {
  const { supervisor, workers } = supervise();
  await supervisor.start(initial());
  await rename(supervisor, 'Kept');
  const identity = await supervisor.checkpoint();
  const later = await rename(supervisor, 'Not kept');

  workers[0].mode = 'hang';
  const inFlight = [0, 1].map(
    (n) =>
      supervisor.submit({
        execute: {
          guard: later,
          intent: { version: 1, command: { renameProject: { name: units(`Lost ${n}`) } } },
        },
      }).result,
  );
  const generation = supervisor.generation;
  workers[0].crash();
  for (const result of inFlight) assert.ok(unknownOutcome(await refusal(result)));
  assert.ok(supervisor.failed);
  assert.equal(workers[0].terminated, 1, 'the failed worker is stopped');
  assert.ok(unknownOutcome(await refusal(supervisor.submit({ query: {} }).result)));

  const report = await supervisor.recover();
  assert.equal(report.unknownOutcomes, 2);
  assert.notDeepEqual(report.generation, generation);
  assert.equal(report.checkpoint.semanticHash, identity.semanticHash);
  assert.equal(workers.length, 2);
  // A late reply from the failed worker changes nothing.
  workers[0].inject({ kind: 'exchange', incarnation: 1, id: 99, text: '{}' });
  await supervisor.checkpoint();
  assert.equal(JSON.parse(supervisor.acknowledgedCheckpoint()!.stateJson).name, 'Kept');
  await rename(supervisor, 'After recovery');

  const notFailed = await refusal(supervisor.recover());
  assert.ok(notFailed instanceof ProjectSessionSupervisorError && notFailed.code === 'not-failed');
  supervisor.dispose();
});

await test('disposal closes the session, stops the worker and refuses later work', async () => {
  const { supervisor, workers } = supervise();
  await supervisor.start(initial());
  workers[0].mode = 'hang';
  const pending = supervisor.submit({ query: {} }).result;
  supervisor.dispose();
  assert.equal(workers[0].terminated, 1);
  assert.ok(await refusal(pending));
  const after = await refusal(supervisor.submit({ query: {} }).result);
  assert.ok(after instanceof ProjectSessionSupervisorError && after.code === 'disposed');
  const recovery = await refusal(supervisor.recover());
  assert.ok(recovery instanceof ProjectSessionSupervisorError && recovery.code === 'disposed');
});

await test('a worker that cannot open fails the start', async () => {
  const { supervisor, workers } = supervise();
  const started = supervisor.start(initial());
  workers[0].mode = 'refuse-open';
  const error = await refusal(started);
  assert.ok(error instanceof SessionWorkerFailure);
  assert.ok(supervisor.failed);
});

console.log(`session supervisor tests passed: ${passed}`);
