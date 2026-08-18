/**
 * Traces for the contextual calibration documentation links (P8.3).
 *
 * The property that matters is that the link goes somewhere real. An invented
 * documentation URL is worse than none: it sends an operator away and gives
 * them nothing, and it does so with the authority of a link that looks correct.
 *
 * So every target is checked against the pinned tree — and where the tree is
 * not checked out, against the generated inventory that was derived from it.
 * That is not the check quietly skipping: the inventory records each target's
 * Git blob at the pinned commit, and a blob id can only have come from
 * resolving that path in that tree. What a checkout without the clone cannot
 * do is notice that upstream's guide moved *after* the inventory was generated,
 * and that is exactly what regenerating it on a developer machine catches.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  calibrationInventory,
  CALIBRATION_WORKFLOW_IDS,
  PINNED_CALIBRATION_COMMIT,
} from '../../features/calibrationInventory';
import { calibrationDocBlob, calibrationDocHref, calibrationDocPath } from './docs';

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

test('every pinned calibration has a documentation target', () => {
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const path = calibrationDocPath(workflow);
    assert.match(path, /^doc\/calibration\/[a-z0-9-]+\.md$/, `${workflow} names a doc file`);
  }
});

test('the app links exactly what the pinned inventory recorded, with no second copy of the map', () => {
  // The mapping used to live in `docs.ts` as its own table. Two tables drift:
  // the generator would keep proving its own paths exist while the app linked
  // the other ones. Holding them to identity is what makes the check below
  // cover what an operator actually clicks.
  assert.equal(calibrationInventory.documentation.length, CALIBRATION_WORKFLOW_IDS.length);
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const target = calibrationInventory.documentation.find((entry) => entry.workflowId === workflow);
    assert.ok(target, `${workflow} has a recorded documentation target`);
    assert.equal(calibrationDocPath(workflow), target.path, `${workflow} links its recorded target`);
    assert.match(calibrationDocBlob(workflow), /^[0-9a-f]{40}$/, `${workflow} records a pinned blob`);
  }
});

test('every documentation target resolves to a blob at the pinned commit', () => {
  // The recorded blob is the evidence, and the trace above holds the app to it;
  // what needs the clone is re-resolving it against upstream.
  if (!hasPinnedTree) return 'not re-resolved: no pinned checkout';
  for (const workflow of CALIBRATION_WORKFLOW_IDS) {
    const path = calibrationDocPath(workflow);
    // Read at the pinned commit rather than off the worktree: a dirty or
    // checked-out-elsewhere clone must not be able to make this pass.
    const blob = execFileSync('git', ['-C', PINNED_TREE, 'rev-parse', `${PINNED_CALIBRATION_COMMIT}:${path}`], {
      encoding: 'utf8',
    }).trim();
    assert.equal(blob, calibrationDocBlob(workflow), `${workflow} points at ${path} as it is at the pinned commit`);
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
  const blobs = new Set(flow.map((workflow) => calibrationDocBlob(workflow)));
  assert.equal(blobs.size, 1, 'and therefore one pinned blob');
});

console.log(
  `\nCalibration docs: ${passed} tests passed${hasPinnedTree ? ' (re-resolved against the pinned tree)' : ''}.`,
);
