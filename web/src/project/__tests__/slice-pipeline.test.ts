import assert from 'node:assert/strict';
import { InMemoryAssetRepository } from '../assets';
import { cloneJson, cloneProjectState } from '../domain/canonical';
import { seededRandom, UuidIdSource } from '../domain/ids';
import type { ProjectArchiveSnapshot, ProjectSerializerPort } from '../ports';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import {
  CanonicalSliceJobCoordinator,
  SliceJobCancelledError,
  SlicePreflightError,
  SliceRouteCancellationError,
  SliceJobTimeoutError,
  SliceRouteError,
  StaleSliceCompletionError,
} from '../slicing/SliceJobCoordinator';
import { StoreProjectSliceSource } from '../slicing/source';
import {
  SLICE_PROTOCOL_VERSION,
  type CanonicalSliceJobResult,
  type SliceProfileResolverPort,
  type SliceRecoveryReason,
  type SliceResultPublisherPort,
  type SliceRouteAdapterPort,
  type SliceRouteRequest,
  type SliceRouteResponse,
} from '../slicing/types';
import { ProjectStore } from '../store';
import { createProjectFixture } from './fixtures';

const ENGINE_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626';
const ENGINE_ARTIFACT_HASH = 'sha256:fixture-engine-artifact';
const encoder = new TextEncoder();

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class CapturingSerializer implements ProjectSerializerPort {
  readonly delegate = new Bbs3mfProjectSerializer();
  readonly snapshots: ProjectArchiveSnapshot[] = [];
  calls = 0;

  async serialize(snapshot: ProjectArchiveSnapshot, cancellation?: Parameters<ProjectSerializerPort['serialize']>[1]) {
    this.calls += 1;
    this.snapshots.push({
      state: cloneProjectState(snapshot.state),
      assets: snapshot.assets.map((asset) => ({ descriptor: cloneJson(asset.descriptor), bytes: asset.bytes.slice() })),
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
    });
    const result = await this.delegate.serialize(snapshot, cancellation);
    return { ...result, warnings: [...(result.warnings ?? []), 'serializer projection warning'] };
  }

  deserialize(...args: Parameters<ProjectSerializerPort['deserialize']>) {
    return this.delegate.deserialize(...args);
  }
}

class RecordingRoute implements SliceRouteAdapterPort {
  readonly metadata = {
    id: 'recording-route',
    kind: 'test' as const,
    protocolVersion: SLICE_PROTOCOL_VERSION,
    engine: { commit: ENGINE_COMMIT, artifactHash: ENGINE_ARTIFACT_HASH },
  };
  readonly requests: SliceRouteRequest[] = [];

  async execute(request: SliceRouteRequest, _signal: AbortSignal): Promise<SliceRouteResponse> {
    this.requests.push(cloneRequest(request));
    return responseFor(request);
  }
}

const profiles: SliceProfileResolverPort = {
  capture(state, _plateId) {
    return {
      references: [
        {
          kind: 'printer',
          id: state.printer.profileId?.trim() || 'canonical:effective-printer',
          hash: state.printer.profileHash ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
        },
        {
          kind: 'process',
          id:
            (typeof state.config.print_settings_id === 'string' && state.config.print_settings_id) ||
            'canonical:effective-process',
          hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000004',
        },
        ...state.filaments.physical.map((filament, index) => ({
          kind: 'filament' as const,
          id: filament.presetId?.trim() || filament.id,
          hash: filament.presetHash ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000002',
          tool: index,
        })),
        ...state.filaments.mixed
          .filter((filament) => filament.enabled)
          .map((filament, index) => ({
            kind: 'filament' as const,
            id: filament.id,
            hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000005',
            tool: state.filaments.physical.length + index,
          })),
      ],
      effectiveConfigHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000003',
    };
  },
};

