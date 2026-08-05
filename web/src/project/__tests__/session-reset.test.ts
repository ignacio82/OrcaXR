import assert from 'node:assert/strict';

import {
  EditorSession,
  InMemoryAssetRepository,
  RenameProjectCommand,
  UuidIdSource,
  cloneProjectState,
  createEmptyProject,
  seededRandom,
  type ProjectArchiveSnapshot,
  type ProjectSerializerPort,
  type SerializedProject,
} from '..';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class MemorySerializer implements ProjectSerializerPort {
  async serialize(snapshot: ProjectArchiveSnapshot): Promise<SerializedProject> {
    return {
      bytes: new TextEncoder().encode(JSON.stringify(snapshot.state)),
      mediaType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      suggestedFilename: 'reset-fixture.3mf',
      sourceRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
    };
  }

  async deserialize(): Promise<never> {
    throw new Error('Not used by reset tests');
  }
}

function createPopulatedSession() {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const session = new EditorSession({
    initialState: fixture.state,
    assets,
    serializer: new MemorySerializer(),
  });
  session.selection.set([{ kind: 'instance', id: fixture.ids.instance }], {
    kind: 'instance',
    id: fixture.ids.instance,
  });
  session.execute(new RenameProjectCommand('First dirty name'));
  session.execute(new RenameProjectCommand('Second dirty name'));
  assert.equal(session.undo(), true);
  assert.deepEqual(session.commands.getHistorySnapshot(), {
    undoCount: 1,
    redoCount: 1,
    undoLabel: 'Rename project to First dirty name',
    redoLabel: 'Rename project to Second dirty name',
    dirtyCategories: ['projectData'],
  });
  return { fixture, session };
}

function sessionFootprint(session: EditorSession) {
  return {
    project: session.project.getSnapshot(),
    assets: session.assets.list(),
    selection: session.selection.getSnapshot(),
    history: session.commands.getHistorySnapshot(),
  };
}

await test('validates project state and the complete asset bundle before mutating reset authority', () => {
  const { fixture, session } = createPopulatedSession();
  const before = sessionFootprint(session);

  const invalidState = cloneProjectState(fixture.state);
  invalidState.name = '   ';
  assert.throws(() => session.reset(invalidState, { entries: [fixture.asset] }), /Invalid project state/);
  assert.deepEqual(sessionFootprint(session), before);

  const validStateWithRequiredAsset = cloneProjectState(fixture.state);
  validStateWithRequiredAsset.name = 'Valid replacement';
  assert.throws(
    () => session.reset(validStateWithRequiredAsset),
    new RegExp(`missing source asset ${fixture.ids.asset}`),
  );
  assert.deepEqual(sessionFootprint(session), before);

  session.dispose();
});

await test('replaces state, assets, and selection and establishes an empty clean history root', () => {
  const { fixture, session } = createPopulatedSession();
  const before = session.project.getSnapshot();
  const replacement = createEmptyProject({
    idSource: new UuidIdSource(seededRandom(0x5eed)),
    now: '2026-07-25T00:00:00.000Z',
    name: 'Fresh reset target',
    firstPlateName: 'Fresh plate',
    toolCount: 3,
  });
  replacement.config = { printable_area: ['0x0', '300x0', '300x300', '0x300'] };

  session.reset(replacement);

  const after = session.project.getSnapshot();
  assert.ok(after.revision > before.revision);
  assert.notEqual(after.state.id, fixture.ids.project);
  assert.deepEqual(after.state, replacement);
  assert.deepEqual(session.assets.list(), []);
  assert.deepEqual(session.selection.getSnapshot(), { refs: [] });
  assert.deepEqual(session.commands.getHistorySnapshot(), {
    undoCount: 0,
    redoCount: 0,
    undoLabel: undefined,
    redoLabel: undefined,
    dirtyCategories: [],
  });
  assert.equal(session.commands.isDirty(), false);
  assert.equal(session.undo(), false);
  assert.equal(session.redo(), false);

  session.execute(new RenameProjectCommand('Edit after reset'));
  assert.equal(session.commands.isDirty(), true);
  assert.equal(session.undo(), true);
  assert.equal(session.commands.isDirty(), false, 'undoing to the reset checkpoint must be clean');
  assert.equal(session.project.getSnapshot().state.name, replacement.name);

  session.dispose();
});

console.log(`\nEditor session reset: ${passed} tests passed.`);
