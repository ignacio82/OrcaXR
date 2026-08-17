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

console.log(`\nCalibration session: ${passed} tests passed.`);
