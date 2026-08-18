/**
 * Traces for the stock primitives (P5.8, P11.2).
 *
 * Upstream offers six and this app offered three, and the three it had were
 * built inline in the XR workspace where nothing could measure them. Both are
 * fixed by generating the shapes in a module that imports geometry and nothing
 * else — so these traces assert the dimensions an operator actually gets,
 * against the numbers read from upstream's own `create_mesh`.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildRegistry } from '../../../actions/catalog';
import {
  PRIMITIVE_DESCRIPTIONS,
  PRIMITIVE_KINDS,
  PRIMITIVE_SIDE_MM,
  primitiveFileName,
  primitiveGeometry,
  type PrimitiveKind,
} from '../primitives';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function measure(kind: PrimitiveKind) {
  const geometry = primitiveGeometry(kind);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const position = geometry.getAttribute('position');
  return { geometry, box, size, vertices: position.count, triangles: position.count / 3 };
}

const round = (value: number) => Number(value.toFixed(3));

test('every kind produces a finite, triangulated mesh', () => {
  for (const kind of PRIMITIVE_KINDS) {
    const { geometry, vertices, triangles } = measure(kind);
    assert.equal(geometry.index, null, `${kind} should be non-indexed`);
    assert.ok(vertices > 0 && vertices % 3 === 0, `${kind} has ${vertices} vertices`);
    assert.ok(triangles > 8, `${kind} has only ${triangles} triangles`);
    const array = geometry.getAttribute('position').array as ArrayLike<number>;
    for (let index = 0; index < array.length; index += 1) {
      assert.ok(Number.isFinite(array[index]), `${kind} has a non-finite coordinate`);
    }
  }
});

test('the dimensions are upstream’s, at the side this app uses', () => {
  // `GUI_ObjectList.cpp::create_mesh`, with `side` = 20 mm.
  const cube = measure('cube');
  assert.deepEqual([round(cube.size.x), round(cube.size.y), round(cube.size.z)], [20, 20, 20]);

  const cylinder = measure('cylinder');
  assert.deepEqual([round(cylinder.size.x), round(cylinder.size.z)], [20, 20], 'radius 0.5×side, height side');

  const sphere = measure('sphere');
  assert.deepEqual([round(sphere.size.x), round(sphere.size.y), round(sphere.size.z)], [20, 20, 20]);

  const cone = measure('cone');
  assert.deepEqual([round(cone.size.x), round(cone.size.z)], [20, 20], 'radius 0.5×side, height side');

  // A disc is 0.2 mm thick because upstream's disc is a cylinder of literal
  // height 0.2 — not a proportion of the side. Scaling it would silently make
  // it a short cylinder, which upstream already offers separately.
  const disc = measure('disc');
  assert.equal(round(disc.size.x), 20);
  assert.equal(round(disc.size.z), 0.2);

  // Major radius 0.5×side, tube radius 0.125×side: 25 mm across, 5 mm tall.
  const torus = measure('torus');
  assert.deepEqual([round(torus.size.x), round(torus.size.y), round(torus.size.z)], [25, 25, 5]);
});

test('a cone stands on its base and a torus lies flat with a hole', () => {
  const cone = measure('cone');
  const position = cone.geometry.getAttribute('position');
  const top = cone.box.max.z;
  let widestNearTop = 0;
  let widestNearBottom = 0;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const radius = Math.hypot(x, y);
    if (z > top - 1) widestNearTop = Math.max(widestNearTop, radius);
    if (z < cone.box.min.z + 1) widestNearBottom = Math.max(widestNearBottom, radius);
  }
  assert.ok(widestNearTop < 1, `the apex is at the top (found radius ${widestNearTop} there)`);
  assert.ok(widestNearBottom > 9, `the base is at the bottom (found radius ${widestNearBottom} there)`);

  const torus = measure('torus');
  const torusPosition = torus.geometry.getAttribute('position');
  let innermost = Number.POSITIVE_INFINITY;
  for (let index = 0; index < torusPosition.count; index += 1) {
    innermost = Math.min(innermost, Math.hypot(torusPosition.getX(index), torusPosition.getY(index)));
  }
  // 0.5×side − 0.125×side = 7.5 mm: the hole is real, not a filled disc.
  assert.equal(round(innermost), 7.5);
});

test('the catalog offers exactly the kinds this module builds', () => {
  const registry = buildRegistry();
  const offered = registry
    .forSurface('command-palette')
    .filter((action) => action.id.startsWith('add_primitive_'))
    .map((action) => action.id.replace('add_primitive_', ''))
    .sort();
  assert.deepEqual(offered, [...PRIMITIVE_KINDS].sort(), 'a shape nobody can add, or a menu entry with no shape');
  for (const kind of PRIMITIVE_KINDS) {
    assert.equal(primitiveFileName(kind), `${kind}.stl`);
    assert.ok(PRIMITIVE_DESCRIPTIONS[kind].includes(`${PRIMITIVE_SIDE_MM} mm`), `${kind} does not state its size`);
  }
});

console.log(`\nStock primitives: ${passed} tests passed.`);
