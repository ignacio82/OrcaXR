import assert from 'node:assert/strict';

import {
  DEFAULT_BRIM_EAR_DETECTION,
  detectBrimEars,
  detectOutlineCorners,
  signedArea,
  sliceMeshOutline,
  thinBrimEars,
  type OutlinePolygon,
} from '../brimEarDetection';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** An axis-aligned box from (0,0,0) to (w,d,h), as a soup of triangles. */
function box(width: number, depth: number, height: number): number[] {
  const p = [
    [0, 0, 0],
    [width, 0, 0],
    [width, depth, 0],
    [0, depth, 0],
    [0, 0, height],
    [width, 0, height],
    [width, depth, height],
    [0, depth, height],
  ];
  const faces = [
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
  ];
  return faces.flatMap((face) => face.flatMap((index) => p[index]));
}

/** A prism whose cross-section is a regular polygon — no sharp corners at high n. */
function prism(sides: number, radius: number, height: number): number[] {
  const ring = Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  const out: number[] = [];
  for (let index = 0; index < sides; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % sides];
    out.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], height);
    out.push(a[0], a[1], 0, b[0], b[1], height, a[0], a[1], height);
    out.push(0, 0, 0, b[0], b[1], 0, a[0], a[1], 0);
    out.push(0, 0, height, a[0], a[1], height, b[0], b[1], height);
  }
  return out;
}

function corners(result: ReturnType<typeof detectBrimEars>): [number, number][] {
  return result.ears
    .map((ear) => [round(ear.point.positionMm[0]), round(ear.point.positionMm[1])] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

test('a box gets one ear on each of its four corners', () => {
  const result = detectBrimEars(box(20, 10, 5), undefined, DEFAULT_BRIM_EAR_DETECTION);
  assert.equal(result.reason, undefined);
  assert.deepEqual(corners(result), [
    [0, 0],
    [0, 10],
    [20, 0],
    [20, 10],
  ]);
  assert.ok(
    result.ears.every((ear) => Math.abs(ear.angleDeg - 90) < 1e-6),
    'a box corner is a right angle',
  );
  assert.ok(
    result.ears.every((ear) => ear.point.headFrontRadiusMm === DEFAULT_BRIM_EAR_DETECTION.headFrontRadiusMm),
    'each placed ear carries the configured radius',
  );
});

test('a smooth prism has nothing sharp enough to hold down', () => {
  const result = detectBrimEars(prism(48, 10, 5), undefined, DEFAULT_BRIM_EAR_DETECTION);
  assert.deepEqual(result.ears, []);
  assert.match(result.reason ?? '', /nothing that peels/);

  // A coarse prism does have corners, and the threshold is what decides.
  const hexagon = detectBrimEars(prism(6, 10, 5), undefined, DEFAULT_BRIM_EAR_DETECTION);
  assert.equal(hexagon.ears.length, 6, 'a hexagon interior angle is 120°, inside the 125° default');
  const stricter = detectBrimEars(prism(6, 10, 5), undefined, { ...DEFAULT_BRIM_EAR_DETECTION, maxAngleDeg: 100 });
  assert.deepEqual(stricter.ears, [], 'and a stricter threshold rejects the same shape');
});

test('an inward corner is not an ear', () => {
  // An L: six corners, but the inner one is material on both sides.
  const shape: OutlinePolygon = [
    [0, 0],
    [20, 0],
    [20, 5],
    [5, 5],
    [5, 20],
    [0, 20],
  ];
  assert.ok(signedArea(shape) > 0, 'the fixture is counter-clockwise');
  const detected = detectOutlineCorners(shape, 125);
  assert.deepEqual(
    detected.map((corner) => corner.point),
    [
      [0, 0],
      [20, 0],
      [20, 5],
      [5, 20],
      [0, 20],
    ],
    'every outward corner qualifies and the reflex corner at (5,5) does not',
  );

  // Winding must not change the answer: the same outline reversed is the same
  // physical part.
  const reversed = [...shape].reverse();
  assert.deepEqual(
    detectOutlineCorners(reversed, 125)
      .map((corner) => corner.point)
      .sort(),
    detected.map((corner) => corner.point).sort(),
  );
});

test('corners that collide are thinned to the sharper one', () => {
  const ears = [
    { point: { positionMm: [0, 0, 0] as [number, number, number], headFrontRadiusMm: 5 }, angleDeg: 90 },
    { point: { positionMm: [0.2, 0, 0] as [number, number, number], headFrontRadiusMm: 5 }, angleDeg: 60 },
    { point: { positionMm: [10, 0, 0] as [number, number, number], headFrontRadiusMm: 5 }, angleDeg: 120 },
  ];
  const kept = thinBrimEars(ears, 1);
  assert.deepEqual(
    kept.map((ear) => ear.angleDeg),
    [60, 120],
    'the sharper of the colliding pair survives, because it is the one more likely to lift',
  );

  // A radius of zero keeps everything; the thinning is a choice, not a filter
  // that silently drops points.
  assert.equal(thinBrimEars(ears, 0).length, 3);
});

test('the outline comes from the mesh, so a concave footprint is not a bounding box', () => {
  // A plus-shaped prism: a bounding box would report four corners; the real
  // footprint has twelve, eight of them outward.
  const arm = 5;
  const span = 15;
  const outline: [number, number][] = [
    [arm, 0],
    [span - arm, 0],
    [span - arm, arm],
    [span, arm],
    [span, span - arm],
    [span - arm, span - arm],
    [span - arm, span],
    [arm, span],
    [arm, span - arm],
    [0, span - arm],
    [0, arm],
    [arm, arm],
  ];
  const detected = detectOutlineCorners(outline, 125);
  assert.equal(detected.length, 8, 'a plus has eight outward corners and four reflex ones');
  assert.ok(
    detected.every((corner) => Math.abs(corner.angleDeg - 90) < 1e-6),
    'each is a right angle',
  );
});

test('a mesh slice reads closed loops, and degenerate input is refused rather than guessed', () => {
  const loops = sliceMeshOutline(box(4, 6, 2), undefined, 1);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4, 'a box cross-section is a quadrilateral');
  assert.equal(Math.abs(signedArea(loops[0])), 24);

  assert.match(detectBrimEars([], undefined).reason ?? '', /no geometry/);
  const flat: number[] = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  assert.match(detectBrimEars(flat, undefined).reason ?? '', /flat/);
});

test('indexed and non-indexed meshes give the same answer', () => {
  const soup = box(8, 8, 4);
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();
  for (let vertex = 0; vertex < soup.length / 3; vertex += 1) {
    const key = soup.slice(vertex * 3, vertex * 3 + 3).join(',');
    let index = lookup.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      positions.push(soup[vertex * 3], soup[vertex * 3 + 1], soup[vertex * 3 + 2]);
      lookup.set(key, index);
    }
    indices.push(index);
  }
  assert.ok(positions.length / 3 < soup.length / 3, 'the indexed form really is deduplicated');
  assert.deepEqual(corners(detectBrimEars(positions, indices)), corners(detectBrimEars(soup, undefined)));
});

console.log(`\nBrim ear detection: ${passed} tests passed.`);
