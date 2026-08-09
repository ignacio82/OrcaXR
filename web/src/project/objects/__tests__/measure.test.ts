import assert from 'node:assert/strict';

import type { FacetSelectionMesh } from '../../annotations';
import type { Vec3 } from '../../domain/model';
import {
  FEATURE_HOVER_LIMIT_MM,
  MeasureError,
  PINNED_MEASURE_SOURCE,
  SURFACE_FEATURE_ORDER,
  SurfaceFeatureExtractor,
  areParallel,
  arePerpendicular,
  measureSurfaceFeatures,
  transformSurfaceFeature,
  type FeatureWorldTransform,
  type SurfaceFeature,
} from '../measure';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Closed-form oracles need exact primitives, so the fixtures are built by hand. */
function cube(side = 10): FacetSelectionMesh {
  const s = side;
  const vertices: Vec3[] = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
  ];
  const triangles: [number, number, number][] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [3, 7, 6],
    [3, 6, 2],
    [0, 4, 7],
    [0, 7, 3],
    [1, 2, 6],
    [1, 6, 5],
  ];
  return Object.freeze({ vertices: Object.freeze(vertices), triangles: Object.freeze(triangles) });
}

/**
 * A closed prism whose top and bottom are regular `sides`-gons of exact radius
 * `radius`. The caps are the circles under test; their radius is known exactly.
 */
function prism(sides: number, radius: number, height: number): FacetSelectionMesh {
  const vertices: Vec3[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (2 * Math.PI * index) / sides;
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), 0]);
  }
  for (let index = 0; index < sides; index += 1) {
    const angle = (2 * Math.PI * index) / sides;
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), height]);
  }
  const triangles: [number, number, number][] = [];
  // Bottom cap (normal -Z) and top cap (normal +Z), fanned from vertex 0.
  for (let index = 1; index < sides - 1; index += 1) {
    triangles.push([0, index + 1, index]);
    triangles.push([sides, sides + index, sides + index + 1]);
  }
  // Side quads.
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides;
    triangles.push([index, next, sides + next]);
    triangles.push([index, sides + next, sides + index]);
  }
  return Object.freeze({ vertices: Object.freeze(vertices), triangles: Object.freeze(triangles) });
}

