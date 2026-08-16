/**
 * Painted seam preference reaches the engine (P4.7, P7.1).
 *
 * Last of the facet-paint channels to be put to the slicer. Like the others it
 * is written into the model as a triangle attribute — `paint_seam` — and the
 * archive round-trip has always passed; nothing had asked what the seam placer
 * did with it.
 *
 * The gate comes from the pinned source, per the rule the earlier fixtures
 * earned: `SeamPlacer.cpp:715` reads a volume's enforcers and blockers whenever
 * `is_seam_painted()` holds, with no configuration prerequisite, so a default
 * project is the right baseline.
 *
 * What is asserted is that the paint *moves the seam*, and by a distance that
 * cannot be rounding — roughly a full object width here. Which way it moves is
 * deliberately not asserted: the seam coordinates are bed coordinates and the
 * loader centres the object, so a directional claim would be a claim about the
 * coordinate frame rather than about the paint, and this ledger has already
 * paid for four assertions that were really about the fixture.
 */

import assert from 'node:assert/strict';

import { CUBE_FACES, CUBE_MM, buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Where each outer-wall loop begins — the seam, one point per layer. */
function seamPoints(gcode: string): [number, number][] {
  const points: [number, number][] = [];
  let armed = false;
  for (const line of gcode.split('\n')) {
    if (/^;TYPE:Outer wall/.test(line)) {
      armed = true;
      continue;
    }
    if (!armed) continue;
    const match = /^G1 X([\d.-]+) Y([\d.-]+)/.exec(line);
    if (!match) continue;
    points.push([Number.parseFloat(match[1]), Number.parseFloat(match[2])]);
    armed = false;
  }
  return points;
}

function centroid(points: readonly [number, number][]): [number, number] {
  const sum = points.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

await test('a seam enforcer moves the seam', async () => {
  const plain = await sliceArchive(await buildSliceArchive(), 'seam-plain');
  const painted = await sliceArchive(
    await buildSliceArchive({
      annotations: (empty) => ({
        ...empty,
        seam: [{ triangles: [...CUBE_FACES.frontY0], value: 'prefer' }],
      }),
    }),
    'seam-painted',
  );

  const before = seamPoints(plain);
  const after = seamPoints(painted);
  assert.ok(before.length > 50, `the plain run has a seam on every layer: ${before.length}`);
  assert.equal(after.length, before.length, 'the same object still prints the same number of loops');

  const [bx, by] = centroid(before);
  const [ax, ay] = centroid(painted.length ? after : before);
  const moved = Math.hypot(ax - bx, ay - by);
  assert.ok(moved > CUBE_MM / 4, `the enforcer must move the seam further than rounding could: ${moved.toFixed(2)} mm`);
});

await test('an empty seam annotation leaves the seam where it was', async () => {
  // The channel is inert when it carries nothing, so the comparison above
  // measures the paint rather than the act of carrying an annotation.
  const plain = await sliceArchive(await buildSliceArchive(), 'seam-plain-a');
  const empty = await sliceArchive(
    await buildSliceArchive({ annotations: (blank) => ({ ...blank, seam: [] }) }),
    'seam-plain-b',
  );
  assert.deepEqual(centroid(seamPoints(empty)), centroid(seamPoints(plain)));
});

console.log(`\nSeam paint slicing: ${passed} tests passed.`);
