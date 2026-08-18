/**
 * The calibration resources are pinned by hash, and the hashes are real (P8.2, P12.1).
 *
 * Eight of the fifteen workflows cannot be materialised because their geometry
 * lives in an upstream resource file rather than in a generator — the flow
 * families are a plate of patches, the pressure-advance line and pattern are
 * drawn shapes. The inventory records each of those files by path and git blob
 * hash, and this is what checks the recorded hash against upstream.
 *
 * That check is what makes the pin worth having. A resource hash that has
 * quietly stopped matching means the geometry a future loader would read is not
 * the geometry the inventory was audited against, and the audit is where the
 * envelope numbers used for bed-fit come from. Getting that wrong places a
 * calibration off the bed.
 *
 * Where the pinned tree is not checked out, the shape and internal consistency
 * of the recorded hashes are still held — and `resources.test.ts` proves the
 * bytes this build ships hash to exactly them — but re-resolving them against
 * upstream needs the clone and says so rather than claiming it happened.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { calibrationInventory, PINNED_CALIBRATION_COMMIT } from '../calibrationInventory';

let passed = 0;
/**
 * A trace may return a note, which is printed on the result line, so a run that
 * could not reach upstream never reads as one that did.
 */
function test(name: string, run: () => void | string): void {
  const note = run();
  passed += 1;
  console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`);
}

const PINNED_TREE = resolve(import.meta.dirname, '../../../../third_party/SnapmakerOrca');
const hasPinnedTree = existsSync(resolve(PINNED_TREE, '.git'));

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

test('one path never carries two hashes, however many workflows reach for it', () => {
  // The flow stages and the two pressure-advance variants share files. If the
  // same path were recorded under two hashes, one of the two loads would refuse
  // valid bytes and which one it was would depend on the workflow taken.
  const byPath = new Map<string, string>();
  for (const resource of resources) {
    const prior = byPath.get(resource.path);
    if (prior !== undefined) {
      assert.equal(resource.blob, prior, `${resource.path} is recorded under one hash`);
    }
    byPath.set(resource.path, resource.blob);
  }
});

test('every recorded blob is the blob of the file at the pinned commit', () => {
  // Deliberately not a pass claiming more than it did: the recorded hashes are
  // held to shape and consistency above, and re-deriving them from upstream is
  // what needs the clone.
  if (!hasPinnedTree) return 'not re-derived: no pinned checkout';
  const mismatched: string[] = [];
  for (const resource of resources) {
    // Resolved at the pinned commit, never off the worktree: a clone left on
    // another branch, or with edits in it, must not be able to make this pass.
    let actual: string;
    try {
      actual = execFileSync('git', ['-C', PINNED_TREE, 'rev-parse', `${PINNED_CALIBRATION_COMMIT}:${resource.path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      mismatched.push(`${resource.path} is not present at ${PINNED_CALIBRATION_COMMIT}`);
      continue;
    }
    if (actual !== resource.blob) {
      mismatched.push(`${resource.path} is ${actual}, recorded as ${resource.blob}`);
    }
  }
  assert.deepEqual(mismatched, [], 'every calibration resource matches the hash it was audited under');
});

test('resources are pinned to one commit, and it is the audited one', () => {
  assert.match(PINNED_CALIBRATION_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(
    calibrationInventory.upstream.commit,
    PINNED_CALIBRATION_COMMIT,
    'the generated inventory was derived at the pin',
  );
  if (!hasPinnedTree) return 'commit not resolved: no pinned checkout';
  const resolved = execFileSync('git', ['-C', PINNED_TREE, 'rev-parse', `${PINNED_CALIBRATION_COMMIT}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  assert.equal(resolved, PINNED_CALIBRATION_COMMIT, 'the calibration pin names a commit the tree actually has');
  const tree = execFileSync('git', ['-C', PINNED_TREE, 'rev-parse', `${PINNED_CALIBRATION_COMMIT}^{tree}`], {
    encoding: 'utf8',
  }).trim();
  assert.equal(tree, calibrationInventory.upstream.tree, 'and the tree the inventory recorded');
});

console.log(
  `\nCalibration resources: ${passed} tests passed (${resources.length} pinned files` +
    `${hasPinnedTree ? ', re-derived from the pinned tree' : ', upstream re-derivation skipped'}).`,
);
