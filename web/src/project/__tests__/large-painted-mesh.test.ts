import assert from 'node:assert/strict';

import {
  ORCA_REFINEMENT_ENCODING_VERSION,
  ORCA_REFINEMENT_MAX_NODES,
  ORCA_REFINEMENT_MAX_NODES_PER_TRIANGLE,
  refinementNodeBudget,
  type FacetRefinementNode,
} from '../domain/model';
import { validateFacetRefinementChannel } from '../domain/facetRefinement';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * A painted mesh carries exactly one refinement root per source triangle, so
 * any *flat* cap on the aggregate node count is really a cap on how many
 * triangles a painted model may have. A real 1.9M-triangle painted project
 * that the pinned engine opens without complaint was refused on that basis, in
 * four separate places, and could not be opened, validated, saved, or reopened.
 * These pin the rule that replaced it: the budget scales with the geometry.
 */

test('the node budget scales with the mesh instead of capping it', () => {
  // Small meshes keep a generous floor.
  assert.equal(refinementNodeBudget(0), ORCA_REFINEMENT_MAX_NODES);
  assert.equal(refinementNodeBudget(1_000), ORCA_REFINEMENT_MAX_NODES);

  // Large ones scale, so one root per triangle is always affordable.
  const triangles = 1_897_256; // The real narwhal project.
  const budget = refinementNodeBudget(triangles);
  assert.equal(budget, triangles * ORCA_REFINEMENT_MAX_NODES_PER_TRIANGLE);
  assert.ok(budget > triangles, 'a mesh must be able to hold its own roots');
  assert.ok(budget > ORCA_REFINEMENT_MAX_NODES, 'the old flat cap sat below the root count of a legitimate model');
});

test('a painted mesh larger than the flat cap validates', () => {
  // Deliberately just over the old constant: this is the exact shape that used
  // to be rejected, and it is the cheapest input that proves the fix.
  const triangleCount = ORCA_REFINEMENT_MAX_NODES + 1;
  const unpainted: FacetRefinementNode = { kind: 'leaf', state: { kind: 'unpainted' } };
  const painted: FacetRefinementNode = { kind: 'leaf', state: { kind: 'assigned', value: 'tool-a' } };
  const roots: FacetRefinementNode[] = new Array(triangleCount);
  for (let index = 0; index < triangleCount; index += 1) roots[index] = index % 3 === 0 ? painted : unpainted;
  // One genuinely subdivided facet, which is what forces the dense encoding.
  roots[0] = {
    kind: 'split',
    splitSides: 1,
    specialSide: 0,
    children: [painted, unpainted],
  };

  const assignments = [{ value: 'tool-a', triangles: [] as number[] }];
  const issues = validateFacetRefinementChannel(
    'color',
    { version: ORCA_REFINEMENT_ENCODING_VERSION, roots },
    assignments,
    { triangleCount, path: 'volume.annotations.refinement.color' },
  );
  const limitIssues = issues.filter((issue) => issue.code === 'facet-refinement-limit-exceeded');
  assert.deepEqual(limitIssues, [], 'a mesh may hold one root per triangle whatever its size');
});

test('expansion far beyond the geometry is still refused', () => {
  // A tiny mesh whose paint tree is enormous is the case the budget exists for.
  const triangleCount = 4;
  const budget = refinementNodeBudget(triangleCount);
  const deep = (depth: number): FacetRefinementNode =>
    depth === 0
      ? { kind: 'leaf', state: { kind: 'unpainted' } }
      : {
          kind: 'split',
          splitSides: 3,
          specialSide: 0,
          children: [deep(depth - 1), deep(depth - 1), deep(depth - 1), deep(depth - 1)],
        };
  // 4^11 leaves is comfortably past the floor for a four-triangle mesh.
  const roots = [deep(11), deep(11), deep(11), deep(11)];
  const issues = validateFacetRefinementChannel('color', { version: ORCA_REFINEMENT_ENCODING_VERSION, roots }, [], {
    triangleCount,
    path: 'volume.annotations.refinement.color',
  });
  assert.ok(
    issues.some((issue) => issue.code === 'facet-refinement-limit-exceeded'),
    `a four-triangle mesh may not carry more than ${budget} nodes`,
  );
});

console.log(`\nLarge painted mesh limits: ${passed} tests passed.`);
