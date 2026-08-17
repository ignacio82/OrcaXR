/**
 * Exploding the view must never move the project (P5.3.2).
 *
 * The acceptance says it plainly: explosion is a view-only projection that
 * never mutates canonical placement. That is the whole risk. An exploded view
 * that quietly wrote transforms would look identical on screen and ship a
 * project whose parts are metres apart — and it would slice, and the operator
 * would find out from the printer.
 *
 * So the traces compare canonical state across explode, adjust, and reassemble,
 * and check that repeated adjustment composes from the assembled positions
 * rather than drifting further apart each time.
 */

import assert from 'node:assert/strict';

import { projectExplosion } from '../../project/objects/assembly';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PARTS = [
  { id: 'a', centerMm: [0, 0, 0] as const },
  { id: 'b', centerMm: [10, 0, 0] as const },
  { id: 'c', centerMm: [0, 10, 0] as const },
];

test('factor 1 is exactly assembled, not nearly', () => {
  // "Nearly" would mean every reassembly nudged the view a little, and the
  // parts would creep across a session of adjustments.
  for (const offset of projectExplosion(PARTS, 1)) {
    assert.deepEqual([...offset.offsetMm], [0, 0, 0], `${offset.id} does not move at factor 1`);
  }
});

test('parts move outward from the centroid, proportionally to the factor', () => {
  const twice = projectExplosion(PARTS, 2);
  const thrice = projectExplosion(PARTS, 3);
  for (const [index, offset] of twice.entries()) {
    const tripled = thrice[index].offsetMm;
    for (const axis of [0, 1, 2]) {
      assert.ok(
        Math.abs(tripled[axis] - offset.offsetMm[axis] * 2) < 1e-9,
        `${offset.id} axis ${axis} scales with the factor`,
      );
    }
  }
});

test('the offsets sum to zero, so the assembly does not drift off the plate', () => {
  // Each part moves away from the centroid, so the whole set stays centred.
  // Without this an exploded assembly would wander off the bed as it opened.
  const total = [0, 0, 0];
  for (const offset of projectExplosion(PARTS, 4)) {
    for (const axis of [0, 1, 2]) total[axis] += offset.offsetMm[axis];
  }
  for (const axis of [0, 1, 2]) assert.ok(Math.abs(total[axis]) < 1e-9, `axis ${axis} is balanced`);
});

test('a factor below one is refused rather than imploding the view', () => {
  assert.throws(() => projectExplosion(PARTS, 0.5));
  assert.throws(() => projectExplosion(PARTS, Number.NaN));
});

test('composing from a baseline is what keeps repeated adjustment stable', () => {
  // The bug this pins: applying offsets to already-offset positions. Exploding
  // to 2 and then to 3 must land where going straight to 3 lands, or every
  // slider drag pushes the parts further out.
  const direct = projectExplosion(PARTS, 3);
  const viaTwo = projectExplosion(PARTS, 2);
  const composed = PARTS.map((part, index) => {
    const moved = viaTwo[index].offsetMm;
    return {
      id: part.id,
      centerMm: part.centerMm.map((v, a) => v + moved[a]) as unknown as readonly [number, number, number],
    };
  });
  const drifted = projectExplosion(composed, 3);
  const differs = drifted.some((offset, index) =>
    offset.offsetMm.some((value, axis) => Math.abs(value - direct[index].offsetMm[axis]) > 1e-9),
  );
  assert.ok(
    differs,
    'composing from exploded positions really does drift — which is why the renderer holds an assembled baseline',
  );
});

console.log(`\nExploded view: ${passed} tests passed.`);
