import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  captureProjectIntent,
  decodeProjectIntent,
  decodeProjectBatch,
  encodeProjectIntent,
  encodeProjectBatch,
  PROJECT_INTENT_MAX_BYTES,
  PROJECT_INTENT_MAX_NODES,
} from '../../../../contracts/generated/project-intents';
import { InvalidProjectIntent } from '../../../../contracts/runtime/project-intents';
import { intentText, prepareProjectIntent, createIntentTextEncoder } from '../PreparedProjectCommands';
import { AsyncEditorSession, EditorSession, InMemoryAssetRepository } from '..';
import { createProjectFixture } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../testdata/cross-platform/project-intent-vectors.json', import.meta.url), 'utf8'),
);
for (const row of fixture.cases) {
  const decode =
    row.kind === 'Batch'
      ? (raw: string) => JSON.parse(encodeProjectBatch(decodeProjectBatch(raw)))
      : (raw: string) => JSON.parse(encodeProjectIntent(decodeProjectIntent(raw)));
  if (row.expected === null) assert.throws(() => decode(row.input), InvalidProjectIntent, row.label);
  else assert.deepEqual(decode(row.input), row.expected, row.label);
}
const value = { version: 1, command: { deletePlate: { plateId: intentText('import:fixture:private') } } };
const captured = captureProjectIntent(value);
value.command.deletePlate.plateId[0] = 0;
assert.notDeepEqual(captured, value);
assert.ok(Object.isFrozen(captured));
assert.ok(Object.isFrozen(captured.command));
assert.ok('deletePlate' in captured.command && Object.isFrozen(captured.command.deletePlate.plateId));
let calls = 0;
for (const malformed of [
  Object.assign(Object.create({}), { version: 1, command: value.command }),
  {
    get version() {
      calls++;
      return 1;
    },
    command: value.command,
  },
  { version: 1, command: value.command, [Symbol('private')]: true },
  { version: 1, command: { deletePlate: { plateId: Object.assign(Array(2), { 1: 65 }) } } },
  { version: 1, command: { deletePlate: { plateId: Object.assign([65], { extra: 1 }) } } },
  { version: 1, command: { deletePlate: { plateId: new Uint16Array([65]) } } },
  {
    version: 1,
    command: {
      deletePlate: {
        plateId: Object.defineProperty([65], '0', {
          get() {
            calls++;
            return 65;
          },
        }),
      },
    },
  },
  { version: 1, command: { deletePlate: { plateId: Object.assign([65], { [Symbol('private')]: 1 }) } } },
])
  assert.throws(() => captureProjectIntent(malformed), InvalidProjectIntent);
assert.equal(calls, 0);
assert.throws(() => decodeProjectIntent(' '.repeat(PROJECT_INTENT_MAX_BYTES + 1)), InvalidProjectIntent);
assert.throws(
  () =>
    decodeProjectIntent(
      JSON.stringify({ version: 1, command: { deletePlate: { plateId: Array(PROJECT_INTENT_MAX_NODES).fill(65) } } }),
    ),
  InvalidProjectIntent,
);
assert.throws(
  () => prepareProjectIntent({ version: 1, command: { deletePlate: { plateId: intentText('private-invalid-id') } } }),
  (error) => error instanceof InvalidProjectIntent && !error.message.includes('private'),
);

assert.throws(
  () => decodeProjectIntent('{"' + 'x'.repeat(PROJECT_INTENT_MAX_BYTES - 16) + '":0}'),
  InvalidProjectIntent,
);

const allUnits = Array.from({ length: 65536 }, (_, index) => index);
const unitRequest = { version: 1, command: { deletePlate: { plateId: allUnits } } };
assert.deepEqual(decodeProjectIntent(encodeProjectIntent(unitRequest)), unitRequest);
const wide = {
  version: 1,
  command: {
    duplicatePlate: {
      sourcePlateId: [65],
      plateId: [65],
      customGcodeIds: [],
      thumbnailIds: [],
      objects: Array.from({ length: 18000 }, () => ({
        objectId: [65],
        volumeIds: [],
        instanceIds: [],
        layerRangeIds: [],
      })),
    },
  },
};
assert.ok(JSON.stringify(wide).length > PROJECT_INTENT_MAX_BYTES);
assert.throws(() => captureProjectIntent(wide), InvalidProjectIntent);