function harness(route: SliceRouteAdapterPort = new RecordingRoute(), publisher?: SliceResultPublisherPort) {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.printer.profileHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000001';
  // Absolute extruder addressing, so the projection's relative-E layer reset
  // does not apply and this test keeps asserting exactly its own warning.
  state.config.use_relative_e_distances = '0';
  state.filaments.physical.forEach((filament, index) => {
    filament.presetId = `pla-${index}`;
    filament.presetHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000002';
  });
  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const serializer = new CapturingSerializer();
  const coordinator = new CanonicalSliceJobCoordinator({
    source: new StoreProjectSliceSource(project, assets),
    serializer,
    profiles,
    route,
    publisher,
    now: () => '2026-07-17T12:00:00.000Z',
  });
  return { fixture, project, assets, serializer, coordinator, route };
}

await test('submits only serialized canonical 3MF bytes and records complete provenance', async () => {
  const route = new RecordingRoute();
  const published: CanonicalSliceJobResult[] = [];
  const setup = harness(route, { publish: (result) => published.push(result) });
  const result = await setup.coordinator.startCurrentPlate().completion;

  assert.equal(setup.serializer.calls, 1);
  assert.equal(route.requests.length, 1);
  const request = route.requests[0];
  assert.equal(request.project.mediaType, 'model/3mf');
  assert.deepEqual(Array.from(request.project.bytes.subarray(0, 2)), [0x50, 0x4b]);
  assert.equal(request.project.sourceRevision, 0);
  assert.equal(request.project.sourceHash, setup.project.getSnapshot().hash);
  assert.equal(request.project.sourceAssetHash, result.sourceAssetHash);
  assert.match(result.sourceAssetHash, /^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(request.engine.commit, ENGINE_COMMIT);
  assert.equal(request.engine.artifactHash, ENGINE_ARTIFACT_HASH);
  assert.equal(
    request.profiles.references[0].hash,
    'sha256:0000000000000000000000000000000000000000000000000000000000000001',
  );

  assert.equal(result.plates[0].projectInputHash, request.project.inputHash);
  assert.match(result.plates[0].projectInputHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.plates[0].outputHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.plates[0].serializerWarnings, ['serializer projection warning']);
  assert.deepEqual(result.plates[0].preflightIssues, []);
  assert.equal(result.route.engine.commit, ENGINE_COMMIT);
  assert.equal(result.route.engine.artifactHash, ENGINE_ARTIFACT_HASH);
  assert.deepEqual(result.warnings, ['serializer projection warning', 'engine warning']);
  assert.equal(published.length, 1);

  // Returned and published byte buffers do not alias the coordinator's copy.
  result.plates[0].gcode[0] = 0;
  published[0].plates[0].gcode[1] = 0;
  assert.notEqual(setup.coordinator.getLatestResult()!.plates[0].gcode[0], 0);
  assert.notEqual(setup.coordinator.getLatestResult()!.plates[0].gcode[1], 0);
});

await test('blocks canonical preflight before serialization or route submission', async () => {
  const route = new RecordingRoute();
  const setup = harness(route);
  const next = cloneProjectState(setup.project.getSnapshot().state);
  next.filaments.physical[0].enabled = false;
  setup.project.replaceState(next, { reason: 'disable-assigned-filament' });

  const handle = setup.coordinator.startCurrentPlate();
  await assert.rejects(handle.completion, (error: unknown) => {
    assert.ok(error instanceof SlicePreflightError);
    assert.equal(error.result.canSlice, false);
    assert.ok(error.result.issues.some((issue) => issue.code === 'disabled-filament-assignment'));
    assert.ok(error.result.issues.some((issue) => issue.code === 'disabled-mixed-component'));
    return true;
  });
  assert.equal(setup.serializer.calls, 0);
  assert.equal(route.requests.length, 0);
  assert.equal(handle.getStatus().phase, 'failed');
  assert.equal(handle.getStatus().errorName, 'SlicePreflightError');
});

await test('every required canonical edit changes the exact project bytes submitted to slicing', async () => {
  const route = new RecordingRoute();
  const setup = harness(route);
  await setup.coordinator.startCurrentPlate().completion;
  let previousSubmission = route.requests.at(-1)!.project.bytes;

  const edits: Array<[string, (state: ReturnType<typeof cloneProjectState>) => void]> = [
    [
      'part assignment',
      (state) => {
        state.plates[0].objects[0].volumes[0].filamentId = state.filaments.physical[1].id;
      },
    ],
    [
      'paint facet',
      (state) => {
        state.plates[0].objects[0].volumes[0].annotations.color[0].value = state.filaments.physical[0].id;
      },
    ],
    [
      'layer override',
      (state) => {
        state.plates[0].objects[0].layerRanges[0].config.layer_height = 0.16;
      },
    ],
    [
      'mixed recipe',
      (state) => {
        state.filaments.mixed[0].components[0].weight = 3;
      },
    ],
    [
      'instance transform',
      (state) => {
        state.plates[0].objects[0].instances[0].transform.translationMm = [12, 7, 0];
      },
    ],
    [
      'plate config',
      (state) => {
        state.plates[0].config.sparse_infill_density = 42;
      },
    ],
  ];

  for (const [label, edit] of edits) {
    const next = cloneProjectState(setup.project.getSnapshot().state);
    edit(next);
    setup.project.replaceState(next, { reason: `test-${label}` });
    await setup.coordinator.startCurrentPlate().completion;
    const submitted = route.requests.at(-1)!.project.bytes;
    assert.notDeepEqual(submitted, previousSubmission, `${label} must change the serialized slice input`);
    previousSubmission = submitted;
  }
});

await test('serializes current plate two and every printable plate as distinct one-plate archives', async () => {
  const route = new RecordingRoute();
  const setup = harness(route);
  const next = cloneProjectState(setup.project.getSnapshot().state);
  const ids = new UuidIdSource(seededRandom(0x5151));
  const plateId = ids.next('plate');
  const secondObject = cloneJson(next.plates[0].objects[0]);
  secondObject.id = ids.next('object');
  secondObject.name = 'Second-plate triangle';
  secondObject.volumes[0].id = ids.next('volume');
  secondObject.instances[0].id = ids.next('instance');
  secondObject.instances[0].transform.translationMm = [41, 17, 0];
  secondObject.layerRanges[0].id = ids.next('layer-range');
  next.plates.push({
    id: plateId,
    name: 'Plate 2',
    order: 1,
    printable: true,
    config: { layer_height: 0.28 },
    objects: [secondObject],
  });
  next.activePlateId = plateId;
  setup.project.replaceState(next, { reason: 'add-second-plate' });
  const fullSource = setup.project.getSnapshot();

  const current = await setup.coordinator.startCurrentPlate().completion;
  assert.deepEqual(
    current.plates.map((plate) => plate.plateId),
    [plateId],
  );
  const currentRequest = route.requests.at(-1)!;
  assert.equal(currentRequest.plateId, plateId);
  assert.equal(currentRequest.project.sourceHash, fullSource.hash);
  assert.equal(current.sourceHash, fullSource.hash);
  const currentProjection = setup.serializer.snapshots.at(-1)!;
  assert.notEqual(currentProjection.sourceHash, fullSource.hash, 'projected and full-state hashes stay distinct');
  assertOnePlateState(currentProjection.state, plateId, secondObject.id);
  const currentArchive = await setup.serializer.deserialize(currentRequest.project.bytes);
  assertOnePlateState(currentArchive.state, plateId, secondObject.id);

  const callsBeforeAll = setup.serializer.calls;
  const requestsBeforeAll = route.requests.length;
  const all = await setup.coordinator.startAllPlates().completion;
  assert.deepEqual(
    all.plates.map((plate) => plate.plateId),
    [setup.fixture.ids.plate, plateId],
  );
  assert.equal(setup.serializer.calls, callsBeforeAll + 2, 'every plate receives its own serializer projection');
  assert.equal(new Set(all.plates.map((plate) => plate.projectInputHash)).size, 2);

  const requests = route.requests.slice(requestsBeforeAll);
  assert.equal(requests.length, 2);
  assert.notDeepEqual(requests[0].project.bytes, requests[1].project.bytes);
  assert.equal(requests[0].project.sourceHash, fullSource.hash);
  assert.equal(requests[1].project.sourceHash, fullSource.hash);
  const firstArchive = await setup.serializer.deserialize(requests[0].project.bytes);
  const secondArchive = await setup.serializer.deserialize(requests[1].project.bytes);
  assertOnePlateState(firstArchive.state, setup.fixture.ids.plate, setup.fixture.ids.object);
  assertOnePlateState(secondArchive.state, plateId, secondObject.id);
});

await test('rejects stale completion before it can publish or replace the latest result', async () => {
  let pending:
    | {
        request: SliceRouteRequest;
        resolve: (response: SliceRouteResponse) => void;
      }
    | undefined;
  const route: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    execute(request) {
      return new Promise((resolve) => {
        pending = { request: cloneRequest(request), resolve };
      });
    },
  };
  const published: CanonicalSliceJobResult[] = [];
  const setup = harness(route, { publish: (result) => published.push(result) });
  const handle = setup.coordinator.startCurrentPlate();
  await waitUntil(() => pending !== undefined);
  const newer = cloneProjectState(setup.project.getSnapshot().state);
  newer.name = 'Newer canonical revision';
  setup.project.replaceState(newer, { reason: 'newer-revision' });
  pending!.resolve(responseFor(pending!.request));

  await assert.rejects(handle.completion, StaleSliceCompletionError);
  assert.equal(handle.getStatus().phase, 'stale');
  assert.equal(published.length, 0);
  assert.equal(setup.coordinator.getLatestResult(), undefined);
});

