/**
 * Filament assignment, filament remapping and wipe-tower placement through the
 * guarded asynchronous session route: each waits for acknowledgement, keeps
 * exact undo, and a queued edit refuses a competing one instead of rebasing.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AsyncSessionError } from '../../project/AsyncEditorSession';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform, type PhysicalFilament } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

function setup() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0xf11a)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
    toolCount: 2,
  });
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const imported = controller.importBufferGeometry(geometry, { name: 'Cube', transform: identityTransform() });
  geometry.dispose();
  const filament = (key: string, toolId: number, color: string): PhysicalFilament => ({
    id: entityId<'physical-filament'>(`import:async-filaments:${key}`),
    name: `${key} PLA`,
    toolId,
    material: 'PLA',
    color,
    config: {},
    enabled: true,
  });
  const physical = [filament('first', 0, '#FF0000'), filament('second', 1, '#0000FF')];
  controller.setSlicingConfiguration({
    printer: { profileId: 'snapmaker-u1', toolCount: 2 },
    config: {},
    filaments: { physical, mixed: [] },
  });
  const [first, second] = physical.map((entry) => entry.id);
  return { controller, imported, first, second };
}
const footprint = (controller: CanonicalWorkspaceController) => ({
  summary: controller.getSummary(),
  identity: controller.captureProjectExportGuard(),
});
const stale = (error: unknown) => error instanceof AsyncSessionError && error.code === 'stale';
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test('assignment and remap wait for acknowledgement and undo exactly', async () => {
  const { controller, imported, first, second } = setup();
  try {
    const object = { kind: 'object' as const, id: imported.objectId };
    const local = () => controller.getFilamentAssignmentSnapshot([object]).scopes[0].localFilamentId;
    const before = footprint(controller);
    const pending = controller.setFilamentAssignments(
      [object],
      second,
      controller.getFilamentAssignmentSnapshot([object]),
    );
    assert.deepEqual(footprint(controller), before, 'nothing applies before acknowledgement');
    assert.equal(await pending, true);
    assert.equal(local(), second);
    assert.equal(
      await controller.setFilamentAssignments([object], second, controller.getFilamentAssignmentSnapshot([object])),
      false,
      'an exact repeat changes nothing',
    );

    const remapping = controller.remapFilaments([second], first);
    assert.equal(local(), second);
    await remapping;
    assert.equal(local(), first);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(local(), second);
    assert.equal(await controller.undoAsync(), true);
    assert.equal(controller.captureProjectExportGuard().semanticHash, before.identity.semanticHash);
  } finally {
    controller.dispose();
  }
});

await test('wipe-tower placement waits for acknowledgement and refuses a competing edit', async () => {
  const { controller } = setup();
  try {
    const plateId = controller.getSummary().activePlateId;
    const before = footprint(controller);
    const placing = controller.autoPlaceWipeTower(plateId, { bedSizeMm: [256, 256] });
    assert.deepEqual(footprint(controller), before);
    const pick = await placing;
    assert.deepEqual(controller.getPlateWipeTower(plateId)?.positionMm, [pick.xMm, pick.yMm]);
    await controller.setPlateWipeTower(plateId, undefined);
    assert.equal(controller.getPlateWipeTower(plateId), undefined);

    const competing = controller.autoPlaceWipeTower(plateId, { bedSizeMm: [256, 256] });
    controller.setProjectConfig({ edit_probe: 'newer' });
    const newer = footprint(controller);
    await assert.rejects(competing, stale);
    assert.deepEqual(footprint(controller), newer);
    assert.equal(controller.getPlateWipeTower(plateId), undefined);
  } finally {
    controller.dispose();
  }
});

console.log(`canonical async filament tests passed: ${passed}`);
