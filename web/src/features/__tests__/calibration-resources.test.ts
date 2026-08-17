/**
 * The calibration resources are pinned by hash, and the hashes are real (P8.2, P12.1).
 *
 * Eight of the fifteen workflows cannot be materialised because their geometry
 * lives in an upstream resource file rather than in a generator — the flow
 * families are a plate of patches, the pressure-advance line and pattern are
 * drawn shapes. The inventory already records each of those files by path and
 * git blob hash, and until now nothing checked that the recorded hash matched
 * the file.
 *
 * That check is what makes the pin worth having. A resource hash that has
 * quietly stopped matching means the geometry a future loader would read is not
 * the geometry the inventory was audited against, and the audit is where the
 * envelope numbers used for bed-fit come from. Getting that wrong places a
 * calibration off the bed.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { calibrationInventory, PINNED_CALIBRATION_COMMIT } from '../calibrationInventory';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PINNED_TREE = resolve(import.meta.dirname, '../../../../third_party/SnapmakerOrca');

const resources = calibrationInventory.workflows.flatMap((workflow) =>
  workflow.resources.map((resource) => ({ workflow: workflow.id, ...resource })),
);

test('every workflow names at least one resource, by path and blob', () => {
  assert.ok(resources.length > 0, 'the inventory records resources at all');
  for (const resource of resources) {
    // Not all of them live under `calib/`: the tolerance gauge is one of
    // upstream's handy models, which is a fact about their tree, not a defect.
    assert.match(resource.path, /^resources\//, `${resource.workflow} names a file inside the upstream resource tree`);
    assert.match(resource.blob, /^[0-9a-f]{40}$/, `${resource.workflow} records a git blob id for ${resource.path}`);
  }
});

test('every recorded blob is the blob of the file in the pinned tree', () => {
  // Failing rather than skipping when the submodule is absent: a provenance
  // check that quietly passes is worth less than none, because it is believed.
  if (!existsSync(PINNED_TREE)) {
    throw new Error(`The pinned tree is not checked out at ${PINNED_TREE}, so resource hashes cannot be verified.`);
  }
  const mismatched: string[] = [];
  for (const resource of resources) {
    const file = resolve(PINNED_TREE, resource.path);
    if (!existsSync(file)) {
      mismatched.push(`${resource.path} is missing from the pinned tree`);
      continue;
    }
    const actual = execFileSync('git', ['-C', PINNED_TREE, 'hash-object', resource.path], {
      encoding: 'utf8',
    }).trim();
    if (actual !== resource.blob) {
      mismatched.push(`${resource.path} is ${actual}, recorded as ${resource.blob}`);
    }
  }
  assert.deepEqual(mismatched, [], 'every calibration resource matches the hash it was audited under');
});

test('resources are pinned to one commit, and it is the audited one', () => {
  assert.match(PINNED_CALIBRATION_COMMIT, /^[0-9a-f]{40}$/);
  const resolved = execFileSync('git', ['-C', PINNED_TREE, 'rev-parse', `${PINNED_CALIBRATION_COMMIT}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  assert.equal(resolved, PINNED_CALIBRATION_COMMIT, 'the calibration pin names a commit the tree actually has');
});

console.log(`\nCalibration resources: ${passed} tests passed (${resources.length} pinned files).`);
