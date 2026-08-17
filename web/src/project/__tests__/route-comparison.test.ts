/**
 * The route comparator, exercised against real engine output (P12.3).
 *
 * P12.3 names a route-comparison corpus and there was none. The external CLI is
 * not present in this environment, so the comparison itself cannot be *run*
 * here — but the comparator can be built and proved, and that is the half that
 * decides whether the corpus is worth anything when a qualifier does run it.
 *
 * The trace that matters is the one that makes it fail. A comparator verified
 * only on identical inputs is a check that can never report anything, which is
 * indistinguishable from no corpus at all — and this session has already found
 * four passing checks that were measuring nothing.
 */

import assert from 'node:assert/strict';

import { compareSummaries, summariseProgram } from '../../../../tools/parity/route-comparison.mjs';
import { buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

let program: string | null = null;
async function realProgram(): Promise<string> {
  program ??= await sliceArchive(await buildSliceArchive({}), 'route-comparison');
  return program;
}

await test('a real program summarises into the facts a printer acts on', async () => {
  const summary = summariseProgram(await realProgram());
  assert.ok(summary.layers > 1, 'it has layers');
  assert.ok((summary.filamentMm ?? 0) > 0, 'and a filament total');
  assert.ok(summary.roles.length > 0, 'and extrusion roles');
  assert.ok(summary.commands.includes('G1'), 'and the moves themselves');
});

await test('a route compared with itself reports nothing', async () => {
  const summary = summariseProgram(await realProgram());
  assert.deepEqual(compareSummaries(summary, summary), []);
});

await test('a dropped extrusion role is caught', async () => {
  // The failure this corpus exists for: one build emits supports or a brim and
  // the other silently does not. Byte comparison would drown in header noise;
  // this names the missing role.
  const summary = summariseProgram(await realProgram());
  const missingRole = { ...summary, roles: summary.roles.slice(1) };
  const differences = compareSummaries(summary, missingRole);
  assert.ok(differences.length > 0);
  assert.match(differences.join(' '), /extrusion roles only in the first route/);
});

await test('a dropped printer command is caught', async () => {
  const summary = summariseProgram(await realProgram());
  const missingCommand = { ...summary, commands: summary.commands.filter((c: string) => c !== 'G1') };
  assert.match(compareSummaries(summary, missingCommand).join(' '), /commands only in the first route: G1/);
});

await test('filament is compared proportionally, not absolutely', async () => {
  // Two builds round differently across thousands of moves. An absolute
  // threshold would pass a real divergence on a large print and fail rounding
  // noise on a small one, so the tolerance is relative.
  const summary = summariseProgram(await realProgram());
  const base = summary.filamentMm as number;
  assert.deepEqual(compareSummaries(summary, { ...summary, filamentMm: base * 1.005 }), [], 'half a percent passes');
  assert.ok(compareSummaries(summary, { ...summary, filamentMm: base * 1.05 }).length > 0, 'five percent does not');
});

await test('a layer-count difference is never a tolerance question', async () => {
  const summary = summariseProgram(await realProgram());
  assert.match(compareSummaries(summary, { ...summary, layers: summary.layers - 1 }).join(' '), /layer count/);
});

console.log(`\nRoute comparison: ${passed} tests passed.`);
