import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createProjectFixture, type ProjectFixture } from '../../project/__tests__/fixtures';
import { projectFingerprint } from '../../project/domain/canonical';
import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import { CanonicalWorkspaceController, StaleCanonicalFilamentAssignmentError } from '../CanonicalWorkspaceController';

const NOW = '2026-07-23T12:00:00.000Z';
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    const id = `import:filament-controller-test:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    return id;
  }
}

async function openFixture(): Promise<{
  fixture: ProjectFixture;
  controller: CanonicalWorkspaceController;
}> {
  const fixture = createProjectFixture();
  const serialized = await new Bbs3mfProjectSerializer().serialize({
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 0,
    sourceHash: projectFingerprint(fixture.state),
  });
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    toolCount: 2,
    projectImportParser: new BbsProjectImportParser(),
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
  await controller.openCanonical3mf(serialized.bytes);
  return { fixture, controller };
}

await test('resolves selected assignment scopes, inheritance, and stable physical recipe IDs', async () => {
  const { fixture, controller } = await openFixture();
  controller.setObjectsTreeSelection([
    { kind: 'object', id: fixture.ids.object },
    { kind: 'volume', id: fixture.ids.volume },
    { kind: 'layer-range', id: fixture.ids.range },
    { kind: 'instance', id: fixture.ids.instance },
  ]);
  const snapshot = controller.getFilamentAssignmentSnapshot();

  assert.equal(snapshot.sourceRevision, controller.getSummary().revision);
  assert.equal(snapshot.sourceHash, controller.getSummary().projectHash);
  assert.deepEqual(
    snapshot.scopes.map((scope) => scope.entity.kind),
    ['object', 'volume', 'layer-range'],
  );
  assert.deepEqual(snapshot.unsupportedSelection, [{ kind: 'instance', id: fixture.ids.instance }]);
  assert.deepEqual(snapshot.scopes[0], {
    entity: { kind: 'object', id: fixture.ids.object },
    objectId: fixture.ids.object,
    label: 'Tiny triangle',
    localFilamentId: fixture.ids.physical0,
    effectiveFilamentId: fixture.ids.physical0,
  });
  assert.equal(snapshot.scopes[1].localFilamentId, undefined);
  assert.equal(snapshot.scopes[1].inheritedFilamentId, fixture.ids.physical0);
  assert.equal(snapshot.scopes[1].effectiveFilamentId, fixture.ids.physical0);
  assert.match(snapshot.scopes[2].label, /0–5 mm/);

  assert.deepEqual(
    snapshot.options.slice(0, 2).map((option) => [option.id, option.kind]),
    [
      [fixture.ids.physical0, 'physical'],
      [fixture.ids.physical1, 'physical'],
    ],
  );
  assert.equal(snapshot.options.length, 4);
  assert.equal(snapshot.options[2].kind, 'mixed');
  const mixed = snapshot.options.find((option) => option.id === fixture.ids.mixed)!;
  assert.deepEqual(
    mixed.recipe.map((component) => component.filamentId),
    [fixture.ids.physical0, fixture.ids.physical1],
  );
  assert.equal(mixed.distributionMode, 'ratio');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.scopes), true);
  assert.ok(snapshot.scopes.every((scope) => Object.isFrozen(scope) && Object.isFrozen(scope.entity)));
  assert.equal(Object.isFrozen(snapshot.options), true);
  assert.ok(
    snapshot.options.every(
      (option) => Object.isFrozen(option) && Object.isFrozen(option.recipe) && Object.isFrozen(option.warnings),
    ),
  );
  assert.ok(mixed.recipe.every(Object.isFrozen));

  controller.dispose();
});

await test('batches object, part, and height-range assignment into one exact undo boundary', async () => {
  const { fixture, controller } = await openFixture();
  const entities = [
    { kind: 'object' as const, id: fixture.ids.object },
    { kind: 'volume' as const, id: fixture.ids.volume },
    { kind: 'layer-range' as const, id: fixture.ids.range },
  ];
  const before = controller.getFilamentAssignmentSnapshot(entities);
  const historyBefore = controller.getSummary().history.undoCount;

  assert.equal(controller.setFilamentAssignments(entities, fixture.ids.physical1, before), true);
  const assigned = controller.getFilamentAssignmentSnapshot(entities);
  assert.ok(assigned.scopes.every((scope) => scope.localFilamentId === fixture.ids.physical1));
  assert.ok(assigned.scopes.every((scope) => scope.effectiveFilamentId === fixture.ids.physical1));
  assert.equal(controller.getSummary().history.undoCount, historyBefore + 1);
  assert.equal(controller.getSummary().history.undoLabel, 'Assign 3 scopes');

  const beforeNoop = controller.getSummary();
  assert.equal(controller.setFilamentAssignments(entities, fixture.ids.physical1, assigned), false);
  assert.deepEqual(controller.getSummary(), beforeNoop);

  assert.equal(controller.undo(), true);
  const restored = controller.getFilamentAssignmentSnapshot(entities);
  assert.equal(restored.scopes[0].localFilamentId, fixture.ids.physical0);
  assert.equal(restored.scopes[1].localFilamentId, undefined);
  assert.equal(restored.scopes[2].localFilamentId, undefined);
  assert.equal(controller.redo(), true);
  assert.ok(
    controller
      .getFilamentAssignmentSnapshot(entities)
      .scopes.every((scope) => scope.localFilamentId === fixture.ids.physical1),
  );

  const beforeClear = controller.getFilamentAssignmentSnapshot(entities.slice(1));
  const clearHistory = controller.getSummary().history.undoCount;
  assert.equal(controller.setFilamentAssignments(entities.slice(1), null, beforeClear), true);
  const inherited = controller.getFilamentAssignmentSnapshot(entities);
  assert.equal(inherited.scopes[0].localFilamentId, fixture.ids.physical1);
  assert.equal(inherited.scopes[1].localFilamentId, undefined);
  assert.equal(inherited.scopes[1].effectiveFilamentId, fixture.ids.physical1);
  assert.equal(inherited.scopes[2].localFilamentId, undefined);
  assert.equal(inherited.scopes[2].effectiveFilamentId, fixture.ids.physical1);
  assert.equal(controller.getSummary().history.undoCount, clearHistory + 1);

  const mixedGuard = controller.getFilamentAssignmentSnapshot([entities[1]]);
  assert.equal(controller.setFilamentAssignments([entities[1]], fixture.ids.mixed, mixedGuard), true);
  assert.equal(controller.getFilamentAssignmentSnapshot([entities[1]]).scopes[0].localFilamentId, fixture.ids.mixed);

  controller.dispose();
});

await test('fails stale, unknown, duplicate, empty, and missing-scope requests without partial mutation', async () => {
  const { fixture, controller } = await openFixture();
  const object = { kind: 'object' as const, id: fixture.ids.object };
  const stale = controller.getFilamentAssignmentSnapshot([object]);
  controller.renameObject(fixture.ids.object, 'Revision changed');
  const afterRename = controller.getSummary();
  assert.throws(
    () => controller.setFilamentAssignments([object], fixture.ids.physical1, stale),
    StaleCanonicalFilamentAssignmentError,
  );
  assert.deepEqual(controller.getSummary(), afterRename);
  assert.equal(controller.getFilamentAssignmentSnapshot([object]).scopes[0].localFilamentId, fixture.ids.physical0);

  const current = controller.getFilamentAssignmentSnapshot([object]);
  assert.throws(
    () =>
      controller.setFilamentAssignments(
        [object],
        entityId<'physical-filament'>('import:filament-controller-test:missing-head'),
        current,
      ),
    /Unknown filament/,
  );
  assert.throws(() => controller.setFilamentAssignments([], fixture.ids.physical1, current), /at least one/);
  assert.throws(
    () => controller.setFilamentAssignments([object, object], fixture.ids.physical1, current),
    /duplicate filament assignment targets/,
  );
  assert.throws(
    () =>
      controller.setFilamentAssignments(
        [object, { kind: 'volume', id: entityId<'volume'>('import:filament-controller-test:missing-volume') }],
        fixture.ids.physical1,
        current,
      ),
    /Unknown volume/,
  );
  assert.deepEqual(controller.getSummary(), afterRename);
  assert.equal(controller.getFilamentAssignmentSnapshot([object]).scopes[0].localFilamentId, fixture.ids.physical0);

  controller.dispose();
});

console.log(`\nCanonical filament assignment: ${passed} tests passed.`);
