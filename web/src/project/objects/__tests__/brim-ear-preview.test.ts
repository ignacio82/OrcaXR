/**
 * Traces for the brim-ear preview's connectivity check (P5.3.6).
 *
 * The visual half of a preview cannot be asserted here, but the half that
 * carries information can: which ears the pinned gizmo would paint red because
 * they reach nothing. That is the judgement, and it is worth more than the
 * drawing — an ear that misses the part is invisible in the slice too.
 */

import assert from 'node:assert/strict';

import { brimEarOutline, discTouchesOutline, findDisconnectedBrimEars, type BrimEarDisc } from '../brimEarPreview';
import type { OutlinePolygon } from '../brimEarDetection';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A 20 mm square outline, the first layer of a plain cube. */
const SQUARE: OutlinePolygon = Object.freeze([
  Object.freeze([0, 0] as const),
  Object.freeze([20, 0] as const),
  Object.freeze([20, 20] as const),
  Object.freeze([0, 20] as const),
]);

const disc = (x: number, y: number, radiusMm = 5): BrimEarDisc => ({ x, y, radiusMm });

test('a disc on the part touches it, inside or straddling the wall', () => {
  assert.equal(discTouchesOutline(disc(10, 10), [SQUARE]), true, 'dead centre');
  assert.equal(discTouchesOutline(disc(0, 0), [SQUARE]), true, 'on a corner');
  assert.equal(discTouchesOutline(disc(-4, 10), [SQUARE]), true, 'straddling a wall from outside');
});

test('a disc clear of the part touches nothing', () => {
  // 5 mm radius centred 6 mm out from the wall: the nearest material is 1 mm
  // beyond its rim. This is the ear that prints an island and holds nothing.
  assert.equal(discTouchesOutline(disc(-6, 10), [SQUARE]), false);
});

test('an ear that misses the part is reported, and one that lands is not', () => {
  const ears = [disc(10, 10), disc(-6, 10)];
  assert.deepEqual([...findDisconnectedBrimEars(ears, [SQUARE])], [1]);
});

test('a chain of overlapping ears reaching the part is anchored, transitively', () => {
  // Each hop is 8 mm with 5 mm radii, so consecutive discs overlap and the
  // chain is one connected region of brim. The first touches the wall.
  const chain = [disc(-4, 10), disc(-12, 10), disc(-20, 10)];
  assert.deepEqual([...findDisconnectedBrimEars(chain, [SQUARE])], []);
});

test('the chain is only anchored while it reaches back to the part', () => {
  // Same chain with its first link removed: nothing now touches the square,
  // so the whole run is disconnected rather than anchored to each other.
  const orphans = [disc(-12, 10), disc(-20, 10)];
  assert.deepEqual([...findDisconnectedBrimEars(orphans, [SQUARE])], [0, 1]);
});

test('order does not decide the answer', () => {
  // The fixed-point loop must not depend on the order ears were placed in: the
  // far end of a chain is anchored even when it is tested before its anchor.
  const reversed = [disc(-20, 10), disc(-12, 10), disc(-4, 10)];
  assert.deepEqual([...findDisconnectedBrimEars(reversed, [SQUARE])], []);
});

test('a bigger ear reaches further', () => {
  assert.equal(discTouchesOutline(disc(-6, 10, 5), [SQUARE]), false);
  assert.equal(discTouchesOutline(disc(-6, 10, 7), [SQUARE]), true);
});

test('an outline is cut just above the base, not through the middle', () => {
  // Two stacked boxes: a 20 mm footprint below, a 6 mm one above. A cut near
  // the base must see the wide one, or every ear on the skirt reads as an
  // island.
  const positions: number[] = [];
  const pushBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    const p: [number, number, number][] = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    for (const face of [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ]) {
      for (const index of face) positions.push(...p[index]);
    }
  };
  pushBox(0, 0, 0, 20, 20, 5);
  pushBox(7, 7, 5, 13, 13, 15);

  const outline = brimEarOutline(positions, undefined, 0.2);
  assert.ok(outline, 'a solid with height has a first layer');
  assert.equal(outline.baseZ, 0);
  // An ear at the wide footprint's corner is on the part.
  assert.equal(discTouchesOutline(disc(0, 0), outline.loops), true);
  // An ear beyond it is not, which the narrow upper box must not rescue.
  assert.equal(discTouchesOutline(disc(-8, -8), outline.loops), false);
});

test('a flat or empty solid has no first layer to reach', () => {
  assert.equal(brimEarOutline([], undefined), null);
  const flat = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  assert.equal(brimEarOutline(flat, undefined), null, 'a single triangle has no height');
});

console.log(`\nBrim ear preview: ${passed} tests passed.`);
