/**
 * The registry facts the canonical session decides (`canonicalUiFacts`, which
 * the native core ports) read exactly what the shell derived from the
 * published summary before, through imports, selection, plates and history.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { seededRandom, UuidIdSource } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

function fromSummary(controller: CanonicalWorkspaceController) {
  const summary = controller.getSummary();
  const active = summary.plates.find((plate) => plate.id === summary.activePlateId);
  return {
    modelCount: active?.instanceCount ?? 0,
    plateCount: summary.plates.length,
    hasSelection: controller.getObjectsTree().selection.refs.length > 0,
    hasInstanceSelection: summary.primaryInstanceId !== undefined,
    canUndo: summary.history.undoCount > 0,
    canRedo: summary.history.redoCount > 0,
    dirty: summary.dirty,
  };
}

await test('facts follow imports, selection, plates and history', async () => {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0xfac7)),
    clock: () => '2026-10-08T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  try {
    const check = (label: string, expected: Partial<ReturnType<typeof fromSummary>>) => {
      const facts = controller.getUiFacts();
      assert.deepEqual({ ...facts }, fromSummary(controller), label);
      assert.deepEqual({ ...facts }, { ...facts, ...expected }, label);
      assert.equal(Object.isFrozen(facts), true);
    };
    check('empty', { modelCount: 0, plateCount: 1, canUndo: false, dirty: false });
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    const first = controller.importBufferGeometry(geometry, { name: 'First', transform: identityTransform() });
    check('imported', { modelCount: 1, canUndo: true, dirty: true });
    controller.importBufferGeometry(geometry, {
      name: 'Second',
      transform: { ...identityTransform(), translationMm: [40, 0, 0] as const },
    });
    geometry.dispose();
    check('two models', { modelCount: 2 });
    controller.selectInstance(first.instanceId);
    check('instance selected', { hasSelection: true, hasInstanceSelection: true });
    await controller.renameObject(first.objectId, 'Renamed');
    check('edited', { canRedo: false });
    assert.equal(await controller.undoAsync(), true);
    check('undone', { canRedo: true });
    await controller.addPlate('Second plate', { activate: true });
    check('second plate active', { modelCount: 0, plateCount: 2 });
    controller.clearSelection();
    check('cleared', { hasSelection: false, hasInstanceSelection: false });
  } finally {
    controller.dispose();
  }
});

console.log(`canonical UI facts tests passed: ${passed}`);
