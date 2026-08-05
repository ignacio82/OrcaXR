import assert from 'node:assert/strict';
import * as THREE from 'three';

import { entityId, type EntityId, type IdSource } from '../../project/domain/ids';
import type { MixedFilament, PhysicalFilament } from '../../project/domain/model';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

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
    const id = `import:reset-controller-test:${kind}-${this.nextNumber}` as EntityId<Kind>;
    this.nextNumber += 1;
    return id;
  }
}

await test('starts a saveable clean project with fresh IDs while retaining only the base printer profile and heads', async () => {
  const inheritedConfig = {
    printable_area: ['0x0', '270x0', '270x270', '0x270'],
    layer_height: 0.24,
    wall_loops: 2,
    retained_profile_probe: 'base',
  };
  const physical: PhysicalFilament[] = [
    {
      id: entityId<'physical-filament'>('import:reset-controller-test:physical-a'),
      name: 'Head A PLA',
      toolId: 0,
      presetId: 'pla-a',
      presetHash: 'sha256:pla-a',
      material: 'PLA',
      vendor: 'Snapmaker',
      color: '#ff0000',
      nozzleDiameterMm: 0.4,
      config: { nozzle_temperature: 215 },
      enabled: true,
    },
    {
      id: entityId<'physical-filament'>('import:reset-controller-test:physical-b'),
      name: 'Head B PETG',
      toolId: 1,
      presetId: 'petg-b',
      presetHash: 'sha256:petg-b',
      material: 'PETG',
      vendor: 'Snapmaker',
      color: '#0000ff',
      nozzleDiameterMm: 0.4,
      config: { nozzle_temperature: 245 },
      enabled: true,
    },
  ];
  const mixed: MixedFilament = {
    id: entityId<'mixed-filament'>('import:reset-controller-test:mixed-ab'),
    name: 'Transient purple',
    displayColor: '#800080',
    components: physical.map((filament) => ({ filamentId: filament.id, weight: 1 })),
    distribution: { mode: 'ratio' },
    config: {},
    enabled: true,
  };
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectName: 'Reset source',
    toolCount: 2,
    initialProjectConfig: inheritedConfig,
    projectImportParser: new BbsProjectImportParser(),
    fullSpectrumAutoPairPreferences: { enabled: true },
  });
  controller.setSlicingConfiguration({
    printer: {
      profileId: 'snapmaker-u1-0.4',
      profileHash: 'sha256:snapmaker-u1-0.4',
      toolCount: 2,
    },
    config: inheritedConfig,
    settingsOverrides: {
      layer_height: 0.1,
      transient_override_probe: true,
    },
    filaments: { physical, mixed: [mixed] },
  });
  const geometry = new THREE.BoxGeometry(10, 12, 14);
  const imported = controller.importBufferGeometry(geometry, { name: 'Reset me' });
  controller.selectInstance(imported.instanceId);
  controller.renamePlate(controller.getSummary().activePlateId, 'Dirty plate');
  controller.addPlate('Transient plate');
  assert.equal(controller.undo(), true);

  const before = controller.getSummary();
  const retained = controller.getSlicingConfiguration();
  assert.equal(before.dirty, true);
  assert.ok(before.history.undoCount > 0);
  assert.equal(before.history.redoCount, 1);
  assert.equal(before.assetCount, 1);
  assert.equal(retained.filaments.mixed.length, 2);

  controller.resetProject();

  const reset = controller.getSummary();
  assert.notEqual(reset.projectId, before.projectId);
  assert.notEqual(reset.activePlateId, before.activePlateId);
  assert.equal(reset.projectName, 'Untitled project');
  assert.deepEqual(reset.plates, [
    {
      id: reset.activePlateId,
      name: 'Plate 1',
      order: 0,
      active: true,
      printable: true,
      objectCount: 0,
      instanceCount: 0,
      modelVolumeCount: 0,
    },
  ]);
  assert.equal(reset.objectCount, 0);
  assert.equal(reset.instanceCount, 0);
  assert.equal(reset.modelVolumeCount, 0);
  assert.equal(reset.assetCount, 0);
  assert.deepEqual(reset.selectedInstanceIds, []);
  assert.equal(reset.primaryInstanceId, undefined);
  assert.deepEqual(reset.history, {
    undoCount: 0,
    redoCount: 0,
    undoLabel: undefined,
    redoLabel: undefined,
    dirtyCategories: [],
  });
  assert.equal(reset.dirty, false);
  assert.equal(controller.undo(), false);
  assert.equal(controller.redo(), false);

  const resetSettings = controller.getProjectSettingsOverrideSnapshot();
  assert.deepEqual(resetSettings.inheritedConfig, inheritedConfig);
  assert.deepEqual(resetSettings.overrides, {});
  assert.deepEqual(resetSettings.effectiveConfig, inheritedConfig);
  const resetSlicing = controller.getSlicingConfiguration();
  assert.deepEqual(resetSlicing.printer, retained.printer);
  assert.deepEqual(resetSlicing.config, inheritedConfig);
  assert.deepEqual(resetSlicing.settingsOverrides, {});
  assert.deepEqual(resetSlicing.filaments.physical, retained.filaments.physical);
  assert.equal(resetSlicing.filaments.mixed.length, 1);
  assert.equal(resetSlicing.filaments.mixed[0].fullSpectrum?.custom, false);
  assert.equal(resetSlicing.filaments.mixed[0].fullSpectrum?.originAuto, true);
  assert.notEqual(resetSlicing.filaments.mixed[0].id, retained.filaments.mixed[0].id);

  const saved = await controller.saveCanonical3mf();
  assert.ok(saved.bytes.byteLength > 0);
  assert.equal(saved.sourceRevision, reset.revision);
  assert.equal(saved.sourceHash, reset.projectHash);
  assert.equal(controller.getSummary().dirty, false);

  geometry.dispose();
  controller.dispose();
});

console.log(`\nCanonical workspace reset: ${passed} tests passed.`);
