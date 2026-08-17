/**
 * Traces for the contextual calibration documentation links (P8.3).
 *
 * The property that matters is that the link goes somewhere real. An invented
 * documentation URL is worse than none: it sends an operator away and gives
 * them nothing, and it does so with the authority of a link that looks correct.
 * So every target is checked against the pinned tree itself.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { CALIBRATION_WORKFLOW_IDS, PINNED_CALIBRATION_COMMIT } from '../../features/calibrationInventory';
import { calibrationDocHref, calibrationDocPath } from './docs';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PINNED_TREE = resolve(import.meta.dirname, '../../../../third_party/SnapmakerOrca');

test('every pinned calibration has a documentation target', () => {
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const path = calibrationDocPath(workflow);
    assert.match(path, /^doc\/calibration\/[a-z0-9-]+\.md$/, `${workflow} names a doc file`);
  }
});

test('every documentation target is a file that exists in the pinned tree', () => {
  // Checked against the checkout rather than trusted. If the submodule is not
  // present this cannot run, and it says so rather than passing quietly — a
  // link check that silently skips is how a dead link ships.
  if (!existsSync(PINNED_TREE)) {
    throw new Error(
      `The pinned Snapmaker OrcaSlicer tree is not checked out at ${PINNED_TREE}, so documentation links cannot be verified.`,
    );
  }
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const file = resolve(PINNED_TREE, calibrationDocPath(workflow));
    assert.ok(
      existsSync(file),
      `${workflow} points at ${calibrationDocPath(workflow)}, which is not in the pinned tree`,
    );
  }
});

test('links name the pinned commit, never a moving branch', () => {
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const href = calibrationDocHref(workflow);
    assert.ok(href.includes(PINNED_CALIBRATION_COMMIT), `${workflow} pins its documentation link`);
    // The point of pinning: a link to a branch documents whatever upstream is
    // doing today, which need not be what this build does.
    assert.ok(!/\/blob\/(main|master)\//.test(href), `${workflow} must not link to a moving branch`);
    assert.ok(href.startsWith('https://'), `${workflow} link is https`);
  }
});

test('workflows that share a document say so by sharing the file, not by copying it', () => {
  // The four flow workflows are stages of one procedure and upstream documents
  // them together. Mapping each to its own invented page would imply four
  // guides that do not exist.
  const flow = ['flow-pass-1', 'flow-pass-2', 'flow-yolo', 'flow-yolo-perfectionist'] as const;
  const paths = new Set(flow.map((workflow) => calibrationDocPath(workflow)));
  assert.equal(paths.size, 1, 'the flow stages share one pinned guide');
});

console.log(`\nCalibration docs: ${passed} tests passed.`);
