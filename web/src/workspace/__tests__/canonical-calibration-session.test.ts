/**
 * A calibration must not cost the operator their project (P8.3).
 *
 * The plan asks for the original project to be preserved in a separate session
 * and for cancellation not to overwrite it. Adding a calibration model to the
 * project in front of the operator meets neither: their arrangement changes,
 * and "you can undo it" is not preservation — it is a request that they
 * remember to.
 *
 * These traces hold the guarantee at its strongest form: whatever a calibration
 * session does, cancelling it leaves the held project byte-identical, including
 * its fingerprint.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { identityTransform } from '../../project/domain/model';
import { projectFingerprint } from '../../project/domain/canonical';
import type { EntityId, IdSource } from '../../project/domain/ids';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../../project/calibration/compiler';
import type { CalibrationJobPrerequisites } from '../../project/calibration/types';
import { CALIBRATION_WORKFLOW_IDS } from '../../features/calibrationInventory';

const NOW = '2026-08-01T12:00:00.000Z';
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
    return `import:calibration-session:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

function controller(): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectImportParser: new BbsProjectImportParser(),
  });
}

function calibrationPrereqs(): CalibrationJobPrerequisites {
  return {
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
}

function cube(size = 10): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size, size, size).toNonIndexed();
}

function state(workspace: CanonicalWorkspaceController) {
  return workspace.createCanonicalSliceSource().capture().state;
}

/** A project with two arranged parts, standing in for real work. */
function withWork(workspace: CanonicalWorkspaceController): void {
  workspace.importBufferGeometry(cube(), {
    name: 'Bracket',
    transform: { ...identityTransform(), translationMm: [30, 40, 0] },
  });
  workspace.importBufferGeometry(cube(6), {
    name: 'Spacer',
    transform: { ...identityTransform(), translationMm: [80, 20, 0] },
  });
}

await test('a calibration session hands over a clean project, not the operator’s', () => {
  const workspace = controller();
  withWork(workspace);
  const before = state(workspace);
  assert.equal(before.plates[0].objects.length, 2, 'two parts arranged');

  assert.equal(workspace.beginCalibrationSession(), true);
  assert.equal(workspace.calibrationSessionOpen, true);

  const during = state(workspace);
  assert.equal(during.plates[0].objects.length, 0, 'the calibration starts on an empty plate');
  // The machine being calibrated has to be the machine that prints the test,
  // so the printer travels with the session even though the models do not.
  assert.deepEqual(during.printer, before.printer);
});

await test('cancelling restores the project byte-for-byte, whatever the calibration did', () => {
  const workspace = controller();
  withWork(workspace);
  const before = state(workspace);
  const fingerprintBefore = projectFingerprint(before);

  workspace.beginCalibrationSession();
  // A calibration is not a read-only visit: it adds geometry, and may add
  // several. None of it may survive the cancel.
  workspace.importBufferGeometry(cube(20), { name: 'Temperature tower' });
  workspace.importBufferGeometry(cube(4), { name: 'Flow patch' });

  assert.equal(workspace.cancelCalibrationSession(), true);
  assert.equal(workspace.calibrationSessionOpen, false);

  const after = state(workspace);
  assert.equal(projectFingerprint(after), fingerprintBefore, 'the fingerprint is the one from before');
  assert.deepEqual(after, before, 'and so is every field of the state');
});

await test('keeping the calibration lets the held project go, and says so by refusing a later cancel', () => {
  const workspace = controller();
  withWork(workspace);

  workspace.beginCalibrationSession();
  workspace.importBufferGeometry(cube(20), { name: 'Temperature tower' });
  assert.equal(workspace.keepCalibrationSession(), true);
  assert.equal(workspace.calibrationSessionOpen, false);

  const after = state(workspace);
  assert.equal(after.plates[0].objects.length, 1, 'the calibration is the project now');
  assert.equal(after.plates[0].objects[0].name, 'Temperature tower');
  // There is nothing held any more, so the operator cannot be told a cancel
  // succeeded when it would restore nothing.
  assert.equal(workspace.cancelCalibrationSession(), false);
});

await test('a session cannot nest, because the outer project would be stranded', () => {
  const workspace = controller();
  withWork(workspace);
  const before = state(workspace);

  assert.equal(workspace.beginCalibrationSession(), true);
  workspace.importBufferGeometry(cube(20), { name: 'First calibration' });
  // A second begin must not put the *calibration* aside and lose the real
  // project behind it. It reports false and changes nothing about what is held.
  assert.equal(workspace.beginCalibrationSession(), false);

  workspace.cancelCalibrationSession();
  assert.deepEqual(state(workspace), before, 'the operator’s project is what comes back');
});

await test('cancelling without a session is refused rather than resetting the project', () => {
  const workspace = controller();
  withWork(workspace);
  const before = state(workspace);

  assert.equal(workspace.cancelCalibrationSession(), false);
  assert.equal(workspace.keepCalibrationSession(), false);
  assert.deepEqual(state(workspace), before, 'a refused call is not an excuse to clear anything');
});

/**
 * Materialising a compiled plan (P8.2).
 *
 * The requirement is blunt: generated bands must carry real engine overrides
 * rather than visual labels alone. Until this landed the compiler produced the
 * overrides and nothing installed them, so a temperature tower was a tower
 * shape printed entirely at one temperature — which looks exactly like a
 * working calibration right up until the operator measures it.
 */
