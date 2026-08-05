import assert from 'node:assert/strict';
import * as THREE from 'three';

import { canonicalStringify, projectFingerprint } from '../../project/domain/canonical';
import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import { createEmptyProject, type PhysicalFilament } from '../../project/domain/model';
import { createFullSpectrumMixedFilament } from '../../project/filaments/fullSpectrumRecipe';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import { readSafeZip } from '../../project/serialization/deterministicZip';
import {
  CanonicalWorkspaceController,
  FullSpectrumAutoPairConfirmationMismatchError,
  StaleFullSpectrumAutoPairReconciliationError,
} from '../CanonicalWorkspaceController';

const NOW = '2026-07-25T15:00:00.000Z';
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class RecordingIdSource implements IdSource {
  private nextNumber = 1;
  readonly allocations: string[] = [];

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    const id = `import:auto-pair-controller:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    this.allocations.push(kind);
    return id;
  }

  count(kind: string): number {
    return this.allocations.filter((candidate) => candidate === kind).length;
  }
}

function createController(autoPairs: 'enabled' | 'default-off' = 'enabled'): {
  readonly controller: CanonicalWorkspaceController;
  readonly ids: RecordingIdSource;
} {
  const ids = new RecordingIdSource();
  return {
    ids,
    controller: CanonicalWorkspaceController.createEmpty({
      idSource: ids,
      clock: () => NOW,
      parent: new THREE.Scene(),
      mapping: MAPPING,
      projectName: 'Auto-pair controller fixture',
      toolCount: 3,
      projectImportParser: new BbsProjectImportParser(),
      ...(autoPairs === 'enabled' ? { fullSpectrumAutoPairPreferences: { enabled: true } } : {}),
    }),
  };
}

function physical(name: string, color: string, toolId: number): PhysicalFilament {
  return {
    id: entityId<'physical-filament'>(`import:auto-pair-controller:physical-${name}`),
    name: `${name.toUpperCase()} PLA`,
    toolId,
    material: 'PLA',
    color,
    config: {},
    enabled: true,
  };
}

function configurePhysical(
  controller: CanonicalWorkspaceController,
  physicalFilaments: readonly PhysicalFilament[],
): void {
  const current = controller.getSlicingConfiguration();
  controller.setSlicingConfiguration({
    printer: { ...current.printer, toolCount: physicalFilaments.length },
    config: current.config,
    ...(current.settingsOverrides !== undefined ? { settingsOverrides: current.settingsOverrides } : {}),
    filaments: {
      physical: physicalFilaments,
      mixed: current.filaments.mixed,
    },
  });
}

function allMixed(controller: CanonicalWorkspaceController) {
  return controller.getSlicingConfiguration().filaments.mixed;
}

function currentGuard(controller: CanonicalWorkspaceController) {
  const summary = controller.getSummary();
  return { expectedRevision: summary.revision, sourceHash: summary.projectHash };
}

function virtualGuard(controller: CanonicalWorkspaceController) {
  const snapshot = controller.getVirtualFilamentLibrarySnapshot();
  return { expectedRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash };
}

async function mixedDefinitions(controller: CanonicalWorkspaceController): Promise<string> {
  const archive = await controller.saveCanonical3mf();
  const config = JSON.parse(
    new TextDecoder().decode(readSafeZip(archive.bytes).get('Metadata/project_settings.config')),
  ) as { mixed_filament_definitions?: string };
  return config.mixed_filament_definitions ?? '';
}

await test('adds, removes, and re-adds physical rows with stable surviving IDs and exact C(N,2) wire order', async () => {
  const { controller, ids } = createController();
  const a = physical('a', '#FF0000', 0);
  const b = physical('b', '#0000FF', 1);
  const c = physical('c', '#FFFFFF', 2);

  configurePhysical(controller, [a, b]);
  const pairAb = allMixed(controller)[0];
  assert.ok(pairAb);
  assert.deepEqual(
    pairAb.components.map((component) => component.filamentId),
    [a.id, b.id],
  );
  assert.equal(pairAb.fullSpectrum?.custom, false);
  assert.equal(pairAb.fullSpectrum?.originAuto, true);
  assert.equal(ids.count('mixed-filament'), 1);

  const historyBeforeNoop = controller.getSummary().history.undoCount;
  const allocationsBeforeNoop = ids.count('mixed-filament');
  const noChange = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller));
  assert.equal(noChange.status, 'unchanged');
  assert.equal(noChange.changed, false);
  assert.equal(controller.getSummary().history.undoCount, historyBeforeNoop);
  assert.equal(ids.count('mixed-filament'), allocationsBeforeNoop);

  const staleGuard = currentGuard(controller);
  configurePhysical(controller, [a, b, c]);
  assert.throws(
    () => controller.reconcileFullSpectrumAutoPairs(staleGuard),
    StaleFullSpectrumAutoPairReconciliationError,
  );
  const afterAdd = allMixed(controller);
  assert.deepEqual(
    afterAdd.map((filament) => filament.components.map((component) => component.filamentId)),
    [
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
    ],
  );
  assert.equal(afterAdd[0].id, pairAb.id);
  assert.equal(afterAdd[0].fullSpectrum?.upstreamStableId, pairAb.fullSpectrum?.upstreamStableId);
  assert.equal(ids.count('mixed-filament'), 3);
  const firstAcId = afterAdd[1].id;
  const firstBcId = afterAdd[2].id;

  configurePhysical(controller, [a, b]);
  assert.deepEqual(
    allMixed(controller).map((filament) => filament.id),
    [pairAb.id],
  );

  configurePhysical(controller, [a, b, c]);
  const afterReAdd = allMixed(controller);
  assert.equal(afterReAdd[0].id, pairAb.id);
  assert.notEqual(afterReAdd[1].id, firstAcId);
  assert.notEqual(afterReAdd[2].id, firstBcId);
  assert.equal(ids.count('mixed-filament'), 5);

  assert.equal(controller.undo(), true);
  assert.deepEqual(
    allMixed(controller).map((filament) => filament.id),
    [pairAb.id],
  );
  assert.equal(controller.undo(), true);
  assert.deepEqual(
    allMixed(controller).map((filament) => filament.id),
    [pairAb.id, firstAcId, firstBcId],
  );
  assert.equal(controller.redo(), true);
  assert.equal(controller.redo(), true);

  const reAdded = allMixed(controller);
  assert.equal(
    await mixedDefinitions(controller),
    reAdded
      .map(
        (filament, index) =>
          `${index === 0 ? '1,2' : index === 1 ? '1,3' : '2,3'},1,0,50,0,g,w,m2,z0,xa0,xb0,d0,o1,u${
            filament.fullSpectrum!.upstreamStableId
          }`,
      )
      .join(';'),
  );
  controller.dispose();
});

await test('defaults auto generation off without allocating or rewriting imported project definitions', async () => {
  const a = physical('a', '#FF0000', 0);
  const b = physical('b', '#0000FF', 1);
  const fresh = createController('default-off');
  configurePhysical(fresh.controller, [a, b]);
  assert.deepEqual(allMixed(fresh.controller), []);
  assert.equal(fresh.ids.count('mixed-filament'), 0);
  fresh.controller.dispose();

  const sourceState = createEmptyProject({
    idSource: new RecordingIdSource(),
    now: NOW,
    name: 'Preference-off archive',
    toolCount: 2,
  });
  sourceState.filaments.physical = [a, b];
  const importedBase = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:auto-pair-controller:preserved-base'),
    [a, b],
    {
      mode: 'ratio',
      name: 'Preserved automatic pair',
      displayColor: '#812780',
      componentFilamentIds: [a.id, b.id],
      mixBPercent: 35,
    },
    '7001',
  );
  importedBase.fullSpectrum!.custom = false;
  importedBase.fullSpectrum!.originAuto = true;
  const importedCustom = createFullSpectrumMixedFilament(
    entityId<'mixed-filament'>('import:auto-pair-controller:preserved-custom'),
    [a, b],
    {
      mode: 'ratio',
      name: 'Preserved authored pair',
      displayColor: '#702060',
      componentFilamentIds: [a.id, b.id],
      mixBPercent: 20,
    },
    '7002',
  );
  sourceState.filaments.mixed = [importedBase, importedCustom];
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state: sourceState,
    assets: [],
    sourceRevision: 0,
    sourceHash: projectFingerprint(sourceState),
  });

  const { controller, ids } = createController('default-off');
  await controller.openCanonical3mf(archive.bytes);
  assert.deepEqual(allMixed(controller), [importedBase, importedCustom]);
  assert.equal(ids.count('mixed-filament'), 0);
  const historyBefore = controller.getSummary().history.undoCount;
  const result = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller));
  assert.equal(result.status, 'disabled');
  assert.equal(result.changed, false);
  assert.equal(result.physicalCount, 2);
  assert.equal(result.projectedPairCount, 1);
  assert.deepEqual(result.createdRowIds, []);
  assert.deepEqual(result.droppedRowIds, []);
  assert.equal(ids.count('mixed-filament'), 0);
  assert.equal(controller.getSummary().history.undoCount, historyBefore);
  assert.deepEqual(allMixed(controller), [importedBase, importedCustom]);
  controller.dispose();
});

await test('applies the live preference without rewriting on disable and honors count-bound confirmation', () => {
  const three = createController('default-off');
  const physicalThree = [physical('a', '#FF0000', 0), physical('b', '#0000FF', 1), physical('c', '#FFFFFF', 2)];
  configurePhysical(three.controller, physicalThree);
  assert.deepEqual(three.controller.getFullSpectrumAutoPairPolicySnapshot(), {
    enabled: false,
    physicalCount: 3,
    projectedPairCount: 3,
    confirmationRequired: false,
  });
  const historyBefore = three.controller.getSummary().history.undoCount;
  const enabled = three.controller.setFullSpectrumAutoPairGenerationEnabled(true);
  assert.equal(enabled.status, 'reconciled');
  assert.equal(enabled.createdRowIds.length, 3);
  assert.equal(three.controller.getFullSpectrumAutoPairPolicySnapshot().enabled, true);
  assert.equal(three.controller.getSummary().history.undoCount, historyBefore + 1);
  const rowsBeforeDisable = canonicalStringify(allMixed(three.controller));
  const disabled = three.controller.setFullSpectrumAutoPairGenerationEnabled(false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.changed, false);
  assert.equal(three.controller.getFullSpectrumAutoPairPolicySnapshot().enabled, false);
  assert.equal(canonicalStringify(allMixed(three.controller)), rowsBeforeDisable);
  assert.equal(three.controller.getSummary().history.undoCount, historyBefore + 1);
  assert.throws(
    () => three.controller.setFullSpectrumAutoPairGenerationEnabled('yes' as unknown as boolean),
    /must be boolean/i,
  );
  three.controller.dispose();

  const five = createController('default-off');
  const physicalFive = [
    physical('d', '#00FF00', 0),
    physical('e', '#000000', 1),
    physical('f', '#FFFF00', 2),
    physical('g', '#00FFFF', 3),
    physical('h', '#FF00FF', 4),
  ];
  configurePhysical(five.controller, physicalFive);
  assert.throws(
    () =>
      five.controller.setFullSpectrumAutoPairGenerationEnabled(true, {
        confirmedPhysicalCount: 4,
      }),
    FullSpectrumAutoPairConfirmationMismatchError,
  );
  assert.equal(five.controller.getFullSpectrumAutoPairPolicySnapshot().enabled, false);
  const pending = five.controller.setFullSpectrumAutoPairGenerationEnabled(true);
  assert.equal(pending.status, 'confirmation-required');
  assert.equal(pending.projectedPairCount, 10);
  assert.equal(five.controller.getFullSpectrumAutoPairPolicySnapshot().confirmationRequired, true);
  assert.equal(five.ids.count('mixed-filament'), 0);
  const confirmed = five.controller.setFullSpectrumAutoPairGenerationEnabled(true, {
    confirmedPhysicalCount: 5,
  });
  assert.equal(confirmed.status, 'reconciled');
  assert.equal(confirmed.createdRowIds.length, 10);
  assert.equal(five.controller.getFullSpectrumAutoPairPolicySnapshot().confirmationRequired, false);
  five.controller.dispose();
});

await test('requires exact per-count confirmation above four physical filaments before allocating pairs', () => {
  const { controller, ids } = createController();
  const physicalFive = [
    physical('a', '#FF0000', 0),
    physical('b', '#0000FF', 1),
    physical('c', '#FFFFFF', 2),
    physical('d', '#00FF00', 3),
    physical('e', '#000000', 4),
  ];
  configurePhysical(controller, physicalFive);
  assert.deepEqual(allMixed(controller), []);
  assert.equal(ids.count('mixed-filament'), 0);

  const historyBefore = controller.getSummary().history.undoCount;
  const required = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller));
  assert.equal(required.status, 'confirmation-required');
  assert.equal(required.changed, false);
  assert.equal(required.physicalCount, 5);
  assert.equal(required.projectedPairCount, 10);
  assert.equal(controller.getSummary().history.undoCount, historyBefore);
  assert.equal(ids.count('mixed-filament'), 0);

  assert.throws(
    () =>
      controller.reconcileFullSpectrumAutoPairs(currentGuard(controller), {
        confirmedPhysicalCount: 4,
      }),
    FullSpectrumAutoPairConfirmationMismatchError,
  );
  assert.equal(ids.count('mixed-filament'), 0);

  const accepted = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller), {
    confirmedPhysicalCount: 5,
  });
  assert.equal(accepted.status, 'reconciled');
  assert.equal(accepted.changed, true);
  assert.equal(accepted.createdRowIds.length, 10);
  assert.equal(allMixed(controller).length, 10);
  assert.equal(ids.count('mixed-filament'), 10);
  assert.equal(controller.getSummary().history.undoCount, historyBefore + 1);

  const unchanged = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller));
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(ids.count('mixed-filament'), 10);

  configurePhysical(
    controller,
    [...physicalFive].reverse().map((filament, toolId) => ({ ...filament, toolId })),
  );
  assert.equal(allMixed(controller).length, 10);
  assert.equal(ids.count('mixed-filament'), 10);

  const sixth = physical('f', '#FFFF00', 5);
  configurePhysical(controller, [...physicalFive, sixth]);
  assert.equal(allMixed(controller).length, 10);
  assert.equal(ids.count('mixed-filament'), 10);
  const sixRequired = controller.reconcileFullSpectrumAutoPairs(currentGuard(controller));
  assert.equal(sixRequired.status, 'confirmation-required');
  assert.equal(sixRequired.physicalCount, 6);
  assert.equal(sixRequired.projectedPairCount, 15);
  assert.equal(ids.count('mixed-filament'), 10);
  controller.dispose();
});

await test('keeps an auto-pair tombstone stable through reconciliation and physical reorder', async () => {
  const { controller, ids } = createController();
  const a = physical('a', '#FF0000', 0);
  const b = physical('b', '#0000FF', 1);
  configurePhysical(controller, [a, b]);
  const pair = allMixed(controller)[0];
  const beforeDeleteHistory = controller.getSummary().history.undoCount;

  const deletion = controller.deleteVirtualFilament(pair.id, virtualGuard(controller));
  assert.equal(deletion.outcome, 'tombstoned');
  assert.equal(controller.getSummary().history.undoCount, beforeDeleteHistory + 1);
  assert.equal(controller.getVirtualFilamentLibrarySnapshot().mixed.length, 0);
  assert.equal(allMixed(controller)[0].id, pair.id);
  assert.equal(allMixed(controller)[0].enabled, false);
  assert.equal(allMixed(controller)[0].fullSpectrum?.deleted, true);

  const allocationCount = ids.count('mixed-filament');
  assert.equal(controller.reconcileFullSpectrumAutoPairs(currentGuard(controller)).changed, false);
  assert.equal(ids.count('mixed-filament'), allocationCount);

  configurePhysical(controller, [b, a]);
  const reorderedTombstone = allMixed(controller)[0];
  assert.equal(reorderedTombstone.id, pair.id);
  assert.deepEqual(
    reorderedTombstone.components.map((component) => component.filamentId),
    [b.id, a.id],
  );
  assert.equal(reorderedTombstone.fullSpectrum?.deleted, true);
  assert.equal(
    await mixedDefinitions(controller),
    `1,2,0,0,50,0,g,w,m2,z0,xa0,xb0,d1,o1,u${pair.fullSpectrum!.upstreamStableId}`,
  );

  assert.equal(controller.undo(), true);
  assert.equal(allMixed(controller)[0].fullSpectrum?.deleted, true);
  assert.equal(controller.undo(), true);
  assert.equal(allMixed(controller)[0].id, pair.id);
  assert.equal(allMixed(controller)[0].enabled, true);
  assert.equal(allMixed(controller)[0].fullSpectrum?.deleted, false);
  controller.dispose();
});

await test('editing an auto pair keeps its stable custom-origin row and creates one base in the same undo boundary', async () => {
  const { controller, ids } = createController();
  const a = physical('a', '#FF0000', 0);
  const b = physical('b', '#0000FF', 1);
  configurePhysical(controller, [a, b]);
  const originalBase = allMixed(controller)[0];
  const historyBeforeEdit = controller.getSummary().history.undoCount;

  controller.editVirtualFilament(
    originalBase.id,
    {
      mode: 'ratio',
      name: 'Edited automatic purple',
      displayColor: '#7A2080',
      componentFilamentIds: [a.id, b.id],
      mixBPercent: 25,
    },
    virtualGuard(controller),
  );

  const afterEdit = allMixed(controller);
  assert.equal(controller.getSummary().history.undoCount, historyBeforeEdit + 1);
  assert.equal(controller.getSummary().history.undoLabel, 'Edit mixed filament');
  assert.equal(ids.count('mixed-filament'), 2);
  assert.equal(afterEdit.length, 2);
  assert.notEqual(afterEdit[0].id, originalBase.id);
  assert.equal(afterEdit[0].fullSpectrum?.custom, false);
  assert.equal(afterEdit[0].fullSpectrum?.originAuto, true);
  assert.equal(afterEdit[1].id, originalBase.id);
  assert.equal(afterEdit[1].fullSpectrum?.mixBPercent, 25);
  assert.equal(afterEdit[1].fullSpectrum?.custom, true);
  assert.equal(afterEdit[1].fullSpectrum?.originAuto, true);
  assert.equal(
    await mixedDefinitions(controller),
    [
      `1,2,1,0,50,0,g,w,m2,z0,xa0,xb0,d0,o1,u${afterEdit[0].fullSpectrum!.upstreamStableId}`,
      `1,2,1,1,25,0,g,w,m2,z0,xa0,xb0,d0,o1,u${originalBase.fullSpectrum!.upstreamStableId},cm0`,
    ].join(';'),
  );

  assert.equal(controller.undo(), true);
  assert.deepEqual(
    allMixed(controller).map((filament) => filament.id),
    [originalBase.id],
  );
  assert.equal(controller.redo(), true);
  assert.deepEqual(
    allMixed(controller).map((filament) => filament.id),
    afterEdit.map((filament) => filament.id),
  );

  const historyBeforeDelete = controller.getSummary().history.undoCount;
  const deletion = controller.deleteVirtualFilament(originalBase.id, virtualGuard(controller));
  assert.equal(deletion.outcome, 'tombstoned');
  assert.equal(controller.getSummary().history.undoCount, historyBeforeDelete + 1);
  assert.ok(allMixed(controller).every((filament) => filament.fullSpectrum?.deleted));
  assert.ok(allMixed(controller).every((filament) => !filament.enabled));
  assert.equal(ids.count('mixed-filament'), 2, 'deleting an edited pair must not allocate or resurrect another base');
  assert.equal(controller.undo(), true);
  assert.deepEqual(
    allMixed(controller).map((filament) => [filament.id, filament.enabled, filament.fullSpectrum?.deleted]),
    afterEdit.map((filament) => [filament.id, filament.enabled, filament.fullSpectrum?.deleted]),
  );
  controller.dispose();
});

await test('open establishes a clean reconciled root and preview import commits the same state in one command', async () => {
  const a = physical('a', '#FF0000', 0);
  const b = physical('b', '#0000FF', 1);
  const sourceState = createEmptyProject({
    idSource: new RecordingIdSource(),
    now: NOW,
    name: 'Unreconciled archive',
    toolCount: 2,
  });
  sourceState.filaments.physical = [a, b];
  const archive = await new Bbs3mfProjectSerializer().serialize({
    state: sourceState,
    assets: [],
    sourceRevision: 0,
    sourceHash: projectFingerprint(sourceState),
  });

  const opened = createController().controller;
  await opened.openCanonical3mf(archive.bytes);
  assert.equal(allMixed(opened).length, 1);
  assert.equal(allMixed(opened)[0].fullSpectrum?.originAuto, true);
  assert.equal(opened.getSummary().history.undoCount, 0);
  assert.equal(opened.getSummary().dirty, false);

  const imported = createController().controller;
  const beforeImport = imported.getSummary();
  const prepared = await imported.prepareCanonical3mfImport(archive.bytes, {
    filename: 'unreconciled.3mf',
  });
  assert.equal(imported.getSummary().projectId, beforeImport.projectId);
  assert.equal(allMixed(imported).length, 0);
  prepared.confirm({
    confirmed: true,
    acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
  });
  assert.equal(allMixed(imported).length, 1);
  assert.equal(imported.getSummary().history.undoCount, 1);
  assert.equal(imported.getSummary().history.undoLabel, 'Import unreconciled.3mf');
  assert.equal(imported.undo(), true);
  assert.equal(imported.getSummary().projectId, beforeImport.projectId);
  assert.equal(allMixed(imported).length, 0);

  opened.dispose();
  imported.dispose();
});

console.log(`canonical auto pairs: ${passed} tests passed`);
