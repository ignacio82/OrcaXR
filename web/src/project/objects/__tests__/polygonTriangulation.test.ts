import assert from 'node:assert/strict';

import { type Contour, signedArea, simplifyContour, triangulatePolygon } from '../polygonTriangulation';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function area(points: Contour, triangles: readonly [number, number, number][]): number {
  let total = 0;
  for (const [a, b, c] of triangles) {
    total += Math.abs(
      ((points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) -
        (points[c][0] - points[a][0]) * (points[b][1] - points[a][1])) /
        2,
    );
  }
  return total;
}

/** Every edge of a triangulated region is shared by two triangles or is boundary. */
function boundaryLoopsClose(triangles: readonly [number, number, number][]): boolean {
  const directed = new Map<string, number>();
  for (const [a, b, c] of triangles) {
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${from}_${to}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  // On a closed boundary every vertex has as many outgoing as incoming edges.
  const balance = new Map<number, number>();
  for (const [key, count] of directed) {
    const [fromText, toText] = key.split('_');
    const from = Number(fromText);
    const to = Number(toText);
    const net = count - (directed.get(`${to}_${from}`) ?? 0);
    if (net <= 0) continue;
    balance.set(from, (balance.get(from) ?? 0) + net);
    balance.set(to, (balance.get(to) ?? 0) - net);
  }
  return [...balance.values()].every((value) => value === 0);
}

const SQUARE: Contour = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test('a convex polygon triangulates completely', () => {
  const triangles = triangulatePolygon(SQUARE);
  assert.equal(triangles.length, 2);
  assert.equal(area(SQUARE, triangles), 100);
});

test('winding of the input never changes the result', () => {
  const clockwise = [...SQUARE].reverse();
  assert.equal(triangulatePolygon(clockwise).length, 2);
  assert.equal(area(clockwise, triangulatePolygon(clockwise)), 100);
});

test('a hole is subtracted rather than filled', () => {
  const hole: Contour = [
    [3, 3],
    [3, 7],
    [7, 7],
    [7, 3],
  ];
  const triangles = triangulatePolygon(SQUARE, [hole]);
  const points = [...SQUARE, ...hole];
  // 100 mm² minus a 16 mm² counter. Filling the hole would give 100.
  assert.ok(Math.abs(area(points, triangles) - 84) < 1e-9, `covered ${area(points, triangles)} mm²`);
  assert.ok(boundaryLoopsClose(triangles));
});

test('two holes both survive — the case a naive ear clipper loses', () => {
  const left: Contour = [
    [1, 1],
    [1, 4],
    [4, 4],
    [4, 1],
  ];
  const right: Contour = [
    [6, 6],
    [6, 9],
    [9, 9],
    [9, 6],
  ];
  const triangles = triangulatePolygon(SQUARE, [left, right]);
  const points = [...SQUARE, ...left, ...right];
  assert.ok(Math.abs(area(points, triangles) - (100 - 9 - 9)) < 1e-9, `covered ${area(points, triangles)} mm²`);
  assert.ok(boundaryLoopsClose(triangles));
});

test('a concave polygon keeps its notch empty', () => {
  // An L shape: 100 mm² square with a 25 mm² bite removed.
  const shape: Contour = [
    [0, 0],
    [10, 0],
    [10, 5],
    [5, 5],
    [5, 10],
    [0, 10],
  ];
  const triangles = triangulatePolygon(shape);
  assert.ok(Math.abs(area(shape, triangles) - 75) < 1e-9);
  assert.ok(boundaryLoopsClose(triangles));
});

test('degenerate input produces nothing rather than garbage', () => {
  assert.deepEqual(triangulatePolygon([]), []);
  assert.deepEqual(
    triangulatePolygon([
      [0, 0],
      [1, 1],
    ]),
    [],
  );
  // Three collinear points enclose no area.
  assert.deepEqual(
    triangulatePolygon([
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
    [],
  );
});

test('simplifyContour removes exactly what the triangulator would drop', () => {
  const withCollinear: Contour = [
    [0, 0],
    [5, 0],
    [10, 0],
    [10, 10],
    [10, 10],
    [0, 10],
  ];
  assert.deepEqual(simplifyContour(withCollinear), [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  // Already-minimal input is left alone.
  assert.deepEqual(simplifyContour(SQUARE), SQUARE);
});

test('signedArea reports orientation as well as size', () => {
  assert.equal(signedArea(SQUARE), 100);
  assert.equal(signedArea([...SQUARE].reverse()), -100);
});

console.log(`\nPolygon triangulation: ${passed} tests passed.`);