await test('a compiled plan installs its bands as canonical layer ranges carrying real overrides', () => {
  const workspace = controller();
  workspace.importBufferGeometry(cube(30), { name: 'Temperature tower' });
  const objectId = state(workspace).plates[0].objects[0].id;

  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', calibrationPrereqs()), {
    jobId: 'calibration:materialise-1',
  });
  const perHeight = plan.effects.filter((effect) => effect.zRangeMm !== null);
  assert.ok(perHeight.length > 1, 'a tower has several bands to install');

  const installed = workspace.applyCalibrationPlan(objectId, plan);
  assert.equal(installed.bands, perHeight.length, 'every band with a z range became a layer range');
  // The base band starts at the plate and becomes the print's starting setting
  // rather than an event, so there is exactly one fewer event than band.
  assert.equal(installed.events, perHeight.length - 1, 'every band above the plate carries its own command');
  assert.ok(installed.printKeys > 0, 'and the base band set the temperature the print starts at');

  const ranges = state(workspace).plates[0].objects[0].layerRanges;
  assert.equal(ranges.length, perHeight.length);
  for (const [index, effect] of perHeight.entries()) {
    const range = ranges[index];
    assert.equal(range.minZMm, effect.zRangeMm![0]);
    assert.equal(range.maxZMm, effect.zRangeMm![1]);
    const layerKeys = effect.engineOverrides.filter((override) => override.scope === 'layer');
    assert.ok(layerKeys.length > 0, 'the band carries an engine override, not just a label');
    for (const override of layerKeys) {
      assert.equal(
        range.config[override.key],
        String(override.value),
        `band ${index} writes ${override.key} the engine will read`,
      );
    }
    // Never omitted: the pinned engine faults on a range without it, which a
    // slice trace in `calibration-band-slice.test.ts` demonstrates directly.
    assert.ok(range.config.layer_height, `band ${index} carries a layer height, or the slicer crashes on it`);
  }
});

await test('installing a plan is one undoable act, not one per band', () => {
  const workspace = controller();
  workspace.importBufferGeometry(cube(30), { name: 'Temperature tower' });
  const objectId = state(workspace).plates[0].objects[0].id;
  const before = workspace.getSummary().history.undoCount;

  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', calibrationPrereqs()), {
    jobId: 'calibration:materialise-2',
  });
  workspace.applyCalibrationPlan(objectId, plan);
  assert.equal(
    workspace.getSummary().history.undoCount,
    before + 1,
    'a tower installed halfway prints its upper bands at the wrong settings and looks fine in the G-code',
  );

  workspace.undo();
  assert.deepEqual(state(workspace).plates[0].objects[0].layerRanges, [], 'one undo takes the whole plan back out');
});

await test('a plan cannot be installed onto an object that is not there', () => {
  const workspace = controller();
  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('temperature-tower', calibrationPrereqs()), {
    jobId: 'calibration:materialise-3',
  });
  assert.throws(() => workspace.applyCalibrationPlan('import:missing:object-1' as never, plan), /Unknown object/);
});

await test('every pinned workflow either installs or refuses by name — never silently nothing', () => {
  // The sweep that matters. Seven of the fifteen express their effects per
  // object or per line rather than per height, and an earlier version of
  // `applyCalibrationPlan` reported success on those while installing nothing
  // at all: no bands, no events, a project that slices and calibrates nothing.
  // A refusal is a fine answer here. Silence is not.
  const installed: string[] = [];
  const refused: string[] = [];
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const workspace = controller();
    workspace.importBufferGeometry(cube(30), { name: id });
    const objectId = state(workspace).plates[0].objects[0].id;
    const prereqs = calibrationPrereqs();
    const flavor = id === 'junction-deviation' ? 'marlin' : 'klipper';
    const plan = compileCalibrationJob(
      createDefaultCalibrationJobRequest(id, { ...prereqs, firmware: { ...prereqs.firmware, flavor } }),
      { jobId: 'calibration:sweep' },
    );
    try {
      const result = workspace.applyCalibrationPlan(objectId, plan);
      assert.ok(
        result.bands + result.events + result.objectKeys > 0,
        `${id} reported success while installing nothing`,
      );
      installed.push(id);
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, new RegExp(id), `${id} refuses by naming itself; got: ${message}`);
      assert.match(message, /Nothing was changed/, `${id} says the project is untouched`);
      // A refusal must leave no trace, or "nothing was changed" is a lie.
      assert.deepEqual(state(workspace).plates[0].objects[0].layerRanges, [], `${id} left no half-installed bands`);
      refused.push(id);
    }
  }
  assert.ok(installed.length > 0, 'some workflows install');
  assert.equal(
    installed.length + refused.length,
    CALIBRATION_WORKFLOW_IDS.length,
    'every workflow gave a definite answer',
  );
  console.log(`    (${installed.length} install, ${refused.length} refuse: ${refused.join(', ')})`);
});

await test('a plan whose pieces cannot differ says so, rather than blaming placement', () => {
  // `tolerance-extension` compiles to six pieces at six bed positions carrying
  // *no* engine overrides, against a single-solid STL. Placing them would make
  // six identical gauges labelled 0 mm through 0.4 mm — a plate that looks like
  // a calibration and measures nothing. The refusal has to name that, because
  // "cannot yet materialise" invites someone to fix it by placing six copies.
  const workspace = controller();
  workspace.importBufferGeometry(cube(30), { name: 'Tolerance' });
  const objectId = state(workspace).plates[0].objects[0].id;
  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('tolerance-extension', calibrationPrereqs()), {
    jobId: 'calibration:tolerance',
  });
  assert.ok(
    plan.effects.every((effect) => effect.engineOverrides.length === 0),
    'the premise: this plan really does carry no per-piece setting',
  );
  assert.throws(
    () => workspace.applyCalibrationPlan(objectId, plan),
    /no setting that differs between them.*identical parts under different labels/s,
  );
});

console.log(`\nCalibration session: ${passed} tests passed.`);
