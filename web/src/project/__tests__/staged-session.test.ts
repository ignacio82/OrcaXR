import assert from 'node:assert/strict';
import { AsyncEditorSession, AsyncSessionError } from '../AsyncEditorSession';
import { ProjectSessionEndpoint } from '../ProjectSessionEndpoint';
import { LocalProjectSessionTransport, ProjectReceiptUnavailableError } from '../LocalProjectSessionTransport';
import { ProjectSessionClient, ProjectSessionClientError } from '../ProjectSessionClient';
import {
  decodeProjectSessionReply,
  encodeProjectSessionReply,
  encodeProjectSessionRequest,
  type ProjectSessionOperationWire,
} from '../../../../contracts/generated/project-intents';
import {
  captureInstanceCommand,
  capturePasteCommand,
  captureSmallIntent,
  singleStagedWork,
  transactionStagedWork,
  StagedInputError,
  type StagedProjectWork,
} from '../StagedProjectCommands';
import { EditorSession } from '../session';
import { InMemoryAssetRepository } from '../assets';
import { canonicalStringify, cloneJson } from '../domain/canonical';
import { entityId } from '../domain/ids';
import { intentText } from '../PreparedProjectCommands';
import { createProjectFixture } from './fixtures';
const nonce = [0, 1, 2147483648, 4294967295];
const hello = { hello: { minProtocolVersion: 1, maxProtocolVersion: 1, projectSchemaVersion: 1, intentVersion: 1 } };
const input = { maxUnits: 4_000_000, maxNodes: 1_000_000, maxDepth: 128 };
const limits = { maxResources: 4, maxCommands: 100, maxUnits: 8_000_000, maxAssetBytes: 0 };
const zero = { resources: 0, commands: 0, units: 0, assetBytes: 0 };
function setup(largeId = false) {
  const fixture = createProjectFixture();
  if (largeId) fixture.state.id = entityId<'project'>('import:large:' + 'a'.repeat(131072));
  const object = fixture.state.plates[0].objects[0]!;
  object.instances[0]!.extensionData = JSON.parse('{"__proto__":{"kept":"\\ud800"},"quote":"\\"😀"}');
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: {
      async serialize() {
        throw Error('unused');
      },
      async deserialize() {
        throw Error('unused');
      },
    },
  });
  const facade = new AsyncEditorSession(session),
    endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
  const transport = new LocalProjectSessionTransport(facade, nonce, 1);
  let sequence = 0;
  const request = (operation: ProjectSessionOperationWire) =>
    encodeProjectSessionRequest({ protocolVersion: 1, generation: nonce, requestId: ++sequence, operation });
  const send = async (operation: ProjectSessionOperationWire) =>
    decodeProjectSessionReply(await endpoint.handle(request(operation))).result;
  const command = (suffix: string) =>
    captureInstanceCommand(
      object.id,
      { ...cloneJson(object.instances[0]!), id: entityId<'instance'>(`import:instance:${suffix}`) },
      undefined,
      input,
    );
  const work = (suffix: string) => singleStagedWork(command(suffix));
  const stage = (value: StagedProjectWork) => endpoint.stage(value, facade.captureGuard());
  const intent = (name = 'edited') => ({
    version: 1,
    command: { renameObject: { objectId: intentText(object.id), name: intentText(name) } },
  });
  return { fixture, object, session, facade, endpoint, transport, request, send, command, work, stage, intent };
}
let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  console.log(`  ✓ ${name}`);
  passed++;
}
await test('record charges match complete UTF-16 argument encodings and exact budget edges', () => {
  const s = setup(),
    record = { ...cloneJson(s.object.instances[0]!), id: entityId<'instance'>('import:instance:measured') };
  for (const name of [undefined, '', '\u0000\ud800😀\\"', 'ordinary']) {
    if (name === undefined) delete record.name;
    else record.name = name;
    const units = canonicalStringify(['createInstance', s.object.id, record, null]).length;
    assert.equal(
      captureInstanceCommand(s.object.id, record, undefined, { ...input, maxUnits: units }).inputUnits,
      units,
    );
    assert.throws(
      () => captureInstanceCommand(s.object.id, record, undefined, { ...input, maxUnits: units - 1 }),
      StagedInputError,
    );
  }
  const ids = {
    objectId: entityId<'object'>('import:object:paste'),
    volumeIds: s.object.volumes.map((_, i) => entityId<'volume'>(`import:volume:${i}`)),
    instanceIds: s.object.instances.map((_, i) => entityId<'instance'>(`import:instance:${i}`)),
    layerRangeIds: s.object.layerRanges.map((_, i) => entityId<'layer-range'>(`import:range:${i}`)),
  };
  const expected = canonicalStringify([
    'pasteObject',
    s.object,
    ids.objectId,
    ids.volumeIds,
    ids.instanceIds,
    ids.layerRangeIds,
    null,
    ' named ',
  ]).length;
  assert.equal(
    capturePasteCommand(s.object, ids, undefined, ' named ', { ...input, maxUnits: expected }).inputUnits,
    expected,
  );
  assert.throws(
    () => capturePasteCommand(s.object, ids, undefined, ' named ', { ...input, maxUnits: expected - 1 }),
    StagedInputError,
  );
  const c = s.command('batch');
  const expectedBatch = canonicalStringify(['😀\ud800', []]).length + c.inputUnits;
  assert.equal(transactionStagedWork('😀\ud800', [c], expectedBatch).inputUnits, expectedBatch);
});
await test('capture refuses getter hooks, cycles, sparse input, nonfinite values and budget exhaustion', () => {
  const s = setup();
  let hits = 0;
  const record = cloneJson(s.object.instances[0]!);
  Object.defineProperty(record, 'name', {
    enumerable: true,
    get() {
      hits++;
      return 'changed';
    },
  });
  assert.throws(() => captureInstanceCommand(s.object.id, record, undefined, input), StagedInputError);
  assert.equal(hits, 0);
  const ids = {
    get objectId() {
      hits++;
      return entityId<'object'>('import:object:fake');
    },
  } as never;
  assert.throws(() => capturePasteCommand(s.object, ids, undefined, undefined, input), StagedInputError);
  assert.equal(hits, 0);
  const c = s.command('getter'),
    values = [c];
  Object.defineProperty(values, '0', {
    enumerable: true,
    get() {
      hits++;
      return c;
    },
  });
  assert.throws(() => transactionStagedWork('batch', values, input.maxUnits), StagedInputError);
  assert.equal(hits, 0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const data of [cycle, { bad: Infinity }, { sparse: new Array(2) }])
    assert.throws(
      () =>
        captureInstanceCommand(
          s.object.id,
          { ...s.object.instances[0]!, extensionData: data as never },
          undefined,
          input,
        ),
      StagedInputError,
    );
  for (const restricted of [
    { ...input, maxNodes: 1 },
    { ...input, maxDepth: 1 },
    { ...input, maxUnits: 1 },
  ])
    assert.throws(
      () => captureInstanceCommand(s.object.id, s.object.instances[0]!, undefined, restricted),
      StagedInputError,
    );
  singleStagedWork(c);
  assert.throws(() => singleStagedWork(c), StagedInputError);
});
await test('staging is explicitly enabled, budgets cover pending work, and IDs are never reused', async () => {
  const s = setup();
  assert.throws(
    () => s.stage(s.work('disabled')),
    (e) => e instanceof AsyncSessionError && e.code === 'resourceLimit',
  );
  s.endpoint.configureStaging({ ...limits, maxResources: 1 });
  await s.send(hello);
  const id = s.stage(s.work('first')),
    before = s.endpoint.stagingUsage();
  assert.equal(id, 1);
  assert.ok(before.units > 1);
  const pending = s.send({ executeStaged: { stagedId: id } });
  assert.deepEqual(s.endpoint.stagingUsage(), before);
  assert.throws(
    () => s.stage(s.work('overflow')),
    (e) => e instanceof AsyncSessionError && e.code === 'resourceLimit',
  );
  assert.throws(
    () => s.endpoint.configureStaging({ maxResources: 0, maxCommands: 0, maxUnits: 0, maxAssetBytes: 0 }),
    (e) => e instanceof AsyncSessionError && e.code === 'busy',
  );
  assert.deepEqual(await s.send({ releaseStaged: { stagedId: id } }), { released: false });
  assert.ok('acknowledged' in (await pending));
  assert.deepEqual(s.endpoint.stagingUsage(), zero);
  const next = s.stage(s.work('second'));
  assert.ok(next > id);
  assert.deepEqual(await s.send({ releaseStaged: { stagedId: next } }), { released: true });
  assert.deepEqual(await s.send({ releaseStaged: { stagedId: next } }), { released: false });
  assert.deepEqual(await s.send({ executeStaged: { stagedId: id } }), { error: 'invalidRequest' });
  assert.deepEqual(s.endpoint.stagingUsage(), zero);
});
await test('aggregate command and encoded-unit budgets reject before publication', () => {
  for (const budget of [
    { ...limits, maxCommands: 0 },
    { ...limits, maxUnits: 1 },
    { ...limits, maxResources: 0 },
  ]) {
    const s = setup(),
      before = canonicalStringify(s.session.project.getSnapshot().state);
    s.endpoint.configureStaging(budget);
    assert.throws(
      () => s.stage(s.work('refused')),
      (e) => e instanceof AsyncSessionError && e.code === 'resourceLimit',
    );
    assert.deepEqual(s.endpoint.stagingUsage(), zero);
    assert.equal(canonicalStringify(s.session.project.getSnapshot().state), before);
  }
});
await test('cancellation and close release queued payload charges before settlement', async () => {
  for (const close of [false, true]) {
    const s = setup();
    s.endpoint.configureStaging(limits);
    await s.send(hello);
    const id = s.stage(s.work('queued'));
    const queued = s.request({ executeStaged: { stagedId: id } });
    const pending = s.endpoint.handle(queued);
    const target = JSON.parse(queued).requestId;
    const control = s.send(close ? { close: {} } : { cancel: { targetRequestId: target } });
    assert.deepEqual(s.endpoint.stagingUsage(), zero);
    await control;
    assert.deepEqual(decodeProjectSessionReply(await pending).result, { error: close ? 'disposed' : 'cancelled' });
    assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 1);
  }
});
await test('guards bind preparation, foreign owners and history-only changes; selection does not retarget work', async () => {
  const s = setup(),
    foreign = setup();
  s.endpoint.configureStaging(limits);
  await s.send(hello);
  assert.throws(
    () => s.endpoint.stage(s.work('foreign'), foreign.facade.captureGuard()),
    (e) => e instanceof AsyncSessionError && e.code === 'stale',
  );
  const old = s.facade.captureGuard();
  s.session.commands.markCheckpoint();
  assert.throws(
    () => s.endpoint.stage(s.work('old'), old),
    (e) => e instanceof AsyncSessionError && e.code === 'stale',
  );
  const id = s.stage(s.work('checkpoint'));
  s.session.commands.markCheckpoint();
  assert.deepEqual(await s.send({ executeStaged: { stagedId: id } }), { error: 'stale' });
  assert.deepEqual(s.endpoint.stagingUsage(), zero);
  const accepted = s.stage(s.work('selection'));
  s.session.selection.set([{ kind: 'plate', id: s.fixture.ids.plate }]);
  assert.ok('acknowledged' in (await s.send({ executeStaged: { stagedId: accepted } })));
  assert.deepEqual(s.session.selection.getSnapshot().primary, { kind: 'instance', id: 'import:instance:selection' });
});
await test('a 70-instance staged batch remains one undo entry and a failed last member rolls back the batch', async () => {
  for (const fail of [false, true]) {
    const s = setup();
    s.transport.configureStaging(limits);
    const guard = s.facade.captureGuard();
    const before = canonicalStringify(s.session.project.getSnapshot().state);
    const commands = Array.from({ length: 70 }, (_, i) => s.command(`fill-${i}`));
    if (fail) commands.push(s.command('fill-0'));
    const work = transactionStagedWork('Fill 70 instances', commands, input.maxUnits);
    if (fail) {
      await assert.rejects(s.transport.executeStaged(work, { guard }));
      assert.equal(canonicalStringify(s.session.project.getSnapshot().state), before);
    } else {
      await s.transport.executeStaged(work, { guard });
      assert.equal(s.session.commands.getHistorySnapshot().undoCount, 1);
      assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 71);
      await s.transport.undo();
      assert.equal(canonicalStringify(s.session.project.getSnapshot().state), before);
      await s.transport.redo();
    }
    assert.deepEqual(s.transport.stagingUsage(), zero);
  }
});
await test('large records preserve metadata outside the request envelope without a new wire record format', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const record = {
    ...cloneJson(s.object.instances[0]!),
    id: entityId<'instance'>('import:instance:large'),
    extensionData: { text: 'x'.repeat(1_100_000) },
  };
  const c = captureInstanceCommand(s.object.id, record, undefined, input);
  assert.ok(c.inputUnits > 1_048_576);
  const work = singleStagedWork(c);
  record.extensionData.text = 'mutated';
  await s.transport.executeStaged(work, { guard });
  assert.equal(
    s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances[1]!.extensionData?.text,
    'x'.repeat(1_100_000),
  );
  assert.deepEqual(s.transport.stagingUsage(), zero);
});
await test('release control works at queue capacity without cancelling accepted work', async () => {
  const s = setup();
  s.endpoint.configureStaging(limits);
  await s.send(hello);
  const id = s.stage(s.work('ready'));
  const requests = Array.from({ length: 32 }, () => s.send({ query: {} }));
  const busy = s.send({ executeStaged: { stagedId: id } });
  const released = s.send({ releaseStaged: { stagedId: id } });
  assert.deepEqual(s.endpoint.stagingUsage(), zero);
  assert.deepEqual(await busy, { error: 'busy' });
  assert.deepEqual(await released, { released: true });
  await Promise.all(requests);
});
await test('client release uses its control lane and rejects malformed release replies', async () => {
  const s = setup();
  s.endpoint.configureStaging(limits);
  const client = new ProjectSessionClient((request) => s.endpoint.handle(request), nonce, 1);
  await client.submit({ query: {} }).result;
  const id = s.stage(s.work('client'));
  assert.equal(await client.releaseStaged(id), true);
  assert.equal(await client.releaseStaged(id), false);
  const other = setup();
  const broken = new ProjectSessionClient(
    async (request) => {
      const reply = decodeProjectSessionReply(await other.endpoint.handle(request));
      return encodeProjectSessionReply('released' in reply.result ? { ...reply, result: { closed: {} } } : reply);
    },
    nonce,
    1,
  );
  await assert.rejects(
    broken.releaseStaged(999),
    (e) => e instanceof ProjectSessionClientError && e.code === 'outcomeUnknown',
  );
});
await test('local failed pre-handshake submission releases unconsumed staged input', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const signal = new AbortController();
  const pending = s.transport.executeStaged(s.work('cancelled'), { guard, signal: signal.signal });
  signal.abort();
  assert.deepEqual(s.transport.stagingUsage(), zero);
  await assert.rejects(pending);
  assert.deepEqual(s.transport.stagingUsage(), zero);
});
await test('post-commit cancellation preserves the command and only releases its staging charge', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const signal = new AbortController();
  const unsubscribe = s.session.project.subscribe(() => signal.abort());
  await s.transport.executeStaged(s.work('committed'), { guard, signal: signal.signal });
  unsubscribe();
  assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 2);
  assert.deepEqual(s.transport.stagingUsage(), zero);
});
await test('staged guards support large persisted IDs and retain completed-without-summary outcomes', async () => {
  const s = setup(true);
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  await assert.rejects(s.transport.executeStaged(s.work('wide-project'), { guard }), ProjectReceiptUnavailableError);
  assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 2);
  assert.deepEqual(s.transport.stagingUsage(), zero);
});
await test('small intents can share a staged transaction while retaining their strict decoder', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const batch = transactionStagedWork(
    '',
    [s.command('mixed'), captureSmallIntent(s.intent('named'), input.maxUnits)],
    input.maxUnits,
  );
  await s.transport.executeStaged(batch, { guard });
  assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.name, 'named');
  assert.equal(s.session.commands.getHistorySnapshot().undoLabel, '');
  await s.transport.undo();
  assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 1);
});
await test('staged transport requires the pre-preparation guard and drops refused inputs', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const value = s.work('no-guard');
  await assert.rejects(
    s.transport.executeStaged(value, undefined as never),
    (e) => e instanceof AsyncSessionError && e.code === 'invalid-request',
  );
  assert.throws(
    () => s.endpoint.stage(value, guard),
    (e) => e instanceof AsyncSessionError && e.code === 'invalid-request',
  );
  const stale = s.work('prepared');
  s.session.commands.markCheckpoint();
  await assert.rejects(
    s.transport.executeStaged(stale, { guard }),
    (e) => e instanceof AsyncSessionError && e.code === 'stale',
  );
  assert.deepEqual(s.transport.stagingUsage(), zero);
});
await test('lost staged acknowledgement preserves committed work and releases later refused staging', async () => {
  const s = setup();
  s.transport.configureStaging(limits);
  const guard = s.facade.captureGuard();
  const endpoint = (s.transport as unknown as { endpoint: ProjectSessionEndpoint }).endpoint;
  const original = endpoint.handle.bind(endpoint);
  endpoint.handle = async (request) => {
    const result = await original(request);
    if (JSON.parse(request).operation.executeStaged) throw Error('lost reply');
    return result;
  };
  await assert.rejects(
    s.transport.executeStaged(s.work('lost'), { guard }),
    (e) => e instanceof ProjectSessionClientError && e.code === 'outcomeUnknown',
  );
  assert.equal(s.session.project.getSnapshot().state.plates[0]!.objects[0]!.instances.length, 2);
  assert.deepEqual(s.transport.stagingUsage(), zero);
  const newerGuard = s.facade.captureGuard();
  await assert.rejects(s.transport.executeStaged(s.work('refused'), { guard: newerGuard }));
  assert.deepEqual(s.transport.stagingUsage(), zero);
  assert.equal(s.session.commands.getHistorySnapshot().undoCount, 1);
});
console.log(`\n${passed} staged session tests passed.`);
