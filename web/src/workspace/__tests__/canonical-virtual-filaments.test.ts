import assert from 'node:assert/strict';
import * as THREE from 'three';

import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import type { PhysicalFilament } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { readSafeZip } from '../../project/serialization/deterministicZip';
import {
  CanonicalWorkspaceController,
  StaleCanonicalVirtualFilamentMutationError,
} from '../CanonicalWorkspaceController';

const NOW = '2026-07-25T12:00:00.000Z';
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
    const id = `import:virtual-controller-test:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    return id;
  }
}

function createController(): CanonicalWorkspaceController {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectName: 'Virtual controller fixture',
    toolCount: 3,
    projectImportParser: new BbsProjectImportParser(),
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
  const physical: PhysicalFilament[] = [
    {
      id: entityId<'physical-filament'>('import:virtual-controller-test:physical-a'),
      name: 'Red PLA',
      toolId: 0,
      material: 'PLA',
      color: '#FF0000',
      config: {},
      enabled: true,
    },
    {
      id: entityId<'physical-filament'>('import:virtual-controller-test:physical-b'),
      name: 'Blue PLA',
      toolId: 1,
      material: 'PLA-CF',
      color: '#0000FF',
      config: {},
      enabled: true,
    },
    {
      id: entityId<'physical-filament'>('import:virtual-controller-test:physical-c'),
      name: 'White PETG',
      toolId: 2,
      material: 'PETG',
      color: '#FFFFFF',
      config: {},
      enabled: true,
    },
  ];
  controller.setSlicingConfiguration({
    printer: { profileId: 'snapmaker-u1', toolCount: 3 },
    config: {},
    filaments: { physical, mixed: [] },
  });
  return controller;
}

function guard(controller: CanonicalWorkspaceController) {
  const snapshot = controller.getVirtualFilamentLibrarySnapshot();
  return { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash };
}

await test('adds an exact guarded Ratio row, freezes its projection, and writes the exact BBS definition', async () => {
  const controller = createController();
  const snapshot = controller.getVirtualFilamentLibrarySnapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.physical), true);
  assert.deepEqual(
    snapshot.physical.map((entry) => [entry.engineToolId, entry.name]),
    [
      [1, 'Red PLA'],
      [2, 'Blue PLA'],
      [3, 'White PETG'],
    ],
  );

  const id = entityId<'mixed-filament'>('import:virtual-controller-test:ratio');
  controller.addVirtualFilament(
    {
      mode: 'ratio',
      name: 'Purple ratio',
      displayColor: '#800080',
      componentFilamentIds: [snapshot.physical[0].id, snapshot.physical[1].id],
      mixBPercent: 25,
    },
    { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
    id,
  );
  const after = controller.getVirtualFilamentLibrarySnapshot();
  assert.equal(after.mixed.length, 4);
  const added = after.mixed.find((row) => row.filament.id === id)!;
  assert.equal(added.hasExactFullSpectrumState, true);
  assert.equal(Object.isFrozen(added.filament.components), true);
  assert.deepEqual(
    added.filament.components.map((component) => component.weight),
    [75, 25],
  );

  const archive = await controller.saveCanonical3mf();
  const projectSettings = JSON.parse(
    new TextDecoder().decode(readSafeZip(archive.bytes).get('Metadata/project_settings.config')),
  );
  assert.match(
    projectSettings.mixed_filament_definitions.split(';').at(-1),
    /^1,2,1,1,25,0,g,w,m2,z0,xa0,xb0,d0,o0,u[1-9][0-9]*,cm0$/,
  );
  controller.dispose();
});

await test('rejects stale and incompatible requests without changing canonical state or history', () => {
  const controller = createController();
  const initial = controller.getVirtualFilamentLibrarySnapshot();
  controller.addVirtualFilament(
    {
      mode: 'ratio',
      name: 'Initial',
      displayColor: '#800080',
      componentFilamentIds: [initial.physical[0].id, initial.physical[1].id],
      mixBPercent: 50,
    },
    { expectedRevision: initial.sourceRevision, sourceHash: initial.sourceHash },
  );
  const beforeStale = controller.getSummary();
  assert.throws(
    () =>
      controller.addVirtualFilament(
        {
          mode: 'ratio',
          name: 'Stale',
          displayColor: '#123456',
          componentFilamentIds: [initial.physical[0].id, initial.physical[1].id],
          mixBPercent: 50,
        },
        { expectedRevision: initial.sourceRevision, sourceHash: initial.sourceHash },
      ),
    StaleCanonicalVirtualFilamentMutationError,
  );
  assert.deepEqual(controller.getSummary(), beforeStale);

  const current = controller.getVirtualFilamentLibrarySnapshot();
  const beforeIncompatible = controller.getSummary();
  assert.throws(
    () =>
      controller.addVirtualFilament(
        {
          mode: 'ratio',
          name: 'PLA plus unsupported material',
          displayColor: '#123456',
          componentFilamentIds: [current.physical[0].id, current.physical[2].id],
          mixBPercent: 50,
        },
        { expectedRevision: current.sourceRevision, sourceHash: current.sourceHash },
      ),
    /cannot be mixed|compatibility/i,
  );
  assert.deepEqual(controller.getSummary(), beforeIncompatible);
  controller.dispose();
});

await test('edits, duplicates, toggles, tombstones referenced rows, removes unreferenced rows, and undoes each outcome', () => {
  const controller = createController();
  let snapshot = controller.getVirtualFilamentLibrarySnapshot();
  const ratioId = entityId<'mixed-filament'>('import:virtual-controller-test:lifecycle-ratio');
  controller.addVirtualFilament(
    {
      mode: 'ratio',
      name: 'Lifecycle ratio',
      displayColor: '#800080',
      componentFilamentIds: [snapshot.physical[0].id, snapshot.physical[1].id],
      mixBPercent: 50,
    },
    { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
    ratioId,
  );

  snapshot = controller.getVirtualFilamentLibrarySnapshot();
  controller.editVirtualFilament(
    ratioId,
    {
      mode: 'cycle',
      name: 'Lifecycle cycle',
      displayColor: '#775599',
      manualPatternGroups: [
        [snapshot.physical[0].id, snapshot.physical[1].id],
        [snapshot.physical[1].id, snapshot.physical[0].id, snapshot.physical[1].id],
      ],
    },
    { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
  );
  assert.equal(
    controller.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.id === ratioId)?.filament
      .distribution.mode,
    'cycle',
  );
  assert.equal(controller.undo(), true);
  assert.equal(
    controller.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.id === ratioId)?.filament
      .distribution.mode,
    'ratio',
  );
  assert.equal(controller.redo(), true);

  snapshot = controller.getVirtualFilamentLibrarySnapshot();
  const duplicateId = entityId<'mixed-filament'>('import:virtual-controller-test:lifecycle-copy');
  controller.duplicateVirtualFilament(
    ratioId,
    {
      mode: 'gradient',
      name: 'Lifecycle gradient copy',
      displayColor: '#6688AA',
      componentFilamentIds: [snapshot.physical[0].id, snapshot.physical[1].id],
      direction: 'b-to-a',
      localZMaxSublayers: 4,
    },
    { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
    duplicateId,
  );
  assert.equal(controller.getVirtualFilamentLibrarySnapshot().mixed.length, 5);

  controller.setVirtualFilamentEnabled(duplicateId, false, guard(controller));
  assert.equal(
    controller.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.id === duplicateId)?.filament
      .enabled,
    false,
  );
  controller.setVirtualFilamentEnabled(duplicateId, true, guard(controller));

  const model = controller.importBufferGeometry(new THREE.BoxGeometry(10, 10, 10), { name: 'Mixed assignment' });
  const assignmentSnapshot = controller.getFilamentAssignmentSnapshot([{ kind: 'object', id: model.objectId }]);
  controller.setFilamentAssignments([{ kind: 'object', id: model.objectId }], ratioId, {
    sourceRevision: assignmentSnapshot.sourceRevision,
    sourceHash: assignmentSnapshot.sourceHash,
  });
  const beforeTombstone = controller
    .getSlicingConfiguration()
    .filaments.mixed.find((filament) => filament.id === ratioId);
  const deletion = controller.deleteVirtualFilament(ratioId, guard(controller));
  assert.equal(deletion.outcome, 'tombstoned');
  assert.match(deletion.dependencyPaths.join('\n'), /filamentId/);
  assert.equal(
    controller.getVirtualFilamentLibrarySnapshot().mixed.some((row) => row.filament.id === ratioId),
    false,
  );
  const tombstone = controller.getSlicingConfiguration().filaments.mixed.find((filament) => filament.id === ratioId);
  assert.equal(tombstone?.enabled, false);
  assert.equal(tombstone?.fullSpectrum?.deleted, true);
  assert.equal(controller.undo(), true);
  assert.deepEqual(
    controller.getSlicingConfiguration().filaments.mixed.find((filament) => filament.id === ratioId),
    beforeTombstone,
  );

  const removed = controller.deleteVirtualFilament(duplicateId, guard(controller));
  assert.equal(removed.outcome, 'removed');
  assert.equal(
    controller.getSlicingConfiguration().filaments.mixed.some((filament) => filament.id === duplicateId),
    false,
  );
  assert.equal(controller.undo(), true);
  assert.equal(
    controller.getSlicingConfiguration().filaments.mixed.some((filament) => filament.id === duplicateId),
    true,
  );
  controller.dispose();
});

console.log(`canonical virtual filaments: ${passed} tests passed`);