await test('rejects asset-repository-only drift before publication', async () => {
  let pending:
    | {
        request: SliceRouteRequest;
        resolve: (response: SliceRouteResponse) => void;
      }
    | undefined;
  const route: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    execute(request) {
      return new Promise((resolve) => {
        pending = { request: cloneRequest(request), resolve };
      });
    },
  };
  const published: CanonicalSliceJobResult[] = [];
  const setup = harness(route, { publish: (result) => published.push(result) });
  const handle = setup.coordinator.startCurrentPlate();
  await waitUntil(() => pending !== undefined);
  setup.assets.remove(setup.fixture.asset.descriptor.id);
  pending!.resolve(responseFor(pending!.request));

  await assert.rejects(handle.completion, StaleSliceCompletionError);
  assert.equal(handle.getStatus().phase, 'stale');
  assert.equal(published.length, 0);
  assert.equal(setup.coordinator.getLatestResult(), undefined);
});

await test('retries a recoverable worker failure with pristine bytes and records recovery', async () => {
  const requests: SliceRouteRequest[] = [];
  const recoveries: Array<{ reason: SliceRecoveryReason; attempt: number }> = [];
  const route: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    async execute(request) {
      requests.push(cloneRequest(request));
      if (request.attempt === 1) {
        request.project.bytes.fill(0); // A transferable/misbehaving adapter cannot poison the retry.
        throw new SliceRouteError('worker terminated', true);
      }
      return responseFor(request);
    },
    async recover(context) {
      recoveries.push({ reason: context.reason, attempt: context.failedAttempt });
    },
  };
  const setup = harness(route);
  const phases: string[] = [];
  setup.coordinator.subscribe((status) => phases.push(status.phase));
  const result = await setup.coordinator.startCurrentPlate({ maxAttempts: 2 }).completion;

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].project.bytes, requests[1].project.bytes);
  assert.deepEqual(recoveries, [{ reason: 'retryable-error', attempt: 1 }]);
  assert.equal(result.plates[0].attempts, 2);
  assert.ok(phases.includes('retrying'));
});

