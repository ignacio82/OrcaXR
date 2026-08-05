import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectValidationError,
  ProjectStore,
  SelectionStore,
  SetInstanceTransformsCommand,
  canonicalStringify,
  cloneProjectState,
  entityId,
  identityTransform,
  type InstanceId,
  type Transform,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const initial = cloneProjectState(fixture.state);
  const secondId = entityId<'instance'>('import:batch-transform:second');
  initial.plates[0].objects[0].instances.push({
    id: secondId,
    name: 'Second instance',
    transform: { ...identityTransform(), translationMm: [20, 0, 0] },
    printable: true,
  });
  const project = new ProjectStore(initial);
  const selection = new SelectionStore();
  selection.set([
    { kind: 'instance', id: fixture.ids.instance },
    { kind: 'instance', id: secondId },
  ]);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection, assets });
  bus.markCheckpoint();
  return { fixture, secondId, initial, project, selection, bus };
}

function moved(x: number, y: number, z: number): Transform {
  return { ...identityTransform(), translationMm: [x, y, z] };
}

function transformOf(project: ProjectStore, id: InstanceId): Transform {
  for (const plate of project.getSnapshot().state.plates) {
    for (const object of plate.objects) {
      const instance = object.instances.find((candidate) => candidate.id === id);
      if (instance) return instance.transform;
    }
  }
  throw new Error(`Missing test instance ${id}`);
}

test('transforms an exact multi-instance set atomically with byte-exact undo/redo and stable selection', () => {
  const { fixture, secondId, initial, project, selection, bus } = harness();
  const selectionBefore = selection.getSnapshot();
  const before = canonicalStringify(initial);
  bus.execute(
    new SetInstanceTransformsCommand([
      { instanceId: secondId, transform: moved(32, 7, 1) },
      { instanceId: fixture.ids.instance, transform: moved(12, 4, 3) },
    ]),
  );

  assert.deepEqual(transformOf(project, fixture.ids.instance), moved(12, 4, 3));
  assert.deepEqual(transformOf(project, secondId), moved(32, 7, 1));
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.getHistorySnapshot().undoLabel, 'Transform 2 instances');

  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.deepEqual(selection.getSnapshot(), selectionBefore);
  assert.equal(bus.redo(), true);
  assert.deepEqual(transformOf(project, secondId), moved(32, 7, 1));
});

test('omits complete no-ops and rejects duplicate, missing, or invalid inputs without partial mutation', () => {
  const { fixture, secondId, project, bus } = harness();
  const before = canonicalStringify(project.getSnapshot().state);
  bus.execute(
    new SetInstanceTransformsCommand([
      { instanceId: fixture.ids.instance, transform: transformOf(project, fixture.ids.instance) },
      { instanceId: secondId, transform: transformOf(project, secondId) },
    ]),
  );
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
  assert.equal(project.getSnapshot().revision, 0);

  assert.throws(
    () =>
      new SetInstanceTransformsCommand([
        { instanceId: secondId, transform: moved(1, 2, 3) },
        { instanceId: secondId, transform: moved(4, 5, 6) },
      ]),
    /duplicate instance/i,
  );
  assert.throws(
    () =>
      bus.execute(
        new SetInstanceTransformsCommand([
          { instanceId: fixture.ids.instance, transform: moved(8, 8, 8) },
          { instanceId: entityId<'instance'>('import:batch-transform:missing'), transform: moved(1, 1, 1) },
        ]),
      ),
    /unknown instance/i,
  );
  assert.throws(
    () =>
      bus.execute(
        new SetInstanceTransformsCommand([
          {
            instanceId: fixture.ids.instance,
            transform: { ...identityTransform(), scale: [1, 0, 1] },
          },
          { instanceId: secondId, transform: moved(9, 9, 9) },
        ]),
      ),
    (error: unknown) =>
      error instanceof ProjectValidationError &&
      error.issues.some((issue) => /transform scale cannot contain zero/i.test(issue.message)),
  );
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
  assert.equal(bus.getHistorySnapshot().undoCount, 0);
});

test('coalesces one streamed multi-instance gesture across reordered inputs and preserves its origin', () => {
  const { fixture, secondId, initial, project, bus } = harness();
  const first = [
    { instanceId: fixture.ids.instance, transform: moved(5, 0, 0) },
    { instanceId: secondId, transform: moved(25, 0, 0) },
  ] as const;
  const final = [
    { instanceId: secondId, transform: moved(35, 10, 0) },
    { instanceId: fixture.ids.instance, transform: moved(15, 10, 0) },
  ] as const;
  bus.execute(new SetInstanceTransformsCommand(first, 'pointer-7'));
  bus.execute(new SetInstanceTransformsCommand(final, 'pointer-7'));
  assert.equal(bus.getHistorySnapshot().undoCount, 1);
  assert.deepEqual(transformOf(project, fixture.ids.instance), moved(15, 10, 0));
  assert.deepEqual(transformOf(project, secondId), moved(35, 10, 0));
  assert.equal(bus.undo(), true);
  assert.equal(canonicalStringify(project.getSnapshot().state), canonicalStringify(initial));
  assert.equal(bus.redo(), true);
  assert.deepEqual(transformOf(project, secondId), moved(35, 10, 0));
});

test('defensively snapshots caller-owned transforms', () => {
  const { fixture, project, bus } = harness();
  const callerTranslation: [number, number, number] = [7, 8, 9];
  const transform: Transform = { ...identityTransform(), translationMm: callerTranslation };
  const command = new SetInstanceTransformsCommand([{ instanceId: fixture.ids.instance, transform }]);
  callerTranslation[0] = 999;
  bus.execute(command);
  assert.deepEqual(transformOf(project, fixture.ids.instance), moved(7, 8, 9));
});

console.log(`\nCanonical batch transforms: ${passed} tests passed.`);
