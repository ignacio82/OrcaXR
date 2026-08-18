/**
 * Traces for calibration resource loading (P8.2).
 *
 * The property that carries the weight is refusal. These files decide where a
 * calibration sits on the bed — the compiler's fit numbers were audited from
 * exactly these bytes — so a file that has changed must stop the build rather
 * than warn about it, and a file that was never shipped must say so instead of
 * producing an empty plate.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { CalibrationResourceError, calibrationResourceFile, gitBlobId, loadCalibrationResource } from './resources';
import { calibrationInventory, PINNED_CALIBRATION_COMMIT } from '../../features/calibrationInventory';

let passed = 0;
/**
 * A trace may return a note, which is printed on the result line, so a run that
 * could not reach upstream never reads as one that did.
 */
async function test(name: string, run: () => Promise<void | string> | void | string): Promise<void> {
  const note = await run();
  passed += 1;
  console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`);
}

const PUBLIC = resolve(import.meta.dirname, '../../../public/calibration');
const PINNED_TREE = resolve(import.meta.dirname, '../../../../third_party/SnapmakerOrca');
const hasPinnedTree = existsSync(resolve(PINNED_TREE, '.git'));

/** Serve the shipped copies from disk, standing in for the network. */
const fromDisk: typeof fetch = (async (input: RequestInfo | URL) => {
  const file = String(input).replace('calibration/', '');
  const path = resolve(PUBLIC, file);
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(await readFile(path));
}) as typeof fetch;

const shipped = calibrationInventory.workflows
  .flatMap((workflow) => workflow.resources)
  .filter((resource) => existsSync(resolve(PUBLIC, calibrationResourceFile(resource.path))));

await test('the git blob id is computed the way Git computes it', async () => {
  // Checked against git itself rather than against a second implementation of
  // the same idea: `blob <len>\0<content>`, SHA-1. If this framing were wrong
  // every hash below would agree with every other hash and with nothing real.
  const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);
  const fromGit = execFileSync('git', ['hash-object', '--stdin'], { input: Buffer.from(bytes) })
    .toString()
    .trim();
  assert.equal(await gitBlobId(bytes), fromGit);
});

await test('every shipped resource is the audited bytes', async () => {
  assert.ok(shipped.length > 0, 'this build ships calibration geometry at all');
  for (const resource of shipped) {
    const bytes = await loadCalibrationResource(resource, fromDisk);
    assert.ok(bytes.byteLength > 0, `${resource.path} arrives with content`);
  }
});

await test('the shipped copy hashes to the blob the inventory audited', async () => {
  // This is the comparison to upstream that survives having no clone. A Git
  // blob id is the content, so a shipped file that hashes to the recorded blob
  // *is* the upstream bytes — and the recorded blob is held to the pinned
  // commit by `features/__tests__/calibration-resources.test.ts`. Together the
  // two make "was copied, not regenerated" checkable everywhere.
  for (const resource of shipped) {
    const copy = await readFile(resolve(PUBLIC, calibrationResourceFile(resource.path)));
    assert.equal(await gitBlobId(copy), resource.blob, `${resource.path} was copied, not regenerated`);
  }
});

await test('and is byte-identical to the pinned commit itself where it can be read', async () => {
  if (!hasPinnedTree) return 'not compared: no pinned checkout';
  for (const resource of shipped) {
    const copy = await readFile(resolve(PUBLIC, calibrationResourceFile(resource.path)));
    // `git show` at the pin rather than the worktree file: the point is what
    // upstream published at that commit, not what this clone happens to hold.
    const upstream = execFileSync('git', ['-C', PINNED_TREE, 'show', `${PINNED_CALIBRATION_COMMIT}:${resource.path}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.deepEqual(copy, upstream, `${resource.path} matches the pinned commit`);
  }
});

await test('a resource whose bytes changed is refused, not warned about', async () => {
  const resource = shipped[0];
  const tampered: typeof fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  await assert.rejects(
    loadCalibrationResource(resource, tampered),
    (error: unknown) =>
      error instanceof CalibrationResourceError &&
      error.code === 'wrong-bytes' &&
      /refusing to build a calibration/.test(error.message),
    'different geometry under the same name must stop the build',
  );
});

await test('a resource that was never shipped says so, rather than yielding nothing', async () => {
  const missing: typeof fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  await assert.rejects(
    loadCalibrationResource(shipped[0], missing),
    (error: unknown) => error instanceof CalibrationResourceError && error.code === 'not-shipped',
  );
});

console.log(
  `\nCalibration resources loading: ${passed} tests passed (${shipped.length} shipped` +
    `${hasPinnedTree ? ', compared to the pinned commit' : ', upstream byte comparison skipped'}).`,
);
