import assert from 'node:assert/strict';
import * as THREE from 'three';

import { InMemoryAssetRepository } from '../assets';
import { ProjectPickScene, PickRefusal } from '../picking';
import { ProjectStore } from '../store';
import { ThreeProjectSurface, getThreeProjectEntity } from '../surfaces/ThreeProjectSurface';
import { createPickingFixture } from './pickingFixture';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const units = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

test('picks the facet the workspace raycast meets, in printer space', () => {
  const fixture = createPickingFixture();
  const assets = new InMemoryAssetRepository();
  for (const payload of fixture.assets) assets.put(payload.descriptor, payload.bytes);
  const scene = new THREE.Scene();
  const surface = new ThreeProjectSurface({ parent: scene, assets, mapping: MAPPING });
  surface.renderProject(new ProjectStore(fixture.state).getSnapshot());
  scene.updateMatrixWorld(true);
  const meshes = surface.root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
  const toWorld = surface.root.matrixWorld;
  const toPrinter = toWorld.clone().invert();
  const pick = ProjectPickScene.capture(fixture.state, assets, { plateId: units(fixture.plateId), modelsOnly: false });
  const raycaster = new THREE.Raycaster();
  let hits = 0;
  let misses = 0;
  for (const [i, ray] of fixture.rays.entries()) {
    const origin = new THREE.Vector3(...ray.origin).applyMatrix4(toWorld);
    const direction = new THREE.Vector3(...ray.direction).transformDirection(toWorld);
    raycaster.set(origin, direction);
    const [expected] = raycaster.intersectObjects(meshes, false);
    const actual = pick.nearest(ray.origin, ray.direction);
    if (!expected) {
      assert.equal(actual, undefined, `ray ${i} misses`);
      misses += 1;
      continue;
    }
    assert.ok(actual, `ray ${i} hits`);
    const entity = getThreeProjectEntity(expected.object)!;
    assert.equal(actual.volumeId, entity.volumeId, `ray ${i} volume`);
    assert.equal(actual.instanceId, entity.instanceId, `ray ${i} instance`);
    assert.equal(actual.triangle, expected.faceIndex, `ray ${i} facet`);
    const point = expected.point.clone().applyMatrix4(toPrinter).toArray();
    point.forEach((v, k) => assert.ok(Math.abs(v - actual.point[k]) < 1e-6, `ray ${i} point ${k}`));
    const local = expected.object.worldToLocal(expected.point.clone()).toArray();
    local.forEach((v, k) => assert.ok(Math.abs(v - actual.localPoint[k]) < 1e-6, `ray ${i} local ${k}`));
    assert.ok(Math.abs(expected.distance / MAPPING.worldUnitsPerMm - actual.distance) < 1e-6, `ray ${i} distance`);
    hits += 1;
  }
  assert.ok(hits > 120 && misses > 20, `${hits} hits, ${misses} misses`);
  surface.dispose();
});

test('models-only scenes skip modifiers, and an unknown plate or mesh refuses', () => {
  const fixture = createPickingFixture();
  const assets = new InMemoryAssetRepository();
  for (const payload of fixture.assets) assets.put(payload.descriptor, payload.bytes);
  const everything = ProjectPickScene.capture(fixture.state, assets, {
    plateId: units(fixture.plateId),
    modelsOnly: false,
  });
  const models = ProjectPickScene.capture(fixture.state, assets, {
    plateId: units(fixture.plateId),
    modelsOnly: true,
  });
  // Straight down onto the modifier cube above the first sphere.
  const down = { origin: [50, 40, 100] as const, direction: [0, 0, -1] as const };
  assert.equal(everything.nearest([...down.origin], [...down.direction])?.volumeId, 'import:volume:pick-modifier');
  assert.equal(
    models.nearest([...down.origin], [...down.direction])?.volumeId,
    fixture.state.plates[0].objects[0].volumes[0].id,
  );
  assert.throws(
    () =>
      ProjectPickScene.capture(fixture.state, assets, { plateId: units('import:plate:missing'), modelsOnly: false }),
    (error: unknown) => error instanceof PickRefusal && error.code === 'unknown-plate',
  );
  assert.throws(
    () =>
      ProjectPickScene.capture(fixture.state, new InMemoryAssetRepository(), {
        plateId: units(fixture.plateId),
        modelsOnly: false,
      }),
    (error: unknown) => error instanceof PickRefusal && error.code === 'invalid-mesh',
  );
});

console.log(`\nProject picking: ${passed} tests passed.`);