await test('cancellation and timeouts terminate publication even when a route stalls', async () => {
  let started = false;
  const stalled: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    execute(_request, signal) {
      started = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const cancelled = harness(stalled);
  const cancelHandle = cancelled.coordinator.startCurrentPlate();
  await waitUntil(() => started);
  cancelHandle.cancel('user cancelled');
  await assert.rejects(cancelHandle.completion, SliceJobCancelledError);
  assert.equal(cancelHandle.getStatus().phase, 'cancelled');
  assert.equal(cancelled.coordinator.getLatestResult(), undefined);

  const timedOut = harness(stalled);
  const timeoutHandle = timedOut.coordinator.startCurrentPlate({ maxAttempts: 1, attemptIdleTimeoutMs: 5 });
  await assert.rejects(timeoutHandle.completion, SliceJobTimeoutError);
  assert.equal(timeoutHandle.getStatus().phase, 'timed-out');
  assert.equal(timedOut.coordinator.getLatestResult(), undefined);
});

await test('a slow route that keeps reporting progress is never cancelled for taking a long time', async () => {
  // A two-million-facet model slices for many minutes. The attempt limit exists
  // to catch a route that has stopped responding, so progress has to hold it
  // off — otherwise the app cancels healthy work and reports it as a failure
  // long after the operator watched it start.
  let ticks = 0;
  let release: (() => void) | undefined;
  const slowButAlive: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    execute(request, signal, onProgress) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        const beat = setInterval(() => {
          ticks += 1;
          onProgress?.({ percent: Math.min(99, ticks), message: `slicing ${ticks}` });
        }, 5);
        release = () => {
          clearInterval(beat);
          resolve({
            protocolVersion: request.protocolVersion,
            jobId: request.jobId,
            plateId: request.plateId,
            inputHash: request.project.inputHash,
            engine: { ...new RecordingRoute().metadata.engine },
            gcode: new TextEncoder().encode('; slow but alive\n'),
            warnings: [],
            statistics: {},
          });
        };
      });
    },
  };
  const slow = harness(slowButAlive);
  // An idle limit far shorter than the run: only the heartbeat keeps it alive.
  const handle = slow.coordinator.startCurrentPlate({ maxAttempts: 1, attemptIdleTimeoutMs: 60 });
  await waitUntil(() => ticks >= 20);
  release?.();
  await handle.completion;
  assert.equal(handle.getStatus().phase, 'completed');
  assert.ok(ticks >= 20, 'the route ran well past the idle limit while reporting progress');
});

