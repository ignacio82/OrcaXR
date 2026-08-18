/**
 * The surface classification pass P11.2 asks for (P11.2, P0.1, P0.2).
 *
 * "The P0 surface manifest has no unclassified item" is half of P11.2's
 * acceptance, and it was the half nobody could check: 205 upstream menu items
 * were dispositioned to this task and then never answered one by one. This runs
 * the answer against three files that are maintained separately — the pinned
 * manifest, the reviewed overlay, and the live action catalog — so a drift in
 * any of them is a failure rather than a stale claim.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildRegistry } from '../catalog';
import {
  adaptationIdsFrom,
  auditUpstreamSurfaces,
  surfaceKey,
  taskIdsFrom,
  type UpstreamSurfaceMap,
} from '../upstreamSurfaces';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = resolve(import.meta.dirname, '../../../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'docs/parity/snapmaker-v2.3.4.json'), 'utf8'));
const map = JSON.parse(readFileSync(resolve(root, 'tools/parity/surface-map.json'), 'utf8')) as UpstreamSurfaceMap;
const plan = readFileSync(resolve(root, 'docs/parity.md'), 'utf8');
const leaves = manifest.inventory.menuActions as { id: string; label: string; symbol?: string }[];
const known = { adaptations: adaptationIdsFrom(plan), tasks: taskIdsFrom(plan) };

test('the plan really does define the ids the overlay cites', () => {
  // Guard for the guard: if these parsers silently found nothing, every
  // adaptation and task reference below would pass by accident.
  assert.ok(known.adaptations.size >= 14, `adaptation register looks empty: ${known.adaptations.size}`);
  assert.ok(known.tasks.size >= 90, `task list looks empty: ${known.tasks.size}`);
  assert.ok(known.adaptations.has('ADAPT-01') && known.tasks.has('P11.2'));
});

test('every upstream menu item is classified, and nothing classifies a ghost', () => {
  const audit = auditUpstreamSurfaces(leaves, map, buildRegistry(), known);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.leaves, 205, 'the pinned manifest still has 205 menu leaves');
  assert.equal(audit.keys, 162, 'they collapse to 162 distinct symbol/label items');
  const { byKind } = audit;
  const total = Object.values(byKind).reduce((sum, count) => sum + count, 0);
  assert.equal(total, audit.keys);
  console.log(
    `    ${audit.keys} upstream items: ${Object.entries(byKind)
      .sort()
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')}`,
  );
});

test('an unclassified item fails, which is the whole point', () => {
  const withoutOne = {
    ...map,
    mappings: Object.fromEntries(Object.entries(map.mappings).filter(([key]) => key !== surfaceKey(leaves[0]))),
  };
  const audit = auditUpstreamSurfaces(leaves, withoutOne, buildRegistry(), known);
  assert.ok(
    audit.problems.some((problem) => problem.includes('is unclassified')),
    'dropping a mapping must be caught, or this check proves nothing',
  );
});

test('a mapping to an action that does not exist fails', () => {
  const broken = {
    ...map,
    mappings: { ...map.mappings, [surfaceKey(leaves[0])]: { kind: 'action' as const, action: 'no_such_action' } },
  };
  const audit = auditUpstreamSurfaces(leaves, broken, buildRegistry(), known);
  assert.ok(audit.problems.some((problem) => problem.includes('unknown action no_such_action')));
});

test('a cited adaptation or task that the plan does not define fails', () => {
  const key = surfaceKey(leaves[0]);
  const invented = {
    ...map,
    mappings: {
      ...map.mappings,
      [key]: { kind: 'adaptation' as const, adaptation: 'ADAPT-99', reason: 'invented' },
    },
  };
  assert.ok(
    auditUpstreamSurfaces(leaves, invented, buildRegistry(), known).problems.some((problem) =>
      problem.includes('ADAPT-99'),
    ),
  );
  const owed = {
    ...map,
    mappings: { ...map.mappings, [key]: { kind: 'absent' as const, task: 'P99.9', reason: 'invented' } },
  };
  assert.ok(
    auditUpstreamSurfaces(leaves, owed, buildRegistry(), known).problems.some((problem) => problem.includes('P99.9')),
  );
});

test('every upstream item we claim to have reaches DOM, search, and either XR or a reason', () => {
  const audit = auditUpstreamSurfaces(leaves, map, buildRegistry(), known);
  assert.ok(audit.reached.length > 80, `only ${audit.reached.length} upstream items map to an action`);
  // The audit already fails on a reachability gap; this states the count that
  // gap-checking covers, so a shrinking catalog cannot pass by mapping less.
  const registry = buildRegistry();
  for (const { action } of audit.reached) {
    const entry = registry.get(action);
    assert.ok(entry, `${action} vanished from the catalog`);
  }
});

console.log(`\nUpstream surface classification: ${passed} tests passed.`);