const point = (p: Vec3): SurfaceFeature => ({ kind: 'point', point: p });
const edge = (from: Vec3, to: Vec3): SurfaceFeature => ({ kind: 'edge', from, to });
const plane = (normal: Vec3, origin: Vec3, index = 0): SurfaceFeature => ({ kind: 'plane', index, normal, origin });
const circle = (center: Vec3, normal: Vec3, radius: number): SurfaceFeature => ({
  kind: 'circle',
  center,
  normal,
  radius,
});

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} within ${tolerance}, received ${actual}`);
}

test('pins the upstream feature ordering, epsilon, and hover limit', () => {
  assert.equal(PINNED_MEASURE_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.deepEqual(SURFACE_FEATURE_ORDER, { point: 1, edge: 2, circle: 4, plane: 8 });
  assert.equal(FEATURE_HOVER_LIMIT_MM, 0.5);
  assert.equal(areParallel([0, 0, 1], [0, 0, -1]), true, 'antiparallel counts as parallel upstream');
  assert.equal(areParallel([0, 0, 1], [1, 0, 0]), false);
  assert.equal(arePerpendicular([0, 0, 1], [1, 0, 0]), true);
});

test('point-to-point reports the exact distance and its signed components', () => {
  const result = measureSurfaceFeatures(point([1, 2, 3]), point([4, 6, 15]));
  close(result.distanceStrict?.distance ?? -1, 13);
  assert.deepEqual(result.distanceXyz, [3, 4, 12]);
  assert.equal(result.distanceInfinite, undefined, 'two points have no infinite variant');
});

test('point-to-edge separates the infinite line from the bounded segment', () => {
  const segment = edge([0, 0, 0], [10, 0, 0]);
  const inside = measureSurfaceFeatures(point([4, 3, 0]), segment);
  close(inside.distanceInfinite?.distance ?? -1, 3);
  close(inside.distanceStrict?.distance ?? -1, 3, 1e-12);
  assert.deepEqual(inside.distanceStrict?.to, [4, 0, 0]);

  // Past the end the strict distance goes to the endpoint, the infinite one does not.
  const beyond = measureSurfaceFeatures(point([14, 3, 0]), segment);
  close(beyond.distanceInfinite?.distance ?? -1, 3);
  close(beyond.distanceStrict?.distance ?? -1, 5);
  assert.deepEqual(beyond.distanceStrict?.to, [10, 0, 0]);
});

test('swapping the operands swaps the reported endpoints, not the distance', () => {
  const a = point([0, 0, 0]);
  const b = plane([0, 0, 1], [0, 0, 7]);
  const forward = measureSurfaceFeatures(a, b);
  const reverse = measureSurfaceFeatures(b, a);
  close(forward.distanceInfinite?.distance ?? -1, 7);
  close(reverse.distanceInfinite?.distance ?? -1, 7);
  assert.deepEqual(forward.distanceInfinite?.from, a.kind === 'point' ? a.point : undefined);
  assert.deepEqual(reverse.distanceInfinite?.to, a.kind === 'point' ? a.point : undefined);
});

test('point-to-circle handles the axis case and the general case exactly', () => {
  const ring = circle([0, 0, 0], [0, 0, 1], 5);
  // On the axis: the closest point is on the rim, exactly one radius away.
  const onAxis = measureSurfaceFeatures(point([0, 0, 0]), ring);
  close(onAxis.distanceStrict?.distance ?? -1, 5);

  // Off axis and out of plane: sqrt((radial - r)^2 + axial^2).
  const offAxis = measureSurfaceFeatures(point([9, 0, 4]), ring);
  close(offAxis.distanceStrict?.distance ?? -1, Math.hypot(9 - 5, 4));
  assert.deepEqual(offAxis.distanceStrict?.to, [5, 0, 0]);
});

test('edge-to-edge picks the nearest pair and reports the angle between them', () => {
  const horizontal = edge([0, 0, 0], [10, 0, 0]);
  const vertical = edge([0, 4, 0], [0, 4, 10]);
  const result = measureSurfaceFeatures(horizontal, vertical);
  close(result.distanceInfinite?.distance ?? -1, 4);
  close(result.angle?.angle ?? -1, Math.PI / 2, 1e-12);

  const parallel = measureSurfaceFeatures(horizontal, edge([0, 3, 0], [10, 3, 0]));
  close(parallel.distanceInfinite?.distance ?? -1, 3);
  assert.equal(parallel.angle, undefined, 'parallel edges have no angle upstream');
});

test('edge-to-plane measures only when the edge is parallel to the plane', () => {
  const floor = plane([0, 0, 1], [0, 0, 0]);
  const parallelEdge = edge([0, 0, 6], [10, 0, 6]);
  const parallelResult = measureSurfaceFeatures(parallelEdge, floor);
  close(parallelResult.distanceInfinite?.distance ?? -1, 6);
  assert.equal(parallelResult.angle, undefined, 'an edge lying parallel has no angle');

  const slanted = measureSurfaceFeatures(edge([0, 0, 0], [0, 0, 10]), floor);
  assert.equal(slanted.distanceInfinite, undefined, 'a crossing edge has no plane distance');
  close(slanted.angle?.angle ?? -1, Math.PI / 2, 1e-12);
});

test('plane-to-plane gives a distance when parallel and an angle when not', () => {
  const floor = plane([0, 0, 1], [0, 0, 0]);
  const ceiling = plane([0, 0, 1], [0, 0, 12]);
  close(measureSurfaceFeatures(floor, ceiling).distanceInfinite?.distance ?? -1, 12);

  const wall = plane([1, 0, 0], [0, 0, 0], 1);
  const angled = measureSurfaceFeatures(floor, wall);
  assert.equal(angled.distanceInfinite, undefined);
  close(angled.angle?.angle ?? -1, Math.PI / 2, 1e-12);
});

test('coaxial and offset circle pairs measure, skew pairs refuse instead of guessing', () => {
  const lower = circle([0, 0, 0], [0, 0, 1], 5);
  const upper = circle([0, 0, 8], [0, 0, 1], 5);
  close(measureSurfaceFeatures(lower, upper).distanceInfinite?.distance ?? -1, 8);

  const shifted = circle([20, 0, 0], [0, 0, 1], 5);
  close(measureSurfaceFeatures(lower, shifted).distanceInfinite?.distance ?? -1, 10, 1e-9);

  const skew = circle([0, 0, 8], [1, 0, 0], 5);
  const refused = measureSurfaceFeatures(lower, skew);
  assert.equal(refused.unsupported, 'non-parallel-circle-pair');
  assert.equal(refused.distanceInfinite, undefined, 'an unsupported pair reports no number');
});

test('a cube resolves exactly six planes and measures across them', () => {
  const extractor = new SurfaceFeatureExtractor(cube(10));
  assert.equal(extractor.planeCount, 6, 'each cube face is one plane of two coplanar facets');
  for (let index = 0; index < 6; index += 1) {
    assert.equal(extractor.planeFacets(index).length, 2);
  }

  // A pick in the middle of a face is far from every edge, so it is the plane.
  const bottom = extractor.featureAt(0, [5, 5, 0]);
  assert.equal(bottom.kind, 'plane');
  const top = extractor.featureAt(2, [5, 5, 10]);
  assert.equal(top.kind, 'plane');
  const across = measureSurfaceFeatures(bottom, top);
  close(across.distanceInfinite?.distance ?? -1, 10, 1e-9);

  const side = extractor.featureAt(4, [5, 0, 5]);
  assert.equal(side.kind, 'plane');
  close(measureSurfaceFeatures(bottom, side).angle?.angle ?? -1, Math.PI / 2, 1e-9);
});

test('a pick near an edge claims the edge, and a pick near a corner claims the point', () => {
  const extractor = new SurfaceFeatureExtractor(cube(10));
  const nearEdge = extractor.featureAt(0, [5, 0.1, 0]);
  assert.equal(nearEdge.kind, 'edge', 'inside the hover limit the edge wins over the plane');

  const nearCorner = extractor.featureAt(0, [0.01, 0.01, 0]);
  assert.equal(nearCorner.kind, 'point', 'close to an endpoint the endpoint wins');
  if (nearCorner.kind === 'point') assert.deepEqual(nearCorner.point, [0, 0, 0]);

  // Well inside the face, no edge is within the pinned 0.5 mm hover limit.
  assert.equal(extractor.featureAt(0, [5, 5, 0]).kind, 'plane');
});

test('a many-sided prism cap resolves to a circle of the exact radius', () => {
  const radius = 7.5;
  const extractor = new SurfaceFeatureExtractor(prism(24, radius, 4));
  const capFeatures = extractor.planeFeatures(0);
  const found = capFeatures.find((feature) => feature.kind === 'circle');
  assert.ok(found, 'a 24-gon cap is a circle upstream, not 24 edges');
  if (found?.kind === 'circle') {
    close(found.radius, radius, 1e-9);
    close(found.center[0], 0, 1e-9);
    close(found.center[1], 0, 1e-9);
    // Diameter is the readout's derived value; it must stay exactly 2r.
    close(2 * found.radius, 2 * radius, 1e-9);
  }
});

test('a low-sided prism cap stays a polygon of edges, as upstream classifies it', () => {
  const extractor = new SurfaceFeatureExtractor(prism(6, 5, 4));
  const capFeatures = extractor.planeFeatures(0);
  assert.equal(
    capFeatures.some((feature) => feature.kind === 'circle'),
    false,
    'six sides is a polygon, not a circle',
  );
  assert.ok(capFeatures.filter((feature) => feature.kind === 'edge').length >= 6);
});

test('two coaxial prism caps measure their exact separation through the extractor', () => {
  const height = 6;
  const extractor = new SurfaceFeatureExtractor(prism(32, 4, height));
  const circles = [0, 1]
    .map((index) => extractor.planeFeatures(index).find((feature) => feature.kind === 'circle'))
    .filter((feature): feature is Extract<SurfaceFeature, { kind: 'circle' }> => feature?.kind === 'circle');
  assert.equal(circles.length, 2, 'both caps resolve to circles');
  close(measureSurfaceFeatures(circles[0], circles[1]).distanceInfinite?.distance ?? -1, height, 1e-6);
});

test('degenerate meshes and unknown faces fail closed', () => {
  assert.throws(
    () => new SurfaceFeatureExtractor({ vertices: [], triangles: [] }),
    (error: unknown) => error instanceof MeasureError && error.code === 'degenerate-mesh',
  );
  const extractor = new SurfaceFeatureExtractor(cube(10));
  assert.throws(
    () => extractor.featureAt(999, [0, 0, 0]),
    (error: unknown) => error instanceof MeasureError && error.code === 'unknown-face',
  );
  assert.throws(
    () => extractor.featureAt(-1, [0, 0, 0]),
    (error: unknown) => error instanceof MeasureError && error.code === 'unknown-face',
  );
  assert.throws(
    () => extractor.planeFacets(99),
    (error: unknown) => error instanceof MeasureError && error.code === 'invalid-feature',
  );
});

test('features move into world millimetres, and an ellipse is refused', () => {
  // Translate by (100, 0, 0) and scale uniformly by 2.
  const uniform: FeatureWorldTransform = [2, 0, 0, 100, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
  const moved = transformSurfaceFeature(circle([1, 0, 0], [0, 0, 1], 3), uniform);
  assert.ok(moved && moved.kind === 'circle');
  if (moved?.kind === 'circle') {
    assert.deepEqual(moved.center, [102, 0, 0]);
    close(moved.radius, 6);
    assert.deepEqual(moved.normal, [0, 0, 1]);
  }

  const movedEdge = transformSurfaceFeature(edge([0, 0, 0], [1, 0, 0]), uniform);
  assert.ok(movedEdge && movedEdge.kind === 'edge');
  if (movedEdge?.kind === 'edge') {
    assert.deepEqual(movedEdge.from, [100, 0, 0]);
    assert.deepEqual(movedEdge.to, [102, 0, 0]);
  }

  const stretched: FeatureWorldTransform = [3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(
    transformSurfaceFeature(circle([0, 0, 0], [0, 0, 1], 3), stretched),
    undefined,
    'a non-uniform scale turns a circle into an ellipse with no single radius',
  );
  assert.ok(transformSurfaceFeature(point([1, 2, 3]), stretched), 'a point is still exact under any scale');
});

console.log(`\nCanonical measurement: ${passed} tests passed.`);