await test('a route that goes silent is cancelled and says that is why', async () => {
  let started = false;
  const silent: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    execute(_request, signal, onProgress) {
      started = true;
      // One beat, then silence.
      onProgress?.({ percent: 1, message: 'started' });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const stuck = harness(silent);
  const handle = stuck.coordinator.startCurrentPlate({ maxAttempts: 1, attemptIdleTimeoutMs: 20 });
  await assert.rejects(handle.completion, (error: unknown) => {
    assert.ok(error instanceof SliceJobTimeoutError, 'silence is reported as a timeout, not as a mystery');
    assert.match(String((error as Error).message), /no progress/, 'and it says what actually happened');
    return true;
  });
  assert.equal(started, true);
  assert.equal(handle.getStatus().phase, 'timed-out');
});

await test('confirmed-cleanup routes delay cancellation until cleanup settles and fail unconfirmed cleanup honestly', async () => {
  let cleanupStarted = false;
  let releaseCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const confirmedRoute: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    cancellation: { mode: 'confirmed-cleanup', cleanupTimeoutMs: 100 },
    execute(_request, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cleanupStarted = true;
            void cleanupGate.then(() => {
              const reason = signal.reason instanceof Error ? signal.reason : undefined;
              reject(new SliceRouteCancellationError('route cleanup confirmed', true, reason));
            });
          },
          { once: true },
        );
      });
    },
  };
  const confirmed = harness(confirmedRoute);
  const confirmedHandle = confirmed.coordinator.startCurrentPlate();
  await waitUntil(() => confirmedHandle.getStatus().phase === 'submitting');
  confirmedHandle.cancel('confirmed cancellation');
  await waitUntil(() => cleanupStarted);
  assert.equal(confirmedHandle.getStatus().phase, 'cancelling', 'terminal cancellation waits for cleanup');
  releaseCleanup?.();
  await assert.rejects(confirmedHandle.completion, SliceRouteCancellationError);
  assert.equal(confirmedHandle.getStatus().phase, 'cancelled');
  assert.equal(confirmedHandle.getStatus().cancellationConfirmed, true);

  const unconfirmedRoute: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    cancellation: { mode: 'confirmed-cleanup', cleanupTimeoutMs: 100 },
    execute(_request, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const reason = signal.reason instanceof Error ? signal.reason : undefined;
            reject(new SliceRouteCancellationError('remote DELETE was not confirmed', false, reason));
          },
          { once: true },
        );
      });
    },
  };
  const unconfirmed = harness(unconfirmedRoute);
  const unconfirmedHandle = unconfirmed.coordinator.startCurrentPlate();
  await waitUntil(() => unconfirmedHandle.getStatus().phase === 'submitting');
  unconfirmedHandle.cancel('unconfirmed cancellation');
  await assert.rejects(unconfirmedHandle.completion, SliceRouteCancellationError);
  assert.equal(unconfirmedHandle.getStatus().phase, 'failed');
  assert.equal(unconfirmedHandle.getStatus().cancellationConfirmed, false);
});

