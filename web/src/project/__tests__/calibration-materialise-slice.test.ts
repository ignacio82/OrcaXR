/**
 * A materialised calibration actually slices, and its bands are in the program (P8.3, P8.2).
 *
 * Everything so far verified halves. `applyCalibrationPlan` was checked against
 * canonical state, and the band mechanisms were checked against the engine with
 * hand-built archives. Nothing had put the *output of the materialisation* to
 * the slicer, so the join between them was assumed — and every assumption of
 * that shape checked this session has turned out to be wrong at least once.
 *
 * This drives the real path end to end: compile a plan, materialise it through
 * the controller, serialize what the controller holds, and slice that.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BbsProjectImportParser } from '../import/BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { CanonicalWorkspaceController } from '../../workspace/CanonicalWorkspaceController';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../calibration/compiler';
import { baseSliceConfig, sliceArchive } from './sliceHarness';
import type { EntityId, IdSource } from '../domain/ids';
import type { CalibrationJobPrerequisites } from '../calibration/types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    return `import:calib-slice:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

const PREREQS: CalibrationJobPrerequisites = {
  printer: {
    id: 'printer:snapmaker-u1',
    manufacturer: 'Snapmaker',
    model: 'U1',
    bedWidthMm: 270,
    bedDepthMm: 270,
    buildHeightMm: 270,
    maxPrintSpeedMmPerS: 300,
    maxAccelerationMmPerS2: 10_000,
  },
  nozzle: { diameterMm: 0.4, minTemperatureC: 170, maxTemperatureC: 300, maxLayerHeightMm: 0.32 },
  filament: {
    id: 'filament:pla-red',
    name: 'Red PLA',
    material: 'PLA',
    minTemperatureC: 180,
    maxTemperatureC: 260,
    flowRatio: 0.98,
    maxVolumetricSpeedMm3PerS: 30,
    retractionLengthMm: 0.8,
  },
  process: {
    id: 'process:quality',
    layerHeightMm: 0.2,
    firstLayerHeightMm: 0.2,
    lineWidthMm: 0.45,
    outerWallSpeedMmPerS: 120,
    defaultAccelerationMmPerS2: 5_000,
    xyHoleCompensationMm: 0,
    xyContourCompensationMm: 0,
  },
  firmware: {
    flavor: 'klipper',
    nozzleTemperature: true,
    pressureAdvance: true,
    inputShaping: true,
    junctionDeviation: true,
    maxInputShapingFrequencyHz: 500,
  },
};

await test('a temperature tower materialised through the controller slices with its bands in it', async () => {
  const workspace = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => '2026-08-01T12:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });

  // Tall enough to carry every band, and standing *on* the bed. Three's box is
  // centred on the origin, so an untranslated 90 mm box spans -45..45 and the
  // engine simply has no layers above 45 mm — the top bands then go missing
  // and the test fails for a reason that has nothing to do with the code under
  // it. This cost a run to find; the translate is the whole fix.
  const tower = new THREE.BoxGeometry(20, 20, 90).toNonIndexed();
  tower.translate(0, 0, 45);
  workspace.importBufferGeometry(tower, { name: 'Temperature tower' });
  const captured = workspace.createCanonicalSliceSource().capture();
  const objectId = captured.state.plates[0].objects[0].id;

  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', PREREQS), {
    jobId: 'calibration:end-to-end',
  });
  const installed = workspace.applyCalibrationPlan(objectId, plan);
  assert.ok(installed.events > 0, 'the plan installed commands to reach the program');

  // Serialize exactly what the controller now holds, and give the engine a
  // profile config so it is a real slice rather than a defaults slice.
  const snapshot = workspace.createCanonicalSliceSource().capture();
  // Base and effective config are swapped together: the canonical invariant is
  // that effective equals base plus explicit overrides, and the plan wrote real
  // overrides for the base band, so replacing only the effective config would
  // produce a state the validator rejects — and rightly, since it would no
  // longer describe what the overrides did.
  const base = await baseSliceConfig();
  const overrides = snapshot.state.settingsOverrides ?? {};
  const state = {
    ...snapshot.state,
    settingsBaseConfig: { ...base },
    config: { ...base, ...overrides },
  } as typeof snapshot.state;
  const bytes = (
    await new Bbs3mfProjectSerializer().serialize({
      state,
      assets: snapshot.assets,
      sourceRevision: 1,
      sourceHash: 'calibration-end-to-end',
    })
  ).bytes;

  const gcode = await sliceArchive(bytes, 'calibration-materialised');

  // Every band that became an event must be commanded, and the temperatures
  // must be the ones the plan declared — not merely "some M104 appears".
  const commanded = new Set([...gcode.matchAll(/^M10[49] S(\d+)/gm)].map((match) => Number(match[1])));
  const expected = plan.effects
    .filter((effect) => effect.zRangeMm !== null && effect.zRangeMm[0] > 0)
    .map((effect) => Number(effect.value));
  assert.ok(expected.length > 1, 'a tower has several bands above the plate');
  const missing = expected.filter((temperature) => !commanded.has(temperature));
  assert.deepEqual(
    missing,
    [],
    `every band the plan declared is commanded; missing ${missing.join(', ')} from ${[...commanded].join(', ')}`,
  );
});

console.log(`\nMaterialised calibration slicing: ${passed} tests passed.`);
