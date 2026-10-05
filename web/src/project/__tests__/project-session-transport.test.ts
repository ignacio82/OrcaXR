import assert from 'node:assert/strict';
import {
  decodeProjectSessionReply,
  decodeProjectSessionRequest,
  encodeProjectSessionRequest,
  type ProjectSessionOperationWire,
  type ProjectSessionResultWire,
} from '../../../../contracts/generated/project-intents';
import { AsyncEditorSession, AsyncSessionError } from '../AsyncEditorSession';
import { ProjectSessionEndpoint, wireSessionGuard } from '../ProjectSessionEndpoint';
import { ProjectSessionClient, ProjectSessionClientError } from '../ProjectSessionClient';
import { LocalProjectSessionTransport, ProjectReceiptUnavailableError } from '../LocalProjectSessionTransport';
import { intentText } from '../PreparedProjectCommands';
import { EditorSession } from '../session';
import { InMemoryAssetRepository } from '../assets';
import { RenameProjectCommand, ReplaceProjectCommand } from '../commands';
import { entityId } from '../domain/ids';
import { cloneProjectState } from '../domain/canonical';
import { createProjectFixture } from './fixtures';

const nonce = [0, 1, 2147483648, 4294967295];
const hello = { hello: { minProtocolVersion: 1, maxProtocolVersion: 1, projectSchemaVersion: 1, intentVersion: 1 } };
function setup(largeId = false) {
  const fixture = createProjectFixture();
  if (largeId) fixture.state.id = entityId<'project'>('import:large:' + 'a'.repeat(131072));
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: {
      async serialize() {
        throw new Error('unused');
      },
      async deserialize() {
        throw new Error('unused');
      },
    },
  });
  const facade = new AsyncEditorSession(session);
  const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
  let sequence = 0;
  const request = (operation: ProjectSessionOperationWire, id = ++sequence, generation = nonce, protocolVersion = 1) =>
    encodeProjectSessionRequest({ protocolVersion, generation, requestId: id, operation });
  const send = async (operation: ProjectSessionOperationWire) =>
    decodeProjectSessionReply(await endpoint.handle(request(operation))).result;
  const intent = (name = 'Wire plate') => ({
    version: 1,
    command: { renamePlate: { plateId: intentText(fixture.state.activePlateId), name: intentText(name) } },
  });
  const execute = (name?: string) => ({
    execute: { guard: wireSessionGuard(facade.captureGuard()), intent: intent(name) },
  });
  return { fixture, session, facade, endpoint, request, send, intent, execute };
}
function acknowledged(result: ProjectSessionResultWire) {
  assert.ok('acknowledged' in result);
  return result.acknowledged;
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('negotiates separate versions, rejects foreign generations, and bounds malformed error replies', async () => {
  const s = setup();
  assert.deepEqual(await s.send({ query: {} }), { error: 'notReady' });
  assert.deepEqual(await s.send({ hello: { ...hello.hello, intentVersion: 2 } }), { error: 'unsupportedVersion' });
  assert.deepEqual(decodeProjectSessionReply(await s.endpoint.handle(s.request(hello, 3, nonce, 2))).result, {
    error: 'unsupportedVersion',
  });
  assert.deepEqual(decodeProjectSessionReply(await s.endpoint.handle(s.request(hello, 3, [1, 1, 2, 3]))).result, {
    error: 'wrongSession',
  });
  assert.ok('welcome' in (await s.send(hello)));
  for (const raw of [
    'private invalid',
    ' '.repeat(1048577),
    '{"requestId":2,"requestId":2}',
    s.request({ query: {} }).replace('"query":{}', '"query":[]'),
  ]) {
    const reply = await s.endpoint.handle(raw);
    assert.ok(reply.length < 200);
    assert.deepEqual(decodeProjectSessionReply(reply).result, { error: 'invalidRequest' });
    assert.ok(!reply.includes('private'));
  }
  assert.equal(acknowledged(await s.send({ query: {} })).changed, false);
  s.session.dispose();
});
await test('one ordered connection rejects replay and out-of-order mutations without duplication', async () => {
  const s = setup();
  await s.send(hello);
  const text = s.request(s.execute());
  assert.equal(acknowledged(decodeProjectSessionReply(await s.endpoint.handle(text)).result).changed, true);
  assert.deepEqual(decodeProjectSessionReply(await s.endpoint.handle(text)).result, { error: 'duplicateRequest' });
  assert.deepEqual(decodeProjectSessionReply(await s.endpoint.handle(s.request({ query: {} }, 1))).result, {
    error: 'duplicateRequest',
  });
  assert.equal(s.session.commands.getHistorySnapshot().undoCount, 1);
  s.session.dispose();
});
await test('queued commands bind revision, asset and history identity and queries remain ordered', async () => {
  const s = setup();
  await s.send(hello);
  const first = s.send(s.execute('First'));
  const second = s.send(s.execute('Second'));
  const query = s.send({ query: {} });
  assert.equal(acknowledged(await first).changed, true);
  assert.deepEqual(await second, { error: 'stale' });
  const receipt = acknowledged(await query);
  assert.equal(receipt.changed, false);
  assert.equal(receipt.history.undoCount, 1);
  const stale = s.send(s.execute('Stale'));
  s.session.commands.clearHistory();
  assert.deepEqual(await stale, { error: 'stale' });
  const asset = s.send(s.execute('Stale assets'));
  s.session.assets.remove(s.fixture.ids.asset);
  assert.deepEqual(await asset, { error: 'stale' });
  s.session.dispose();
});
await test('cancellation and close settle pending mutations before commit and never dispose assets', async () => {
  for (const close of [false, true]) {
    const s = setup();
    await s.send(hello);
    const before = s.session.project.getSnapshot();
    const assets = s.session.assets.captureInternal();
    const text = s.request(s.execute());
    const id = decodeProjectSessionRequest(text).requestId;
    const pending = s.endpoint.handle(text);
    assert.deepEqual(
      await s.send(close ? { close: {} } : { cancel: { targetRequestId: id } }),
      close ? { closed: {} } : { cancelled: 'requested' },
    );
    assert.deepEqual(decodeProjectSessionReply(await pending).result, { error: close ? 'disposed' : 'cancelled' });
    assert.deepEqual(s.session.project.getSnapshot(), before);
    assert.equal(s.session.assets.captureInternal(), assets);
    assert.deepEqual(
      await s.send(close ? { query: {} } : { cancel: { targetRequestId: id } }),
      close ? { error: 'disposed' } : { cancelled: 'notPending' },
    );
    s.session.dispose();
  }
});
await test('close and cancellation requested by a commit observer cannot retract acknowledgement', async () => {
  const s = setup();
  await s.send(hello);
  s.session.commands.subscribeHistory(() => s.endpoint.dispose());
  const receipt = acknowledged(await s.send(s.execute()));
  assert.equal(receipt.changed, true);
  assert.equal(receipt.history.undoCount, 1);
  assert.deepEqual(await s.send({ query: {} }), { error: 'disposed' });
  s.session.dispose();
});
await test('endpoint backpressure retains a control lane and recovers', async () => {
  const s = setup();
  await s.send(hello);
  const pending = Array.from({ length: 32 }, () => s.send({ query: {} }));
  assert.deepEqual(await s.send({ query: {} }), { error: 'busy' });
  await Promise.all(pending);
  assert.equal(acknowledged(await s.send({ query: {} })).changed, false);
  s.session.dispose();
});
await test('bounded history labels preserve UTF-16 and canonical history remains complete', async () => {
  const s = setup();
  await s.send(hello);
  const label = '\ud800'.repeat(300);
  s.session.execute(new ReplaceProjectCommand(cloneProjectState(s.fixture.state), label));
  const result = acknowledged(await s.send({ query: {} }));
  assert.equal(result.history.undoLabel.truncated, true);
  assert.deepEqual(result.history.undoLabel.text, Array(256).fill(55296));
  assert.equal(s.session.commands.getHistorySnapshot().undoLabel, label);
  s.session.dispose();
});
await test('undo with an oversized restored identity reports completed outcome without pretending rollback', async () => {
  const s = setup(true);
  const short = cloneProjectState(s.fixture.state);
  short.id = entityId<'project'>('import:small:id');
  s.session.execute(new ReplaceProjectCommand(short));
  await s.send(hello);
  const result = await s.send({ undo: wireSessionGuard(s.facade.captureGuard()) });
  assert.deepEqual(result, { receiptUnavailable: true });
  assert.equal(s.session.project.getSnapshot().state.id, s.fixture.state.id);
  assert.equal(s.session.commands.getHistorySnapshot().redoCount, 1);
  s.session.dispose();
});
await test('client and local bridge preserve completed outcomes when a restored summary cannot fit', async () => {
  for (const local of [false, true]) {
    const s = setup(true);
    const short = cloneProjectState(s.fixture.state);
    short.id = entityId<'project'>('import:small:id');
    s.session.execute(new ReplaceProjectCommand(short));
    if (local) {
      const bridge = new LocalProjectSessionTransport(s.facade, nonce, 1);
      await assert.rejects(
        bridge.undo(),
        (error: unknown) => error instanceof ProjectReceiptUnavailableError && error.changed,
      );
      bridge.dispose();
    } else {
      const client = new ProjectSessionClient((text) => s.endpoint.handle(text), nonce, 1);
      const result = await client.submit({ undo: wireSessionGuard(s.facade.captureGuard()) }).result;
      assert.ok('receiptUnavailable' in result && result.receiptUnavailable);
      await client.close();
    }
    assert.equal(s.session.project.getSnapshot().state.id, s.fixture.state.id);
    assert.equal(s.session.commands.getHistorySnapshot().redoCount, 1);
    s.session.dispose();
  }
});
await test('client captures operations before handshake, preserves immutable receipts and supports undo/redo', async () => {
  const s = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const messages: string[] = [];
  const client = new ProjectSessionClient(
    async (text) => {
      messages.push(text);
      const reply = await s.endpoint.handle(text);
      if ('hello' in decodeProjectSessionRequest(text).operation) await gate;
      return reply;
    },
    nonce,
    1,
  );
  const operation = s.execute('Captured \ud800');
  const result = client.submit(operation).result;
  operation.execute.intent.command.renamePlate.name.fill(65);
  release();
  const receipt = await result;
  assert.ok('acknowledged' in receipt);
  assert.equal(s.session.project.getSnapshot().state.plates[0].name, 'Captured \ud800');
  assert.ok(Object.isFrozen(receipt.acknowledged.history.undoLabel.text));
  const undo = await client.submit({ undo: receipt.acknowledged.guard }).result;
  assert.ok('acknowledged' in undo);
  assert.equal(undo.acknowledged.changed, true);
  const redo = await client.submit({ redo: undo.acknowledged.guard }).result;
  assert.ok('acknowledged' in redo);
  assert.equal(redo.acknowledged.changed, true);
  assert.deepEqual(
    messages.map((text) => decodeProjectSessionRequest(text).requestId),
    [1, 2, 3, 4],
  );
  await client.close();
  s.session.dispose();
});
await test('pending handshake does not rebase mutations and bounds client work before dispatch', async () => {
  const s = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new ProjectSessionClient(
    async (text) => {
      const reply = await s.endpoint.handle(text);
      if ('hello' in decodeProjectSessionRequest(text).operation) await gate;
      return reply;
    },
    nonce,
    1,
  );
  const stale = client.submit(s.execute()).result;
  const pending = Array.from({ length: 31 }, () => client.submit({ query: {} }).result);
  await assert.rejects(client.submit({ query: {} }).result, { code: 'busy' });
  s.session.execute(new RenameProjectCommand('Intervening'));
  release();
  await assert.rejects(stale, { code: 'stale' });
  await Promise.all(pending);
  await client.close();
  s.session.dispose();
});
await test('client cancellation before dispatch prevents sending, and close rejects waiting requests', async () => {
  for (const close of [false, true]) {
    const s = setup();
    const messages: string[] = [];
    const client = new ProjectSessionClient(
      (text) => {
        messages.push(text);
        return s.endpoint.handle(text);
      },
      nonce,
      1,
    );
    const ticket = client.submit(s.execute());
    if (close) await client.close();
    else assert.equal(await ticket.cancel(), 'requested');
    await assert.rejects(ticket.result, { code: close ? 'disposed' : 'cancelled' });
    assert.ok(messages.every((text) => !('execute' in decodeProjectSessionRequest(text).operation)));
    assert.equal(s.session.commands.getHistorySnapshot().undoCount, 0);
    s.session.dispose();
  }
});
await test('client sends bounded cancellation messages and uses the operation reply as final authority', async () => {
  const s = setup();
  const messages: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new ProjectSessionClient(
    async (text) => {
      messages.push(text);
      const reply = await s.endpoint.handle(text);
      if ('execute' in decodeProjectSessionRequest(text).operation) await gate;
      return reply;
    },
    nonce,
    1,
  );
  await client.submit({ query: {} }).result;
  const ticket = client.submit(s.execute());
  await Promise.resolve();
  const cancel = ticket.cancel();
  release();
  await cancel;
  await assert.rejects(ticket.result, { code: 'cancelled' });
  assert.equal(s.session.commands.getHistorySnapshot().undoCount, 0);
  assert.ok(messages.some((text) => 'cancel' in decodeProjectSessionRequest(text).operation));
  s.session.dispose();
});
await test('a completed edit stays successful when cancellation and close overtake its delayed reply', async () => {
  const s = setup();
  let release!: () => void;
  let committed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commitment = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const client = new ProjectSessionClient(
    async (text) => {
      const response = await s.endpoint.handle(text);
      if ('execute' in decodeProjectSessionRequest(text).operation) {
        committed();
        await gate;
      }
      return response;
    },
    nonce,
    1,
  );
  const ticket = client.submit(s.execute());
  await commitment;
  assert.equal(await ticket.cancel(), 'notPending');
  await client.close();
  release();
  const receipt = await ticket.result;
  assert.ok('acknowledged' in receipt && receipt.acknowledged.changed);
  assert.equal(s.session.commands.getHistorySnapshot().undoCount, 1);
  s.session.dispose();
});
await test('client rejects incompatible handshakes before transmitting any mutation', async () => {
  const s = setup();
  let sent = 0;
  const client = new ProjectSessionClient(
    (text) => {
      sent++;
      return s.endpoint.handle(text);
    },
    nonce,
    2,
  );
  await assert.rejects(client.submit(s.execute()).result, { code: 'unsupportedVersion' });
  assert.equal(sent, 1);
  s.session.dispose();
});
await test('malformed, foreign and lost replies are uncertain outcomes with no automatic retry', async () => {
  for (const kind of ['malformed', 'generation', 'requestId', 'result', 'history', 'lost']) {
    const s = setup();
    let mutations = 0;
    const client = new ProjectSessionClient(
      async (text) => {
        const request = decodeProjectSessionRequest(text);
        const raw = await s.endpoint.handle(text);
        if (!('execute' in request.operation)) return raw;
        mutations++;
        if (kind === 'lost') throw new Error('private failure');
        if (kind === 'malformed') return 'private invalid';
        const reply = JSON.parse(raw);
        if (kind === 'generation') reply.generation = [9, 9, 9, 9];
        if (kind === 'requestId') reply.requestId++;
        if (kind === 'result') reply.result = { closed: {} };
        if (kind === 'history') reply.result.acknowledged.history.dirtyCategories = ['projectData', 'projectData'];
        return JSON.stringify(reply);
      },
      nonce,
      1,
    );
    await assert.rejects(
      client.submit(s.execute()).result,
      (error: unknown) =>
        error instanceof ProjectSessionClientError &&
        error.code === 'outcomeUnknown' &&
        !error.message.includes('private'),
    );
    await assert.rejects(client.submit({ query: {} }).result, { code: 'outcomeUnknown' });
    assert.equal(mutations, 1);
    assert.equal(s.session.commands.getHistorySnapshot().undoCount, 1);
    s.session.dispose();
  }
});
await test('local bridge preserves owner guards, captured history and atomic rollback without copying assets', async () => {
  const s = setup();
  const bridge = new LocalProjectSessionTransport(s.facade, nonce, 1);
  const foreign = new AsyncEditorSession(s.session);
  await assert.rejects(
    bridge.executeIntent(s.intent(), { guard: foreign.captureGuard() }),
    (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale',
  );
  const assets = s.session.assets.captureInternal();
  const before = s.session.project.getSnapshot();
  const command = s.intent().command;
  await assert.rejects(
    bridge.transactionIntents({
      version: 1,
      label: intentText('Rollback'),
      commands: [command, { deletePlate: { plateId: intentText(s.fixture.state.activePlateId) } }],
    }),
    { code: 'commandFailed' },
  );
  assert.deepEqual(s.session.project.getSnapshot().state, before.state);
  assert.equal(s.session.commands.getHistorySnapshot().undoCount, 0);
  const receipt = await bridge.executeIntent(s.intent());
  assert.ok(s.facade.isCurrent(receipt.guard));
  assert.equal((await bridge.undo()).value, true);
  assert.equal((await bridge.redo()).value, true);
  assert.equal(s.session.assets.captureInternal(), assets);
  bridge.dispose();
  foreign.dispose();
  s.session.dispose();
});
await test('oversized and getter payloads never execute and subsequent valid requests recover', async () => {
  const s = setup();
  const client = new ProjectSessionClient((text) => s.endpoint.handle(text), nonce, 1);
  let getters = 0;
  const invalid = {
    get query() {
      getters++;
      return {};
    },
  };
  await assert.rejects(client.submit(invalid).result, { code: 'invalidRequest' });
  assert.equal(getters, 0);
  const large = s.execute();
  large.execute.intent.command.renamePlate.name = Array(131072).fill(65);
  await assert.rejects(client.submit(large).result, { code: 'invalidRequest' });
  const completed = await client.submit(s.execute()).result;
  assert.ok('acknowledged' in completed);
  await client.close();
  s.session.dispose();
});
await test('underlying disposal blocks negotiation and sanitized failures reveal no private command diagnostics', async () => {
  const s = setup();
  s.session.dispose();
  assert.deepEqual(await s.send(hello), { error: 'disposed' });
  const live = setup();
  await live.send(hello);
  const operation = live.execute();
  operation.execute.intent.command.renamePlate.plateId = intentText('import:private:missing');
  const reply = await live.endpoint.handle(live.request(operation));
  assert.deepEqual(decodeProjectSessionReply(reply).result, { error: 'commandFailed' });
  assert.ok(!reply.includes('private'));
  live.session.dispose();
});
console.log(`Project session transport: ${passed} lifecycle and ownership regressions passed.`);