await test('confirmed-cleanup routes are bounded when an adapter never settles after abort', async () => {
  const route: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    cancellation: { mode: 'confirmed-cleanup', cleanupTimeoutMs: 5 },
    execute() {
      return new Promise(() => {});
    },
  };
  const setup = harness(route);
  const handle = setup.coordinator.startCurrentPlate();
  await waitUntil(() => handle.getStatus().phase === 'submitting');
  handle.cancel('adapter stalled');
  await assert.rejects(
    handle.completion,
    (error: unknown) => error instanceof SliceRouteCancellationError && !error.cancellationConfirmed,
  );
  assert.equal(handle.getStatus().phase, 'failed');
  assert.equal(handle.getStatus().cancellationConfirmed, false);
});

await test('route progress is bounded and projected with active plate and attempt context', async () => {
  const route: SliceRouteAdapterPort = {
    metadata: new RecordingRoute().metadata,
    async execute(request, _signal, onProgress) {
      onProgress?.({ percent: Number.NaN, message: '' });
      onProgress?.({ percent: 137, message: `Generating\n${'x'.repeat(300)}` });
      return responseFor(request);
    },
  };
  const setup = harness(route);
  const observed: ReturnType<typeof setup.coordinator.getActiveJobs>[number][] = [];
  setup.coordinator.subscribe((status) => observed.push(status));
  const handle = setup.coordinator.startCurrentPlate();
  await handle.completion;

  const progress = observed.find((status) => status.progressPercent !== undefined);
  assert.ok(progress);
  assert.equal(progress.phase, 'submitting');
  assert.equal(progress.activePlateId, setup.fixture.ids.plate);
  assert.equal(progress.attempt, 1);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.progressMessage?.includes('\n'), false);
  assert.equal(progress.progressMessage?.length, 160);
  assert.equal(handle.getStatus().progressPercent, undefined);
  assert.equal(handle.getStatus().progressMessage, undefined);
});

function responseFor(request: SliceRouteRequest): SliceRouteResponse {
  return {
    protocolVersion: SLICE_PROTOCOL_VERSION,
    jobId: request.jobId,
    plateId: request.plateId,
    inputHash: request.project.inputHash,
    engine: { ...request.engine },
    gcode: encoder.encode(`; canonical ${request.project.inputHash}\nG1 X1 Y1 E1\n`),
    warnings: ['engine warning'],
    statistics: { layers: 1, plate: request.plateId },
  };
}

function cloneRequest(request: SliceRouteRequest): SliceRouteRequest {
  return {
    ...request,
    project: { ...request.project, bytes: request.project.bytes.slice() },
    profiles: {
      references: request.profiles.references.map((reference) => ({ ...reference })),
      effectiveConfigHash: request.profiles.effectiveConfigHash,
    },
    engine: { ...request.engine },
  };
}

function assertOnePlateState(
  state: ProjectArchiveSnapshot['state'],
  plateId: ProjectArchiveSnapshot['state']['activePlateId'],
  objectId: ProjectArchiveSnapshot['state']['plates'][number]['objects'][number]['id'],
): void {
  assert.equal(state.activePlateId, plateId);
  assert.equal(state.plates.length, 1);
  assert.equal(state.plates[0].id, plateId);
  assert.equal(state.plates[0].order, 0);
  assert.deepEqual(
    state.plates[0].objects.map((object) => object.id),
    [objectId],
  );
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for test condition');
}

console.log(`\nCanonical slice pipeline: ${passed} tests passed.`);