assert.throws(() => intentText('a'.repeat(PROJECT_INTENT_MAX_NODES)), InvalidProjectIntent);
const textEncoder = createIntentTextEncoder();
textEncoder('a'.repeat(PROJECT_INTENT_MAX_NODES - 2));
assert.throws(() => textEncoder('b'), InvalidProjectIntent);

function setup(order = 0) {
  const source = createProjectFixture();
  source.state.plates[0].order = order;
  const assets = new InMemoryAssetRepository();
  assets.put(source.asset.descriptor, source.asset.bytes);
  const session = new EditorSession({
    initialState: source.state,
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
  return { session, gateway: new AsyncEditorSession(session), source };
}
{
  const { session, gateway, source } = setup();
  const assets = session.assets.captureInternal();
  const wire = {
    version: 1,
    command: { renamePlate: { plateId: intentText(source.state.activePlateId), name: intentText('Captured \ud800') } },
  };
  const pending = gateway.executeIntent(wire);
  wire.command.renamePlate.name.fill(65);
  const acknowledgement = await pending;
  assert.equal(session.project.getSnapshot().state.plates[0].name, 'Captured \ud800');
  assert.equal(acknowledgement.history.undoCount, 1);
  await gateway.undo();
  await gateway.redo();
  assert.equal(session.project.getSnapshot().state.plates[0].name, 'Captured \ud800');
  assert.equal(session.assets.captureInternal(), assets);
  const before = session.project.getSnapshot();
  const cancelled = { aborted: false };
  const request = gateway.executeIntent(
    {
      version: 1,
      command: { setPlatePrintable: { plateId: intentText(source.state.activePlateId), printable: false } },
    },
    { cancellation: cancelled },
  );
  cancelled.aborted = true;
  await assert.rejects(request, { code: 'cancelled' });
  assert.deepEqual(session.project.getSnapshot(), before);
  session.dispose();
}
{
  const { session, gateway, source } = setup();
  const plateId = intentText(source.state.activePlateId);
  const assets = session.assets.captureInternal();
  const before = session.project.getSnapshot();
  const selection = session.selection.getSnapshot();
  const commands = [{ renamePlate: { plateId, name: intentText('Temporary') } }, { deletePlate: { plateId } }];
  await assert.rejects(gateway.transactionIntents({ version: 1, label: intentText('Rollback'), commands }));
  assert.deepEqual(session.project.getSnapshot().state, before.state);
  assert.ok(session.project.getSnapshot().revision > before.revision);
  assert.deepEqual(session.selection.getSnapshot(), selection);
  assert.equal(session.assets.captureInternal(), assets);
  assert.equal(session.commands.getHistorySnapshot().undoCount, 0);
  await gateway.transactionIntents({
    version: 1,
    label: intentText('Atomic'),
    commands: [commands[0], { setPlatePrintable: { plateId, printable: false } }],
  });
  assert.equal(session.commands.getHistorySnapshot().undoCount, 1);
  await gateway.undo();
  assert.deepEqual(session.project.getSnapshot().state, before.state);
  await gateway.redo();
  assert.equal(session.project.getSnapshot().state.plates[0].name, 'Temporary');
  const guard = gateway.captureGuard();
  await gateway.transactionIntents({ version: 1, label: intentText('Empty'), commands: [] });
  assert.deepEqual(gateway.captureGuard(), guard);
  session.dispose();
}
{
  const { session, gateway } = setup(Number.MAX_SAFE_INTEGER);
  const before = session.project.getSnapshot();
  await gateway.executeIntent({
    version: 1,
    command: {
      addPlate: {
        plateId: intentText('import:fixture:large-order'),
        name: intentText('Large order'),
        order: Number.MAX_SAFE_INTEGER + 1,
        activate: false,
      },
    },
  });
  assert.equal(session.project.getSnapshot().state.plates[1].order, Number.MAX_SAFE_INTEGER + 1);
  await gateway.undo();
  assert.deepEqual(session.project.getSnapshot().state, before.state);
  session.dispose();
}

console.log(
  `Project intents: ${fixture.cases.length} wire cases, strict object/resource ownership, cancellation and atomic execution passed.`,
);
