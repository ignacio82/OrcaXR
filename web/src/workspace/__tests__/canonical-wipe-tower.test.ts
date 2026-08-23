import assert from 'node:assert/strict';
import * as THREE from 'three';

import { UuidIdSource, seededRandom, type IdSource } from '../../project';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

const NOW = '2026-08-23T15:00:00.000Z';
const MAPPING = { bedSizeMm: [256, 256] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function createController(): {
  readonly controller: CanonicalWorkspaceController;
  readonly ids: IdSource;
} {
  const ids = new UuidIdSource(seededRandom(0xbeef));
  return {
    ids,
    controller: CanonicalWorkspaceController.createEmpty({
      idSource: ids,
      clock: () => NOW,
      parent: new THREE.Scene(),
      mapping: MAPPING,
      projectName: 'Wipe-tower controller test',
      toolCount: 4,
      projectImportParser: new BbsProjectImportParser(),
    }),
  };
}

test('autoPlaceWipeTower positions wipe tower and reports summary', () => {
  const { controller } = createController();
  const summaryBefore = controller.getSummary();
  const plateId = summaryBefore.activePlateId;
  assert.equal(summaryBefore.plates[0].wipeTower, undefined);
  assert.equal(controller.getPlateWipeTower(plateId), undefined);

  const pick = controller.autoPlaceWipeTower(plateId, {
    bedSizeMm: [256, 256],
  });

  assert.equal(pick.label, 'back-left');
  assert.equal(pick.xMm, 1);
  assert.equal(pick.yMm, 195);
  assert.equal(pick.clearanceMm, Infinity);

  const summaryAfter = controller.getSummary();
  assert.ok(summaryAfter.plates[0].wipeTower);
  assert.equal(summaryAfter.plates[0].wipeTower?.enabled, true);
  assert.deepEqual(summaryAfter.plates[0].wipeTower?.positionMm, [1, 195]);
  assert.equal(summaryAfter.history.undoCount, 1);

  // Undo restores undefined
  controller.undo();
  assert.equal(controller.getSummary().plates[0].wipeTower, undefined);
  assert.equal(controller.getPlateWipeTower(plateId), undefined);
  assert.equal(controller.getSummary().history.undoCount, 0);

  // Redo restores placed tower
  controller.redo();
  assert.ok(controller.getSummary().plates[0].wipeTower);
  assert.deepEqual(controller.getPlateWipeTower(plateId)?.positionMm, [1, 195]);
});

test('setPlateWipeTower updates, clears, and undos wipe tower state', () => {
  const { controller } = createController();
  const plateId = controller.getSummary().activePlateId;

  controller.setPlateWipeTower(plateId, {
    enabled: true,
    positionMm: [100, 200],
    rotationDeg: 45,
  });

  assert.deepEqual(controller.getPlateWipeTower(plateId), {
    enabled: true,
    positionMm: [100, 200],
    rotationDeg: 45,
  });
  assert.equal(controller.getSummary().history.undoCount, 1);

  // Clear wipe tower
  controller.setPlateWipeTower(plateId, undefined);
  assert.equal(controller.getPlateWipeTower(plateId), undefined);
  assert.equal(controller.getSummary().history.undoCount, 2);

  // Undo clear
  controller.undo();
  assert.deepEqual(controller.getPlateWipeTower(plateId), {
    enabled: true,
    positionMm: [100, 200],
    rotationDeg: 45,
  });
});

console.log(`\nCanonical wipe tower controller tests: ${passed} tests passed.`);
